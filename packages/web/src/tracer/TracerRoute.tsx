/** Hash sub-routing for the Tracer workspace, nested under the app's own `#trace` route:
 *  `#trace` is the list/home, `#trace/doc/<uuid>` edits a trace, `#trace/view/<uuid>` is the
 *  read-only public view, `#trace/scratch` is a local-only canvas with no account (ADR 0025,
 *  mirrors the Visualizer's `#graph/scratch`), `#trace/anon/<id>` reads a 3-hour anon share
 *  snapshot, and `#trace/<chain>/<address>` (the app's older quick-link shape, still used by
 *  "Trace funds" buttons elsewhere) starts a trace seeded with that address -- a real saved trace
 *  when signed in, a scratch canvas seeded with that address otherwise. */
import { useEffect, useState } from "react";
import { makeAddressNode } from "./lib/ops.ts";
import { useServerSession } from "../serverSession.ts";
import { useCreateTrace } from "./api.ts";
import { TracerHome } from "./TracerHome.tsx";
import { TracerPage } from "./TracerPage.tsx";
import { emptyTraceDoc, SCRATCH_ID, type TraceSource } from "./useTraceDocument.ts";

type SubRoute =
  | { kind: "home" }
  | { kind: "doc"; id: string }
  | { kind: "view"; id: string }
  | { kind: "anon"; id: string }
  | { kind: "scratch"; chain?: "ethereum" | "solana"; address?: string }
  | { kind: "seed"; chain: "ethereum" | "solana"; address: string };

function parseSubRoute(): SubRoute {
  const [, a = "", b = ""] = window.location.hash.replace(/^#/, "").split("/");
  if (a === "doc" && b) return { kind: "doc", id: b };
  if (a === "view" && b) return { kind: "view", id: b };
  if (a === "anon" && b) return { kind: "anon", id: b };
  if (a === "scratch") return { kind: "scratch" };
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

  if (route.kind === "doc") return <TracerPage key={route.id} source={{ kind: "saved", id: route.id, readOnly: false }} />;
  if (route.kind === "view") return <TracerPage key={route.id} source={{ kind: "saved", id: route.id, readOnly: true }} />;
  if (route.kind === "anon") return <TracerPage key={route.id} source={{ kind: "anonShare", id: route.id }} />;
  if (route.kind === "scratch") return <TracerPage key={SCRATCH_ID} source={{ kind: "scratch", initial: emptyTraceDoc() }} />;
  if (route.kind === "seed") return <SeedRedirect key={`${route.chain}:${route.address}`} chain={route.chain} address={route.address} />;
  return <TracerHome />;
}

/** Starts a trace seeded with an address (from an "open in tracer" link elsewhere). Signed in: a
 *  real saved trace, then hands off to `#trace/doc/<uuid>` -- the same thing TracerHome's own
 *  search does. Anon: no server call at all, straight to a scratch canvas pre-seeded with that one
 *  address node (ADR 0025 -- anon has no saved traces to create). */
function SeedRedirect({ chain, address }: { chain: "ethereum" | "solana"; address: string }) {
  const session = useServerSession();
  const create = useCreateTrace();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (session.status !== "signed-in") return; // anon/unreachable: render the scratch branch below, no mutation; "checking": wait for it to resolve
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
  }, [chain, address, session.status]);

  if (session.status === "checking") return <p className="mx-auto max-w-xl p-6 text-[13px] text-muted">Starting a trace…</p>;
  if (session.status !== "signed-in") {
    let node;
    try {
      node = makeAddressNode(SCRATCH_ID, { chain, address }, { x: 0, y: 0 });
    } catch {
      return <div className="mx-auto max-w-xl p-6 text-[13px] text-danger">That is not a valid address.</div>;
    }
    return <TracerPage key={`${chain}:${address}`} source={{ kind: "scratch", initial: { ...emptyTraceDoc(), nodes: [node] } }} />;
  }
  if (error) return <div className="mx-auto max-w-xl p-6 text-[13px] text-danger">{error}</div>;
  return <p className="mx-auto max-w-xl p-6 text-[13px] text-muted">Starting a trace…</p>;
}
