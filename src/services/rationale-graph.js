'use strict';

const fs = require('fs');
const path = require('path');

const pool = require('../db/pool');
const { edgeWriteTier } = require('./resolution/tiers');
const { parseRationale } = require('./contract-parsers/rationale');

// Post-tail pass that puts the "why" into the graph at symbol granularity.
//
// DOC nodes existed only for prose FILES — a README, a design note. The
// rationale a maintainer actually needs is attached to a function: "retries
// because the vendor 502s under load", "do not reorder, the lock comes first".
// None of it was in the graph, so every "why is this like this" question fell
// back to reading the file.
//
// This capability most directly serves onboarding — a new engineer's question
// is usually "why", and "why" is not derivable from structure.
//
//   DOC(rationale) -[REFERENCES]-> METHOD/CLASS   the symbol it explains
//   FILE           -[CONTAINS]->   DOC            written by writeContainsEdges
//
// Zero-token: regex over files already on disk. A docstring shorter than a
// sentence is skipped — `"""Forum."""` says nothing the symbol name does not.

const LANG_BY_EXT = {
  '.py': 'python', '.java': 'java', '.kt': 'java', '.kts': 'java',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.go': 'go', '.cs': 'csharp', '.php': 'php', '.rb': 'ruby', '.rs': 'rust',
  '.dart': 'dart', '.scala': 'scala', '.swift': 'swift',
};

const MAX_SOURCE_BYTES = 400_000;
// A file with hundreds of docstrings is a generated API surface, and one DOC
// node per entry would swamp the graph with boilerplate. Cap and say so.
const MAX_RATIONALE_PER_FILE = 60;

