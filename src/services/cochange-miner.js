'use strict';

// Temporal co-change edges (`CO_CHANGES`), mined from git history at DECLARATION grain.
//
// WHY THIS EXISTS ALONGSIDE git-coupling-analyzer.js
// -------------------------------------------------
// `git-coupling-analyzer.js` already writes COUPLED_WITH from co-change, but at file grain and
// attached to whichever node happens to sort first in the file, with no commit-size filter, no
// direction and no age weighting. A 200-file release commit there contributes 19 900 pairs of
// equal standing to a two-file bugfix. This miner is the declaration-grain replacement:
//
//   * hunks are mapped to the declaration that contains them, using the product's own
//     tree-sitter extractor over the file content AT THAT COMMIT (no ctags, no LLM, no network);
//     the file's FILE node is the fallback endpoint when no declaration can be identified;
//   * commits touching more than `maxFiles` source files are dropped entirely — a sweep is not
//     a causal blast radius;
//   * support is DECAYED: by default each contributing commit is worth 0.5 ** (ageDays /
//     halfLifeDays), and an edge exists only when the decayed support reaches `minSupport`. Two
//     other weightings exist (`decay: 'linear' | 'none' | 'auto'`, see DEFAULTS). Every one of
//     them caps a commit at 1.0, so decayed support >= K implies raw count >= K: decay can only
//     ever remove an edge, never invent one;
//   * commits carry a CHANGE TYPE (`alter` / `additive` / `bulk`) and `changeTypes` conditions
//     the mine on it. Off by default;
//   * confidence is ASYMMETRIC — `co_change_count / commits_touching_source` — so both
//     directions are stored and A->B is generally not B->A. "Whenever I touch the parser I touch
//     the token table" is not the same claim as its converse.
//
// Same-file pairs are not emitted: the graph already carries that relationship through CONTAINS,
// and a blast-radius answer that returns the seed's own file traverses no edge.
//
// `until` exists for one reason: BENCHMARK HONESTY. The blast-radius gold is itself co-change
// mined from history, so mining edges from the same commits is training on the test set. In
// production this is left unset and the whole history is read; a benchmark run pins it to a
// cutoff strictly earlier than the window the gold is built from, which HANDICAPS the arm
// relative to what ships.

const { execFileSync } = require('child_process');
const pathmod = require('path');
const pool = require('../db/pool');
const { bulkWrite } = require('../db/bulk');
const { buildAstNodes, awaitTreeSitterReady, EXT_TO_AST_LANG } = require('./ast-extractor');
const { deriveConfidenceTier } = require('./resolution/tiers');

const DEFAULTS = {
  maxFiles: 20,
  // A commit-size cap on FILES alone is not enough. `requests` has 37 source files, so a
  // reformat touching five of them passes a 20-file cap while touching 444 declarations and
  // contributing 98 000 pairs of equal standing — one commit swamping the entire repository.
  // The declaration cap is the filter that actually bounds the damage.
  maxDecls: 30,
  minSupport: 3,
  halfLifeDays: 1095,
  // Declaration-grain co-change is sparse: most declaration pairs co-change exactly once, so a
  // support threshold of 2 already discards almost everything. The coarse plane (FILE node to
  // FILE node) is where the repetition actually lives, and it reaches a declaration in three
  // hops through CONTAINS. It is a separate switch because it buys reach at the cost of fanout,
  // and that trade has to be measurable rather than assumed.
  filePairs: false,
  until: null,
  // CHANGE-TYPE CONDITIONING (Zimmermann et al., IEEE TSE 31(6) 2005). Restricting evolutionary
  // coupling to maintenance transactions — pure alterations, no items added or deleted — almost
  // doubled recall to 44% with precision roughly unchanged over >100k transactions. `null` keeps
  // every transaction, which is the shipped default and the configuration every published
  // co-change number here was measured on.
  changeTypes: null,
  // A commit big enough to be a sweep rather than a change is tagged `bulk` even when it is a
  // pure alteration: a 15-file reformat is not maintenance in the sense the finding relies on.
  bulkFiles: 8,
  bulkDecls: 12,
  // `exponential` is the shipped decay. `auto` is the paper's linear age weighting GATED on
  // repository volatility — it improved Eclipse (0.24 -> 0.28 recall) and did nothing at all on
  // GCC, so applying it unconditionally is not what was measured.
  decay: 'exponential',
  linearFloor: 0.05,
  volatilityRatio: 1.5,
  volatilityMinSpanDays: 30,
  volatilityMinCommits: 30,
};

const HUNK_RE = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm;

function git(repoPath, args, { allowFail = false, input = null } = {}) {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'ignore'],
      ...(input === null ? {} : { input }),
    });
  } catch (err) {
    if (allowFail) return '';
    throw err;
  }
}

