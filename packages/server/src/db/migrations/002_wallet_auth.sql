-- Wallet-based auth replaces username+password entirely. A user IS a (chain, wallet_address)
-- pair; display_name is the only thing they can change about their identity afterward (via
-- PATCH /api/settings). `username` survives as an internal unique handle (never shown, never
-- chosen by the user) because other tables and the existing UNIQUE constraint already key off it.
ALTER TABLE users ADD COLUMN chain TEXT;
ALTER TABLE users ADD COLUMN wallet_address TEXT;
ALTER TABLE users DROP COLUMN password_hash;

CREATE UNIQUE INDEX users_chain_wallet_address_idx ON users (chain, wallet_address);
