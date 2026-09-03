'use strict';

const pool = require('../db/pool');
const { looksBinary } = require('./ingest-policy');

// Regex patterns for files that look like they may contain secrets.
// These are path-based heuristics — actual secret scanning is a future concern.
// `(?:\.\w+)*` not `(?:\.\w+)?`: one optional suffix segment let the whole Next/CRA/Vite
// `.env.<mode>.local` cascade through — `.env.development.local`, `.env.test.local` and
// `.env.local.bak` all missed. `secrets?` gains a directory form because `config/secrets/db.yaml`
// is as common as `secrets.yaml`, and the tail adds the credential files a service repo actually
// carries: .envrc, .pgpass, .htpasswd, terraform tfvars, and service-account / *-key JSON.
const SECRET_PATH_RE = /(?:^|\/)(?:\.env(?:\.\w+)*|\.envrc|credentials?(?:\.\w+)*|secrets?(?:\.\w+)*|secrets?\/[^/]+|\.aws\/credentials|\.npmrc|\.pypirc|\.pgpass|\.htpasswd|id_rsa|id_ed25519|.*\.tfvars|.*service-account.*\.json|.*[-_]key\.json|.*\.pem|.*\.key|.*\.p12|.*\.pfx)$/i;

// Content-based heuristic: look for patterns that strongly suggest credential values.
// Two shapes, because the `KEY = value` form is blind to the two formats an ICP repo most often
// hides a credential in. Proven: docker-compose.override.yml carrying `POSTGRES_PASSWORD: <secret>`
// and a config.json carrying `"db_password": "<secret>"` both reached nodes.raw_evidence,
// file_source_cache, file_text_chunks_fts and method_text_index, and search_code returned them.
// The separator class covers `=`, `:` (YAML) and `":` (JSON); the key alternation is a substring
// match so DB_PASSWORD, POSTGRES_PASSWORD and db_password all hit.
const SECRET_KEY_WORDS = 'SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|TOKEN|CREDENTIAL';
const SECRET_CONTENT_RE = new RegExp(
  `(?:^|[\\n{,])\\s*["']?[A-Za-z0-9_.\\-]*(?:${SECRET_KEY_WORDS})[A-Za-z0-9_.\\-]*["']?\\s*[:=]\\s*["']?[A-Za-z0-9+/=_\\-]{12,}`,
  'im'
);

// The cache covers every readable text file, and all of it is copied into a second, indexed
// table. Scan the WHOLE file for the secret-content heuristic whenever it is under
// LEXICAL_MAX_FILE_BYTES (files above that are never cached at all — see cacheableTextDecision —
// so there is no silent partial-scan gap).
const LEXICAL_MAX_FILE_BYTES = parseInt(process.env.LEXICAL_MAX_FILE_BYTES, 10) || 1048576;

function hasSecretLookingContent(content) {
  if (!content) return false;
  const scanWindow = Buffer.byteLength(content, 'utf8') <= LEXICAL_MAX_FILE_BYTES
    ? content
    : content.slice(0, 8192);
  return SECRET_CONTENT_RE.test(scanWindow);
}

function isSecretPath(filePath) {
  return SECRET_PATH_RE.test(filePath);
}

/**
 * Write a source cache entry for a file processed during ingest.
 * Called BEFORE node extraction so citations can later reconstruct exact lines.
 *
 * @param {object} opts
 * @param {number} opts.repositoryBranchId
 * @param {number} opts.fileId
 * @param {string} opts.fileSha
 * @param {string} opts.path
 * @param {string|null} opts.content - file text (null if skipped)
 * @param {string|null} opts.skipReason - set when content is not stored
 */
