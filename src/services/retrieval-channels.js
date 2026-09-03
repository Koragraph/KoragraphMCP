'use strict';

const pool = require('../db/pool');
const { generationFilterSql } = require('./ingest-generation-service');
const { resolveCalibration } = require('./retrieval-fusion');
const { retrieveLexicalChannel, LEXICAL_CHANNEL_LIMIT } = require('./retrieval-lexical');
const { retrieveFileLexicalChannel, FILE_LEXICAL_CHANNEL_LIMIT } = require('./retrieval-file-lexical');

// 'lexical' is a T1 channel rather than a T2 escalation, because with dense and sparse gone it is
// the only channel that can reach a body identifier the declaration index does not name. Order is
// load-bearing: unionChannelCandidates keeps the first channel to claim a node id.
const ALL_CHANNELS = Object.freeze(['exact', 'lexical', 'graph']);
const T1_CHANNELS = ALL_CHANNELS;
// 'file_lexical' (full-file BM25, retrieval-file-lexical.js) is deliberately NOT in ALL_CHANNELS —
// it must be requested explicitly (channels: [...T1_CHANNELS, 'file_lexical']). Adding a channel
// to ALL_CHANNELS silently changes every default caller; this one is opt-in so recall@32k and
// every other number measured against the default path stays byte-identical unless a caller asks.
const OPTIONAL_CHANNELS = Object.freeze(['file_lexical']);

// The trigram tokenizer indexes 3-grams, so a shorter needle cannot MATCH and the term is omitted.
const FTS_MIN_NEEDLE = 3;

// Probed once per process, not assumed. `pool.js` applies `schema.sql` only when a store has NO
// schema, so `nodes_fts` is absent from every graph ingested before it was added — and a query
// naming a table that is not there raises "no such table", which protocol.js reads as a missing
// store. Cached because this is on the retrieval hot path; `resetFtsProbe` exists so a test that
// creates the table mid-process is not answered from a stale probe.
let ftsProbe;

function ftsAvailable() {
  if (ftsProbe !== undefined) return ftsProbe;
  try {
    ftsProbe = pool.db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='nodes_fts'")
      .get().n > 0;
  } catch {
    ftsProbe = false;
  }
  return ftsProbe;
}

function resetFtsProbe() { ftsProbe = undefined; }

const EXACT_CHANNEL_LIMIT = parseInt(process.env.RETRIEVAL_EXACT_CHANNEL_LIMIT || '16', 10);
const EXACT_NEEDLE_CAP = parseInt(process.env.RETRIEVAL_EXACT_NEEDLE_CAP || '8', 10);
// Bare-name-collision tier-flood cap ("(b)"): max
// candidates admitted per exact_match_score tier once that tier's population exceeds the cap.
// See the SQL comment in retrieveExactChannel for the mechanism and why this is safe for normal
// (unflooded) tie groups. Kept well below EXACT_CHANNEL_LIMIT so a flooded top tier cannot alone
// consume the whole channel limit and starve every lower tier the query's other words would land in.
const EXACT_TIER_FANOUT_CAP = parseInt(process.env.RETRIEVAL_EXACT_TIER_FANOUT_CAP || '8', 10);
const GRAPH_CHANNEL_LIMIT = parseInt(process.env.RETRIEVAL_GRAPH_CHANNEL_LIMIT || '12', 10);
const DEFAULT_CANDIDATE_BOUND = parseInt(process.env.RETRIEVAL_CHANNEL_CANDIDATE_BOUND || '1000', 10);

// 'AMBIGUOUS' is a real confidence_tier value
// (grounding failure — name and/or raw_evidence not verifiably present in the source file)
// distinct from the pre-existing 'EXTRACTED'/'INFERRED'. Excluding it here is what makes
// the tier mean something instead of being decorative. Default true; the
// exact and graph channels are the two that filter by node predicate rather than by
// embedding similarity, so they are where an ungrounded node would otherwise surface.
const RETRIEVAL_EXCLUDE_AMBIGUOUS = process.env.RETRIEVAL_EXCLUDE_AMBIGUOUS !== 'false';
const AMBIGUOUS_EXCLUSION_SQL = RETRIEVAL_EXCLUDE_AMBIGUOUS ? " AND n.confidence_tier != 'AMBIGUOUS'" : '';

