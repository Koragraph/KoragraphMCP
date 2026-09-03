'use strict';

const fs = require('fs');
const path = require('path');

const { resolveBranch, resolveFileId, fileDeclarations } = require('./resolve');
const { repoNameOf } = require('./repo-identity');
const { bestRenameCandidate, findMovedDeclaration } = require('./revalidate');

// 3.3: anchoring for open loops. A loop's anchor exists for exactly one job — deciding WHEN to
// surface it (an agent visiting that node, see 3.5/3.6) — and that is a critically different
// lifecycle from a fact's anchor. It is never checked for drift and it never expires or resolves
// the loop it belongs to: only `resolve` (a person or agent saying the work is done) or the one
// narrow mechanical "path now exists" check in open-loops.js#checkableClose does that. The only
// mechanical work this module does is following a rename/move so the anchor keeps pointing at the
// right place, and falling back to repo-grain (dropping the anchor, never the loop) when the named
// code is genuinely gone — a temporary decision does not become finished just because the code
// around it vanished.

const INSERT_LOOP_ANCHOR = `INSERT OR IGNORE INTO loop_anchors
  (loop_id, repo_id, file_path, symbol_name, symbol_kind, body_fingerprint, body_sketch, grain)
  VALUES (@loop_id, @repo_id, @file_path, @symbol_name, @symbol_kind, @body_fingerprint, @body_sketch, @grain)`;

// `anchorRows` is whatever promote.js#anchorsFor already computes for a fact's target — same
// lookup, same symbol/file/repo grain fallback (3.3's whole point). Repo-grain rows are dropped:
// a loop with nothing specific named stays implicitly repo-grain by having no loop_anchors row at
// all, delivered instead by the session-start block (3.6).
function anchorLoop(practiceDb, loopId, anchorRows) {
  const insert = practiceDb.prepare(INSERT_LOOP_ANCHOR);
  let anchored = 0;
  for (const a of anchorRows) {
    if (a.grain === 'repo') continue;
    insert.run({
      loop_id: loopId,
      repo_id: a.repo_id,
      file_path: a.file_path,
      symbol_name: a.symbol_name,
      symbol_kind: a.symbol_kind,
      body_fingerprint: a.body_fingerprint,
      body_sketch: a.body_sketch,
      grain: a.grain,
    });
    anchored++;
  }
  return anchored;
}

function fileExistsOnDisk(repoRoot, filePath) {
  if (!repoRoot) return null;
  if (!fs.existsSync(repoRoot)) return null;
  return fs.existsSync(path.join(repoRoot, filePath));
}

function fileIndexStatus(graphDb, fileId) {
  try {
    const row = graphDb.prepare('SELECT index_status FROM files WHERE id = ?').get(fileId);
    return row ? row.index_status : null;
  } catch { return null; }
}

const UPDATE_LOOP_ANCHOR = `UPDATE OR REPLACE loop_anchors
   SET symbol_name = @new_name, renamed_from = @renamed_from, file_path = @new_file_path,
       body_fingerprint = @body_fingerprint, body_sketch = @body_sketch
 WHERE loop_id = @loop_id AND repo_id = @repo_id AND file_path = @file_path
   AND symbol_name IS @old_name`;

const DELETE_LOOP_ANCHOR = `DELETE FROM loop_anchors
 WHERE loop_id = @loop_id AND repo_id = @repo_id AND file_path = @file_path AND symbol_name IS @symbol_name`;

