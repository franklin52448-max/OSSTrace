/**
 * The real backend services the UI talks to, on ephemeral ports, over real temp-file stores —
 * the same handlers `npm run dev:*` serves. The one thing a test controls is network timing:
 * `held()` sits in front of a real handler and keeps each request waiting until the test
 * releases it, so a test can make responses land in any order it likes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountService, JsonFileAccountStore, createAccountsHandler } from "@osstrace/accounts";
import {
  CommunityLabelReader,
  JsonFileSubmissionStore,
  LabelSubmissionService,
  createLabelSubmissionsHandler,
} from "@osstrace/community-labels";
import {
  CompositeLabelStore,
  InMemoryCache,
  JsonFileLabelStore,
  type Balance,
  type ChainAdapter,
  type ChainId,
  type TransactionsResult,
} from "@osstrace/core";
import { createExplorerHandler } from "@osstrace/explorer/src/http.ts";
// --- private-labels (imports) ---
import { JsonFilePrivateLabelStore, PrivateLabelService, createPrivateLabelsHandler } from "@osstrace/private-labels";
// --- live stream (imports) ---
import { InMemoryEventBus } from "@osstrace/explorer/src/events.ts";
import { Indexer } from "@osstrace/explorer/src/indexing.ts";
import { attachStream, StreamHub } from "@osstrace/explorer/src/stream.ts";
// --- end ---
import { WEB_ORIGIN } from "./env.ts";
// --- BEGIN view backends (bounties, cases, risk, tracer, visualizer): imports -----------------
import type { TransactionSummary } from "@osstrace/core";
import { BountyService, JsonFileBountyStore, createBountiesHandler } from "@osstrace/bounties";
import type { DepositVerification, DepositVerifier } from "@osstrace/bounties/src/deposits.ts";
import { CaseService, JsonFileCaseStore, createCasesHandler } from "@osstrace/case-management";
// risk-scoring, tracer and visualizer have no index.ts (their package "main" is server.ts, which
// listens on import): import their real handlers the way their own server.ts files do.
import { createRiskScoringHandler } from "@osstrace/risk-scoring/src/http.ts";
import { WormholescanResolver } from "@osstrace/tracer/src/bridges/wormhole.ts";
import { createTracerHandler } from "@osstrace/tracer/src/http.ts";
import { createVisualizerHandler } from "@osstrace/visualizer/src/http.ts";
// --- END view backends: imports ---------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

/**
 * A real, concrete stand-in for `BountyService`'s injected `DepositVerifier` (ADR 0020) — not a
 * mocking framework. A test preprograms exactly what a given `(chain, txRef)` should verify as;
 * the real on-chain decode logic itself has its own tests, against real recorded mainnet data, in
 * `packages/features/bounties/tests/deposits.test.ts`.
 */
export class StandInDepositVerifier implements DepositVerifier {
  readonly #answers = new Map<string, DepositVerification>();
  set(chain: "ethereum" | "solana", txRef: string, result: DepositVerification): void {
    this.#answers.set(`${chain}:${txRef}`, result);
  }
  async verify(chain: "ethereum" | "solana", txRef: string): Promise<DepositVerification> {
    return this.#answers.get(`${chain}:${txRef}`) ?? { ok: false, reason: "not_found" };
  }
}

export interface Running {
  url: string;
  close(): Promise<void>;
}

