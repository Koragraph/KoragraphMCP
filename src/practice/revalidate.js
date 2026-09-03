'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { resolveBranch, resolveFileId, fileDeclarations } = require('./resolve');

function gitHeadSha(repoRoot) {
  if (!repoRoot) return null;
  try {
    const r = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    return (r.stdout || '').trim() || null;
  } catch { return null; }
}

// True ONLY with positive evidence the working tree is not at the indexed commit: the graph's
// last_commit_sha and the checkout's HEAD are both known and differ. Unknown on either side is NOT
// divergence — the same conservatism the per-file file_sha guard uses, so an anchor we cannot check
// never expires. This is the branch-grain analogue of that guard: revalidate runs over every fact
// on every ingest of ANY repo, so when repo A is edited-and-committed but not re-ingested, checking
// A's facts during an ingest of repo B reads a graph that is behind A's disk — and a symbol that
// only "moved" or "vanished" in the stale index is not evidence of falsity. Memoised per branch.
function branchDiverged(graphDb, branch) {
  if (branch._diverged !== undefined) return branch._diverged;
  let indexed = null;
  try {
    indexed = graphDb.prepare('SELECT last_commit_sha FROM repository_branches WHERE id = ?')
      .get(branch.branchId)?.last_commit_sha || null;
  } catch { indexed = null; }
  const head = gitHeadSha(branch.repoRoot);
  branch._diverged = !!(indexed && head && indexed !== head);
  return branch._diverged;
}

// movedVerdict decides 'orphaned'/'moved' from the GRAPH alone. When the index is behind disk, a
// symbol still present on disk can look gone — so an orphan verdict is only earned when the index
// is current. Divergence downgrades it to unknown, never expiry.
function moved(graphDb, branch, anchor) {
  const v = movedVerdict(graphDb, branch, anchor);
  if (v.verdict === 'orphaned' && branchDiverged(graphDb, branch)) {
    return { verdict: 'unknown', reason: 'symbol gone from a stale index — working tree is ahead of the indexed commit' };
  }
  return v;
}

function fileIndexStatus(graphDb, fileId) {
  try {
    const row = graphDb.prepare('SELECT index_status FROM files WHERE id = ?').get(fileId);
    return row ? row.index_status : null;
  } catch (_) {
    return null;
  }
}

// The content hash the graph recorded for a file at ingest, and the same hash computed from the
// working tree now. ingest.js writes `files.file_sha = sha256(content).hex.slice(0,40)`; matching
// that exactly is what lets the drift path tell "the working tree IS the indexed commit" (a real
// body edit that was re-ingested) from "the working tree has moved on and the graph is stale" (an
// uncommitted edit, a different checkout) — in which case reading the GRAPH's line-spans off DISK
// returns unrelated code and must never be read as drift.
function graphFileSha(graphDb, fileId) {
  try {
    const row = graphDb.prepare('SELECT file_sha FROM files WHERE id = ?').get(fileId);
    return row ? row.file_sha : null;
  } catch (_) {
    return null;
  }
}

function diskFileSha(repoRoot, filePath) {
  if (!repoRoot) return null;
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(repoRoot, filePath)))
      .digest('hex').slice(0, 40);
  } catch (_) {
    return null;
  }
}
const { repoNameOf } = require('./repo-identity');
const { fingerprint, sketch, similarity } = require('./fingerprint');
const { readSpan } = require('./promote');

// The moat. Everyone can store "pooling was wrong here"; nobody else notices when the function it
// was about got renamed, moved or deleted.
//
// The load-bearing rule is the one that says nothing: an anchor we cannot CHECK is `unknown`, and
// unknown never expires a fact. A repository missing from the graph, a checkout that has moved, a
// file not yet ingested — all of those look exactly like deletion if you only ask the graph. A
// memory product that forgets whenever its index is stale is worse than one that never forgets.

// Re-resolution after a rename. A rename alone scores high and unrelated code near zero, so the
// threshold has room; a rename PLUS a body edit on a four-line function falls below it and will
// NOT re-resolve. That case orphans, which is the safe direction: a fact about code that changed
// twice is a fact worth losing.
const RENAME_MIN_SIMILARITY = 0.5;
const RENAME_DOMINANCE = 1.5;