function isSourcePath(p) {
  const ext = pathmod.extname(p).toLowerCase();
  return Boolean(ext && EXT_TO_AST_LANG[ext]);
}

// `git log`/`git show --raw` always report paths relative to the git WORKING TREE ROOT, never
// relative to `-C repoPath`. When the ingest root is a subdirectory of the checkout (an ordinary
// monorepo-workspace shape — see the same fix in src/cli/ingest.js#rebaseDiffToIngestRoot), those
// paths never match `fileNode`'s ingest-root-relative keys, so `fileNode.has(path)` is false for
// EVERY file on EVERY commit and mining silently produces zero edges for the whole repository.
// `git show sha:path` itself still needs the ORIGINAL git-root-relative path — it resolves against
// the repo root regardless of `-C` — so this only rewrites the key used to consult the graph.
function gitRootRelativeToIngestRoot(repoPath) {
  const ingestRoot = pathmod.resolve(repoPath);
  let gitRoot;
  try {
    gitRoot = git(repoPath, ['rev-parse', '--show-toplevel']).trim();
  } catch (_) {
    return (p) => p;
  }
  if (!gitRoot || pathmod.resolve(gitRoot) === ingestRoot) return (p) => p;
  return (p) => {
    const rel = pathmod.relative(ingestRoot, pathmod.resolve(gitRoot, p));
    if (rel === '' || rel.startsWith('..') || pathmod.isAbsolute(rel)) return null;
    return rel.split(pathmod.sep).join('/');
  };
}

// One `git show` yields both the per-file status letter (`--raw`) and the line counts
// (`--numstat`); asking for `--name-only` and then asking again for the shape would double the
// history walk. The file list this produces is the same list, in the same order, that
// `--name-only` produced.
function commitDiff(repoPath, sha) {
  // `--unified=0` rides along on the SAME invocation that already fetches --raw and --numstat.
  // Before this, every file of every commit cost a SECOND `git show -U0 -- <path>` purely to
  // learn its changed line numbers: 568 extra process spawns on this repository's 152 commits,
  // and it scales with history, so expressjs/express (6,163 commits) spent nearly its whole
  // 113 s ingest here. git already emits the hunk headers for every file in one pass.
  //
  // This single-commit form is what a caller asking about ONE commit wants. The history walk
  // does not use it — see walkCommitDiffs, which gets every commit from one process.
  return parseCommitBody(git(repoPath,
    ['show', '--format=', '--raw', '--numstat', '--unified=0', '--no-color', sha],
    { allowFail: true }));
}

function parseCommitBody(out) {
  const files = [];
  const lineCounts = new Map();
  const hunks = new Map();
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line[0] === ':') {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const meta = line.slice(0, tab).trim().split(/\s+/);
      const paths = line.slice(tab + 1).split('\t');
      files.push({ path: paths[paths.length - 1], status: (meta[meta.length - 1] || 'M')[0] });
      continue;
    }
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parseInt(parts[0], 10);
    const removed = parseInt(parts[1], 10);
    // A binary file reports `-` for both; it contributes a status but no line shape.
    if (!Number.isFinite(added) || !Number.isFinite(removed)) continue;
    lineCounts.set(parts[parts.length - 1], { added, removed });
  }
  parsePatchHunks(out, hunks);
  return { files, lineCounts, hunks };
}

// git quotes a path containing a control character, a space-with-quote, or a non-ASCII byte when
// core.quotePath is on (the default), so `+++ b/...` is not always a literal path. Rather than
// re-implement git's C-style unquoting, an unparsed name is simply left out of the map — the
// caller falls back to the per-file `changedLines` call for exactly those paths, which is the
// slow-but-correct path this optimisation replaces everywhere else.
// One process for many commits instead of one process per commit.
//
// `git show` per commit cost 51.8 s of subprocess time on expressjs/express (5,678 non-merge
// commits); the same diffs come out of a single `git log` in 565 ms. `--no-walk --stdin` is used
// rather than a plain revision walk because it takes the exact commit list the caller already
// resolved, in the caller's order, so the history filter stays in one place.
//
// Batched rather than one call for the whole history because the output is real memory: express's
// full history is 14.5 MB, and RAM is a product constraint here — a repository two orders of
// magnitude larger must not be the first thing that decides this. 500 commits is ~1 MB on express.
const COMMIT_BATCH = parseInt(process.env.COCHANGE_COMMIT_BATCH || '500', 10);

// 0x1e RECORD SEPARATOR, matched only at the START OF A LINE and only when a full 40-hex sha
// follows. Splitting on the byte alone is NOT safe and the first version of this did exactly
// that: psf/requests commit 724ae127 touches `ext/requests-logo.ai`, which git treats as text,
// and its body carries 8,995 literal 0x1e bytes. The block shattered and the commit came back
// with zero files — silently, because an unemitted commit falls through to the empty-diff path.
//
// Line-anchoring is what makes it sound. Under --unified=0 git prefixes every added line with
// `+` and every removed line with `-`, and emits no context lines at all, so no line of file
// content can begin at column 0 with anything — the only lines that can are git's own headers
// and this marker.
const RS = '\x1e';
const COMMIT_MARK = /^\x1e([0-9a-f]{40})$/;

