'use strict';

const pool = require('../db/pool');
const { logger } = require('../common-services/logger');
const { activateGeneration, failGeneration } = require('./ingest-generation-service');

const MAX_RETRY_ATTEMPTS = parseInt(process.env.INGEST_RETRY_MAX_ATTEMPTS || '5', 10);
const RETRY_BACKOFF_MS = parseInt(process.env.INGEST_RETRY_BACKOFF_MS || '30000', 10);

const MODALITIES = {
  syntax_graph: 'syntax_graph',
  source_cache: 'source_cache',
  edge_resolution: 'edge_resolution',
};

// A run that half-fails still writes whatever it managed, so completeIngestJob needs a
// comparison against the generation it is about to supersede — otherwise a half-graph could
// land ACTIVE and read as COMPLETE. Pure so it is unit-testable without a DB. Tolerates the
// volume noise a real re-ingest has and flags only a shrink big enough to be a bug, not a
// legitimate small drift.
const GENERATION_SHRINK_THRESHOLD_PCT = 30;

function evaluateGenerationShrink({
  beforeNodeCount = 0,
  afterNodeCount = 0,
  beforeEdgeCount = null,
  afterEdgeCount = null,
  resetIntent = false,
} = {}) {
  // beforeNodeCount === 0 covers both "first ingest of this branch" and "--reset wiped the
  // whole project first" (resetProject deletes ingest_generations too, so there is nothing
  // to have shrunk from) — both are legitimate zero-baseline states, not a shrink.
  if (resetIntent || !beforeNodeCount) {
    return {
      shrunk: false,
      shrinkPct: 0,
      edgeShrinkPct: null,
      reason: resetIntent ? 'reset_intent' : 'no_prior_generation',
    };
  }
  const shrinkPct = Math.round(((beforeNodeCount - afterNodeCount) / beforeNodeCount) * 10000) / 100;
  // Compare node AND edge counts — a resolution-pass failure can wipe most of the edge set
  // while leaving node extraction (and thus nodeCount) intact, so the node-only check alone
  // would miss it. Edge counts are optional (beforeEdgeCount
  // null/0 skips this half) so callers that only have node counts keep working unchanged.
  let edgeShrinkPct = null;
  if (beforeEdgeCount != null && afterEdgeCount != null && beforeEdgeCount > 0) {
    edgeShrinkPct = Math.round(((beforeEdgeCount - afterEdgeCount) / beforeEdgeCount) * 10000) / 100;
  }
  const nodeShrunk = shrinkPct > GENERATION_SHRINK_THRESHOLD_PCT;
  const edgeShrunk = edgeShrinkPct != null && edgeShrinkPct > GENERATION_SHRINK_THRESHOLD_PCT;
  const shrunk = nodeShrunk || edgeShrunk;
  return { shrunk, shrinkPct, edgeShrinkPct, reason: shrunk ? 'generation_shrink' : null };
}

