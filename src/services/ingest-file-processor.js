'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pool = require('../db/pool');
const { classify, classifyByContent, shouldPreferContentClassification, isContentClassifiable, isExtractable } = require('./classifier');
const { stampMethodIdentities } = require('./ingest-helpers');
const { buildAstNodes, extractVueSfc, extractPortedTreeSitter, harvestSpans, SUPPORTED_GRAMMAR_EXTS } = require('./ast-extractor');
const { langFor } = require('./lang-ext');
const { deriveSemanticNodes } = require('./semantic-typing');
const { shouldProcess } = require('./ingest-scope');
const { chunkTextByLines, detectClassifiableContent, DEFAULT_MAX_BYTES } = require('./ingest-policy');
const { writeSourceCache, shouldCacheSource } = require('./source-excerpts');
const { writeFileChunks } = require('./lexical-text-store');
const { upsertFileSummary } = require('./file-summary');
const { replaceChangedFileFacts } = require('./changed-file-replacement');
const { enqueueIngestRetry } = require('./ingest-job-state');
const { computeIndexerFingerprint, computeCacheKey, getCachedExtraction, putCachedExtraction } = require('./extraction-cache');

// Single source of truth for the oversize threshold lives in ingest-policy.js — not a second
// hardcoded value that could silently drift from the policy default.
const MAX_BYTES = DEFAULT_MAX_BYTES;

function createExtractionDecisions() {
  return {
    parser_only: 0,
    parser_plus_semantic_llm: 0,
    llm_required: 0,
    skipped_scope: 0,
    skipped_binary: 0,
    skipped_vendor: 0,
    skipped_oversize: 0,
    llm_cache_hit: 0,
    llm_cache_miss: 0,
    extraction_cache_hit: 0,
    extraction_cache_miss: 0,
  };
}

function createFileCounters() {
  return {
    done: 0,
    skipped: 0,
    errors: 0,
    nodes: 0,
    astEdgesWritten: 0,
    parseFailures: 0,
    llmCacheMisses: 0,
    schemaRepairAttempts: 0,
    schemaRepairRecovered: 0,
    schemaRepairFailed: 0,
    shaSkipped: 0,
    sourceCacheFailures: 0,
    parseFailureSample: [],
    llmErrorSample: [],
    degradedFiles: 0,
    degradedFileSample: [],
    truncatedFiles: 0,
    truncatedFileSample: [],
    spansHarvested: 0,
    extractionCacheHits: 0,
    extractionCacheMisses: 0,
    extractionDecisions: createExtractionDecisions(),
  };
}

function createPendingCollectors() {
  return {
    pendingEdges: [],
    pendingRelativeImports: [],
    pendingSqlRefs: [],
    pendingConfigRefs: [],
    // {fileId, imports: [{name,module,alias,line}]} per file — consumed by ingest.js's
    // FILE-node-creation loop to stamp `properties.imports` on each file's FILE node.
    pendingImportFacts: [],
    // {fromNodeId, toName, line} — a declared field's type name base.js#walkGeneric could not
    // resolve same-file. Kept separate from `pendingEdges` (CALLS/EXTENDS/IMPLEMENTS/
    // DEPENDS_ON's shared branch-wide-name-match cascade) on purpose —
    // ingest.js#resolveTypeReferenceEdges tries import evidence ONLY and refuses otherwise,
    // never the module_stem/global_label fallbacks pendingEdges' own resolver waterfall tries.
    pendingTypeReferences: [],
    // {fileId, refs: [{module, line}]} per file — consumed by ingest.js#resolveReExportEdges
    // to write FILE-to-FILE RE_EXPORTS edges.
    pendingReExports: [],
  };
}

function createFileProcessorState() {
  return {
    counters: createFileCounters(),
    pending: createPendingCollectors(),
  };
}

function classifyIngestFile(relPath, content, stack) {
  let fileType = classify(relPath, stack);
  if (fileType === 'OTHER' || isContentClassifiable(relPath)) {
    let byContent = null;
    if (isContentClassifiable(relPath)) {
      try {
        byContent = classifyByContent(relPath, content, stack);
      } catch (_) {}
    } else if (detectClassifiableContent(content)) {
      try {
        if (/^\s*(?:package|import)\s/m.test(content)) {
          byContent = classifyByContent(`${relPath}.java`, content, stack);
        } else if (/export\s+/.test(content)) {
          byContent = classifyByContent(`${relPath}.ts`, content, stack);
        } else if (/^\s*(?:async\s+)?def\s+\w+/m.test(content)) {
          byContent = classifyByContent(`${relPath}.py`, content, stack);
        }
      } catch (_) {}
    }
    if (byContent && (fileType === 'OTHER' || shouldPreferContentClassification(fileType, byContent))) {
      fileType = byContent;
    }
  }
  return fileType;
}

function parserPathForContent(relPath, fileType) {
  if (SUPPORTED_GRAMMAR_EXTS.has(path.extname(relPath).toLowerCase())) return relPath;
  if (/^(?:NODE|REACT|ANGULAR|VUE)_/.test(fileType)) return `${relPath}.ts`;
  if (/^PYTHON_/.test(fileType)) return `${relPath}.py`;
  if (['CONTROLLER', 'SERVICE', 'REPOSITORY', 'ENTITY', 'SCHEDULER', 'CONFIG', 'CONSTANTS'].includes(fileType)) {
    return `${relPath}.java`;
  }
  return relPath;
}