const STOPWORDS = new Set([
  'related', 'endpoints', 'endpoint', 'service', 'services', 'implementation',
  'handler', 'configuration', 'list', 'can', 'you', 'the', 'and', 'from', 'with',
]);

const EXACT_NODE_TYPES = [
  'ENDPOINT', 'NODE_CONTROLLER', 'NODE_ENTRYPOINT', 'NODE_SERVICE',
  'SERVICE', 'CONTROLLER', 'METHOD', 'CLASS', 'FUNCTION', 'ANGULAR_ROUTES', 'REACT_ROUTES',
  // Without these, a path/config-shaped query could not exact-match presence/doc/config nodes —
  // asking "what's in application.properties" got "file not found" even though the FILE node existed.
  'FILE', 'DOC', 'CONFIG_VALUE', 'DB_TABLE',
  // A build manifest's only nodes are DEPENDENCY, so `pom.xml` was otherwise unreachable through
  // this channel no matter how it was queried.
  'DEPENDENCY',
  // A CONSTANT or FIELD (e.g. a #define) is a declaration a question names by name exactly as a
  // METHOD or CLASS is, and this channel is the one that answers "the query said the name", so
  // omitting these types leaves them unreachable by name.
  'CONSTANT', 'FIELD', 'INTERFACE', 'ENTITY', 'MODULE', 'UTILITY', 'ANNOTATION',
  'ENUM', 'STRUCT', 'CONFIG_CLASS', 'REPOSITORY', 'TEST',
];

// Reachable by name, but only when the query names them exactly — see the WHERE clause in
// retrieveExactChannel.
const MANIFEST_NODE_TYPES = ['DEPENDENCY', 'CONFIG_VALUE'];

const GRAPH_EDGE_TYPES = [
  'CALLS', 'DEPENDS_ON', 'DEFINED_IN', 'EXTENDS', 'IMPLEMENTS', 'BELONGS_TO', 'READS_TABLE',
];

function extractQueryTokens(queryText) {
  const tokens = new Set();

  // A filename-shaped query is the one case where tokenizing destroys the query.
  // The >=4-char word filter dropped `pom.xml`/`db.yml` to ZERO needles (channel returned
  // `unavailable`, so the file was unreachable by name at any limit), and splitting
  // `application.properties` into two generic words made every *Application class score exactly
  // as high as the file itself. Keep the literal string and its basename so the equality tiers
  // in retrieveExactChannel's scoring can separate the real target from incidental substring
  // hits. NL queries are unaffected — they don't match the path shape and fall through below.
  const literal = String(queryText || '').trim();
  if (literal && literal.length <= 200 && /^[\w.@+-]+(?:[/\\][\w.@+-]+)*$/.test(literal) && /[./\\]/.test(literal)) {
    tokens.add(literal);
    const base = literal.split(/[/\\]/).pop();
    if (base && base !== literal) tokens.add(base);
  }

  const paren = queryText.match(/\(([A-Za-z][A-Za-z0-9_-]{2,})\)/);
  if (paren) tokens.add(paren[1]);

  // Qualified identifiers (`Converter.DATE`, `Session.get`, `TBinaryProtocol::writeI32`).
  // Add only the components of an identifier the question wrote in QUALIFIED form: the word-level
  // tokenizer splits `Converter.DATE` into `Converter` and `date` and the length-descending needle
  // cut can drop the answer token, but qualification makes these declaration names, not vocabulary,
  // so admitting them does not displace dense seeds the way lowering the floor for every bare word
  // would.
  const qualified = new Set();
  for (const m of queryText.match(/[A-Za-z_][A-Za-z0-9_]*(?:(?:\.|::)[A-Za-z_][A-Za-z0-9_]*)+/g) || []) {
    qualified.add(m);
    for (const part of m.split(/\.|::/)) {
      if (part && part.length >= 2 && !STOPWORDS.has(part.toLowerCase())) qualified.add(part);
    }
  }
  for (const q of qualified) tokens.add(q);
  // 4-char floor: a lower floor admits extra tokens that get SEEDED and displace other seeds,
  // costing more recall than they buy.
  for (const t of queryText.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) || []) {
    if (STOPWORDS.has(t.toLowerCase())) continue;
    tokens.add(t);
  }
  // Qualified-name tokens sort ahead of ordinary words regardless of length: the needle cut below
  // is by position, so ordering by length alone would keep a long generic word ("trailing") and
  // drop a short named declaration ("DATE").
  return [...tokens].sort((a, b) => {
    const qa = qualified.has(a) ? 1 : 0;
    const qb = qualified.has(b) ? 1 : 0;
    if (qa !== qb) return qb - qa;
    return b.length - a.length;
  });
}