// null means "cannot tell", which is NOT the same as "gone" — the whole expiry mechanism turns on
// that distinction. `repositories.full_path` records where the repository was when it was
// ingested; if that directory is no longer there, every file under it reads as deleted and every
// fact about the repository expires in one pass. So the root is checked before the file.
function fileExistsOnDisk(repoRoot, filePath) {
  if (!repoRoot) return null;
  if (!fs.existsSync(repoRoot)) return null;
  return fs.existsSync(path.join(repoRoot, filePath));
}

function currentBody(repoRoot, filePath, node) {
  if (!repoRoot) return null;
  return readSpan(path.join(repoRoot, filePath), node.start_line, node.end_line);
}

function bestRenameCandidate(anchor, decls, repoRoot) {
  let stored;
  try { stored = JSON.parse(anchor.body_sketch || '[]'); } catch { stored = []; }
  if (!stored.length) return null;

  const scored = [];
  for (const d of decls) {
    // A kind change (METHOD → CLASS) is not a rename of the same thing.
    if (anchor.symbol_kind && d.node_type !== anchor.symbol_kind) continue;
    const body = currentBody(repoRoot, anchor.file_path, d);
    if (!body) continue;
    scored.push({ decl: d, score: similarity(stored, sketch(body)), body });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || a.decl.start_line - b.decl.start_line);

  const [best, runnerUp] = scored;
  if (best.score < RENAME_MIN_SIMILARITY) return null;
  // Dominance, not just a threshold: a file of near-identical accessors would otherwise let any of
  // them claim the anchor, and a confident wrong re-resolution is worse than an orphan.
  if (runnerUp && runnerUp.score > 0 && best.score < runnerUp.score * RENAME_DOMINANCE) return null;
  return best;
}

const BRANCH_WIDE_SQL = `
SELECT n.node_type, n.name, n.start_line, n.end_line, f.path AS file_path
  FROM nodes n
  JOIN files f ON f.id = n.file_id
 WHERE n.repository_branch_id = ?
   AND n.approval_status = 'APPROVED'
   AND n.name = ?
   AND n.start_line IS NOT NULL AND n.end_line IS NOT NULL
   AND f.path <> ?`;

// The file is gone; is the SYMBOL? Routing "file gone" straight to `orphaned` would treat the
// path — the most volatile coordinate in a repository — as the fact's identity: a repo that moves
// `requests/` -> `src/requests/`, or a `git mv` of a byte-identical file, would expire every fact
// whose symbol still exists.
//
// So the orphan verdict requires positive evidence: the symbol absent from the WHOLE branch.
// If it exists elsewhere, the same guards the in-file rename path uses decide — an exact
// fingerprint match is a pure move and follows immediately; otherwise sketch similarity with the
// dominance rule, because re-anchoring to the wrong `get` in another file is worse than an
// orphan. Can't tell which one? `unknown`, never `orphaned`: a fact wrongly kept is visible and
// forgettable, a fact wrongly dropped is invisible forever.
function findMovedDeclaration(graphDb, branch, anchor) {
  if (!anchor.symbol_name) return null;
  let rows;
  try {
    rows = graphDb.prepare(BRANCH_WIDE_SQL).all(branch.branchId, anchor.symbol_name, anchor.file_path);
  } catch { return null; }
  const decls = rows.filter((d) => !anchor.symbol_kind || d.node_type === anchor.symbol_kind);
  if (!decls.length) return null;                       // genuinely gone: orphan is now earned

  let stored;
  try { stored = JSON.parse(anchor.body_sketch || '[]'); } catch { stored = []; }

  const scored = [];
  for (const d of decls) {
    const body = currentBody(branch.repoRoot, d.file_path, d);
    if (!body) continue;
    if (anchor.body_fingerprint && fingerprint(body) === anchor.body_fingerprint) {
      return { decl: d, body, score: 1 };               // byte-identical: a pure move
    }
    if (stored.length) scored.push({ decl: d, score: similarity(stored, sketch(body)), body });
  }
  if (!scored.length) return { ambiguous: true };
  scored.sort((a, b) => b.score - a.score || a.decl.file_path.localeCompare(b.decl.file_path));
  const [best, runnerUp] = scored;
  if (best.score < RENAME_MIN_SIMILARITY) return { ambiguous: true };
  if (runnerUp && runnerUp.score > 0 && best.score < runnerUp.score * RENAME_DOMINANCE) {
    return { ambiguous: true };
  }
  return best;
}

