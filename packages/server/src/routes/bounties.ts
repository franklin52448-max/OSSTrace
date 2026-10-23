import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Bounty, BountyDeposit, BountySubmission, BountyWallets, DepositChain } from "@osstrace/contract";
import { BOUNTY_DIFFICULTIES, BOUNTY_TAGS, type BountyDifficulty, type BountyTag } from "@osstrace/contract";
import { requireUser, type Ctx } from "../context.ts";
import { HttpClient, budgetMs } from "../lib/http.ts";
import { verifyBaseDeposit, verifyBitcoinDeposit, verifyBnbDeposit, verifyEthereumDeposit, verifyPinnedEvmDeposit, verifyRobinhoodDeposit, verifySolanaDeposit, type DepositVerification } from "../chain/deposits.ts";
import { normalizeAddress, type WalletChain } from "../auth/wallet.ts";
import { ApiErr, badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";
import { nowIso } from "../lib/time.ts";
import { depositChain, parse } from "../schemas.ts";

const createBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(20_000),
    reward: z.string().trim().min(1).max(300),
    // Stored de-duplicated, in BOUNTY_TAGS order, so the same set always reads the same way.
    tags: z
      .array(z.enum(BOUNTY_TAGS))
      .min(1, "pick at least one tag")
      .max(BOUNTY_TAGS.length)
      .transform((tags) => BOUNTY_TAGS.filter((t) => tags.includes(t))),
    difficulty: z.enum(BOUNTY_DIFFICULTIES),
    deadline: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "deadline must be a date, YYYY-MM-DD")
      .refine(isCalendarDate, "deadline must be a real calendar date")
      .refine(notBeforeYesterdayUtc, "deadline can't be in the past")
      .nullable()
      .optional(),
  })
  .strict();
const submitBody = z.object({ prUrl: z.string().trim().min(1).max(500).regex(/^https?:\/\/\S+$/, "prUrl must be a full http(s) URL"), note: z.string().trim().max(2000).default("") }).strict();
const claimBody = z.object({ submissionId: z.string().min(1).max(64) }).strict();
const cancelBody = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();
const depositBody = z.object({ chain: depositChain, txRef: z.string().trim().min(1).max(200) }).strict();

/** "2026-02-30" matches the YYYY-MM-DD shape but isn't a day; Date.UTC would silently roll it to March 2. */
function isCalendarDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** A deadline is a calendar date in the opener's own timezone, which may run up to a day behind UTC
 *  -- so "today" for them can be "yesterday" in UTC. Anything earlier than that is in the past for everyone. */
function notBeforeYesterdayUtc(value: string): boolean {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return value >= yesterday;
}

type BountyRow = {
  id: string;
  status: "open" | "claimed" | "cancelled";
  title: string;
  description: string;
  reward: string;
  tags: string; // JSON array (migration 011)
  difficulty: BountyDifficulty | null; // NULL only for bounties opened before migration 011
  deadline: string | null;
  opened_by: string;
  opened_at: string;
  claimed_submission_id: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  resolved_by: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
};
type SubmissionRow = { id: string; bounty_id: string; submitted_by: string; pr_url: string; note: string; submitted_at: string; outcome: "pending" | "accepted" | "rejected" };
/**
 * The sign-in that proves ownership of a deposit's sender, per deposit chain. BNB has no login of its
 * own and doesn't need one: a BNB address *is* an Ethereum address (same secp256k1 key, same 0x
 * form), and wallet sign-in only accepts an EOA's own personal_sign signature (auth/wallet.ts), so a
 * wallet signed in as "ethereum" controls exactly the BNB account at that address. Robinhood Chain
 * is the same case: an EOA's address comes from its key alone, never the chain id, so the key that
 * signed in as 0xabc on Ethereum is the only one that can send from 0xabc on chain 4663. Base (chain
 * 8453) likewise, and Arbitrum One, OP Mainnet, Zora, Lens Chain and the Data Network too. Bitcoin has
 * no entry: it has no sender check at all (see the deposit route).
 */