// Terminal extraction failures (llm_error, parse_failure with no AST fallback,
// schema_repair_failed) must each leave an honest manifest reason so the coverage table stops
// reporting NULL for files that actually failed. Best-effort: a bookkeeping failure here must
// never abort the ingest.
async function stampCoverageReason(jobId, relPath, reason, queryFn) {
  if (!jobId || !relPath || !reason) return;
  try {
    await queryFn(
      `UPDATE ingest_coverage_files SET reason = $3 WHERE job_id = $1 AND path = $2`,
      [jobId, relPath, reason],
    );
  } catch (err) {
    console.error(`[ingest] [COVERAGE_REASON] ${relPath}: ${err.message}`);
  }
}

// Persist how many chunks an oversize file was split into so "which files lost chunks"
// becomes a query against the chunk_count column instead of an inference from log absence.
// Best-effort, same as stampCoverageReason: a bookkeeping failure here must never abort the
// ingest.
async function stampChunkCount(jobId, relPath, chunkCount, queryFn) {
  if (!jobId || !relPath || !chunkCount) return;
  try {
    await queryFn(
      `UPDATE ingest_coverage_files SET chunk_count = $3 WHERE job_id = $1 AND path = $2`,
      [jobId, relPath, chunkCount],
    );
  } catch (err) {
    console.error(`[ingest] [COVERAGE_CHUNK_COUNT] ${relPath}: ${err.message}`);
  }
}

// ENG0d — terminal extraction failures must leave an ingest_retry_queue row, not just a
// coverage reason, so operators (and future automation) can see "this file needs another
// pass" rather than the failure vanishing into a warning string nobody re-reads. No live
// checkout is retained after a job completes, so these are not auto-executable today
// (see executeRetryItem's 'extraction_retry' case in ingest-job-state.js) — maxAttempts:1
// means they land in FAILED with a clear last_error rather than retrying forever.
async function enqueueExtractionFailureRetry({ jobId, projectId, branchId, relPath, failureReason, fileId, queryFn }) {
  if (!jobId || !relPath) return;
  try {
    await enqueueIngestRetry({
      ingestJobId: jobId,
      projectId,
      branchId,
      workType: 'extraction_retry',
      idempotencyKey: `extraction:${jobId}:${relPath}`,
      payload: { relPath, failureReason, fileId },
      maxAttempts: 1,
      db: { query: queryFn },
    });
  } catch (err) {
    console.error(`[ingest] [RETRY_QUEUE] ${relPath}: ${err.message}`);
  }
}

// Fills end_line only where it's missing and the harvested span map has a
// matching entry by name. Never overwrites an existing span, never invents
// one on a name mismatch (a miss just leaves end_line as-is). Looked up by
// the node's own node_type:name first (exact), then falls back to CLASS:name
// / METHOD:name — the LLM's semantic classification (REPOSITORY, SERVICE,
// UTILITY, ENDPOINT, ...) is a role on top of the same class/method-shaped
// source declaration the AST parses, so a bare CLASS/METHOD key with a
// matching name is still the correct span, just under a different label.
// harvestSpans returns every occurrence per key, so a declared start_line selects its OWN
// span instead of inheriting the first same-named declaration's end_line (which would produce
// start>end spans on Java overloads and on an interface method beside its implementation). A
// node with no start_line keeps first-match behaviour; a node whose start_line matches no
// occurrence is left untouched rather than given a foreign span.
function _selectSpan(entries, nd) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const declaredStart = nd.start_line ?? nd.line ?? null;
  if (declaredStart == null) return entries[0];
  return entries.find((e) => e.start_line === declaredStart)
    || entries.find((e) => e.start_line <= declaredStart && declaredStart <= e.end_line)
    || null;
}

function _fillMissingSpans(nodes, spanMap, counters) {
  if (!spanMap || spanMap.size === 0) return;
  for (const nd of nodes) {
    if (!nd || nd.end_line != null) continue;
    if (!nd.node_type || !nd.name) continue;
    const span = _selectSpan(spanMap.get(`${nd.node_type}:${nd.name}`), nd)
      || _selectSpan(spanMap.get(`CLASS:${nd.name}`), nd)
      || _selectSpan(spanMap.get(`METHOD:${nd.name}`), nd);
    if (!span) continue;
    nd.start_line = nd.start_line ?? nd.line ?? span.start_line;
    nd.end_line = span.end_line;
    if (counters) counters.spansHarvested = (counters.spansHarvested || 0) + 1;
  }
}

function _remapBlockDefinedIn(astNodes, edge, relPath) {
  if (!['.rb', '.php'].includes(path.extname(relPath).toLowerCase()) || edge.edgeType !== 'DEFINED_IN') return edge;
  const method = astNodes[edge.fromIndex];
  if (!method?.start_line) return edge;
  const containing = astNodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => (
      node?.node_type === 'CLASS'
      && node.start_line != null
      && node.end_line != null
      && node.start_line < method.start_line
      && method.start_line <= node.end_line
      && (method.end_line == null || method.end_line <= node.end_line)
    ))
    .sort((a, b) => (
      (a.node.end_line - a.node.start_line) - (b.node.end_line - b.node.start_line)
      || b.node.start_line - a.node.start_line
    ));
  if (containing.length === 0) return null;
  return { ...edge, toIndex: containing[0].index };
}