function movedVerdict(graphDb, branch, anchor) {
  const hit = findMovedDeclaration(graphDb, branch, anchor);
  if (!hit) return { verdict: 'orphaned', reason: 'symbol gone from the whole graph' };
  if (hit.ambiguous) {
    return { verdict: 'unknown', reason: 'file gone but the symbol exists elsewhere — cannot pick the new home' };
  }
  return {
    verdict: 'moved',
    node: hit.decl,
    similarity: hit.score,
    refresh: {
      file_path: hit.decl.file_path,
      body_fingerprint: fingerprint(hit.body),
      body_sketch: JSON.stringify(sketch(hit.body)),
    },
  };
}

// One anchor → one verdict. Verdicts that keep a fact alive: ok, unconfirmed, renamed, moved, unknown.
function checkAnchor(anchor, { graphDb, branchCache, suppressRename = false }) {
  if (!graphDb) return { verdict: 'unknown', reason: 'no code graph' };

  let branch = branchCache.get(anchor.repo_id);
  if (branch === undefined) {
    branch = resolveBranch(graphDb, {
      repoId: anchor.repo_id, repoName: repoNameOf(anchor.repo_id),
    });
    branchCache.set(anchor.repo_id, branch);
  }
  if (!branch) return { verdict: 'unknown', reason: 'repository not in the graph' };

  // A repo-grain anchor (009) carries file_path = '' and no symbol, so every check below is about
  // something it does not have. Its one claim is "this repository exists", and `branch` above IS
  // that claim — so the only two verdicts it can reach are this one and the `unknown` above, and a
  // repository genuinely removed still reads unknown because a deleted graph.db, a repo never
  // ingested and a moved checkout are indistinguishable from it. That is the answer we want:
  // stated laws are most of what this grain holds, and expiring one is worse than never checking.
  //
  // It survived the file path by accident, not by design: path.join(root, '') is root, so `onDisk`
  // was always true and the empty path always missed `files`, landing on "not yet in the graph".
  // Both are incidental, and both sit upstream of an `orphaned`.
  if (anchor.grain === 'repo') return { verdict: 'ok' };

  const repoRoot = branch.repoRoot;
  const onDisk = fileExistsOnDisk(repoRoot, anchor.file_path);
  const fileId = resolveFileId(graphDb, branch.branchId, anchor.file_path);

  if (!fileId) {
    // Absent from the graph but present on disk is graph incompleteness, not deletion. Expiring
    // here would forget a fact every time a file had not been re-ingested yet.
    if (onDisk === null) return { verdict: 'unknown', reason: 'checkout location unknown' };
    if (onDisk) return { verdict: 'unknown', reason: 'file not yet in the graph' };
    if (anchor.grain === 'symbol') return moved(graphDb, branch, anchor);
    if (branchDiverged(graphDb, branch)) return { verdict: 'unknown', reason: 'file gone from a stale index — working tree is ahead of the indexed commit' };
    return { verdict: 'orphaned', reason: 'file no longer exists' };
  }

  // `resolveFileId`'s exact-path match does not filter on index_status, so a RENAMED or DELETED
  // file's row — archived, not deleted, per this store's own convention — still resolves a fileId
  // for its OLD path, and this branch used to return 'ok' unconditionally on that alone. Every
  // file-grain fact anchored here (any rule naming a file with no more specific symbol — a common,
  // ordinary anchor shape) could NEVER expire: `git mv agent.rs agent_legacy.rs`, re-ingest, and
  // the fact about the OLD path stayed "ok" forever, because a stale archived row still counted as
  // "file exists". Mirrors the branch-divergence guard above: only orphan on POSITIVE evidence —
  // the graph row is REMOVED *and* the path is actually gone from disk, not from index_status
  // alone (a .gitignore'd directory hits REMOVED too, and that file may still be right there).
  if (anchor.grain === 'file') {
    if (onDisk === false && fileIndexStatus(graphDb, fileId) === 'REMOVED') {
      if (branchDiverged(graphDb, branch)) {
        return { verdict: 'unknown', reason: 'file gone from a stale index — working tree is ahead of the indexed commit' };
      }
      return { verdict: 'orphaned', reason: 'file no longer exists' };
    }
    return { verdict: 'ok' };
  }
  if (onDisk === false) return moved(graphDb, branch, anchor);
  if (!repoRoot) return { verdict: 'unknown', reason: 'checkout location unknown' };

  // A file the walk stopped visiting is marked REMOVED and has every node ARCHIVED, while the file
  // itself sits untouched on disk — `onDisk === false` already returned above, so reaching here with
  // REMOVED means the GRAPH went quiet, not that the code went away. Adding a directory to
  // .gitignore does exactly this; without this guard it would expire every fact about those files as
  // `orphaned` — facts lost on a byte-identical file.
  //
  // The discriminator has to be `index_status`, not "are there declarations": a developer who
  // genuinely empties a file leaves it COMPLETE with zero declarations, and that IS an orphan. Both
  // states archive their nodes, so node status alone cannot tell them apart.
  if (fileIndexStatus(graphDb, fileId) === 'REMOVED') {
    return { verdict: 'unknown', reason: 'file is on disk but no longer indexed' };
  }

  const decls = fileDeclarations(graphDb, branch.branchId, fileId);
  const sameName = decls.filter((d) => d.name === anchor.symbol_name
    && (!anchor.symbol_kind || d.node_type === anchor.symbol_kind));

  if (sameName.length) {
    for (const d of sameName) {
      const body = currentBody(repoRoot, anchor.file_path, d);
      if (!body) continue;
      if (fingerprint(body) === anchor.body_fingerprint) {
        return { verdict: 'ok', node: d };
      }
    }
    // Same name, no fingerprint match — the drift path, and the ONLY verdict here that expires (or
    // overwrites) the fact. Before trusting the disk read to call it drift, confirm the working tree
    // is actually at the indexed commit: currentBody reads the CURRENT disk at the GRAPH's
    // line-spans, so an uncommitted edit that shifts lines, or a different checkout, makes that read
    // garbage — a byte-identical symbol scores similarity 0 and a true fact (a stated law,
    // cross-repo, re-checked on every ingest of ANY repo) expires on absence of falsity. A file_sha
    // mismatch proves disk != what was indexed, so the read cannot be trusted: unknown, never
    // drift. When the file WAS re-ingested the shas match and a genuine body rewrite still drifts.
    const gSha = graphFileSha(graphDb, fileId);
    const dSha = diskFileSha(repoRoot, anchor.file_path);
    if (gSha && dSha && gSha !== dSha) {
      return { verdict: 'unknown', reason: 'working tree diverged from the indexed commit' };
    }
    // Branch-grain fallback for the per-file check above: a store predating files.file_sha (gSha
    // null) can still be told stale by its indexed commit lagging HEAD — do not drift-expire then.
    if (branchDiverged(graphDb, branch)) {
      return { verdict: 'unknown', reason: 'working tree diverged from the indexed commit' };
    }
    // More than one declaration shares this name and none matched the fingerprint: scoring against
    // an arbitrary one would flag a true fact about a DIFFERENT overload. Cannot tell which is the
    // anchor's — unknown, never a flag.
    if (sameName.length > 1) {
      return { verdict: 'unknown', reason: 'multiple same-named declarations — cannot identify which changed' };
    }

    // Same name, different body. The mechanical layer's job stops at "the body changed" — it does
    // not judge how much, because magnitude of change was never a proxy for whether the CLAIM is
    // still true (a one-line edit can falsify a rule; a heavy rewrite can leave it intact). Flag it
    // unconfirmed and refresh the anchor so the NEXT check compares against the current body, not
    // the original one. Never retire on this path — only an agent's verdict (a `contradicted` from
    // reading the code, or a `confirm` that clears the flag) decides truth from here.
    const d = sameName[0];
    const body = currentBody(repoRoot, anchor.file_path, d);
    if (!body) return { verdict: 'unknown', reason: 'body unreadable' };
    return {
      verdict: 'unconfirmed', node: d,
      refresh: { body_fingerprint: fingerprint(body), body_sketch: JSON.stringify(sketch(body)) },
    };
  }

  const renamed = suppressRename ? null : bestRenameCandidate(anchor, decls, repoRoot);
  if (renamed) {
    return {
      verdict: 'renamed',
      node: renamed.decl,
      similarity: renamed.score,
      refresh: {
        symbol_name: renamed.decl.name,
        body_fingerprint: fingerprint(renamed.body),
        body_sketch: JSON.stringify(sketch(renamed.body)),
      },
    };
  }
  // The THIRD way a symbol leaves its path, and the one first missed: the file survives and the
  // symbol moves out of it into another file. The two movedVerdict call sites above only fire when
  // the file itself is gone, so on sindresorhus/got — where refactors carve functions out of
  // core/index.ts into new modules — 33 facts orphaned whose symbols all still existed at HEAD.
  // Same rule as the other two sites: orphan only when the symbol is gone from the whole branch.
  return movedVerdict(graphDb, branch, anchor);
}

