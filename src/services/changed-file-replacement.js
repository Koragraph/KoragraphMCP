'use strict';

const pool = require('../db/pool');
const { computeCanonicalKey, computeMethodOwnerQualifier, validateExtractionNodes } = require('./ingest-helpers');

// Clamped to the driver's probed parameter ceiling. Every node in the graph goes through
// upsertNodeRows at 14 bound params per row, so an INGEST_BULK_FLUSH_SIZE above 2,340 binds past
// 32,766 and throws `too many SQL variables` on the one write path that produces the entire
// graph. The knob stays honoured below that; it just cannot be set into the failure.
const DEFAULT_FLUSH_SIZE = Math.min(
  parseInt(process.env.INGEST_BULK_FLUSH_SIZE || '50', 10) || 50,
  pool.safeChunk(14)
);
// Below this population, a zero-node extraction isn't worth protecting — the guard exists to
// stop a parser hiccup from mass-archiving a real file's worth of nodes, not to block
// legitimate near-empty files from ever losing their last couple of nodes.
const EMPTY_EXTRACTION_GUARD_MIN_NODES = 3;
// A per-NODE audit stamp (`properties.extractor_version`, prepareNodeRow below) written at
// ingest time, not an input to `file_extraction_cache`'s own invalidation key — that cache
// is content-hash + indexer-fingerprint gated
// (extraction-cache.js#computeIndexerFingerprint, deliberately NOT a hand-maintained version
// constant). This stamp lets a forensic query tell an old-shape row from a new one via
// `json_extract(properties, '$.extractor_version')`.
const EXTRACTOR_VERSION = 'cgc-port-1';

function prepareNodeRow(nd, fileId, branchId, fileSha, relPath, source = null) {
  const sourceFile = nd._sourceFile || relPath;
  // _methodIdentity is the identity ingest-file-processor decided for this method (AST plane,
  // and the LLM rows it aligned to it). Recomputing here instead would give an aligned LLM row
  // a different key from the AST row it describes, splitting one method into two nodes.
  const ownerQualifier = nd.node_type === 'METHOD'
    ? (nd._methodIdentity !== undefined ? nd._methodIdentity : computeMethodOwnerQualifier(nd))
    // A FIELD's identity is its declaring class; `name`/`id`/`type` recur across classes.
    : nd.node_type === 'FIELD' ? (nd.parent_class || null)
    // A nested type's identity includes the scope it is declared in; a top-level one has none.
    : nd.node_type === 'CLASS' ? (nd._container || null)
      : null;
  const canonicalKey = computeCanonicalKey(nd.node_type, nd.name, branchId, sourceFile, ownerQualifier);
  const props = { ...nd };
  [
    'node_type', 'name', 'summary', 'raw_evidence', 'confidence', 'confidence_tier',
    'start_line', 'end_line', 'edges', '_sourceFile', '_owner', '_container', '_methodIdentity', 'extractor_version',
  ].forEach((k) => delete props[k]);
  // Stamp the per-row source ('ast'|'llm') at write time so plane claims are falsifiable
  // from data, not just from code reading.
  // dedupeRowsByCanonicalKey below widens this to a set when both a row survive collapse.
  if (source) props.extraction_source = [source];
  // Stamped unconditionally. It used to ride on a fallback that only fired when `props` came out
  // empty, so adding extraction_source above made `props` non-empty for every AST node and
  // silently dropped extractor_version from exactly the rows ENG1a was labelling.
  props.extractor_version = EXTRACTOR_VERSION;
  const propsJson = JSON.stringify(props);
  const tier = ['EXTRACTED', 'INFERRED', 'AMBIGUOUS'].includes(nd.confidence_tier)
    ? nd.confidence_tier
    : 'INFERRED';

  return {
    nd,
    fileId,
    branchId,
    fileSha,
    canonicalKey,
    tier,
    propsJson,
    sourceFile,
    startLine: nd.start_line ?? nd.line ?? null,
    endLine: nd.end_line ?? null,
    confidence: typeof nd.confidence === 'number' ? nd.confidence : 1.0,
  };
}

