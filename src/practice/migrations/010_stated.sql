-- Staging for rules the developer states in passing.
--
-- The correction channel is the highest-confidence signal this store will ever get — the developer
-- typing "no, we use vitest not jest" is explicit, unambiguous, and cost them nothing to produce.
-- It arrives on the UserPromptSubmit hook, and a hook may not open graph.db, so it cannot be
-- anchored at the moment it is heard: `author.js` reaches `resolve.js`, which the hook-path require
-- tests forbid transitively and rightly.
--
-- So the hook writes here — practice.db only, one INSERT — and an off-hook drain (author.js#
-- drainStated, run by `koragraph ingest` and the practice CLI) promotes each row through the same
-- `rememberFact` door as everything else, with the graph open, at declaration grain where the rule
-- names a declaration. This is staging, not a second write path: nothing in this table is a fact
-- until the one write door has admitted it.
--
-- `cwd` is stored because the drain runs later and elsewhere; without it the repository the rule
-- was stated in would have to be guessed from the drain's own working directory.
CREATE TABLE stated_rules (
  id              INTEGER PRIMARY KEY,
  session_id      TEXT NOT NULL,
  agent_id        TEXT,
  repo_id         TEXT,
  cwd             TEXT,
  body            TEXT NOT NULL,
  confidence      TEXT NOT NULL,
  signals         TEXT,
  captured_at     TEXT NOT NULL,
  promoted_at     TEXT,
  fact_id         INTEGER REFERENCES facts(id) ON DELETE SET NULL,
  rejected_reason TEXT,
  CHECK (confidence IN ('law','observation'))
);

-- The drain reads only what it has not seen. Partial, because a store that has been running for a
-- year is almost entirely promoted rows and scanning them on every ingest is waste.
CREATE INDEX idx_stated_pending ON stated_rules (captured_at) WHERE promoted_at IS NULL AND rejected_reason IS NULL;

-- One capture per (session, body). The same rule restated in one session is one rule; the same
-- rule restated next week is a confirmation and gets a new row, which is what supersession in
-- fact-edges.js is for.
CREATE UNIQUE INDEX idx_stated_dedupe ON stated_rules (session_id, body);
