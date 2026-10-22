-- Bounties, ported from the old standalone @osstrace/bounties service (ADR 0009, ADR 0020) onto
-- this server/schema. This project never custodies a payout: `reward` is the poster's own
-- free-text claim, and a deposit row is only ever independently-checked evidence that a real
-- on-chain payment happened -- never a balance this project owns or moves.
--
-- Authorization note: the old service had a separate "moderator" role to resolve claims. Accounts
-- are wallet-based now with no such role, so resolving/claiming/cancelling a bounty requires being
-- its own opener (simplest rule that still matches ADR 0009's intent -- see routes/bounties.ts).
CREATE TABLE bounties (
  id                     TEXT PRIMARY KEY,
  status                 TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'cancelled')),
  title                  TEXT NOT NULL,
  description            TEXT NOT NULL,
  reward                 TEXT NOT NULL,            -- free text, e.g. "100,000 tokens" -- never parsed as currency
  opened_by              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opened_at              TEXT NOT NULL,
  claimed_submission_id  TEXT,
  claimed_by             TEXT REFERENCES users(id) ON DELETE SET NULL,
  claimed_at             TEXT,
  resolved_by            TEXT REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at           TEXT,
  cancelled_by           TEXT REFERENCES users(id) ON DELETE SET NULL,
  cancellation_reason    TEXT
);
CREATE INDEX bounties_status ON bounties (status, opened_at);

CREATE TABLE bounty_submissions (
  id           TEXT PRIMARY KEY,
  bounty_id    TEXT NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  submitted_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pr_url       TEXT NOT NULL,              -- never fetched server-side (SSRF risk) -- a human checks it
  note         TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('pending', 'accepted', 'rejected'))
);
CREATE INDEX bounty_submissions_bounty ON bounty_submissions (bounty_id, submitted_at);

-- A real, independently-checked on-chain deposit toward a bounty's reward. `asset_contract` NULL
-- means the chain's own native currency (SOL/ETH); otherwise it's the token's real mint/contract.
CREATE TABLE bounty_deposits (
  id             TEXT PRIMARY KEY,
  bounty_id      TEXT NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  chain          TEXT NOT NULL CHECK (chain IN ('ethereum', 'solana')),
  asset_contract TEXT,
  amount         TEXT NOT NULL,            -- decimal string at the asset's real on-chain decimals
  tx_ref         TEXT NOT NULL,            -- the real signature (Solana) or tx hash (Ethereum)
  from_address   TEXT NOT NULL,
  to_wallet      TEXT NOT NULL,
  memo           TEXT,
  recorded_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recorded_at    TEXT NOT NULL,
  UNIQUE (chain, tx_ref)                   -- a given on-chain payment can only ever be recorded once
);
CREATE INDEX bounty_deposits_bounty ON bounty_deposits (bounty_id);