async function retrieveExactChannel(queryText, branchIds, activeGenerationIds, limit = EXACT_CHANNEL_LIMIT) {
  const started = Date.now();
  if (!branchIds || !branchIds.length) {
    return {
      channel: 'exact',
      status: 'unavailable',
      candidate_count: 0,
      hit: false,
      latency_ms: 0,
      candidates: [],
      storage_bytes: 0,
    };
  }

  // Each needle costs two bound params and one scoring CASE — a bounded, linear cost. The
  // structural configuration has no dense channel to fall back on when the exact channel misses,
  // so a dropped needle is costly; the cap is 8.
  const needles = extractQueryTokens(queryText).slice(0, EXACT_NEEDLE_CAP);
  if (!needles.length) {
    return {
      channel: 'exact',
      status: 'unavailable',
      candidate_count: 0,
      hit: false,
      latency_ms: 0,
      candidates: [],
      storage_bytes: 0,
    };
  }

  // SQLite's LIKE is case-insensitive for ASCII BY DEFAULT, which the pool
  // asserts at startup ('A' LIKE 'a' must be 1) — PRAGMA case_sensitive_like would flip all of
  // these at once, silently, so it is never set. Non-ASCII is the residue: SQLite's LIKE is
  // case-SENSITIVE there and its builtin lower() is ASCII-only (lower('ÜNICODE') -> 'Ünicode'),
  // so the pool overrides lower()/upper() with Unicode-aware versions and the equality tiers below
  // route through them.
  // Two params per needle — the raw string (equality tiers) and the `%wrapped%` form (containment
  // tiers). A single flat `n.name LIKE %needle%` => 1.0 tier was the tie source: for
  // `application.properties`, several names all scored exactly 1.0, and with no tiebreak the query
  // returned an arbitrary subset.
  const methodTextExpr = "COALESCE(me.method_text, '')";

  const needleParams = [];
  const matchClauses = [];
  const scoreCases = [];
  const hitCases = [];
  needles.forEach((needle, i) => {
    const raw = 2 + i * 2;
    const wild = raw + 1;
    needleParams.push(needle, `%${needle}%`);
    // The LIKE terms are the CORRECTNESS floor and are never removed; FTS is added beside them as
    // an accelerator, never as a replacement. `pool.js` applies `schema.sql` only to a store with
    // no schema at all, so a graph ingested before `nodes_fts` existed does not have the table and
    // `nodes_fts MATCH` would raise "no such table: nodes_fts", which protocol.js misreports as a
    // MISSING STORE ("No code graph is indexed yet") on a fully populated graph. So the table is
    // probed rather than assumed, and the trigram index only ever ADDS candidates.
    // The needle is QUOTED into an FTS5 phrase before it reaches MATCH. Passed raw it is parsed
    // as a query expression, so any needle carrying FTS5 syntax (a method call like `app.use`, a
    // filename like `path/to/file.js`) raises `fts5: syntax error` and the agent receives that
    // string as the answer.
    //
    // Quoted inline rather than as a third bound parameter: every index downstream is computed
    // from `2 + needles.length * 2`, and widening the stride would move genParamIdx, nodeTypesIdx,
    // manifestIdx, tierCapIdx and limitIdx together. `"` is doubled, which is FTS5's own escape.
    const ftsTerm = needle.length >= FTS_MIN_NEEDLE && ftsAvailable()
      ? `n.id IN (SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ('"' || replace($${raw}, '"', '""') || '"')) OR `
      : '';
    matchClauses.push(
      `(${ftsTerm}f.path LIKE $${wild} OR n.name LIKE $${wild}`
      + ` OR COALESCE(n.raw_evidence, '') LIKE $${wild} OR ${methodTextExpr} LIKE $${wild})`,
    );
    // Equality tiers use `=` on lower(), not LIKE, so needles containing `_` or `%` (legal in
    // filenames) compare literally instead of as wildcards.
    scoreCases.push(`CASE
        WHEN lower(COALESCE(n.name, '')) = lower($${raw}) THEN 1.0
        -- A basename query names the FILE, so the node representing the file itself outranks the
        -- nodes that merely live in it. Without this, a repo with db/{mysql,postgres,hsqldb,h2}/
        -- schema.sql let mysql's 9 DB_TABLE nodes (all tied on the same basename) fill the whole
        -- top-10 and hide the other three files entirely.
        WHEN n.node_type = 'FILE'
             AND lower(regexp_replace(COALESCE(f.path, ''), '^.*/', '')) = lower($${raw}) THEN 0.98
        WHEN lower(regexp_replace(COALESCE(f.path, ''), '^.*/', '')) = lower($${raw}) THEN 0.97
        WHEN lower(COALESCE(f.path, '')) = lower($${raw}) THEN 0.95
        WHEN n.name LIKE $${raw} || '%' THEN 0.75
        WHEN n.name LIKE $${wild} THEN 0.6
        WHEN COALESCE(f.path, '') LIKE $${wild} THEN 0.5
        ELSE 0 END`);
    // Needle COVERAGE, independent of the best single tier. The strongest single-tier match throws
    // away how MANY of the query's tokens a candidate answers, so a whole file's declarations can
    // tie on a basename match. Coverage separates them: a node matching two needles (the file AND
    // its own name) outranks one matching one.
    hitCases.push(`(CASE WHEN (n.name LIKE $${wild} OR COALESCE(f.path, '') LIKE $${wild}
        OR COALESCE(n.raw_evidence, '') LIKE $${wild} OR ${methodTextExpr} LIKE $${wild})
        THEN 1 ELSE 0 END)`);
  });

  const genParamIdx = 2 + needles.length * 2;
  const genFilter = generationFilterSql('n.ingest_generation_id', activeGenerationIds, genParamIdx);
  const nodeTypesIdx = genParamIdx + genFilter.params.length;
  const manifestIdx = nodeTypesIdx + 1;
  const tierCapIdx = manifestIdx + 1;
  const limitIdx = tierCapIdx + 1;

  const params = [
    branchIds,
    ...needleParams,
    ...genFilter.params,
    EXACT_NODE_TYPES,
    MANIFEST_NODE_TYPES,
    EXACT_TIER_FANOUT_CAP,
    limit,
  ];

  // `DISTINCT ON (n.id) ... ORDER BY n.id, exact_match_score DESC` legally dedupes per-node
  // (method_text_index can yield multiple rows per node), but an outer LIMIT would then truncate by
  // ascending node id, not by score — a node with a real match could be dropped in favor of
  // unrelated lower-id nodes whenever candidates exceeded the limit. Fix: dedupe in a subquery,
  // then re-sort and LIMIT by score in the outer query.
  const { rows } = await pool.query(
    `SELECT id, name, node_type, summary, properties, start_line, end_line,
            repository_branch_id, method_name, dense_score, exact_match_score,
            needle_hits
     FROM (
       SELECT *,
         -- Bare-name-collision tier-flood cap ("(b)").
         -- The needle-coverage tiebreak (needle_hits DESC below) only breaks ties WITHIN a tier; it
         -- cannot help when a whole tier exceeds the channel limit. When many bare-name collisions
         -- fill a tier, the flat ORDER BY exact_match_score DESC ... LIMIT never reaches whatever
         -- tier the real (differently-named) answer sits in. tier_size/tier_rank make this a
         -- per-query condition (population > cap), not a name/file/repo special case -- a small tie
         -- group has tier_size <= cap and passes through unchanged below.
         COUNT(*) OVER (PARTITION BY exact_match_score) AS tier_size,
         RANK() OVER (
           PARTITION BY exact_match_score
           ORDER BY needle_hits DESC, id ASC
         ) AS tier_rank
       FROM (
         -- B5: DISTINCT ON (n.id) ... ORDER BY n.id, exact_match_score DESC, needle_hits DESC.
         -- The partition key leaves the ORDER BY (it is constant within its own partition) and the
         -- rest becomes the window's ordering. The scoring expressions are REPEATED rather than
         -- referenced by alias: SQLite cannot see a SELECT alias from inside a window's ORDER BY
         -- ("no such column"), so the same template strings are interpolated twice on purpose.
         --
         -- The remaining tie — two method rows for one node with equal score and equal hits — was
         -- arbitrary under DISTINCT ON and is arbitrary here. It decides only which
         -- me.method_name is carried, and nothing downstream reads it (checked: not in
         -- retrieval-fusion, retrieval-query-plan, graph-retriever or subgraph-builder), so it
         -- cannot reach the delivered context.
         SELECT id, name, node_type, summary, properties, start_line, end_line,
                repository_branch_id, method_name, dense_score, exact_match_score,
                needle_hits
         FROM (
           SELECT
             n.id,
             n.name,
             n.node_type,
             n.summary,
             n.properties,
             n.start_line,
             n.end_line,
             n.repository_branch_id,
             me.method_name,
             0.5 AS dense_score,
             -- D16: Postgres GREATEST ignores NULL arguments; SQLite's multi-argument max()
             -- returns NULL if ANY argument is NULL. Safe only because every scoreCases branch
             -- ends in ELSE 0. Keep it that way — one nullable branch makes every candidate
             -- score NULL and the whole channel ranks flat.
             max(${scoreCases.join(', ')}, 0.36) AS exact_match_score,
             (${hitCases.join(' + ')}) AS needle_hits,
             ROW_NUMBER() OVER (
               PARTITION BY n.id
               ORDER BY max(${scoreCases.join(', ')}, 0.36) DESC, (${hitCases.join(' + ')}) DESC
             ) AS _rn
           FROM nodes n
           LEFT JOIN files f ON f.id = n.file_id
           LEFT JOIN method_text_index me ON me.node_id = n.id AND me.embedding_status = 'active'
           WHERE n.repository_branch_id IN (SELECT value FROM json_each($1))
             AND n.approval_status = 'APPROVED'
             AND n.node_type IN (SELECT value FROM json_each($${nodeTypesIdx}))
             AND (${matchClauses.join(' OR ')})${genFilter.clause}${AMBIGUOUS_EXCLUSION_SQL}
         ) ranked
         WHERE _rn = 1
       ) deduped
     ) windowed
     -- Manifest-grain nodes (DEPENDENCY, CONFIG_VALUE) were added to EXACT_NODE_TYPES so a query
     -- naming pom.xml or a package could reach them at all. But they match on PREFIX and SUBSTRING
     -- like everything else, and a package namespace fans out: a query naming a package can fill
     -- this channel's slots with that package's sub-namespaces at equal score, pushing the
     -- declaration that actually answers it far down the ranking.
     --
     -- A dependency or config key is not a declaration anyone is reading; it is only the answer
     -- when the question NAMES it. Requiring an equality tier (>= 0.95: name equals, basename
     -- equals, path equals) keeps urllib3 — which the question does name — and drops the eleven
     -- namespace siblings it does not. Declaration types are untouched.
     WHERE NOT (node_type IN (SELECT value FROM json_each($${manifestIdx})) AND exact_match_score < 0.95)
       -- Only intervene once a single tier's population alone would already exceed the whole
       -- channel's LIMIT (i.e. it is provably the bottleneck, not merely "more than a couple of
       -- ties") — a normal tie group under EXACT_CHANNEL_LIMIT passes through unchanged. Gating on
       -- EXACT_TIER_FANOUT_CAP alone would cap every tie group uniformly and trim ordinary,
       -- not-actually-flooded groups too aggressively; gating on population > limit avoids that.
       AND (tier_size <= $${limitIdx} OR tier_rank <= $${tierCapIdx})
     ORDER BY exact_match_score DESC, needle_hits DESC,
              length(COALESCE(name, '')) ASC, id ASC
     LIMIT $${limitIdx}`,
    params
  );

  const candidates = rows.map((r) => ({
    ...r,
    channel: 'exact',
    channel_score: Number(r.exact_match_score ?? 0.5),
  }));

  return {
    channel: 'exact',
    status: 'executed',
    candidate_count: candidates.length,
    hit: candidates.length > 0,
    latency_ms: Date.now() - started,
    candidates,
    storage_bytes: candidates.length * 128,
  };
}

