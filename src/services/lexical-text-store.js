'use strict';

// Write path for the lexical chunk table. Turns cached file text (file_source_cache)
// into deterministic line-window chunks in file_text_chunks via lexical-chunker.js.
// Every ingest write path calls writeFileChunks() immediately after the corresponding
// writeSourceCache() call — see the callsites in ingest-file-processor.js and ingest.js.

const pool = require('../db/pool');
const { bulkWrite } = require('../db/bulk');
const { chunkFileText, buildSearchText } = require('./lexical-chunker');


function isLexicalWriteEnabled() {
  return process.env.RETRIEVAL_LEXICAL_ENABLED !== 'false';
}

async function insertChunkRow(client, {
  repositoryBranchId, fileId, fileSha, path: filePath, ingestGenerationId,
  chunkIndex, startLine, endLine, chunkText, searchText,
}) {
  // DO UPDATE, not DO NOTHING (same rule as the bulk insert above): an unchanged file keeps the
  // same (branch,file,sha,index) key across re-ingests, so DO NOTHING left the row pinned to the
  // generation that first wrote it while writeNode re-stamped its nodes to the current one.
  // Retrieval filters both planes by the ACTIVE generation, so the drift made every
  // carried-forward chunk invisible to the lexical channel while its nodes stayed visible.
  await client.query(
    `INSERT INTO file_text_chunks
       (repository_branch_id, file_id, file_sha, path, chunk_index, start_line, end_line, chunk_text, search_text, ingest_generation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (repository_branch_id, file_id, file_sha, chunk_index)
     DO UPDATE SET ingest_generation_id =
       COALESCE(EXCLUDED.ingest_generation_id, file_text_chunks.ingest_generation_id)`,
    [repositoryBranchId, fileId, fileSha, filePath, chunkIndex, startLine, endLine, chunkText, searchText, ingestGenerationId ?? null]
  );
}

/**
 * Chunk a file's cached text and write it to file_text_chunks, deleting any
 * chunks left over from a previous file_sha in the same transaction (per-file retention;
 * Track 4c does generation-level retention).
 *
 * @param {object} opts
 * @param {number} opts.repositoryBranchId
 * @param {number} opts.fileId
 * @param {string} opts.fileSha
 * @param {string} opts.path
 * @param {string|null} opts.content - null means "nothing to chunk" (binary/skipped/uncached)
 * @param {number|null} [opts.ingestGenerationId]
 * @param {Function} [opts.queryFn] - injectable query function for tests; when omitted a real
 *   pool client is checked out and the write runs in its own BEGIN/COMMIT transaction.
 * @returns {Promise<{chunks:number, skipped:string|null, oversizeSearchText:number, unchunkable:number, truncated:boolean}>}
 */
async function writeFileChunks({
  repositoryBranchId, fileId, fileSha, path: filePath, content,
  ingestGenerationId = null, queryFn = null,
}) {
  if (!isLexicalWriteEnabled()) {
    return { chunks: 0, skipped: 'disabled', oversizeSearchText: 0, truncated: false };
  }
  if (content == null) {
    return { chunks: 0, skipped: 'no_content', oversizeSearchText: 0, truncated: false };
  }

  const chunks = chunkFileText(content);
  if (chunks.length === 0) {
    return { chunks: 0, skipped: 'empty', oversizeSearchText: 0, truncated: false };
  }

  const ownsClient = !queryFn;
  const client = ownsClient ? await pool.connect() : { query: queryFn };
  let oversizeSearchText = 0;
  let unchunkable = 0;

  try {
    await client.query('BEGIN');

    // Per-file retention: the file changed, its old chunks under a prior file_sha are dead.
    await client.query(
      `DELETE FROM file_text_chunks WHERE repository_branch_id = $1 AND file_id = $2 AND file_sha <> $3`,
      [repositoryBranchId, fileId, fileSha]
    );

    const precomputed = chunks.map((c) => ({
      ...c,
      searchText: buildSearchText(c.chunk_text).searchText,
    }));

    // FTS5 has no per-value size cap, so there is no fallback path here for the oversized-value
    // case that Postgres's tsvector column would have rejected.
    //
    // The counters stay in the return shape: callers read them, and 0 is now the honest value.
    await bulkWrite(client,
      `INSERT INTO file_text_chunks
         (repository_branch_id, file_id, file_sha, path, chunk_index, start_line, end_line, chunk_text, search_text, ingest_generation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (repository_branch_id, file_id, file_sha, chunk_index)
       DO UPDATE SET ingest_generation_id =
         COALESCE(EXCLUDED.ingest_generation_id, file_text_chunks.ingest_generation_id)`,
      precomputed.map((c) => [
        repositoryBranchId, fileId, fileSha, filePath, c.chunk_index,
        c.start_line, c.end_line, c.chunk_text, c.searchText, ingestGenerationId,
      ]));

    await client.query('COMMIT');
    return { chunks: chunks.length - unchunkable, oversizeSearchText, unchunkable, truncated: !!chunks.truncated };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_rollbackErr) {
      // best-effort; the original error is what matters
    }
    throw err;
  } finally {
    if (ownsClient) client.release();
  }
}

/**
 * Track 4c retention: delete chunk rows that are BOTH (a) tagged to a generation outside the
 * branch's currently-active set, AND (b) no longer the branch's current file_sha for that
 * file_id. Per-file retention (the DELETE inside writeFileChunks, above) only fires for the
 * specific file being rewritten in this ingest; this is the branch-wide sweep that catches
 * everything else a generation left behind (deleted files, files whose content changed on a
 * run that never re-ran writeFileChunks for them, etc.) without touching rows that are still
 * the live content for their file (those are safe to keep regardless of generation tag —
 * ingest-generation-service's generationFilterSql already lets NULL/active-generation rows
 * through at read time).
 *
 * @param {object} opts
 * @param {number} opts.branchId
 * @param {number[]} opts.activeGenerationIds - generations considered live for this branch;
 *   rows tagged to any other generation (and whose file_sha is stale) are pruned. An empty
 *   array means "no generation is active yet" and prunes on file_sha alone.
 * @param {Function} [opts.queryFn] - injectable query function for tests; defaults to a real
 *   pool client.
 * @returns {Promise<{deleted: number}>}
 */
async function pruneSupersededChunks({ branchId, activeGenerationIds = [], queryFn = null }) {
  const ids = (activeGenerationIds || []).filter((id) => Number.isFinite(id));
  const client = queryFn ? { query: queryFn } : pool;

  // SQLite's DELETE takes no table ALIAS — `DELETE FROM t c WHERE c.x` is a syntax error, and it
  // fails at prepare time on the alias, not on anything recognisable. Unqualified column names
  // refer to the target table, which is what the alias was doing.
  const generationClause = ids.length
    ? `(ingest_generation_id IS NULL OR ingest_generation_id NOT IN (SELECT value FROM json_each($2)))`
    : `ingest_generation_id IS NOT NULL`;
  const params = ids.length ? [branchId, ids] : [branchId];

  const { rowCount } = await client.query(
    `DELETE FROM file_text_chunks
      WHERE repository_branch_id = $1
        AND ${generationClause}
        AND file_sha <> (
          SELECT f.file_sha FROM files f WHERE f.id = file_text_chunks.file_id
        )`,
    params
  );
  return { deleted: rowCount || 0 };
}

module.exports = {
  writeFileChunks,
  pruneSupersededChunks,
  isLexicalWriteEnabled,
};