// Merge two extraction_source values (each a [] array or undefined, per-row shape
// stamped by prepareNodeRow) into the deduplicated set-union, order-independent.
function mergeExtractionSources(a, b) {
  const merged = new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]);
  return merged.size ? [...merged] : undefined;
}

function dedupeRowsByCanonicalKey(prepared) {
  const seenKeys = new Map();
  const deduped = [];
  const ckByOriginal = [];

  for (const row of prepared) {
    const { canonicalKey, tier } = row;
    ckByOriginal.push(canonicalKey);
    if (seenKeys.has(canonicalKey)) {
      const existingIdx = seenKeys.get(canonicalKey);
      const existing = deduped[existingIdx];
      const existingProps = JSON.parse(existing.propsJson);
      const rowProps = JSON.parse(row.propsJson);
      const mergedSource = mergeExtractionSources(existingProps.extraction_source, rowProps.extraction_source);
      const winner = (tier === 'EXTRACTED' && existing.tier !== 'EXTRACTED') ? row : existing;
      const loser = winner === row ? existing : row;
      const winnerProps = JSON.parse(winner.propsJson);
      if (mergedSource) winnerProps.extraction_source = mergedSource;
      else delete winnerProps.extraction_source;
      // Picking one row WHOLESALE would keep the structural row (its tier is EXTRACTED) and
      // drop the semantic row entirely while still stamping extraction_source ["ast","llm"]
      // on the survivor — the provenance marker would claim a contribution not in the row.
      // The structural row still wins identity, spans and tier; the fields only the semantic
      // row can supply are carried across instead of discarded.
      const mergedNd = { ...winner.nd };
      if (loser.nd?.raw_evidence && !mergedNd.raw_evidence) {
        mergedNd.raw_evidence = loser.nd.raw_evidence;
        if (loser.nd.summary) mergedNd.summary = loser.nd.summary;
      }
      const mergedConfidence = mergedNd.raw_evidence && mergedNd.raw_evidence === loser.nd?.raw_evidence
        ? loser.confidence
        : winner.confidence;
      deduped[existingIdx] = {
        ...winner,
        nd: mergedNd,
        confidence: mergedConfidence,
        propsJson: JSON.stringify(winnerProps),
      };
    } else {
      seenKeys.set(canonicalKey, deduped.length);
      deduped.push(row);
    }
  }

  return { deduped, ckByOriginal };
}

