import type { AddressInfo, Chain, EntityRef, LabelRef, TagRef } from "@osstrace/contract";
import type { Db } from "../db/index.ts";

type LabelRow = {
  id: string;
  chain: Chain;
  address: string;
  name: string;
  note: string | null;
  entity_id: string | null;
  e_name: string | null;
  e_type: string | null;
};

/**
 * Joins the user's own labels, entities and tags onto addresses. Built once per response for the set of
 * addresses it contains (chunked IN queries), then queried in memory.
 */
export class LabelIndex {
  private byKey = new Map<string, { label: LabelRef; entity: EntityRef | null; tags: TagRef[] }>();

  static empty() {
    return new LabelIndex();
  }

  static load(db: Db, userId: string | null, addrs: Iterable<{ chain: Chain; address: string | null | undefined }>): LabelIndex {
    const ix = new LabelIndex();
    if (!userId) return ix;
    const perChain = new Map<Chain, Set<string>>();
    for (const a of addrs) {
      if (!a.address) continue;
      if (!perChain.has(a.chain)) perChain.set(a.chain, new Set());
      perChain.get(a.chain)!.add(a.address);
    }
    const rows: LabelRow[] = [];
    for (const [chain, set] of perChain) {
      const list = [...set];
      for (let i = 0; i < list.length; i += 400) {
        const part = list.slice(i, i + 400);
        rows.push(
          ...db.all<LabelRow>(
            `SELECT l.id, l.chain, l.address, l.name, l.note, l.entity_id, e.name AS e_name, e.type AS e_type
             FROM labels l LEFT JOIN entities e ON e.id = l.entity_id
             WHERE l.user_id = ? AND l.chain = ? AND l.address IN (${part.map(() => "?").join(",")})`,
            userId,
            chain,
            ...part,
          ),
        );
      }
    }
    if (rows.length === 0) return ix;
    const tagMap = new Map<string, TagRef[]>();
    const ids = [...new Set([...rows.map((r) => r.id), ...rows.map((r) => r.entity_id).filter((x): x is string => !!x)])];
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400);
      const ph = part.map(() => "?").join(",");
      const tr = db.all<{ owner: string; id: string; name: string; color: string }>(
        `SELECT lt.label_id AS owner, t.id, t.name, t.color FROM label_tags lt JOIN tags t ON t.id = lt.tag_id WHERE lt.label_id IN (${ph})
         UNION ALL
         SELECT et.entity_id AS owner, t.id, t.name, t.color FROM entity_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entity_id IN (${ph})`,
        ...part,
        ...part,
      );
      for (const t of tr) {
        if (!tagMap.has(t.owner)) tagMap.set(t.owner, []);
        tagMap.get(t.owner)!.push({ id: t.id, name: t.name, color: t.color });
      }
    }
    for (const r of rows) {
      const tags = [...(tagMap.get(r.id) ?? []), ...(r.entity_id ? tagMap.get(r.entity_id) ?? [] : [])];
      const dedup = [...new Map(tags.map((t) => [t.id, t])).values()];
      ix.byKey.set(`${r.chain}:${r.address}`, {
        label: { id: r.id, name: r.name, note: r.note, source: "user" },
        entity: r.entity_id && r.e_name ? { id: r.entity_id, name: r.e_name, type: r.e_type, source: "user" } : null,
        tags: dedup,
      });
    }
    return ix;
  }

  info(chain: Chain, address: string, owner?: string | null): AddressInfo {
    const hit = this.byKey.get(`${chain}:${address}`);
    const out: AddressInfo = {
      address,
      chain,
      entity: hit?.entity ?? null,
      label: hit?.label ?? null,
      tags: hit?.tags ?? [],
    };
    if (owner && owner !== address) out.ownerAddress = this.info(chain, owner);
    return out;
  }
}
