-- OSSTrace server schema v1. Postgres-portable: TEXT/INTEGER/BIGINT/REAL columns, ISO-8601 UTC text timestamps
-- (fixed 6 fractional digits so string order == time order), explicit FKs with ON DELETE, no AUTOINCREMENT,
-- no SQLite-only functions in DDL. Booleans are INTEGER 0/1.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,          -- stored lowercased
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,           -- sha256(token) hex; the raw token is never stored
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  user_agent   TEXT
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE user_prefs (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE notification_methods (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('webhook', 'in_app')),
  name        TEXT NOT NULL,
  url         TEXT,
  secret      TEXT,                            -- HMAC key for webhooks; never returned by the API
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  last_status TEXT
);
CREATE INDEX notification_methods_user ON notification_methods (user_id);

CREATE TABLE traces (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  shareable  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version    BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX traces_user_updated ON traces (user_id, updated_at);

CREATE TABLE trace_nodes (
  trace_id   TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  ord        INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('address', 'entity', 'transaction')),
  chain      TEXT,
  address    TEXT,
  entity_id  TEXT,
  tx_hash    TEXT,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  pos_ts     TEXT,                             -- last-writer-wins guard for update_node_position
  width      REAL,
  height     REAL,
  color      TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (trace_id, id)
);

CREATE TABLE trace_edges (
  trace_id      TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  ord           INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('aggregate', 'transfer')),
  from_node     TEXT NOT NULL,
  to_node       TEXT NOT NULL,
  chain         TEXT,
  transfer_id   TEXT,
  agg_usd_in    REAL,
  agg_cnt_in    BIGINT,
  agg_usd_out   REAL,
  agg_cnt_out   BIGINT,
  agg_cached_at TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (trace_id, id),
  FOREIGN KEY (trace_id, from_node) REFERENCES trace_nodes (trace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (trace_id, to_node) REFERENCES trace_nodes (trace_id, id) ON DELETE CASCADE
);

CREATE TABLE views (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT '',
  shareable     INTEGER NOT NULL DEFAULT 0,
  state_json    TEXT NOT NULL,
  field_ts_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  version       BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX views_user_updated ON views (user_id, updated_at);

CREATE TABLE entities (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL,                    -- lowercased name, unique per user
  type       TEXT,
  note       TEXT,
  website    TEXT,
  twitter    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, name_key)
);

CREATE TABLE labels (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain      TEXT NOT NULL CHECK (chain IN ('solana', 'ethereum')),
  address    TEXT NOT NULL,                    -- canonical form (EIP-55 / base58 as-is)
  name       TEXT NOT NULL,
  note       TEXT,
  entity_id  TEXT REFERENCES entities(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, chain, address)
);
CREATE INDEX labels_entity ON labels (entity_id);
CREATE INDEX labels_user_created ON labels (user_id, created_at, id);

CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL,
  color      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, name_key)
);

CREATE TABLE label_tags (
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (label_id, tag_id)
);
CREATE INDEX label_tags_tag ON label_tags (tag_id);

CREATE TABLE entity_tags (
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  tag_id    TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (entity_id, tag_id)
);
CREATE INDEX entity_tags_tag ON entity_tags (tag_id);

CREATE TABLE alerts (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  direction         TEXT NOT NULL CHECK (direction IN ('in', 'out', 'both')),
  min_usd           REAL,
  tokens_json       TEXT,                      -- JSON array of tokenIds, NULL = any
  method_ids_json   TEXT NOT NULL DEFAULT '[]',
  armed_at          TEXT NOT NULL,             -- creation / last enable time: only later transfers fire
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  last_triggered_at TEXT
);
CREATE INDEX alerts_user ON alerts (user_id, created_at);

CREATE TABLE alert_targets (
  alert_id  TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  ord       INTEGER NOT NULL,
  type      TEXT NOT NULL CHECK (type IN ('address', 'entity')),
  chain     TEXT,
  address   TEXT,
  entity_id TEXT REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (alert_id, ord)
);

