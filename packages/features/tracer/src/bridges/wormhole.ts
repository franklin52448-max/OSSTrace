import type { Address, ChainId } from "@osstrace/core";
import { canonicalAddress, isRealAddress } from "@osstrace/core";
import { isDecimalString } from "@osstrace/visualizer/src/decimal.ts";

/**
 * Wormhole support for Tracer. The design, and every source cited below, is in ADR 0012
 * (docs/adr/0012-tracer-cross-chain-bridge-hops-via-wormhole.md).
 *
 * Every fact here has a citation, the same rule ADR 0002 sets for labels. Checked 2026-10-22
 * against (1) https://wormhole.com/docs/reference/contract-addresses/, (2) Wormhole's official SDK,
 * wormhole-foundation/wormhole-sdk-ts @ c0dbf3498e9eb5dc40d2441ac61567a89d6fbde9,
 * core/base/src/constants/contracts/{core,tokenBridge}.ts ("Mainnet" tables), and (3) the chains
 * themselves (eth_getCode returns real bytecode for both Ethereum addresses; getAccountInfo
 * reports both Solana addresses as executable upgradeable-BPF programs).
 */
export const WORMHOLE_CONTRACTS = {
  ethereum: {
    coreBridge: "0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B",
    tokenBridge: "0x3ee18B2214AFF97000D974cf647E7C347E8fa585",
  },
  solana: {
    coreBridge: "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth",
    tokenBridge: "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb",
  },
} as const satisfies Record<ChainId, { coreBridge: string; tokenBridge: string }>;

export const WORMHOLE_CONTRACTS_SOURCE = {
  description: "Wormhole documentation, Contract Addresses (mainnet Core Bridge + Token Bridge); cross-checked against wormhole-sdk-ts @ c0dbf349 and on-chain",
  url: "https://wormhole.com/docs/reference/contract-addresses/",
  addedAt: "2026-10-22",
} as const;

/**
 * Wormhole's own chain IDs, which are not EVM chain IDs. Source: wormhole-sdk-ts @
 * c0dbf3498e9eb5dc40d2441ac61567a89d6fbde9, core/base/src/constants/chains.ts
 * (`[1, "Solana"]`, `[2, "Ethereum"]`).
 */
export const WORMHOLE_CHAIN_IDS: Readonly<Record<ChainId, number>> = { solana: 1, ethereum: 2 };

/** The OSSTrace chain for a Wormhole chain ID, or `null` for any chain OSSTrace has no adapter for. */
export function chainFromWormholeId(id: number | null): ChainId | null {
  if (id === WORMHOLE_CHAIN_IDS.ethereum) return "ethereum";
  if (id === WORMHOLE_CHAIN_IDS.solana) return "solana";
  return null;
}

export const DEFAULT_WORMHOLESCAN_API_URL = "https://api.wormholescan.io";

/**
 * One Wormhole transfer between two supported chains that involves the queried node, and that
 * Wormholescan has linked to a destination-chain transaction. Both tx hashes are real, as reported
 * by Wormholescan. Tracer does not re-fetch the destination tx to confirm it (ADR 0012, "What
 * this does not prove").
 */
export interface BridgeTransfer {
  protocol: "wormhole";
  /** `emitterChain/emitterAddress/sequence`: the signed message's (VAA's) own identity. */
  operationId: string;
  /** Wormhole apps Wormholescan attributes this to, e.g. `PORTAL_TOKEN_BRIDGE`, `NATIVE_TOKEN_TRANSFER`. */
  appIds: string[];
  /** Relative to the queried node: `"out"` = it sent this transfer, `"in"` = it received it. */
  direction: "in" | "out";
  source: { chain: ChainId; address: string; txHash: string; timestamp: string };
  /**
   * `address` is the recipient exactly as the signed message names it. For a Portal Token Bridge
   * transfer into Solana that is an SPL *token account*, not a wallet (ADR 0012).
   */
  target: { chain: ChainId; address: string; txHash: string; timestamp: string | null; status: string | null };
  /** As Wormholescan resolved it. Each field is `null` when it didn't, and is never guessed. */
  token: { address: string | null; wormholeChainId: number | null; symbol: string | null; amount: string | null };
  /** Where this link came from: Wormholescan's own record of the operation. */
  evidenceUrl: string;
}

