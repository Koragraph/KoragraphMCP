'use strict';

const { execSync } = require('child_process');
const pool = require('../db/pool');
const { bulkWrite } = require('../db/bulk');
const { deriveConfidenceTier } = require('./resolution/tiers');

const DEFAULT_THRESHOLD = 3;

// A commit is evidence of coupling only if it is a CHANGE. A release bump, a reformat or a
// licence-header sweep touches everything at once and says nothing about which files belong
// together — but it contributes n(n-1)/2 pairs, so it dominates by construction.
//
// On real repositories a handful of sweep commits over this cap can contribute the majority
// of all pairs. cochange-miner.js has capped at 20 files since it was written, for exactly
// this reason; this plane must do the same. The number is deliberately the same as
// COCHANGE_MAX_FILES's default: they are the same judgement about what a commit means.
const DEFAULT_MAX_FILES = parseInt(process.env.COUPLING_MAX_FILES || '20', 10);

/**
 * Run `git log` to extract commit→file pairs, then count co-change frequency
 * for every pair of files changed in the same commit.
 *
 * Returns an array of { fileA, fileB, count } sorted by count desc.
 */
function computeFileCoupling(repoPath, threshold = DEFAULT_THRESHOLD, options = {}) {
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : DEFAULT_MAX_FILES;
  let raw;
  try {
    raw = execSync(
      'git log --name-only --pretty=format:"%H"',
      { cwd: repoPath, stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 }
    ).toString();
  } catch (err) {
    throw new Error(`git log failed in ${repoPath}: ${err.message}`);
  }

  // Parse into commits: each block is a hash line followed by changed file paths.
  // Use a line-by-line state machine rather than a regex split so that file paths
  // that happen to be 40 hex characters don't get misidentified as commit SHAs.
  const SHA_RE = /^[0-9a-f]{40}$/;
  const blocks = [];
  let current = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (SHA_RE.test(trimmed)) {
      if (current) blocks.push(current);
      current = { sha: trimmed, files: [] };
    } else if (current && trimmed) {
      current.files.push(trimmed);
    }
  }
  if (current) blocks.push(current);

  const cochange = new Map(); // key "a\x00b" → count

  let sweptCommits = 0;
  for (const block of blocks) {
    const files = block.files;
    if (files.length < 2) continue;
    // Dropped whole, not truncated: taking the first 20 paths of a 145-file sweep would still
    // assert coupling between 190 arbitrary pairs, and which 20 is decided by git's output order.
    if (maxFiles > 0 && files.length > maxFiles) { sweptCommits += 1; continue; }

    // Count every pair (sorted so a < b lexicographically to avoid duplicates)
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        // NUL (\x00) as separator — never valid in a file path
        const key = files[i] < files[j] ? `${files[i]}\x00${files[j]}` : `${files[j]}\x00${files[i]}`;
        cochange.set(key, (cochange.get(key) || 0) + 1);
      }
    }
  }

  const pairs = [];
  for (const [key, count] of cochange.entries()) {
    if (count >= threshold) {
      // Key is "fileA\x00fileB" — NUL is never valid in a file path
      const nul = key.indexOf('\x00');
      const fileA = key.slice(0, nul);
      const fileB = key.slice(nul + 1);
      pairs.push({ fileA, fileB, count });
    }
  }
  pairs.sort((a, b) => b.count - a.count);
  pairs.sweptCommits = sweptCommits;
  return pairs;
}

/**
 * Analyze git history for a repo and write COUPLED_WITH edges.
 *
 * For each pair of files that co-change >= threshold times, find the primary
 * node (first non-IMPORT, non-ARCHIVED node) in each file and write a
 * COUPLED_WITH edge with cochange_count in properties.
 *
 * @param {string} repoPath  Absolute path to the checked-out repo
 * @param {number} branchId  repository_branches.id
 * @param {object} [opts]
 * @param {number} [opts.threshold=3]  Min co-change count to emit an edge
 * @returns {Promise<number>} Number of edges written
 */
async function analyzeCoupling(repoPath, branchId, { threshold = DEFAULT_THRESHOLD } = {}) {
  let pairs;
  try {
    pairs = computeFileCoupling(repoPath, threshold);
  } catch (err) {
    console.warn(`[git-coupling] skipping — ${err.message}`);
    return 0;
  }

  if (!pairs.length) {
    console.log(`[git-coupling] branchId=${branchId} no pairs above threshold=${threshold}`);
    return 0;
  }

  // Load all files for this branch: path → array of node ids (prefer CLASS/SERVICE/NODE_SERVICE)
  const { rows: fileNodes } = await pool.query(
    `SELECT f.path, n.id AS node_id, n.node_type
     FROM files f
     JOIN nodes n ON n.file_id = f.id
     WHERE f.repository_branch_id = $1
       AND n.approval_status != 'ARCHIVED'
     ORDER BY f.path, CASE n.node_type
       WHEN 'CLASS'        THEN 1
       WHEN 'SERVICE'      THEN 2
       WHEN 'NODE_SERVICE' THEN 3
       WHEN 'REPOSITORY'   THEN 4
       WHEN 'CONTROLLER'   THEN 5
       WHEN 'METHOD'       THEN 6
       ELSE 7
     END, n.id`,
    [branchId]
  );

  // Build path → primary node id map (first row per path after ORDER BY above)
  const primaryNode = new Map();
  for (const row of fileNodes) {
    if (!primaryNode.has(row.path)) {
      primaryNode.set(row.path, row.node_id);
    }
  }

  // Resolve pairs → (fromId, toId, count) and discard unresolvable ones
  const resolved = [];
  for (const { fileA, fileB, count } of pairs) {
    const fromId = primaryNode.get(fileA);
    const toId   = primaryNode.get(fileB);
    if (!fromId || !toId || fromId === toId) continue;
    resolved.push({ fromId, toId, count });
  }

  let written = 0;
  if (resolved.length > 0) {
    // Batch upsert via unnest — single round-trip regardless of pair count.
    // 'git_cochange' (tiers.js) is tier 7/INFERRED: the cochange_count measurement is exact
    // (real git history), the coupling *implication* is inferred.
    const { tier, confidence, label } = deriveConfidenceTier('git_cochange');
    try {
      written = await bulkWrite(pool,
        `INSERT INTO edges
           (from_node_id, to_node_id, edge_type, confidence_tier, is_cross_repo, properties, resolution_tier, confidence)
         VALUES ($1, $2, 'COUPLED_WITH', $4, false, $3, $5, $6)
         ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO UPDATE
           SET properties = EXCLUDED.properties, resolution_tier = EXCLUDED.resolution_tier,
               confidence = EXCLUDED.confidence, confidence_tier = EXCLUDED.confidence_tier`,
        resolved.map((r) => [
          r.fromId, r.toId,
          JSON.stringify({ cochange_count: r.count, source: 'git_coupling', resolution: 'git_cochange' }),
          label, tier, confidence,
        ]));
    } catch (err) {
      console.warn(`[git-coupling] branchId=${branchId} batch insert failed: ${err.message}`);
    }
  }

  console.log(`[git-coupling] branchId=${branchId} pairs_above_threshold=${pairs.length} edges_written=${written} sweep_commits_dropped=${pairs.sweptCommits || 0}`);
  return written;
}

module.exports = { analyzeCoupling, computeFileCoupling };
