-- What a lesson cost to learn. A typo fixed on the first try and a bug that burned an afternoon
-- produced identically-ranked facts until this column existed; nothing in the store knew one was
-- expensive.
--
-- NULL means "never measured", NOT "cheap". A git-history seed has no session, no turns and no
-- abandoned attempt, so there is nothing to weigh — and suppressing on absence of evidence is the
-- same mistake as expiring an anchor we could not check. Readers COALESCE a NULL to the
-- surfacing threshold, so an unmeasured fact passes and a measured cheap one does not.
ALTER TABLE facts ADD COLUMN weight REAL;

-- Why it scored what it scored, as JSON [{signal, detail, points}]. A bare number a user cannot
-- interrogate is not auditable, and every other surface in this layer carries its provenance.
ALTER TABLE facts ADD COLUMN weight_reasons TEXT;

CREATE INDEX idx_facts_weight ON facts (weight DESC, created_at DESC) WHERE expired_at IS NULL;