async function writeSourceCache({ repositoryBranchId, fileId, fileSha, path: filePath, content, skipReason, ingestGenerationId = null }) {
  const byteSize = content != null ? Buffer.byteLength(content, 'utf8') : null;
  await pool.query(
    `INSERT INTO file_source_cache
       (repository_branch_id, file_id, file_sha, path, content, byte_size, skip_reason, ingest_generation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (file_id, file_sha) DO UPDATE SET
       content    = EXCLUDED.content,
       byte_size  = EXCLUDED.byte_size,
       skip_reason = EXCLUDED.skip_reason,
       ingest_generation_id = COALESCE(EXCLUDED.ingest_generation_id, file_source_cache.ingest_generation_id),
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    [repositoryBranchId, fileId, fileSha, filePath, content ?? null, byteSize, skipReason ?? null, ingestGenerationId]
  );
}

/**
 * Determine whether a file's source should be stored in the cache.
 * Returns { store: bool, skipReason: string|null }.
 *
 * Rules:
 *   - Secret-looking path → skip
 *   - Content has credential-looking values → skip
 *   - Binary SKIP_EXTS are already excluded by walkRepo; not re-checked here
 */
function shouldCacheSource(filePath, content) {
  if (isSecretPath(filePath)) {
    return { store: false, skipReason: 'secret_path' };
  }
  if (hasSecretLookingContent(content)) {
    return { store: false, skipReason: 'secret_content' };
  }
  return { store: true, skipReason: null };
}

/**
 * Decide whether a raw file buffer (not yet decoded) should be cached as text.
 * Used by the presence-floor / binary-stub tails, which read the file as a
 * Buffer directly off disk rather than via the extract path's already-decoded string.
 *
 * Order matters: oversize check first (avoids decoding a buffer we're about to discard),
 * then binary sniff on the raw bytes (decoding a binary buffer to UTF-8 before this check
 * corrupts it and wastes the work), and only then the string-based secret checks.
 *
 * @param {string} relPath
 * @param {Buffer} buffer
 * @param {{maxBytes?: number}} [opts]
 * @returns {{store: boolean, skipReason: string|null}}
 */
function cacheableTextDecision(relPath, buffer, { maxBytes = LEXICAL_MAX_FILE_BYTES } = {}) {
  // Accepts a string as well as a Buffer. Every ingest call site already holds the decoded text and
  // was writing `Buffer.from(content, 'utf8')` purely to be measured here — two extra copies of the
  // file (encode, then the decode below) for a question `Buffer.byteLength` answers for free. On the
  // oversize path, which is the only path a 27 MB artifact takes, nothing is allocated at all now.
  if (typeof buffer === 'string') {
    if (Buffer.byteLength(buffer, 'utf8') > maxBytes) return { store: false, skipReason: 'oversize' };
    return cacheableTextDecision(relPath, Buffer.from(buffer, 'utf8'), { maxBytes });
  }
  if (!buffer || buffer.length > maxBytes) {
    return { store: false, skipReason: 'oversize' };
  }
  if (looksBinary(buffer)) {
    return { store: false, skipReason: 'binary' };
  }
  const content = buffer.toString('utf8');
  return shouldCacheSource(relPath, content);
}

/**
 * Retrieve a source excerpt from the cache.
 *
 * @param {object} opts
 * @param {number} opts.fileId
 * @param {number|null} [opts.startLine] - 1-based inclusive
 * @param {number|null} [opts.endLine]   - 1-based inclusive
 * @param {string|null} [opts.fileSha]   - if provided, only matches this exact SHA
 * @param {object|null} [opts._pool]     - injectable DB pool for tests
 * @returns {Promise<{ text: string|null, verified: boolean, reason: string|null, fileSha: string|null }>}
 */
async function getSourceExcerpt({ fileId, startLine = null, endLine = null, fileSha = null, activeGenerationIds = null, _pool = null }) {
  if (!Number.isFinite(fileId)) {
    return { text: null, verified: false, reason: 'invalid_file_id', fileSha: null };
  }

  const _db = _pool || pool;
  const params = [fileId];
  let sql = `SELECT file_sha, content, skip_reason FROM file_source_cache WHERE file_id = $1`;
  if (fileSha) {
    params.push(fileSha);
    sql += ` AND file_sha = $${params.length}`;
  }
  if (activeGenerationIds?.length) {
    params.push(activeGenerationIds);
    sql += ` AND (ingest_generation_id IS NULL OR ingest_generation_id IN (SELECT value FROM json_each($${params.length})))`;
  }
  sql += ` ORDER BY created_at DESC LIMIT 1`;

  const { rows } = await _db.query(sql, params);

  if (!rows.length) {
    return { text: null, verified: false, reason: 'cache_miss', fileSha: null };
  }

  const row = rows[0];

  if (row.skip_reason) {
    return { text: null, verified: false, reason: row.skip_reason, fileSha: row.file_sha };
  }

  if (!row.content) {
    return { text: null, verified: false, reason: 'no_content', fileSha: row.file_sha };
  }

  let text = row.content;
  const hasValidSpan = Number.isFinite(startLine) && Number.isFinite(endLine) && startLine >= 1 && endLine >= startLine;

  if (hasValidSpan) {
    const lines = text.split(/\r?\n/);
    text = lines.slice(startLine - 1, endLine).join('\n');
    if (!text) {
      return { text: null, verified: false, span: null, reason: 'span_out_of_range', fileSha: row.file_sha };
    }
    return { text, verified: true, span: { startLine, endLine }, reason: null, fileSha: row.file_sha };
  }

  // No line span requested/available — never claim a whole-file dump is a verified excerpt.
  return { text, verified: false, span: null, reason: 'no_line_span', fileSha: row.file_sha };
}

/**
 * Batch-fetch the current file_sha for a set of file IDs from files.
 * Used for freshness checking: comparing the SHA stored in the source cache
 * against the SHA currently on the selected branch.
 *
 * @param {number[]} fileIds
 * @returns {Promise<Map<number, string>>}  fileId → current file_sha (null if not found)
 */
async function getCurrentFileShasBatch(fileIds) {
  const ids = (fileIds || []).filter(id => Number.isFinite(id));
  if (!ids.length) return new Map();

  const { rows } = await pool.query(
    `SELECT id, file_sha FROM files WHERE id IN (SELECT value FROM json_each($1))`,
    [ids]
  );
  const result = new Map();
  for (const row of rows) {
    result.set(row.id, row.file_sha || null);
  }
  return result;
}

module.exports = {
  writeSourceCache,
  getSourceExcerpt,
  shouldCacheSource,
  cacheableTextDecision,
  getCurrentFileShasBatch,
  isSecretPath,
  hasSecretLookingContent,
  LEXICAL_MAX_FILE_BYTES,
};
