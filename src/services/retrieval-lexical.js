'use strict';

// Lexical channel. Reads file_text_chunks and matches raw source text.
//
// Chunk -> node mapping is a three-tier anchor cascade: innermost COMPLETE-span node containing
// the chunk, else the file's FILE node, else any approved node for the file. A plain
// `node_type = 'FILE'` join would return ~0 candidates for many files. `end_line IS NOT NULL` is
// required in tier 1: IMPORT nodes carry start_line but never end_line, and
// COALESCE(end_line, start_line) would turn every import into a winning 1-line span.

const pool = require('../db/pool');
const { generationFilterSql } = require('./ingest-generation-service');
const { camelSplit } = require('./lexical-chunker');

const LEXICAL_CHANNEL_LIMIT = parseInt(process.env.RETRIEVAL_LEXICAL_CHANNEL_LIMIT || '16', 10);
const LEXICAL_MAX_QUERY_TOKENS = parseInt(process.env.RETRIEVAL_LEXICAL_MAX_QUERY_TOKENS || '64', 10);
// tsquery nodes < 32,768; 64 emitted tokens is far below that and past the point
// where extra OR-terms add signal.
const CHUNK_CANDIDATE_MULTIPLIER = 8;
const MIN_CHUNK_CANDIDATES = 64;

// Read at call time (not module load) so a test can flip the env var without a
// process restart, same reasoning as resolveRankFn/resolveWeightsLiteral/resolveQueryIdf below.
function resolveTimeoutMs() {
  return parseInt(process.env.RETRIEVAL_LEXICAL_TIMEOUT_MS || '1500', 10);
}
// Raised by the pool's _deadline_check(). Replaces Postgres SQLSTATE 57014 (query_canceled):
// better-sqlite3 raises SQLITE_ERROR for everything, so an err.code === '57014' check would
// silently stop matching and this channel would throw instead of degrading — taking down every
// other channel's results with it.
const { QUERY_TIMEOUT_CODE } = require('../db/sqlite-pool');

// Query-side only. Leads with 0-9 as well as a letter so a numeric term ("404", "500", "8091",
// "oauth2") survives tokenisation — the corpus FTS already indexes those (nodes_fts MATCH '404'
// finds 61 chunks in fastify), but the old letter-leading class dropped "404" to zero tokens, so a
// query of "404" returned NOTHING while four-oh-four.js sat in the graph. Single bare digits are
// dropped below as noise; a query with no digit-leading token tokenises byte-identically to before.
const IDENTIFIER_RE = /[A-Za-z0-9_$][A-Za-z0-9_$]*/g;
const RESERVED_WORDS = new Set(['or', 'and', 'not']);

/**
 * Tokenize raw query text for the lexical channel's tsquery. Deliberately NOT
 * buildSearchText  — that emits the original text plus expansions, and raw query
 * text can carry tsquery operators (`websearch_to_tsquery('simple','foo or -bar
 * or "a b"')` -> `'foo' | !'bar' | 'a' <-> 'b'`). Extracting only identifier characters and
 * dropping the reserved words strips every operator before it ever reaches Postgres, and the
 * regex naturally splits on `.`/`/` so no separate dot/slash pass is needed on already-bare
 * identifier tokens.
 *
 * @param {string} queryText
 * @returns {{tokens: string[], truncated: boolean}}
 */
function tokenizeLexicalQuery(queryText) {
  const raw = String(queryText || '').match(IDENTIFIER_RE) || [];
  const tokens = [];
  const seen = new Set();
  let truncated = false;

  outer:
  for (const tok of raw) {
    const candidates = [tok, ...camelSplit(tok)];
    for (const candidate of candidates) {
      if (!candidate) continue;
      // A lone digit ("2", "3") is an index or a version fragment, not a search term, and matches
      // a huge share of the corpus. Multi-digit numbers (404, 500, 8091) are meaningful and kept.
      if (candidate.length < 2 && /^\d$/.test(candidate)) continue;
      const lower = candidate.toLowerCase();
      if (RESERVED_WORDS.has(lower) || seen.has(lower)) continue;
      seen.add(lower);
      tokens.push(candidate);
      if (tokens.length >= LEXICAL_MAX_QUERY_TOKENS) {
        truncated = true;
        break outer;
      }
    }
  }

  return { tokens, truncated };
}

