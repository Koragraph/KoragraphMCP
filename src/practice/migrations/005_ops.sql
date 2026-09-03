-- Operations: what the second layer knows about its own upkeep.

-- Recurrence is the strongest precision signal the layer has: a hazard seen in four commits is a
-- different claim from one seen once, and the reader has to be told which. Stored as a column
-- rather than read out of `evidence` because `list` orders by it.
ALTER TABLE facts ADD COLUMN recurrence INTEGER NOT NULL DEFAULT 1;

-- Which pass produced this. Answers "the digest went strange after I ran seed" without a git
-- archaeology session. CHECK, not a convention, because an unmapped value must throw.
ALTER TABLE facts ADD COLUMN source TEXT
  CHECK (source IS NULL OR source IN ('harvest','seed','hook','user','import'));

-- `expiry_reason` says which rule fired; this says what the user typed when they killed it. A
-- rejected fact is itself a signal about our precision, and the reason is the signal.
ALTER TABLE facts ADD COLUMN expiry_note TEXT;

CREATE INDEX idx_facts_recurrence ON facts (recurrence DESC, created_at DESC) WHERE expired_at IS NULL;

-- When each maintenance pass last ran and how far it got. `event_watermark` is the highest event id
-- the pass considered, which is what makes "captured but never harvested" answerable without
-- depending on any single harvester having stamped harvested_at.
CREATE TABLE ops_runs (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL,
  ran_at          TEXT NOT NULL,
  event_watermark INTEGER,
  summary         TEXT,
  CHECK (kind IN ('harvest','seed','revalidate'))
);
CREATE INDEX idx_ops_runs_kind ON ops_runs (kind, ran_at DESC);
