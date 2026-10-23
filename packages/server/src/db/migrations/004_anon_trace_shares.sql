-- Anon Tracer sharing (ADR 0025): a genuinely separate system from the signed-in trace_* tables.
-- No user_id -- these aren't owned by an account, don't appear in anyone's trace list, and carry
-- no undo/redo history, just an immutable snapshot of a local-only canvas at share time.
CREATE TABLE anon_trace_shares (
  id         TEXT PRIMARY KEY,
  doc_json   TEXT NOT NULL,
  created_ip TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX anon_trace_shares_expires ON anon_trace_shares (expires_at);
CREATE INDEX anon_trace_shares_ip_created ON anon_trace_shares (created_ip, created_at);
