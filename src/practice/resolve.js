'use strict';

const Database = require('better-sqlite3');

const { graphDbPath } = require('./paths');
const fs = require('node:fs');
const { normaliseRemote, readOriginUrl } = require('./repo-identity');

// The only place the practice graph touches the code graph, and it touches it READ-ONLY, at use
// time, never from the hook.
//
// The coupling is deliberately at resolution and not at storage: we never store nodes.id.
// `canonical_key` embeds raw parameter text, so renaming a parameter or changing a default re-keys
// the node — a fact bound to a node id would orphan on exactly the fix that produced it.

// FILE and DIRECTORY carry a whole-file span and therefore overlap every edit in the file.
// RATIONALE and DOC_REF are commentary about the code, not the thing being edited — a comment
// block sitting on the line above a method wins on span and would silently take the anchor.
// DOC belongs here for the same reason RATIONALE and DOC_REF do, and its absence was silently
// disabling drift detection. A DOC node is a comment: it sits INSIDE the declaration it documents
// and spans a single line, so when an anchor is re-resolved by line range -- which promote.js does
// after author.js has already found the right declaration by NAME -- the "smallest span wins" rule
// hands the anchor to the comment.
//
// Without this, a fact about a METHOD can anchor instead to a DOC node on a line inside it:
// renaming the method and re-ingesting reports the fact re-resolved fine, because the comment had
// not moved, so the fact looks healthy while describing a function that no longer had that name.
//
// A comment is the WORST possible anchor for a code fact. It changes on a different schedule from
// the code it sits in -- usually never -- so a fact anchored to one can neither drift nor orphan.
const EXCLUDED_NODE_TYPES = Object.freeze(['FILE', 'DIRECTORY', 'RATIONALE', 'DOC', 'DOC_REF']);

const OWNER_NODE_TYPES = Object.freeze(['CLASS', 'ENTITY', 'INTERFACE', 'STRUCT', 'MODULE']);

// A hunk larger than this is a file rewrite, not an edit to a declaration. Resolving it would
// return most of the file's symbols and anchor a fact to all of them.
const MAX_HUNK_LINES = 2000;

// Pre-resolved. Joining `files` on f.path inside the overlap statement keeps idx_nodes_file_span
// but collapses its seek to a single column, i.e. every node in the branch scanned with a `files`
// probe per row:
//
//   pre-resolved  SEARCH n USING INDEX idx_nodes_file_span
//                   (repository_branch_id=? AND file_id=? AND start_line>? AND start_line<?)
//   joined        SEARCH n USING COVERING INDEX idx_nodes_file_span (repository_branch_id=?)
//                 SEARCH f USING INTEGER PRIMARY KEY (rowid=?)
//
// The index is still CHOSEN either way. What collapses is the seek: four columns to one. A test
// asserts the seek depth, not the index name, because the index name alone does not distinguish the two.
const FILE_SQL = 'SELECT id FROM files WHERE repository_branch_id = ? AND path = ?';

// A developer writing a rule names the file the way they say it out loud -- `cochange-miner.js`,
// not `src/services/cochange-miner.js`. The graph stores repo-relative paths, so an exact match
// misses every one of them — on a real CLAUDE.md import, roughly half the unanchored facts named a
// file that IS in the graph, under its full path.
//
// UNAMBIGUOUS only. Two files sharing a basename is common (index.js, main.go, utils.py) and
// picking one would anchor a rule to whichever row came first. Refusing there matches
// resolveDottedSuffixFile's rule on the graph side: never guess a root.
const FILE_BY_BASENAME_SQL = `SELECT id, path FROM files
                               WHERE repository_branch_id = ? AND path LIKE ?
                               LIMIT 2`;