// Give every METHOD node the owner its own extraction pass already proved, so
// computeCanonicalKey can tell an interface method from its implementation instead of
// collapsing them. Uses the SAME _remapBlockDefinedIn the edge writer below uses, so the
// stamped owner is always the class the DEFINED_IN edge will actually point at.
// Plane-agnostic on purpose: the collapse can happen on the Java, Go and TypeScript planes,
// and every plane emits DEFINED_IN through this list.
function _stampMethodOwners(astNodes, structuralEdges, relPath) {
  if (!Array.isArray(astNodes)) return;
  const definedIn = [];
  for (const se of structuralEdges || []) {
    if (se?.edgeType !== 'DEFINED_IN') continue;
    const mapped = _remapBlockDefinedIn(astNodes, se, relPath);
    if (mapped) definedIn.push(mapped);
  }
  stampMethodIdentities(astNodes, definedIn);
}

// The AST and LLM planes write into the same canonical-key space and are merged by
// dedupeRowsByCanonicalKey. Owner-qualifying only the AST plane would break that merge: an LLM
// node describing the same method carries no DEFINED_IN evidence, so it would key differently
// and land as a SECOND live node (reproduced live: `Calc(int a)::add` from AST beside
// `(int a)::add` from the LLM). Copy the AST plane's decided
// identity onto the LLM node it describes; an LLM method the AST never found keeps the
// unqualified key it had before, unchanged.
function _alignLlmMethodIdentity(astNodes, llmNodes) {
  if (!Array.isArray(astNodes) || !Array.isArray(llmNodes) || !llmNodes.length) return;
  const byName = new Map();
  for (const nd of astNodes) {
    if (!nd || nd.node_type !== 'METHOD' || !nd.name) continue;
    if (!byName.has(nd.name)) byName.set(nd.name, []);
    byName.get(nd.name).push(nd);
  }
  if (!byName.size) return;
  for (const nd of llmNodes) {
    if (!nd || nd.node_type !== 'METHOD' || !nd.name) continue;
    const candidates = byName.get(nd.name);
    if (!candidates || !candidates.length) continue;
    const declared = nd.start_line ?? nd.line ?? null;
    let match = null;
    if (declared != null) {
      match = candidates.find((c) => c.start_line === declared)
        || candidates.find((c) => c.start_line != null && c.end_line != null
          && c.start_line <= declared && declared <= c.end_line)
        || null;
    }
    // With one AST candidate there is nothing to be ambiguous about, so an LLM line estimate
    // that missed still merges. With several, refusing to guess is the safe answer: guessing
    // wrong would attach the LLM's summary to the wrong overload.
    if (!match && candidates.length === 1) match = candidates[0];
    if (!match) continue;
    nd._owner = match._owner;
    nd._methodIdentity = match._methodIdentity;
  }
}

function _phpTraitUses(astNodes, content, relPath) {
  if (path.extname(relPath).toLowerCase() !== '.php' || typeof content !== 'string') {
    return { edges: [], lines: new Set() };
  }
  const edges = [];
  const lines = new Set();
  const sourceLines = content.split('\n');
  for (let index = 0; index < sourceLines.length; index++) {
    const match = sourceLines[index].match(/^\s*use\s+([A-Za-z_\\][\w\\]*(?:\s*,\s*[A-Za-z_\\][\w\\]*)*)\s*;/);
    if (!match) continue;
    const line = index + 1;
    const owners = astNodes
      .map((node, nodeIndex) => ({ node, nodeIndex }))
      .filter(({ node }) => (
        node?.node_type === 'CLASS'
        && node.kind === 'class'
        && node.start_line < line
        && line <= node.end_line
      ))
      .sort((a, b) => (
        (a.node.end_line - a.node.start_line) - (b.node.end_line - b.node.start_line)
        || b.node.start_line - a.node.start_line
      ));
    if (owners.length === 0) continue;
    lines.add(line);
    for (const rawName of match[1].split(',')) {
      const toName = rawName.trim().split('\\').pop();
      if (toName) edges.push({
        fromIndex: owners[0].nodeIndex,
        toName,
        edgeType: 'IMPLEMENTS',
        evidenceLine: line,
      });
    }
  }
  return { edges, lines };
}

