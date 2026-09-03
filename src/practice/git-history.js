'use strict';

const crypto = require('crypto');
const { spawnSync } = require('child_process');

// Cold start. Live capture yields too few usable code-error failures to bootstrap the layer. Git
// history already holds the same pairs — a fix commit IS failing-state → passing-state, it
// self-labels in its message, and its diff anchors it to a declaration. This module finds them.
//
// Everything here is `git` plus string work. No model, no network, no heuristic scoring: every
// emitted fact records WHICH rule fired so precision is auditable per rule and a bad rule can be
// switched off rather than tuned until it looks good.

const RS = '\x1e';
const US = '\x1f';

const DEFAULT_LIMIT = 400;
const PAGE = 250;

// A commit touching more than this is a merge, a bulk rename or a formatting sweep. It teaches
// nothing and it would anchor one message to twenty unrelated declarations.
const MAX_FILES = 20;

// -U0 keeps this small, but a generated-file commit inside the file cap can still be megabytes.
const MAX_PATCH_BYTES = 64 * 1024 * 1024;
const PATCH_BATCH = 40;

const CONVENTIONAL_FIX = /^(?:fix|bugfix|hotfix)(?:\([^)]*\))?!?:\s/i;
const CONVENTIONAL_OTHER = /^(?:feat|docs?|chore|style|refactor|perf|test|build|ci|revert)(?:\([^)]*\))?!?:\s/i;
const ISSUE_CLOSE = /\b(?:fix(?:e[sd])?|resolve[sd]?|close[sd]?)\s+(?:#|gh-|issue\s*#?)\d+/i;
const REVERT_SUBJECT = /^Revert\b/;
const REVERTS_COMMIT = /This reverts commit ([0-9a-f]{7,40})/i;

// Word-boundary anchored, so `prefix`, `fixture` and `bugfix-free prose` do not fire. This is the
// noisiest of the four fix rules by construction and is reported separately for that reason.
const FIX_KEYWORDS = Object.freeze([
  /\bfix(?:es|ed)?\b/i,
  /\bbugs?\b/i,
  /\bregress(?:ion|ions|ed)?\b/i,
  /\bbroken\b/i,
  /\bcrash(?:es|ed|ing)?\b/i,
  /\boverflow\b/i,
  /\bleaks?\b/i,
  /\brace\b/i,
  /\bdeadlock\b/i,
  /\bNPE\b/,
  /\boff-by-one\b/i,
  /\bsegfault\b|\bsegmentation fault\b/i,
  /\bnull ?pointer\b/i,
  /\bhangs?\b|\bhanging\b/i,
]);

const FUNCNAME_STOPWORDS = new Set([
  'function', 'const', 'let', 'var', 'class', 'def', 'func', 'fn', 'public', 'private',
  'protected', 'static', 'void', 'return', 'async', 'await', 'export', 'default', 'module',
  'exports', 'if', 'for', 'while', 'new', 'this', 'self', 'struct', 'impl', 'type', 'interface',
  'package', 'import', 'from', 'require', 'final', 'abstract', 'override', 'end', 'do', 'else',
  'int', 'string', 'bool', 'float', 'double', 'char', 'long', 'short', 'byte', 'object',
]);

function git(repoRoot, args, { maxBuffer = 32 * 1024 * 1024, input = undefined } = {}) {
  const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', maxBuffer, input });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr || '').trim()}`);
  return r.stdout || '';
}

function isGitRepo(repoRoot) {
  const r = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--git-dir'], { encoding: 'utf8' });
  return r.status === 0;
}

function h16(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

// Which rule fired, in precision order. A commit that self-labels `feat:`/`docs:` and only trips
// the keyword net is not a fix — the author already said what it was.
function classifyCommit({ subject = '', body = '' }) {
  const subj = String(subject);
  const full = `${subj}\n${String(body)}`;

  if (REVERT_SUBJECT.test(subj) || REVERTS_COMMIT.test(full)) {
    return { fixShaped: true, kind: 'revert', rule: 'revert_message' };
  }
  if (CONVENTIONAL_FIX.test(subj)) {
    return { fixShaped: true, kind: 'correction', rule: 'fix_conventional' };
  }
  if (ISSUE_CLOSE.test(full) && /\bfix(?:e[sd])?\b/i.test(full)) {
    return { fixShaped: true, kind: 'correction', rule: 'fix_issue' };
  }
  if (CONVENTIONAL_OTHER.test(subj)) return { fixShaped: false, rule: null };
  if (FIX_KEYWORDS.some((re) => re.test(subj))) {
    return { fixShaped: true, kind: 'correction', rule: 'fix_keyword' };
  }
  return { fixShaped: false, rule: null };
}

function revertedShaOf(body) {
  const m = REVERTS_COMMIT.exec(String(body || ''));
  return m ? m[1] : null;
}

function parseLogPage(text) {
  const out = [];
  for (const chunk of text.split(RS)) {
    if (!chunk.trim()) continue;
    const parts = chunk.split(US);
    if (parts.length < 5) continue;
    const [sha, parents, date, subject, rest] = parts;
    // `--name-only` appends the paths after the format output, separated by a blank line.
    const lines = String(rest).split('\n');
    const files = [];
    let body = [];
    let inFiles = false;
    for (const line of lines) {
      if (!inFiles) {
        if (line === '') { inFiles = true; continue; }
        body.push(line);
        continue;
      }
      if (line.trim()) files.push(line.trim());
    }
    out.push({
      sha,
      parents: String(parents).split(' ').filter(Boolean),
      date,
      subject,
      body: body.join('\n').trim(),
      files,
    });
  }
  return out;
}

// Paged rather than one call: memory stays bounded by PAGE even when `limit` is large, and each
// page is released before the next is fetched.
function* streamLog(repoRoot, { since, limit }) {
  let skip = 0;
  let emitted = 0;
  while (emitted < limit) {
    const take = Math.min(PAGE, limit - emitted);
    const args = [
      'log', '--no-color', '--name-only',
      `--format=${RS}%H${US}%P${US}%aI${US}%s${US}%b`,
      `--max-count=${take}`, `--skip=${skip}`,
    ];
    if (since) args.push(`--since=${since}`);
    const page = parseLogPage(git(repoRoot, args));
    if (!page.length) return;
    for (const c of page) { yield c; emitted++; }
    skip += take;
    if (page.length < take) return;
  }
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function identifiersIn(text) {
  const raw = String(text || '').match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || [];
  return raw.filter((t) => t.length > 2 && !FUNCNAME_STOPWORDS.has(t.toLowerCase()));
}

// One `git show` over a batch of commits. Line CONTENT is folded into two hashes per file and then
// dropped: the content is only needed to recognise an inverse pair, and keeping it would make
// memory scale with the diff size of the whole window.
function parsePatches(text) {
  const commits = new Map();
  let cur = null;
  let file = null;
  let hunk = null;
  let added = [];
  let removed = [];

  const closeFile = () => {
    if (!cur || !file) return;
    file.added_hash = h16(added.join('\n'));
    file.removed_hash = h16(removed.join('\n'));
    // A mode-only or rename-only commit has no lines either way. Two of them hash identically in
    // both directions, and the inverse-pair test would then call any such commit a revert of any
    // other. Recorded so the pair test can refuse them.
    if (added.length || removed.length) cur.has_content = true;
    added = [];
    removed = [];
    cur.files.push(file);
    file = null;
    hunk = null;
  };

  for (const line of text.split('\n')) {
    if (line.startsWith(RS)) {
      closeFile();
      cur = { sha: line.slice(1).trim(), files: [], has_content: false };
      commits.set(cur.sha, cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('diff --git ')) {
      closeFile();
      file = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      file = p === '/dev/null' ? null : { path: p.replace(/^b\//, ''), hunks: [] };
      added = [];
      removed = [];
      continue;
    }
    if (!file) continue;
    const m = HUNK_RE.exec(line);
    if (m) {
      hunk = {
        old_start: parseInt(m[1], 10),
        old_lines: m[2] === undefined ? 1 : parseInt(m[2], 10),
        new_start: parseInt(m[3], 10),
        new_lines: m[4] === undefined ? 1 : parseInt(m[4], 10),
        funcname: m[5] || '',
      };
      file.hunks.push(hunk);
      continue;
    }
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-') && !line.startsWith('---')) removed.push(line.slice(1));
  }
  closeFile();
  return commits;
}

function patchHashes(files) {
  const fwd = [];
  const rev = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    fwd.push(`${f.path}|${f.added_hash}|${f.removed_hash}`);
    rev.push(`${f.path}|${f.removed_hash}|${f.added_hash}`);
  }
  return { fwd: h16(fwd.join('\n')), rev: h16(rev.join('\n')) };
}

function fetchPatches(repoRoot, shas) {
  if (!shas.length) return new Map();
  const out = new Map();
  for (let i = 0; i < shas.length; i += PATCH_BATCH) {
    const batch = shas.slice(i, i + PATCH_BATCH);
    const text = git(repoRoot, [
      'show', '--unified=0', '--no-color', '--no-renames', '--first-parent',
      `--format=${RS}%H`, ...batch,
    ], { maxBuffer: MAX_PATCH_BYTES });
    for (const [sha, c] of parsePatches(text)) out.set(sha, c);
  }
  return out;
}

// The exact question the anchor needs: is the file at this commit byte-identical to the file at
// HEAD? If it is, the patch's post-image line numbers ARE current line numbers and resolving them
// against the graph is exact rather than a guess. One process for the whole window.
function blobIdentity(repoRoot, pairs) {
  const seen = new Set();
  const queries = [];
  for (const [sha, path] of pairs) {
    for (const spec of [`${sha}:${path}`, `HEAD:${path}`]) {
      if (seen.has(spec)) continue;
      seen.add(spec);
      queries.push(spec);
    }
  }
  const oids = new Map();
  if (!queries.length) return oids;
  const text = spawnSync('git', ['-C', repoRoot, 'cat-file', '--batch-check=%(objectname)'], {
    encoding: 'utf8', input: `${queries.join('\n')}\n`, maxBuffer: 64 * 1024 * 1024,
  });
  if (text.status !== 0) return oids;
  const lines = String(text.stdout || '').split('\n');
  for (let i = 0; i < queries.length && i < lines.length; i++) {
    const v = lines[i].trim();
    oids.set(queries[i], /^[0-9a-f]{40,}$/.test(v) ? v : null);
  }
  return oids;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function resolvable(repoRoot, shas) {
  if (!shas.length) return [];
  const r = spawnSync('git', ['-C', repoRoot, 'cat-file', '--batch-check=%(objectname)'], {
    encoding: 'utf8', input: `${shas.join('\n')}\n`, maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0) return [];
  const lines = String(r.stdout || '').split('\n');
  return shas.filter((_, i) => /^[0-9a-f]{40,}$/.test(String(lines[i] || '').trim()));
}

function dirtyFiles(repoRoot) {
  const r = spawnSync('git', ['-C', repoRoot, 'diff', '--name-only', 'HEAD'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) return new Set();
  return new Set(String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean));
}

// Everything the seeding pass needs, in one read-only sweep. Nothing here touches a database.
function scanHistory(repoRoot, { since = null, limit = DEFAULT_LIMIT, maxFiles = MAX_FILES } = {}) {
  if (!isGitRepo(repoRoot)) throw new Error(`not a git repository: ${repoRoot}`);

  const skipped = { merge: 0, too_many_files: 0, no_files: 0, not_fix_shaped: 0, no_patch: 0 };
  const eligible = [];
  let scanned = 0;

  for (const c of streamLog(repoRoot, { since, limit })) {
    scanned++;
    if (c.parents.length > 1) { skipped.merge++; continue; }
    if (!c.files.length) { skipped.no_files++; continue; }
    if (c.files.length > maxFiles) { skipped.too_many_files++; continue; }
    const cls = classifyCommit(c);
    eligible.push({
      sha: c.sha, date: c.date, subject: c.subject, body: c.body,
      reverted_sha: revertedShaOf(c.body),
      fixShaped: cls.fixShaped, kind: cls.kind || null, rule: cls.rule,
    });
  }

  const patches = fetchPatches(repoRoot, eligible.map((c) => c.sha));

  // Walking newest-first, a commit whose FORWARD patch equals an already-seen REVERSE patch is the
  // one that was undone; the commit already in the table is the one that undid it. `undoes` is
  // keyed the way the fact reads — reverter → what it reverted — so the fact anchors on the code
  // as it stands after the revert, not on lines that no longer exist.
  const byRev = new Map();
  const undoes = new Map();
  for (const c of eligible) {
    const p = patches.get(c.sha);
    if (!p || !p.files.length || !p.has_content) continue;
    const { fwd, rev } = patchHashes(p.files);
    const reverter = byRev.get(fwd);
    if (reverter) undoes.set(reverter, c.sha);
    if (!byRev.has(rev)) byRev.set(rev, c.sha);
  }

  const selected = [];
  for (const c of eligible) {
    const p = patches.get(c.sha);
    if (!p || !p.files.length) { if (c.fixShaped) skipped.no_patch++; continue; }
    const undone = undoes.get(c.sha) || null;
    if (undone && !c.fixShaped) {
      c.fixShaped = true;
      c.kind = 'revert';
      c.rule = 'revert_inverse';
    }
    if (undone && c.kind === 'revert') c.reverted_sha = c.reverted_sha || undone;
    if (!c.fixShaped) { skipped.not_fix_shaped++; continue; }

    selected.push({
      ...c,
      files: p.files.map((f) => ({ path: f.path, hunks: f.hunks })),
    });
  }

  // What the reverted commit was, for the fact body. Most are inside the window; the rest cost one
  // extra `git show -s` for the whole set.
  const subjects = new Map(eligible.map((c) => [c.sha, c.subject]));
  const wanted = [...new Set(selected.map((c) => c.reverted_sha).filter((s) => s && !subjects.has(s)))];
  // `This reverts commit <sha>` names a commit that may have been rewritten out of this history, and
  // one unknown sha makes `git show` exit non-zero and print nothing for the whole batch. cat-file
  // reports per line and never fails, so the batch is filtered before it is asked for.
  for (const batch of chunk(resolvable(repoRoot, wanted), PATCH_BATCH)) {
    const r = spawnSync('git', ['-C', repoRoot, 'show', '-s', `--format=%H${US}%s`, ...batch], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    for (const line of String(r.stdout || '').split('\n')) {
      const [sha, subject] = line.split(US);
      if (sha && subject) subjects.set(sha, subject);
    }
  }
  for (const c of selected) {
    c.reverted_subject = c.reverted_sha
      ? (subjects.get(c.reverted_sha)
        || [...subjects.keys()].filter((k) => k.startsWith(c.reverted_sha)).map((k) => subjects.get(k))[0]
        || null)
      : null;
  }

  const pairs = [];
  for (const c of selected) for (const f of c.files) pairs.push([c.sha, f.path]);
  const oids = blobIdentity(repoRoot, pairs);
  const dirty = dirtyFiles(repoRoot);

  for (const c of selected) {
    for (const f of c.files) {
      const atCommit = oids.get(`${c.sha}:${f.path}`) || null;
      const atHead = oids.get(`HEAD:${f.path}`) || null;
      f.exists_at_head = atHead !== null;
      f.unchanged_since = Boolean(atCommit && atHead && atCommit === atHead && !dirty.has(f.path));
    }
  }

  return { commits: selected, scanned, skipped, repoRoot };
}

module.exports = {
  scanHistory, classifyCommit, revertedShaOf, parseLogPage, parsePatches, patchHashes,
  blobIdentity, identifiersIn, isGitRepo, git,
  DEFAULT_LIMIT, MAX_FILES, PAGE, FIX_KEYWORDS, RS, US,
};