function evaluateIngestGates(metrics = {}) {
  const {
    filesExtractable = 0,
    nodesWritten = 0,
    parseFailures = 0,
    sourceCacheFailures = 0,
    unresolvedEdgeCount = 0,
    semanticFilesSeen = 0,
    degradedFiles = 0,
    extractionErrors = 0,
    degradedPasses = [],
  } = metrics;

  const gates = {
    extraction: { status: 'pass', mandatory: true },
    source_verification: { status: 'pass', mandatory: false },
    edge_resolution: { status: 'pass', mandatory: false },
  };
  const degradedModalities = [];

  // filesExtractable alone has two holes: it can under-report (classifier miss,
  // limit truncation) while files were still actually fed into the semantic
  // pipeline. semanticFilesSeen is the actually-attempted count, so a zero-node
  // outcome fails the mandatory gate if EITHER signal says work was attempted.
  if ((filesExtractable > 0 || semanticFilesSeen > 0) && nodesWritten === 0) {
    gates.extraction.status = 'fail';
  } else if (extractionErrors > 0 && extractionErrors >= semanticFilesSeen) {
    gates.extraction.status = 'fail';
  } else if (extractionErrors > 0) {
    gates.extraction.status = 'degraded';
    degradedModalities.push(MODALITIES.syntax_graph);
  } else if (degradedFiles > 0) {
    // A parseFailures>0 file that the AST
    // plane rescued (isDegraded=false in ingest-file-processor.js) lost nothing and
    // must not degrade the modality. Only a file that ALSO lost AST coverage
    // (degradedFiles) is a real syntax_graph loss.
    gates.extraction.status = 'degraded';
    degradedModalities.push(MODALITIES.syntax_graph);
  }

  if (sourceCacheFailures > 0) {
    gates.source_verification.status = 'degraded';
    degradedModalities.push(MODALITIES.source_cache);
  }

  if (unresolvedEdgeCount > 0) {
    gates.edge_resolution.status = 'degraded';
    degradedModalities.push(MODALITIES.edge_resolution);
  }

  // A post-tail pass that threw is the difference between "this graph is complete" and "this
  // graph is missing an entire edge type", and until this arm existed the difference reached
  // stdout and nothing else: soften() printed a DEGRADED banner while ingest_jobs recorded
  // COMPLETE with edge_resolution=pass. That is the shape of the parameter-ceiling bug — 2 of 7
  // repos finished "successfully" with no intra-repo CALLS plane at all. The shrink guard cannot
  // catch it either: a failed ADDITIVE pass does not shrink anything, and on a first ingest
  // evaluateGenerationShrink returns no_prior_generation.
  if (degradedPasses.length > 0) {
    gates.edge_resolution.status = 'degraded';
    degradedModalities.push(MODALITIES.edge_resolution);
  }

  const mandatoryFailed = gates.extraction.status === 'fail';
  let recommendedStatus = 'COMPLETE';
  if (mandatoryFailed) {
    recommendedStatus = 'FAILED';
  } else if (degradedModalities.length > 0) {
    recommendedStatus = 'DEGRADED';
  }

  return {
    gates,
    degradedModalities: [...new Set(degradedModalities)],
    recommendedStatus,
    mandatoryFailed,
    canPublishSnapshot: !mandatoryFailed && nodesWritten > 0,
  };
}

// Single canonical classifier for a project's ingest health,
// consumed by every surface (ingest-coverage/graph-quality, project list,
// project-detail, sources tree) so "healthy" can never be reported while
// the underlying ingest_jobs row says otherwise. Vocabulary intentionally
// matches deriveIngestHealth's existing health_status strings
// (healthy/running/warning/failed/no_ingest) rather than inventing a new one.
function classifyJobHealth(job) {
  if (!job) return { status: 'no_ingest', jobStatus: null, failedStages: [], degradedModalities: [] };

  const jobStatus = job.status || 'UNKNOWN';

  let degradedModalities = [];
  try {
    degradedModalities = typeof job.degraded_modalities === 'string'
      ? JSON.parse(job.degraded_modalities)
      : (job.degraded_modalities || []);
  } catch (_) {}

  let gates = {};
  try {
    gates = typeof job.gate_summary === 'string'
      ? JSON.parse(job.gate_summary)
      : (job.gate_summary || {});
  } catch (_) {}
  const failedStages = Object.keys(gates).filter(
    (name) => gates[name] && gates[name].status && gates[name].status !== 'pass',
  );

  let status;
  if (jobStatus === 'FAILED') status = 'failed';
  else if (jobStatus === 'PENDING' || jobStatus === 'RUNNING') status = 'running';
  else if (jobStatus === 'WAITING_RETRY' || jobStatus === 'DEGRADED') status = 'warning';
  else if (jobStatus === 'COMPLETE') status = 'healthy';
  else status = 'unknown';

  return { status, jobStatus, failedStages, degradedModalities };
}