const KEEPS_ALIVE = new Set(['ok', 'unconfirmed', 'renamed', 'moved', 'unknown']);

const UPDATE_ANCHOR = `UPDATE OR REPLACE anchors
   SET symbol_name = @new_name, renamed_from = @renamed_from, file_path = @new_file_path,
       body_fingerprint = @body_fingerprint, body_sketch = @body_sketch
 WHERE fact_id = @fact_id AND repo_id = @repo_id AND file_path = @file_path
   AND symbol_name IS @old_name`;

// Shared with the `confirm` action: applying a checkAnchor `refresh` payload to an anchor row is
// the exact same write whether it happens during a routine revalidation pass or because an agent
// just confirmed a flagged fact is still accurate — one mechanism, not a second one built to match.
function applyAnchorRefresh(practiceDb, anchor, refresh) {
  practiceDb.prepare(UPDATE_ANCHOR).run({
    fact_id: anchor.fact_id,
    repo_id: anchor.repo_id,
    file_path: anchor.file_path,
    old_name: anchor.symbol_name,
    new_name: refresh.symbol_name || anchor.symbol_name,
    renamed_from: refresh.symbol_name ? anchor.symbol_name : anchor.renamed_from,
    new_file_path: refresh.file_path || anchor.file_path,
    body_fingerprint: refresh.body_fingerprint,
    body_sketch: refresh.body_sketch,
  });
}