const OVERLAP_SQL = `
SELECT n.id, n.node_type, n.name, n.start_line, n.end_line,
       (n.end_line - n.start_line) AS span
  FROM nodes n
 WHERE n.repository_branch_id = ?
   AND n.file_id = ?
   AND n.approval_status = 'APPROVED'
   AND n.start_line IS NOT NULL
   AND n.start_line <= ? AND n.end_line >= ?
 ORDER BY span ASC, n.id ASC`;

function openGraphDb(file = null) {
  // Read-only, and not through SqlitePool: that shim asserts FTS5 by CREATEing a probe table,
  // which cannot run on a read-only handle. Read-only also means this can never take a write lock
  // an ingest is waiting on.
  return new Database(file || graphDbPath(), { readonly: true, fileMustExist: true });
}

// practice `repo_id` → the graph's branch. Three ways, because the graph does not store our
// identity: on the live graph the only repository row has web_url = NULL and full_path =
// /tmp/commons-cli, so a web_url match alone would resolve nothing at all.

// One `git remote get-url origin` per checkout per process. resolveBranch runs on the read path
// and revalidation calls it once per distinct repo_id, so an uncached probe would spawn a git
// process per anchor.
const checkoutIdentity = new Map();

function identityOfCheckout(fullPath) {
  if (!fullPath || !String(fullPath).includes('/')) return null;
  if (checkoutIdentity.has(fullPath)) return checkoutIdentity.get(fullPath);
  let id = null;
  try {
    if (fs.existsSync(fullPath)) id = normaliseRemote(readOriginUrl(fullPath));
  } catch { id = null; }
  checkoutIdentity.set(fullPath, id);
  return id;
}

// `repoRoot` is tried FIRST and is the only exact signal here. The other three are all guesses
// about a name:
//
//   * byUrl never fires. `repositories.web_url` is normalizeRepoWebUrl(sourceUrl), the CLI passes
//     `file://<path>`, and that normaliser returns null for a local path by design -- it exists to
//     produce a BROWSABLE url, not an identity. Verified NULL for every repository in every store
//     on this machine, including the live one.
//   * byName and the basename fallback both compare the git remote's repo name against the
//     CHECKOUT DIRECTORY name, so they hold only when those happen to agree.
//
// When all three miss, resolveBranch returns null, author.js falls back to repo grain, and
// declaration-grain anchoring -- the thing this layer exists for -- silently does not happen.
// This is what happens when a repo's remote name and its checkout directory name disagree (clone
// expressjs/express into a directory called `app`): repoId resolves to the remote, the graph holds
// name `app`, every name match misses, and rules store at repo grain.
//
// The checkout path needs no schema change and no re-ingest: `full_path` holds the real absolute
// path and it is exactly what the caller is standing in.
function resolveBranch(graphDb, { repoId, repoName, repoRoot }) {
  // The four match strategies below (root/identity/url/name/path) do not all need repoId — byName
  // and byPath compare against repoName alone. Requiring repoId unconditionally blocked a caller
  // that only knows a repo's NAME (not its identity or a local checkout to read git config from)
  // from ever reaching a match its own logic clearly supports.
  if (!repoId && !repoName && !repoRoot) return null;
  const repos = graphDb.prepare('SELECT id, name, full_path, web_url FROM repositories').all();
  const wanted = String(repoName || '').toLowerCase();
  const root = repoRoot ? String(repoRoot).replace(/\/+$/, '') : null;

  const byRoot = root
    ? repos.find((r) => r.full_path && String(r.full_path).replace(/\/+$/, '') === root)
    : null;
  // Ask the CHECKOUT what it is, rather than trusting either name. This is the match that works
  // for callers holding only a stored repo_id -- revalidate and promote operate over durable
  // coordinates and have no repoRoot to offer -- and it compares like with like: both sides are
  // `normaliseRemote(git remote origin)`, which is exactly how repoIdentity() minted the repo_id
  // in the first place.
  // repoId is now optional (a repoName-only caller has none) — gate both comparisons on a
  // truthy repoId so an absent identity/url on one side can never coincidentally equal an
  // absent repoId on the other and produce a spurious match.
  const byIdentity = repoId ? repos.find((r) => identityOfCheckout(r.full_path) === repoId) : null;
  const byUrl = repoId ? repos.find((r) => r.web_url && normaliseRemote(r.web_url) === repoId) : null;
  const byName = repos.find((r) => String(r.name || '').toLowerCase() === wanted);
  const byPath = repos.find((r) => {
    const base = String(r.full_path || '').split('/').filter(Boolean).pop();
    return base && base.toLowerCase() === wanted;
  });

  const repo = byRoot || byIdentity || byUrl || byName || byPath;
  if (!repo) return null;

  const branches = graphDb.prepare(
    'SELECT id, branch_name, is_tracked, node_count FROM repository_branches WHERE repository_id = ?',
  ).all(repo.id);
  if (!branches.length) return null;

  // Facts are not branch-scoped — they resolve against whichever branch the graph holds.
  // Tracked first, then the branch with the most of the repository in it, then lowest id so the
  // answer is deterministic.
  branches.sort((a, b) => (b.is_tracked || 0) - (a.is_tracked || 0)
    || (b.node_count || 0) - (a.node_count || 0)
    || a.id - b.id);

  return {
    branchId: branches[0].id,
    branchName: branches[0].branch_name,
    repositoryId: repo.id,
    repoRoot: checkoutRoot(graphDb, repo),
    matchedBy: byUrl ? 'web_url' : (byName ? 'name' : 'full_path'),
  };
}

