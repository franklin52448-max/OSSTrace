-- ZetaChain, Mythos and the HyperEVM become real address/label chains: widen labels.chain's CHECK from
-- 017's ('solana', 'ethereum', 'bnb', 'robinhood', 'base', 'arbitrum', 'optimism', 'zora', 'lens',
-- 'story', 'gnosis', 'ronin', 'rootstock') to include 'zetachain', 'mythos' and 'hyperliquid'. Without
-- this a user labelling an address on any of them gets a raw SQLite constraint failure, even though the
-- API's own `chain` schema accepts it.
--
-- Same rebuild as 007, 009, 012, 015 and 017, for the same reasons: SQLite can't ALTER a CHECK, and
-- label_tags has an ON DELETE CASCADE foreign key INTO labels that DROP TABLE would fire (foreign_keys
-- is always ON and can't be switched off inside the transaction every migration runs in) -- so every
-- label_tags row is copied aside first and put back once the new table is in place under the same ids.
-- The CHECK below must list every chain any earlier migration allowed: a rebuild that dropped one
-- would fail on (or forbid) that chain's existing rows.
CREATE TEMP TABLE label_tags_keep AS SELECT label_id, tag_id FROM label_tags;

CREATE TABLE labels_new (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain      TEXT NOT NULL CHECK (chain IN ('solana', 'ethereum', 'bnb', 'robinhood', 'base', 'arbitrum', 'optimism', 'zora', 'lens', 'story', 'gnosis', 'ronin', 'rootstock', 'zetachain', 'mythos', 'hyperliquid')),
  address    TEXT NOT NULL,                    -- canonical form (EIP-55 / base58 as-is)
  name       TEXT NOT NULL,
  note       TEXT,
  entity_id  TEXT REFERENCES entities(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, chain, address)
);

INSERT INTO labels_new (id, user_id, chain, address, name, note, entity_id, created_at, updated_at)
SELECT id, user_id, chain, address, name, note, entity_id, created_at, updated_at FROM labels;

DROP TABLE labels;
ALTER TABLE labels_new RENAME TO labels;

CREATE INDEX labels_entity ON labels (entity_id);
CREATE INDEX labels_user_created ON labels (user_id, created_at, id);

INSERT OR IGNORE INTO label_tags (label_id, tag_id) SELECT label_id, tag_id FROM label_tags_keep;
DROP TABLE label_tags_keep;