export type BridgeDeadEndReason = "no-destination-tx" | "counterparty-chain-unsupported" | "counterparty-address-unresolved";

/**
 * A real Wormhole operation involving the queried node that Tracer can't follow as a hop. It is
 * reported so that a trail ending at a bridge says so, rather than silently dead-ending.
 */
export interface BridgeDeadEnd {
  protocol: "wormhole";
  operationId: string;
  /** The queried node this was found on, and its chain. */
  nodeId: string;
  nodeChain: ChainId;
  direction: "in" | "out";
  reason: BridgeDeadEndReason;
  sourceTxHash: string;
  sourceTimestamp: string;
  sourceWormholeChainId: number;
  targetWormholeChainId: number;
  /** The other end's address exactly as reported (on its own chain), or `null` when none was. */
  counterparty: string | null;
  evidenceUrl: string;
}

export interface ClassifiedOperations {
  transfers: BridgeTransfer[];
  deadEnds: BridgeDeadEnd[];
  /** Operations missing an id, chain IDs, source tx hash or source timestamp. Counted, never used. */
  malformed: number;
}

export type BridgeLookupResult = ({ available: true } & ClassifiedOperations) | { available: false; reason: string };

/** Finds bridge transfers involving one address. Wormhole is the only implementation (ADR 0012). */
export interface BridgeResolver {
  readonly protocol: "wormhole";
  lookup(node: Address, limit: number): Promise<BridgeLookupResult>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function sameAddress(chain: ChainId, candidate: string | null, nodeId: string): boolean {
  return candidate !== null && isRealAddress(chain, candidate) && canonicalAddress(chain, candidate) === nodeId;
}

export function operationEvidenceUrl(baseUrl: string, operationId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/v1/operations/${operationId}`;
}

/**
 * Classifies a Wormholescan `GET /api/v1/operations?address=` response body relative to `node`.
 * The function is pure and does no I/O.
 *
 * An operation counts only if the node is on the side of it that is on the node's own chain: the
 * sender of a message whose source chain is the node's chain, or the recipient of one whose
 * destination chain is the node's chain. An EVM address is the same 20 bytes on every EVM chain,
 * so Wormholescan also returns operations where that address acts on Base or Arbitrum. Those are
 * a different account, and they are dropped rather than credited to the Ethereum node.
 */
export function classifyWormholescanOperations(node: Address, body: unknown, baseUrl = DEFAULT_WORMHOLESCAN_API_URL): ClassifiedOperations | null {
  const operations = obj(body)["operations"];
  if (!Array.isArray(operations)) return null;

  const nodeId = canonicalAddress(node.chain, node.value);
  const transfers: BridgeTransfer[] = [];
  const deadEnds: BridgeDeadEnd[] = [];
  const seen = new Set<string>();
  let malformed = 0;

  for (const raw of operations) {
    const op = obj(raw);
    const std = obj(obj(op["content"])["standarizedProperties"]);
    const sourceChainInfo = obj(op["sourceChain"]);
    const targetChainInfo = obj(op["targetChain"]);

    const operationId = str(op["id"]);
    const sourceW = num(std["fromChain"]) ?? num(sourceChainInfo["chainId"]);
    const targetW = num(std["toChain"]) ?? num(targetChainInfo["chainId"]);
    const sourceTxHash = str(obj(sourceChainInfo["transaction"])["txHash"]);
    const sourceTimestamp = str(sourceChainInfo["timestamp"]);
    if (operationId === null || sourceW === null || targetW === null || sourceTxHash === null || sourceTimestamp === null) {
      malformed++;
      continue;
    }
    if (seen.has(operationId)) continue;
    seen.add(operationId);

    const sourceChain = chainFromWormholeId(sourceW);
    const targetChain = chainFromWormholeId(targetW);
    const sourceSigner = str(sourceChainInfo["from"]);
    const appSender = str(std["fromAddress"]);
    const recipient = str(std["toAddress"]);

    const isOut = sourceChain === node.chain && (sameAddress(node.chain, sourceSigner, nodeId) || sameAddress(node.chain, appSender, nodeId));
    const isIn = targetChain === node.chain && sameAddress(node.chain, recipient, nodeId);
    // Neither: this address acting on some other chain, or not this node at all. Both: a
    // same-chain message, which is not a cross-chain hop.
    if (isOut === isIn) continue;

    const direction = isOut ? "out" : "in";
    const counterpartyChain = isOut ? targetChain : sourceChain;
    const counterparty = isOut ? recipient : appSender ?? sourceSigner;
    const evidenceUrl = operationEvidenceUrl(baseUrl, operationId);
    const targetTxHash = str(obj(targetChainInfo["transaction"])["txHash"]);

    const deadEnd = (reason: BridgeDeadEndReason): void =>
      void deadEnds.push({
        protocol: "wormhole",
        operationId,
        nodeId,
        nodeChain: node.chain,
        direction,
        reason,
        sourceTxHash,
        sourceTimestamp,
        sourceWormholeChainId: sourceW,
        targetWormholeChainId: targetW,
        counterparty,
        evidenceUrl,
      });

    if (counterpartyChain === null) {
      deadEnd("counterparty-chain-unsupported");
      continue;
    }
    if (!isRealAddress(counterpartyChain, counterparty)) {
      deadEnd("counterparty-address-unresolved");
      continue;
    }
    if (targetTxHash === null || sourceChain === null || targetChain === null) {
      deadEnd("no-destination-tx");
      continue;
    }

    const sourceAddress = isOut ? nodeId : canonicalAddress(sourceChain, counterparty);
    const targetAddress = isOut ? canonicalAddress(targetChain, counterparty) : nodeId;
    const data = obj(op["data"]);
    const amount = str(data["tokenAmount"]);
    transfers.push({
      protocol: "wormhole",
      operationId,
      appIds: Array.isArray(std["appIds"]) ? std["appIds"].filter((a): a is string => typeof a === "string") : [],
      direction,
      source: { chain: sourceChain, address: sourceAddress, txHash: sourceTxHash, timestamp: sourceTimestamp },
      target: {
        chain: targetChain,
        address: targetAddress,
        txHash: targetTxHash,
        timestamp: str(targetChainInfo["timestamp"]),
        status: str(targetChainInfo["status"]),
      },
      token: {
        address: str(std["tokenAddress"]),
        wormholeChainId: num(std["tokenChain"]),
        symbol: str(data["symbol"]),
        amount: amount !== null && isDecimalString(amount) ? amount : null,
      },
      evidenceUrl,
    });
  }

  return { transfers, deadEnds, malformed };
}

export interface WormholescanResolverConfig {
  /** Defaults to the public API, which needs no key. Override with `WORMHOLESCAN_API_URL`. */
  baseUrl?: string;
  /** Per-request timeout. A slow third party must not hang a whole trace. */
  timeoutMs?: number;
}

/** Real lookups against Wormholescan's public operations API: one GET per node. See ADR 0012. */
export class WormholescanResolver implements BridgeResolver {
  readonly protocol = "wormhole" as const;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(config: WormholescanResolverConfig = {}) {
    this.#baseUrl = (config.baseUrl ?? DEFAULT_WORMHOLESCAN_API_URL).replace(/\/+$/, "");
    this.#timeoutMs = config.timeoutMs ?? 15_000;
  }

  async lookup(node: Address, limit: number): Promise<BridgeLookupResult> {
    const url = new URL(`${this.#baseUrl}/api/v1/operations`);
    url.searchParams.set("address", canonicalAddress(node.chain, node.value));
    url.searchParams.set("page", "0");
    url.searchParams.set("pageSize", String(limit));

    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (cause) {
      return { available: false, reason: `Wormholescan: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
    if (!response.ok) return { available: false, reason: `Wormholescan: HTTP ${response.status}` };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { available: false, reason: "Wormholescan: response was not JSON" };
    }
    const classified = classifyWormholescanOperations(node, body, this.#baseUrl);
    if (classified === null) return { available: false, reason: "Wormholescan: unexpected response shape (no operations array)" };
    return { available: true, ...classified };
  }
}