const DEPOSIT_SIGNER: Record<Exclude<DepositChain, "bitcoin">, WalletChain> = {
  solana: "solana",
  ethereum: "ethereum",
  bnb: "ethereum",
  robinhood: "ethereum",
  base: "ethereum",
  arbitrum: "ethereum",
  optimism: "ethereum",
  zora: "ethereum",
  lens: "ethereum",
  story: "ethereum",
};

/** What a payment in an untracked asset is told, per chain: each chain's own default list, so a
 *  chain with no USDC/USDT never claims to track them. Bitcoin never gets this (no token standard). */
const TRACKED_ASSETS: Record<DepositChain, string> = {
  solana: "for deposits (native SOL/ETH/BNB, USDC or USDT)",
  ethereum: "for deposits (native SOL/ETH/BNB, USDC or USDT)",
  bnb: "for deposits (native SOL/ETH/BNB, USDC or USDT)",
  bitcoin: "for deposits (native SOL/ETH/BNB, USDC or USDT)",
  robinhood: "for Robinhood Chain deposits (native ETH or USDG)",
  base: "for Base deposits (native ETH or USDC)",
  arbitrum: "for Arbitrum One deposits (native ETH or USDC)",
  optimism: "for OP Mainnet deposits (native ETH or USDC)",
  zora: "for Zora deposits (native ETH)",
  lens: "for Lens Chain deposits (native GHO)",
  story: "for Data Network deposits (native DATA)",
};

type DepositRow = { id: string; bounty_id: string; chain: DepositChain; asset_contract: string | null; amount: string; tx_ref: string; from_address: string; to_wallet: string; memo: string | null; recorded_by: string; recorded_at: string };

/** Only ever written by this route (validated), but read defensively: an unknown entry is dropped, never shown as a tag. */
function parseTags(raw: string): BountyTag[] {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? BOUNTY_TAGS.filter((t) => parsed.includes(t)) : [];
}

const toSubmission = (r: SubmissionRow): BountySubmission => ({ id: r.id, bountyId: r.bounty_id, submittedBy: r.submitted_by, prUrl: r.pr_url, note: r.note, submittedAt: r.submitted_at, outcome: r.outcome });
const toDeposit = (r: DepositRow): BountyDeposit => ({
  id: r.id,
  chain: r.chain,
  asset: r.asset_contract ? { contract: r.asset_contract } : "native",
  amount: r.amount,
  txRef: r.tx_ref,
  fromAddress: r.from_address,
  toWallet: r.to_wallet,
  ...(r.memo ? { memo: r.memo } : {}),
  recordedBy: r.recorded_by,
  recordedAt: r.recorded_at,
});

