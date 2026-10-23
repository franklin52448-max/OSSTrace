/** Hash sub-routing for the Visualizer workspace, nested under the app's own `#graph` route:
 *  `#graph` is the list/home, `#graph/scratch[?query]` is a URL-only scratch view (the query string
 *  rides inside the hash, parsed fresh only on a real navigation -- see VisualizerPage's own silent
 *  History API sync for why a scratch edit never re-triggers this router), `#graph/saved/<id>` edits
 *  a saved view, `#graph/public/<id>` is its read-only share link, and `#graph/<chain>/<address>`
 *  (the app's older quick-link shape, still used by "Visualize" buttons elsewhere) opens a scratch
 *  view seeded with that one address. */
import { isChain } from "@osstrace/contract";
import { useEffect, useState } from "react";
import { parseScratchParams } from "./lib/urlState.ts";
import { VisualizerHome } from "./VisualizerHome.tsx";
import { VisualizerPage } from "./VisualizerPage.tsx";
import type { ViewSource } from "./useVisualizerDocument.ts";

type SubRoute = { kind: "home" } | { kind: "saved"; id: string; readOnly: boolean } | { kind: "scratch"; search: string };

function parseSubRoute(): SubRoute {
  const [pathPart, queryPart = ""] = window.location.hash.replace(/^#/, "").split("?");
  const [, a = "", b = ""] = pathPart!.split("/");
  if (a === "scratch") return { kind: "scratch", search: queryPart };
  if (a === "saved" && b) return { kind: "saved", id: b, readOnly: false };
  if (a === "public" && b) return { kind: "saved", id: b, readOnly: true };
  if (isChain(a) && b) return { kind: "scratch", search: `base=${encodeURIComponent(`${a}:${decodeURIComponent(b)}`)}` };
  return { kind: "home" };
}

export function VisualizerRoute() {
  const [route, setRoute] = useState<SubRoute>(parseSubRoute);
  useEffect(() => {
    const onHashChange = () => setRoute(parseSubRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (route.kind === "saved") {
    const source: ViewSource = { kind: "saved", id: route.id, readOnly: route.readOnly };
    return <VisualizerPage key={`${route.id}:${route.readOnly}`} source={source} />;
  }
  if (route.kind === "scratch") {
    const source: ViewSource = { kind: "scratch", initial: parseScratchParams(new URLSearchParams(route.search)) };
    return <VisualizerPage key={`scratch:${route.search}`} source={source} />;
  }
  return <VisualizerHome />;
}