async function retrieveGraphChannel(seedNodeIds, branchIds, activeGenerationIds, limit = GRAPH_CHANNEL_LIMIT) {
  const started = Date.now();
  if (!seedNodeIds || !seedNodeIds.length) {
    return {
      channel: 'graph',
      status: 'executed',
      candidate_count: 0,
      hit: false,
      latency_ms: 0,
      candidates: [],
      storage_bytes: 0,
    };
  }

  const genParamIdx = 4;
  const genFilter = generationFilterSql('n.ingest_generation_id', activeGenerationIds, genParamIdx);
  const limitIdx = genParamIdx + genFilter.params.length;
  const edgeTypes = GRAPH_EDGE_TYPES;

  const { rows } = await pool.query(
    // B5: every selected column here is either from n (functionally determined by n.id) or a
    // literal, so the duplicates a multi-edge join produces are identical in every column. Plain
    // DISTINCT is exactly equivalent to DISTINCT ON (n.id) in that case, and keeps the
    // ORDER BY / LIMIT that decides what the channel returns.
    `SELECT DISTINCT
       n.id,
       n.name,
       n.node_type,
       n.summary,
       n.properties,
       n.start_line,
       n.end_line,
       n.repository_branch_id,
       '_graph' AS method_name,
       0.42 AS dense_score,
       0.42 AS graph_score
     FROM edges e
     JOIN nodes n ON (
       (e.from_node_id = n.id AND e.to_node_id IN (SELECT value FROM json_each($1)))
       OR (e.to_node_id = n.id AND e.from_node_id IN (SELECT value FROM json_each($1)))
     )
     WHERE n.approval_status = 'APPROVED'
       AND n.node_type NOT IN ('CONFIG_VALUE', 'DEPENDENCY', 'IMPORT')
       AND n.repository_branch_id IN (SELECT value FROM json_each($2))
       AND e.edge_type IN (SELECT value FROM json_each($3))
       AND n.id NOT IN (SELECT value FROM json_each($1))${genFilter.clause}${AMBIGUOUS_EXCLUSION_SQL}
     ORDER BY n.id
     LIMIT $${limitIdx}`,
    [seedNodeIds, branchIds, edgeTypes, ...genFilter.params, limit]
  );

  const candidates = rows.map((r) => ({
    ...r,
    channel: 'graph',
    channel_score: Number(r.graph_score ?? 0.42),
  }));

  return {
    channel: 'graph',
    status: 'executed',
    candidate_count: candidates.length,
    hit: candidates.length > 0,
    latency_ms: Date.now() - started,
    candidates,
    storage_bytes: candidates.length * 64,
  };
}

