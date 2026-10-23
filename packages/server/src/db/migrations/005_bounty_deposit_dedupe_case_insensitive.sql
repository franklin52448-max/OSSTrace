-- Fix: `UNIQUE (chain, tx_ref)` on bounty_deposits is case-sensitive, but an Ethereum tx hash is
-- hex and case-insensitive on-chain (0xABC... and 0xabc... are the same real transaction). The
-- real sender of one real payment could resubmit it with different letter-casing and have the
-- same deposit counted multiple times toward a bounty. App code now lowercases an Ethereum tx_ref
-- before every insert/lookup (see routes/bounties.ts) -- this migration normalizes any rows already
-- stored with mixed case and adds a case-insensitive unique index as a second line of defense (in
-- case app code is ever bypassed or changes). Solana signatures are base58, already case-sensitive
-- with one canonical form, so this only touches ethereum rows.

-- If a duplicate already exists under two different cases, keep the earliest and drop the rest --
-- same real deposit, no reason to keep more than one record of it.
DELETE FROM bounty_deposits
WHERE chain = 'ethereum'
  AND id NOT IN (
    SELECT MIN(id) FROM bounty_deposits WHERE chain = 'ethereum' GROUP BY lower(tx_ref)
  );

UPDATE bounty_deposits SET tx_ref = lower(tx_ref) WHERE chain = 'ethereum';

CREATE UNIQUE INDEX bounty_deposits_chain_tx_ref_ci ON bounty_deposits (chain, lower(tx_ref));
