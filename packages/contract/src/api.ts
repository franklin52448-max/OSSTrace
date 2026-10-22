// REST contract for OSSTrace. All routes are under /api, JSON in/out, cookie session (httpOnly, SameSite=Lax).
// Mutating requests (POST/PUT/PATCH/DELETE) MUST send `Content-Type: application/json` (or no body) and
// pass an Origin check. Errors: HTTP status + `ApiError` body.
// Both the server and the web client import these types; changing one means changing both.

import type {
  AddressInfo,
  BalancesResponse,
  Chain,
  Counterparty,
  TagRef,
  Trace,
  TraceOp,
  TraceSummary,
  Transfer,
  VisualizerOp,
  VisualizerState,
  VisualizerView,
  VisualizerViewSummary,
} from "./types.ts";

export type ApiError = {
  error: {
    code:
      | "bad_request"
      | "unauthorized"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "rate_limited"
      | "provider_error" // upstream chain data provider failed or is rate limited; never replaced by fake data
      | "internal";
    message: string;
    /** For provider_error: which provider and whether a retry might help. */
    provider?: { id: string; retryAfterSec?: number };
  };
};

// ---------- Auth & account ----------
// Identity is the wallet: a user IS a (chain, walletAddress) pair, verified by a signed challenge.
// `username` is an internal unique handle, never chosen or shown; `displayName` is the only
// identity field a signed-in user can change (PATCH /api/settings).
export type User = { id: string; username: string; displayName: string; createdAt: string; chain: "solana" | "ethereum" | null; walletAddress: string | null };
export type AuthResponse = { user: User };
export type ChallengeRequest = { chain: "solana" | "ethereum"; address: string };
export type ChallengeResponse = { message: string };
export type VerifyRequest = { chain: "solana" | "ethereum"; address: string; signature: string };
export type SessionInfo = { id: string; createdAt: string; lastSeenAt: string; userAgent: string | null; current: boolean };
// POST /api/auth/challenge {chain,address} -> ChallengeResponse: a message to sign, valid 5 minutes, single-use.
// POST /api/auth/verify {chain,address,signature} -> AuthResponse (sets cookie): verifies the signature over the
// pending challenge for that wallet, then finds or creates the user for (chain, address).
// POST /api/auth/logout -> 204; GET /api/auth/me -> AuthResponse | 401.
// GET /api/auth/sessions -> SessionInfo[]; DELETE /api/auth/sessions/:id -> 204; DELETE /api/auth/account -> 204
// (deleting the account just needs a valid session -- the wallet signature that started it already proved ownership).
// Rate limits: challenges per ip; verify failures per (ip, chain:address), same backoff shape as the old login throttle.

// ---------- Settings ----------
export type Preferences = {
  theme: "dark" | "light";
  defaultChain: Chain;
  defaultUsdGte: number; // default USD floor for transfers/counterparties (default 1)
  defaultTimeLast: "1d" | "7d" | "30d" | "90d" | "1y" | "all";
  flowDots: boolean;
  timezone: string; // IANA
};
export type Settings = { user: User; preferences: Preferences };
export type UpdateSettingsRequest = { displayName?: string; preferences?: Partial<Preferences> };
// GET /api/settings -> Settings; PATCH /api/settings -> Settings

export type NotificationMethod =
  | { id: string; kind: "webhook"; name: string; url: string; enabled: boolean; createdAt: string; lastStatus?: string | null }
  | { id: string; kind: "in_app"; name: string; enabled: boolean; createdAt: string };
export type CreateNotificationMethod = { kind: "webhook"; name: string; url: string; secret?: string };
export type WebhookTestResult = { ok: boolean; status: number | null; detail: string };
// GET /api/settings/notification-methods -> NotificationMethod[] (in_app one always exists, cannot be deleted)
// POST -> NotificationMethod; PATCH /:id {name?, enabled?, url?}; DELETE /:id -> 204; POST /:id/test -> WebhookTestResult
// Webhook URLs must be http(s) and must NOT resolve to loopback/private/link-local addresses (SSRF guard).

// ---------- Chains, search, address data ----------
export type ChainStatus = { id: Chain; name: string; provider: string; ok: boolean; note?: string };
export type SearchHit =
  | { type: "address"; chain: Chain; address: string; info: AddressInfo }
  | { type: "label"; id: string; chain: Chain; address: string; name: string }
  | { type: "entity"; id: string; name: string; addressCount: number };
// GET /api/chains -> ChainStatus[]
// GET /api/search?q=&limit= -> { hits: SearchHit[] } (address detection by format + user's labels/entities)
// GET /api/address/:chain/:address -> AddressInfo
// GET /api/address/:chain/:address/balances -> BalancesResponse

export type CounterpartiesQuery = { flow?: "in" | "out" | "all"; limit?: number; timeLast?: string; timeGte?: string; timeLte?: string; usdGte?: number };
// GET /api/address/:chain/:address/counterparties -> { counterparties: Counterparty[]; sync: SyncStatus }