// Many blobs from one process. `git show <sha>:<path>` per file was the last per-file spawn on
// the history walk and, after the diffs were batched, the single largest cost left in an ingest:
// 21.9 s of a 28.6 s express run was spawnSync, and everything outside co-change takes 1 s.
//
// Read as BUFFERS, not utf8. `--batch` frames each object as `<oid> <type> <size>\n<bytes>\n`,
// and the size is in bytes — decoding first would make a multi-byte character shift every
// subsequent offset and desynchronise the whole stream. Each blob is decoded on its own, after
// its frame has been cut at the byte offset git actually gave.
function readBlobs(repoPath, specs) {
  const found = new Map();
  if (!specs.length) return found;

  let out;
  try {
    out = execFileSync('git', ['-C', repoPath, 'cat-file', '--batch'], {
      input: `${specs.join('\n')}\n`,
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch (_) {
    return found;                       // caller falls back to the per-file read
  }

  let at = 0;
  for (const spec of specs) {
    const nl = out.indexOf(0x0a, at);
    if (nl < 0) break;
    const header = out.toString('utf8', at, nl);
    at = nl + 1;
    // `<spec> missing` — a path that did not exist at that commit. Skipped, not fatal: the file
    // list comes from the diff, so this only happens on a history git cannot fully resolve.
    if (header.endsWith(' missing')) continue;
    const size = parseInt(header.slice(header.lastIndexOf(' ') + 1), 10);
    if (!Number.isFinite(size)) break;
    found.set(spec, out.toString('utf8', at, at + size));
    at += size + 1;                     // git writes one trailing newline after the payload
  }
  return found;
}

function* walkCommitDiffs(repoPath, shas, { batchSize = COMMIT_BATCH } = {}) {
  for (let i = 0; i < shas.length; i += batchSize) {
    const slice = shas.slice(i, i + batchSize);
    const out = git(repoPath,
      ['log', '--no-walk', '--stdin', `--format=${RS}%H`, '--raw', '--numstat', '--unified=0', '--no-color'],
      { allowFail: true, input: `${slice.join('\n')}\n` });

    const seen = new Set();
    let sha = null;
    let body = [];
    const flush = function* flush() {
      if (!sha) return;
      seen.add(sha);
      yield { sha, diff: parseCommitBody(body.join('\n')) };
    };
    for (const line of out.split('\n')) {
      const mark = COMMIT_MARK.exec(line);
      if (!mark) { if (sha) body.push(line); continue; }
      yield* flush();
      sha = mark[1];
      body = [];
    }
    yield* flush();
    // A commit git declined to emit (a corrupt object, a grafted history) must not silently
    // vanish from the plane: it is yielded with an empty diff so the caller's own accounting
    // still sees it, exactly as the per-commit `git show` used to on an allowFail return.
    for (const sha of slice) {
      if (!seen.has(sha)) yield { sha, diff: parseCommitBody('') };
    }
  }
}

function unquoteGitPath(raw) {
  return raw.startsWith('"') ? null : raw;
}

// Attribution is by the `+++ b/<path>` line inside each `diff --git` block, not by position.
// Position looks tempting because git emits patch blocks in raw-list order, but a mode-only
// change contributes a header with no hunks and a deletion contributes `+++ /dev/null`, so an
// index-based pairing silently shifts every subsequent file's line numbers onto the wrong file.
function parsePatchHunks(out, hunks) {
  let current = null;
  let inHeader = false;
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) { current = null; inHeader = true; continue; }
    // `+++ ` is only a file header BEFORE the first hunk of a block. Under --unified=0 every
    // added line is prefixed with `+`, so an added line whose own text begins with `++` arrives
    // here as `+++...` and reads exactly like a header. Measured against the per-file call over
    // this repository's history: 2 files of 1,882 lost most of their hunks that way
    // (blast-radius.js 277 lines -> 1) because the bogus header retargeted `current`.
    if (inHeader && line.startsWith('+++ ')) {
      const name = line.slice(4).trim();
      current = name === '/dev/null' ? null : unquoteGitPath(name.replace(/^b\//, ''));
      if (current && !hunks.has(current)) hunks.set(current, []);
      continue;
    }
    if (!current || !line.startsWith('@@')) continue;
    inHeader = false;
    const m = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = parseInt(m[1], 10);
    const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
    const list = hunks.get(current);
    for (let i = 0; i < count; i++) list.push(start + i);
  }
}

// The transaction shape the change-type tag is derived from, restricted to source files: a README
// added beside a code alteration says nothing about which code entities were added.
function summariseTransaction(diff) {
  const txn = { m: 0, a: 0, d: 0, r: 0, ins: 0, del: 0 };
  for (const f of diff.files) {
    if (!isSourcePath(f.path)) continue;
    if (f.status === 'A') txn.a += 1;
    else if (f.status === 'D') txn.d += 1;
    else if (f.status === 'R' || f.status === 'C') txn.r += 1;
    else txn.m += 1;
    const n = diff.lineCounts.get(f.path);
    if (n) { txn.ins += n.added; txn.del += n.removed; }
  }
  return txn;
}

// The paper's transaction taxonomy, applied to what git records: a maintenance transaction is a
// pure alteration — every touched entity already existed and still exists. A commit that only
// inserts lines into an existing file is adding entities too, so it is not maintenance.
function commitChangeType(commit, opts = DEFAULTS) {
  const txn = commit.txn;
  if (!txn) return 'unknown';
  const nodeCount = Array.isArray(commit.nodes) ? commit.nodes.length : 0;
  if (commit.src > opts.bulkFiles || nodeCount > opts.bulkDecls) return 'bulk';
  if (txn.a || txn.d || txn.r) return 'additive';
  if (txn.del === 0 && txn.ins > 0) return 'additive';
  return 'alter';
}

// Volatility, from commit dates alone: what share of the history's commits fall in the newest
// quarter of its time span, normalised so a uniformly-paced repository scores 1.0. Eclipse-shaped
// (accelerating) repositories score well above it; a mature, evenly-worked codebase does not.
// The floors exist because a repository with 20 commits over 2 days has no age spread to weight.
function repositoryVolatility(dates, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const ts = [...dates].filter(Number.isFinite).sort((a, b) => a - b);
  if (ts.length < 2) return { commits: ts.length, span_days: 0, recent_share: 0, ratio: 0, volatile: false };
  const span = ts[ts.length - 1] - ts[0];
  const spanDays = span / 86400000;
  const cutoff = ts[0] + span * 0.75;
  const recent = ts.filter((t) => t >= cutoff).length;
  const share = recent / ts.length;
  const ratio = share / 0.25;
  return {
    commits: ts.length,
    span_days: Number(spanDays.toFixed(2)),
    recent_share: Number(share.toFixed(4)),
    ratio: Number(ratio.toFixed(3)),
    volatile: ts.length >= opts.volatilityMinCommits
      && spanDays >= opts.volatilityMinSpanDays
      && ratio >= opts.volatilityRatio,
  };
}

function changedLines(repoPath, sha, path) {
  const out = git(repoPath, ['show', '-U0', '--no-color', '--format=', sha, '--', path],
    { allowFail: true });
  const lines = [];
  HUNK_RE.lastIndex = 0;
  let m;
  while ((m = HUNK_RE.exec(out)) !== null) {
    const start = parseInt(m[1], 10);
    const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
    for (let i = 0; i < count; i++) lines.push(start + i);
  }
  return lines;
}

// The innermost declaration containing a line, so a body edit attributes to the method rather
// than to the class that encloses it.
function innermostDecls(decls, lines) {
  const hit = new Set();
  for (const ln of lines) {
    let best = null;
    for (const d of decls) {
      if (d.start_line == null || d.end_line == null) continue;
      if (ln < d.start_line || ln > d.end_line) continue;
      if (!best || (d.end_line - d.start_line) < (best.end_line - best.start_line)) best = d;
    }
    if (best) hit.add(best.name);
  }
  return hit;
}

async function loadBranchIndex(branchId, deps = {}) {
  const _pool = deps.pool || pool;
  // `f.index_status` excludes PENDING: a file the ingest-policy skip (generated/minified/binary/
  // vendored — ingest-policy.js's GENERATED_FILE_RE etc.) still gets a stub FILE node so the graph
  // can represent "this file exists", but it was never actually structurally parsed. Without this
  // filter that stub makes `fileNode.has(path)` true, so co-change mining re-parses the file's raw
  // historical content from git at every commit that touched it — on a vendored minified asset
  // (e.g. a 3MB `mermaid.min.js` with 300k-character lines, found on a real repo) `buildAstNodes`
  // alone takes 30+ seconds PER COMMIT, turning a mine that should take under a minute into one
  // that never finishes. COMPLETE and DEGRADED both mean real extraction ran (DEGRADED still
  // parsed, just imperfectly); only PENDING means "policy decided not to look at this file".
  const { rows } = await _pool.query(
    `SELECT n.id, n.name, n.node_type, f.path
       FROM nodes n
       JOIN files f ON f.id = n.file_id
      WHERE n.repository_branch_id = $1 AND n.approval_status <> 'ARCHIVED'
        AND f.index_status IN ('COMPLETE', 'DEGRADED')`,
    [branchId],
  );
  const decls = new Map();     // `${path}\x00${name}` -> [nodeId]
  const fileNode = new Map();  // path -> FILE node id
  const nodeFile = new Map();  // nodeId -> path
  for (const r of rows) {
    nodeFile.set(r.id, r.path);
    if (r.node_type === 'FILE') { fileNode.set(r.path, r.id); continue; }
    const k = `${r.path}\x00${r.name}`;
    if (!decls.has(k)) decls.set(k, []);
    decls.get(k).push(r.id);
  }
  return { decls, fileNode, nodeFile };
}

// PASS 1 — read history once and record, per commit, which graph nodes it touched and at what
// grain. Everything downstream (commit-size filter, support threshold, decay half-life) is a pure
// function of this table, so a sensitivity sweep costs no extra history walk.
async function collectCommitTouches(repoPath, branchId, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const _pool = options.pool || pool;
  await awaitTreeSitterReady().catch(() => ({}));

  const { decls, fileNode, nodeFile } = await loadBranchIndex(branchId, { pool: _pool });
  if (!fileNode.size) return null;

  const toGraphPath = gitRootRelativeToIngestRoot(repoPath);

  const logArgs = ['log', '--no-merges', '--format=%H%x1f%cI'];
  if (opts.until) logArgs.push(`--until=${opts.until}`);
  const log = git(repoPath, logArgs).split('\n').filter((l) => l.trim());
  // psf/requests carries a commit stamped `+518:00`. `Date.parse` returns NaN for it, and a
  // single NaN poisons `Math.max` -> the reference date becomes NaN -> every age clamps to 0 ->
  // the decay silently switches off for the whole repository. Drop such commits and count them.
  const parsed = log.map((l) => {
    const i = l.indexOf('\x1f');
    return { sha: l.slice(0, i), date: Date.parse(l.slice(i + 1)) };
  });
  const commitsAll = parsed.filter((c) => Number.isFinite(c.date));
  const badDates = parsed.length - commitsAll.length;
  if (!commitsAll.length) return null;
  // Co-change mining re-parses the historical version of every changed file, per commit — measured
  // at ~15 ms/parse, ~1.5 parses/commit, so cost is linear in commit count. On a 50k-commit repo
  // (sympy) that is ~19 minutes of pure tree-sitter parsing; on the ICP's own repos it is seconds.
  // Cap to the most RECENT commits (git log is newest-first) — the ones the age decay weights
  // highest and whose coupling is least likely to be stale. The default (10k) sits ABOVE every
  // repo the co-change benchmark was measured on (requests ~6.3k, thrift ~5.5k, viper ~3k), so
  // those numbers are preserved by construction; it only bounds pathological histories. 0 = full.
  const maxCommits = parseInt(process.env.COCHANGE_MAX_COMMITS ?? '10000', 10);
  const commits = (maxCommits > 0 && commitsAll.length > maxCommits)
    ? commitsAll.slice(0, maxCommits) : commitsAll;
  const commitsSkippedForCap = commitsAll.length - commits.length;
  if (commitsSkippedForCap > 0) {
    console.error(`[cochange] mining the ${commits.length} most recent of ${commitsAll.length} commits `
      + `(${commitsSkippedForCap} older skipped for speed; set COCHANGE_MAX_COMMITS=0 for full history)`);
  }

  const stats = {
    commits_in_window: commits.length,
    files_unmapped: 0,
    files_decl_grain: 0,
    files_file_grain: 0,
    parse_failures: 0,
    commits_unparseable_date: badDates,
  };
  const touches = [];

  const byDate = new Map(commits.map((c) => [c.sha, c.date]));
  const allShas = commits.map((x) => x.sha);

  // Two passes over each batch of commits rather than one pass over each commit: the diffs come
  // from one `git log`, and then every blob those diffs actually need comes from one
  // `git cat-file --batch`. Batched at the same boundary as the diffs so peak memory stays a
  // function of COMMIT_BATCH and not of the repository's whole history.
  for (let b = 0; b < allShas.length; b += COMMIT_BATCH) {
    const batch = [...walkCommitDiffs(repoPath, allShas.slice(b, b + COMMIT_BATCH))];

    const specs = [];
    const wanted = new Set();
    for (const { sha, diff } of batch) {
      const srcFiles = diff.files.map((f) => f.path).filter(isSourcePath);
      if (!srcFiles.length || srcFiles.length > Math.max(opts.maxFiles, opts.scanMaxFiles || 60)) continue;
      for (const path of srcFiles) {
        const graphPath = toGraphPath(path);
        if (!graphPath || !fileNode.has(graphPath)) continue;
        if (!(diff.hunks.get(path) || []).length) continue;
        const spec = `${sha}:${path}`;
        if (wanted.has(spec)) continue;
        wanted.add(spec);
        specs.push(spec);
      }
    }
    const blobs = readBlobs(repoPath, specs);

    for (const { sha, diff } of batch) {
    const c = { sha, date: byDate.get(sha) };
    const src = diff.files.map((f) => f.path).filter(isSourcePath);
    if (!src.length) continue;
    const txn = summariseTransaction(diff);
    // The scan cap is deliberately far above any plausible `maxFiles`: a sweep commit is skipped
    // by the filter downstream, and parsing 400 files of a release commit to then discard it is
    // wasted work.
    if (src.length > Math.max(opts.maxFiles, opts.scanMaxFiles || 60)) {
      touches.push({ sha: c.sha, date: c.date, src: src.length, txn, nodes: [] });
      continue;
    }

    const touched = new Map();
    for (const path of src) {
      const graphPath = toGraphPath(path);
      if (!graphPath || !fileNode.has(graphPath)) { stats.files_unmapped++; continue; }
      // The combined `git show` above already carries this file's hunks. `changedLines` stays as
      // the fallback for a path git chose to quote, which the patch parser deliberately declines
      // to decode rather than re-implementing git's unquoting.
      const lines = diff.hunks.has(path) ? diff.hunks.get(path) : changedLines(repoPath, c.sha, path);
      let names = new Set();
      if (lines.length) {
        const spec = `${c.sha}:${path}`;
        // The batch read above covers every file whose hunks came from the diff. A path that took
        // the `changedLines` fallback was never requested, so it reads on its own here.
        const content = blobs.has(spec)
          ? blobs.get(spec)
          : git(repoPath, ['show', spec], { allowFail: true });
        if (content) {
          let built = null;
          try { built = buildAstNodes(content, graphPath); } catch (_) { stats.parse_failures++; }
          if (built && Array.isArray(built.nodes)) names = innermostDecls(built.nodes, lines);
        }
      }
      const ids = [];
      for (const name of names) {
        for (const id of (decls.get(`${graphPath}\x00${name}`) || [])) ids.push(id);
      }
      if (ids.length) {
        stats.files_decl_grain++;
        for (const id of ids) if (!touched.has(id)) touched.set(id, 'decl');
      } else {
        stats.files_file_grain++;
        const fid = fileNode.get(graphPath);
        if (!touched.has(fid)) touched.set(fid, 'file');
      }
    }
    touches.push({
      sha: c.sha, date: c.date, src: src.length, txn,
      nodes: [...touched.entries()].map(([id, grain]) => [id, grain]),
    });
    }
  }

  stats.commits_skipped_for_cap = commitsSkippedForCap;
  const nodeFileObj = {};
  for (const [id, p] of nodeFile) nodeFileObj[id] = p;
  return {
    stats,
    touches,
    node_file: nodeFileObj,
    file_node_ids: [...fileNode.values()],
    ref_date: maxDate(commits),
  };
}

// Reduce rather than Math.max(...spread) — the spread blows the call stack on a full history
// (COCHANGE_MAX_COMMITS=0), the same harness bug the decay code above avoids.
function maxDate(commits) {
  let ref = -Infinity;
  for (const c of commits) if (c.date > ref) ref = c.date;
  return ref === -Infinity ? 0 : ref;
}

// Which age weighting actually runs, and — for `auto` — the volatility measurement that decided
// it. Recorded in `stats.decay` because "the decay was off" and "the decay ran and changed
// nothing" are different claims and a report has to be able to tell them apart.
function buildWeightFn(dates, refDate, opts, stats) {
  const finite = dates.filter(Number.isFinite);
  // Reduce rather than Math.min(...spread) — harness bug 17: the spread blows the call stack on a
  // real history.
  let oldest = refDate;
  for (const d of finite) if (d < oldest) oldest = d;
  const spanDays = Math.max(0, (refDate - oldest) / 86400000);
  const linear = (ageDays) => (spanDays > 0
    ? Math.max(opts.linearFloor, 1 - (ageDays / spanDays))
    : 1);
  const exponential = (ageDays) => Math.pow(0.5, ageDays / opts.halfLifeDays);

  let mode = opts.decay || 'exponential';
  let volatility = null;
  if (mode === 'auto') {
    volatility = repositoryVolatility(finite, opts);
    mode = volatility.volatile ? 'linear' : 'none';
  }
  const fn = { exponential, linear, none: () => 1 }[mode];
  if (!fn) throw new Error(`cochange-miner: unknown decay mode '${opts.decay}'`);
  if (stats) {
    stats.decay = {
      requested: opts.decay || 'exponential', effective: mode, span_days: Number(spanDays.toFixed(2)), volatility,
    };
  }
  return fn;
}

// PASS 2 — pure. Apply the commit-size filter, accumulate decayed support and asymmetric
// confidence, and return the directed edge list plus the stats a write-up has to quote.
function buildPairs(collected, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const nodeFile = collected.node_file;
  const fileNodeIds = new Set(collected.file_node_ids);
  const pathToFileNode = new Map(collected.file_node_ids.map((id) => [nodeFile[id], id]));
  const refDate = collected.ref_date;
  if (!Number.isFinite(refDate)) {
    throw new Error('FATAL: collected.ref_date is not a finite timestamp — the age decay would '
      + 'silently be a no-op. Re-collect (delete the cache).');
  }

  const pairs = new Map();
  const nodeCommits = new Map();
  const stats = {
    commits_over_max_files: 0, commits_over_max_decls: 0, commits_used: 0,
    commits_filtered_by_change_type: 0,
    change_type_counts: { alter: 0, additive: 0, bulk: 0, unknown: 0 },
    endpoints_decl: 0, endpoints_file: 0,
  };

  const dates = collected.touches.map((c) => c.date);
  const weightOf = buildWeightFn(dates, refDate, opts, stats);
  const changeFilter = opts.changeTypes ? new Set(opts.changeTypes) : null;

  for (const c of collected.touches) {
    if (c.src > opts.maxFiles) { stats.commits_over_max_files++; continue; }
    if (!c.nodes || c.nodes.length < 2) continue;
    if (c.nodes.length > opts.maxDecls) { stats.commits_over_max_decls++; continue; }
    const changeType = commitChangeType(c, opts);
    stats.change_type_counts[changeType] += 1;
    if (changeFilter && !changeFilter.has(changeType)) {
      stats.commits_filtered_by_change_type++;
      continue;
    }
    stats.commits_used++;
    const ageDays = Math.max(0, (refDate - c.date) / 86400000);
    const w = weightOf(ageDays);
    const grainOf = new Map(c.nodes);
    const ids = c.nodes.map(([id]) => id);
    for (const id of ids) nodeCommits.set(id, (nodeCommits.get(id) || 0) + 1);
    if (opts.filePairs) {
      const fids = [...new Set(ids.map((id) => pathToFileNode.get(nodeFile[id])))]
        .filter((x) => x !== undefined);
      for (let i = 0; i < fids.length; i++) {
        for (let j = i + 1; j < fids.length; j++) {
          const a = fids[i]; const b = fids[j];
          if (a === b) continue;
          const lo = a < b ? a : b; const hi = a < b ? b : a;
          const k = `${lo}\x00${hi}`;
          let rec = pairs.get(k);
          if (!rec) { rec = { n: 0, w: 0, decl: 0, file: 0, t: {} }; pairs.set(k, rec); }
          rec.n += 1; rec.w += w; rec.file += 1;
          rec.t[changeType] = (rec.t[changeType] || 0) + 1;
        }
      }
      for (const fid of new Set(ids.map((id) => pathToFileNode.get(nodeFile[id])))) {
        if (fid !== undefined) nodeCommits.set(fid, (nodeCommits.get(fid) || 0) + 1);
      }
    }

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]; const b = ids[j];
        if (nodeFile[a] === nodeFile[b]) continue;
        // With the coarse plane on, a FILE-to-FILE pair is already counted there; counting it
        // again here would double its support for the same commit.
        if (opts.filePairs && fileNodeIds.has(a) && fileNodeIds.has(b)) continue;
        const lo = a < b ? a : b; const hi = a < b ? b : a;
        const k = `${lo}\x00${hi}`;
        let rec = pairs.get(k);
        if (!rec) { rec = { n: 0, w: 0, decl: 0, file: 0, t: {} }; pairs.set(k, rec); }
        rec.n += 1; rec.w += w;
        rec.t[changeType] = (rec.t[changeType] || 0) + 1;
        if (grainOf.get(a) === 'decl' && grainOf.get(b) === 'decl') rec.decl += 1;
        else rec.file += 1;
      }
    }
  }

  const emit = [];
  for (const [k, rec] of pairs) {
    // Support is a COUNT of evidence; decay is a statement about RECENCY. Gating the count with
    // the decayed number compares two different units, and the threshold is a knife edge at the
    // raw value: with any real halfLifeDays a pair seen exactly `minSupport` times decays just
    // under it and is rejected — a long-history repo can lose its whole co-change plane that way.
    //
    // `decayed_support` is written to edge properties but no reader
    // ranks on it — `changes_with` orders by the miner's support RATIO (`confidence`) — so the
    // decay was gating admission and influencing nothing else.
    if (rec.n < opts.minSupport) continue;
    const sep = k.indexOf('\x00');
    const a = parseInt(k.slice(0, sep), 10);
    const b = parseInt(k.slice(sep + 1), 10);
    const grain = rec.decl && !rec.file ? 'decl' : (!rec.decl && rec.file ? 'file' : 'mixed');
    emit.push({ from: a, to: b, rec, grain, srcCommits: nodeCommits.get(a) || rec.n });
    emit.push({ from: b, to: a, rec, grain, srcCommits: nodeCommits.get(b) || rec.n });
  }

  const endpointIds = new Set(emit.map((e) => e.from));
  stats.pairs_considered = pairs.size;
  stats.pairs_admitted = emit.length / 2;
  stats.grain_decl = emit.filter((e) => e.grain === 'decl').length / 2;
  stats.grain_mixed = emit.filter((e) => e.grain === 'mixed').length / 2;
  stats.grain_file = emit.filter((e) => e.grain === 'file').length / 2;
  stats.endpoints_decl = [...endpointIds].filter((id) => !fileNodeIds.has(id)).length;
  stats.endpoints_file = [...endpointIds].filter((id) => fileNodeIds.has(id)).length;
  // Reduce rather than Math.max(...spread): a large repo produces hundreds of thousands of
  // pairs and the spread blows the call stack.
  let maxN = 0; let maxW = 0;
  for (const r of pairs.values()) { if (r.n > maxN) maxN = r.n; if (r.w > maxW) maxW = r.w; }
  stats.max_raw_support = maxN;
  stats.max_decayed_support = Number(maxW.toFixed(3));
  return { emit, stats };
}

