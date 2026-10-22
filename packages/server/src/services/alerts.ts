import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { AlertEvent, AlertRule, AlertTarget, Chain } from "@osstrace/contract";
import type { Ctx } from "../context.ts";
import type { Param } from "../db/index.ts";
import { budgetMs } from "../lib/http.ts";
import { nowIso } from "../lib/time.ts";
import { FROM_IS, rowAddresses, rowToTransfer, TO_IS, TRANSFER_COLS, type TransferRow } from "../chain/store.ts";
import { LabelIndex } from "./labelIndex.ts";
import { webhookHeaders } from "../routes/settings.ts";

export const LIMITS = { maxRules: 50, maxTargetsPerRule: 20 };
const MAX_EVENTS_PER_RULE_PER_TICK = 50;
const MAX_ADDRESSES_PER_TICK = 200;

export type AlertRow = {
  id: string;
  user_id: string;
  name: string;
  enabled: number;
  direction: "in" | "out" | "both";
  min_usd: number | null;
  tokens_json: string | null;
  method_ids_json: string;
  armed_at: string;
  created_at: string;
  updated_at: string;
  last_triggered_at: string | null;
};

export function alertTargets(ctx: Ctx, alertId: string): AlertTarget[] {
  return ctx.db
    .all<{ type: "address" | "entity"; chain: Chain | null; address: string | null; entity_id: string | null }>("SELECT type, chain, address, entity_id FROM alert_targets WHERE alert_id = ? ORDER BY ord", alertId)
    .map((t): AlertTarget => (t.type === "address" ? { type: "address", chain: t.chain!, address: t.address! } : { type: "entity", entityId: t.entity_id! }));
}

export function toRule(ctx: Ctx, r: AlertRow): AlertRule {
  const n = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM alert_events WHERE alert_id = ?", r.id)!;
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled === 1,
    targets: alertTargets(ctx, r.id),
    direction: r.direction,
    minUsd: r.min_usd === null ? null : Number(r.min_usd),
    tokens: r.tokens_json ? (JSON.parse(r.tokens_json) as string[]) : null,
    methodIds: JSON.parse(r.method_ids_json) as string[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastTriggeredAt: r.last_triggered_at,
    eventCount: Number(n.n),
  };
}

type EventRow = { id: string; alert_id: string; alert_name: string; transfer_json: string; matched_target_json: string; created_at: string };

export function toEvents(ctx: Ctx, userId: string, rows: EventRow[]): AlertEvent[] {
  const transfers = rows.map((r) => JSON.parse(r.transfer_json) as TransferRow);
  const ix = LabelIndex.load(ctx.db, userId, rowAddresses(transfers));
  return rows.map((r, i) => ({
    id: r.id,
    alertId: r.alert_id,
    alertName: r.alert_name,
    transfer: rowToTransfer(transfers[i]!, ix),
    matchedTarget: JSON.parse(r.matched_target_json) as AlertTarget,
    createdAt: r.created_at,
    deliveries: ctx.db
      .all<{ method_id: string; status: "sent" | "failed" | "skipped"; detail: string | null }>("SELECT method_id, status, detail FROM alert_deliveries WHERE event_id = ? ORDER BY created_at", r.id)
      .map((d) => ({ methodId: d.method_id, status: d.status, ...(d.detail ? { detail: d.detail } : {}) })),
  }));
}

export type TickResult = { rules: number; addresses: number; synced: number; syncErrors: number; events: number; deliveries: number };

/**
 * Polls watched addresses (newest page only) every ALERT_POLL_SEC and fires each (rule, transfer) once,
 * only for transfers whose block time is after the rule was armed (created / re-enabled / retargeted).
 * Provider failures are logged and retried next tick; they never crash the process.
 */