// Read at call time, not module load, so the same process can be driven through multiple
// configurations by an eval harness without a restart. These values are server-controlled (env
// only, never request input) and constrained to a fixed whitelist below, so interpolating them
// directly into SQL text carries no injection risk.
function resolveRankFn() {
  // FTS5 offers bm25 and nothing with a cover-density analogue, so there is one ranking function.
  return 'bm25';
}

function resolveWeights() {
  // bm25()'s per-column weights are positional and this table is fts5(chunk_text, search_text).
  // Un-weighted is the DEFAULT: uniform strictly beat weighted on the lexical gold set.
  // RETRIEVAL_LEXICAL_WEIGHTED=true opts back in with a 2.5x column ratio.
  return process.env.RETRIEVAL_LEXICAL_WEIGHTED === 'true' ? [2.5, 1.0] : [1.0, 1.0];
}

// There is no separate query-side IDF leg: BM25's IDF component is the first factor of its
// formula, computed against the indexed corpus, so FTS5 does natively and per-query what a
// separate leg would do with extra round trips and a correlated per-token subquery. Keeping both
// would double-count document frequency.

function emptyResult(extra = {}) {
  return {
    channel: 'lexical',
    status: 'unavailable',
    candidate_count: 0,
    hit: false,
    latency_ms: 0,
    candidates: [],
    storage_bytes: 0,
    orphan_chunks: 0,
    lexical_anchor_distribution: { span: 0, file: 0, file_any: 0 },
    ...extra,
  };
}

