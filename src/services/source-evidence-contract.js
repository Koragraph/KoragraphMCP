'use strict';

const pool = require('../db/pool');

const STRUCTURAL_NODE_TYPES = new Set([
  'METHOD', 'CLASS', 'FUNCTION', 'INTERFACE', 'ENUM', 'STRUCT',
  'NODE_SERVICE', 'NODE_CONTROLLER', 'ENDPOINT', 'ENTITY', 'IMPORT',
  'REACT_COMPONENT', 'GO_PACKAGE', 'KOTLIN_CLASS',
]);

const FILE_LEVEL_NODE_TYPES = new Set([
  'FILE', 'CONFIG', 'DOC', 'README', 'SERVICE', 'REPOSITORY',
]);

const SOURCE_CAPABILITY = {
  EXACT_SPAN: 'exact_span',
  FILE_LEVEL: 'file_level',
  HEURISTIC: 'heuristic',
  NONE: 'none',
};

const SPAN_TIER = {
  EXACT: 'exact',
  FILE_LEVEL: 'file_level',
  HEURISTIC: 'heuristic',
  NONE: 'none',
};

const FRESHNESS_STATUS = {
  CURRENT: 'current',
  STALE: 'stale',
  UNKNOWN: 'unknown',
  NOT_APPLICABLE: 'not_applicable',
};

function hasExactSpan(node) {
  return Number.isFinite(node.start_line)
    && Number.isFinite(node.end_line)
    && node.start_line >= 1
    && node.end_line >= node.start_line;
}

function resolveSpanTier(node) {
  if (!node.file_id) return SPAN_TIER.NONE;
  if (hasExactSpan(node)) {
    if (STRUCTURAL_NODE_TYPES.has(node.node_type)) return SPAN_TIER.EXACT;
    return SPAN_TIER.HEURISTIC;
  }
  if (FILE_LEVEL_NODE_TYPES.has(node.node_type) || node.file_id) return SPAN_TIER.FILE_LEVEL;
  return SPAN_TIER.HEURISTIC;
}

function resolveSourceCapability(node) {
  const tier = resolveSpanTier(node);
  if (tier === SPAN_TIER.EXACT) return SOURCE_CAPABILITY.EXACT_SPAN;
  if (tier === SPAN_TIER.FILE_LEVEL) return SOURCE_CAPABILITY.FILE_LEVEL;
  if (tier === SPAN_TIER.HEURISTIC) return SOURCE_CAPABILITY.HEURISTIC;
  return SOURCE_CAPABILITY.NONE;
}

function resolveFreshnessStatus(node) {
  if (!node.file_id) return FRESHNESS_STATUS.NOT_APPLICABLE;
  if (!node.file_sha_at_extract || !node.file_sha) return FRESHNESS_STATUS.UNKNOWN;
  if (node.file_sha_at_extract === node.file_sha) return FRESHNESS_STATUS.CURRENT;
  return FRESHNESS_STATUS.STALE;
}

function nodeNeedsSourceContract(node) {
  if (node.file_id != null) return true;
  return STRUCTURAL_NODE_TYPES.has(node.node_type) || FILE_LEVEL_NODE_TYPES.has(node.node_type);
}

function validateNodeSourceContract(node) {
  const failures = [];

  if (!nodeNeedsSourceContract(node)) {
    return {
      contract_ok: true,
      failures: [],
      optional: true,
      source_capability: resolveSourceCapability(node),
      span_tier: resolveSpanTier(node),
      freshness_status: resolveFreshnessStatus(node),
    };
  }

  if (node.file_id == null) failures.push('missing_file_id');
  if (node.repository_branch_id != null && node.repository_id == null) failures.push('missing_repository');
  if (node.repository_branch_id != null && !node.revision_sha) failures.push('missing_revision');
  if (node.file_id && !node.file_path) failures.push('missing_path');
  if (node.file_id && !node.file_sha) failures.push('missing_current_file_sha');
  if (node.file_id && !node.file_sha_at_extract) failures.push('missing_extracted_file_sha');

  const capability = resolveSourceCapability(node);
  if (STRUCTURAL_NODE_TYPES.has(node.node_type) && node.file_id && !hasExactSpan(node)) {
    failures.push('missing_exact_span');
    if (!Number.isFinite(node.end_line)) failures.push('missing_end_line');
  } else if (capability === SOURCE_CAPABILITY.EXACT_SPAN && !hasExactSpan(node)) {
    failures.push('missing_exact_span');
    if (!Number.isFinite(node.end_line)) failures.push('missing_end_line');
  }

  const freshness = resolveFreshnessStatus(node);
  if (freshness === FRESHNESS_STATUS.STALE) failures.push('stale_file_sha');
  if (node.file_id && node.has_source_cache === false) failures.push('source_cache_miss');

  return {
    contract_ok: failures.length === 0,
    failures,
    source_capability: capability,
    span_tier: resolveSpanTier(node),
    freshness_status: freshness,
  };
}

