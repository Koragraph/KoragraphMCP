'use strict';

const { tokenise } = require('./fingerprint');

// Edges between facts. Everything else in this store points OUTWARD at code — `anchors` binds a
// fact to a coordinate, `history_seeds` to a commit — which made the layer a table of sentences
// with references, not a graph. This is the one relation that only exists between memories:
//
//   supersedes   A replaced B. B is expired with reason 'superseded'; the edge is the only record
//                of what replaced it, which 001 asserted in a CHECK and gave nowhere to store.
//
// `contradicts`, `same_cause`, and `caused_by` are omitted: nothing in the codebase writes any of
// the three (including `same_cause`, whose only capable writer, linkSameCause, has zero call
// sites anywhere, production or test). The mechanism that actually handles "these disagree" is
// `contradicted_at`/`contradicted_reason` on `facts` (011/013), not an edge type.
const EDGE_TYPES = Object.freeze(['supersedes']);

// Jaccard over the TOKEN SET, not over fingerprint.js's shingle sketch. That sketch answers "is
// this the same body of code", where three-token order carries meaning; two statements of the same
// rule reorder freely and the sketch scores them far apart even when a reader calls them identical.
// Same question, different data, so the measure changes and the tokeniser is still shared.
//
// Content words only: "the", "a", "is" appear in every rule in the store and drag every pair
// upward, which is how a threshold this blunt starts retiring unrelated laws.
const SUPERSEDE_SIMILARITY = 0.6;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'for', 'from', 'has', 'have', 'here',
  'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'we', 'when',
  'will', 'with', 'you',
]);

