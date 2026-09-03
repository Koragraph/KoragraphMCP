'use strict';

// A genuinely new, OPT-IN channel, not a change to any default. `retrieval-lexical.js` ranks
// CHUNKS (file_text_chunks, a line-windowed, lossy view of a file), then anchors the winning chunk
// to a node. For a prose issue that names symptoms and file paths rather than identifiers, ranking
// whole FILES by full-file text is closer to a plain BM25-over-files baseline. This ranks
// `file_source_cache` (the verbatim per-file content koragraph already caches at ingest, keyed to
// the file's CURRENT file_sha), scored by FTS5 bm25() the same way `retrieval-lexical.js` scores
// chunks.
//
// Deliberately NOT added to ALL_CHANNELS/T1_CHANNELS in retrieval-channels.js — see the comment
// there ("adding a channel to ALL_CHANNELS must never silently change what an un-escalated T1 pass
// runs"). This channel only runs when a caller explicitly requests 'file_lexical', so the shipped
// default retrieval path is byte-identical until someone opts in.

const pool = require('../db/pool');
const { generationFilterSql } = require('./ingest-generation-service');
const { tokenizeLexicalQuery } = require('./retrieval-lexical');
const { QUERY_TIMEOUT_CODE } = require('../db/sqlite-pool');

const FILE_LEXICAL_CHANNEL_LIMIT = parseInt(process.env.RETRIEVAL_FILE_LEXICAL_CHANNEL_LIMIT || '32', 10);
const FILE_CANDIDATE_MULTIPLIER = 8;
const MIN_FILE_CANDIDATES = 64;

// classify()'s non-code roles — the generic "no extractable content" bucket ('FILE'), docs, tests
// (excluded on principle too: the answer to a fix-this-bug query is a source file, never a test
// file), and manifests that carry no behavior. A whitelist of EXTRACTABLE_TYPES (classifier.js)
// would wrongly drop every route-2/3 language (Swift, Rust, Scala, ...), which land in
// SOURCE_GENERIC, not a stack-specific role — this is a blocklist of the handful of roles that are
// never source, not an allowlist. BM25 rewards a short document for the same term density a long
// file dilutes, so an unfiltered full-file BM25 pass can rank a short release-notes file above a
// long source file that is the real answer; the filter keeps ranking scoped to files that can
// plausibly be one.
const NON_CODE_FILE_TYPES = new Set(['FILE', 'DOC', 'TEST', 'README', 'SCHEMA', 'OTHER', 'CONTRACT_CONFIG']);

function resolveTimeoutMs() {
  return parseInt(process.env.RETRIEVAL_FILE_LEXICAL_TIMEOUT_MS || '1500', 10);
}

function emptyResult(extra = {}) {
  return {
    channel: 'file_lexical',
    status: 'unavailable',
    candidate_count: 0,
    hit: false,
    latency_ms: 0,
    candidates: [],
    storage_bytes: 0,
    orphan_files: 0,
    ...extra,
  };
}

