-- The read plane, plus the bookkeeping harvesting needs.
--
-- Measured on 2,448 live events: the recorder watched Edit|Write|Bash only, so every Read/Grep/Glob
-- was invisible. 87.5% of file inspections are of a file that was already inspected in the same
-- corpus (215 distinct files, 1,717 inspections, ast-extractor.js read 228 times), and the signal
-- nobody in the category has is which files were opened and then never edited. That cannot be
-- reconstructed later, so it is captured now even though its consumer ships later.

-- `event_type` is a CHECK constraint and SQLite cannot ALTER one, so the table is rebuilt. The
-- copy is exhaustive by column name rather than by `SELECT *` so a future column added above this
-- migration cannot silently reorder into the wrong slot.
CREATE TABLE events_new (
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
  search_pattern TEXT,
  harvested_at TEXT,
  CHECK (event_type IN ('edit','cmd_pass','cmd_fail','cmd_denied','read','search'))
);

INSERT INTO events_new
  (id, session_id, agent_id, ts, event_type, tool_name, tool_use_id, repo_id, file_path,
   hunk_index, old_start, old_lines, new_start, new_lines, old_fingerprint, new_fingerprint,
   cmd, err_excerpt, payload)
SELECT
   id, session_id, agent_id, ts, event_type, tool_name, tool_use_id, repo_id, file_path,
   hunk_index, old_start, old_lines, new_start, new_lines, old_fingerprint, new_fingerprint,
   cmd, err_excerpt, payload
  FROM events;

DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

CREATE INDEX idx_events_session ON events (session_id, agent_id, ts, id);
CREATE INDEX idx_events_unharvested ON events (session_id, ts) WHERE harvested_at IS NULL;
-- The read plane's whole point is "which file, how often, by whom" — a scan over 2k rows per query
-- would make the consumer too slow to ship.
CREATE INDEX idx_events_file ON events (repo_id, file_path, event_type) WHERE file_path IS NOT NULL;

-- Idempotence for harvesting. `harvested_at` alone cannot provide it: a Stop hook fires every turn,
-- and a failure armed before the previous run has to stay visible for a pass that arrives after it,
-- so the recent tail is deliberately re-read. Identity is what stops a re-read becoming a duplicate.
CREATE TABLE harvested_lessons (
  lesson_key   TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  agent_id     TEXT,
  fact_id      INTEGER,
  created_at   TEXT NOT NULL
);
