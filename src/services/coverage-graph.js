'use strict';

const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { logger } = require('../common-services/logger');

// A coverage artifact reports the DECLARATION line; the graph reports the node's start line, and
// the two differ by a line or two for a decorator or an `async` prefix. Wider than this stops being
// a tolerance and starts being a guess about which function was meant.
const COVERAGE_LINE_WINDOW = 2;

// Istanbul / V8 / Vitest `coverage-final.json`, turned into per-declaration coverage STATE.
//
// Not an edge, and specifically not a COVERED_BY edge to a test. That artifact is AGGREGATE: it
// records that the suite executed a function, never which test executed it. The first version of
// this module wrote `COVERED_BY` from a node to ITSELF, which is not a relation and told a reader
// nothing — and its test asserted only that a row existed, so a self-edge passed. Attribution needs
// per-test coverage, which this file does not carry; inventing an edge to the nearest test file
// would be a guess wearing an EXTRACTED confidence tier.
//
// What the artifact DOES support is exactly what blast-radius.js already claims to rank on:
// "callers with no visible test coverage first". That was a path heuristic (looksLikeTestPath) —
// is this file under test/ — which answers a different question. `properties.covered` makes the
// claim true where an artifact exists, and the heuristic still answers where one does not.
async function processCoverageArtifacts({ repoPath, branchId }) {
  if (!repoPath || !fs.existsSync(repoPath)) return { filesParsed: 0, covered: 0 };

  const candidates = [
    path.join(repoPath, 'coverage', 'coverage-final.json'),
    path.join(repoPath, 'coverage-final.json'),
    path.join(repoPath, '.coverage', 'coverage-final.json'),
  ];

  let covFile = candidates.find((p) => fs.existsSync(p));
  if (!covFile) return { filesParsed: 0, covered: 0 };

  let covData;
  try {
    covData = JSON.parse(fs.readFileSync(covFile, 'utf8'));
  } catch (err) {
    logger.warn(`[coverage-graph] Failed to parse ${covFile}: ${err.message}`);
    return { filesParsed: 0, covered: 0 };
  }

  const { rows: nodes } = await pool.query(
    `SELECT n.id, n.name, n.node_type, n.start_line, n.end_line, f.path
     FROM nodes n
     JOIN files f ON f.id = n.file_id
     WHERE n.repository_branch_id = $1 AND n.approval_status != 'ARCHIVED'`,
    [branchId]
  );

  if (!nodes || nodes.length === 0) return { filesParsed: 0, covered: 0 };

  const nodesByFile = new Map();
  for (const n of nodes) {
    if (!nodesByFile.has(n.path)) nodesByFile.set(n.path, []);
    nodesByFile.get(n.path).push(n);
  }

  let covered = 0;
  let filesParsed = 0;

  for (const [rawFilePath, fileCov] of Object.entries(covData)) {
    filesParsed++;
    const relPath = path.isAbsolute(rawFilePath) ? path.relative(repoPath, rawFilePath) : rawFilePath;
    const fileNodes = nodesByFile.get(rawFilePath) || nodesByFile.get(relPath);
    if (!fileNodes || fileNodes.length === 0) continue;

    if (fileCov.fnMap && fileCov.f) {
      for (const [fnIdx, hits] of Object.entries(fileCov.f)) {
        if (hits <= 0) continue;
        const fnMeta = fileCov.fnMap[fnIdx];
        if (!fnMeta || !fnMeta.decl || !fnMeta.decl.start) continue;

        const startLine = fnMeta.decl.start.line;
        // NEAREST, not first-within-tolerance. `find` with a +/-2 window returns whichever METHOD
        // the row order happened to put first, so two adjacent declarations collide and the hit
        // lands on the wrong one — measured on a two-function file where the covered `addNumbers`
        // (line 2) marked the UNCOVERED `multiplyNumbers` (line 3) instead. An exact line match is
        // preferred; the window only absorbs a decorator or an `async` prefix shifting the
        // declaration line, and it is never allowed to reach past a closer candidate.
        let matchingNode = null;
        let bestDelta = Infinity;
        for (const n of fileNodes) {
          if (n.node_type !== 'METHOD' || n.start_line == null) continue;
          const delta = Math.abs(n.start_line - startLine);
          if (delta > COVERAGE_LINE_WINDOW) continue;
          if (delta < bestDelta || (delta === bestDelta && matchingNode && n.id < matchingNode.id)) {
            bestDelta = delta;
            matchingNode = n;
          }
        }

        if (matchingNode) {
          try {
            await pool.query(
              `UPDATE nodes
                  SET properties = json_set(COALESCE(NULLIF(properties, ''), '{}'),
                                            '$.covered', json('true'),
                                            '$.coverage_hits', $2)
                WHERE id = $1`,
              [matchingNode.id, hits],
            );
            covered++;
          } catch (err) {
            logger.warn(`[coverage-graph] could not mark ${matchingNode.name} covered: ${err.message}`);
          }
        }
      }
    }
  }

  logger.info(`[coverage-graph] Processed ${filesParsed} coverage file(s), marked ${covered} declaration(s) covered`);
  return { filesParsed, covered };
}

module.exports = { processCoverageArtifacts };