const EXPIRE_FACT = 'UPDATE facts SET expired_at = ?, expiry_reason = ? WHERE id = ? AND expired_at IS NULL';

// Set only when NULL: the first anchor to flag on a fact records when it happened, and a later
// pass finding the SAME fact still unconfirmed (a second anchor, or the same one re-checked before
// anyone looked) must not push the timestamp forward — "unconfirmed since" answers when drift was
// first seen, not when it was last re-noticed. Cleared only by an explicit `confirm` or by a
// `contradicted` verdict, never by revalidate itself.
const FLAG_UNCONFIRMED = `UPDATE facts SET unconfirmed_since = COALESCE(unconfirmed_since, ?)
                           WHERE id = ? AND expired_at IS NULL`;

// Recorded, never expired. A manifest is weaker evidence than the developer who stated the rule,
// so a contradiction withholds the fact from delivery and shows up in `practice list` for them to
// settle. Cleared automatically when the repository agrees again, so a temporary state -- a
// half-finished migration between test runners -- heals without anyone touching the store.
// Setting contradicted_at also clears unconfirmed_since on the same row. Once a fact has been
// actively judged false, "has anyone re-confirmed this" is moot — leaving both set would show a
// reader two overlapping signals about the same fact instead of one clear one. A fact is either
// fine, unconfirmed, or contradicted, never unconfirmed AND contradicted at once.
const MARK_CONTRADICTED = `UPDATE facts SET contradicted_at = ?, contradicted_reason = ?, unconfirmed_since = NULL
                            WHERE id = ? AND contradicted_at IS NULL`;
