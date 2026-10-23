-- Robinhood Chain bounty deposits: widen bounty_deposits.chain's CHECK to include 'robinhood', on top
-- of 008's 'bnb' -- the same rebuild as 006/008 (SQLite can't ALTER a CHECK constraint): nothing
-- has a foreign key into bounty_deposits, so dropping it can't cascade anywhere; both indexes are
-- recreated (dropping the table drops them); the file runs in one transaction (see Db.migrate).
CREATE TABLE bounty_deposits_new (
  id             TEXT PRIMARY KEY,
  bounty_id      TEXT NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  chain          TEXT NOT NULL CHECK (chain IN ('ethereum', 'solana', 'bitcoin', 'bnb', 'robinhood')),
  asset_contract TEXT,
  amount         TEXT NOT NULL,            -- decimal string at the asset's real on-chain decimals
  tx_ref         TEXT NOT NULL,            -- the real signature (Solana), tx hash (EVM) or txid (Bitcoin)
  from_address   TEXT NOT NULL,            -- Bitcoin: best-effort, display-only (no sender check)
  to_wallet      TEXT NOT NULL,
  memo           TEXT,
  recorded_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recorded_at    TEXT NOT NULL,
  UNIQUE (chain, tx_ref)                   -- a given on-chain payment can only ever be recorded once
);

INSERT INTO bounty_deposits_new (id, bounty_id, chain, asset_contract, amount, tx_ref, from_address, to_wallet, memo, recorded_by, recorded_at)
SELECT id, bounty_id, chain, asset_contract, amount, tx_ref, from_address, to_wallet, memo, recorded_by, recorded_at FROM bounty_deposits;

DROP TABLE bounty_deposits;
ALTER TABLE bounty_deposits_new RENAME TO bounty_deposits;

CREATE INDEX bounty_deposits_bounty ON bounty_deposits (bounty_id);
CREATE UNIQUE INDEX bounty_deposits_chain_tx_ref_ci ON bounty_deposits (chain, lower(tx_ref));
