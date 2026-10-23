-- Robinhood Chain (EVM chain id 4663) is a full chain, so a label can be on a "robinhood" address:
-- widen labels.chain's CHECK again, on top of 007's ('solana', 'ethereum', 'bnb'). Exactly 007's
-- rebuild (SQLite can't ALTER a CHECK constraint), for exactly 007's reasons; tables whose chain
-- column has no CHECK (trace nodes/edges, transfers, address_sync, alert targets...) need nothing.
-- The whole file runs in one transaction (see Db.migrate), so a failure leaves the old table as-is.

-- labels: label_tags has a foreign key INTO labels with ON DELETE CASCADE, and foreign keys are ON
-- (Db's constructor) and can't be switched off inside a transaction -- so DROP TABLE labels would
-- cascade-delete every label's tag links. They're copied aside first and put back once the new
-- labels table (same ids) is in place under the old name, which label_tags' REFERENCES labels(id)
-- then resolves to.
CREATE TEMP TABLE label_tags_keep AS SELECT label_id, tag_id FROM label_tags;

CREATE TABLE labels_new (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain      TEXT NOT NULL CHECK (chain IN ('solana', 'ethereum', 'bnb', 'robinhood')),
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