async function enqueueIngestRetry({
  ingestJobId,
  projectId,
  branchId,
  orgId = null,
  workType,
  idempotencyKey,
  payload = {},
  maxAttempts = MAX_RETRY_ATTEMPTS,
  db = pool,
}) {
  const { rows } = await db.query(
    `INSERT INTO ingest_retry_queue (
       org_id, project_id, ingest_job_id, branch_id,
       work_type, idempotency_key, payload, max_attempts, status, next_retry_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT (idempotency_key) DO UPDATE SET
       status = CASE
         WHEN ingest_retry_queue.status = 'COMPLETE' THEN 'COMPLETE'
         ELSE 'PENDING'
       END,
       next_retry_at = CASE
         WHEN ingest_retry_queue.status = 'COMPLETE' THEN ingest_retry_queue.next_retry_at
         ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now')
       END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     RETURNING id, status`,
    [
      orgId,
      projectId,
      ingestJobId,
      branchId,
      workType,
      idempotencyKey,
      JSON.stringify(payload),
      maxAttempts,
    ],
  );
  return rows[0];
}

async function updateJobFields(jobId, fields, db = pool) {
  if (!jobId) return;
  const serialized = { ...fields };
  if (Array.isArray(serialized.degraded_modalities)) {
    serialized.degraded_modalities = JSON.stringify(serialized.degraded_modalities);
  }
  if (serialized.gate_summary && typeof serialized.gate_summary === 'object') {
    serialized.gate_summary = JSON.stringify(serialized.gate_summary);
  }
  const sets = Object.keys(serialized).map((k, i) => `${k} = $${i + 2}`).join(', ');
  await db.query(
    `UPDATE ingest_jobs SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1`,
    [jobId, ...Object.values(serialized)],
  );
}