CREATE TABLE alert_events (
  id                  TEXT PRIMARY KEY,
  alert_id            TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transfer_chain      TEXT NOT NULL,
  transfer_id         TEXT NOT NULL,
  transfer_json       TEXT NOT NULL,           -- normalized transfer snapshot (labels re-joined on read)
  matched_target_json TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  UNIQUE (alert_id, transfer_chain, transfer_id)   -- each (rule, transfer) fires once
);
CREATE INDEX alert_events_alert ON alert_events (alert_id, created_at, id);

CREATE TABLE alert_deliveries (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES alert_events(id) ON DELETE CASCADE,
  method_id  TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX alert_deliveries_event ON alert_deliveries (event_id);

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id   TEXT NOT NULL REFERENCES alert_events(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  read_at    TEXT
);
CREATE INDEX notifications_user ON notifications (user_id, created_at, id);

-- Chain data cache. Only real provider data lands here.
CREATE TABLE transfers (
  chain            TEXT NOT NULL,
  id               TEXT NOT NULL,
  seq              BIGINT NOT NULL,            -- local ingest order, tie-breaker for keyset paging
  block_number     BIGINT NOT NULL,
  block_time       BIGINT NOT NULL,            -- epoch seconds
  tx_hash          TEXT NOT NULL,
  from_addr        TEXT NOT NULL,
  to_addr          TEXT NOT NULL,
  from_owner       TEXT,                       -- Solana token-account owner wallet
  to_owner         TEXT,
  token_id         TEXT NOT NULL,              -- 'native', mint or contract
  token_symbol     TEXT,
  token_name       TEXT,
  token_decimals   INTEGER,
  token_standard   TEXT,                       -- native | erc20 | erc721 | erc1155 | spl
  amount_raw       TEXT NOT NULL,
  amount           TEXT NOT NULL,
  amount_num       REAL NOT NULL,              -- for value filters/sorting only
  usd              REAL,                       -- NULL when no price source had one
  price_source     TEXT,
  price_checked_at TEXT,
  PRIMARY KEY (chain, id)
);
CREATE UNIQUE INDEX transfers_seq ON transfers (seq);
CREATE INDEX transfers_from ON transfers (chain, from_addr, block_time, seq);
CREATE INDEX transfers_to ON transfers (chain, to_addr, block_time, seq);
CREATE INDEX transfers_from_owner ON transfers (chain, from_owner, block_time, seq);
CREATE INDEX transfers_to_owner ON transfers (chain, to_owner, block_time, seq);
CREATE INDEX transfers_pair ON transfers (chain, from_addr, to_addr, block_time);
CREATE INDEX transfers_unpriced ON transfers (price_checked_at);

CREATE TABLE address_sync (
  chain        TEXT NOT NULL,
  address      TEXT NOT NULL,
  streams_json TEXT NOT NULL,                  -- per-stream cursors / coverage
  covered_from BIGINT,                         -- epoch seconds; oldest time fully covered
  complete     INTEGER NOT NULL DEFAULT 0,     -- reached the start of the address history
  head_at      TEXT,                           -- last time the newest page was fetched
  last_error   TEXT,
  warning      TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (chain, address)
);

CREATE TABLE prices (
  coin       TEXT NOT NULL,                    -- DefiLlama coin key, e.g. coingecko:ethereum
  bucket     BIGINT NOT NULL,                  -- epoch seconds (hour bucket); -1 = current
  usd        REAL,                             -- NULL = provider had no price
  symbol     TEXT,
  decimals   INTEGER,
  source     TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (coin, bucket)
);

CREATE TABLE login_attempts (
  id       TEXT PRIMARY KEY,
  ip       TEXT NOT NULL,
  username TEXT NOT NULL,
  success  INTEGER NOT NULL,
  at       TEXT NOT NULL
);
CREATE INDEX login_attempts_ip_user ON login_attempts (ip, username, at);
CREATE INDEX login_attempts_ip ON login_attempts (ip, at);
