-- Cold start. Live capture yields only a handful of usable code-error failures over days of heavy
-- agentic work, all singletons. Git history already holds thousands of failing-state →
-- passing-state pairs, self-labelled by their messages. This is where the seeding pass records what
-- it has already taken, so a second run is a no-op.

-- Idempotency, not provenance: the commit sha also travels inside facts.evidence so a surfaced
-- fact stays checkable with `git show` even if this table is dropped. `commit_sha` is '' for a
-- fact that is about a SET of commits rather than one (a hazard).
CREATE TABLE history_seeds (
  repo_id      TEXT NOT NULL,
  commit_sha   TEXT NOT NULL,
  rule         TEXT NOT NULL,
  anchor_key   TEXT NOT NULL,
  fact_id      INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  seeded_at    TEXT NOT NULL,
  PRIMARY KEY (repo_id, commit_sha, rule, anchor_key)
);
CREATE INDEX idx_history_seeds_fact ON history_seeds (fact_id);

-- error text → the declaration that actually had to change. `signature` is normalised the same way
-- a captured cmd_fail signature is (absolute paths to basenames, no line:col, no hex addresses) or
-- a lookup months later never matches the string that was stored.
--
-- `occurrences` is deliberately NOT a column: it is COUNT(DISTINCT fact_id) at query time, which
-- makes re-indexing idempotent for free. A counter column would inflate on every re-run.
CREATE TABLE error_index (
  id           INTEGER PRIMARY KEY,
  repo_id      TEXT NOT NULL,
  signature    TEXT NOT NULL,
  sample       TEXT,
  file_path    TEXT NOT NULL,
  symbol_name  TEXT NOT NULL DEFAULT '',
  fact_id      INTEGER NOT NULL DEFAULT 0,
  source       TEXT NOT NULL,
  seen_at      TEXT NOT NULL,
  UNIQUE (repo_id, signature, file_path, symbol_name, source, fact_id),
  CHECK (source IN ('commit','cmd_fail'))
);
CREATE INDEX idx_error_index_repo ON error_index (repo_id, file_path, symbol_name);

-- External content: the row is the truth, the index is derived. Rebuildable with
-- INSERT INTO error_index_fts(error_index_fts) VALUES('rebuild').
CREATE VIRTUAL TABLE error_index_fts USING fts5(
  signature,
  content='error_index',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER error_index_ai AFTER INSERT ON error_index BEGIN
  INSERT INTO error_index_fts (rowid, signature) VALUES (new.id, new.signature);
END;
CREATE TRIGGER error_index_ad AFTER DELETE ON error_index BEGIN
  INSERT INTO error_index_fts (error_index_fts, rowid, signature) VALUES ('delete', old.id, old.signature);
END;
CREATE TRIGGER error_index_au AFTER UPDATE OF signature ON error_index BEGIN
  INSERT INTO error_index_fts (error_index_fts, rowid, signature) VALUES ('delete', old.id, old.signature);
  INSERT INTO error_index_fts (rowid, signature) VALUES (new.id, new.signature);
END;
