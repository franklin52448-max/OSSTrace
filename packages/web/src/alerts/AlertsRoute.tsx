/** Hash sub-routing for the Alerts workspace, nested under the app's own `#alerts` route:
 *  `#alerts` is the home, `#alerts/new[?chain=&address=&entity=]` opens the create dialog over it
 *  (used by "Alert me on this address"-style links elsewhere), `#alerts/inbox` and `#alerts/manage`
 *  are their own pages, `#alerts/<id>` is a rule's detail page, and `#alerts/<id>/edit` opens the
 *  edit dialog over it. */
import type { Chain } from "@osstrace/contract";
import { useEffect, useState } from "react";
import { AlertsHome } from "./AlertsHome.tsx";
import { AlertsLayout, type AlertsActive } from "./AlertsLayout.tsx";
import { AlertDetailPage } from "./AlertDetailPage.tsx";
import { InboxPage } from "./InboxPage.tsx";
import { ManagePage } from "./ManagePage.tsx";

type SubRoute =
  | { kind: "home"; creating: boolean; prefill: { chain: Chain | null; address: string | null; entityId: string | null } }
  | { kind: "inbox" }
  | { kind: "manage" }
  | { kind: "detail"; id: string; editing: boolean };

function parseSubRoute(): SubRoute {
  const [pathPart, queryPart = ""] = window.location.hash.replace(/^#/, "").split("?");
  const [, a = "", b = ""] = pathPart!.split("/");
  if (a === "new") {
    const sp = new URLSearchParams(queryPart);
    const chainParam = sp.get("chain");
    return {
      kind: "home",
      creating: true,
      prefill: { chain: chainParam === "ethereum" || chainParam === "solana" ? chainParam : null, address: sp.get("address"), entityId: sp.get("entity") },
    };
  }
  if (a === "inbox") return { kind: "inbox" };
  if (a === "manage") return { kind: "manage" };
  if (a && a !== "") return { kind: "detail", id: a, editing: b === "edit" };
  return { kind: "home", creating: false, prefill: { chain: null, address: null, entityId: null } };
}

export function AlertsRoute() {
  const [route, setRoute] = useState<SubRoute>(parseSubRoute);
  useEffect(() => {
    const onHashChange = () => setRoute(parseSubRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (route.kind === "detail") {
    const active: AlertsActive = { kind: "detail", id: route.id };
    return (
      <AlertsLayout active={active} creating={false} prefill={{ chain: null, address: null, entityId: null }} onCreateOpenChange={() => {}} onCreated={() => {}}>
        <AlertDetailPage id={route.id} editing={route.editing} onEditingChange={(editing) => (window.location.hash = editing ? `#alerts/${route.id}/edit` : `#alerts/${route.id}`)} />
      </AlertsLayout>
    );
  }
  if (route.kind === "inbox") {
    return (
      <AlertsLayout active={{ kind: "inbox" }} creating={false} prefill={{ chain: null, address: null, entityId: null }} onCreateOpenChange={() => {}} onCreated={() => {}}>
        <InboxPage />
      </AlertsLayout>
    );
  }
  if (route.kind === "manage") {
    return (
      <AlertsLayout active={{ kind: "manage" }} creating={false} prefill={{ chain: null, address: null, entityId: null }} onCreateOpenChange={() => {}} onCreated={() => {}}>
        <ManagePage />
      </AlertsLayout>
    );
  }
  return (
    <AlertsLayout
      active={{ kind: "home" }}
      creating={route.creating}
      prefill={route.prefill}
      onCreateOpenChange={(o) => {
        if (!o) window.location.hash = "#alerts";
      }}
      onCreated={(rule) => (window.location.hash = `#alerts/${rule.id}`)}
    >
      <AlertsHome />
    </AlertsLayout>
  );
}
