import { compareDecimal } from "@osstrace/visualizer/src/decimal.ts";
import type { TraceEdge } from "./edges.ts";

/**
 * What a traced path is required to carry at *every* hop, not just somewhere in it — tracing
 * "did A's funds reach B" means following one continuous flow, not finding any qualifying edge
 * buried a few hops away from an otherwise-unrelated path. See the Tracer README and ADR 0008.
 */
export interface TraceFilters {
  /** A token symbol (case-insensitive), or the literal `"native"` for the chain's own currency. */
  token?: string;
  /** Minimum amount, inclusive, as a decimal string in that token's own units. */
  minAmount?: string;
  /** ISO 8601 — only edges at or after this instant count. An edge with no known timestamp never does. */
  sinceTimestamp?: string;
  /** ISO 8601 — only edges at or before this instant count. An edge with no known timestamp never does. */
  untilTimestamp?: string;
}

/**
 * The edge's own amount in its own unit — `valueNative` for a native edge, `token.amount` for a
 * token edge. `null` when the token's decimals were never resolved (core's `TokenTransfer.amount`
 * contract): never guessed, so a `minAmount` filter can never silently count an unknown amount as
 * satisfying it. A bridge edge's amount is Wormholescan's reported token amount, or `null` when it
 * didn't report one (ADR 0012).
 */
function edgeAmount(edge: TraceEdge): string | null {
  return edge.kind === "native" ? edge.valueNative : edge.token?.amount ?? null;
}

/** A bridge hop is a token movement (`valueNative` is always "0"), so it is matched on its token symbol. */
function edgeTokenSymbol(edge: TraceEdge): string | null {
  return edge.kind === "native" ? null : edge.token?.symbol ?? null;
}

/**
 * This project never converts between tokens or to a USD value (that would mean inventing an
 * exchange rate — the same reason `NodeStats.totalIn`/`totalOut` never mix token types). A
 * `minAmount` filter on `"USDC"` works directly because USDC is itself ~$1; a `minAmount` filter
 * meant as "$100 of ETH" does not exist here and isn't claimed to.
 */
export function edgeMatchesFilters(edge: TraceEdge, filters: TraceFilters): boolean {
  if (filters.sinceTimestamp !== undefined || filters.untilTimestamp !== undefined) {
    // An edge whose transaction has no reported timestamp (ADR 0016) can't be shown to fall inside
    // a time window, so it fails any `since`/`until` filter — the same "unknown fails the filter"
    // rule as an unresolved amount or symbol below (ADR 0012). Explicit, rather than leaving it to
    // whatever a `NaN` comparison happens to do.
    if (edge.timestamp === null) return false;
    const at = Date.parse(edge.timestamp);
    if (Number.isNaN(at)) return false;
    if (filters.sinceTimestamp !== undefined && at < Date.parse(filters.sinceTimestamp)) return false;
    if (filters.untilTimestamp !== undefined && at > Date.parse(filters.untilTimestamp)) return false;
  }

  if (filters.token !== undefined) {
    if (filters.token.toLowerCase() === "native") {
      if (edge.kind !== "native") return false;
    } else {
      const symbol = edgeTokenSymbol(edge);
      if (symbol === null || symbol.toLowerCase() !== filters.token.toLowerCase()) return false;
    }
  }

  if (filters.minAmount !== undefined) {
    const amount = edgeAmount(edge);
    if (amount === null) return false;
    if (compareDecimal(amount, filters.minAmount) < 0) return false;
  }

  return true;
}
