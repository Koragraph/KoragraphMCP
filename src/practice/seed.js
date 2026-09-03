'use strict';

const path = require('path');
const { scanHistory, identifiersIn, DEFAULT_LIMIT } = require('./git-history');
const { promoteLessons } = require('./promote');
const { repoIdentity, repoNameOf } = require('./repo-identity');
const { resolveBranch, resolveFileId, fileDeclarations } = require('./resolve');
const { indexErrors } = require('./error-index');
const { redactSecrets } = require('./untrusted');

// The pass that makes the product knowledgeable on install day. Live capture needs a year to reach
// what `git log` already holds, and a memory product that is empty for a year is dead on install.
//
// Every fact here is `observation` with a commit sha in its evidence — checkable with `git show`,
// never a verdict. Nothing here is a `law`; nobody stated any of it.

const BODY_MAX = 180;
const HAZARD_MIN_FIXES = 2;

// Whether a path could hold a DECLARATION at all, decided without the graph.
//
// This is the no-graph twin of the `no_declarations` guard in targetsFor. That guard is correct and
// it is the only thing standing between this pass and junk — but it can only run when a graph
// handle resolves the file, and **no graph is the default state on a fresh install**: a user runs
// `koragraph practice seed` before, or instead of, `koragraph ingest`. Without this guard the pass
// mints facts about markdown session documents and `.env.example` — including hazards claiming a
// doc "has needed N separate fixes", a claim about the future made about a session document. The
// first thing the product ever says to a user cannot be that.
//
// An ALLOW-list, not a deny-list: refusing markdown and `.env` still admits `.txt`, `.csv`, `.svg`
// and every lockfile. The set is the union of ast-extractor.js's EXT_TO_AST_LANG and
// EXT_TO_GRAMMAR — the extensions this product can actually extract a declaration from. It lives in
// its own dependency-free module because the live fail→fix path needs the same guard and runs on a
// hook, where requiring this file (and so resolve.js, and so graph.db) is forbidden.
const { SOURCE_EXTS, isSourcePath } = require('./source-paths');

// A hunk's post-image range is only a current line range if the file has not changed since. When it
// has, the line numbers are archaeology and resolving them against today's graph anchors the fact
// to whatever happens to occupy those lines now. That is the SZZ leak in miniature and it is the
// single largest precision risk in this pass, so the two cases are separated rather than blended.
const RESOLUTION = Object.freeze(['line', 'name', 'file']);

