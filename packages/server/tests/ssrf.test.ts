import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertPublicUrl, isBlockedIp, safePost, SsrfError } from "../src/lib/ssrf.ts";

describe("isBlockedIp", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254", "::ffff:127.0.0.1",
    "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a9fe:a9fe", "2001:db8::1", "ff02::1", "not-an-ip",
  ])("blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));
  it.each(["93.184.216.34", "1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:93.184.216.34"])("allows %s", (ip) =>
    expect(isBlockedIp(ip)).toBe(false),
  );
});

describe("assertPublicUrl", () => {
  const resolver = (map: Record<string, string[]>) => async (h: string) => (map[h] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  it("refuses non-http schemes, credentials, localhost names and private resolutions", async () => {
    const r = resolver({ "good.example": ["93.184.216.34"], "mixed.example": ["93.184.216.34", "10.0.0.1"], "v6.example": ["::1"] });
    await expect(assertPublicUrl("https://good.example/x", r)).resolves.toBeInstanceOf(URL);
    for (const bad of [
      "ftp://good.example/",
      "https://user:pw@good.example/",
      "http://localhost:8080/",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://2130706433/", // 127.0.0.1 in decimal
      "http://0x7f.1/",
      "https://mixed.example/",
      "https://v6.example/",
      "https://nxdomain.example/",
      "not a url",
    ]) {
      await expect(assertPublicUrl(bad, r), bad).rejects.toBeInstanceOf(SsrfError);
    }
  });
});

describe("safePost", () => {
  let server: http.Server;
  let port: number;
  const hits: { path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        hits.push({ path: req.url ?? "", headers: req.headers, body });
        if (req.url === "/redirect") {
          res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
          res.end();
        } else if (req.url === "/slow") {
          setTimeout(() => res.end("late"), 3000);
        } else res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // These tests talk to a loopback test server, so they inject a policy that treats only 127.0.0.1 as public.
  const onlyLoopbackAllowed = (ip: string) => ip !== "127.0.0.1";
  const fixed = (ip: string) => async () => [{ address: ip, family: 4 }];

  it("posts JSON with the given headers", async () => {
    const r = await safePost(`http://hook.test:${port}/ok`, '{"a":1}', { "x-osstrace-signature": "sha256=abc" }, { resolve: fixed("127.0.0.1"), isBlocked: onlyLoopbackAllowed });
    expect(r).toEqual({ ok: true, status: 200, detail: "HTTP 200" });
    const hit = hits.find((h) => h.path === "/ok")!;
    expect(hit.body).toBe('{"a":1}');
    expect(hit.headers["content-type"]).toBe("application/json");
    expect(hit.headers["x-osstrace-signature"]).toBe("sha256=abc");
  });

  it("does not follow redirects", async () => {
    const r = await safePost(`http://hook.test:${port}/redirect`, "{}", {}, { resolve: fixed("127.0.0.1"), isBlocked: onlyLoopbackAllowed });
    expect(r).toMatchObject({ ok: false, status: 302, detail: "redirect not followed" });
    expect(hits.filter((h) => h.path === "/redirect")).toHaveLength(1);
  });

  it("times out", async () => {
    const t0 = Date.now();
    const r = await safePost(`http://hook.test:${port}/slow`, "{}", {}, { resolve: fixed("127.0.0.1"), isBlocked: onlyLoopbackAllowed, timeoutMs: 300 });
    expect(r).toMatchObject({ ok: false, status: null, detail: "timeout" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("blocks private targets with the real policy (loopback server is never reached)", async () => {
    const before = hits.length;
    const r = await safePost(`http://127.0.0.1:${port}/ok`, "{}", {});
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/^blocked/);
    const r2 = await safePost(`http://hook.test:${port}/ok`, "{}", {}, { resolve: fixed("127.0.0.1") });
    expect(r2.detail).toMatch(/^blocked/);
    expect(hits.length).toBe(before);
  });

  it("DNS rebinding: public at check time, private at connect time -> blocked at connect", async () => {
    let calls = 0;
    const rebinding = async () => (calls++ === 0 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]);
    const before = hits.length;
    const r = await safePost(`http://rebind.test:${port}/ok`, "{}", {}, { resolve: rebinding });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/^blocked/);
    expect(hits.length).toBe(before);
  });
});