// One anchor's fate: 'ok' (nothing to do), 'renamed'/'moved' (refresh in place), 'dropped' (fell
// back to repo-grain — the loop stays open, just undirected), or 'unknown' (cannot tell, so leave
// it exactly as it is — the same "never guess" rule the fact anchor check uses).
function checkOne(anchor, { graphDb, branchCache }) {
  if (!graphDb) return { verdict: 'unknown' };
  let branch = branchCache.get(anchor.repo_id);
  if (branch === undefined) {
    branch = resolveBranch(graphDb, { repoId: anchor.repo_id, repoName: repoNameOf(anchor.repo_id) });
    branchCache.set(anchor.repo_id, branch);
  }
  if (!branch) return { verdict: 'unknown' };
  const repoRoot = branch.repoRoot;

  if (anchor.grain === 'file') {
    const fileId = resolveFileId(graphDb, branch.branchId, anchor.file_path);
    const onDisk = fileExistsOnDisk(repoRoot, anchor.file_path);
    if (fileId && fileIndexStatus(graphDb, fileId) !== 'REMOVED') return { verdict: 'ok' };
    if (onDisk) return { verdict: 'ok' };
    if (onDisk === null || (!fileId && onDisk !== false)) return { verdict: 'unknown' };
    return { verdict: 'dropped' };
  }

  const fileId = resolveFileId(graphDb, branch.branchId, anchor.file_path);
  if (fileId) {
    const decls = fileDeclarations(graphDb, branch.branchId, fileId);
    const sameName = decls.some((d) => d.name === anchor.symbol_name
      && (!anchor.symbol_kind || d.node_type === anchor.symbol_kind));
    if (sameName) return { verdict: 'ok' };

    const renamed = bestRenameCandidate(anchor, decls, repoRoot);
    if (renamed) {
      return {
        verdict: 'renamed',
        refresh: {
          symbol_name: renamed.decl.name,
          file_path: anchor.file_path,
        },
      };
    }
  } else {
    // The file itself is not in the graph. Absent-but-on-disk (or an unreadable checkout) is graph
    // incompleteness, not deletion — dropping here would fall a loop back to repo-grain every time
    // its file simply had not been re-ingested yet. Only a file confirmed GONE from disk earns a
    // move/drop verdict below.
    const onDisk = fileExistsOnDisk(repoRoot, anchor.file_path);
    if (onDisk !== false) return { verdict: 'unknown' };
  }

  const moved = findMovedDeclaration(graphDb, branch, anchor);
  if (moved && !moved.ambiguous) {
    return {
      verdict: 'moved',
      refresh: { symbol_name: moved.decl.name, file_path: moved.decl.file_path },
    };
  }
  if (moved && moved.ambiguous) return { verdict: 'unknown' };
  return { verdict: 'dropped' };
}

// Runs alongside `revalidate()`, over every loop_anchors row, on the same "revalidate" cadence.
// Never touches open_loops.resolved_at — see the module comment for why.
function revalidateLoopAnchors(practiceDb, graphDb, { now = new Date() } = {}) {
  const rows = practiceDb.prepare(
    `SELECT la.* FROM loop_anchors la JOIN open_loops l ON l.id = la.loop_id WHERE l.resolved_at IS NULL`,
  ).all();
  const update = practiceDb.prepare(UPDATE_LOOP_ANCHOR);
  const del = practiceDb.prepare(DELETE_LOOP_ANCHOR);
  const branchCache = new Map();
  const report = { checked: rows.length, renamed: 0, moved: 0, dropped: 0, unknown: 0, ok: 0 };

  for (const anchor of rows) {
    const result = checkOne(anchor, { graphDb, branchCache });
    report[result.verdict] = (report[result.verdict] || 0) + 1;
    if (result.verdict === 'dropped') {
      del.run({ loop_id: anchor.loop_id, repo_id: anchor.repo_id, file_path: anchor.file_path, symbol_name: anchor.symbol_name });
    } else if (result.refresh) {
      update.run({
        loop_id: anchor.loop_id,
        repo_id: anchor.repo_id,
        file_path: anchor.file_path,
        old_name: anchor.symbol_name,
        new_name: result.refresh.symbol_name,
        renamed_from: result.refresh.symbol_name !== anchor.symbol_name ? anchor.symbol_name : anchor.renamed_from,
        new_file_path: result.refresh.file_path,
        body_fingerprint: anchor.body_fingerprint,
        body_sketch: anchor.body_sketch,
      });
    }
  }
  return report;
}

// The delivery-side lookup (3.5/3.6) lives in open-loops.js, not here, as `loopsAtNode` — this
// module requires resolve.js/revalidate.js for the rename-following mechanics, and recall.js's
// note-slot lookup (used from the UserPromptSubmit hook path via context-brief.js) must never pull
// that in, even transitively through a lazy require: the hook-safety tests walk EVERY `require(...)`
// text in a file, lazy or not, so a pure delivery-side read belongs beside open-loops.js's other
// hook-safe reads (listOpen, surface), which already have zero graph-touching requires.

module.exports = { anchorLoop, revalidateLoopAnchors };