async function commitExtractedNodes({
  astResult,
  extracted,
  fileId,
  branchId,
  fileSha,
  relPath,
  ingestGenerationId,
  repositoryId,
  counters,
  pending,
  writeAstEdges,
  logPrefix,
  deps = {},
  spanMap = null,
  content = null,
}) {
  const astNodes = astResult?.nodes || [];
  if (spanMap) {
    _fillMissingSpans(astNodes, spanMap, counters);
    _fillMissingSpans(extracted || [], spanMap, counters);
  }
  // Tell replaceChangedFileFacts whether the source genuinely has no content (a real
  // deletion/truncation, which must archive normally) vs. still having content that this
  // extraction pass just failed to produce nodes from.
  const sourceEmpty = typeof content === 'string' ? content.trim().length === 0 : false;
  _stampMethodOwners(astNodes, astResult?.structuralEdges, relPath);
  _alignLlmMethodIdentity(astNodes, extracted || []);

  // Deterministic semantic role typing (semantic-typing.js). Reads the annotations the AST
  // plane already captured and emits the SERVICE / REPOSITORY / ENDPOINT / TEST nodes that
  // were previously only ever produced by the semantic LLM call. Appended AFTER the two
  // passes above, whose index-based bookkeeping is over the original AST nodes only.
  if (process.env.SEMANTIC_TYPING !== 'off') {
    try {
      const derived = deriveSemanticNodes(astNodes, {
        structuralEdges: astResult?.structuralEdges || [],
        relPath,
        lang: langFor(relPath),
        source: typeof content === 'string' ? content : null,
      });
      for (const patch of derived.patches || []) {
        if (astNodes[patch.index]) astNodes[patch.index].auth_annotation = patch.auth_annotation;
      }
      if (derived.nodes.length) {
        astNodes.push(...derived.nodes);
        if (Array.isArray(astResult?.structuralEdges)) astResult.structuralEdges.push(...derived.edges);
        counters.semanticRoleNodes = (counters.semanticRoleNodes || 0) + derived.nodes.length;
      }
    } catch (err) {
      console.warn(`[semantic-typing] ${relPath}: ${err.message}`);
    }
  }
  const replacement = await replaceChangedFileFacts({
    branchId,
    fileId,
    fileSha,
    relPath,
    ingestGenerationId,
    astNodes,
    llmNodes: extracted,
    repositoryId,
    sourceEmpty,
    db: deps.query ? { connect: async () => ({ query: deps.query, release: () => {} }) } : undefined,
  });

  if (replacement.status === 'validation_failed') {
    throw new Error(`file fact validation failed: ${(replacement.errors || []).join('; ')}`);
  }

  counters.nodes += replacement.nodeCount;

  const astResults = replacement.results.filter((r) => r.source === 'ast');
  const astNodeIndexToId = new Map();
  for (const r of astResults) {
    astNodeIndexToId.set(r.originalIndex, r.id);
  }

  if (astResult) {
    const {
      structuralEdges,
      inheritanceEdges,
      relativeImportEdges,
      sqlReferences,
      configValueRefs,
      unresolvedCalls,
      typeReferences,
      importFacts,
      reExports,
    } = astResult;
    const phpTraitUses = _phpTraitUses(astNodes, content, relPath);
    const effectiveInheritanceEdges = [...(inheritanceEdges || []), ...phpTraitUses.edges];

    if (structuralEdges?.length > 0) {
      const resolvedAstEdges = [];
      for (const se of structuralEdges) {
        const mappedEdge = _remapBlockDefinedIn(astNodes, se, relPath);
        if (!mappedEdge) continue;
        const fromId = astNodeIndexToId.get(mappedEdge.fromIndex);
        const toId = astNodeIndexToId.get(mappedEdge.toIndex);
        if (fromId && toId && fromId !== toId) resolvedAstEdges.push([fromId, toId, mappedEdge.edgeType, mappedEdge.resolution, mappedEdge.evidenceLine ?? null, mappedEdge.calleeName ?? null]);
      }
      counters.astEdgesWritten += await writeAstEdges(resolvedAstEdges);
    }

    if (effectiveInheritanceEdges.length > 0) {
      const astNodeNameToIndex = new Map();
      for (let ni = 0; ni < astNodes.length; ni++) {
        // Semantic role nodes (semantic-typing.js) deliberately carry the SAME name as the
        // class they describe — SERVICE ClinicServiceImpl sits beside CLASS
        // ClinicServiceImpl. This map is last-write-wins, so without the skip an
        // `extends`/`implements` edge would resolve onto the role node instead of the
        // declaration it actually inherits from.
        if (astNodes[ni].extraction_source_hint === 'ast_semantic') continue;
        if (astNodes[ni].name) astNodeNameToIndex.set(astNodes[ni].name, ni);
      }
      for (const ie of effectiveInheritanceEdges) {
        let fromId;
        if (ie.fromIndex !== undefined) {
          fromId = astNodeIndexToId.get(ie.fromIndex);
        } else if (ie.fromName) {
          const idx = astNodeNameToIndex.get(ie.fromName);
          if (idx !== undefined) fromId = astNodeIndexToId.get(idx);
        }
        if (fromId && ie.toName) {
          // This hint is NOT read by ingest.js#resolveAndWriteEdges — that path derives
          // confidence_tier from HOW the name resolved (import/module_stem -> EXTRACTED,
          // everything else -> INFERRED), so a pendingEdges entry resolved in-branch already
          // lands INFERRED unless it is genuinely import-proven. It IS read by
          // resolveCrossRepoEdges (`e.confidenceTier ?? 'INFERRED'`) when the in-branch pass
          // leaves it unresolved and it escalates cross-repo. The legacy inheritanceEdges
          // never set a tier, so `?? 'EXTRACTED'` reproduces its existing value; ported's
          // cross-file-only entries set `confidenceTier: 'INFERRED'` explicitly — a
          // name-guessed edge must not inherit the top tier by default.
          pending.pendingEdges.push({
            fromNodeId: fromId,
            toName: ie.toName,
            edgeType: ie.edgeType,
            confidenceTier: ie.confidenceTier ?? 'EXTRACTED',
            // The legacy inheritanceEdges sites carry evidenceLine — never fabricated when absent.
            callLine: ie.evidenceLine ?? null,
          });
        }
      }
    }

    if (relativeImportEdges?.length > 0) {
      for (const rie of relativeImportEdges) {
        const fromId = astNodeIndexToId.get(rie.fromIndex);
        if (fromId) {
          pending.pendingRelativeImports.push({ fromNodeId: fromId, targetRelPath: rie.targetRelPath });
        }
      }
    }

    if (sqlReferences?.length > 0) {
      pending.pendingSqlRefs.push({ fileId, refs: sqlReferences });
    }
    if (configValueRefs?.length > 0) {
      pending.pendingConfigRefs.push({ fileId, refs: configValueRefs });
    }
    // IMPORT nodes retired — import facts are collected per file here and attached onto the
    // FILE node's properties.imports later (ingest.js's FILE-node-creation loop, which runs
    // after every file in the branch has committed), not written as their own node/edge in
    // this per-file pass.
    const effectiveImportFacts = (importFacts || []).filter((fact) => !phpTraitUses.lines.has(fact.line));
    if (effectiveImportFacts.length > 0) {
      pending.pendingImportFacts.push({ fileId, imports: effectiveImportFacts });
    }
    if (reExports?.length > 0) {
      pending.pendingReExports.push({ fileId, refs: reExports });
    }

    // Deferred cross-file calls (base.js's walkGeneric, via _adaptPortedResult) queued into
    // the same pendingEdges array the LLM plane already feeds, so resolveAndWriteEdges'
    // module-stem pass (tried before the byName fan-out heuristics) gets a shot at them once
    // the whole branch's fileIndex/symbolIndex exist.
    if (unresolvedCalls?.length > 0) {
      for (const uc of unresolvedCalls) {
        const fromId = astNodeIndexToId.get(uc.fromIndex);
        if (fromId && uc.calleeName) {
          // Carry the call-site line through to resolveAndWriteEdges so branch-wide-resolved
          // CALLS edges aren't lineless too. Also carry `receiverName` (the accessor residue —
          // `Bar.baz()` where `Bar` couldn't be bound same-file) so resolveAndWriteEdges's
          // receiver-import rung has something to resolve; `'self'`-canonicalised residue
          // (this/super misses) has no import-alias meaning but is still forwarded unchanged —
          // the receiver-import resolver's own import-alias lookup naturally refuses it (no
          // import is ever named 'self'), so no filtering is needed here.
          pending.pendingEdges.push({ fromNodeId: fromId, toName: uc.calleeName, edgeType: uc.edgeType || 'CALLS', callLine: uc.line ?? null, receiverName: uc.receiverName ?? null });
        }
      }
    }

    // Declared field types base.js couldn't resolve same-file — queued separately from
    // pendingEdges (see createPendingCollectors' comment on pendingTypeReferences for why:
    // import-evidence-only resolution, no name-matching fallback).
    if (typeReferences?.length > 0) {
      for (const tr of typeReferences) {
        const fromId = astNodeIndexToId.get(tr.fromIndex);
        if (fromId && tr.toName) {
          pending.pendingTypeReferences.push({ fromNodeId: fromId, toName: tr.toName, line: tr.line ?? null });
        }
      }
    }
  }

  for (const r of replacement.results.filter((entry) => entry.source === 'llm')) {
    const { id, nd } = r;
    if (!id || !nd) continue;
    for (const e of (Array.isArray(nd.edges) ? nd.edges : [])) {
      if (e && e.to_name && e.edge_type) {
        pending.pendingEdges.push({ fromNodeId: id, toName: e.to_name, edgeType: e.edge_type });
      }
    }
  }

  return replacement;
}