function computeMarginalRecall(channelResults) {
  const seen = new Set();
  const marginal = {};
  for (const ch of ALL_CHANNELS) marginal[ch] = 0;

  for (const result of channelResults) {
    if (!result || result.status !== 'executed') continue;
    let unique = 0;
    for (const c of result.candidates) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        unique += 1;
      }
    }
    marginal[result.channel] = unique;
  }
  return marginal;
}

function unionChannelCandidates(channelResults, candidateBound = DEFAULT_CANDIDATE_BOUND) {
  const unionMap = new Map();

  for (const result of channelResults) {
    if (!result || result.status !== 'executed') continue;
    for (const c of result.candidates) {
      const existing = unionMap.get(c.id);
      const channels = existing
        ? [...new Set([...existing.channels, result.channel])]
        : [result.channel];
      const bestScore = existing
        ? Math.max(existing.channel_score, c.channel_score)
        : c.channel_score;
      // A `...c` spread would overwrite the whole merged row whenever a node was found by more than
      // one channel, including `dense_score` — but non-dense channels (retrieveExactChannel,
      // retrieveGraphChannel) stamp a hardcoded placeholder dense_score (0.5) onto their rows purely
      // so fuseRetrievalCandidates has a numeric field to read. A node found by the real dense
      // channel AND a later-iterated exact channel would otherwise lose its true cosine similarity
      // to that placeholder, crippling its fused score in dense_cosine fusion mode.
      const denseScore = result.channel === 'dense'
        ? Number(c.dense_score ?? 0)
        : Number(existing?.dense_score ?? c.dense_score ?? 0);
      // `channel_score` above is a Math.max across channels, and the `...c` spread keeps whichever
      // channel iterated last — neither survives as "the lexical score" of a candidate dense also
      // found. `channel_scores` is a dedicated, additive map so the rank map can read
      // `channel_scores.lexical` instead of misreading the winner.
      const channelScores = {
        ...existing?.channel_scores,
        [result.channel]: Number(c.channel_score ?? 0),
      };
      unionMap.set(c.id, {
        ...c,
        channels,
        channel_score: bestScore,
        channel_scores: channelScores,
        channel_sources: channels,
        dense_score: existing ? Math.max(Number(existing.dense_score ?? 0), denseScore) : denseScore,
      });
    }
  }

  return [...unionMap.values()]
    .sort((a, b) => b.channel_score - a.channel_score)
    .slice(0, candidateBound);
}