async function retrieveFileLexicalChannel(queryText, branchIds, activeGenerationIds, limit = FILE_LEXICAL_CHANNEL_LIMIT) {
  const started = Date.now();

  if (!branchIds || !branchIds.length) {
    return emptyResult();
  }

  const { tokens, truncated } = tokenizeLexicalQuery(queryText);
  if (!tokens.length) {
    return emptyResult();
  }

  const fileCandidateLimit = Math.max(limit * FILE_CANDIDATE_MULTIPLIER, MIN_FILE_CANDIDATES);
  const timeoutMs = resolveTimeoutMs();
  const releaseDeadline = pool.setQueryDeadline ? pool.setQueryDeadline(timeoutMs) : null;

  const matchExpr = tokens.map((t) => `"${String(t).replace(/"/g, '""')}"`).join(' OR ');
  const genFilter = generationFilterSql('fsc.ingest_generation_id', activeGenerationIds, 4);
  const fileLimitIdx = 4 + genFilter.params.length;

  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;

    // Join on files.file_sha = file_source_cache.file_sha so a stale row left behind by an
    // incremental re-ingest (file_source_cache has no per-file retention sweep, unlike
    // file_text_chunks' pruneSupersededChunks) never outranks the file's current content.
    const matchedCte = `
      WITH matched AS (
        SELECT
          fsc.id AS cache_id,
          fsc.repository_branch_id,
          fsc.file_id,
          fsc.path,
          -bm25(file_source_cache_fts) AS lexical_score
        FROM file_source_cache_fts
        JOIN file_source_cache fsc ON fsc.id = file_source_cache_fts.rowid
        JOIN files f ON f.id = fsc.file_id AND f.file_sha = fsc.file_sha
        WHERE file_source_cache_fts MATCH $2
          AND fsc.repository_branch_id IN (SELECT value FROM json_each($1))
          AND (f.file_type IS NULL OR f.file_type NOT IN (SELECT value FROM json_each($3)))
          AND _deadline_check()
          ${genFilter.clause}
        ORDER BY lexical_score DESC
        LIMIT $${fileLimitIdx}
      )`;
    const matchedParams = [branchIds, matchExpr, [...NON_CODE_FILE_TYPES], ...genFilter.params, fileCandidateLimit];

    const sql = `
    ${matchedCte}
    SELECT
      m.cache_id, m.repository_branch_id, m.file_id, m.path, m.lexical_score,
      file_node.id AS file_node_id,
      any_node.id AS any_node_id,
      COALESCE(file_node.id, any_node.id) AS node_id,
      COALESCE(file_node.name, any_node.name) AS name,
      COALESCE(file_node.node_type, any_node.node_type) AS node_type,
      COALESCE(file_node.summary, any_node.summary) AS summary,
      COALESCE(file_node.properties, any_node.properties) AS properties
    FROM matched m
    LEFT JOIN nodes file_node ON file_node.id = (
      SELECT n.id FROM nodes n
      WHERE n.repository_branch_id = m.repository_branch_id
        AND n.file_id = m.file_id
        AND n.node_type = 'FILE'
        AND n.approval_status = 'APPROVED'
      ORDER BY n.id ASC LIMIT 1
    )
    LEFT JOIN nodes any_node ON any_node.id = (
      SELECT n.id FROM nodes n
      WHERE n.repository_branch_id = m.repository_branch_id
        AND n.file_id = m.file_id AND n.approval_status = 'APPROVED'
      ORDER BY n.id ASC LIMIT 1
    )`;

    const { rows } = await client.query(sql, matchedParams);
    await client.query('COMMIT');
    inTransaction = false;

    let maxScore = 0;
    for (const row of rows) {
      const v = Number(row.lexical_score) || 0;
      if (v > maxScore) maxScore = v;
    }
    const normalise = maxScore > 0 ? (v) => v / maxScore : (v) => v;

    let orphanFiles = 0;
    const byFile = new Map();
    for (const row of rows) {
      if (row.node_id == null) {
        orphanFiles += 1;
        continue;
      }
      // One row per file already (one matched row per file_source_cache row, and a file has at
      // most one current-sha cache row), but guard the merge anyway in case a repo re-uses a path.
      const score = normalise(Number(row.lexical_score) || 0);
      const existing = byFile.get(row.file_id);
      if (!existing || score > existing.score) byFile.set(row.file_id, { row, score });
    }

    const candidates = [...byFile.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ row, score }) => ({
        id: row.node_id,
        name: row.name,
        node_type: row.node_type,
        summary: row.summary,
        properties: {
          ...(row.properties || {}),
          file_lexical_path: row.path,
          file_lexical_anchor: row.file_node_id != null ? 'file' : 'file_any',
        },
        start_line: null,
        end_line: null,
        repository_branch_id: row.repository_branch_id,
        method_name: null,
        dense_score: 0,
        exact_match_score: 0,
        channel: 'file_lexical',
        channel_score: score,
        file_lexical_score: score,
      }));

    return {
      channel: 'file_lexical',
      status: 'executed',
      candidate_count: candidates.length,
      hit: candidates.length > 0,
      latency_ms: Date.now() - started,
      candidates,
      storage_bytes: candidates.length * 256,
      orphan_files: orphanFiles,
      query_tokens_truncated: truncated,
      rank_config: { rank_fn: 'bm25' },
    };
  } catch (err) {
    if (inTransaction) {
      try {
        await client.query('ROLLBACK');
      } catch (_rollbackErr) {
        // best-effort — the connection may already be unusable after a cancel
      }
    }
    if (err && err.code === QUERY_TIMEOUT_CODE) {
      return emptyResult({ reason: 'timeout', latency_ms: Date.now() - started });
    }
    throw err;
  } finally {
    if (releaseDeadline) releaseDeadline();
    client.release();
  }
}

module.exports = {
  retrieveFileLexicalChannel,
  FILE_LEXICAL_CHANNEL_LIMIT,
};
