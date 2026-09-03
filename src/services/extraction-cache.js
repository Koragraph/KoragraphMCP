'use strict';

// Free re-ingest. Content-derived cache: identical (content, relPath) never pays for AST
// parse + LLM extraction twice, gated on an `indexer_fingerprint` hash of the extraction
// code itself so a code change invalidates every row without a hand-maintained version
// constant (the exact rot pattern `changed-file-replacement.js`'s
// `EXTRACTOR_VERSION = 'ingest.js'` is called out for).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../db/pool');

const EXTRACTORS_DIR = path.join(__dirname, 'extractors');
const RESOLUTION_DIR = path.join(__dirname, 'resolution');
const AST_EXTRACTOR_FILE = path.join(__dirname, 'ast-extractor.js');
// The fingerprint means "a change to the extraction code invalidates every cached row", so
// it must hash every source that materially shapes the cached payload — not only the four
// above but also:
//   classifier.js            -> fileType, which selects both the parser path and the prompt
//   ingest-file-processor.js -> parserPathForContent, shouldSkipLlmForParser, the .vue
//                               ported carve-out, and the LLM retry/schema-repair loop
//   ingest-helpers.js        -> parseNodes / validateExtractionNodes / groundNode, which
//                               decide what the LLM half of a cached row even contains
// Without them a code change ships while every previously-ingested repo keeps serving the
// pre-change extraction back from cache.
const CLASSIFIER_FILE = path.join(__dirname, 'classifier.js');
const FILE_PROCESSOR_FILE = path.join(__dirname, 'ingest-file-processor.js');
const INGEST_HELPERS_FILE = path.join(__dirname, 'ingest-helpers.js');

