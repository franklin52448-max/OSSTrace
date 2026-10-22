/** Hash sub-routing for the Tracer workspace, nested under the app's own `#trace` route:
 *  `#trace` is the list/home, `#trace/doc/<uuid>` edits a trace, `#trace/view/<uuid>` is the
 *  read-only public view, and `#trace/<chain>/<address>` (the app's older quick-link shape, still
 *  used by "Trace funds" buttons elsewhere) starts a new trace seeded with that address and
 *  redirects into it. */
import { useEffect, useState } from "react";
import { useCreateTrace } from "./api.ts";
import { TracerHome } from "./TracerHome.tsx";
import { TracerPage } from "./TracerPage.tsx";

type SubRoute =
  | { kind: "home" }
  | { kind: "doc"; id: string }
  | { kind: "view"; id: string }
  | { kind: "seed"; chain: "ethereum" | "solana"; address: string };

function parseSubRoute(): SubRoute {
  const [, a = "", b = ""] = window.location.hash.replace(/^#/, "").split("/");
  if (a === "doc" && b) return { kind: "doc", id: b };
  if (a === "view" && b) return { kind: "view", id: b };
  if ((a === "ethereum" || a === "solana") && b) return { kind: "seed", chain: a, address: decodeURIComponent(b) };
  return { kind: "home" };
}

export function TracerRoute() {
  const [route, setRoute] = useState<SubRoute>(parseSubRoute);
  useEffect(() => {
    const onHashChange = () => setRoute(parseSubRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (route.kind === "doc") return <TracerPage key={route.id} id={route.id} />;
  if (route.kind === "view") return <TracerPage key={route.id} id={route.id} readOnly />;
  if (route.kind === "seed") return <SeedRedirect key={`${route.chain}:${route.address}`} chain={route.chain} address={route.address} />;
  return <TracerHome />;
}

/** Starts a new trace seeded with an address (from an "open in tracer" link elsewhere), then
 *  hands off to `#trace/doc/<uuid>` — the same thing TracerHome's own search does. */
function SeedRedirect({ chain, address }: { chain: "ethereum" | "solana"; address: string }) {
  const create = useCreateTrace();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    create.mutate(
      { initialAddress: address, initialChain: chain },
      {
        onSuccess: (r) => {
          if (live) window.location.hash = `#trace/doc/${r.id}`;
        },
        onError: (e) => {
          if (live) setError(e instanceof Error ? e.message : "Could not start a trace.");
        },
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, address]);
  if (error) return <div className="mx-auto max-w-xl p-6 text-[13px] text-danger">{error}</div>;
  return <p className="mx-auto max-w-xl p-6 text-[13px] text-muted">Starting a trace…</p>;
}
