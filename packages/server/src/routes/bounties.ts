import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Bounty, BountyDeposit, BountySubmission, BountyWallets, DepositChain } from "@osstrace/contract";
import { requireUser, type Ctx } from "../context.ts";
import { HttpClient, budgetMs } from "../lib/http.ts";
import { verifyBitcoinDeposit, verifyEthereumDeposit, verifySolanaDeposit, type DepositVerification } from "../chain/deposits.ts";
import { normalizeAddress } from "../auth/wallet.ts";
import { ApiErr, badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";
import { nowIso } from "../lib/time.ts";
import { depositChain, parse } from "../schemas.ts";

const createBody = z.object({ title: z.string().trim().min(1).max(200), description: z.string().trim().min(1).max(20_000), reward: z.string().trim().min(1).max(300) }).strict();
const submitBody = z.object({ prUrl: z.string().trim().min(1).max(500).regex(/^https?:\/\/\S+$/, "prUrl must be a full http(s) URL"), note: z.string().trim().max(2000).default("") }).strict();
const claimBody = z.object({ submissionId: z.string().min(1).max(64) }).strict();
const cancelBody = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();
const depositBody = z.object({ chain: depositChain, txRef: z.string().trim().min(1).max(200) }).strict();

type BountyRow = {
  id: string;
  status: "open" | "claimed" | "cancelled";
  title: string;
  description: string;
  reward: string;
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
type DepositRow = { id: string; bounty_id: string; chain: DepositChain; asset_contract: string | null; amount: string; tx_ref: string; from_address: string; to_wallet: string; memo: string | null; recorded_by: string; recorded_at: string };

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
      "INSERT INTO bounties (id, status, title, description, reward, opened_by, opened_at) VALUES (?, 'open', ?, ?, ?, ?, ?)",
      id,
      body.title,
      body.description,
      body.reward,
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
    // An Ethereum tx hash is hex and case-insensitive on-chain (0xABC... and 0xabc... are the same
    // real transaction) -- lowercase it before every lookup/insert so the real sender can't get one
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
      bitcoin: () => verifyBitcoinDeposit(http, config.esploraUrl, txRef, wallet, budget),
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
        unsupported_asset: "That transaction pays the right wallet, but not in an asset this server tracks for deposits (native SOL/ETH, USDC or USDT)",
        malformed_reference: {
          solana: "That doesn't look like a real Solana signature",
          ethereum: "That doesn't look like a real Ethereum transaction hash",
          bitcoin: "That doesn't look like a real Bitcoin transaction ID (64 hex characters)",
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
    if (body.chain !== "bitcoin") {
      if (u.chain !== body.chain || !u.walletAddress || normalizeAddress(body.chain, u.walletAddress) !== normalizeAddress(body.chain, d.fromAddress)) {
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