// `repositories.full_path` does NOT hold a path on the shipping ingest path: ingest.js:143 binds
// `repoName` into that column, so after `koragraph ingest /Users/me/foo` it reads "foo". Everything
// that asks the graph where a checkout is therefore gets a bare directory name, which
// fs.existsSync resolves against the CURRENT directory — so revalidation reads every anchor as
// "checkout location unknown" and expires nothing, silently, on every real install.
//
// `ingest_jobs.local_path` does hold the absolute path the CLI was given, so it is the fallback.
// Returning null when neither answers is correct and load-bearing: null means "cannot check", and
// unknown never expires a fact.
function checkoutRoot(graphDb, repo) {
  const stored = repo.full_path || '';
  if (stored.startsWith('/')) return stored;
  try {
    const row = graphDb.prepare(
      `SELECT local_path FROM ingest_jobs
        WHERE local_path IS NOT NULL AND (local_path = ? OR local_path LIKE ?)
        ORDER BY id DESC LIMIT 1`,
    ).get(repo.name, `%/${repo.name}`);
    return row && row.local_path ? row.local_path : null;
  } catch {
    return null;
  }
}

function resolveFileId(graphDb, branchId, filePath) {
  if (!branchId || !filePath) return null;
  const row = graphDb.prepare(FILE_SQL).get(branchId, filePath);
  if (row) return row.id;

  // Only for a bare name. A path the developer already qualified (`src/foo.js`) that does not
  // match is a real miss, and widening it to a suffix search would let `lib/foo.js` answer for it.
  const clean = String(filePath).replace(/^\.\//, '');
  if (clean.includes('/')) return null;
  const hits = graphDb.prepare(FILE_BY_BASENAME_SQL).all(branchId, `%/${clean}`);
  return hits.length === 1 ? hits[0].id : null;
}

// Per LINE, not per hunk. cochange-miner.js:93-105 does the same thing for the same reason: a
// multi-line hunk can straddle two declarations, and taking one global minimum span attributes the
// whole hunk to whichever declaration happened to be tightest. Ties at the winning span are KEPT —
// two METHOD rows with the same name and the same span are both legitimate, and a fact may anchor
// to more than one.
function innermostByLine(rows, startLine, endLine) {
  const kept = new Map();
  for (let ln = startLine; ln <= endLine; ln++) {
    let bestSpan = Infinity;
    const winners = [];
    for (const r of rows) {
      if (r.start_line == null || r.end_line == null) continue;
      if (ln < r.start_line || ln > r.end_line) continue;
      const span = r.end_line - r.start_line;
      if (span < bestSpan) { bestSpan = span; winners.length = 0; winners.push(r); }
      else if (span === bestSpan) winners.push(r);
    }
    for (const r of winners) kept.set(r.id, r);
  }
  return [...kept.values()].sort((a, b) => a.start_line - b.start_line || a.id - b.id);
}

// The enclosing CLASS/STRUCT/MODULE, computed from spans rather than read off canonical_key —
// binding to a key the ingest owns and can revoke is forbidden.
function ownerOf(rows, node) {
  let best = null;
  for (const r of rows) {
    if (r.id === node.id) continue;
    if (!OWNER_NODE_TYPES.includes(r.node_type)) continue;
    if (r.start_line > node.start_line || r.end_line < node.end_line) continue;
    if (!best || (r.end_line - r.start_line) < (best.end_line - best.start_line)) best = r;
  }
  return best ? best.name : null;
}

// (repo, file, line range) → the symbols the edit landed in. An empty answer is normal and is not
// a failure: declaration line-coverage is under half, so more than half of all edits land
// outside any declaration and anchor at file grain instead.
function resolveSymbols(graphDb, { branchId, fileId, startLine, endLine }) {
  if (!branchId || !fileId || !startLine) return [];
  const end = endLine == null ? startLine : endLine;
  if (end < startLine) return [];
  if (end - startLine > MAX_HUNK_LINES) return [];

  const rows = graphDb.prepare(OVERLAP_SQL).all(branchId, fileId, end, startLine);
  const candidates = rows.filter((r) => !EXCLUDED_NODE_TYPES.includes(r.node_type));
  const resolved = innermostByLine(candidates, startLine, end);

  // A hunk spanning two methods also covers the class-body lines between them, and for those lines
  // the innermost declaration IS the class. That is the honest answer and it is what the
  // cochange-miner idiom produces, so resolution reports it — but an anchor on the enclosing class
  // adds nothing when the specific methods are already anchored. Flagged here rather than dropped,
  // so the promotion step decides and this stays a report of what is true.
  return resolved.map((n) => ({
    node_type: n.node_type,
    name: n.name,
    owner: ownerOf(rows, n),
    start_line: n.start_line,
    end_line: n.end_line,
    span: n.end_line - n.start_line,
    encloses_resolved: resolved.some((o) => o.id !== n.id
      && o.start_line >= n.start_line && o.end_line <= n.end_line),
  }));
}

// The anchor set: the most specific resolved declarations. Falls back to the enclosing container
// when it is the only thing the edit landed in, because an anchor on a class is worth more than
// no anchor at all.
function anchorable(resolved) {
  const specific = resolved.filter((n) => !n.encloses_resolved);
  return specific.length ? specific : resolved;
}


const DECLS_SQL = `
SELECT n.id, n.node_type, n.name, n.start_line, n.end_line
  FROM nodes n
 WHERE n.repository_branch_id = ?
   AND n.file_id = ?
   AND n.approval_status = 'APPROVED'
   AND n.start_line IS NOT NULL
   AND n.end_line IS NOT NULL
 ORDER BY n.start_line, n.id`;

// Every declaration in a file, for revalidation: the orphan check asks whether a name is still
// there, and the rename check needs the whole candidate set to compare against.
function fileDeclarations(graphDb, branchId, fileId) {
  if (!branchId || !fileId) return [];
  return graphDb.prepare(DECLS_SQL).all(branchId, fileId)
    .filter((r) => !EXCLUDED_NODE_TYPES.includes(r.node_type));
}

const BY_NAME_SQL = `
SELECT n.id, n.node_type, n.name, n.start_line, n.end_line, f.path AS file_path
  FROM nodes n
  JOIN files f ON f.id = n.file_id
 WHERE n.repository_branch_id = ?
   AND n.approval_status = 'APPROVED'
   AND n.start_line IS NOT NULL
   AND n.end_line IS NOT NULL
   AND lower(n.name) = lower(?)
 LIMIT 200`;

// The direction the rest of this file never needed: a NAME, not a line range. An authored fact
// arrives as "this is true of parseSizeInBytes" with no edit and no hunk behind it, so there is no
// range to overlap and the lookup has to start from the identifier.
//
// Two passes, because `Session.get` is one string in every language here and a node's `name` holds
// only the final component: the exact name first, then its final component, and never both merged
// — a bare `get` matching forty methods must not be reached while `Session.get` had an exact hit.
function resolveByName(graphDb, branchId, { name, fileHint = null } = {}) {
  if (!graphDb || !branchId || !name) return [];
  const attempts = [String(name).trim()];
  const tail = finalComponentOf(attempts[0]);
  if (tail && tail !== attempts[0]) attempts.push(tail);

  for (const candidate of attempts) {
    const rows = graphDb.prepare(BY_NAME_SQL).all(branchId, candidate)
      .filter((r) => !EXCLUDED_NODE_TYPES.includes(r.node_type));
    const scoped = fileHint ? rows.filter((r) => pathMatches(r.file_path, fileHint)) : rows;
    if (!scoped.length) continue;
    // Smallest span first: an overload resolved to the class that contains it is the wrong answer
    // when the method itself is in the set. Then lowest id, so a tie is deterministic.
    return scoped
      .map((r) => ({
        node_type: r.node_type,
        name: r.name,
        file_path: r.file_path,
        start_line: r.start_line,
        end_line: r.end_line,
        span: r.end_line - r.start_line,
      }))
      .sort((a, b) => a.span - b.span || a.file_path.localeCompare(b.file_path)
        || a.start_line - b.start_line);
  }
  return [];
}

function finalComponentOf(name) {
  const parts = String(name).split(/::|->|\.|\//).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function pathMatches(nodePath, hint) {
  const p = String(nodePath || '');
  const h = String(hint || '').replace(/^\.\//, '');
  if (!h) return true;
  if (!p) return false;
  return p === h || p.endsWith(`/${h}`) || p.split('/').pop() === h.split('/').pop();
}

// Does the graph know this path at all? An authored fact naming a file that was deleted must be
// storable and REPORTABLE as unanchored — the audit of a stale instruction file is the product —
// so this answers the question rather than deciding what to do about it.
function fileExists(graphDb, branchId, filePath) {
  return resolveFileId(graphDb, branchId, filePath) !== null;
}

// The graph's CANONICAL repo-relative path for a hint, or null. A bare basename (`auth.py`)
// resolves through resolveFileId's suffix fallback to a real file id; storing that hint verbatim as
// an anchor coordinate is wrong — the anchor is supposed to hold a durable repo-relative path, and
// `auth.py` orphans the moment a second `auth.py` appears (the fallback then returns null and the
// file reads as deleted). This returns the `files.path` behind the resolved id so the anchor stores
// the canonical form.
function resolveFilePath(graphDb, branchId, filePath) {
  const id = resolveFileId(graphDb, branchId, filePath);
  if (!id) return null;
  try {
    const row = graphDb.prepare('SELECT path FROM files WHERE id = ?').get(id);
    return row ? row.path : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  openGraphDb, resolveBranch, resolveFileId, resolveSymbols, anchorable, innermostByLine, ownerOf,
  fileDeclarations, checkoutRoot, resolveByName, fileExists, resolveFilePath, identityOfCheckout,
  EXCLUDED_NODE_TYPES, OWNER_NODE_TYPES, MAX_HUNK_LINES, OVERLAP_SQL, FILE_SQL, DECLS_SQL,
  BY_NAME_SQL,
};