export function registerBounties(app: FastifyInstance, ctx: Ctx) {
  const { db, config } = ctx;
  const http = new HttpClient("bounty-deposit", 4, ctx.fetchImpl);

  function toBounty(r: BountyRow): Bounty {
    const submissions = db.all<SubmissionRow>("SELECT * FROM bounty_submissions WHERE bounty_id = ? ORDER BY submitted_at", r.id).map(toSubmission);
    const deposits = db.all<DepositRow>("SELECT * FROM bounty_deposits WHERE bounty_id = ? ORDER BY recorded_at", r.id).map(toDeposit);
    return {
      id: r.id,
      status: r.status,
      title: r.title,
      description: r.description,
      reward: r.reward,
      tags: parseTags(r.tags),
      ...(r.difficulty ? { difficulty: r.difficulty } : {}),
      ...(r.deadline ? { deadline: r.deadline } : {}),
      openedBy: r.opened_by,
      openedAt: r.opened_at,
      ...(r.claimed_submission_id ? { claimedSubmissionId: r.claimed_submission_id } : {}),
      ...(r.claimed_by ? { claimedBy: r.claimed_by } : {}),
      ...(r.claimed_at ? { claimedAt: r.claimed_at } : {}),
      ...(r.resolved_by ? { resolvedBy: r.resolved_by } : {}),
      ...(r.cancelled_at ? { cancelledAt: r.cancelled_at } : {}),
      ...(r.cancelled_by ? { cancelledBy: r.cancelled_by } : {}),
      ...(r.cancellation_reason ? { cancellationReason: r.cancellation_reason } : {}),
      submissions,
      deposits,
    };
  }

  function getOr404(id: string): BountyRow {
    const row = db.get<BountyRow>("SELECT * FROM bounties WHERE id = ?", id);
    if (!row) throw notFound("Bounty not found");
    return row;
  }

  // The public wallets this server will check a deposit against (never a key it holds).
  app.get("/api/bounties/wallets", async (): Promise<BountyWallets> => {
    return config.depositWallets;
  });

  // Anyone can browse, signed in or not (matches the old service's intent).
  app.get("/api/bounties", async (): Promise<Bounty[]> => {
    return db.all<BountyRow>("SELECT * FROM bounties ORDER BY opened_at DESC").map(toBounty);
  });

  app.get<{ Params: { id: string } }>("/api/bounties/:id", async (req): Promise<Bounty> => {
    return toBounty(getOr404(req.params.id));
  });

  app.post("/api/bounties", async (req, reply) => {
    const u = requireUser(req);
    const body = parse(createBody, req.body);
    const id = randomUUID();
    const now = nowIso();
    db.run(
      "INSERT INTO bounties (id, status, title, description, reward, tags, difficulty, deadline, opened_by, opened_at) VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      body.title,
      body.description,
      body.reward,
      JSON.stringify(body.tags),
      body.difficulty,
      body.deadline ?? null,
      u.id,
      now,
    );
    const res: Bounty = toBounty(getOr404(id));
    return reply.status(201).send(res);
  });

  app.post<{ Params: { id: string } }>("/api/bounties/:id/submissions", async (req, reply) => {
    const u = requireUser(req);
    const body = parse(submitBody, req.body);
    const bounty = getOr404(req.params.id);
    if (bounty.status !== "open") throw new ApiErr("conflict", "This bounty is no longer open");
    const id = randomUUID();
    const now = nowIso();
    db.run("INSERT INTO bounty_submissions (id, bounty_id, submitted_by, pr_url, note, submitted_at, outcome) VALUES (?, ?, ?, ?, ?, ?, 'pending')", id, bounty.id, u.id, body.prUrl, body.note, now);
    const res: BountySubmission = toSubmission(db.get<SubmissionRow>("SELECT * FROM bounty_submissions WHERE id = ?", id)!);
    return reply.status(201).send(res);
  });

  app.post<{ Params: { id: string } }>("/api/bounties/:id/claim", async (req): Promise<Bounty> => {
    const u = requireUser(req);
    const body = parse(claimBody, req.body);
    const bounty = getOr404(req.params.id);
    if (bounty.opened_by !== u.id) throw forbidden("Only the bounty's own opener can accept a submission");
    if (bounty.status !== "open") throw new ApiErr("conflict", "This bounty is no longer open");
    const submission = db.get<SubmissionRow>("SELECT * FROM bounty_submissions WHERE id = ? AND bounty_id = ?", body.submissionId, bounty.id);
    if (!submission) throw notFound("Submission not found on this bounty");
    const now = nowIso();
    db.tx(() => {
      db.run("UPDATE bounty_submissions SET outcome = 'accepted' WHERE id = ?", submission.id);
      db.run("UPDATE bounty_submissions SET outcome = 'rejected' WHERE bounty_id = ? AND id <> ? AND outcome = 'pending'", bounty.id, submission.id);
      db.run(
        "UPDATE bounties SET status = 'claimed', claimed_submission_id = ?, claimed_by = ?, claimed_at = ?, resolved_by = ? WHERE id = ?",
        submission.id,
        submission.submitted_by,
        now,
        u.id,
        bounty.id,
      );
    });
    return toBounty(getOr404(bounty.id));
  });

  app.post<{ Params: { id: string } }>("/api/bounties/:id/cancel", async (req): Promise<Bounty> => {
    const u = requireUser(req);
    const body = parse(cancelBody, req.body);
    const bounty = getOr404(req.params.id);
    if (bounty.opened_by !== u.id) throw forbidden("Only the bounty's own opener can cancel it");
    if (bounty.status !== "open") throw new ApiErr("conflict", "This bounty is no longer open");
    db.run("UPDATE bounties SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancellation_reason = ? WHERE id = ?", nowIso(), u.id, body.reason, bounty.id);
    return toBounty(getOr404(bounty.id));
  });

  app.post<{ Params: { id: string } }>("/api/bounties/:id/deposits", async (req, reply) => {
    const u = requireUser(req);
    const body = parse(depositBody, req.body);
    const bounty = getOr404(req.params.id);
    // A deposit against a bounty that's already claimed or cancelled would show as "funding"
    // something that's no longer live -- a deposit can still be made at any point in an OPEN
    // bounty's life (ADR 0020 §5), just not after it's resolved one way or the other.
    if (bounty.status !== "open") throw conflict("This bounty is no longer open; deposits can't be recorded against it");
    const wallet = config.depositWallets[body.chain];
    if (!wallet) throw badRequest(`No ${body.chain} deposit wallet is configured on this server`);
    // An Ethereum (or BNB) tx hash is hex and case-insensitive on-chain (0xABC... and 0xabc... are the
    // same real transaction) -- lowercase it before every lookup/insert so the real sender can't get one
    // real payment counted multiple times by resubmitting it with different letter-casing. Solana
    // signatures are base58, already case-sensitive with one canonical form, so left as-is. A Bitcoin
    // txid is hex with the same case-insensitivity, so it's lowercased too (also the form Esplora
    // serves it in).
    const txRef = body.chain === "solana" ? body.txRef : body.txRef.toLowerCase();
    if (db.get("SELECT 1 FROM bounty_deposits WHERE chain = ? AND tx_ref = ?", body.chain, txRef)) throw conflict("This payment has already been recorded");

    const budget = budgetMs(8000);
    const verifiers: Record<DepositChain, () => Promise<DepositVerification>> = {
      solana: () => verifySolanaDeposit(http, config.solanaRpcUrl, txRef, wallet, config.depositAllowedTokens.solana, budget),
      ethereum: () => verifyEthereumDeposit(http, config.ethBlockscoutUrl, config.ethRpcUrl, txRef, wallet, config.depositAllowedTokens.ethereum, budget),
      bnb: () => verifyBnbDeposit(http, config.bnbRpcUrl, txRef, wallet, config.depositAllowedTokens.bnb, budget),
      robinhood: () => verifyRobinhoodDeposit(http, config.robinhoodRpcUrl, txRef, wallet, config.depositAllowedTokens.robinhood, budget),
      bitcoin: () => verifyBitcoinDeposit(http, config.esploraUrl, txRef, wallet, budget),
      base: () => verifyBaseDeposit(http, config.baseRpcUrl, txRef, wallet, config.depositAllowedTokens.base, budget),
      arbitrum: () => verifyPinnedEvmDeposit(http, "arbitrum", config.arbitrumRpcUrl, txRef, wallet, config.depositAllowedTokens.arbitrum, budget),
      optimism: () => verifyPinnedEvmDeposit(http, "optimism", config.optimismRpcUrl, txRef, wallet, config.depositAllowedTokens.optimism, budget),
      zora: () => verifyPinnedEvmDeposit(http, "zora", config.zoraRpcUrl, txRef, wallet, config.depositAllowedTokens.zora, budget),
      lens: () => verifyPinnedEvmDeposit(http, "lens", config.lensRpcUrl, txRef, wallet, config.depositAllowedTokens.lens, budget),
      story: () => verifyPinnedEvmDeposit(http, "story", config.storyRpcUrl, txRef, wallet, config.depositAllowedTokens.story, budget),
    };
    const verified = await verifiers[body.chain]();
    if (!verified.ok) {
      const messages: Record<typeof verified.reason, string> = {
        not_configured: "No deposit wallet is configured for this chain",
        not_found: "That transaction wasn't found",
        // A Bitcoin "not_confirmed" means not mined into a block yet (it may still confirm), not a
        // failed tx the way it is for ETH/SOL -- say so, so the depositor knows to retry later.
        not_confirmed:
          body.chain === "bitcoin" ? "That transaction isn't confirmed in a block yet -- try again once it has at least one confirmation" : "That transaction didn't succeed on-chain",
        wrong_wallet: "That transaction doesn't pay the configured deposit wallet",
        // Per chain (TRACKED_ASSETS): Robinhood Chain has no USDC/USDT, Zora/Lens/Data Network take native only.
        unsupported_asset: `That transaction pays the right wallet, but not in an asset this server tracks ${TRACKED_ASSETS[body.chain]}`,
        malformed_reference: {
          solana: "That doesn't look like a real Solana signature",
          ethereum: "That doesn't look like a real Ethereum transaction hash",
          bnb: "That doesn't look like a real BNB Chain transaction hash",
          robinhood: "That doesn't look like a real Robinhood Chain transaction hash",
          bitcoin: "That doesn't look like a real Bitcoin transaction ID (64 hex characters)",
          base: "That doesn't look like a real Base transaction hash",
          arbitrum: "That doesn't look like a real Arbitrum One transaction hash",
          optimism: "That doesn't look like a real OP Mainnet transaction hash",
          zora: "That doesn't look like a real Zora transaction hash",
          lens: "That doesn't look like a real Lens Chain transaction hash",
          story: "That doesn't look like a real Data Network transaction hash",
        }[body.chain],
      };
      throw badRequest(messages[verified.reason]);
    }

    const d = verified.deposit;
    // Deposit transactions are public on-chain data -- without this check, anyone signed in could
    // watch the deposit wallet and attach someone else's transaction (meant for a different bounty)
    // to one of their own choosing, first-come-first-served. The caller must be the real sender.
    //
    // Bitcoin is deliberately exempt: there's no BTC wallet-connect sign-in to prove ownership with,
    // and a BTC tx has no single recoverable "sender" (see verifyBitcoinDeposit) -- `fromAddress` is
    // display-only there. Any signed-in user (on any chain's account) can record a verified BTC
    // payment; the trade-off is that a watcher could attach someone else's BTC payment to a bounty,
    // which is the accepted cost of supporting Bitcoin at all without custody (ADR 0020).
    //
    // BNB is checked against an "ethereum" sign-in (DEPOSIT_SIGNER): same key, same address. A user
    // signed in with Solana can't record a BNB deposit, same as they can't record an Ethereum one.
    if (body.chain !== "bitcoin") {
      const signer = DEPOSIT_SIGNER[body.chain];
      if (u.chain !== signer || !u.walletAddress || normalizeAddress(signer, u.walletAddress) !== normalizeAddress(signer, d.fromAddress)) {
        throw forbidden("That transaction wasn't sent from your connected wallet");
      }
    }

    const id = randomUUID();
    const now = nowIso();
    try {
      db.run(
        "INSERT INTO bounty_deposits (id, bounty_id, chain, asset_contract, amount, tx_ref, from_address, to_wallet, memo, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        bounty.id,
        body.chain,
        d.asset === "native" ? null : d.asset.contract,
        d.amount,
        txRef,
        d.fromAddress,
        d.toWallet,
        d.memo ?? null,
        u.id,
        now,
      );
    } catch (err) {
      // Two concurrent submissions of the same payment can both pass the SELECT check above before
      // either INSERTs -- the UNIQUE index is the real backstop; surface it as the same 409, not a 500.
      if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) throw conflict("This payment has already been recorded");
      throw err;
    }
    const res: BountyDeposit = toDeposit(db.get<DepositRow>("SELECT * FROM bounty_deposits WHERE id = ?", id)!);
    return reply.status(201).send(res);
  });
}
