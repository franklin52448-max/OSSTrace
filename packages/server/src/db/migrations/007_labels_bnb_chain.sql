-- BNB Smart Chain is a full chain (contract's `Chain`), so a label can be on a "bnb" address: widen
-- labels.chain's CHECK from ('solana', 'ethereum'). Tables whose chain column has no CHECK (trace
-- nodes/edges, transfers, address_sync, alert targets...) need nothing.
--
-- SQLite can't ALTER a CHECK constraint, so the table is recreated, as 006 did for bounty_deposits --
-- with one difference that matters: label_tags has a foreign key INTO labels (ON DELETE CASCADE),
-- and with foreign_keys = ON (always, see Db) DROP TABLE runs an implicit DELETE that cascades. So
-- every label_tags row is copied aside first and put back after, or every tag on every label would
-- be silently wiped. (PRAGMA foreign_keys can't be switched off here instead: it's a no-op inside a
-- transaction, and Db.migrate runs each migration in one.) After the rename, label_tags' REFERENCES
-- labels(id) resolves to the new table by name, and a failure anywhere rolls the whole thing back.
CREATE TEMP TABLE label_tags_keep AS SELECT label_id, tag_id FROM label_tags;

CREATE TABLE labels_new (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain      TEXT NOT NULL CHECK (chain IN ('solana', 'ethereum', 'bnb')),
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