async function enrichNodesWithSourceIdentity(nodes, { db, activeGenerationIds } = {}) {
  if (!nodes || !nodes.length) return [];

  const pg = db || pool;
  const ids = [...new Set(nodes.map((n) => n.id).filter(Boolean))];
  if (!ids.length) return nodes.map((n) => ({ ...n }));

  const params = [ids];
  let cacheGenClause = '';
  if (activeGenerationIds?.length) {
    params.push(activeGenerationIds);
    cacheGenClause = `AND (fsc.ingest_generation_id IS NULL OR fsc.ingest_generation_id IN (SELECT value FROM json_each($${params.length})))`;
  }

  const { rows } = await pg.query(
    `SELECT
       n.id,
       n.file_id,
       n.file_sha_at_extract,
       n.start_line,
       n.end_line,
       n.node_type,
       n.repository_branch_id,
       f.path AS file_path,
       f.file_sha,
       rb.branch_name,
       rb.last_commit_sha AS revision_sha,
       r.id AS repository_id,
       r.name AS repository_name,
       EXISTS (
         SELECT 1 FROM file_source_cache fsc
         WHERE fsc.file_id = n.file_id
           AND fsc.skip_reason IS NULL
           AND fsc.content IS NOT NULL
           ${cacheGenClause}
       ) AS has_source_cache
     FROM nodes n
     LEFT JOIN files f ON f.id = n.file_id
     LEFT JOIN repository_branches rb ON rb.id = n.repository_branch_id
     LEFT JOIN repositories r ON r.id = rb.repository_id
     WHERE n.id IN (SELECT value FROM json_each($1))`,
    params,
  );

  const byId = new Map(rows.map((r) => [r.id, r]));

  return nodes.map((n) => {
    const row = byId.get(n.id);
    if (!row) {
      const stub = { ...n, has_source_cache: false };
      return { ...stub, source_evidence: validateNodeSourceContract(stub) };
    }

    const merged = {
      ...n,
      file_id: row.file_id ?? n.file_id ?? null,
      file_path: row.file_path ?? n.file_path ?? null,
      file_sha: row.file_sha ?? null,
      file_sha_at_extract: row.file_sha_at_extract ?? n.file_sha_at_extract ?? null,
      start_line: row.start_line ?? n.start_line ?? null,
      end_line: row.end_line ?? n.end_line ?? null,
      repository_branch_id: row.repository_branch_id ?? n.repository_branch_id,
      repository_id: row.repository_id ?? null,
      repository_name: row.repository_name ?? null,
      branch_name: row.branch_name ?? null,
      revision_sha: row.revision_sha ?? null,
      has_source_cache: !!row.has_source_cache,
    };

    merged.span_tier = resolveSpanTier(merged);
    merged.source_capability = resolveSourceCapability(merged);
    merged.freshness_status = resolveFreshnessStatus(merged);
    merged.source_evidence = validateNodeSourceContract(merged);

    return merged;
  });
}

function auditNodesSourceContract(nodes) {
  const issues = {
    missing_file_id: 0,
    missing_exact_span: 0,
    missing_end_line: 0,
    stale_file_sha: 0,
    source_cache_miss: 0,
    missing_current_file_sha: 0,
    missing_extracted_file_sha: 0,
    contract_failures: 0,
  };

  for (const n of nodes || []) {
    const v = n.source_evidence || validateNodeSourceContract(n);
    if (!v.contract_ok && !v.optional) {
      issues.contract_failures += 1;
      for (const f of v.failures) {
        issues[f] = (issues[f] || 0) + 1;
      }
    }
  }

  return {
    ok: issues.contract_failures === 0,
    total: nodes?.length || 0,
    issues,
  };
}

module.exports = {
  SOURCE_CAPABILITY,
  SPAN_TIER,
  FRESHNESS_STATUS,
  STRUCTURAL_NODE_TYPES,
  hasExactSpan,
  resolveSpanTier,
  resolveSourceCapability,
  resolveFreshnessStatus,
  nodeNeedsSourceContract,
  enrichNodesWithSourceIdentity,
  validateNodeSourceContract,
  auditNodesSourceContract,
};