export async function listen(handler: Handler): Promise<Running> {
  const server: Server = createServer((req, res) => void handler(req, res));
  // No websocket endpoint here (e.g. the Explorer's /stream): refuse the upgrade outright, so the
  // UI sees a closed socket the same way it would against an API without one.
  server.on("upgrade", (_req, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface HeldRequest {
  method: string;
  path: string;
  /** Lets the real handler answer it. Resolves once the whole response has been written. */
  release(): Promise<void>;
}

/** Wraps a real handler so every request waits for the test to release it. */
export function held(handler: Handler): { handler: Handler; next(path: string): Promise<HeldRequest> } {
  const arrived: HeldRequest[] = [];
  const waiting: { path: string; resolve(request: HeldRequest): void }[] = [];
  return {
    handler(req, res) {
      const request: HeldRequest = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        release: () =>
          new Promise<void>((resolve) => {
            res.on("finish", () => resolve());
            void handler(req, res);
          }),
      };
      const index = waiting.findIndex((w) => w.path === request.path);
      if (index >= 0) waiting.splice(index, 1)[0]?.resolve(request);
      else arrived.push(request);
    },
    /** The next request (already arrived, or still to come) for exactly this path. */
    next(path) {
      const index = arrived.findIndex((r) => r.path === path);
      if (index >= 0) return Promise.resolve(arrived.splice(index, 1)[0] as HeldRequest);
      return new Promise((resolve) => waiting.push({ path, resolve }));
    },
  };
}

/**
 * The upstream chain, which is the one piece that can't be real in a test: a real
 * `ChainAdapter` serving a fixed balance per address (like the Explorer's own tests'
 * RecordingAdapter), so each address's report is recognisable on screen.
 */
export class FixedBalanceAdapter implements ChainAdapter {
  readonly chain: ChainId;
  readonly #balances: Map<string, string>;

  constructor(chain: ChainId, balances: Record<string, string>) {
    this.chain = chain;
    this.#balances = new Map(Object.entries(balances).map(([address, amount]) => [address.toLowerCase(), amount]));
  }

  async getBalance(address: string): Promise<Balance> {
    const amount = this.#balances.get(address.toLowerCase());
    if (amount === undefined) throw new Error(`no balance configured for ${address}`);
    return { chain: this.chain, address, native: { symbol: "ETH", amount, decimals: 18 }, asOf: "2026-10-22T00:00:00Z" };
  }

  async getRecentTransactions(): Promise<TransactionsResult> {
    return { available: true, transactions: [] };
  }
}

// --- BEGIN view backends: chain-history stand-in ---------------------------------------------
/**
 * `FixedBalanceAdapter` plus a fixed transaction history per address, for the views that walk
 * transactions (Visualizer, Tracer, Risk scoring's hop search). Same idea as those packages' own
 * tests' adapters: a real `ChainAdapter` with configured data, never a mocking framework. An
 * address with no configured history gets an empty (but available) history: "no activity".
 */
export class FixedHistoryAdapter implements ChainAdapter {
  readonly chain: ChainId;
  readonly #balances: FixedBalanceAdapter;
  readonly #history: Map<string, TransactionSummary[]>;

  constructor(chain: ChainId, balances: Record<string, string>, history: Record<string, TransactionSummary[]>) {
    this.chain = chain;
    this.#balances = new FixedBalanceAdapter(chain, balances);
    this.#history = new Map(Object.entries(history).map(([address, txs]) => [address.toLowerCase(), txs]));
  }

  getBalance(address: string): Promise<Balance> {
    return this.#balances.getBalance(address);
  }

  async getRecentTransactions(address: string, limit = 25): Promise<TransactionsResult> {
    return { available: true, transactions: (this.#history.get(address.toLowerCase()) ?? []).slice(0, limit) };
  }
}
// --- END view backends: chain-history stand-in ------------------------------------------------

export interface Stack {
  /** Accounts + community-label submission routes on one server, as their own tests mount them. */
  accounts: Running;
  accountService: AccountService;
  /** The real Explorer API, every request held until released. */
  explorer: Running;
  nextExplorerRequest(path: string): Promise<HeldRequest>;
  // --- private-labels ---
  /** The real private-labels API (ADR 0004), on its own port, authenticating against `accountService`. */
  privateLabels: Running;
  // --- end private-labels ---
  // --- BEGIN view backends: Stack fields ------------------------------------------------------
  /** The label store every chain-reading API here shares (writes go to its labels.json). */
  labelStore: CompositeLabelStore;
  /** Bounties API (BountiesView), sharing `accountService`. */
  bounties: Running;
  /** The deposit verifier `BountyService` was built with — a test preprograms its answers (ADR 0020). */
  bountyDeposits: StandInDepositVerifier;
  /** The receiving wallets `GET /bounties/wallets` reports — fixed test addresses, never real ones. */
  bountyWallets: { ethereum: string; solana: string };
  /** Case-management API (CasesView), sharing `accountService`. */
  cases: Running;
  /** Risk scoring API (RiskPanel), over the stack's adapter + `labelStore`. */
  risk: Running;
  /** The path of every request the risk API has received, in order (scoring is expensive: tests check when it's asked). */
  riskRequests: string[];
  /** Tracer API (TracerView), over the stack's adapter + `labelStore`, Wormhole following wired to `wormholescan`. */
  tracer: Running;
  /** Visualizer API (GraphView), over the stack's adapter + `labelStore`. */
  visualizer: Running;
  /**
   * The Wormholescan API the Tracer's real `WormholescanResolver` calls, served locally (the real
   * one is a third party a test can't depend on). A test puts a recorded real response body under
   * an address; any other address gets `{ operations: [] }`, Wormholescan's own "nothing found".
   */
  wormholescan: Running;
  wormholescanResponses: Map<string, unknown>;
  // --- END view backends: Stack fields --------------------------------------------------------
  close(): Promise<void>;
}

/**
 * Starts the real accounts, community-labels and Explorer APIs and points the UI's
 * `VITE_*_URL`s at them. Call it before importing any component, which reads those at load.
 * The Explorer reads community labels from the same submissions file the labels API writes,
 * exactly as `@osstrace/explorer`'s bootstrap wires it.
 */
export async function startStack(adapter: ChainAdapter): Promise<Stack> {
  const dir = await mkdtemp(join(tmpdir(), "osstrace-web-test-"));
  const accountService = new AccountService(new JsonFileAccountStore(join(dir, "accounts.json")));

  // --- private-labels ---
  // The real private-labels API on the same accounts, and the same service handed to
  // community-labels as its read-only lookup for "share as Community label" (ADR 0017), exactly
  // as community-labels' own server.ts wires it.
  const privateLabelService = new PrivateLabelService(accountService, new JsonFilePrivateLabelStore(join(dir, "private-labels.json")));
  const privateLabelsHandler = createPrivateLabelsHandler(privateLabelService, { allowedOrigins: [WEB_ORIGIN] });
  const privateLabels = await listen(async (req, res) => {
    if (await privateLabelsHandler(req, res)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found", message: "not found" }));
  });
  process.env["VITE_PRIVATE_LABELS_URL"] = privateLabels.url;
  // --- end private-labels ---

  const submissionsPath = join(dir, "submissions.json");
  const submissions = new LabelSubmissionService(new JsonFileSubmissionStore(submissionsPath), accountService, {
    privateLabels: privateLabelService, // private-labels
  });
  const accountsHandler = createAccountsHandler(accountService, { allowedOrigins: [WEB_ORIGIN] });
  const labelsHandler = createLabelSubmissionsHandler(submissions, { allowedOrigins: [WEB_ORIGIN] });
  const accounts = await listen(async (req, res) => {
    if (await accountsHandler(req, res)) return;
    if (await labelsHandler(req, res)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found", message: "not found" }));
  });

  const labelStore = new CompositeLabelStore(
    [new JsonFileLabelStore(join(dir, "labels.json"))],
    [new CommunityLabelReader(new JsonFileSubmissionStore(submissionsPath))],
  );
  const explorerHandler = createExplorerHandler({
    registry: new Map([[adapter.chain, adapter]]),
    store: labelStore,
    cache: new InMemoryCache(),
  });
  const gate = held(explorerHandler);
  const explorer = await listen(gate.handler);

  process.env["VITE_EXPLORER_URL"] = explorer.url;
  process.env["VITE_ACCOUNTS_URL"] = accounts.url;
  process.env["VITE_COMMUNITY_LABELS_URL"] = accounts.url;
  // Not exercised by these tests; pointed at a real server that answers 404 rather than at a
  // port on this machine that might happen to be running something.
  process.env["VITE_RISK_SCORING_URL"] = accounts.url;

  // --- BEGIN view backends: servers -----------------------------------------------------------
  // Each is wired the way its own src/server.ts wires it, over this stack's temp dir, accounts
  // service, chain adapter and label store. Set after the placeholders above, so these win.

  // Bounties (packages/features/bounties/src/server.ts).
  const bountyDeposits = new StandInDepositVerifier();
  // Fixed test addresses -- never anything that could be mistaken for a real receiving wallet.
  const bountyWallets = { ethereum: "0xTestWalletEthereum00000000000000000001", solana: "TestWalletSolana1111111111111111111111111" };
  const bountyService = new BountyService(new JsonFileBountyStore(join(dir, "bounties.json")), accountService, { deposits: bountyDeposits });
  const bountiesHandler = createBountiesHandler(bountyService, { allowedOrigins: [WEB_ORIGIN], wallets: bountyWallets });
  const bounties = await listen(async (req, res) => {
    if (await bountiesHandler(req, res)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found", message: "not found" }));
  });
  process.env["VITE_BOUNTIES_URL"] = bounties.url;

  // Case management (packages/features/case-management/src/server.ts).
  const caseService = new CaseService(accountService, new JsonFileCaseStore(join(dir, "cases.json")));
  const casesHandler = createCasesHandler(caseService, { allowedOrigins: [WEB_ORIGIN] });
  const cases = await listen(async (req, res) => {
    if (await casesHandler(req, res)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found", message: "not found" }));
  });
  process.env["VITE_CASES_URL"] = cases.url;

  // Risk scoring (packages/features/risk-scoring/src/server.ts).
  const chainRegistry = new Map([[adapter.chain, adapter]]);
  const riskHandler = createRiskScoringHandler({ registry: chainRegistry, store: labelStore });
  const riskRequests: string[] = [];
  const risk = await listen((req, res) => {
    riskRequests.push(req.url ?? "/");
    return riskHandler(req, res);
  });
  process.env["VITE_RISK_SCORING_URL"] = risk.url;

  // Tracer (packages/features/tracer/src/server.ts), its real WormholescanResolver pointed at a
  // local stand-in for api.wormholescan.io that serves whatever the test recorded.
  const wormholescanResponses = new Map<string, unknown>();
  const wormholescan = await listen((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/v1/operations") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const body = wormholescanResponses.get(url.searchParams.get("address") ?? "") ?? { operations: [] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const tracer = await listen(
    createTracerHandler({
      registry: chainRegistry,
      store: labelStore,
      wormhole: { resolver: new WormholescanResolver({ baseUrl: wormholescan.url }), adapters: chainRegistry },
    }),
  );
  process.env["VITE_TRACER_URL"] = tracer.url;

  // Visualizer (packages/features/visualizer/src/server.ts).
  const visualizer = await listen(createVisualizerHandler({ registry: chainRegistry, store: labelStore }));
  process.env["VITE_VISUALIZER_URL"] = visualizer.url;
  // --- END view backends: servers -------------------------------------------------------------

  return {
    accounts,
    accountService,
    explorer,
    nextExplorerRequest: gate.next,
    privateLabels, // private-labels
    // --- BEGIN view backends: Stack values --------------------------------------------------
    labelStore,
    bounties,
    bountyDeposits,
    bountyWallets,
    cases,
    risk,
    riskRequests,
    tracer,
    visualizer,
    wormholescan,
    wormholescanResponses,
    // --- END view backends: Stack values ----------------------------------------------------
    async close() {
      await privateLabels.close(); // private-labels
      // --- BEGIN view backends: close -------------------------------------------------------
      for (const server of [visualizer, tracer, wormholescan, risk, cases, bounties]) await server.close();
      // --- END view backends: close ---------------------------------------------------------
      await explorer.close();
      await accounts.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// --- live stream ------------------------------------------------------------------------------
// A second, streaming Explorer, separate from `startStack()`'s held one: the real HTTP API with
// the real `/stream` websocket attached (ADR 0013 §6: session auth against the stack's real
// accounts, an Origin allowlist, the per-IP cap), plus a real Indexer on the same cache and event
// bus, wired the way `@osstrace/explorer`'s server.ts wires its embedded indexer. The indexer's
// timer is the one thing not used: a test runs each cycle on demand with `indexer.runCycle()`,
// as the Explorer's own stream tests do.

export interface LiveExplorer extends Running {
  indexer: Indexer;
  hub: StreamHub;
  /** How many websocket upgrade requests have reached this server (to prove one was, or wasn't, opened). */
  upgrades(): number;
}

export async function startLiveExplorer(accountService: AccountService, adapter: ChainAdapter): Promise<LiveExplorer> {
  const dir = await mkdtemp(join(tmpdir(), "osstrace-web-live-"));
  const registry = new Map([[adapter.chain, adapter]]);
  const store = new JsonFileLabelStore(join(dir, "labels.json"));
  const cache = new InMemoryCache();
  const bus = new InMemoryEventBus();
  const handle = createExplorerHandler({ registry, store, cache, allowedOrigins: [WEB_ORIGIN] });
  const server: Server = createServer((req, res) => void handle(req, res));
  let upgrades = 0;
  server.on("upgrade", () => upgrades++);
  const hub = await StreamHub.create(bus, { accounts: accountService });
  const stream = attachStream(server, hub, { allowedOrigins: [WEB_ORIGIN] });
  const indexer = new Indexer({ registry, store, cache, bus, intervalMs: 30_000, topN: 20 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    indexer,
    hub,
    upgrades: () => upgrades,
    async close() {
      await stream.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
// --- end live stream --------------------------------------------------------------------------
