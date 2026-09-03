-- A repo-grain fact could never stop being true.
--
-- revalidate.js returns `ok` unconditionally for a repo-grain anchor, and its comment says why:
-- the anchor's only claim is "this repository exists", and the branch resolving IS that claim.
-- That is right about the ANCHOR and wrong about the FACT. "Always use vitest here, never jest" is
-- a claim about a toolchain, and toolchains change — so the class of rule a CLAUDE.md is actually
-- made of was the one class this layer promised to expire and never did.
--
-- CONTRADICTED, not expired, and the distinction is the point. `expiry_reason` records the four
-- ways a fact stops being about live code; this records that the repository now says something
-- different from what a person did. A manifest is weaker evidence than a developer, so a
-- contradiction withholds the fact from delivery and shows up in `practice list` for the developer
-- to settle — it never silently deletes what they said.
--
-- ADD COLUMN rather than widening 001's expiry_reason CHECK: SQLite cannot alter a constraint
-- without rebuilding the table, and practice.db is the durable, irreplaceable half of this product.
ALTER TABLE facts ADD COLUMN contradicted_at TEXT;
ALTER TABLE facts ADD COLUMN contradicted_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_facts_contradicted ON facts (contradicted_at) WHERE contradicted_at IS NOT NULL;