// Only a contradiction THIS check raised. A developer saying "we use jest now" is marked
// `stated:` by stated.js, and a manifest agreeing again is evidence about a toolchain that says
// nothing about what the developer told us -- clearing it would be the layer arguing back.
const CLEAR_CONTRADICTED = `UPDATE facts SET contradicted_at = NULL, contradicted_reason = NULL
                             WHERE id = ? AND contradicted_at IS NOT NULL
                               AND contradicted_reason LIKE 'manifest:%'`;


// The repo-grain check. Runs BESIDE checkAnchor rather than inside it, because checkAnchor answers
// "does this anchor still point at something" and this answers "does this claim still hold" --
// different questions, and conflating them is how the repo grain ended up with neither.
function checkRepoGrain(practiceDb, ctx) {
  const { id, body, anchors, graphDb, branchCache, now, report, markContradicted, clearContradicted } = ctx;
  if (!anchors.some((a) => a.grain === 'repo')) return;

  let verdict;
  try {
    const { checkRepoFact } = require('./repo-checks');
    const repoId = anchors.find((a) => a.grain === 'repo').repo_id;
    let branch = branchCache.get(repoId);
    if (branch === undefined) {
      branch = resolveBranch(graphDb, { repoId, repoName: repoNameOf(repoId) });
      branchCache.set(repoId, branch);
    }
    verdict = checkRepoFact(body, branch && branch.repoRoot);
  } catch {
    return;                                   // a check that throws says nothing
  }

  if (verdict.status === 'contradicted') {
    if (markContradicted.run(now.toISOString(), verdict.reason, id).changes) {
      report.contradicted.push({ fact_id: id, reason: verdict.reason });
    }
    return;
  }
  // `unknown` must not clear a contradiction either: not being able to look is not evidence that
  // the repository agrees again.
  if (verdict.status === 'ok') report.uncontradicted += clearContradicted.run(id).changes;
}

// One declaration cannot be the rename of two different ones. bestRenameCandidate scores each
// anchor independently, and its dominance guard only compares candidates WITHIN one anchor's list
// -- so when a file loses two declarations and gains one, every orphaned anchor scores that lone
// survivor, the runner-up is undefined, the guard is skipped, and they all re-anchor to it.
//
// Observed: a file holding matchPng and matchJpg, one fact on each, replaced by a single matchGif.
// Both facts followed the rename, leaving matchGif carrying two mutually contradictory rules --
// including a `law`, which recall delivers as an instruction to obey. The README's contract is
// "rename the code, the fact follows; delete it, the fact orphans", and the comment beside the
// dominance guard already says a confident wrong re-resolution is worse than an orphan.
//
// So the claims are settled globally: highest similarity keeps the declaration, everyone else is
// re-checked with the rename suppressed and takes the moved-or-orphaned path they should have had.
// Ties break on the lower fact id, so a re-run of the same store gives the same answer.
function renameClaimKey(anchor, node) {
  return `${anchor.repo_id} ${anchor.file_path} ${node.name} ${node.start_line}`;
}

function losingRenameClaims(entries) {
  const best = new Map();
  for (const entry of entries) {
    const { result } = entry;
    if (!result || result.verdict !== 'renamed' || !result.node) continue;
    const key = renameClaimKey(entry.anchor, result.node);
    const held = best.get(key);
    const better = !held
      || (result.similarity || 0) > (held.result.similarity || 0)
      || ((result.similarity || 0) === (held.result.similarity || 0)
          && entry.anchor.fact_id < held.anchor.fact_id);
    if (better) best.set(key, entry);
  }
  const winners = new Set([...best.values()]);
  return entries.filter((e) => e.result && e.result.verdict === 'renamed' && e.result.node
    && !winners.has(e));
}

