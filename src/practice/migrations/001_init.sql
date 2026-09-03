-- The practice graph. Durable, ours, never auto-deleted.
--
-- Deliberately NOT in graph.db: graph.db is derived and disposable, and people delete it. Storing
-- the irreplaceable inside the disposable is backwards.

CREATE TABLE facts (
  id                INTEGER PRIMARY KEY,
  kind              TEXT NOT NULL,
  tier              TEXT NOT NULL,
  body              TEXT NOT NULL,
  evidence          TEXT NOT NULL,
  confirmations     INTEGER NOT NULL DEFAULT 0,
  contradictions    INTEGER NOT NULL DEFAULT 0,
  valid_at          TEXT,
  invalid_at        TEXT,
  created_at        TEXT NOT NULL,
  expired_at        TEXT,
  expiry_reason     TEXT,
  CHECK (kind IN ('correction','law','ritual','revert','hazard')),
  CHECK (tier IN ('law','observation','hypothesis')),
  CHECK (expiry_reason IS NULL OR expiry_reason IN ('orphaned','drifted','superseded','user'))
);
CREATE INDEX idx_facts_live ON facts (tier, created_at) WHERE expired_at IS NULL;

-- `body_fingerprint` is an exact hash of the resolved symbol's normalised body at capture time and
-- answers "has this drifted". It cannot answer "was this renamed": a rename changes the declaration
-- line, which is inside the hashed body, so the hash always misses. `body_sketch` carries a
-- similarity signature for exactly that case (see fingerprint.js).
CREATE TABLE anchors (
  fact_id           INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  repo_id           TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  symbol_name       TEXT,
  symbol_owner      TEXT,
  symbol_kind       TEXT,
  body_fingerprint  TEXT,
  body_sketch       TEXT,
  hunk_fingerprint  TEXT,
  grain             TEXT NOT NULL,
  renamed_from      TEXT,
  PRIMARY KEY (fact_id, repo_id, file_path, symbol_name),
  CHECK (grain IN ('symbol','file'))
);
CREATE INDEX idx_anchor_lookup ON anchors (repo_id, file_path, symbol_name);

-- Raw capture, promoted asynchronously; kept for replay after a rule change.
--
-- One row per PATCH HUNK, not per tool call: a single Edit with replace_all produces several, and
-- collapsing them would lose every range but one. `tool_use_id` + `hunk_index` reassemble the call.
CREATE TABLE events (
  id           INTEGER PRIMARY KEY,
  session_id   TEXT NOT NULL,
  agent_id     TEXT,
  ts           TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  tool_name    TEXT,
  tool_use_id  TEXT,
  repo_id      TEXT,
  file_path    TEXT,
  hunk_index   INTEGER,
  old_start    INTEGER, old_lines INTEGER,
  new_start    INTEGER, new_lines INTEGER,
  old_fingerprint TEXT,
  new_fingerprint TEXT,
  cmd          TEXT,
  err_excerpt  TEXT,
  payload      TEXT,
  CHECK (event_type IN ('edit','cmd_pass','cmd_fail','cmd_denied'))
);
CREATE INDEX idx_events_session ON events (session_id, agent_id, ts, id);
