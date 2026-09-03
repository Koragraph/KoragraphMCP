'use strict';

const pool = require('../db/pool');

// Snapshot current edge count for a branch before incremental extraction begins.
// Returns { edgeCount, nodeCount } for use as a before-baseline.
async function snapshotBranchCounts(branchId) {
  const { rows: [nc] } = await pool.query(
    `SELECT count(*) AS cnt
     FROM nodes
     WHERE repository_branch_id = $1 AND approval_status != 'ARCHIVED'`,
    [branchId]
  );
  const { rows: [ec] } = await pool.query(
    `SELECT count(*) AS cnt
     FROM edges e
     JOIN nodes n ON n.id = e.from_node_id
     WHERE n.repository_branch_id = $1`,
    [branchId]
  );
  return { nodeCount: nc.cnt, edgeCount: ec.cnt };
}

// Compute a graph diff row and write it to graph_diffs.
// before = { nodeCount, edgeCount } — snapshot taken at start of runIncrementalIngest
// nodesAdded, nodesArchived — counts from the incremental run itself
// Returns the inserted row.
async function writeGraphDiff({ ingestJobId, branchId, before, nodesAdded, nodesArchived }) {
  // Re-count edges after the run
  const { rows: [ec] } = await pool.query(
    `SELECT count(*) AS cnt
     FROM edges e
     JOIN nodes n ON n.id = e.from_node_id
     WHERE n.repository_branch_id = $1`,
    [branchId]
  );
  const edgesAfter = ec.cnt;
  const edgesAdded   = Math.max(0, edgesAfter - before.edgeCount);
  const edgesRemoved = Math.max(0, before.edgeCount - edgesAfter);

  const diffDetail = {
    before_node_count: before.nodeCount,
    before_edge_count: before.edgeCount,
    after_edge_count: edgesAfter,
  };

  const { rows: [row] } = await pool.query(
    `INSERT INTO graph_diffs
       (ingest_job_id, branch_id, nodes_added, nodes_archived, edges_added, edges_removed, diff_detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [ingestJobId, branchId, nodesAdded, nodesArchived, edgesAdded, edgesRemoved, JSON.stringify(diffDetail)]
  );

  console.log(`[graph-diff] jobId=${ingestJobId} branch=${branchId} nodes_added=${nodesAdded} nodes_archived=${nodesArchived} edges_added=${edgesAdded} edges_removed=${edgesRemoved}`);
  return row;
}

module.exports = { snapshotBranchCounts, writeGraphDiff };