export type SyncStatus = {
  state: "ready" | "syncing" | "partial" | "error";
  /** Oldest transaction time covered by the local cache for the queried addresses (ISO) or null. */
  coveredFrom: string | null;
  provider: string;
  message?: string;
};

export type TransfersQuery = {
  /** repeatable `chain:address` (also accepts bare address with detectable chain) */
  base?: string[];
  counterparties?: string[];
  flow?: "in" | "out" | "all" | "self";
  usdGte?: number;
  usdLte?: number;
  valueGte?: number;
  valueLte?: number;
  tokens?: string[];
  chain?: Chain;
  timeLast?: string; // 1h 12h 1d 7d 30d 1y
  timeGte?: string;
  timeLte?: string;
  sortKey?: "time" | "value" | "usd";
  sortDir?: "asc" | "desc";
  limit?: number; // default 20, max 1000
  cursor?: string; // opaque keyset cursor
};
export type TransfersResponse = {
  transfers: Transfer[];
  nextCursor: string | null;
  /** Count of rows matching in the local cache; `capped` when over 10,000. */
  count: { value: number; capped: boolean };
  sync: SyncStatus;
};
// GET /api/transfers -> TransfersResponse

// ---------- Tracer ----------
// POST /api/traces {initialAddress?, initialChain?} -> { id } (server creates the root node with a deterministic id)
// GET /api/traces -> TraceSummary[] (updatedAt desc); GET /api/traces/:id -> Trace (labels re-joined at read time)
// DELETE /api/traces/:id -> 204
// POST /api/traces/:id/batch {ops} -> BatchResult (<= 500 ops, atomic, idempotent)
// POST /api/traces/:id/aggregate-summary {fromNodeID, toNodeID} -> AggregateSummaryResponse (not persisted)
// POST /api/traces/:id/edges/:edgeId/refresh -> Trace edge (recomputes cached aggregate)
// GET /api/public/traces/:id -> Trace (only when shareable; isOwner=false; 404 otherwise)
export type CreateTraceRequest = { initialAddress?: string; initialChain?: Chain; title?: string };
export type BatchRequest<O> = { ops: O[] };
export type BatchResult = { updatedAt: string; applied: number; skipped: number };
export type TraceBatchRequest = BatchRequest<TraceOp>;
export type AggregateSummaryRequest = { fromNodeID: string; toNodeID: string };
export type AggregateSummaryResponse = {
  cachedUSDIn: number;
  cachedTransactionCountIn: number;
  cachedUSDOut: number;
  cachedTransactionCountOut: number;
  cachedAt: string;
  sync: SyncStatus;
};

// ---------- Visualizer ----------
// POST /api/views {name, state} -> { id }; GET /api/views -> VisualizerViewSummary[]; GET /api/views/:id -> VisualizerView
// POST /api/views/:id/batch {ops} -> BatchResult; DELETE /api/views/:id -> 204
// GET /api/public/views/:id -> VisualizerView (only when shareable)
// POST /api/views/:id/send-to-tracer {nodeIDs?} -> { traceId }   (server builds neighbourhood from state, optional)
export type CreateViewRequest = { name: string; state: VisualizerState };
export type ViewBatchRequest = BatchRequest<VisualizerOp>;
export type ViewListItem = VisualizerViewSummary;

// ---------- Labels, entities, tags (all private to the user; the only label source in v1) ----------
export type Label = {
  id: string;
  chain: Chain;
  address: string;
  name: string;
  note: string | null;
  entityId: string | null;
  tagIds: string[];
  createdAt: string;
  updatedAt: string;
};
export type Entity = {
  id: string;
  name: string;
  type: string | null; // free text: exchange, fund, individual, protocol...
  note: string | null;
  website: string | null;
  twitter: string | null;
  tagIds: string[];
  addressCount: number;
  createdAt: string;
  updatedAt: string;
};
export type Tag = TagRef & { createdAt: string; usageCount: number };
export type CreateLabel = { chain: Chain; address: string; name: string; note?: string; entityId?: string | null; tagIds?: string[] };
export type CreateEntity = { name: string; type?: string; note?: string; website?: string; twitter?: string; tagIds?: string[] };
export type CreateTag = { name: string; color?: string };
export type LabelsQuery = { chain?: Chain; q?: string; entityId?: string; tagId?: string; limit?: number; cursor?: string };
export type LabelsResponse = { labels: Label[]; nextCursor: string | null; total: number };
/** `skipped[].row`: CSV = line number in the file (header is line 1, so the first data row is 2); JSON = 1-based array index. */
export type ImportResult = { created: number; updated: number; skipped: { row: number; reason: string }[] };
// GET /api/labels (LabelsQuery) -> LabelsResponse; POST /api/labels -> Label; PATCH /api/labels/:id; DELETE /api/labels/:id
// POST /api/labels/import {format:"csv"|"json", data:string, onConflict:"update"|"skip"} -> ImportResult
//   CSV columns: chain,address,name,note,entity,tags(semicolon-separated)  (entity/tags created if missing)
// GET /api/labels/export?format=csv|json -> file download
// GET/POST /api/entities, GET/PATCH/DELETE /api/entities/:id (GET includes `addresses: Label[]`)
// GET/POST /api/tags, PATCH/DELETE /api/tags/:id

