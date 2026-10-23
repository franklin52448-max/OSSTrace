-- Tracer agent (services/tracerAgent). Three small tables, none of them holding a secret.

-- An anonymous visitor's agent allowance: one row per browser, found by the sha256 of the random
-- token in its httpOnly `osstrace_agent` cookie (the token itself is never stored). The count lives
-- here, server-side, so clearing localStorage -- or anything else the page itself controls -- can't
-- reset it.
CREATE TABLE tracer_agent_anon_sessions (
  token_hash    TEXT PRIMARY KEY,
  created_ip    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_at       TEXT NOT NULL,
  messages_used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX tracer_agent_anon_sessions_ip_created ON tracer_agent_anon_sessions (created_ip, created_at);
CREATE INDEX tracer_agent_anon_sessions_last ON tracer_agent_anon_sessions (last_at);

-- One row per accepted chat message: the rolling-window abuse limits (per user, per ip) count these,
-- the same shape as login_attempts for the auth throttle. Pruned after two days.
CREATE TABLE tracer_agent_usage (
  id        TEXT PRIMARY KEY,
  ip        TEXT NOT NULL,
  principal TEXT NOT NULL, -- "user:<id>" or "anon:<token_hash>"
  at        TEXT NOT NULL
);
CREATE INDEX tracer_agent_usage_ip_at ON tracer_agent_usage (ip, at);
CREATE INDEX tracer_agent_usage_principal_at ON tracer_agent_usage (principal, at);

-- Short-lived conversation memory, so "now sort by value" / "remove that node" have the previous
-- turn to refer to. Keyed per (caller, trace doc); only the user's own text and the agent's own
-- reply (plus a one-line summary of the tools it ran), never tool payloads. Pruned after 24 hours.
CREATE TABLE tracer_agent_turns (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_key TEXT NOT NULL,
  role     TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content  TEXT NOT NULL,
  at       TEXT NOT NULL
);
CREATE INDEX tracer_agent_turns_conv ON tracer_agent_turns (conv_key, seq);
CREATE INDEX tracer_agent_turns_at ON tracer_agent_turns (at);
