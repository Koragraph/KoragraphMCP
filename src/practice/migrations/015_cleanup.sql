-- Section 5 of the memory-layer redesign: schema cleanup, done last, once nothing in the tree
-- still depends on any of it.
--
-- facts.confirmations — read in two places (recall.js, the CLI's column list) and written by
-- nothing; `recurrence` already covers "how often has this mattered" for every reader that used it.
-- facts.contradictions — the same shape of dead weight, verified independently while touching this
-- migration: selected in the same two places, read by neither, written by nothing.
-- facts.invalid_at — only `valid_at` is ever written (promote.js, for mined lessons); `invalid_at`
-- was read-side only (WHERE clauses in recall.js/context-brief.js) and never set by any writer.
-- `valid_at` is meaningful and stays.
ALTER TABLE facts DROP COLUMN confirmations;
ALTER TABLE facts DROP COLUMN contradictions;
ALTER TABLE facts DROP COLUMN invalid_at;
