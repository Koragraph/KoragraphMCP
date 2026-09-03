-- Open loops (sticky notes): the one kind of knowledge this store had no home for.
--
-- "still need to sort npx packaging", "mid-migration, don't touch the old auth yet" — a note the
-- developer leaves for the next session. It is NOT a fact and deliberately not a `facts` kind: a
-- fact is a claim about code that is true until the code moves, and drift/rename/orphan is how it
-- dies. An open loop has different physics — it is true until the WORK is DONE, not until time
-- passes or the code changes, so it anchors to nothing, expires on completion, and is delivered as
-- context ("here is what was still open") rather than as an instruction to obey. Forcing it into
-- `facts` would thread `if (kind === 'open_loop') skip this` through author/promote/revalidate/
-- recall; a separate table keeps it isolated and dumb-reliable.
--
-- Death is completion, never a TTL and never a silent time-decay: a decay model kills the reminder
-- exactly when the human has forgotten the item, which is precisely when it is doing its job. So an
-- untouched loop stays open forever until something crosses it off. `resolved_at IS NULL` is open.
--
-- Resolved, never hard-deleted — the same rule facts follow. A closed loop is kept, with the reason
-- it closed (agent judged it done, a checkable condition came true, or the developer said so), so it
-- is auditable and can be re-opened as a NEW row later.
--
-- `norm` is the body reduced to its content words for dedupe: the same loop stated twice in two
-- sessions is one loop, not two lines in the next brief. The partial unique index enforces that at
-- most one OPEN loop per (repo, norm) exists, atomically, so two sessions racing to open the same
-- loop coalesce instead of double-writing. A resolved row drops out of the index, which is what lets
-- the same note be re-opened after it was closed.
CREATE TABLE open_loops (
  id              INTEGER PRIMARY KEY,
  repo_id         TEXT NOT NULL,
  body            TEXT NOT NULL,
  norm            TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'user',
  session_id      TEXT,
  mentions        INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  resolved_at     TEXT,
  resolved_reason TEXT,
  CHECK (resolved_reason IS NULL OR resolved_reason IN ('agent', 'condition', 'user'))
);

CREATE UNIQUE INDEX idx_open_loops_dedupe ON open_loops (repo_id, norm) WHERE resolved_at IS NULL;
CREATE INDEX idx_open_loops_open ON open_loops (repo_id) WHERE resolved_at IS NULL;