async function writePairs(emit, opts, deps = {}) {
  const _pool = deps.pool || pool;
  const { tier, label } = deriveConfidenceTier('git_cochange');
  let written = 0;
  // One prepared statement per row inside a transaction (B4). The chunking that existed to keep
  // an unnest payload manageable is gone with unnest — the transaction is the batch now.
  const EDGE_SQL = `INSERT INTO edges
       (from_node_id, to_node_id, edge_type, confidence_tier, is_cross_repo, properties,
        resolution_tier, confidence)
     VALUES ($1, $2, 'CO_CHANGES', $4, false, $3, $5, $6)
     ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO UPDATE
       SET properties = EXCLUDED.properties, resolution_tier = EXCLUDED.resolution_tier,
           confidence = EXCLUDED.confidence, confidence_tier = EXCLUDED.confidence_tier`;

  written = await bulkWrite(_pool, EDGE_SQL, emit.map((e) => [
    e.from,
    e.to,
    JSON.stringify({
      source: 'cochange_miner',
      resolution: 'git_cochange',
      cochange_count: e.rec.n,
      decayed_support: Number(e.rec.w.toFixed(4)),
      source_commits: e.srcCommits,
      grain: e.grain,
      // Only on a conditioned run: on the default path the written properties must stay exactly
      // what every published co-change measurement was taken against.
      ...(opts.changeTypes ? { change_types: e.rec.t || {} } : {}),
      params: {
        max_files: opts.maxFiles, max_decls: opts.maxDecls, min_support: opts.minSupport,
        half_life_days: opts.halfLifeDays, file_pairs: Boolean(opts.filePairs),
        until: opts.until,
        ...(opts.changeTypes ? { change_types: [...opts.changeTypes], decay: opts.decay } : {}),
      },
    }),
    label,
    tier,
    Math.min(1, e.rec.n / Math.max(1, e.srcCommits)).toFixed(2),
  ]));
  return written;
}