async function extractIngestFile({
  relPath,
  fullPath,
  content: contentIn,
  fileType: fileTypeIn,
  stack,
  ignorePatterns = [],
  policy = null,
  chunked = false,
  maxFileBytes = MAX_BYTES,
  storedFileSha = null,
  shaSkipEnabled = true,
  counters,
  logPrefix = '[ingest]',
  deps = {},
}) {
  const readFile = deps.readFileSync || fs.readFileSync;
  const statFile = deps.statSync || fs.statSync;
  const existsFn = deps.existsSync || fs.existsSync;

  if (!existsFn(fullPath)) {
    counters.skipped++;
    return { status: 'skipped', reason: 'missing_file' };
  }

  let stat;
  try {
    stat = statFile(fullPath);
  } catch (_) {
    counters.skipped++;
    return { status: 'skipped', reason: 'unreadable' };
  }

  const oversizeAction = policy?.size?.oversize || (chunked ? 'chunk' : 'skip');
  const byteLimit = policy?.size?.max_bytes || maxFileBytes || MAX_BYTES;
  const isOversize = stat.size > byteLimit;

  if (isOversize && oversizeAction === 'skip') {
    counters.skipped++;
    counters.extractionDecisions.skipped_oversize++;
    return { status: 'skipped', reason: 'oversize' };
  }

  let content = contentIn ?? readFile(fullPath, 'utf8');
  const rawContent = content;
  if (!content.trim()) {
    counters.skipped++;
    counters.extractionDecisions.skipped_scope++;
    return { status: 'skipped', reason: 'empty' };
  }

  let chunkMeta = null;
  if (isOversize && oversizeAction === 'chunk') {
    const chunks = chunkTextByLines(content, byteLimit);
    chunkMeta = {
      chunked: true,
      chunkTotal: chunks.length,
      chunkIndex: 0,
      startLine: chunks[0].startLine,
      endLine: chunks[0].endLine,
    };
    content = chunks[0].content;
    // Only chunk 0 is indexed, so chunks 2..N are lost. Count it so the coverage
    // manifest reports truncation instead of implying the whole file was read.
    if (chunks.length > 1) {
      counters.truncatedFiles = (counters.truncatedFiles || 0) + 1;
      if (!counters.truncatedFileSample) counters.truncatedFileSample = [];
      if (counters.truncatedFileSample.length < 25) {
        counters.truncatedFileSample.push(`${relPath} (chunk 1/${chunks.length})`);
      }
    }
  }

  const fileType = fileTypeIn ?? classifyIngestFile(relPath, content, stack);
  if (!isExtractable(fileType)) {
    counters.skipped++;
    return { status: 'skipped', reason: 'not_extractable' };
  }
  if (!shouldProcess(relPath, fileType, { ignorePatterns, policy, fileSizeBytes: stat.size, maxFileBytes: byteLimit })) {
    counters.skipped++;
    counters.extractionDecisions.skipped_scope++;
    return { status: 'skipped', reason: 'scope' };
  }

  const fileSha = crypto.createHash('sha256').update(rawContent).digest('hex').slice(0, 40);

  if (shaSkipEnabled && storedFileSha && storedFileSha === fileSha) {
    counters.shaSkipped++;
    counters.skipped++;
    return { status: 'sha_skipped', fileSha, fileType, content };
  }

  // Content-derived extraction cache. Keyed on (content, relPath), gated on
  // indexer_fingerprint so a change to extractors/** or resolution/**
  // invalidates every row without a hand-maintained version constant. A hit skips
  // both the AST parse and the LLM call below; a miss runs them as before and, if
  // the result is non-empty and non-partial, writes the cache row for next time.
  const extractionCacheKey = computeCacheKey(rawContent, relPath);
  const indexerFingerprint = computeIndexerFingerprint();
  // Opt-in, not opt-out: the underlying table is process-wide (keyed on content+path, not
  // scoped to a project or test run), so defaulting it on makes every test that calls
  // extractIngestFile with a real DB pool and deterministic fixture content flaky across
  // repeated runs. Like shaSkipEnabled, a new cache mechanism stays opt-in until the thing
  // that actually exercises it explicitly turns it on.
  let cacheHit = null;
  if (process.env.FILE_EXTRACTION_CACHE === 'on') {
    try {
      cacheHit = await (deps.getCachedExtraction || getCachedExtraction)(extractionCacheKey, indexerFingerprint, deps);
    } catch (cacheErr) {
      console.error(`${logPrefix} [EXTRACTION_CACHE] ${relPath}: ${cacheErr.message}`);
    }
  }

  let astResult = null;
  let extracted = [];

  if (cacheHit) {
    counters.extractionCacheHits = (counters.extractionCacheHits || 0) + 1;
    counters.extractionDecisions.extraction_cache_hit++;
    astResult = { nodes: cacheHit.astNodes, ...cacheHit.edgeBucket };
    extracted = cacheHit.llmNodes;
  } else {
    counters.extractionCacheMisses = (counters.extractionCacheMisses || 0) + 1;
    counters.extractionDecisions.extraction_cache_miss++;

    try {
      // The AST plane is a local parser, not an LLM call, so the LLM's
      // chunk-truncated `content` is the wrong input for it. Parse the ORIGINAL
      // `rawContent` here; `content` (possibly chunk 0 only) stays reserved for
      // the LLM path below.
      const _ext = path.extname(relPath).toLowerCase();
      astResult = _ext === '.vue'
        ? await extractVueSfc(rawContent, relPath)
        : (_ext === '.rb' || _ext === '.rs')
          ? await extractPortedTreeSitter(rawContent, relPath)
          : buildAstNodes(rawContent, relPath, parserPathForContent(relPath, fileType));
    } catch (astErr) {
      console.error(`${logPrefix} [AST] ${relPath}: ${astErr.message}`);
    }

    counters.extractionDecisions.parser_only++;
  }

  // Span harvest: a second, independent tree-sitter pass whose only job is to fill a missing
  // end_line on nodes produced by the LLM/regex/AST tiers above — deliberately NOT gated to
  // `!isExtractable` like the generic-AST node-emitting pass in ingest.js, since span-filling
  // applies to extractable files too (e.g. Java, which is LLM-extracted but was emitting
  // end_line:null). Runs regardless of cache hit/miss — it is a local tree-sitter re-parse,
  // not an LLM call.
  let spanMap = null;
  const harvestExt = path.extname(relPath).toLowerCase();
  if (SUPPORTED_GRAMMAR_EXTS.has(harvestExt)) {
    try {
      spanMap = await harvestSpans(fullPath, content);
    } catch (spanErr) {
      console.error(`${logPrefix} [SPAN_HARVEST] ${relPath}: ${spanErr.message}`);
    }
  }


  if (process.env.FILE_EXTRACTION_CACHE === 'on' && !cacheHit) {
    // Never cache a zero-node result (a large share of extractions return zero nodes; caching
    // that would make the gap permanent). `partial` means only "the LLM plane saw a
    // chunk-truncated view" — it no longer blocks the write outright, since the AST plane
    // above was parsed against the full `rawContent` and is complete regardless of chunking.
    const astNodesOut = astResult?.nodes || [];
    const isPartial = Boolean(chunkMeta?.chunked);
    const astComplete = astResult != null;
    if (astNodesOut.length > 0 || extracted.length > 0) {
      try {
        await (deps.putCachedExtraction || putCachedExtraction)({
          cacheKey: extractionCacheKey,
          fingerprint: indexerFingerprint,
          astNodes: astNodesOut,
          llmNodes: extracted,
          edgeBucket: {
            structuralEdges: astResult?.structuralEdges || [],
            inheritanceEdges: astResult?.inheritanceEdges || [],
            relativeImportEdges: astResult?.relativeImportEdges || [],
            sqlReferences: astResult?.sqlReferences || [],
            configValueRefs: astResult?.configValueRefs || [],
            // importFacts was the one channel buildAstNodes returns that this
            // bucket did not carry, so a cache HIT produced a materially
            // different graph from a cache MISS on identical content. Measured
            // on golden spring-petclinic, same code, same SHA, back-to-back
            // runs: cold cache -> 466 import facts, 466 IMPORTS edges, 268
            // external-symbol bindings; warm cache -> 3 facts, 3 IMPORTS, 2
            // bindings. The FILE node's properties.imports is built from this,
            // and everything downstream (resolveImportFacts, the external-symbol
            // rung in resolveAndWriteEdges, receiver-import resolution) reads
            // that one field.
            importFacts: astResult?.importFacts || [],
          },
          partial: isPartial,
          astComplete,
        }, deps);
      } catch (cacheWriteErr) {
        console.error(`${logPrefix} [EXTRACTION_CACHE] ${relPath}: write failed: ${cacheWriteErr.message}`);
      }
    }
  }

  return {
    status: 'extracted',
    relPath,
    content,
    fileType,
    fileSha,
    astResult,
    extracted,
    chunkMeta,
    spanMap,
  };
}

