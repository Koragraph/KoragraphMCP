-- Episodes: one user prompt and everything that happened before the turn ended.
--
-- `events` already holds the second half. What it cannot hold is the FIRST half — the prompt —
-- because no hook that fires on a prompt writes to it. Without the prompt there is no label, and
-- without a label the 3,000 captured events are unsupervised: we know which files an agent touched
-- and never which question it was answering. That join is the whole point of this table.
--
-- Two halves are recorded per episode, and the second one is the differentiated half:
--   positive — the files that were EDITED for this kind of task
--   negative — the files that were opened, sometimes repeatedly, and never touched
-- The negative half cannot be reconstructed later from anything: an unedited read leaves no trace
-- in git, in the graph, or in the diff. It is captured now even though nothing consumes it yet.

CREATE TABLE episodes (
  id             INTEGER PRIMARY KEY,
  session_id     TEXT NOT NULL,
  agent_id       TEXT,
  repo_id        TEXT,
  -- Redacted and bounded at write (episodes.js). Prompt text is more sensitive than command
  -- output even locally, and this store is durable and never auto-deleted.
  prompt         TEXT NOT NULL,
  prompt_chars   INTEGER NOT NULL,
  opened_at      TEXT NOT NULL,
  closed_at      TEXT,
  -- The attribution window is an id range over `events`, not a timestamp range. Timestamps are
  -- assigned by the hook process at its own clock and several hook processes run concurrently;
  -- ids are assigned by one writer, so `first < id <= last` cannot straddle a boundary.
  first_event_id INTEGER NOT NULL,
  last_event_id  INTEGER,
  n_edits        INTEGER NOT NULL DEFAULT 0,
  n_reads        INTEGER NOT NULL DEFAULT 0,
  n_cmd_pass     INTEGER NOT NULL DEFAULT 0,
  n_cmd_fail     INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL,
  outcome        TEXT,
  CHECK (source IN ('hook','transcript')),
  CHECK (outcome IS NULL OR outcome IN ('edited','read_only','empty'))
);
CREATE INDEX idx_episodes_open ON episodes (session_id, agent_id) WHERE closed_at IS NULL;
CREATE INDEX idx_episodes_time ON episodes (opened_at, id);
CREATE UNIQUE INDEX idx_episodes_dedupe ON episodes (session_id, source, opened_at, first_event_id);

CREATE TABLE episode_files (
  episode_id  INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  repo_id     TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  role        TEXT NOT NULL,
  reads       INTEGER NOT NULL DEFAULT 0,
  edits       INTEGER NOT NULL DEFAULT 0,
  searches    INTEGER NOT NULL DEFAULT 0,
  -- The file was named by a shell command (`cat x.js`, `sed -n 1,40p x.js`, `grep … x.js`).
  -- Measured on the live store: 1,877 of 3,054 captured commands name at least one repo-relative
  -- path, against 22 Read events in the whole store — this harness pushes file reading into Bash,
  -- so without this column the negative half is empty on real data.
  cmd_refs    INTEGER NOT NULL DEFAULT 0,
  -- 1 kept, 0 reverted within the episode (a later edit restored an earlier fingerprint — the
  -- abandoned-approach signal), NULL when no edit carried a fingerprint to compare. NULL is
  -- "we could not check", never "it did not survive": an unknown must not read as a negative.
  survived    INTEGER,
  PRIMARY KEY (episode_id, repo_id, file_path),
  CHECK (role IN ('edited','inspected'))
);
CREATE INDEX idx_episode_files_lookup ON episode_files (repo_id, file_path, role);

-- External content: `episodes` is the truth, this is derived and rebuildable with
-- INSERT INTO episodes_fts(episodes_fts) VALUES('rebuild').
CREATE VIRTUAL TABLE episodes_fts USING fts5(
  prompt,
  content='episodes',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts (rowid, prompt) VALUES (new.id, new.prompt);
END;
CREATE TRIGGER episodes_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts (episodes_fts, rowid, prompt) VALUES ('delete', old.id, old.prompt);
END;
CREATE TRIGGER episodes_au AFTER UPDATE OF prompt ON episodes BEGIN
  INSERT INTO episodes_fts (episodes_fts, rowid, prompt) VALUES ('delete', old.id, old.prompt);
  INSERT INTO episodes_fts (rowid, prompt) VALUES (new.id, new.prompt);
END;
