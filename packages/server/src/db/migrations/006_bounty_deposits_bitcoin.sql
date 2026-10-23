-- Bitcoin bounty deposits (ADR 0020 addendum): widen bounty_deposits.chain's CHECK from
-- ('ethereum', 'solana') to include 'bitcoin'. Bitcoin is deposit-only -- labels/traces/transfers
-- keep their own two-chain CHECKs untouched.
--
-- SQLite can't ALTER a CHECK constraint, so the table is recreated: build the new table with every
-- column/constraint from 003 plus the wider CHECK, copy every row across, drop the old table,
-- rename the new one into place, then recreate both indexes (003's bounty_deposits_bounty and 005's
-- case-insensitive bounty_deposits_chain_tx_ref_ci -- dropping the old table drops them with it).
-- Nothing has a foreign key INTO bounty_deposits, so dropping it can't cascade anywhere, and the
-- whole migration runs in one transaction (see Db.migrate), so a failure leaves the old table as-is.
CREATE TABLE bounty_deposits_new (
  id             TEXT PRIMARY KEY,
  bounty_id      TEXT NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  chain          TEXT NOT NULL CHECK (chain IN ('ethereum', 'solana', 'bitcoin')),
  asset_contract TEXT,
  amount         TEXT NOT NULL,            -- decimal string at the asset's real on-chain decimals
  tx_ref         TEXT NOT NULL,            -- the real signature (Solana), tx hash (Ethereum) or txid (Bitcoin)
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
