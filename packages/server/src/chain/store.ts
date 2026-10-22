import type { Chain, Transfer } from "@osstrace/contract";
import type { Db } from "../db/index.ts";
import type { LabelIndex } from "../services/labelIndex.ts";
import { secToIso } from "../lib/time.ts";
import { formatUnits } from "./amount.ts";
import type { RawTransfer } from "./types.ts";

export type TransferRow = {
  chain: Chain;
  id: string;
  seq: number;
  block_number: number;
  block_time: number;
  tx_hash: string;
  from_addr: string;
  to_addr: string;
  from_owner: string | null;
  to_owner: string | null;
  token_id: string;
  token_symbol: string | null;
  token_name: string | null;
  token_decimals: number | null;
  token_standard: string | null;
  amount_raw: string;
  amount: string;
  amount_num: number;
  usd: number | null;
  price_source: string | null;
  price_checked_at: string | null;
};

export const TRANSFER_COLS =
  "t.chain, t.id, t.seq, t.block_number, t.block_time, t.tx_hash, t.from_addr, t.to_addr, t.from_owner, t.to_owner, t.token_id, t.token_symbol, t.token_name, t.token_decimals, t.token_standard, t.amount_raw, t.amount, t.amount_num, t.usd, t.price_source, t.price_checked_at";

/** SQL predicate: the transfer touches `?` on the from side (address or token-account owner). */
export const FROM_IS = (p: string) => `(t.from_addr = ${p} OR t.from_owner = ${p})`;
export const TO_IS = (p: string) => `(t.to_addr = ${p} OR t.to_owner = ${p})`;

export class TransferStore {
  private seq: number;
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
    this.seq = Number(db.get<{ m: number | null }>("SELECT MAX(seq) AS m FROM transfers")?.m ?? 0);
  }

  /** Inserts new transfers (existing ids are left untouched). Returns the number inserted. */
  upsert(rows: RawTransfer[]): number {
    if (rows.length === 0) return 0;
    // Oldest first, so seq follows chain order within a page.
    const sorted = [...rows].sort((a, b) => a.blockTime - b.blockTime || a.id.localeCompare(b.id));
    let inserted = 0;
    this.db.tx(() => {
      for (const r of sorted) {
        const amount = formatUnits(r.amountRaw, r.tokenDecimals);
        const res = this.db.run(
          `INSERT INTO transfers (chain, id, seq, block_number, block_time, tx_hash, from_addr, to_addr, from_owner, to_owner,
             token_id, token_symbol, token_name, token_decimals, token_standard, amount_raw, amount, amount_num, usd, price_source, price_checked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
           ON CONFLICT (chain, id) DO NOTHING`,
          r.chain,
          r.id,
          this.seq + 1,
          r.blockNumber,
          r.blockTime,
          r.txHash,
          r.from,
          r.to,
          r.fromOwner,
          r.toOwner,
          r.tokenId,
          r.tokenSymbol,
          r.tokenName,
          r.tokenDecimals,
          r.tokenStandard,
          r.amountRaw,
          amount,
          Number(amount),
          // Assets without a fungible price (NFTs) are marked checked right away: usd stays NULL.
          r.priceCoin ? null : "n/a",
        );
        if (res.changes > 0) {
          this.seq++;
          inserted++;
        }
      }
    });
    return inserted;
  }

  get(chain: Chain, id: string): TransferRow | undefined {
    return this.db.get<TransferRow>(`SELECT ${TRANSFER_COLS} FROM transfers t WHERE t.chain = ? AND t.id = ?`, chain, id);
  }

  getMany(keys: { chain: Chain; id: string }[]): Map<string, TransferRow> {
    const out = new Map<string, TransferRow>();
    for (const k of keys) {
      const r = this.get(k.chain, k.id);
      if (r) out.set(`${k.chain}:${k.id}`, r);
    }
    return out;
  }

  static coinFor(r: Pick<TransferRow, "chain" | "token_id" | "token_standard">): string | null {
    if (r.token_standard === "erc721" || r.token_standard === "erc1155") return null;
    if (r.token_id === "native") return r.chain === "ethereum" ? "coingecko:ethereum" : "coingecko:solana";
    return `${r.chain}:${r.token_id}`;
  }
}

export function rowAddresses(rows: TransferRow[]) {
  const out: { chain: Chain; address: string }[] = [];
  for (const r of rows) {
    out.push({ chain: r.chain, address: r.from_addr }, { chain: r.chain, address: r.to_addr });
    if (r.from_owner) out.push({ chain: r.chain, address: r.from_owner });
    if (r.to_owner) out.push({ chain: r.chain, address: r.to_owner });
  }
  return out;
}

export function rowToTransfer(r: TransferRow, ix: LabelIndex): Transfer {
  return {
    id: r.id,
    chain: r.chain,
    txHash: r.tx_hash,
    blockNumber: Number(r.block_number),
    blockTimestamp: secToIso(Number(r.block_time)).replace(/\.\d+Z$/, ".000Z"),
    from: ix.info(r.chain, r.from_addr, r.from_owner),
    to: ix.info(r.chain, r.to_addr, r.to_owner),
    tokenId: r.token_id,
    tokenSymbol: r.token_symbol,
    tokenName: r.token_name,
    tokenDecimals: r.token_decimals === null ? null : Number(r.token_decimals),
    amountRaw: r.amount_raw,
    amount: r.amount,
    usd: r.usd === null ? null : Number(r.usd),
    priceSource: r.usd === null ? null : r.price_source,
  };
}

/** Snapshot without labels (stored in alert events; labels are joined again when read). */
export function rowSnapshot(r: TransferRow): TransferRow {
  return { ...r };
}