async function commitIngestFile({
  extractResult,
  upsertFileFn,
  branchId,
  projectId,
  projectName,
  repoId,
  repoName,
  branchName,
  ingestGenerationId,
  counters,
  pending,
  jobId,
  updateJobFn,
  writeAstEdges,
  logPrefix = '[ingest]',
  deps = {},
}) {
  const queryFn = deps.query || pool.query.bind(pool);

  if (!extractResult || extractResult.status === 'skipped' || extractResult.status === 'sha_skipped') {
    return extractResult;
  }

  const { relPath, content, fileType, fileSha, astResult, extracted, spanMap, chunkMeta } = extractResult;

  const fileId = await upsertFileFn(branchId, relPath, fileType, fileSha);

  if (chunkMeta?.chunked && chunkMeta.chunkTotal > 1) {
    await stampChunkCount(jobId, relPath, chunkMeta.chunkTotal, queryFn);
  }

  let sourceCacheStored = false;
  try {
    const { store, skipReason } = shouldCacheSource(relPath, content);
    sourceCacheStored = store;
    await writeSourceCache({
      repositoryBranchId: branchId,
      fileId,
      fileSha,
      path: relPath,
      content: store ? content : null,
      skipReason,
      ingestGenerationId,
    });
  } catch (cacheErr) {
    counters.sourceCacheFailures++;
    console.error(`${logPrefix} [SOURCE_CACHE] ${relPath}: ${cacheErr.message}`);
  }

  if (sourceCacheStored) {
    try {
      await writeFileChunks({
        repositoryBranchId: branchId,
        fileId,
        fileSha,
        path: relPath,
        content,
        ingestGenerationId,
      });
    } catch (chunkErr) {
      console.error(`${logPrefix} [LEXICAL_CHUNKS] ${relPath}: ${chunkErr.message}`);
    }
  }

  try {
    const replacement = await commitExtractedNodes({
      astResult,
      extracted,
      fileId,
      branchId,
      fileSha,
      relPath,
      ingestGenerationId,
      repositoryId: repoId,
      counters,
      pending,
      writeAstEdges,
      logPrefix,
      deps,
      spanMap,
      content,
    });
    extractResult._replacement = replacement;
  } catch (commitErr) {
    counters.errors++;
    await queryFn(`UPDATE files SET index_status = 'FAILED' WHERE id = $1`, [fileId]);
    await stampCoverageReason(jobId, relPath, 'replacement_failed', queryFn);
    console.error(`${logPrefix} [REPLACE] ${relPath}: ${commitErr.message}`);
    throw commitErr;
  }

  // replaceChangedFileFacts already committed its own index_status='DEGRADED' write and
  // skipped replacement when the guard tripped.
  // Falling through to the isDegraded/COMPLETE logic below would silently clobber
  // that DEGRADED status back to COMPLETE — the plain-empty-response case
  // (Boolean(parseFailed)===false, e.g. a silent AST/LLM miss on real content) has
  // isDegraded=false there, so this file's coverage row and index_status would
  // report a clean success while the file's actual nodes are stale from a prior
  // generation. Short-circuit here so the guard's signal survives to the coverage
  // manifest, koragraph_logs, and the returned status.
  if (extractResult._replacement?.status === 'guarded_empty_extraction') {
    counters.degradedFiles = (counters.degradedFiles || 0) + 1;
    if (!counters.degradedFileSample) counters.degradedFileSample = [];
    if (counters.degradedFileSample.length < 25) counters.degradedFileSample.push(relPath);
    await stampCoverageReason(jobId, relPath, 'guarded_empty_extraction', queryFn);
    await enqueueExtractionFailureRetry({ jobId, projectId, branchId, relPath, failureReason: 'guarded_empty_extraction', fileId, queryFn });
    counters.done++;
    if (updateJobFn) {
      await updateJobFn(jobId, { files_done: counters.done, nodes_written: counters.nodes });
    }
    await queryFn(`
      INSERT INTO koragraph_logs (
        project_id, project_name, repository_id, repository_name,
        repository_branch_id, branch_name, file_id, file_path, file_type,
        model, input_tokens, output_tokens, total_tokens, cost_usd, index_status, node_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [projectId, projectName || repoName, repoId, repoName, branchId, branchName,
        fileId, relPath, fileType,
        'parser-only', 0, 0, 0, '0.00000000', 'DEGRADED', 0],
    );
    return { status: 'guarded_empty_extraction', fileId, fileSha, fileType, extracted: [], degraded: true };
  }

  // A single incidental AST node (e.g. one stray IMPORT) is not a real structural rescue of
  // a failed LLM extraction. Require
  // either enough nodes to be a real population (>=3) or at least one class-shaped
  // or method node — the node types that carry the semantic content the LLM pass lost.
  const astNodes = (astResult && astResult.nodes) || [];
  const hasAstCoverage = astNodes.length >= 3
    || astNodes.some((n) => n.node_type === 'CLASS' || n.node_type === 'ENTITY' || n.node_type === 'METHOD');
  const zeroExtractedNodes = !extracted || extracted.length === 0;
  const isDegraded = zeroExtractedNodes && !hasAstCoverage;

  if (isDegraded) {
    counters.degradedFiles = (counters.degradedFiles || 0) + 1;
    if (!counters.degradedFileSample) counters.degradedFileSample = [];
    if (counters.degradedFileSample.length < 25) counters.degradedFileSample.push(relPath);
    await queryFn(
      `UPDATE files SET index_status = 'DEGRADED', last_indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1`,
      [fileId],
    );
    console.error(`${logPrefix} [DEGRADED] ${relPath}: no structural nodes extracted`);
  } else {
    await queryFn(
      `UPDATE files SET index_status = 'COMPLETE', last_indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1`,
      [fileId],
    );
  }

  // ENG0d — three terminal-failure classes each get an honest manifest reason; the two
  // that fully lose the file's content (isDegraded parse_failure, schema_repair_failed)
  // also get a retry-queue row. A parse failure the AST rescued is recorded so the
  // coverage table stops claiming "no reason" for a file that DID fail LLM semantic
  // extraction, but it isn't retry-queued — it isn't lost, it kept structural coverage.
  if (isDegraded) {
    await stampCoverageReason(jobId, relPath, 'parse_failure', queryFn);
    await enqueueExtractionFailureRetry({ jobId, projectId, branchId, relPath, failureReason: 'parse_failure', fileId, queryFn });
  }

  upsertFileSummary({
    fileId,
    filePath: relPath,
    fileType,
    nodes: [...(astResult?.nodes || []), ...extracted],
    force: Boolean(extractResult._replacement?.archivedIds?.length),
    summaryGenerationId: ingestGenerationId,
  }).catch((sumErr) => {
    console.error(`${logPrefix} [FILE_SUMMARY] ${relPath}: ${sumErr.message}`);
  });

  counters.done++;
  if (updateJobFn) {
    await updateJobFn(jobId, { files_done: counters.done, nodes_written: counters.nodes });
  }

  // koragraph_logs.index_status must mirror the file's own status — hardcoding 'COMPLETE'
  // here even when the file above was just marked DEGRADED would make the Operations/Usage
  // dashboard silently count degraded extractions as completed.
  const logStatus = isDegraded ? 'DEGRADED' : 'COMPLETE';

  await queryFn(`
    INSERT INTO koragraph_logs (
      project_id, project_name, repository_id, repository_name,
      repository_branch_id, branch_name, file_id, file_path, file_type,
      model, input_tokens, output_tokens, total_tokens, cost_usd, index_status, node_count)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [projectId, projectName || repoName, repoId, repoName, branchId, branchName,
      fileId, relPath, fileType,
      'parser-only', 0, 0, 0, '0.00000000', logStatus, extracted.length],
  );

  return { status: 'done', fileId, fileSha, fileType, extracted, degraded: isDegraded };
}

async function processIngestFile(opts) {
  const extractResult = await extractIngestFile(opts);
  if (extractResult.status === 'skipped' || extractResult.status === 'sha_skipped') {
    return extractResult;
  }
  return commitIngestFile({ extractResult, ...opts });
}

function hashMethodTextPayload(methodText) {
  return crypto.createHash('sha256').update(methodText || '').digest('hex');
}

module.exports = {
  MAX_BYTES,
  createFileCounters,
  createPendingCollectors,
  createFileProcessorState,
  classifyIngestFile,
  commitExtractedNodes,
  extractIngestFile,
  commitIngestFile,
  processIngestFile,
  hashMethodTextPayload,
  stampCoverageReason,
  stampChunkCount,
  enqueueExtractionFailureRetry,
};
