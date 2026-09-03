'use strict';

// error text → the symbol that actually had to change.
//
// The loop this collapses is the most expensive one an agent runs: read a stack trace, grep for a
// fragment of it, open six files, find the one. Prior art (BugLocator) locates the correct file
// from exactly this data — commit messages naming an error plus the diff that closed it.
//
// Two sources feed it: error strings quoted in fix-commit messages (available on install day) and
// captured cmd_fail signatures once a session has been harvested. Both are normalised identically
// or a lookup months later matches nothing.

// untrusted.js has zero requires of its own, so this stays hook-safe. Every string this module
// returns came from a commit message or from stderr and is rendered into an agent's context.
const { neutralise, safePath } = require('./untrusted');

const MAX_TERMS = 24;
const MAX_SIGNATURE = 240;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'was', 'were', 'not', 'but', 'are', 'has',
  'have', 'had', 'its', 'into', 'when', 'then', 'than', 'you', 'your', 'our', 'all', 'any', 'can',
  'will', 'would', 'should', 'must', 'been', 'being', 'they', 'them', 'his', 'her', 'she', 'him',
]);

// What separates an error REPORT from a sentence mentioning an error is that the error token is
// the thing immediately before the message colon. A looser test (token anywhere before any colon)
// indexes `Signed-off-by: ...` and `Fix ... (warning->error) Client: cpp` as failures. These two
// patterns are the whole gate.
//
//   NAMED  TProtocolException: Invalid data      OSError: [Errno 2] No such file
//   PLAIN  panic: runtime error: index 3         FATAL: deadlock detected
//
// NAMED is case-SENSITIVE: `STRERROR_R_CHAR_P` is a macro, `TypeError` is a class.
const NAMED_ERROR = /\b[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception)\s*(?:\([^)]*\))?\s*:\s+\S/;
// The generic words need a LABEL boundary, not merely whitespace, or prose like "My own error: I
// committed with git add -A" is indexed as a failure. Start of string, an opening quote or bracket,
// or immediately after another label's colon.
const PLAIN_ERROR = /(?:^|["'`([]|:\s)(?:error|warning|panic|fatal|fatal error|assertion failed|undefined reference|segmentation fault|traceback)\s*:\s+\S/i;

// Same shape as fail-fix.js#errorSignature, applied to a whole string rather than one line: a
// signature that keeps `/Users/me/...` or `:412:9` in it can never match the same failure seen
// on another machine, in another checkout, or after one line was added above it.
function normaliseErrorText(text) {
  return String(text || '')
    .replace(/0x[0-9a-fA-F]{4,}/g, '0x')
    .replace(/(?:\/[\w.@+-]+)+\/([\w.@+-]+)/g, '$1')
    .replace(/\b(?:at )?line\s+\d+/gi, '')
    .replace(/\bcol(?:umn)?\s+\d+/gi, '')
    .replace(/:\d+(?::\d+)?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SIGNATURE);
}

function isErrorReport(text) {
  const s = String(text).trim();
  if (s.length < 12 || s.length > 240) return false;
  if (!/\S+\s+\S+\s+\S/.test(s)) return false;   // fewer than three words is an identifier
  return NAMED_ERROR.test(s) || PLAIN_ERROR.test(s);
}

// Backticked spans and error-shaped lines only. Quoted prose was tried first and is not admitted:
// `"cannot"` and `"null"` occur in ordinary English sentences about a change, and a wrong memory
// is worse than no memory.
function extractErrorStrings(message) {
  const text = String(message || '');
  const out = new Set();

  const backticks = /`([^`\n]{6,240})`/g;
  let m;
  while ((m = backticks.exec(text)) !== null) {
    if (isErrorReport(m[1])) out.add(m[1].trim());
  }
  for (const raw of text.split('\n')) {
    // A line that is nothing but one backticked span is the same string the backtick pass already
    // took; without unwrapping it here the two spellings normalise differently and index twice.
    const line = raw.trim().replace(/^[-*>]\s+/, '').replace(/^`(.+)`\.?$/, '$1');
    if (isErrorReport(line)) out.add(line);
  }

  const seen = new Set();
  const kept = [];
  for (const s of out) {
    const sig = normaliseErrorText(s);
    if (sig.length < 8 || seen.has(sig)) continue;
    seen.add(sig);
    kept.push({ signature: sig, sample: s.slice(0, MAX_SIGNATURE) });
  }
  return kept;
}

function ftsTerms(signature) {
  const raw = String(signature || '').split(/[^A-Za-z0-9]+/);
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    const term = t.toLowerCase();
    if (term.length < 3 || STOPWORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

const INSERT_ROW = `INSERT OR IGNORE INTO error_index
  (repo_id, signature, sample, file_path, symbol_name, fact_id, source, seen_at)
  VALUES (@repo_id, @signature, @sample, @file_path, @symbol_name, @fact_id, @source, @seen_at)`;

const SOURCES = Object.freeze(['commit', 'cmd_fail']);

// One row per (signature × anchor). An unmapped source throws rather than defaulting, the same way
// resolution/tiers.js:242-248 does — a silently mislabelled row is worse than a failed insert.
function indexErrors(practiceDb, { repoId, message, anchors, factId = 0, source = 'commit', seenAt = null }) {
  if (!SOURCES.includes(source)) {
    throw new Error(`error-index: unknown source "${source}" (expected one of ${SOURCES.join(', ')})`);
  }
  const strings = extractErrorStrings(message);
  if (!strings.length || !anchors || !anchors.length) return 0;

  const insert = practiceDb.prepare(INSERT_ROW);
  const at = seenAt || new Date().toISOString();
  let written = 0;
  for (const s of strings) {
    for (const a of anchors) {
      if (!a || !a.file_path) continue;
      const r = insert.run({
        repo_id: repoId,
        signature: s.signature,
        sample: s.sample,
        file_path: a.file_path,
        symbol_name: a.symbol_name || '',
        fact_id: factId || 0,
        source,
        seen_at: at,
      });
      written += r.changes;
    }
  }
  return written;
}

// The index is a denormalised copy of a fact's coordinates, so it is a side channel around the two
// filters recall.js enforces in SQL: it outlives the fact's expiry, and it never knew the fact's
// tier. Both were reachable — a hypothesis reached the UserPromptSubmit brief as "this error has
// been hit before at <file>:<symbol>", and an ORPHANED fact kept naming a declaration that had been
// deleted. The join is the fix, and it belongs here rather than in each caller.
const VISIBLE = `(e.fact_id = 0 OR EXISTS (
   SELECT 1 FROM facts f
    WHERE f.id = e.fact_id AND f.expired_at IS NULL AND f.tier IN ('law','observation')))`;

const FTS_SQL = `
SELECT e.repo_id, e.file_path, e.symbol_name, e.fact_id, e.signature, e.sample, e.source,
       bm25(error_index_fts) AS rank
  FROM error_index_fts
  JOIN error_index e ON e.id = error_index_fts.rowid
 WHERE error_index_fts MATCH ?
   AND ${VISIBLE}
 ORDER BY rank
 LIMIT ?`;

const LIKE_SQL = `
SELECT e.repo_id, e.file_path, e.symbol_name, e.fact_id, e.signature, e.sample, e.source, 0 AS rank
  FROM error_index e
 WHERE e.signature LIKE ?
   AND ${VISIBLE}
 LIMIT ?`;

// A symbol-grain hit is what the caller asked for; a file-grain hit is a weaker answer to the same
// question and must not outrank it. `cmd_fail` outranks `commit` because it is an error this
// machine actually saw, not one an author quoted.
function scoreOf(row, rank, occurrences) {
  const base = 1 / (1 + Math.max(0, -rank));
  const grain = row.symbol_name ? 1 : 0.6;
  const origin = row.source === 'cmd_fail' ? 1.15 : 1;
  return Math.min(1, base * grain * origin * (1 + Math.log2(occurrences)));
}

function lookupError(practiceDb, errorText, { repoId = null, limit = 10 } = {}) {
  const signature = normaliseErrorText(errorText);
  const terms = ftsTerms(signature);
  if (!terms.length) return [];

  const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  // Over-fetch: rows are collapsed to one per (file, symbol) below, so the FTS limit is not the
  // answer limit.
  const span = Math.max(50, limit * 20);
  let rows;
  try {
    rows = practiceDb.prepare(FTS_SQL).all(match, span);
  } catch {
    // A store whose FTS index was never built, or a build of SQLite without FTS5. A degraded
    // answer beats a thrown one on a lookup path.
    rows = practiceDb.prepare(LIKE_SQL).all(`%${terms[0]}%`, span);
  }

  // FTS is an OR over the query's terms, so a stored signature sharing one common word with the
  // query comes back ranked. That is how "Remove Rust deprecation warning" retrieved an unrelated
  // SSL-socket message on the first run here. The floor is the difference between a lookup and a
  // guess, and a guess is worse than an empty answer.
  const wanted = new Set(terms);
  const floor = Math.min(terms.length, Math.max(2, Math.ceil(terms.length * 0.3)));

  const groups = new Map();
  for (const r of rows) {
    if (repoId && r.repo_id !== repoId) continue;
    if (ftsTerms(r.signature).filter((t) => wanted.has(t)).length < floor) continue;
    const key = `${r.file_path}\x00${r.symbol_name || ''}`;
    let g = groups.get(key);
    if (!g) {
      g = { row: r, rank: r.rank, facts: new Set(), samples: new Set() };
      groups.set(key, g);
    }
    if (r.rank < g.rank) { g.rank = r.rank; g.row = r; }
    if (r.fact_id) g.facts.add(r.fact_id);
    g.samples.add(r.sample || r.signature);
  }

  const out = [];
  for (const g of groups.values()) {
    const occurrences = Math.max(1, g.facts.size);
    out.push({
      symbol_name: g.row.symbol_name ? neutralise(g.row.symbol_name, 120) : null,
      file_path: safePath(g.row.file_path),
      score: Number(scoreOf(g.row, g.rank, occurrences).toFixed(4)),
      fact_id: [...g.facts][0] || null,
      occurrences,
      matched: neutralise([...g.samples][0] || '', MAX_SIGNATURE) || null,
    });
  }
  out.sort((a, b) => b.score - a.score || a.file_path.localeCompare(b.file_path));
  return out.slice(0, limit);
}

// The cmd_fail half of the index, built from facts that already carry a captured failure. Reads
// only the practice store, so it runs whether or not a session has been harvested yet.
function indexFromFacts(practiceDb, { repoId = null, source = 'cmd_fail' } = {}) {
  // A hypothesis is never surfaced, so it is never indexed either. The
  // lookup enforces this again at read time, because a fact indexed while it was an observation
  // can be demoted afterwards.
  const facts = practiceDb.prepare(
    "SELECT id, evidence FROM facts WHERE expired_at IS NULL AND tier IN ('law','observation')"
    + " AND evidence LIKE '%err_excerpt%'",
  ).all();
  const anchorsOf = practiceDb.prepare(
    'SELECT repo_id, file_path, symbol_name FROM anchors WHERE fact_id = ?',
  );
  let written = 0;
  for (const f of facts) {
    let ev;
    try { ev = JSON.parse(f.evidence); } catch { continue; }
    if (!ev || !ev.err_excerpt) continue;
    const anchors = anchorsOf.all(f.id).filter((a) => !repoId || a.repo_id === repoId);
    if (!anchors.length) continue;
    written += indexErrors(practiceDb, {
      repoId: repoId || anchors[0].repo_id,
      message: ev.err_excerpt,
      anchors,
      factId: f.id,
      source,
      seenAt: ev.failed_at || null,
    });
  }
  return written;
}

module.exports = {
  lookupError, indexErrors, indexFromFacts, extractErrorStrings, normaliseErrorText, ftsTerms,
  isErrorReport, NAMED_ERROR, PLAIN_ERROR, MAX_SIGNATURE,
};