async function resolveRationaleNodes(branchId, repoPath, ingestGenerationId = null, _pool = pool, deps = {}) {
  if (!repoPath || !fs.existsSync(repoPath)) {
    console.log(`[rationale-graph] branchId=${branchId} skipped — no checkout on disk`);
    return { files: 0, nodes: 0, edges: 0 };
  }
  const writeNodeFn = deps.writeNode || require('./ingest').writeNode;

  const { rows: symbolRows } = await _pool.query(
    `SELECT n.id AS node_id, n.node_type, n.name, n.start_line, n.end_line,
            f.id AS file_id, f.path, f.file_sha
     FROM nodes n
     JOIN files f ON f.id = n.file_id
     WHERE n.repository_branch_id = $1
       AND n.node_type IN ('METHOD','CLASS','ENTITY','SERVICE','CONTROLLER','REPOSITORY','TEST',
                           'PYTHON_SERVICE','PYTHON_MODEL','NODE_SERVICE','UTILITY')
       AND n.approval_status != 'ARCHIVED'
     -- B8: SQLite sorts NULLs FIRST on ASC, so NULLS LAST needs the explicit key.
     ORDER BY f.path, (n.start_line IS NULL), n.start_line, n.id`,
    [branchId]
  );
  if (!symbolRows.length) {
    console.log(`[rationale-graph] branchId=${branchId} symbols=0`);
    return { files: 0, nodes: 0, edges: 0 };
  }

  const byPath = new Map();
  for (const r of symbolRows) {
    const list = byPath.get(r.path);
    if (list) list.push(r); else byPath.set(r.path, [r]);
  }

  const edgeRows = [];
  let files = 0, created = 0, capped = 0;
  // Ownership of DOC staleness moved here from replaceChangedFileFacts, which used to archive
  // every DOC on every ingest (churn — see changed-file-replacement.js). A file we actually read
  // and re-parsed is authoritative about its own current rationale set, so after the pass we
  // archive that file's live DOC nodes we did NOT (re)write this run — a docstring that was edited
  // (new canonical key) or deleted (no key at all). processedFileIds must include files whose
  // rationale is now EMPTY (every docstring removed), which is exactly why fileId is stamped before
  // the empty-`found` continue below.
  const processedFileIds = new Set();
  const writtenDocIds = [];

  for (const [relPath, symbols] of byPath) {
    const lang = LANG_BY_EXT[path.extname(relPath).toLowerCase()];
    if (!lang) continue;
    let content;
    try {
      const full = path.join(repoPath, relPath);
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) continue;
      content = fs.readFileSync(full, 'utf8');
    } catch (_) {
      continue;
    }

    const fileId = symbols[0].file_id;
    const fileSha = symbols[0].file_sha;
    processedFileIds.add(fileId);

    let found = parseRationale(content, lang);
    if (!found.length) continue;
    if (found.length > MAX_RATIONALE_PER_FILE) {
      capped += found.length - MAX_RATIONALE_PER_FILE;
      found = found.slice(0, MAX_RATIONALE_PER_FILE);
    }
    files++;

    for (const r of found) {
      // Bind to the symbol whose declaration the parser attributed it to,
      // preferring an exact name match at that line and falling back to the
      // narrowest span containing it. Unattributed rationale still becomes a
      // node — it is file-level "why", which writeContainsEdges reaches.
      let owner = null;
      if (r.ownerName) {
        const named = symbols.filter((s) => s.name === r.ownerName);
        if (named.length === 1) owner = named[0];
        else if (named.length > 1 && r.ownerLine != null) {
          owner = named
            .filter((s) => s.start_line != null && Math.abs(s.start_line - r.ownerLine) <= 2)
            .sort((a, b) => Math.abs(a.start_line - r.ownerLine) - Math.abs(b.start_line - r.ownerLine))[0] || null;
        }
      }
      if (!owner && r.ownerLine != null) {
        owner = symbols
          .filter((s) => s.start_line != null && s.end_line != null && s.start_line <= r.ownerLine && r.ownerLine <= s.end_line)
          .sort((a, b) => (a.end_line - a.start_line) - (b.end_line - b.start_line))[0] || null;
      }

      const label = r.text.length > 90 ? `${r.text.slice(0, 87)}...` : r.text;
      const nodeId = await writeNodeFn(
        {
          node_type: 'DOC',
          name: `${owner ? owner.name : path.basename(relPath)} — ${label}`,
          summary: r.text.slice(0, 500),
          raw_evidence: r.text,
          confidence_tier: 'EXTRACTED',
          confidence: 1.0,
          provenance: 'rationale',
          rationale_kind: r.kind,
          start_line: r.line,
          end_line: r.line,
        },
        fileId, branchId, fileSha, ingestGenerationId
      ).catch(() => null);
      if (!nodeId) continue;
      created++;
      writtenDocIds.push(nodeId);
      if (owner && owner.node_id !== nodeId) {
        edgeRows.push({ from: nodeId, to: owner.node_id, calledName: owner.name, line: r.line });
      }
    }
  }

  // Retire DOC nodes whose docstring is gone. Scoped to files this pass actually re-parsed, and to
  // DOC only (markdown DOCs live in prose files with no symbols, so they never enter processedFileIds
  // and are untouched). A DOC written or upserted this run is in writtenDocIds and survives; the rest
  // are stale. Edges to an archived DOC are hard-deleted, matching how replaceChangedFileFacts and
  // archiveDeletedFileNodes reap a vanished node's edges.
  let archivedStale = 0;
  if (processedFileIds.size) {
    const { rows: staleDocs } = await _pool.query(
      `UPDATE nodes SET approval_status = 'ARCHIVED', last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE node_type = 'DOC'
          AND approval_status != 'ARCHIVED'
          AND file_id IN (SELECT value FROM json_each($1))
          AND NOT (id IN (SELECT value FROM json_each($2)))
        RETURNING id`,
      [JSON.stringify([...processedFileIds]), JSON.stringify(writtenDocIds)],
    );
    archivedStale = staleDocs.length;
    if (archivedStale) {
      const staleIds = JSON.stringify(staleDocs.map((r) => r.id));
      await _pool.query(
        `DELETE FROM edges WHERE from_node_id IN (SELECT value FROM json_each($1)) OR to_node_id IN (SELECT value FROM json_each($1))`,
        [staleIds],
      );
    }
  }

  let written = 0;
  if (edgeRows.length) {
    const CHUNK = pool.safeChunk(7);
    for (let i = 0; i < edgeRows.length; i += CHUNK) {
      const chunk = edgeRows.slice(i, i + CHUNK);
      const params = [];
      const values = chunk.map(({ from, to, calledName, line }) => {
        const base = params.length;
        const derived = edgeWriteTier('rationale_for', 'REFERENCES');
        params.push(from, to, derived.edgeType, derived.label,
          JSON.stringify({ resolution: 'rationale_for', called_name: calledName, call_line: line }),
          derived.tier, derived.confidence);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
      });
      const { rowCount } = await _pool.query(
        `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
         VALUES ${values.join(',')}
         ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
        params
      );
      written += rowCount ?? chunk.length;
    }
  }

  console.log(`[rationale-graph] branchId=${branchId} files=${files} nodes=${created} edges=${written}${capped ? ` capped=${capped}` : ''}${archivedStale ? ` staleDocsArchived=${archivedStale}` : ''}`);
  return { files, nodes: created, edges: written, capped, archivedStale };
}

module.exports = { resolveRationaleNodes };