function _listFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(..._listFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

let _fingerprintCache = null;

// Memoized for the life of the process — these files don't change while a process is
// running, and re-hashing ~15KB of source per file would be wasted work on every one of
// thousands of files in a real ingest.
function computeIndexerFingerprint() {
  if (_fingerprintCache) return _fingerprintCache;

  const files = [
    ..._listFilesRecursive(EXTRACTORS_DIR),
    ..._listFilesRecursive(RESOLUTION_DIR),
    ...[AST_EXTRACTOR_FILE, CLASSIFIER_FILE, FILE_PROCESSOR_FILE, INGEST_HELPERS_FILE]
      .filter((f) => fs.existsSync(f)),
  ];

  const hash = crypto.createHash('sha256');
  for (const f of files) {
    hash.update(f);
    hash.update(' ');
    hash.update(fs.readFileSync(f, 'utf8'));
    hash.update(' ');
  }

  _fingerprintCache = hash.digest('hex');
  return _fingerprintCache;
}

function computeCacheKey(content, relPath) {
  return crypto.createHash('sha256').update(content || '').update('\x00').update(relPath || '').digest('hex');
}

// Returns { astNodes, llmNodes, edgeBucket } on a genuine hit, or null on a miss
// (no row, fingerprint mismatch, partial result, or an empty-node row that should never
// have been written — defensive, since the write side already refuses those).
async function getCachedExtraction(cacheKey, fingerprint, deps = {}) {
  const queryFn = deps.query || pool.query.bind(pool);
  const { rows } = await queryFn(
    `SELECT indexer_fingerprint, nodes, edges, partial
       FROM file_extraction_cache WHERE cache_key = $1`,
    [cacheKey],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.indexer_fingerprint !== fingerprint) return null;

  // last_hit_at is the GC's cold-row signal. Bumped only on a genuine hit (fingerprint
  // matched); a stale-fingerprint row below must not look "recently used" just because it
  // was looked up.
  queryFn(
    `UPDATE file_extraction_cache SET last_hit_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE cache_key = $1`,
    [cacheKey],
  ).catch(() => {}); // best-effort bookkeeping — never block a cache hit on it

  const nodesPayload = row.nodes || {};
  const astNodes = Array.isArray(nodesPayload.ast) ? nodesPayload.ast : [];
  const llmNodes = Array.isArray(nodesPayload.llm) ? nodesPayload.llm : [];
  if (astNodes.length === 0 && llmNodes.length === 0) return null;

  // `partial` means only "the LLM plane saw a chunk-truncated view of an oversize file", not
  // "this row is unusable". Since ingest-file-processor.js parses the AST plane against the
  // full rawContent regardless of chunking, an oversize row's AST half is exactly as complete
  // as a non-chunked row's. A row is still refused when its AST plane was genuinely never
  // completed (`ast_complete !== true`) — that is the "gap made permanent" failure mode this
  // guards against.
  const astComplete = nodesPayload.properties?.ast_complete === true;
  if (row.partial && !astComplete) return null;

  return { astNodes, llmNodes, edgeBucket: row.edges || {} };
}

// Never caches a zero-node result — a large share of extractions return zero nodes, and
// caching that would make the gap permanent instead of self-healing on the next real ingest.
// A `partial` (LLM-truncated) result is still refused unless its AST plane completed
// (`astComplete`), now that the AST and LLM planes can diverge.
async function putCachedExtraction({ cacheKey, fingerprint, astNodes, llmNodes, edgeBucket, partial, astComplete }, deps = {}) {
  const astCount = astNodes?.length || 0;
  const llmCount = llmNodes?.length || 0;
  if (astCount === 0 && llmCount === 0) return false;
  if (partial && astComplete !== true) return false;
  // Under PARSER_FIRST the LLM plane is deliberately skipped
  // (ingest-file-processor.js#shouldSkipLlmForParser), so a zero-llmNodes result here is
  // "structurally complete, semantically empty by construction" rather than a genuine miss.
  // Caching it would let a later PARSER_FIRST=off/on-flip run silently reuse a row that never
  // even attempted the semantic plane instead of extracting it for real.
  if (process.env.PARSER_FIRST === 'true' && astCount > 0 && llmCount === 0) return false;

  const queryFn = deps.query || pool.query.bind(pool);
  await queryFn(
    `INSERT INTO file_extraction_cache (cache_key, indexer_fingerprint, nodes, edges, partial, updated_at)
     VALUES ($1, $2, $3, $4, $5, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT (cache_key) DO UPDATE
       SET indexer_fingerprint = EXCLUDED.indexer_fingerprint,
           nodes = EXCLUDED.nodes,
           edges = EXCLUDED.edges,
           partial = EXCLUDED.partial,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           last_hit_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    [
      cacheKey,
      fingerprint,
      JSON.stringify({ ast: astNodes || [], llm: llmNodes || [], properties: { ast_complete: !!astComplete } }),
      JSON.stringify(edgeBucket || {}),
      !!partial,
    ],
  );
  return true;
}

const GC_STALE_CUTOFF = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')";

// The cache had no eviction, so a row written under a fingerprint that later became
// unreachable (extractor code changed) sat forever. Deletes any row that is either cold (no
// hit in 30 days) OR whose indexer_fingerprint is not the current one — the second clause
// fires immediately on a code change even if the row was hit an hour ago, because a
// fingerprint mismatch already makes getCachedExtraction() treat it as a miss forever.
async function runExtractionCacheGc(deps = {}) {
  const queryFn = deps.query || pool.query.bind(pool);
  const { rows } = await queryFn(
    `DELETE FROM file_extraction_cache
      WHERE last_hit_at < ${GC_STALE_CUTOFF}
         OR indexer_fingerprint IS NOT $1
      RETURNING cache_key`,
    [computeIndexerFingerprint()],
  );
  return rows.length;
}

module.exports = {
  computeIndexerFingerprint,
  computeCacheKey,
  getCachedExtraction,
  putCachedExtraction,
  runExtractionCacheGc,
  _resetFingerprintCacheForTest: () => { _fingerprintCache = null; },
};