async function retrieveLexicalChannel(queryText, branchIds, activeGenerationIds, limit = LEXICAL_CHANNEL_LIMIT) {
  const started = Date.now();

  if (!branchIds || !branchIds.length) {
    return emptyResult();
  }

  const { tokens, truncated } = tokenizeLexicalQuery(queryText);
  if (!tokens.length) {
    return emptyResult();
  }

  const chunkCandidateLimit = Math.max(limit * CHUNK_CANDIDATE_MULTIPLIER, MIN_CHUNK_CANDIDATES);
  const timeoutMs = resolveTimeoutMs();

  const weights = resolveWeights();

  // The timeout: `SET LOCAL statement_timeout` has no SQLite equivalent, and a setImmediate
  // deadline CANNOT fire either: better-sqlite3 is synchronous,
  // so the event loop is blocked for the whole query and no timer runs during it. SQLite's own
  // progress handler is the only mechanism that runs INSIDE the query, so that is what is used.
  // Dropping the guard was not an option — it exists because this query can run long, and losing
  // it turns a slow query into a hang.
  const releaseDeadline = pool.setQueryDeadline ? pool.setQueryDeadline(timeoutMs) : null;

  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;

    // FTS5 MATCH syntax, not tsquery. Each token is double-quoted so an identifier containing
    // FTS5 operator characters (-, *, ^,:, NEAR) is a literal term rather than syntax; an
    // embedded quote is doubled. `OR` reproduces websearch_to_tsquery('simple', 'a or b').
    const matchExpr = tokens.map((t) => `"${String(t).replace(/"/g, '""')}"`).join(' OR ');

    const genFilter = generationFilterSql('c.ingest_generation_id', activeGenerationIds, 5);
    const chunkLimitIdx = 5 + genFilter.params.length;

    // bm25() returns a NEGATIVE score, more negative = better match. Negated here so
    // lexical_score keeps the higher-is-better contract every consumer already assumes, and so
    // ORDER BY lexical_score DESC stays the ordering it always was.
    //
    // The old prefilter is gone with the thing it protected: it bounded how many rows
    // ts_rank_cd was computed over, and FTS5 ranks as it matches rather than scoring a
    // WHERE-matched set afterwards. chunkCandidateLimit still bounds the pool.
    const matchedCte = `
      WITH matched AS (
        SELECT
          c.id AS chunk_id,
          c.repository_branch_id,
          c.file_id,
          c.path,
          c.chunk_index,
          c.start_line,
          c.end_line,
          -bm25(file_text_chunks_fts, $3, $4) AS lexical_score
        FROM file_text_chunks_fts
        JOIN file_text_chunks c ON c.id = file_text_chunks_fts.rowid
        WHERE file_text_chunks_fts MATCH $2
          AND c.repository_branch_id IN (SELECT value FROM json_each($1))
          AND _deadline_check()
          ${genFilter.clause}
        ORDER BY lexical_score DESC
        LIMIT $${chunkLimitIdx}
      )`;
    const matchedParams = [branchIds, matchExpr, weights[0], weights[1],
      ...genFilter.params, chunkCandidateLimit];

    // The three anchor tiers. SQLite has no LATERAL, and a plain join is wrong: it returns EVERY
    // approved node for the file and fans one chunk out into one row per candidate instead of
    // collapsing to a single deterministic pick.
    //
    // Each tier becomes a correlated scalar subquery that yields one id, joined back to nodes for
    // its columns. That is exactly `LATERAL (... ORDER BY... LIMIT 1)` — one row or none, chosen
    // by the same ordering — without needing five subqueries per tier to carry five columns.
    const sql = `
    ${matchedCte}
    SELECT
      m.chunk_id,
      m.repository_branch_id,
      m.file_id,
      m.path,
      m.chunk_index,
      m.start_line,
      m.end_line,
      m.lexical_score,
      span_node.id   AS span_id,
      file_node.id   AS file_node_id,
      any_node.id    AS any_node_id,
      COALESCE(span_node.id, file_node.id, any_node.id) AS node_id,
      COALESCE(span_node.name, file_node.name, any_node.name) AS name,
      COALESCE(span_node.node_type, file_node.node_type, any_node.node_type) AS node_type,
      COALESCE(span_node.summary, file_node.summary, any_node.summary) AS summary,
      COALESCE(span_node.properties, file_node.properties, any_node.properties) AS properties
    FROM matched m
    -- tier 1: innermost node with a COMPLETE span containing the chunk.
    -- an import/config statement is never the right citation anchor for a behavioral
    -- claim, so it is excluded rather than deprioritized. The ordering is a second, independent
    -- guard: prefer a REAL (non-zero-width) span, so a placeholder stub still loses to an
    -- enclosing node with an actual body while remaining a valid last resort.
    LEFT JOIN nodes span_node ON span_node.id = (
      SELECT n.id FROM nodes n
      WHERE n.repository_branch_id = m.repository_branch_id
        AND n.file_id = m.file_id
        AND n.approval_status = 'APPROVED'
        AND n.node_type NOT IN ('IMPORT', 'CONFIG_VALUE', 'DEPENDENCY')
        AND n.start_line IS NOT NULL
        AND n.end_line   IS NOT NULL
        AND n.start_line <= m.end_line
        AND n.end_line   >= m.start_line
      ORDER BY (n.end_line = n.start_line) ASC, (n.end_line - n.start_line) ASC, n.id ASC
      LIMIT 1
    )
    -- tier 2: the file's FILE node (floored / stubbed files)
    LEFT JOIN nodes file_node ON file_node.id = (
      SELECT n.id FROM nodes n
      WHERE n.repository_branch_id = m.repository_branch_id
        AND n.file_id   = m.file_id
        AND n.node_type = 'FILE'
        AND n.approval_status = 'APPROVED'
      ORDER BY n.id ASC
      LIMIT 1
    )
    -- tier 3: ANY approved node for the file, deterministically
    LEFT JOIN nodes any_node ON any_node.id = (
      SELECT n.id FROM nodes n
      WHERE n.repository_branch_id = m.repository_branch_id
        AND n.file_id = m.file_id AND n.approval_status = 'APPROVED'
      ORDER BY n.id ASC LIMIT 1
    )
  `;

    const { rows } = await client.query(sql, matchedParams);
    await client.query('COMMIT');
    inTransaction = false;

    // bm25 is UNBOUNDED; ts_rank_cd was roughly 0-1. That difference is not cosmetic:
    // unionChannelCandidates merges channel_score with Math.max across channels, so a raw bm25
    // value of 25 would beat the exact channel's 0.5-1.0 on every candidate both channels find,
    // and applyFusionThresholds reads that same field.
    //
    // Normalised per query against the best score in the result set. Order is untouched (it is a
    // positive scalar divide), and the field means what its own comment two hundred lines down
    // says it means.
    let maxLexicalScore = 0;
    for (const row of rows) {
      const v = Number(row.lexical_score) || 0;
      if (v > maxLexicalScore) maxLexicalScore = v;
    }
    const normalise = maxLexicalScore > 0 ? (v) => v / maxLexicalScore : (v) => v;

    const anchorCounts = { span: 0, file: 0, file_any: 0 };
    let orphanChunks = 0;
    const byNode = new Map();

    for (const row of rows) {
      const anchor = row.span_id != null
        ? 'span'
        : row.file_node_id != null
          ? 'file'
          : row.any_node_id != null
            ? 'file_any'
            : null;

      if (!anchor) {
        orphanChunks += 1;
        continue;
      }
      anchorCounts[anchor] += 1;

      const score = normalise(Number(row.lexical_score) || 0);
      const existing = byNode.get(row.node_id);
      if (!existing || score > existing.score) {
        byNode.set(row.node_id, { row, score, anchor });
      }
    }

    const candidates = [...byNode.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ row, score, anchor }) => ({
        id: row.node_id,
        name: row.name,
        node_type: row.node_type,
        summary: row.summary,
        properties: {
          ...(row.properties || {}),
          lexical_chunk_index: row.chunk_index,
          lexical_path: row.path,
          lexical_anchor: anchor,
        },
        start_line: row.start_line,
        end_line: row.end_line,
        repository_branch_id: row.repository_branch_id,
        method_name: null,
        // NOT 0.5. A dense_score placeholder of 0.5 makes every lexical candidate
        // tie on the dense_cosine fusion path and discards ts_rank_cd ordering entirely.
        dense_score: 0,
        // Not the ts_rank_cd value: retrieveExactChannel floors exact_match_score at 0.36, and a
        // ts_rank_cd value (typically 0.01-0.3) in the same field mixes two incomparable scales.
        exact_match_score: 0,
        channel: 'lexical',
        channel_score: score,
        // Dedicated field: unionChannelCandidates' `channel_score = Math.max(...)` merge means
        // channel_score is not reliably "the lexical score" once a candidate is also found by
        // another channel (makes this field survive the merge as `channel_scores.lexical`).
        lexical_score: score,
      }));

    return {
      channel: 'lexical',
      status: 'executed',
      candidate_count: candidates.length,
      hit: candidates.length > 0,
      latency_ms: Date.now() - started,
      candidates,
      storage_bytes: candidates.length * 256,
      orphan_chunks: orphanChunks,
      lexical_anchor_distribution: anchorCounts,
      query_tokens_truncated: truncated,
      rank_config: { rank_fn: 'bm25', weights, query_idf: false },
    };
  } catch (err) {
    if (inTransaction) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // best-effort — the connection may already be unusable after a cancel
      }
    }
    // retrieval-channels.js runs channels through Promise.all with no rejection handling — a throw
    // here would take down every other channel's results, including the exact channel's, that
    // already succeeded, and protocol.js would then match the error text ("no such table" from a
    // missing file_text_chunks_fts, a malformed MATCH, an FTS5 build without the trigram tokenizer)
    // and tell the agent the whole graph is unindexed — on a fully populated store. Degrade THIS
    // channel with a surfaced reason instead; the exact channel remains the correctness floor and
    // still reports a genuinely missing store on its own.
    if (err && err.code === QUERY_TIMEOUT_CODE) {
      return emptyResult({ reason: 'timeout', latency_ms: Date.now() - started });
    }
    return emptyResult({ reason: 'error', latency_ms: Date.now() - started });
  } finally {
    if (releaseDeadline) releaseDeadline();
    client.release();
  }
}

module.exports = {
  retrieveLexicalChannel,
  tokenizeLexicalQuery,
  LEXICAL_CHANNEL_LIMIT,
  LEXICAL_MAX_QUERY_TOKENS,
};