function revalidate(practiceDb, graphDb, { now = new Date() } = {}) {
  const facts = practiceDb.prepare('SELECT id, body FROM facts WHERE expired_at IS NULL').all();
  const anchorsOf = practiceDb.prepare('SELECT * FROM anchors WHERE fact_id = ?');
  const updateAnchor = practiceDb.prepare(UPDATE_ANCHOR);
  const expireFact = practiceDb.prepare(EXPIRE_FACT);
  const flagUnconfirmed = practiceDb.prepare(FLAG_UNCONFIRMED);
  const markContradicted = practiceDb.prepare(MARK_CONTRADICTED);
  const clearContradicted = practiceDb.prepare(CLEAR_CONTRADICTED);
  const branchCache = new Map();

  const report = {
    facts_checked: facts.length,
    anchors_checked: 0,
    ok: 0, unconfirmed: 0, renamed: 0, moved: 0, orphaned: 0, unknown: 0,
    expired: [],
    contradicted: [],
    uncontradicted: 0,
  };

  const run = practiceDb.transaction(() => {
    // checkAnchor only reads, so every verdict can be computed before anything is written. That is
    // what makes the rename claims above settleable: they have to be compared across facts, and the
    // per-fact loop below would otherwise have already applied the first claimant's rename.
    const work = facts.map(({ id, body }) => ({ id, body, anchors: anchorsOf.all(id) }));
    const entries = [];
    for (const fact of work) {
      for (const anchor of fact.anchors) {
        entries.push({ anchor, result: checkAnchor(anchor, { graphDb, branchCache }) });
      }
    }
    for (const loser of losingRenameClaims(entries)) {
      loser.result = checkAnchor(loser.anchor, { graphDb, branchCache, suppressRename: true });
    }
    const verdictOf = new Map(entries.map((e) => [e.anchor, e.result]));

    for (const { id, body, anchors } of work) {
      checkRepoGrain(practiceDb, { id, body, anchors, graphDb, branchCache, now, report,
        markContradicted, clearContradicted });
      let alive = false;
      let sawUnconfirmed = false;

      for (const anchor of anchors) {
        const result = verdictOf.get(anchor);
        report.anchors_checked++;
        report[result.verdict]++;
        if (KEEPS_ALIVE.has(result.verdict)) alive = true;
        if (result.verdict === 'unconfirmed') sawUnconfirmed = true;

        if (result.refresh) {
          updateAnchor.run({
            fact_id: anchor.fact_id,
            repo_id: anchor.repo_id,
            file_path: anchor.file_path,
            old_name: anchor.symbol_name,
            new_name: result.refresh.symbol_name || anchor.symbol_name,
            renamed_from: result.refresh.symbol_name ? anchor.symbol_name : anchor.renamed_from,
            new_file_path: result.refresh.file_path || anchor.file_path,
            body_fingerprint: result.refresh.body_fingerprint,
            body_sketch: result.refresh.body_sketch,
          });
        }
      }

      // The mechanical layer's only expiry path: every anchor gone (KEEPS_ALIVE excludes only
      // `orphaned` — whether a body rewrite falsifies a fact's claim is a judgment this layer never
      // makes on its own; it flags `unconfirmed` and leaves the verdict to an agent). A fact is
      // never deleted, only expired with a reason — world time and system time move independently,
      // so a superseded fact reads as history rather than corruption.
      if (!anchors.length || alive) {
        if (sawUnconfirmed) flagUnconfirmed.run(now.toISOString(), id);
        continue;
      }
      expireFact.run(now.toISOString(), 'orphaned', id);
      report.expired.push({ fact_id: id, reason: 'orphaned' });
    }
  });
  run();

  return report;
}

module.exports = {
  revalidate, checkAnchor, bestRenameCandidate, findMovedDeclaration, applyAnchorRefresh,
  RENAME_MIN_SIMILARITY, RENAME_DOMINANCE,
};
