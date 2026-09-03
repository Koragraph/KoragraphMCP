'use strict';

const crypto = require('crypto');
const pool = require('../db/pool');

const ACTIVE_STATUSES = ['ACTIVE'];
const IN_FLIGHT_STATUSES = ['PENDING', 'VALIDATING'];

function hashIngestConfig(config) {
  return crypto.createHash('sha256').update(JSON.stringify(config || {}), 'utf8').digest('hex').slice(0, 16);
}

async function getActiveGenerationForBranch(branchId, db = pool) {
  const { rows } = await db.query(
    `SELECT id, project_id, repository_id, repository_branch_id, revision_sha,
            config_hash, extractor_version, indexer_version, status,
            started_at, completed_at, previous_generation_id, diagnostics
       FROM ingest_generations
      WHERE repository_branch_id = $1
        AND status = 'ACTIVE'
      -- B8: SQLite has no NULLS LAST. On DESC it already sorts NULLs last, but spelling it out
      -- keeps the intent readable and survives anyone flipping the direction.
      ORDER BY (completed_at IS NULL), completed_at DESC, id DESC
      LIMIT 1`,
    [branchId],
  );
  return rows[0] || null;
}

async function getActiveGenerationIds(branchIds, db = pool) {
  const ids = (branchIds || []).filter((id) => Number.isFinite(id));
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT repository_branch_id, id
       FROM ingest_generations
      WHERE repository_branch_id IN (SELECT value FROM json_each($1))
        AND status = 'ACTIVE'`,
    [ids],
  );
  const map = new Map();
  for (const row of rows) {
    map.set(row.repository_branch_id, row.id);
  }
  return map;
}

async function resolveActiveSnapshot(branchIds, db = pool) {
  const generationByBranch = await getActiveGenerationIds(branchIds, db);
  const activeGenerationIds = [...new Set([...generationByBranch.values()])];
  return {
    branchIds: branchIds || [],
    generationByBranch,
    activeGenerationIds,
  };
}

function generationFilterSql(columnRef, activeGenerationIds, paramIndex) {
  if (!activeGenerationIds?.length) {
    return { clause: '', params: [] };
  }
  return {
    clause: ` AND (${columnRef} IS NULL OR ${columnRef} IN (SELECT value FROM json_each($${paramIndex})))`,
    params: [activeGenerationIds],
  };
}

async function beginGeneration({
  projectId,
  repositoryId,
  branchId,
  revisionSha = null,
  config = {},
  extractorVersion = 'ingest.js',
  indexerVersion = 'ingest.js',
  db = pool,
}) {
  const previous = await getActiveGenerationForBranch(branchId, db);
  const configHash = hashIngestConfig(config);
  const { rows } = await db.query(
    `INSERT INTO ingest_generations (
       project_id, repository_id, repository_branch_id, revision_sha,
       config_hash, extractor_version, indexer_version, status,
       previous_generation_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'VALIDATING', $8)
     RETURNING *`,
    [
      projectId,
      repositoryId,
      branchId,
      revisionSha,
      configHash,
      extractorVersion,
      indexerVersion,
      previous?.id || null,
    ],
  );
  return rows[0];
}

async function activateGeneration(generationId, db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [generation] } = await client.query(
      // B9: was FOR UPDATE. The row is read and then written inside the same transaction that
      // BEGINs two lines above; with one writer that transaction is the exclusion.
      `SELECT id, repository_branch_id, status
         FROM ingest_generations
        WHERE id = $1`,
      [generationId],
    );
    if (!generation) {
      throw new Error(`ingest generation ${generationId} not found`);
    }
    if (generation.status === 'ACTIVE') {
      await client.query('COMMIT');
      return generation;
    }
    if (!['PENDING', 'VALIDATING'].includes(generation.status)) {
      throw new Error(`cannot activate generation ${generationId} in status ${generation.status}`);
    }

    const { rows: superseded } = await client.query(
      `UPDATE ingest_generations
          SET status = 'SUPERSEDED',
              completed_at = COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        WHERE repository_branch_id = $1
          AND status = 'ACTIVE'
          AND id <> $2
      RETURNING id`,
      [generation.repository_branch_id, generationId],
    );

    const { rows: [activated] } = await client.query(
      `UPDATE ingest_generations
          SET status = 'ACTIVE',
              completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = $1
      RETURNING *`,
      [generationId],
    );

    await client.query('COMMIT');
    return { ...activated, supersededGenerationIds: superseded.map((r) => r.id) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function failGeneration(generationId, diagnostics = {}, db = pool) {
  const { rows } = await db.query(
    `UPDATE ingest_generations
        SET status = 'FAILED',
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            diagnostics = COALESCE($2, diagnostics)
      WHERE id = $1
        AND status IN ('PENDING', 'VALIDATING')
    RETURNING *`,
    [generationId, diagnostics ? JSON.stringify(diagnostics) : null],
  );
  return rows[0] || null;
}

async function listActiveSnapshotNodes(branchId, db = pool) {
  const snapshot = await resolveActiveSnapshot([branchId], db);
  const activeGenerationIds = snapshot.activeGenerationIds;
  if (!activeGenerationIds.length) {
    const { rows } = await db.query(
      `SELECT id, name, canonical_key, ingest_generation_id
         FROM nodes
        WHERE repository_branch_id = $1
          AND approval_status = 'APPROVED'
        ORDER BY id`,
      [branchId],
    );
    return rows;
  }
  const { rows } = await db.query(
    `SELECT id, name, canonical_key, ingest_generation_id
       FROM nodes
      WHERE repository_branch_id = $1
        AND approval_status = 'APPROVED'
        AND (ingest_generation_id IS NULL OR ingest_generation_id IN (SELECT value FROM json_each($2)))
      ORDER BY id`,
    [branchId, activeGenerationIds],
  );
  return rows;
}

module.exports = {
  hashIngestConfig,
  getActiveGenerationForBranch,
  getActiveGenerationIds,
  resolveActiveSnapshot,
  generationFilterSql,
  beginGeneration,
  activateGeneration,
  failGeneration,
  listActiveSnapshotNodes,
  ACTIVE_STATUSES,
  IN_FLIGHT_STATUSES,
};