// Redacted at WRITE time, not only at render: practice.db is durable and irreplaceable, and
// a commit subject that quotes a credential — `fix: rotate AWS_SECRET_ACCESS_KEY=…` — would
// otherwise sit in it forever.
function truncate(text, max = BODY_MAX) {
  const s = redactSecrets(String(text || '')).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// The fact is anchored on the REVERTING commit, so the body names what was undone, not the
// reverting commit's own subject — "Revert "Bump x to y"" tells a reader nothing they can act on.
function bodyFor(commit) {
  if (commit.kind === 'revert') {
    const what = commit.reverted_subject
      || commit.subject.replace(/^Revert\s+"?/, '').replace(/"$/, '');
    const undone = commit.reverted_sha ? ` (${commit.reverted_sha.slice(0, 8)})` : '';
    return truncate(`Tried here and reverted: ${what}${undone}`);
  }
  return truncate(`Fixed here: ${commit.subject}`);
}

// A fix modifies code that already existed, so a file the commit CREATED was not fixed by it. git
// says so exactly: under `-U0` a new file is one hunk reading `@@ -0,0 +1,N @@`.
//
// Rule-independent on purpose — this is the SZZ premise, not a property of any one fix rule. A fix
// commit that only ADDS a file (e.g. a new test at +N/-0) minted a fact about a file it created,
// which the `@@ -0,0` guard above now excludes.
//
// The broader test — "some hunk replaces a line" — is rejected: it drops real fixes implemented
// purely by adding lines (a bug fixed by adding a guard in a new branch). Refusing a created file
// costs far fewer, and every one of those is a file that did not exist to be wrong.
function existedBeforeCommit(hunks) {
  if (!Array.isArray(hunks) || hunks.length === 0) return false;
  const created = hunks.length === 1 && hunks[0].old_start === 0 && (hunks[0].old_lines || 0) === 0;
  return !created;
}

// The graph is derived and may be absent, stale, or hold a different repo. Every failure to resolve
// downgrades the anchor; none of them throws, and none of them drops the fact.
function branchFor(graphDb, repoId, repoRoot = null) {
  if (!graphDb) return null;
  try {
    return resolveBranch(graphDb, { repoId, repoName: repoNameOf(repoId), repoRoot });
  } catch {
    return null;
  }
}

// The name path. git's hunk header carries the enclosing declaration as of THAT commit, extracted
// by git's own funcname rule — mechanical, not a guess. If that name is still a declaration in the
// file today, the anchor is a name match rather than a line match, and it needs no line arithmetic
// across the intervening history.
function nameMatch(decls, hunks) {
  const byName = new Map();
  for (const d of decls) {
    if (!byName.has(d.name)) byName.set(d.name, d);
  }
  const hits = new Map();
  for (const h of hunks) {
    // The FIRST identifier only — the name being declared on that header line. Taking every
    // identifier anchored a hunk under `const GRAMMAR_ALIAS = { csharp: …, objc: … }` to a METHOD
    // called `objc` elsewhere in the file, which is a false statement about the code.
    const [declared] = identifiersIn(h.funcname);
    const d = declared ? byName.get(declared) : null;
    if (!d) continue;
    // A declaration cannot contain a change larger than itself. git's funcname for a hunk that
    // FOLLOWS a one-line declaration is that declaration, which is how a 38-line hunk came to be
    // anchored to a single-line constant.
    if ((d.end_line - d.start_line + 1) < Math.max(1, h.new_lines || 1)) continue;
    hits.set(d.name, d);
  }
  return [...hits.values()];
}

// One target per hunk on the line path, so two hunks 900 lines apart do not resolve as one range
// spanning everything between them. promote.js#fixRange takes min..max across a target's hunks and
// that is right for one edit call, wrong for one commit.
//
// Returns the reason as well as the targets: a skip that cannot say why it happened is not a
// measurement, and the per-reason counts are how a rule's precision gets audited.
function targetsFor(commit, file, { graphDb, branch }) {
  const repoId = commit.repo_id;
  const repoRoot = commit.repo_root;
  const fileGrain = [{ file_path: file.path, repo_id: repoId, repo_root: repoRoot, resolution: 'file' }];
  if (!file.exists_at_head) return { targets: [], reason: 'file_gone' };
  // Before the graph is consulted, not after: the two branches below both fall through to
  // file-grain when the graph cannot answer, and that fall-through is what let documentation
  // through. Applying it here makes the with-graph and without-graph paths agree.
  if (!isSourcePath(file.path)) return { targets: [], reason: 'not_source' };
  if (!existedBeforeCommit(file.hunks)) return { targets: [], reason: 'file_created_here' };
  if (!branch || !graphDb) return { targets: fileGrain, reason: null };

  let fileId = null;
  try { fileId = resolveFileId(graphDb, branch.branchId, file.path); } catch { fileId = null; }
  if (!fileId) return { targets: fileGrain, reason: null };

  let decls = [];
  try { decls = fileDeclarations(graphDb, branch.branchId, fileId); } catch { decls = []; }
  // A file the code graph holds no declaration for is not code this product can teach about. This
  // is the one guard that removed real junk here: `fix_keyword` fires on "Handoff: 2.5 fixed, and
  // correct the diagnosis it recorded", a documentation commit, and the only thing such a fact can
  // ever say is "this markdown file was fixed once". It costs a config-file fix (.env.example) and
  // it is worth it — a wrong memory is worse than no memory. Skipped, never silently downgraded.
  if (!decls.length) return { targets: [], reason: 'no_declarations' };

  if (file.unchanged_since) {
    const out = [];
    for (const h of file.hunks) {
      if (!h.new_lines) continue;   // a pure deletion has no post-image to anchor to
      out.push({
        file_path: file.path,
        repo_id: repoId,
        repo_root: repoRoot,
        start_line: h.new_start,
        end_line: h.new_start + h.new_lines - 1,
        resolution: 'line',
      });
    }
    return { targets: out.length ? out : fileGrain, reason: null };
  }

  const matched = nameMatch(decls, file.hunks);
  if (!matched.length) return { targets: fileGrain, reason: null };
  // The declaration's own start line, not its span: resolveSymbols over a whole span returns the
  // nested declarations inside it and `anchorable` then drops the one we actually matched.
  return {
    targets: matched.map((d) => ({
      file_path: file.path,
      repo_id: repoId,
      repo_root: repoRoot,
      start_line: d.start_line,
      end_line: d.start_line,
      resolution: 'name',
    })),
    reason: null,
  };
}

function evidenceFor(commit, file, targets) {
  return {
    source: 'git-history',
    rule: commit.rule,
    commit: commit.sha,
    subject: redactSecrets(commit.subject),
    author_date: commit.date,
    file: file.path,
    hunks: file.hunks.length,
    reverted_commit: commit.reverted_sha || null,
    reverted_subject: commit.reverted_subject ? redactSecrets(commit.reverted_subject) : null,
    // Which of the three anchoring routes produced this. A reader auditing precision needs to know
    // whether the anchor came from exact line numbers or from a name that merely still exists.
    resolution: [...new Set(targets.map((t) => t.resolution))].filter((r) => RESOLUTION.includes(r)),
    checkable: `git show ${commit.sha}`,
  };
}

const SEEDED = 'SELECT fact_id FROM history_seeds WHERE repo_id = ? AND commit_sha = ? AND rule = ? AND anchor_key = ?';
const RECORD_SEED = `INSERT OR IGNORE INTO history_seeds
  (repo_id, commit_sha, rule, anchor_key, fact_id, seeded_at) VALUES (?, ?, ?, ?, ?, ?)`;

const HAZARD_SQL = `
SELECT a.file_path, COALESCE(a.symbol_name, '') AS symbol_name,
       COUNT(DISTINCT json_extract(f.evidence, '$.commit')) AS fixes,
       MAX(f.valid_at) AS last_fix_at,
       group_concat(DISTINCT substr(json_extract(f.evidence, '$.commit'), 1, 8)) AS shas
  FROM anchors a
  JOIN facts f ON f.id = a.fact_id
 WHERE a.repo_id = ?
   AND f.source = 'seed'
   AND f.kind = 'correction'
   AND f.expired_at IS NULL
   AND json_extract(f.evidence, '$.commit') IS NOT NULL
 GROUP BY a.file_path, COALESCE(a.symbol_name, '')
HAVING fixes >= ?`;

// Fix-after-fix. The same declaration needing two or more separate fixes is a hazard, and a hazard
// is worth more than either fix on its own: it is the only thing in this pass that says "expect
// trouble here" rather than "this once went wrong".
function seedHazards(practiceDb, graphDb, { repoId, repoRoot, branch, minFixes, now }) {
  const groups = practiceDb.prepare(HAZARD_SQL).all(repoId, minFixes);
  const seeded = practiceDb.prepare(SEEDED);
  const record = practiceDb.prepare(RECORD_SEED);
  const dropSeed = practiceDb.prepare(
    'DELETE FROM history_seeds WHERE repo_id = ? AND commit_sha = ? AND rule = ? AND anchor_key = ?',
  );
  const expire = practiceDb.prepare(
    "UPDATE facts SET expired_at = ?, expiry_reason = 'superseded' WHERE id = ? AND expired_at IS NULL",
  );
  const recurrenceOf = practiceDb.prepare('SELECT recurrence FROM facts WHERE id = ?');

  const lessons = [];
  for (const g of groups) {
    const anchorKey = `${g.file_path}\x00${g.symbol_name}`;
    const prior = seeded.get(repoId, '', 'fix_after_fix', anchorKey);
    if (prior) {
      const row = recurrenceOf.get(prior.fact_id);
      if (row && row.recurrence === g.fixes) continue;
      // The count moved. The old statement is not wrong, it is out of date — expire it with the
      // reason the schema has for exactly this and state the new count.
      expire.run(now.toISOString(), prior.fact_id);
      dropSeed.run(repoId, '', 'fix_after_fix', anchorKey);
    }

    let target = { file_path: g.file_path, repo_id: repoId, repo_root: repoRoot, resolution: 'file' };
    if (g.symbol_name && branch && graphDb) {
      const fileId = resolveFileId(graphDb, branch.branchId, g.file_path);
      const decl = fileId
        ? fileDeclarations(graphDb, branch.branchId, fileId).find((d) => d.name === g.symbol_name)
        : null;
      if (decl) {
        target = {
          file_path: g.file_path, repo_id: repoId, repo_root: repoRoot,
          start_line: decl.start_line, end_line: decl.start_line, resolution: 'name',
        };
      }
    }

    const where = g.symbol_name ? `${g.symbol_name} (${g.file_path})` : g.file_path;
    lessons.push({
      kind: 'hazard',
      tier: 'observation',
      source: 'seed',
      recurrence: g.fixes,
      body: truncate(`Recurring trouble: ${where} has needed ${g.fixes} separate fixes`),
      // World time is the date of the most recent contributing fix, not the date of this pass.
      passed_at: g.last_fix_at || null,
      evidence: {
        source: 'git-history',
        rule: 'fix_after_fix',
        commits: String(g.shas || '').split(',').filter(Boolean),
        fixes: g.fixes,
        checkable: `git log --oneline -- ${g.file_path}`,
      },
      targets: [target],
    });
  }

  if (!lessons.length) return { factIds: [] };
  const { factIds } = promoteLessons(practiceDb, graphDb, lessons, { now, source: 'seed' });
  // promoteLessons drops a lesson whose targets produced no anchor, so the two arrays only line up
  // when nothing was dropped. Re-derive the mapping from the anchors it actually wrote.
  const anchorOf = practiceDb.prepare(
    "SELECT file_path, COALESCE(symbol_name,'') AS symbol_name FROM anchors WHERE fact_id = ? LIMIT 1",
  );
  for (const id of factIds) {
    const a = anchorOf.get(id);
    if (!a) continue;
    record.run(repoId, '', 'fix_after_fix', `${a.file_path}\x00${a.symbol_name}`, id, now.toISOString());
  }
  return { factIds };
}

// Injected so a caller can route it; the default reaches the user, because this pass is only ever
// invoked from `koragraph practice seed` and a silent degrade is the thing being fixed.
const defaultWarn = (message) => process.stderr.write(message);

function seedFromHistory(practiceDb, graphDb, {
  repoRoot = process.cwd(), repoId = null, since = null, limit = DEFAULT_LIMIT,
  minFixes = HAZARD_MIN_FIXES, now = new Date(), indexErrorStrings = true, warn = defaultWarn,
} = {}) {
  const identity = repoIdentity(repoRoot);
  const root = identity.repoRoot || repoRoot;
  const id = repoId || identity.repoId;
  if (!id) throw new Error(`seed: no repository identity for ${repoRoot}`);

  const scan = scanHistory(root, { since, limit });
  // Pass the ORIGINAL ingest root, not the git-root-promoted `root` above: `resolveBranch`'s
  // strongest match (`byRoot`) compares against `repositories.full_path`, which ingest.js binds to
  // the actual ingest path — a monorepo subdirectory, not the enclosing checkout. Without this the
  // repo-identity fallback (`repoNameOf(identity.repoId)`, derived from the promoted root's
  // basename) is the only thing branchFor can try, and it names the wrong directory whenever the
  // ingest root is a subdirectory — the branch is never found and every fact silently downgrades to
  // file grain, on top of the separate path-rebasing bug this same investigation found.
  const branch = branchFor(graphDb, id, path.resolve(repoRoot));

  // `identity.repoRoot` promotes to the enclosing git checkout so history-scanning sees the real
  // repository, but `git log --name-only` from there reports paths relative to THAT root, while the
  // graph (ingested at `repoRoot`, which can be a subdirectory of it — a monorepo workspace) stores
  // paths relative to `repoRoot`. Left unrebased, `resolveFileId` never matches, every fact anchors
  // at file grain, and the file-grain anchor itself is wrong (git-root-relative, not
  // ingest-root-relative) — the same class of bug fixed in cochange-miner.js and
  // ingest.js#rebaseDiffToIngestRoot, here on the seeding path instead of incremental re-ingest.
  const ingestRoot = path.resolve(repoRoot);
  const toIngestRelative = (root && path.resolve(root) !== ingestRoot)
    ? (p) => {
      const rel = path.relative(ingestRoot, path.resolve(root, p));
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
      return rel.split(path.sep).join('/');
    }
    : (p) => p;

  // Not a footnote. Without a resolved graph every fact anchors to a FILE, which means it cannot
  // follow a rename, cannot drift when one function is rewritten, and cannot annotate a
  // declaration on the MCP surface. That is a materially weaker product and the user is entitled
  // to know before they read the output, not after.
  const warnings = [];
  if (!branch) {
    warnings.push(graphDb
      ? `No ingested graph for ${id} — every fact will anchor to a file, not a declaration.`
        + ' Run `koragraph ingest <path>` and re-run this to upgrade them.'
      : 'No code graph is open — every fact will anchor to a file, not a declaration.'
        + ' Run `koragraph ingest <path>` and re-run this to upgrade them.');
  }
  for (const w of warnings) if (typeof warn === 'function') warn(`${w}\n`);

  const seeded = practiceDb.prepare(SEEDED);
  const record = practiceDb.prepare(RECORD_SEED);

  const lessons = [];
  const pending = new Map();
  const skipped = {
    ...scan.skipped,
    already_seeded: 0, file_gone: 0, not_source: 0, file_created_here: 0,
    no_declarations: 0, no_target: 0, out_of_scope: 0,
  };
  const byRule = {};

  for (const commit of scan.commits) {
    commit.repo_id = id;
    commit.repo_root = ingestRoot;
    for (const rawFile of commit.files) {
      if (!rawFile.exists_at_head) { skipped.file_gone++; continue; }
      const ingestPath = toIngestRelative(rawFile.path);
      if (ingestPath === null) { skipped.out_of_scope++; continue; }
      const file = ingestPath === rawFile.path ? rawFile : { ...rawFile, path: ingestPath };
      if (seeded.get(id, commit.sha, commit.rule, file.path)) { skipped.already_seeded++; continue; }
      const { targets, reason } = targetsFor(commit, file, { graphDb, branch });
      if (!targets.length) { skipped[reason || 'no_target']++; continue; }
      lessons.push({
        kind: commit.kind,
        tier: 'observation',
        source: 'seed',
        recurrence: 1,
        body: bodyFor(commit),
        passed_at: commit.date,
        evidence: evidenceFor(commit, file, targets),
        targets,
      });
      pending.set(`${commit.sha}\x00${file.path}`, { commit, file });
    }
  }

  const write = practiceDb.transaction(() => {
    const { factIds } = promoteLessons(practiceDb, graphDb, lessons, { now, source: 'seed' });
    // promoteLessons skips a lesson with no anchors, so the returned ids are a SUBSET of `lessons`
    // in order. Walk both, matching on the fact's own evidence, rather than assuming 1:1.
    const evidenceOf = practiceDb.prepare('SELECT evidence FROM facts WHERE id = ?');
    const anchorsOf = practiceDb.prepare('SELECT file_path, symbol_name FROM anchors WHERE fact_id = ?');
    for (const factId of factIds) {
      let ev;
      try { ev = JSON.parse(evidenceOf.get(factId).evidence); } catch { continue; }
      if (!ev || !ev.commit || !ev.file) continue;
      record.run(id, ev.commit, ev.rule, ev.file, factId, now.toISOString());
      byRule[ev.rule] = (byRule[ev.rule] || 0) + 1;
      if (!indexErrorStrings) continue;
      const hit = pending.get(`${ev.commit}\x00${ev.file}`);
      if (!hit) continue;
      indexErrors(practiceDb, {
        repoId: id,
        message: `${hit.commit.subject}\n${hit.commit.body}`,
        anchors: anchorsOf.all(factId),
        factId,
        source: 'commit',
        seenAt: hit.commit.date,
      });
    }
    return factIds;
  });

  const factIds = write();
  const hazards = seedHazards(practiceDb, graphDb, { repoId: id, repoRoot: ingestRoot, branch, minFixes, now });
  if (hazards.factIds.length) byRule.fix_after_fix = hazards.factIds.length;

  const all = [...factIds, ...hazards.factIds];
  // `skipped` counts two different populations — commits the scan refused, and files inside the
  // surviving commits. Summing them produced "40 scanned, 40 skipped" beside "8 facts", which reads
  // as nothing happened. Report the two separately; `skipped` stays the total for compatibility.
  const commitsSkipped = Object.keys(scan.skipped).reduce((n, k) => n + skipped[k], 0);
  return {
    warnings,
    factIds: all,
    scanned: scan.scanned,
    commitsSkipped,
    commitsUsed: scan.scanned - commitsSkipped,
    filesSkipped: Object.values(skipped).reduce((a, b) => a + b, 0) - commitsSkipped,
    skipped: Object.values(skipped).reduce((a, b) => a + b, 0),
    skippedByReason: skipped,
    factsByRule: byRule,
    repoId: id,
    repoRoot: root,
    graphResolved: Boolean(branch),
  };
}

module.exports = {
  seedFromHistory, seedHazards, targetsFor, nameMatch, bodyFor, isSourcePath, existedBeforeCommit,
  HAZARD_MIN_FIXES, SOURCE_EXTS,
};