function contentTokens(body) {
  const out = new Set();
  for (const raw of tokenise(String(body || '').split('\n'))) {
    const t = raw.toLowerCase();
    if (!/[a-z0-9]/.test(t)) continue;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

function bodySimilarity(a, b) {
  const A = contentTokens(a);
  const B = contentTokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}

// Discourse-filler adverbs that qualify tone or scope but never change WHICH rule is stated. A rule
// ending "…here" and its restatement ending "…always" are one rule; excluding these from the
// contrast test below stops a trailing adverb from reading as a distinct subject. Polarity words
// (always/never/no) are deliberately NOT here: "always run X" vs "never run X" is a real
// contradiction, and collapsing it as a restatement would silently drop one side.
const FILLER_ADVERBS = new Set([
  'here', 'just', 'really', 'actually', 'simply', 'generally', 'usually', 'typically', 'currently',
  'also', 'please', 'basically', 'essentially', 'now', 'then', 'so', 'anyway', 'overall',
]);

// Two tokens are the same word wearing a different inflection (commit/committing, error/errors).
// Prefix match with a 4-char floor, matching relevance.js's stemmer; below 4 chars a prefix is
// too weak (e.g. "log" would match "login").
function sameStem(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && b.startsWith(a)) return true;
  if (b.length >= 4 && a.startsWith(b)) return true;
  return false;
}

// Is `b` a restatement of `a`, or a DISTINCT rule that merely shares structure? Body-token Jaccard
// cannot tell them apart — it is an anti-signal for repo-grain rules: two distinct imperatives
// differing by one salient noun ("run typecheck" vs "run lint") score HIGHER than a genuine
// reworded restatement. The discriminator is the shape of the difference, not its size: a
// restatement adds or drops filler on one side ("…here" -> "…always", "…" -> "…because untrusted"),
// while a distinct rule swaps a salient token on BOTH sides. So it is a restatement unless, after
// removing filler adverbs and collapsing inflections, each side still carries a token the other
// lacks — a two-sided contrast. This only ever makes supersession STRICTER, so it can retire a
// duplicate but can never newly drop a rule the blunt threshold used to keep.
// NEGATION words only — an added one flips meaning ("run tests" -> "never run tests"). Positive
// emphasis like "always" is NOT here: "do X" vs "always do X" is a restatement, and "always X" vs
// "never X" is already a two-sided contrast caught below. Adding "always" here would wrongly read a
// trailing "…always" as a contradiction of "…here".
const NEGATION_WORDS = new Set(['never', 'no', 'not', 'none', 'avoid', 'without', 'dont', 'disable', 'disallow', 'forbid', 'stop']);

function isRestatement(a, b) {
  const strip = (body) => [...contentTokens(body)].filter((t) => !FILLER_ADVERBS.has(t));
  const A = strip(a);
  const B = strip(b);
  const aOnly = A.filter((t) => !B.some((u) => sameStem(t, u)));
  const bOnly = B.filter((t) => !A.some((u) => sameStem(t, u)));
  // A ONE-sided difference whose only new token is a NEGATION is a contradiction, not a restatement:
  // "run tests" vs "never run tests" is a subset plus "never", so aOnly is empty and the two-sided
  // test below would wrongly call it a restatement and supersede the prior. Negation flips meaning,
  // so it must never collapse — it belongs on `contradicts`, not `supersedes`.
  const onlyNegation = (only) => only.length > 0 && only.every((t) => NEGATION_WORDS.has(t));
  if (onlyNegation(aOnly) || onlyNegation(bOnly)) return false;
  return !(aOnly.length && bOnly.length);
}

const INSERT_EDGE = `INSERT OR IGNORE INTO fact_edges
  (src_fact_id, dst_fact_id, edge_type, evidence, created_at) VALUES (?,?,?,?,?)`;

function linkFacts(db, srcId, dstId, edgeType, { evidence = null, now = new Date() } = {}) {
  if (!EDGE_TYPES.includes(edgeType)) {
    throw new Error(`practice: unknown fact edge type "${edgeType}" (expected one of ${EDGE_TYPES.join(', ')})`);
  }
  if (!srcId || !dstId || srcId === dstId) return false;
  const payload = evidence && typeof evidence === 'object' ? JSON.stringify(evidence) : evidence;
  return db.prepare(INSERT_EDGE).run(srcId, dstId, edgeType, payload, now.toISOString()).changes > 0;
}

const OUT_SQL = `
SELECT e.dst_fact_id AS fact_id, e.edge_type, e.created_at, e.evidence,
       f.body, f.kind, f.tier, f.expired_at
  FROM fact_edges e JOIN facts f ON f.id = e.dst_fact_id
 WHERE e.src_fact_id = ?`;

const IN_SQL = `
SELECT e.src_fact_id AS fact_id, e.edge_type, e.created_at, e.evidence,
       f.body, f.kind, f.tier, f.expired_at
  FROM fact_edges e JOIN facts f ON f.id = e.src_fact_id
 WHERE e.dst_fact_id = ?`;

// Both directions, because they read as different sentences: outbound is "this supersedes that",
// inbound is "this was superseded by that", and a reader auditing a fact needs the second one.
function edgesOf(db, factId, { includeExpired = true } = {}) {
  const out = db.prepare(OUT_SQL).all(factId).map((r) => ({ ...r, direction: 'out' }));
  const inb = db.prepare(IN_SQL).all(factId).map((r) => ({ ...r, direction: 'in' }));
  const all = [...out, ...inb];
  return includeExpired ? all : all.filter((r) => !r.expired_at);
}

const LIVE_ON_ANCHOR = `
SELECT DISTINCT f.id, f.body, f.kind, f.tier, f.created_at
  FROM facts f JOIN anchors a ON a.fact_id = f.id
 WHERE f.expired_at IS NULL
   AND a.repo_id = @repo_id
   AND a.file_path = @file_path
   AND ((@symbol_name IS NULL AND a.symbol_name IS NULL)
        OR a.symbol_name = @symbol_name)`;

// Two rules about the same symbol that say nearly the same thing are one rule stated twice, and
// the newer one is the one the developer meant. Similarity is required to be high AND the anchor
// identical: a lower bar across a whole file would let a new hazard silently retire an unrelated
// law that happened to share vocabulary.
function findSuperseded(db, { repoId, filePath, symbolName = null, body, excludeId = null }) {
  const rows = db.prepare(LIVE_ON_ANCHOR).all({
    repo_id: repoId, file_path: filePath, symbol_name: symbolName,
  });
  const out = [];
  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue;
    const score = bodySimilarity(body, row.body);
    // High token overlap is necessary but not sufficient: it fires on distinct rules that share
    // structure. Require the difference to be a restatement's shape, not a two-sided contrast.
    if (score >= SUPERSEDE_SIMILARITY && isRestatement(body, row.body)) {
      out.push({ ...row, similarity: score });
    }
  }
  return out.sort((a, b) => b.similarity - a.similarity);
}

const EXPIRE = `UPDATE facts SET expired_at = ?, expiry_reason = 'superseded', expiry_note = ?
                 WHERE id = ? AND expired_at IS NULL`;

// Never a hard delete: a fact that was replaced is still evidence about how fast this
// codebase's rules move, and about our own precision.
function supersede(db, newFactId, oldFactId, { now = new Date(), note = null } = {}) {
  const changed = db.prepare(EXPIRE).run(
    now.toISOString(), note || `superseded by fact ${newFactId}`, oldFactId,
  ).changes;
  if (!changed) return false;
  linkFacts(db, newFactId, oldFactId, 'supersedes', { now });
  return true;
}

module.exports = {
  linkFacts, edgesOf, findSuperseded, supersede, bodySimilarity,
  contentTokens, isRestatement,
  EDGE_TYPES, SUPERSEDE_SIMILARITY,
};
