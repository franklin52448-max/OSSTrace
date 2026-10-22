/** Hash sub-routing for the Labels workspace, nested under the app's own `#labels` route:
 *  `#labels` is the Labels table, `#labels/entities[?entity=<id>]` is Entities, and
 *  `#labels/tags[?tag=<id>]` is Tags. Each page owns its own filter state inside the hash's query
 *  part, the same pattern Visualizer's scratch mode uses. */
import { useEffect, useState } from "react";
import { EntitiesPage } from "./EntitiesPage.tsx";
import { LabelsLayout, type LabelsTab } from "./LabelsLayout.tsx";
import { LabelsPage } from "./LabelsPage.tsx";
import { TagsPage } from "./TagsPage.tsx";

function parseTab(): LabelsTab {
  const [pathPart] = window.location.hash.replace(/^#/, "").split("?");
  const [, a = ""] = pathPart!.split("/");
  if (a === "entities") return "entities";
  if (a === "tags") return "tags";
  return "labels";
}

export function LabelsRoute() {
  const [tab, setTab] = useState<LabelsTab>(parseTab);
  useEffect(() => {
    const onHashChange = () => setTab(parseTab());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <LabelsLayout active={tab}>
      {tab === "entities" ? <EntitiesPage /> : tab === "tags" ? <TagsPage /> : <LabelsPage />}
    </LabelsLayout>
  );
}
