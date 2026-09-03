-- 3.3 of the memory-layer redesign: a situational note (open_loops) can now name what it is about,
-- the same way a fact does — but it has a critically different lifecycle from a fact's anchor, so
-- it gets its own table rather than making `anchors.fact_id` nullable, which would conflate two
-- different lifecycles in one table and force every future reader of `anchors` to check which kind
-- of row it has.
--
-- A loop's anchor is used ONLY to decide when to surface it (an agent visiting that node). It must
-- NEVER trigger the drift/expiry logic 013 added for facts — a loop does not resolve because the
-- code around it changed, only because someone calls `resolve` or the one narrow mechanical
-- "path now exists" check fires. Only the RENAME-FOLLOWING half of the anchor mechanism applies
-- here (so a loop about `auth.js` still finds it after a `git mv`); body_fingerprint/body_sketch
-- exist for that alone, never for a drift comparison.
CREATE TABLE loop_anchors (
  loop_id           INTEGER NOT NULL REFERENCES open_loops(id) ON DELETE CASCADE,
  repo_id           TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  symbol_name       TEXT,
  symbol_kind       TEXT,
  body_fingerprint  TEXT,
  body_sketch       TEXT,
  grain             TEXT NOT NULL,
  renamed_from      TEXT,
  PRIMARY KEY (loop_id, repo_id, file_path, symbol_name),
  CHECK (grain IN ('symbol','file'))
);
CREATE INDEX idx_loop_anchor_lookup ON loop_anchors (repo_id, file_path, symbol_name);