async function upsertNodeRows(client, deduped, ingestGenerationId) {
  if (!deduped.length) return new Map();

  const keyToId = new Map();
  for (let offset = 0; offset < deduped.length; offset += DEFAULT_FLUSH_SIZE) {
    const chunk = deduped.slice(offset, offset + DEFAULT_FLUSH_SIZE);
    const params = [];
    const valueClauses = chunk.map((row) => {
      const base = params.length;
      params.push(
        row.branchId,
        row.fileId,
        row.nd.node_type,
        row.nd.name,
        row.nd.summary || null,
        row.nd.raw_evidence || null,
        row.startLine,
        row.endLine,
        row.confidence,
        row.tier,
        row.fileSha,
        row.canonicalKey,
        row.propsJson,
        ingestGenerationId,
      );
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},'APPROVED',$${base + 12},$${base + 13},$${base + 14})`;
    });

    const sql = `
      INSERT INTO nodes
        (repository_branch_id, file_id, node_type, name, summary, raw_evidence,
         start_line, end_line,
         confidence, confidence_tier, file_sha_at_extract, approval_status, canonical_key, properties,
         ingest_generation_id)
      VALUES ${valueClauses.join(',')}
      ON CONFLICT (canonical_key)
        WHERE canonical_key IS NOT NULL
          AND repository_branch_id IS NOT NULL
          AND approval_status != 'ARCHIVED'
      DO UPDATE SET
        last_updated_at       = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        file_id               = EXCLUDED.file_id,
        node_type             = EXCLUDED.node_type,
        name                  = EXCLUDED.name,
        -- This path REPLACES a file's facts, so taking the incoming value is right when the
        -- file actually changed. It is wrong when the bytes are identical and the semantic
        -- plane merely produced nothing this run: a re-ingest whose LLM returned empty would
        -- overwrite a real summary, quoted evidence and confidence with the AST placeholder,
        -- deleting knowledge about code that had not changed. The gate is the content hash the
        -- row was extracted at, not a mode flag: same sha + a write carrying no evidence =>
        -- keep what is there.
        summary               = CASE
          WHEN EXCLUDED.raw_evidence IS NOT NULL THEN EXCLUDED.summary
          WHEN nodes.raw_evidence IS NULL THEN EXCLUDED.summary
          WHEN nodes.file_sha_at_extract IS NOT EXCLUDED.file_sha_at_extract THEN EXCLUDED.summary
          ELSE nodes.summary END,
        raw_evidence          = CASE
          WHEN EXCLUDED.raw_evidence IS NOT NULL THEN EXCLUDED.raw_evidence
          WHEN nodes.file_sha_at_extract IS NOT EXCLUDED.file_sha_at_extract THEN EXCLUDED.raw_evidence
          ELSE nodes.raw_evidence END,
        start_line            = EXCLUDED.start_line,
        end_line              = EXCLUDED.end_line,
        confidence            = CASE
          WHEN EXCLUDED.raw_evidence IS NOT NULL THEN EXCLUDED.confidence
          WHEN nodes.raw_evidence IS NULL THEN EXCLUDED.confidence
          WHEN nodes.file_sha_at_extract IS NOT EXCLUDED.file_sha_at_extract THEN EXCLUDED.confidence
          ELSE nodes.confidence END,
        -- Same upgrade-only blocker as ingest.js's writeNode — this is the write path
        -- commitExtractedNodes actually uses (via replaceChangedFileFacts), so the
        -- grounding gate is inert here unless an explicit grounding-failure
        -- AMBIGUOUS is also allowed to overwrite a stored EXTRACTED.
        confidence_tier       = CASE
                                   WHEN EXCLUDED.confidence_tier = 'AMBIGUOUS'
                                        AND json_type(EXCLUDED.properties, '$.grounding_failure') IS NOT NULL
                                     THEN 'AMBIGUOUS'
                                   WHEN EXCLUDED.confidence_tier = 'EXTRACTED'
                                     THEN 'EXTRACTED'
                                   ELSE nodes.confidence_tier END,
        file_sha_at_extract   = EXCLUDED.file_sha_at_extract,
        properties            = EXCLUDED.properties,
        ingest_generation_id  = EXCLUDED.ingest_generation_id,
        approval_status       = 'APPROVED'
      RETURNING id, canonical_key`;

    const { rows: returned } = await client.query(sql, params);
    for (const r of returned) {
      if (r.canonical_key) keyToId.set(r.canonical_key, r.id);
    }
  }

  return keyToId;
}

async function invalidateFileDerivedArtifacts(client, {
  branchId,
  fileId,
  repositoryId,
  archivedNodeIds = [],
}) {
  if (archivedNodeIds.length > 0) {
    await client.query(
      `UPDATE files
          SET summary = NULL,
              summary_generated_at = NULL,
              summary_source = NULL,
              summary_model = NULL,
              summary_generation_id = NULL
        WHERE id = $1`,
      [fileId],
    );

    if (repositoryId) {
      await client.query(
        `UPDATE repositories
            SET repo_summary = NULL,
                repo_summary_generated_at = NULL
          WHERE id = $1`,
        [repositoryId],
      );
    }
  }

  const liveNodeIds = archivedNodeIds.length
    ? (await client.query(
      `SELECT id FROM nodes
        WHERE file_id = $1 AND approval_status = 'APPROVED'`,
      [fileId],
    )).rows.map((r) => r.id)
    : [];

  const affectedIds = [...new Set([...archivedNodeIds, ...liveNodeIds])];
  if (affectedIds.length) {
    await client.query(
      `DELETE FROM edges
        WHERE (from_node_id IN (SELECT value FROM json_each($1)) OR to_node_id IN (SELECT value FROM json_each($1)))
          AND json_extract(properties, '$.source') = 'git_coupling'`,
      [affectedIds],
    );
  }
}

async function replaceChangedFileFacts({
  branchId,
  fileId,
  fileSha,
  relPath,
  ingestGenerationId,
  astNodes = [],
  llmNodes = [],
  repositoryId = null,
  // The caller's signal that the source file genuinely has no content left
  // (deleted/truncated to zero bytes) vs. still having content that
  // a parser/LLM hiccup just failed to extract from. Defaults to false (i.e.
  // "assume the file still has content") so an unmigrated caller that doesn't pass
  // this still gets the safety guard rather than silently losing it.
  sourceEmpty = false,
  db = pool,
}) {
  const indexedNodes = [];
  for (const nd of astNodes) {
    if (!nd?.node_type || !nd?.name) continue;
    indexedNodes.push({ nd, source: 'ast' });
  }
  for (const nd of llmNodes) {
    if (!nd?.node_type || !nd?.name) continue;
    indexedNodes.push({ nd, source: 'llm' });
  }

  const allNodes = indexedNodes.map((entry) => entry.nd);
  const { valid, errors } = validateExtractionNodes(allNodes);
  if (!valid) {
    return { status: 'validation_failed', errors, keyToId: new Map(), archivedIds: [] };
  }

  const prepared = indexedNodes.map((entry, originalIndex) => ({
    ...prepareNodeRow(entry.nd, fileId, branchId, fileSha, relPath, entry.source),
    originalIndex,
    source: entry.source,
  }));

  const { deduped, ckByOriginal } = dedupeRowsByCanonicalKey(prepared);
  const newKeys = deduped.map((r) => r.canonicalKey);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // A parser/LLM hiccup that yields zero nodes must not silently archive an entire
    // file's worth of real nodes. Only trips when there's a
    // meaningful population at risk and the source itself isn't the reason
    // (sourceEmpty=true is a real deletion/truncation — let that archive normally).
    if (indexedNodes.length === 0 && !sourceEmpty) {
      const { rows: [liveRow] } = await client.query(
        `SELECT count(*) AS count FROM nodes
          WHERE file_id = $1 AND approval_status != 'ARCHIVED'`,
        [fileId],
      );
      const liveCount = liveRow ? Number(liveRow.count) : 0;
      if (liveCount >= EMPTY_EXTRACTION_GUARD_MIN_NODES) {
        await client.query(
          `UPDATE files SET index_status = 'DEGRADED', last_indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1`,
          [fileId],
        );
        // ingest_generation_id gates retrieval visibility
        // (generationFilterSql, graph-retriever.js/retrieval-channels.js/
        // retrieval-lexical.js) — activateGeneration supersedes the previous
        // ACTIVE generation once the ingest completes, and only nodes tagged
        // NULL or with the new active id stay visible. Because this branch
        // skips upsertNodeRows, these preserved nodes never get a fresh
        // generation id; carryForwardGenerationMembership normally backfills
        // that for untouched files, but ingest.js's full-ingest
        // coveredFilesForFileNode pass unconditionally re-adds every
        // extractable file (guarded or not) to touchedFileIds, which excludes
        // it from that carry-forward. Stamp it here so the guard's whole
        // point — keep these nodes usable — survives the generation flip
        // regardless of that downstream wiring.
        if (ingestGenerationId != null) {
          await client.query(
            `UPDATE nodes
                SET ingest_generation_id = $2, last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE file_id = $1
                AND approval_status != 'ARCHIVED'
                AND ingest_generation_id IS NOT $2`,
            [fileId, ingestGenerationId],
          );
        }
        await client.query('COMMIT');
        console.error(
          `[changed-file-replacement] [GUARD] ${relPath}: zero-node extraction against `
          + `${liveCount} live nodes (file_id=${fileId}) — skipping replacement, file marked DEGRADED`,
        );
        return {
          status: 'guarded_empty_extraction',
          keyToId: new Map(),
          archivedIds: [],
          archivedKeys: [],
          results: [],
          nodeCount: 0,
          liveCountAtGuard: liveCount,
        };
      }
    }

    const keyToId = await upsertNodeRows(client, deduped, ingestGenerationId);

    // Reattach any inbound-CALLS stubs (to_node_id = NULL — the schema's own documented
    // "transient placeholder" contract) left behind by an earlier replacement that archived
    // the node these edges pointed at. A rename-and-back — symbol archived in one
    // incremental, re-created under a NEW node id in a later one because the canonical-key ON
    // CONFLICT partial index excludes ARCHIVED rows — cannot resolve to a stable id at
    // archival time, so the stub is left dangling until a node with the same name reappears.
    // Scoped to only the node ids this call just wrote, so it never reaches for an unrelated
    // stub elsewhere on the branch.
    //
    // The STUB's caller (fn) must ALSO be scoped to the same branch — edges has no
    // branch/project column of its own, only via from_node_id/to_node_id ->
    // nodes.repository_branch_id. Without `fn.repository_branch_id = branchId`, a dangling
    // stub with a matching called_name from a COMPLETELY UNRELATED project/branch would get
    // wired to this branch's freshly-written node purely on a name collision — cross-tenant
    // edge corruption, not just a missed reattach.
    let inboundEdgesReattached = 0;
    if (keyToId.size) {
      const writtenNodeIds = [...keyToId.values()];
      const { rowCount } = await client.query(
        `UPDATE edges AS e SET to_node_id = n.id
           FROM nodes n
          WHERE e.to_node_id IS NULL
            AND e.edge_type = 'CALLS'
            AND json_extract(e.properties, '$.called_name') = n.name
            AND n.id IN (SELECT value FROM json_each($1))
            AND n.approval_status = 'APPROVED'
            AND e.from_node_id <> n.id
            AND EXISTS (
              SELECT 1 FROM nodes fn
               WHERE fn.id = e.from_node_id
                 AND fn.approval_status != 'ARCHIVED'
                 AND fn.repository_branch_id = $2
            )
            AND NOT EXISTS (
              SELECT 1 FROM edges e2
               WHERE e2.from_node_id = e.from_node_id
                 AND e2.to_node_id = n.id
                 AND e2.edge_type = e.edge_type
            )`,
        [writtenNodeIds, branchId],
      );
      inboundEdgesReattached = rowCount;
    }

    // FILE and DEPENDENCY nodes are never part of astNodes/llmNodes, so their canonical
    // keys can never appear in `newKeys` —
    // they are written by entirely separate passes that share this same file_id
    // (FILE: ingest.js's presence_floor/binary_stub/coveredFilesForFileNode
    // writeNode calls; DEPENDENCY: resolveImportFacts, anchored to whichever
    // file's import first created it). Without this exclusion, every incremental
    // re-ingest of an already-ingested file collaterally archives its own FILE
    // node (reproduced live: a single replaceChangedFileFacts call archived a
    // pre-existing FILE node whose canonical key wasn't in newKeys), and the
    // later writeNode() upsert for that same file can't resurrect it — the
    // ON CONFLICT target is a partial index excluding ARCHIVED rows — so it
    // inserts a duplicate fresh FILE node instead. Same mechanism threatens
    // DEPENDENCY nodes sharing file_id with an extractable source file. Real
    // symbol vanish-archival (METHOD/CLASS/etc — the case this UPDATE exists
    // for) is unaffected: those types are always present in newKeys when the
    // extraction pass produced them.
    //
    // DOC/DOC_REF join the exclusion for the same reason and it is not cosmetic.
    // DOC(rationale) nodes are written ONLY by the post-tail rationale-graph pass
    // (resolveRationaleNodes) and DOC(doc) by ingest.js's markdown pass — never in
    // a source file's astNodes — so their canonical keys are never in this file's
    // newKeys and this UPDATE archived every one of them on every ingest. The
    // partial-index upsert then could not resurrect the archived row, so the
    // post-tail re-created a fresh duplicate: measured +117 archived DOC/RATIONALE
    // nodes and +3 MB per repeated `--full` of UNCHANGED express, unbounded. The
    // rationale pass now owns DOC staleness itself (archives a file's DOC nodes it
    // did not just (re)write), so excluding them here removes the churn without
    // leaving a deleted docstring's DOC alive.
    const { rows: archived } = await client.query(
      `UPDATE nodes
          SET approval_status = 'ARCHIVED',
              last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE file_id = $1
          AND approval_status != 'ARCHIVED'
          AND node_type NOT IN ('FILE', 'DEPENDENCY', 'DOC', 'DOC_REF')
          AND (
            (canonical_key IS NOT NULL AND NOT (canonical_key IN (SELECT value FROM json_each($2))))
            OR (canonical_key IS NULL AND (ingest_generation_id IS NULL OR ingest_generation_id < $3))
          )
      RETURNING id, canonical_key`,
      [fileId, newKeys, ingestGenerationId ?? -1],
    );
    const archivedIds = archived.map((r) => r.id);

    // Before hard-deleting an archived node's edges, rescue INBOUND CALLS from callers this
    // replacement did NOT touch (from_node_id not itself being archived — i.e. an unchanged
    // file elsewhere on the branch) by converting them to unresolved stubs (to_node_id =
    // NULL) instead of deleting them outright. The reattachment pass above (next call that
    // writes a same-named node) re-links them. Edges with both ends archived, or OUTBOUND
    // from an archived node, carry nothing worth rescuing — the caller is gone, or the
    // re-extraction of this same file already regenerates its own outbound edges through the
    // normal resolveAndWriteEdges pass — so those stay hard-deleted below.
    let inboundEdgesRescued = 0;
    if (archivedIds.length) {
      const { rowCount: rescuedCount } = await client.query(
        `UPDATE edges
            SET to_node_id = NULL
          WHERE to_node_id IN (SELECT value FROM json_each($1))
            AND NOT (from_node_id IN (SELECT value FROM json_each($1)))
            AND edge_type = 'CALLS'
            AND json_type(properties, '$.called_name') IS NOT NULL`,
        [archivedIds],
      );
      inboundEdgesRescued = rescuedCount;

      await client.query(
        `DELETE FROM edges
          WHERE from_node_id IN (SELECT value FROM json_each($1)) OR to_node_id IN (SELECT value FROM json_each($1))`,
        [archivedIds],
      );
      await client.query(
        `DELETE FROM method_text_index WHERE node_id IN (SELECT value FROM json_each($1))`,
        [archivedIds],
      );
    }

    await invalidateFileDerivedArtifacts(client, {
      branchId,
      fileId,
      repositoryId,
      archivedNodeIds: archivedIds,
    });

    await client.query('COMMIT');

    const results = prepared.map((row, i) => ({
      originalIndex: row.originalIndex,
      source: row.source,
      id: keyToId.get(ckByOriginal[i]) ?? null,
      canonicalKey: ckByOriginal[i],
      nd: row.nd,
    }));

    return {
      status: 'replaced',
      keyToId,
      archivedIds,
      archivedKeys: archived.map((r) => r.canonical_key),
      results,
      nodeCount: keyToId.size,
      // Visibility into inbound-edge integrity across this replacement — rescued =
      // archived-node inbound edges turned into stubs instead of deleted; reattached = stubs
      // (from this or an earlier call) this call's freshly-written nodes just resolved.
      inboundEdgesRescued,
      inboundEdgesReattached,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function carryForwardGenerationMembership({
  branchId,
  generationId,
  touchedFileIds = [],
  db = pool,
}) {
  const touched = (touchedFileIds || []).filter((id) => Number.isFinite(id));
  if (!generationId || !branchId) return 0;

  const params = [branchId, generationId];
  let fileClause = '';
  if (touched.length) {
    params.push(touched);
    fileClause = ` AND NOT (n.file_id IN (SELECT value FROM json_each($3)))`;
  }

  const { rowCount } = await db.query(
    `UPDATE nodes AS n SET ingest_generation_id = $2,
            last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE n.repository_branch_id = $1
        AND n.approval_status = 'APPROVED'
        AND n.ingest_generation_id IS NOT $2
        ${fileClause}`,
    params,
  );
  return rowCount || 0;
}

module.exports = {
  EXTRACTOR_VERSION,
  prepareNodeRow,
  replaceChangedFileFacts,
  carryForwardGenerationMembership,
  invalidateFileDerivedArtifacts,
};
