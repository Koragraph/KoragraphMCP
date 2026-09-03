-- Human-authored facts, abandoned approaches, and the edges between facts.
--
-- Three things the store could not hold.
--
-- 1. `kind` admitted no value for an approach that was TRIED AND ABANDONED. fail-fix.js records the
--    edit that finally worked; the hours went into the four that did not, and those are what stop
--    the next agent repeating them. 'tombstone' is that kind.
-- 2. `expiry_reason` has admitted 'superseded' since 001 with no column naming WHAT superseded it,
--    so "this rule replaced that rule" was assertable and unrecoverable. `fact_edges` carries it,
--    along with the other relations that make this a graph rather than a list: two facts that
--    contradict each other, and several that are one root cause wearing different clothes.
-- 3. `anchors.grain` admitted only 'symbol' and 'file'. Most rules a developer states are true of
--    the whole repository ("never git add -A here") and name no file at all — and promoteLessons
--    drops a lesson that produces no anchor, so every repo-wide law was silently unstorable.
--
-- Widening a CHECK means rebuilding the table. `anchors` and `history_seeds` carry ON DELETE
-- CASCADE, and DROP TABLE runs an implicit DELETE FROM that fires them, so both children are
-- copied out and rebuilt rather than left to be silently emptied. PRAGMA foreign_keys cannot be
-- used to avoid that: migrations run inside a transaction (db.js#migrate) where the pragma is a
-- no-op, and defer_foreign_keys defers the CHECK, not the cascade action.

CREATE TABLE _mig009_facts AS SELECT * FROM facts;
CREATE TABLE _mig009_anchors AS SELECT * FROM anchors;
CREATE TABLE _mig009_seeds AS SELECT * FROM history_seeds;

DROP TABLE anchors;
DROP TABLE history_seeds;
DROP TABLE facts;

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
  recurrence        INTEGER NOT NULL DEFAULT 1,
  source            TEXT,
  expiry_note       TEXT,
  weight            REAL,
  weight_reasons    TEXT,
  CHECK (kind IN ('correction','law','ritual','revert','hazard','tombstone')),
  CHECK (tier IN ('law','observation','hypothesis')),
  CHECK (source IS NULL OR source IN ('harvest','seed','hook','user','import')),
  CHECK (expiry_reason IS NULL OR expiry_reason IN ('orphaned','drifted','superseded','user'))
);

INSERT INTO facts (id, kind, tier, body, evidence, confirmations, contradictions, valid_at,
                   invalid_at, created_at, expired_at, expiry_reason, recurrence, source,
                   expiry_note, weight, weight_reasons)
  SELECT id, kind, tier, body, evidence, confirmations, contradictions, valid_at,
         invalid_at, created_at, expired_at, expiry_reason, recurrence, source,
         expiry_note, weight, weight_reasons FROM _mig009_facts;

CREATE INDEX idx_facts_live ON facts (tier, created_at) WHERE expired_at IS NULL;
CREATE INDEX idx_facts_recurrence ON facts (recurrence DESC, created_at DESC) WHERE expired_at IS NULL;
CREATE INDEX idx_facts_weight ON facts (weight DESC, created_at DESC) WHERE expired_at IS NULL;

-- `file_path` stays NOT NULL for a repo-grain anchor and holds ''. A nullable column would land in
-- the PRIMARY KEY, where SQLite treats every NULL as distinct and the same law could be stored an
-- unbounded number of times.
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
  CHECK (grain IN ('symbol','file','repo')),
  CHECK (grain <> 'repo' OR file_path = '')
);
INSERT INTO anchors SELECT * FROM _mig009_anchors;
CREATE INDEX idx_anchor_lookup ON anchors (repo_id, file_path, symbol_name);

CREATE TABLE history_seeds (
  repo_id      TEXT NOT NULL,
  commit_sha   TEXT NOT NULL,
  rule         TEXT NOT NULL,
  anchor_key   TEXT NOT NULL,
  fact_id      INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  seeded_at    TEXT NOT NULL,
  PRIMARY KEY (repo_id, commit_sha, rule, anchor_key)
);
INSERT INTO history_seeds SELECT * FROM _mig009_seeds;
CREATE INDEX idx_history_seeds_fact ON history_seeds (fact_id);

DROP TABLE _mig009_facts;
DROP TABLE _mig009_anchors;
DROP TABLE _mig009_seeds;

-- What makes this a graph and not a table of sentences. Direction is src -> dst and reads as the
-- verb: (A, B, 'supersedes') is "A supersedes B", so B is the one that gets expired.
CREATE TABLE fact_edges (
  src_fact_id  INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  dst_fact_id  INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  edge_type    TEXT NOT NULL,
  evidence     TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (src_fact_id, dst_fact_id, edge_type),
  CHECK (edge_type IN ('supersedes','contradicts','same_cause','caused_by')),
  CHECK (src_fact_id <> dst_fact_id)
);
CREATE INDEX idx_fact_edges_dst ON fact_edges (dst_fact_id, edge_type);