async function retrieveAllChannels({
  queryText,
  branchIds,
  activeGenerationIds = [],
  scopedBranchIds = null,
  channels = ALL_CHANNELS,
  candidateBound = DEFAULT_CANDIDATE_BOUND,
  intent = null,
  language = null,
  risk = null,
}) {
  const opts = { intent, language, risk };
  const branchScope = scopedBranchIds || branchIds;
  const requested = [...new Set(channels)];
  const channelResults = [];

  const runChannel = async (channel) => {
    switch (channel) {
      case 'exact':
        return retrieveExactChannel(queryText, branchScope, activeGenerationIds, EXACT_CHANNEL_LIMIT);
      case 'graph':
        return null;
      case 'lexical':
        // added this case ahead of ALL_CHANNELS membership so its own proofs had a
        // real channel to run against. adds 'lexical' to ALL_CHANNELS itself, so this
        // now fires by default too.
        return retrieveLexicalChannel(queryText, branchScope, activeGenerationIds, LEXICAL_CHANNEL_LIMIT);
      case 'file_lexical':
        return retrieveFileLexicalChannel(queryText, branchScope, activeGenerationIds, FILE_LEXICAL_CHANNEL_LIMIT);
      default:
        return { channel, status: 'skipped', candidate_count: 0, hit: false, latency_ms: 0, candidates: [], storage_bytes: 0 };
    }
  };

  const nonGraph = requested.filter((c) => c !== 'graph');
  const parallelResults = await Promise.all(nonGraph.map(runChannel));
  channelResults.push(...parallelResults.filter(Boolean));

  if (requested.includes('graph')) {
    const exactResult = channelResults.find((r) => r.channel === 'exact');
    const lexicalResult = channelResults.find((r) => r.channel === 'lexical');
    // union in lexical hits so a lexical-only hit (a body identifier the exact channel's
    // summary-text LIKE cannot reach) can still expand through the graph channel, not just re-rank
    // in the fused candidate list.
    const seedIds = [
      ...new Set([
        ...(exactResult?.candidates || []).map((c) => c.id),
        ...(lexicalResult?.candidates || []).map((c) => c.id),
      ]),
    ].slice(0, GRAPH_CHANNEL_LIMIT);
    const graphResult = await retrieveGraphChannel(seedIds, branchScope, activeGenerationIds, GRAPH_CHANNEL_LIMIT);
    channelResults.push(graphResult);
  }

  const unioned = unionChannelCandidates(channelResults, candidateBound);
  const marginalRecall = computeMarginalRecall(channelResults);

  const channelStats = channelResults.map((r) => ({
    channel: r.channel,
    status: r.status,
    // The lexical channel enforces a wall-clock deadline and degrades to zero candidates when it
    // trips, which makes the SAME query on the SAME database return a different answer depending
    // on machine load. Dropping `reason` here is what made that invisible: 'unavailable' also
    // means "no chunks stored" and "no query tokens", so nothing downstream could tell a partial
    // answer from an honest empty one.
    reason: r.reason ?? null,
    candidate_count: r.candidate_count,
    hit: r.hit,
    latency_ms: r.latency_ms,
    storage_bytes: r.storage_bytes ?? 0,
    marginal_unique: marginalRecall[r.channel] ?? 0,
  }));

  const calibration = resolveCalibration({
    intent: opts.intent,
    language: opts.language,
    risk: opts.risk,
  });

  return {
    candidates: unioned,
    channel_stats: channelStats,
    marginal_recall: marginalRecall,
    requested_channels: requested,
    executed_channels: channelStats.filter((s) => s.status === 'executed').map((s) => s.channel),
    fusion_calibration: calibration,
  };
}

module.exports = {
  ALL_CHANNELS,
  T1_CHANNELS,
  OPTIONAL_CHANNELS,
  EXACT_NODE_TYPES,
  extractQueryTokens,
  retrieveExactChannel,
  retrieveGraphChannel,
  retrieveAllChannels,
  unionChannelCandidates,
  computeMarginalRecall,
  retrieveLexicalChannel,
  ftsAvailable,
  resetFtsProbe,
};