export class AlertWorker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<TickResult> | null = null;
  private readonly ctx: Ctx;
  private readonly log: FastifyBaseLogger;
  constructor(ctx: Ctx, log: FastifyBaseLogger) {
    this.ctx = ctx;
    this.log = log;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log.error({ err: e instanceof Error ? e.message : String(e) }, "alert tick failed"));
    }, this.ctx.config.alertPollSec * 1000);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
  }

  tick(): Promise<TickResult> {
    if (!this.running) this.running = this.doTick().finally(() => (this.running = null));
    return this.running;
  }

  private async doTick(): Promise<TickResult> {
    const { db } = this.ctx;
    const rules = db.all<AlertRow>("SELECT * FROM alerts WHERE enabled = 1");
    const watch: { rule: AlertRow; target: AlertTarget; chain: Chain; address: string }[] = [];
    for (const rule of rules) {
      for (const target of alertTargets(this.ctx, rule.id)) {
        if (target.type === "address") watch.push({ rule, target, chain: target.chain, address: target.address });
        else
          for (const l of db.all<{ chain: Chain; address: string }>("SELECT chain, address FROM labels WHERE user_id = ? AND entity_id = ?", rule.user_id, target.entityId))
            watch.push({ rule, target, chain: l.chain, address: l.address });
      }
    }
    const addrs = [...new Map(watch.map((w) => [`${w.chain}:${w.address}`, { chain: w.chain, address: w.address }])).values()].slice(0, MAX_ADDRESSES_PER_TICK);
    let synced = 0;
    let syncErrors = 0;
    const results = await Promise.allSettled(
      addrs.map((a) => this.ctx.sync.ensureSynced(a.chain, a.address, { windowFrom: null, headOnly: true, forceHead: true, budget: budgetMs(25_000) })),
    );
    results.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value.state !== "error") synced++;
      else {
        syncErrors++;
        const reason = r.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : r.value.message;
        this.log.warn({ chain: addrs[i]!.chain, reason }, "alert sync failed; will retry next tick");
      }
    });

    let events = 0;
    let deliveries = 0;
    for (const w of watch) {
      const armedSec = Math.floor(Date.parse(w.rule.armed_at) / 1000);
      const params: Param[] = [w.chain];
      const dir =
        w.rule.direction === "in" ? TO_IS("?") : w.rule.direction === "out" ? FROM_IS("?") : `(${FROM_IS("?")} OR ${TO_IS("?")})`;
      params.push(...(w.rule.direction === "both" ? [w.address, w.address, w.address, w.address] : [w.address, w.address]));
      let sql = `SELECT ${TRANSFER_COLS} FROM transfers t WHERE t.chain = ? AND ${dir} AND t.block_time > ?`;
      params.push(armedSec);
      if (w.rule.min_usd !== null) (sql += " AND t.usd >= ?"), params.push(w.rule.min_usd);
      const tokens = w.rule.tokens_json ? (JSON.parse(w.rule.tokens_json) as string[]) : null;
      if (tokens && tokens.length) (sql += ` AND t.token_id IN (${tokens.map(() => "?").join(",")})`), params.push(...tokens);
      sql += " AND NOT EXISTS (SELECT 1 FROM alert_events e WHERE e.alert_id = ? AND e.transfer_chain = t.chain AND e.transfer_id = t.id) ORDER BY t.block_time, t.seq LIMIT ?";
      params.push(w.rule.id, MAX_EVENTS_PER_RULE_PER_TICK);
      const matches = db.all<TransferRow>(sql, ...params);
      for (const t of matches) {
        const eventId = randomUUID();
        const at = nowIso();
        const inserted = db.tx(() => {
          const r = db.run(
            `INSERT INTO alert_events (id, alert_id, user_id, transfer_chain, transfer_id, transfer_json, matched_target_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (alert_id, transfer_chain, transfer_id) DO NOTHING`,
            eventId,
            w.rule.id,
            w.rule.user_id,
            t.chain,
            t.id,
            JSON.stringify(t),
            JSON.stringify(w.target),
            at,
          );
          if (r.changes === 0) return false;
          db.run("INSERT INTO notifications (id, user_id, event_id, created_at, read_at) VALUES (?, ?, ?, ?, NULL)", randomUUID(), w.rule.user_id, eventId, at);
          db.run("UPDATE alerts SET last_triggered_at = ? WHERE id = ?", at, w.rule.id);
          return true;
        });
        if (!inserted) continue;
        events++;
        deliveries += await this.deliver(w.rule, eventId);
      }
    }
    return { rules: rules.length, addresses: addrs.length, synced, syncErrors, events, deliveries };
  }

  private async deliver(rule: AlertRow, eventId: string): Promise<number> {
    const { db } = this.ctx;
    const ids = JSON.parse(rule.method_ids_json) as string[];
    const methods = db.all<{ id: string; kind: string; url: string | null; secret: string | null; enabled: number }>(
      "SELECT id, kind, url, secret, enabled FROM notification_methods WHERE user_id = ?",
      rule.user_id,
    );
    const ev = db.get<EventRow>(
      "SELECT e.id, e.alert_id, a.name AS alert_name, e.transfer_json, e.matched_target_json, e.created_at FROM alert_events e JOIN alerts a ON a.id = e.alert_id WHERE e.id = ?",
      eventId,
    );
    if (!ev) return 0;
    const [event] = toEvents(this.ctx, rule.user_id, [ev]);
    const inApp = methods.find((m) => m.kind === "in_app");
    const record = (methodId: string, status: "sent" | "failed" | "skipped", detail: string | null) =>
      db.run("INSERT INTO alert_deliveries (id, event_id, method_id, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)", randomUUID(), eventId, methodId, status, detail, nowIso());
    let n = 0;
    if (inApp) {
      record(inApp.id, "sent", "in-app inbox");
      n++;
    }
    for (const id of ids) {
      const m = methods.find((x) => x.id === id);
      if (!m || m.kind !== "webhook") continue;
      if (!m.enabled || !m.url) {
        record(m.id, "skipped", "method disabled");
        n++;
        continue;
      }
      const { deliveries: _d, ...payloadEvent } = event!;
      const body = JSON.stringify({ type: "alert.event", event: payloadEvent });
      let res: { ok: boolean; status: number | null; detail: string };
      try {
        res = await this.ctx.sendWebhook(m.url, body, webhookHeaders(m.secret, body, "alert.event"));
      } catch (e) {
        res = { ok: false, status: null, detail: e instanceof Error ? e.message.slice(0, 120) : "delivery failed" };
      }
      record(m.id, res.ok ? "sent" : "failed", res.detail.slice(0, 200));
      db.run("UPDATE notification_methods SET last_status = ? WHERE id = ?", `${res.ok ? "ok" : "failed"}: ${res.detail}`.slice(0, 200), m.id);
      n++;
    }
    return n;
  }
}