async function mineCoChangeEdges(repoPath, branchId, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const collected = options.collected
    || await collectCommitTouches(repoPath, branchId, opts);
  if (!collected) return { edges_written: 0, skipped: 'branch has no file-backed nodes' };
  const { emit, stats } = buildPairs(collected, opts);
  const all = { ...collected.stats, ...stats,
    ref_date: new Date(collected.ref_date).toISOString() };
  if (opts.dryRun) return { ...all, edges_written: 0 };
  const written = await writePairs(emit, opts, { pool: options.pool || pool });
  return { ...all, edges_written: written };
}

async function deleteCoChangeEdges(branchId, deps = {}) {
  const _pool = deps.pool || pool;
  const { rowCount } = await _pool.query(
    // SQLite has neither DELETE ... USING nor a table alias on DELETE. The USING join becomes a
    // subquery against the same rows.
    `DELETE FROM edges
      WHERE edge_type = 'CO_CHANGES'
        AND from_node_id IN (SELECT n.id FROM nodes n WHERE n.repository_branch_id = $1)`,
    [branchId],
  );
  return rowCount;
}

module.exports = {
  mineCoChangeEdges, deleteCoChangeEdges, collectCommitTouches, buildPairs, writePairs,
  commitDiff, changedLines, walkCommitDiffs, readBlobs, summariseTransaction, commitChangeType, repositoryVolatility, buildWeightFn,
  gitRootRelativeToIngestRoot, loadBranchIndex,
  DEFAULTS,
};