async function finalizeIngestJob({
  jobId,
  projectId,
  branchId,
  repoId,
  orgId = null,
  metrics,
  activateGenerationId = null,
  jobFields = {},
  beforeNodeCount = null,
  beforeEdgeCount = null,
  resetIntent = false,
  db = pool,
}) {
  const evaluation = evaluateIngestGates(metrics);

  let shrinkResult = { shrunk: false, shrinkPct: 0, edgeShrinkPct: null, reason: null };
  if (activateGenerationId) {
    if (evaluation.canPublishSnapshot) {
      const { carryForwardGenerationMembership } = require('./changed-file-replacement');
      // An empty touched list is the case that MOST needs carrying forward, not the
      // case to skip: a removal-only incremental writes no node rows, so without this
      // every surviving node stays on the generation about to be SUPERSEDED below —
      // invisible to generation-scoped reads, and deletable by a generation prune via
      // the ON DELETE CASCADE from migration 192 (LEDGER M49).
      if (Array.isArray(metrics.carryForwardTouchedFileIds)) {
        await carryForwardGenerationMembership({
          branchId,
          generationId: activateGenerationId,
          touchedFileIds: metrics.carryForwardTouchedFileIds,
        });
      }
      await activateGeneration(activateGenerationId, db);

      // Shrink guard — beforeNodeCount is a pre-run snapshot the caller took
      // before extraction touched anything (changed-file-replacement.js archives node-by-
      // node DURING the run, not at activation, so "before" has to be captured up front).
      if (branchId && beforeNodeCount != null) {
        const { snapshotBranchCounts } = require('./graph-diff');
        const after = await snapshotBranchCounts(branchId).catch(() => null);
        if (after) {
          shrinkResult = evaluateGenerationShrink({
            beforeNodeCount,
            afterNodeCount: after.nodeCount,
            beforeEdgeCount,
            afterEdgeCount: after.edgeCount,
            resetIntent,
          });
          if (shrinkResult.shrunk) {
            const edgeClause = shrinkResult.edgeShrinkPct != null
              ? `, edges ${beforeEdgeCount} -> ${after.edgeCount} (-${shrinkResult.edgeShrinkPct}%)`
              : '';
            logger.error(
              `[shrink-guard] branch=${branchId} generation=${activateGenerationId} ` +
              `nodes ${beforeNodeCount} -> ${after.nodeCount} (-${shrinkResult.shrinkPct}%)${edgeClause} ` +
              `without reset-intent — degrading job ${jobId}`,
            );
          }
        }
      }
    } else {
      await failGeneration(activateGenerationId, { reason: 'mandatory extraction gates failed', gates: evaluation.gates }, db);
    }
  }

  let status = evaluation.recommendedStatus;
  let degradedModalities = evaluation.degradedModalities;
  if (shrinkResult.shrunk) {
    degradedModalities = [...new Set([...degradedModalities, 'generation_shrink'])];
    if (status === 'COMPLETE') status = 'DEGRADED';
  }

  // comprehension_pct: post-extraction "% of accounted files that
  // actually produced nodes", derived from the per-file manifest so it can
  // never regress to a 0/0 fallback reporting 100.
  let comprehensionFields = {};
  if (jobId) {
    const { rows: [comp] } = await db.query(
      // GATE-0(e) floor honesty: a presence_floor / binary_stub row is a filename-and-size
      // placeholder proving the file is not lost — it is NOT evidence the file was understood.
      // Counting it as comprehension reported 100.00% on jobs where dozens of files produced
      // nothing but a stub, which overstates the product's actual claim. Completeness
      // (files_accounted, files_with_nodes) and comprehension stay separate numbers so neither
      // has to lie for the other to look good.
      //
      // Comprehension is decided by NODE PROVENANCE, not by the coverage tier. The tier records
      // which pass last *routed* a file and goes stale across re-ingests: a file floored on an
      // earlier run keeps its live floor node, so the floor pass correctly does not re-floor it
      // and its tier stays whatever the extraction pass set ('llm_semantic'/'generic_ast').
      // Keying on tier alone counted 25 such files across jobs 186/187/188 as comprehended when
      // their only live nodes were stubs — reintroducing the exact inflation this check prevents.
      `SELECT
         count(*) FILTER (WHERE cf.node_count > 0) AS with_nodes,
         count(*) FILTER (
           WHERE cf.node_count > 0
             AND cf.tier NOT IN ('presence_floor', 'binary_stub', 'record_only')
             AND EXISTS (
               SELECT 1
               FROM files f
               JOIN nodes n ON n.file_id = f.id
               WHERE f.repository_branch_id = $2
                 AND f.path = cf.path
                 AND n.approval_status <> 'ARCHIVED'
                 AND COALESCE(
                       json_extract(n.properties, '$.extraction_source'),
                       json_extract(n.properties, '$.provenance'),
                       ''
                     ) NOT IN ('presence_floor', 'binary_stub')
             )
         ) AS comprehended,
         count(*) AS accounted
       FROM ingest_coverage_files cf
       WHERE cf.job_id = $1`,
      [jobId, branchId],
    );
    const withNodes = comp ? parseInt(comp.with_nodes, 10) : 0;
    const comprehended = comp ? parseInt(comp.comprehended, 10) : 0;
    const accounted = comp ? parseInt(comp.accounted, 10) : 0;
    // files_with_nodes stays the completeness figure (any node, floors included) and keeps its
    // existing column; comprehension_pct is now the floor-excluding one. The gap between them is
    // exactly the stub count, so both facts stay readable without a schema change.
    comprehensionFields = {
      files_with_nodes: withNodes,
      files_accounted: accounted,
      comprehension_pct: accounted > 0 ? +(100 * comprehended / accounted).toFixed(2) : null,
    };
  }

  await updateJobFields(jobId, {
    status,
    degraded_modalities: degradedModalities,
    gate_summary: evaluation.gates,
    ...comprehensionFields,
    ...jobFields,
  }, db);

  return { status, ...evaluation, degradedModalities, shrinkGuard: shrinkResult };
}

async function claimNextRetryItem(db = pool) {
  const { rows } = await db.query(`
    UPDATE ingest_retry_queue
    SET status = 'RUNNING', attempt_count = attempt_count + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = (
      SELECT id FROM ingest_retry_queue
      WHERE status = 'PENDING'
        AND attempt_count < max_attempts
        AND next_retry_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
      ORDER BY next_retry_at ASC, id ASC
      LIMIT 1
      -- B9: was FOR UPDATE SKIP LOCKED. SQLite has neither, and under WAL with a synchronous
      -- in-process driver there is exactly one writer, so the exclusion is free. The CLAIM is
      -- what mattered and it is already atomic: this is a single UPDATE whose subquery picks the
      -- row and whose SET marks it RUNNING, so no second reader can observe it PENDING. It
      -- returns its row through .all() because the shim branches on stmt.reader, not on the SQL
      -- verb (D11) -- run through .run() this would report changes:1 and hand back nothing, and
      -- the claim loop would spin forever on a queue it was successfully draining.
    )
    RETURNING *
  `);
  return rows[0] || null;
}

