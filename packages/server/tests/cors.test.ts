import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORIGIN, makeApp, testWallet, type TestApp } from "./helpers.ts";

// The session is a cookie, not a bearer token, so a cross-origin browser client only gets to send
// or read it at all if the server answers with real Access-Control-Allow-Origin/-Credentials
// headers (never "*" -- credentialed CORS requires an exact origin) and handles the preflight
// OPTIONS request itself, rather than falling through to the 404 handler.
describe("CORS for a cross-origin browser client (cookie-based sessions)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(async () => t.close());

  it("an allowed Origin gets the credentialed CORS headers on a real GET", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/health", headers: { origin: ORIGIN } });
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["vary"]).toBe("Origin");
  });

  it("an origin not on the allowlist gets no CORS headers at all (the browser then blocks the page from reading the response)", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/health", headers: { origin: "http://evil.example.com" } });
    expect(res.statusCode).toBe(200); // the request itself isn't refused (GET isn't a CSRF risk) -- just not exposed to that origin
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("a preflight OPTIONS for an allowed origin gets a 204 with the method/header/credentials headers, not the 404 handler", async () => {
    const res = await t.app.inject({
      method: "OPTIONS",
      url: "/api/auth/challenge",
      headers: { origin: ORIGIN, "access-control-request-method": "POST" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["access-control-allow-headers"]).toContain("content-type");
    expect(res.body).toBe("");
  });

  it("a preflight from a disallowed origin gets a 204 (the browser's own request) but no CORS headers, so the browser still blocks the real request", async () => {
    const res = await t.app.inject({
      method: "OPTIONS",
      url: "/api/auth/challenge",
      headers: { origin: "http://evil.example.com", "access-control-request-method": "POST" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("an allowed-origin mutating request still needs the CSRF Origin check to pass -- CORS headers alone don't bypass it", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/auth/challenge",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      payload: JSON.stringify({ chain: "solana", address: testWallet("corscheck1").address }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
  });

  it("the preflight's retry-after exposure header is present whenever CORS headers are (even though no rate limit is hit here)", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/health", headers: { origin: ORIGIN } });
    expect(res.headers["access-control-expose-headers"]).toBe("retry-after");
  });
});
