import type { ParsedInstruction, ParsedTransactionWithMeta, PartiallyDecodedInstruction } from "@solana/web3.js";
import type { TokenTransfer, TransferDirection } from "@osstrace/core";
import { formatTokenAmount } from "./units.ts";

/**
 * Pure decoding of SPL Token transfers out of a `getParsedTransaction(s)` result — no RPC calls.
 *
 * The RPC's `jsonParsed` encoding already decodes SPL Token (and Token-2022) instructions; this
 * module reads those decoded instructions plus the transaction's own `pre/postTokenBalances`,
 * and reports only what those actually say. Nothing is looked up elsewhere or inferred.
 */

/** Both the classic SPL Token program and Token-2022 parse to the same instruction shapes. */
const TOKEN_PROGRAMS = new Set(["spl-token", "spl-token-2022"]);
const INITIALIZE_ACCOUNT_TYPES = new Set(["initializeAccount", "initializeAccount2", "initializeAccount3"]);

type AnyInstruction = ParsedInstruction | PartiallyDecodedInstruction;

interface ParsedTokenInstruction {
  type: string;
  info: Record<string, unknown>;
}

interface TokenAccountInfo {
  mint: string | null;
  owner: string | null;
  decimals: number | null;
}

function tokenInstruction(ix: AnyInstruction): ParsedTokenInstruction | null {
  if (!("parsed" in ix) || !TOKEN_PROGRAMS.has(ix.program)) return null;
  const parsed = ix.parsed as unknown;
  if (typeof parsed !== "object" || parsed === null) return null;
  const { type, info } = parsed as { type?: unknown; info?: unknown };
  if (typeof type !== "string" || typeof info !== "object" || info === null) return null;
  return { type, info: info as Record<string, unknown> };
}

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** Every instruction in execution order: each top-level instruction followed by its inner ones. */
export function allInstructionsInOrder(tx: ParsedTransactionWithMeta): AnyInstruction[] {
  const inner = new Map<number, AnyInstruction[]>();
  for (const group of tx.meta?.innerInstructions ?? []) {
    inner.set(group.index, group.instructions);
  }
  return tx.transaction.message.instructions.flatMap((ix, i) => [ix, ...(inner.get(i) ?? [])]);
}

/**
 * What the transaction itself tells us about each token account: mint/owner/decimals from
 * `pre/postTokenBalances`, plus mint/owner from any `initializeAccount*` instruction in the same
 * transaction (that's how a temporary account — created and closed inside one swap, so absent
 * from both balance lists — still gets its real owner). Decimals for such an account come from
 * any balance entry of the same mint; otherwise they stay unknown.
 */
function tokenAccountsFromTransaction(tx: ParsedTransactionWithMeta, instructions: AnyInstruction[]): Map<string, TokenAccountInfo> {
  const keys = tx.transaction.message.accountKeys.map((key) => key.pubkey.toString());
  const accounts = new Map<string, TokenAccountInfo>();
  const mintDecimals = new Map<string, number>();

  for (const balance of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) {
    const account = keys[balance.accountIndex];
    mintDecimals.set(balance.mint, balance.uiTokenAmount.decimals);
    if (!account || accounts.has(account)) continue;
    accounts.set(account, { mint: balance.mint, owner: balance.owner ?? null, decimals: balance.uiTokenAmount.decimals });
  }

  for (const ix of instructions) {
    const parsed = tokenInstruction(ix);
    if (!parsed || !INITIALIZE_ACCOUNT_TYPES.has(parsed.type)) continue;
    const account = str(parsed.info["account"]);
    if (!account || accounts.has(account)) continue;
    const mint = str(parsed.info["mint"]);
    accounts.set(account, {
      mint,
      owner: str(parsed.info["owner"]),
      decimals: mint !== null ? (mintDecimals.get(mint) ?? null) : null,
    });
  }
  return accounts;
}

function direction(outgoing: boolean, incoming: boolean): TransferDirection {
  if (outgoing && incoming) return "self";
  return outgoing ? "out" : "in";
}

/**
 * Every decoded SPL Token `transfer` / `transferChecked` (top-level or inner) whose source or
 * destination — the token account itself, or that account's owner — is `address`, in execution
 * order. `transferChecked` carries its own mint and decimals; a plain `transfer` doesn't, so those
 * come from the transaction's token-balance data for the accounts involved, and stay `null` if it
 * has none. `from`/`to` are the token accounts' owners when known, else `null`.
 */
export function decodeSplTransfers(tx: ParsedTransactionWithMeta, address: string): TokenTransfer[] {
  const instructions = allInstructionsInOrder(tx);
  const accounts = tokenAccountsFromTransaction(tx, instructions);
  const transfers: TokenTransfer[] = [];

  for (const ix of instructions) {
    const parsed = tokenInstruction(ix);
    if (!parsed || (parsed.type !== "transfer" && parsed.type !== "transferChecked")) continue;
    const source = str(parsed.info["source"]);
    const destination = str(parsed.info["destination"]);
    if (!source || !destination) continue;

    const sourceInfo = accounts.get(source);
    const destinationInfo = accounts.get(destination);
    const from = sourceInfo?.owner ?? null;
    const to = destinationInfo?.owner ?? null;
    const outgoing = source === address || from === address;
    const incoming = destination === address || to === address;
    if (!outgoing && !incoming) continue;

    let mint: string | null;
    let decimals: number | null;
    let rawAmount: string | null;
    if (parsed.type === "transferChecked") {
      const tokenAmount = parsed.info["tokenAmount"] as { amount?: unknown; decimals?: unknown } | undefined;
      mint = str(parsed.info["mint"]);
      decimals = typeof tokenAmount?.decimals === "number" ? tokenAmount.decimals : null;
      rawAmount = str(tokenAmount?.amount);
    } else {
      mint = sourceInfo?.mint ?? destinationInfo?.mint ?? null;
      decimals = sourceInfo?.decimals ?? destinationInfo?.decimals ?? null;
      const amount = parsed.info["amount"];
      rawAmount = typeof amount === "number" ? String(amount) : str(amount);
    }
    if (rawAmount === null || !/^\d+$/.test(rawAmount)) continue;

    transfers.push({
      token: mint,
      // Solana mints carry no on-chain symbol/name; that lives in separate metadata accounts
      // this adapter doesn't fetch, so these are honestly unknown rather than guessed.
      symbol: null,
      name: null,
      decimals,
      rawAmount,
      amount: decimals !== null ? formatTokenAmount(rawAmount, decimals) : null,
      from,
      to,
      fromTokenAccount: source,
      toTokenAccount: destination,
      direction: direction(outgoing, incoming),
    });
  }
  return transfers;
}