// ---------- Alerts ----------
export type AlertTarget = { type: "address"; chain: Chain; address: string } | { type: "entity"; entityId: string };
export type AlertRule = {
  id: string;
  name: string;
  enabled: boolean;
  targets: AlertTarget[];
  direction: "in" | "out" | "both";
  minUsd: number | null;
  tokens: string[] | null; // tokenIds; null = any
  methodIds: string[]; // notification methods; in_app is implied
  createdAt: string;
  updatedAt: string;
  lastTriggeredAt: string | null;
  eventCount: number;
};
export type CreateAlertRule = Omit<AlertRule, "id" | "createdAt" | "updatedAt" | "lastTriggeredAt" | "eventCount">;
export type AlertEvent = {
  id: string;
  alertId: string;
  alertName: string;
  transfer: Transfer;
  matchedTarget: AlertTarget;
  createdAt: string;
  deliveries: { methodId: string; status: "sent" | "failed" | "skipped"; detail?: string }[];
};
export type Notification = { id: string; eventId: string; alertId?: string; alertName: string; transfer: Transfer; createdAt: string; read: boolean };
export type AlertLimits = { maxRules: number; maxTargetsPerRule: number; pollIntervalSec: number };
// GET/POST /api/alerts; GET/PATCH/DELETE /api/alerts/:id; GET /api/alerts/:id/events?limit&cursor -> {events, nextCursor}
// GET /api/alerts/limits -> AlertLimits
// GET /api/notifications?unread=1&limit&cursor -> {notifications, nextCursor, unreadCount}
// POST /api/notifications/read {ids?: string[], all?: boolean} -> 204
// Semantics: the worker polls watched addresses every pollIntervalSec; an alert only fires for transfers with
// blockTimestamp AFTER the rule's creation/enable time (no backfill spam); each (rule, transfer) fires once.

// ---------- Bounties ----------
// This project never custodies a payout: `reward` is the poster's own free-text claim, and a
// `Deposit` is only ever independently-checked evidence a real on-chain payment happened (ADR
// 0009, ADR 0020). Resolving/claiming/cancelling a bounty requires being its own opener -- there
// is no separate moderator role now that accounts are wallet-based.
export type BountyStatus = "open" | "claimed" | "cancelled";
export type BountyAsset = "native" | { contract: string };
export type BountyDeposit = {
  id: string;
  chain: Chain;
  asset: BountyAsset;
  amount: string;
  txRef: string;
  fromAddress: string;
  toWallet: string;
  memo?: string;
  recordedBy: string;
  recordedAt: string;
};
export type BountySubmission = { id: string; bountyId: string; submittedBy: string; prUrl: string; note: string; submittedAt: string; outcome: "pending" | "accepted" | "rejected" };
export type Bounty = {
  id: string;
  status: BountyStatus;
  title: string;
  description: string;
  reward: string;
  openedBy: string;
  openedAt: string;
  claimedSubmissionId?: string;
  claimedBy?: string;
  claimedAt?: string;
  resolvedBy?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  cancellationReason?: string;
  submissions: BountySubmission[];
  deposits: BountyDeposit[];
};
export type CreateBounty = { title: string; description: string; reward: string };
export type BountyWallets = { ethereum?: string; solana?: string };
// GET /api/bounties/wallets -> BountyWallets (public config; a chain missing means it's not configured)
// GET /api/bounties -> Bounty[] (no auth -- "anyone can browse"); GET /api/bounties/:id -> Bounty
// POST /api/bounties (CreateBounty) -> Bounty
// POST /api/bounties/:id/submissions {prUrl, note?} -> BountySubmission (bounty must be "open")
// POST /api/bounties/:id/claim {submissionId} -> Bounty (opener only)
// POST /api/bounties/:id/cancel {reason} -> Bounty (opener only)
// POST /api/bounties/:id/deposits {chain, txRef} -> BountyDeposit (any signed-in user; the real
//   on-chain payment is independently verified server-side, not trusted from the request)

export type HealthResponse = { ok: true; version: string; chains: ChainStatus[]; /** false when ALLOW_SIGNUP=false; clients treat undefined as true */ allowSignup?: boolean };
// GET /api/health -> HealthResponse (no auth)

// Re-exports so consumers can import everything API-related from one place
export type { AddressInfo, BalancesResponse, Counterparty, Trace, TraceSummary, Transfer, VisualizerView };