async function executeRetryItem(item) {
  switch (item.work_type) {
    case 'extraction_retry': {
      // Terminal extraction failures (llm_error, parse_failure, schema_repair_failed) are
      // queued here so the failure is never
      // silently dropped, but no live checkout is retained after a job completes — there
      // is nothing to re-extract from. Throw a clear, specific error (maxAttempts is set
      // to 1 at enqueue time) so the item lands in FAILED with an honest last_error
      // instead of "unsupported retry work_type" or an infinite retry loop.
      const relPath = item.payload?.relPath || '(unknown path)';
      const reason = item.payload?.failureReason || 'unknown';
      throw new Error(`extraction retry for ${relPath} (${reason}) requires a fresh ingest run — no live checkout retained`);
    }
    default:
      throw new Error(`unsupported retry work_type: ${item.work_type}`);
  }
}

async function reconcileJobAfterRetry(ingestJobId, db = pool) {
  const { rows: pending } = await db.query(
    `SELECT COUNT(*) AS pending
       FROM ingest_retry_queue
      WHERE ingest_job_id = $1 AND status IN ('PENDING', 'RUNNING')`,
    [ingestJobId],
  );
  if (pending[0].pending > 0) return null;

  const { rows: failures } = await db.query(
    `SELECT COUNT(*) AS failed
       FROM ingest_retry_queue
      WHERE ingest_job_id = $1 AND status = 'FAILED'`,
    [ingestJobId],
  );

  const { rows: [job] } = await db.query(
    `SELECT degraded_modalities FROM ingest_jobs WHERE id = $1`,
    [ingestJobId],
  );
  if (!job) return null;

  let degradedModalities = [];
  try {
    degradedModalities = typeof job.degraded_modalities === 'string'
      ? JSON.parse(job.degraded_modalities)
      : (job.degraded_modalities || []);
  } catch (_) {}

  if (failures[0].failed === 0) {
    await updateJobFields(ingestJobId, {
      status: degradedModalities.length > 0 ? 'DEGRADED' : 'COMPLETE',
      degraded_modalities: degradedModalities,
    }, db);
  } else {
    await updateJobFields(ingestJobId, {
      status: 'DEGRADED',
      degraded_modalities: degradedModalities,
    }, db);
  }
  return { ingestJobId };
}

async function processIngestRetryQueue({ limit = 5, db = pool } = {}) {
  const touchedJobs = new Set();
  let processed = 0;

  for (let i = 0; i < limit; i++) {
    const item = await claimNextRetryItem(db);
    if (!item) break;

    try {
      await executeRetryItem(item);

      await db.query(
        `UPDATE ingest_retry_queue
            SET status = 'COMPLETE', last_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = $1`,
        [item.id],
      );
      touchedJobs.add(item.ingest_job_id);
      processed++;
    } catch (err) {
      const exhausted = item.attempt_count >= item.max_attempts;
      await db.query(
        `UPDATE ingest_retry_queue
            SET status = $2,
                last_error = $3,
                next_retry_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ($4 / 1000.0) || ' seconds'),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = $1`,
        [item.id, exhausted ? 'FAILED' : 'PENDING', err.message.slice(0, 2000), String(RETRY_BACKOFF_MS)],
      );
      if (exhausted) touchedJobs.add(item.ingest_job_id);
      logger.warn(`[ingest-retry] item #${item.id} ${exhausted ? 'failed' : 'deferred'}: ${err.message}`);
    }
  }

  for (const jobId of touchedJobs) {
    await reconcileJobAfterRetry(jobId, db);
  }

  return { processed, jobsReconciled: touchedJobs.size };
}

module.exports = {
  MODALITIES,
  evaluateIngestGates,
  evaluateGenerationShrink,
  classifyJobHealth,
  enqueueIngestRetry,
  finalizeIngestJob,
  processIngestRetryQueue,
  reconcileJobAfterRetry,
  claimNextRetryItem,
  executeRetryItem,
};
