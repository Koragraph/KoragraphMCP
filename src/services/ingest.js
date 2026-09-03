'use strict';

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { execSync } = require('child_process');

const { logger }     = require('../common-services/logger');
const pool           = require('../db/pool');
const { bulkWrite }  = require('../db/bulk');
const { classify, classifyByContent, shouldPreferContentClassification, isContentClassifiable, detectRepoType, isExtractable } = require('./classifier');
const { computeCanonicalKey, computeMethodOwnerQualifier, stampMethodIdentities, computeCoveragePct, resolveConfigRef } = require('./ingest-helpers');
const { buildFileScopedIndex } = require('./resolution/facts');
const { resolveDottedSuffixFile, sameLanguageFamily } = require('./resolution/symbol-index');
const { deriveConfidenceTier, resolveViaImportEvidence, resolveViaReceiverImport, resolveViaReceiverType, resolveViaModuleStem, resolveViaGlobalLabel, resolveImportNodeTarget, resolveRelativeImportPath, pyDottedRelativeToSlashSpec, clearTsconfigCaches } = require('./resolution/resolve');
const { edgeWriteTier } = require('./resolution/tiers');
const { loadIgnorePatterns } = require('./ingest-scope');
const {
  loadIngestPolicy,
  walkRepoWithPolicy,
  buildPolicyCoverageManifest,
  detectClassifiableContent,
  SKIP_REASONS,
  DEFAULT_MAX_BYTES,
} = require('./ingest-policy');
const {
  beginGeneration,
  failGeneration,
  activateGeneration,
} = require('./ingest-generation-service');
const {
  createFileProcessorState,
  extractIngestFile,
  commitIngestFile,
} = require('./ingest-file-processor');
const { runIngestPostTail } = require('./ingest-post-tail');
const { writeSourceCache, cacheableTextDecision } = require('./source-excerpts');
const { writeFileChunks } = require('./lexical-text-store');
const { finalizeIngestJob } = require('./ingest-job-state');
const { normalizeRepoWebUrl, validateRepoUrl } = require('./source-url');
const { buildCrossRepoBranchGroups } = require('./cross-repo-revision-scope');
const {
  detectWorkspacePackages,
  detectPublishedModules,
  assignPackageMembership,
  resolveWorkspaceLayout,
  buildWorkspaceManifest,
  buildWorkspacePackageIndex,
} = require('./workspace-layout');
const { buildGenericAstResult, buildAstNodes, extractGoQualifiedRefs, SUPPORTED_GRAMMAR_EXTS, awaitTreeSitterReady } = require('./ast-extractor');
const { parseSqlDdl } = require('./contract-parsers/sql-ddl');
const { parseOpenApi } = require('./contract-parsers/openapi');
const { parseProto } = require('./contract-parsers/proto');
const { parseThrift } = require('./contract-parsers/thrift');
const { extractGrpcFacts, extractThriftFacts } = require('./contract-parsers/grpc-facts');
const { extractTopicFacts, collectTopicBindings } = require('./contract-parsers/topic-facts');
const { parseManifest, isManifestPath } = require('./contract-parsers/manifest');
const { parseConfigFile } = require('./contract-config');

// File extension → ast-extractor language identifier
// Source-code extensions per stack — used to compute a meaningful "% understood"
// coverage metric (extractable code files / total code files), so non-code assets
// (json, html, css, properties) don't dilute the signal.
const CODE_EXTS_BY_STACK = {
  BACKEND: ['.java', '.kt'], JAVA_SPRING: ['.java', '.kt'],
  ANDROID: ['.java', '.kt'], IOS: ['.swift'],
  FLUTTER: ['.dart'], PYTHON: ['.py'],
  NODE: ['.js', '.ts', '.mjs', '.cjs'],
  REACT: ['.js', '.jsx', '.ts', '.tsx'],
  ANGULAR: ['.ts', '.js'],
  DOTNET: ['.cs'],
  GO: ['.go'],
  RUBY: ['.rb'],
  PHP: ['.php'],
  VUE: ['.vue', '.js', '.ts'],
  RUST: ['.rs'],
  KOTLIN: ['.kt', '.kts'],
  CPP: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.hh', '.hxx'],
};

// ─── File walking ─────────────────────────────────────────────────────────────

// Single source of truth for the oversize threshold lives in ingest-policy.js — a second
// hardcoded 200_000 here could silently drift from the policy default and from
// ingest-file-processor.js's own copy.
const MAX_BYTES = DEFAULT_MAX_BYTES;

function walkRepo(repoPath, subdir = null, oversizeSkips = null) {
  const policy = loadIngestPolicy(repoPath);
  const { files, skipped } = walkRepoWithPolicy(repoPath, { subdir, policy });

  if (oversizeSkips) {
    for (const entry of skipped) {
      if (entry.reason === SKIP_REASONS.OVERSIZE) {
        oversizeSkips.push({ path: entry.path, bytes: entry.bytes });
      }
    }
  }

  return files.map((f) => ({ rel: f.rel, full: f.full, chunked: !!f.chunked, sizeBytes: f.sizeBytes }));
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

function gitBranch(repoPath) {
  try { return execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, stdio: 'pipe' }).toString().trim(); }
  catch (_) { return null; }
}

function gitSha(repoPath) {
  try { return execSync('git rev-parse HEAD', { cwd: repoPath, stdio: 'pipe' }).toString().trim(); }
  catch (_) { return null; }
}

// `git diff --name-status` always reports paths relative to the WORKING TREE ROOT (where .git
// lives), never relative to cwd — standard git behaviour, not configurable short of --relative.
// When `repoPath` (the ingest root) is a SUBDIRECTORY of the git checkout — a monorepo pointed at
// one workspace, exactly the shape korainit and a real multi-package repo both hit — the diff
// paths need converting to ingest-root-relative before they mean anything to the rest of the
// incremental pipeline, which treats every path as relative to repoPath.
function gitTopLevel(repoPath) {
  try { return execSync('git rev-parse --show-toplevel', { cwd: repoPath, stdio: 'pipe' }).toString().trim(); }
  catch (_) { return null; }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

// `repoPath` is optional and only used to record what this repository PUBLISHES — the module
// name another repository writes to import it (migration 200). Callers with no checkout on disk
// simply leave the column as it was; nothing else depends on it being present.
async function upsertRepo(projectId, repoName, stack, sourceUrl, repoPath) {
  const webUrl = normalizeRepoWebUrl(sourceUrl);
  let publishedModules = null;
  if (repoPath) {
    try {
      const mods = detectPublishedModules(repoPath);
      if (mods && mods.length) publishedModules = JSON.stringify(mods);
    } catch (err) {
      logger.warn(`[upsertRepo] published-module detection failed for ${repoName}: ${err.message}`);
    }
  }

  // gitlab_project_id is only meaningful for real GitLab repos (migration 032 made it nullable).
  // GitHub and local repos use NULL — the semantic identity is (project_id, name).
  const { rows } = await pool.query(
    `INSERT INTO repositories (project_id, name, full_path, stack, web_url, published_modules)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (project_id, name) WHERE project_id IS NOT NULL
     DO UPDATE SET stack = EXCLUDED.stack,
                   web_url = COALESCE(EXCLUDED.web_url, repositories.web_url),
                   full_path = COALESCE(EXCLUDED.full_path, repositories.full_path),
                   published_modules = COALESCE(EXCLUDED.published_modules, repositories.published_modules)
     RETURNING id`,
    // full_path must hold a resolved path, not the repo NAME: the practice layer is its only
    // consumer and checks the checkout root before deciding a file was deleted; a bare name
    // resolves against the CWD, so every anchor would read as "unknown". repoName remains the
    // fallback because the column is NOT NULL and repoPath is optional.
    [projectId, repoName, repoPath ? path.resolve(repoPath) : repoName, stack, webUrl, publishedModules]
  );
  return rows[0].id;
}

async function upsertBranch(repoId, branchName, commitSha) {
  const { rows } = await pool.query(
    `INSERT INTO repository_branches (repository_id, branch_name, branch_role, is_tracked, last_commit_sha, sync_status)
     VALUES ($1, $2, 'PRODUCTION', true, $3, 'COMPLETE')
     ON CONFLICT (repository_id, branch_name) DO UPDATE SET last_commit_sha = EXCLUDED.last_commit_sha
     RETURNING id`,
    [repoId, branchName, commitSha]
  );
  return rows[0].id;
}

async function upsertFile(branchId, relPath, fileType, fileSha) {
  const { rows } = await pool.query(
    `INSERT INTO files (repository_branch_id, path, file_type, file_sha, index_status)
     VALUES ($1, $2, $3, $4, 'PENDING')
     ON CONFLICT (repository_branch_id, path) DO UPDATE SET file_type = EXCLUDED.file_type, file_sha = EXCLUDED.file_sha, index_status = 'PENDING'
     RETURNING id`,
    [branchId, relPath, fileType, fileSha]
  );
  return rows[0].id;
}

// Shared guard for the ~8 writeSourceCache callsites below — chunk only the text that
// actually got cached (decision.store), and never let a chunk-write failure take down the
// pass that called it (mirrors the writeSourceCache try/catch immediately above each callsite).
async function writeLexicalChunksIfStored(decision, { repositoryBranchId, fileId, fileSha, path: relPath, content, ingestGenerationId, logTag }) {
  if (!decision || !decision.store) return;
  try {
    await writeFileChunks({ repositoryBranchId, fileId, fileSha, path: relPath, content, ingestGenerationId });
  } catch (chunkErr) {
    console.warn(`[ingest] [${logTag}] lexical-chunks ${relPath}: ${chunkErr.message}`);
  }
}

// ─── Node write ───────────────────────────────────────────────────────────────

// Forward-only provenance normalization — callers still pass the legacy `provenance` field
// (generic_ast, contract_sql, contract_openapi, presence_floor, binary_stub, doc); rename it to
// `extraction_source` at write time so every new node carries the same key, without touching every
// call site. Old nodes already in the DB keep only `provenance` — readers must fall back via
// readExtractionSource(). Pure and exported so it is unit-testable without a DB.
function normalizeNodeProvenanceProps(props) {
  if (props.provenance !== undefined) {
    props.extraction_source = props.provenance;
    delete props.provenance;
  }
  return props;
}

async function writeNode(nd, fileId, branchId, fileSha, ingestGenerationId = null) {
  if (!nd.node_type || !nd.name) return null;
  const sourceFile = nd._sourceFile || null;
  // Mirrors changed-file-replacement.js#prepareNodeRow so the generic-AST plane
  // (C/C++, Swift, Scala, Rust, Ruby, PHP — every language isExtractable() rejects, which
  // writes through here rather than through replaceChangedFileFacts) gets the same
  // owner-qualified METHOD identity instead of collapsing same-named methods.
  const ownerQualifier = nd.node_type === 'METHOD'
    ? (nd._methodIdentity !== undefined ? nd._methodIdentity : computeMethodOwnerQualifier(nd))
    // A FIELD's identity is its declaring class; `name`/`id`/`type` recur across classes.
    : nd.node_type === 'FIELD' ? (nd.parent_class || null)
    // A nested type's identity includes the scope it is declared in; a top-level one has none.
    : nd.node_type === 'CLASS' ? (nd._container || null)
      : null;
  const canonicalKey = computeCanonicalKey(nd.node_type, nd.name, branchId, sourceFile, ownerQualifier);
  const props = { ...nd };
  ['node_type','name','summary','raw_evidence','confidence','confidence_tier','start_line','end_line','edges','_sourceFile','_owner','_container','_methodIdentity'].forEach(k => delete props[k]);
  normalizeNodeProvenanceProps(props);
  const propsJson = Object.keys(props).length ? JSON.stringify(props) : null;
  const tier = ['EXTRACTED','INFERRED','AMBIGUOUS'].includes(nd.confidence_tier) ? nd.confidence_tier : 'INFERRED';

  const { rows } = await pool.query(`
    INSERT INTO nodes
      (repository_branch_id, file_id, node_type, name, summary, raw_evidence,
       start_line, end_line,
       confidence, confidence_tier, file_sha_at_extract, approval_status, canonical_key, properties,
       ingest_generation_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'APPROVED',$12,$13,$14)
    ON CONFLICT (canonical_key)
      WHERE canonical_key IS NOT NULL
        AND repository_branch_id IS NOT NULL
        AND approval_status != 'ARCHIVED'
    DO UPDATE SET
      last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      file_id   = EXCLUDED.file_id,
      node_type = EXCLUDED.node_type,
      name      = EXCLUDED.name,
      -- summary and raw_evidence are the semantic plane's only outputs. Taking
      -- EXCLUDED.raw_evidence unconditionally while protecting summary with COALESCE does
      -- nothing when the incoming write supplies a non-null placeholder: an ENDPOINT
      -- carrying a real summary, quoted evidence and confidence 0.7 could be rewritten by
      -- the contract-OpenAPI pass to summary 'GET /api/orders', raw_evidence NULL,
      -- confidence 1.00 — every trace of the semantic plane gone. A DB_TABLE is destroyed
      -- the same way by the contract-SQL pass.
      --
      -- Policy: a provenance-scoped column may only be overwritten by a write that is actually
      -- making that kind of claim. Quoted evidence is the marker for it — the AST and contract
      -- planes never produce raw_evidence, so this is read off what the write CONTAINS rather
      -- than off any mode flag. A write with nothing to say can fill a gap; it cannot erase or
      -- restate an assertion it did not make.
      summary = CASE
        WHEN nodes.summary IS NULL THEN EXCLUDED.summary
        WHEN EXCLUDED.raw_evidence IS NOT NULL THEN COALESCE(EXCLUDED.summary, nodes.summary)
        ELSE nodes.summary END,
      raw_evidence = COALESCE(EXCLUDED.raw_evidence, nodes.raw_evidence),
      start_line = EXCLUDED.start_line,
      end_line = EXCLUDED.end_line,
      -- A deterministic pass reports 1.0 because it is certain about STRUCTURE, which is not
      -- the claim this column describes once a semantic write has calibrated it. Only a write
      -- that carries evidence may move confidence.
      confidence = CASE
        WHEN EXCLUDED.raw_evidence IS NOT NULL THEN EXCLUDED.confidence
        WHEN nodes.raw_evidence IS NULL THEN EXCLUDED.confidence
        ELSE nodes.confidence END,
      -- The upsert was upgrade-only for confidence_tier, which permanently
      -- blocked the grounding gate --
      -- an EXTRACTED node that fails grounding on re-ingest must be demotable to
      -- AMBIGUOUS; a structural write must not promote the tier of a row whose confidence
      -- it is not entitled to restate.
      confidence_tier = CASE
        WHEN EXCLUDED.confidence_tier = 'AMBIGUOUS' AND json_type($13, '$.grounding_failure') IS NOT NULL THEN 'AMBIGUOUS'
        WHEN EXCLUDED.confidence_tier = 'EXTRACTED'
             AND (EXCLUDED.raw_evidence IS NOT NULL OR nodes.raw_evidence IS NULL) THEN 'EXTRACTED'
        ELSE nodes.confidence_tier END,
      -- The plain || merge let an incoming scalar extraction_source ('contract_openapi')
      -- replace an existing array (["ast","llm"]), erasing the record that the semantic plane
      -- contributed at all. Both contributors are real, so the marker is unioned rather than
      -- replaced.
      -- jsonb || is json_merge() here, a shallow right-wins merge registered on the pool.
      -- json_patch() is NOT the equivalent: RFC 7396 deletes any key whose incoming value is
      -- null, and 1,873 nodes in the live graph carry one (test_framework, alias,
      -- declared_version, field_type, dependency_scope, ...), so it would drop them on every
      -- re-ingest merge, silently.
      properties = json_merge(
        json_merge(nodes.properties, COALESCE($13, '{}')),
        CASE
          WHEN json_type(nodes.properties, '$.extraction_source') IS NOT NULL
           AND json_type(COALESCE($13, '{}'), '$.extraction_source') IS NOT NULL
           -- Only when the two writes name DIFFERENT planes. Re-ingesting a file re-writes its
           -- own anchor with the identical marker, and unioning there would silently change the
           -- stored shape from the scalar 'presence_floor' to ['presence_floor'].
           AND json_extract(nodes.properties, '$.extraction_source')
               IS NOT json_extract($13, '$.extraction_source')
          THEN json_object('extraction_source', (
                 SELECT json_group_array(DISTINCT e.value) FROM json_each(
                   json_merge_arrays(
                     json_extract(nodes.properties, '$.extraction_source'),
                     json_extract($13, '$.extraction_source'))
                 ) e))
          ELSE '{}'
        END),
      file_sha_at_extract = EXCLUDED.file_sha_at_extract,
      ingest_generation_id = COALESCE(EXCLUDED.ingest_generation_id, nodes.ingest_generation_id)
    RETURNING id`,
      [branchId, fileId, nd.node_type, nd.name, nd.summary || null, nd.raw_evidence || null,
     nd.start_line ?? nd.line ?? null, nd.end_line ?? null,
     typeof nd.confidence === 'number' ? nd.confidence : 1.0,
     tier, fileSha, canonicalKey, propsJson, ingestGenerationId]
  );
  return rows[0]?.id;
}

// ─── Edge writers ────────────────────────────────────────────────────────────

// Write pre-resolved (fromId, toId, edgeType[, resolution]) tuples — used for AST
// structural edges that are already fully resolved at extraction time (no name
// lookup needed). An extractors/base.js edge always carries `resolution` (a
// closed vocabulary — import | same_file | inherited | ambiguous); when present
// it is persisted into `properties.resolution` so a precision audit can tell an
// import-evidenced edge from a same-file guess. Callers that
// still pass 3-element tuples are unaffected — `resolution` stays undefined and
// no `properties` object is written, exactly as before this slice.
async function writeAstEdges(resolvedEdges) {
  if (!resolvedEdges.length) return 0;
  const CHUNK = pool.safeChunk(7);
  let written = 0;
  for (let i = 0; i < resolvedEdges.length; i += CHUNK) {
    const chunk = resolvedEdges.slice(i, i + CHUNK);
    const params = [];
    // confidence_tier is DERIVED from resolution, not hardcoded — only 'import' is
    // actually import-proven, so writing 'same_file'/'inherited' as 'EXTRACTED'
    // unconditionally would over-tier them. resolution is always tagged (never omitted),
    // defaulting to 'legacy_unretiered' for the rare 3-element-tuple caller so the
    // `json_type(properties, '$.resolution') IS NOT NULL` invariant holds for every future
    // write, not just the ones migration 171 backfilled.
    // edgeWriteTier is the single place that decides (resolution_tier, confidence,
    // confidence_tier) AND, for CALLS edges landing at tier >=8, retypes the write to
    // HEURISTIC_CALLS — every other type keeps its own type at every tier.
    const valueClauses = chunk.map(([from, to, type, resolution, callLine, calleeName]) => {
      const base = params.length;
      const res = resolution || 'legacy_unretiered';
      const derived = edgeWriteTier(res, type);
      // call_line is only added when the extractor plane actually captured one — never
      // fabricated. called_name follows the same rule — the intended callee name, when
      // the caller (base.js#resolveCall) actually captured one.
      const props = { resolution: res };
      if (Number.isInteger(callLine)) props.call_line = callLine;
      if (calleeName) props.called_name = calleeName;
      params.push(from, to, derived.edgeType, derived.label, JSON.stringify(props), derived.tier, derived.confidence);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    await pool.query(
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      params
    );
    written += chunk.length;
  }
  return written;
}

// FILE containment as its own edge type, not folded into DEFINED_IN (which keeps
// its METHOD->CLASS meaning). A CONTAINS edge is a structural fact derived purely
// from `nodes.file_id` matching a live FILE node's `file_id` on the same branch — no
// name resolution, no waterfall, tier 2 / confidence 1.00 / EXTRACTED always.
// Branch-scoped SQL (not a per-node write) so it is idempotent and safe to call on
// every ingest, full or incremental: `edges_resolved_unique` + ON CONFLICT DO NOTHING
// means a re-run only adds rows for nodes that don't have one yet (e.g. new nodes from
// an incremental re-ingest touching files whose FILE node already existed).
// Migration 188 covers the one-time historical backfill; this is the writer that keeps
// it current going forward.
async function writeContainsEdges(branchId, _pool = pool) {
  const { rowCount } = await _pool.query(
    `INSERT INTO edges
       (from_node_id, to_node_id, edge_type, confidence_tier, resolution_tier, confidence, properties)
     SELECT fn.id, n.id, 'CONTAINS', 'EXTRACTED', 2, 1.00, '{"resolution":"file_membership"}'
       FROM nodes n
       JOIN nodes fn
         ON fn.repository_branch_id = n.repository_branch_id
        AND fn.file_id = n.file_id
        AND fn.node_type = 'FILE'
        AND fn.approval_status != 'ARCHIVED'
      WHERE n.repository_branch_id = $1
        AND n.node_type != 'FILE'
        AND n.file_id IS NOT NULL
        AND n.approval_status != 'ARCHIVED'
     ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
    [branchId]
  );
  return rowCount;
}

// Directory containment gives every FILE a parent, so a file a parser has nothing to say about
// (.editorconfig, LICENSE.txt, .github/workflows/*.yml, a data-only .sql) is not left a
// degree-0 node no traversal can reach.
//
// Give the tree a spine. Every FILE gets a parent DIRECTORY, every DIRECTORY its
// parent, up to a repo root — so a zero-yield file is still reachable, still tells you it
// exists, and the graph gains navigable directory topology.
async function writeDirectoryHierarchy(branchId, _pool = pool) {
  const { rows: files } = await _pool.query(
    `SELECT n.id, f.path
       FROM nodes n
       JOIN files f ON f.id = n.file_id
      WHERE n.repository_branch_id = $1
        AND n.node_type = 'FILE'
        AND n.approval_status != 'ARCHIVED'`,
    [branchId],
  );
  if (!files.length) return { directories: 0, edges: 0 };

  const ROOT = '.';
  // dirPath -> Set of child dirPaths; dirPath -> [fileNodeId]
  const childDirs = new Map();
  const dirFiles = new Map();
  const ensure = (d) => {
    if (!childDirs.has(d)) childDirs.set(d, new Set());
    if (!dirFiles.has(d)) dirFiles.set(d, []);
  };
  ensure(ROOT);

  for (const f of files) {
    const posix = String(f.path || '').replace(/\\/g, '/');
    const dir = posix.includes('/') ? posix.slice(0, posix.lastIndexOf('/')) : ROOT;
    ensure(dir);
    dirFiles.get(dir).push(f.id);
    // Walk up to the root, wiring each level to its parent exactly once.
    let cur = dir;
    while (cur !== ROOT) {
      const parent = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : ROOT;
      ensure(parent);
      childDirs.get(parent).add(cur);
      cur = parent;
    }
  }

  const dirPaths = [...childDirs.keys()];
  const dirNodeId = new Map();
  for (const dirPath of dirPaths) {
    const name = dirPath === ROOT ? '.' : dirPath.slice(dirPath.lastIndexOf('/') + 1);
    const canonicalKey = computeCanonicalKey('DIRECTORY', dirPath, branchId, dirPath, null);
    const { rows } = await _pool.query(
      `INSERT INTO nodes
         (repository_branch_id, node_type, name, summary, canonical_key, confidence,
          confidence_tier, approval_status, properties)
       VALUES ($1, 'DIRECTORY', $2, $3, $4, 1.00, 'EXTRACTED', 'APPROVED', $5)
       ON CONFLICT (canonical_key) WHERE canonical_key IS NOT NULL
         AND repository_branch_id IS NOT NULL AND approval_status <> 'ARCHIVED'
       DO UPDATE SET last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       RETURNING id`,
      [branchId, name, `directory ${dirPath}`, canonicalKey,
        JSON.stringify({ dir_path: dirPath, extraction_source: ['ast'], extractor_version: 'dir-1' })],
    );
    dirNodeId.set(dirPath, rows[0].id);
  }

  const pairs = [];
  for (const [dir, kids] of childDirs) {
    for (const kid of kids) pairs.push([dirNodeId.get(dir), dirNodeId.get(kid)]);
  }
  for (const [dir, fileIds] of dirFiles) {
    for (const fid of fileIds) pairs.push([dirNodeId.get(dir), fid]);
  }

  let edges = 0;
  const CHUNK = pool.safeChunk(2);
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const chunk = pairs.slice(i, i + CHUNK);
    const values = chunk.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2}, 'CONTAINS', 'EXTRACTED', 2, 1.00, '{"resolution":"directory_membership"}')`).join(',');
    const { rowCount } = await _pool.query(
      `INSERT INTO edges
         (from_node_id, to_node_id, edge_type, confidence_tier, resolution_tier, confidence, properties)
       VALUES ${values}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      chunk.flat(),
    );
    edges += rowCount;
  }

  console.log(`[writeDirectoryHierarchy] branch=${branchId} directories=${dirNodeId.size} edges=${edges}`);
  return { directories: dirNodeId.size, edges };
}

// LLM extraction emits edges as { edge_type, to_name } on the source node.
// Resolve to_name against nodes already written in this branch (by name) and
// write rows into edges. Branch-scoped only — no cross-repo resolution
// (that's cross-repo-edge-resolver.js's job for the full sync.js pipeline).

// Common suffixes stripped when building the stem map for fuzzy resolution.
const STEM_SUFFIXES = [
  'Impl','Service','Repository','Controller','Handler','Manager',
  'Factory','Util','Utils','Helper','Adapter','Provider','Client',
];

function _stem(name) {
  if (!name) return '';
  for (const sfx of STEM_SUFFIXES) {
    if (name.length > sfx.length && name.endsWith(sfx)) return name.slice(0, -sfx.length);
  }
  return name;
}

// Edge types whose `toName` names a TYPE, not a
// callable: when internal resolution fails on one of these and the file's own
// import statements prove where the name came from, the target is a real
// external symbol (`@Entity`, `implements Serializable`, a `Pageable` return
// type) and belongs on the DEPENDENCY node for its module — the same node
// resolveImportFacts already mints for `FILE -[IMPORTS]-> package`.
//
// CALLS is deliberately absent. Binding `foo.bar()` to the package `foo` came
// from would inflate the call graph with edges that point at a package instead
// of a method — the one thing the call plane must not do.
const EXTERNAL_BINDABLE_EDGE_TYPES = new Set([
  'EXTENDS', 'IMPLEMENTS', 'DECORATED_BY', 'REFERENCES', 'DEPENDS_ON',
]);

// The simple names an import fact can legitimately answer to. Java stamps the
// FQN in both `name` and `module` (`org.springframework.stereotype.Service`),
// JS/TS stamps the local binding in `name` and the specifier in `module`, so
// both the whole string and its last dotted segment are candidate keys.
function importFactAliases(fact) {
  const out = [];
  for (const raw of [fact.name, fact.alias, fact.module]) {
    if (!raw || typeof raw !== 'string') continue;
    out.push(raw);
    const dot = raw.lastIndexOf('.');
    if (dot > 0 && dot < raw.length - 1) out.push(raw.slice(dot + 1));
  }
  return out;
}

// filePath -> simpleName -> module, built only from import facts that are NOT
// relative-shaped (a relative spec names a same-repo file; if that didn't
// resolve internally we have no evidence of an external package and must
// refuse — the same rule isInternalShapedModuleSpec enforces for import edges).
// A name two different imports both claim is dropped, not guessed between.
function buildExternalImportIndex(fileIndex) {
  const byFile = new Map();
  const ambiguousByFile = new Map();
  for (const [filePath, facts] of fileIndex.importsByFile || []) {
    const byName = new Map();
    const ambiguous = new Set();
    for (const fact of facts) {
      if (!fact || !fact.module) continue;
      if (isInternalShapedModuleSpec(fact.module)) continue;
      for (const alias of importFactAliases(fact)) {
        const existing = byName.get(alias);
        if (existing !== undefined && existing !== fact.module) { ambiguous.add(alias); continue; }
        byName.set(alias, fact.module);
      }
    }
    for (const name of ambiguous) byName.delete(name);
    if (byName.size) byFile.set(filePath, byName);
    // Ambiguous names are still PROOF the name is externally imported (typically a
    // try/except fallback binding the same alias to compatible modules, e.g.
    // `try: import httpx2 as httpx except: import httpx`). We refuse to guess WHICH
    // module, but a dotted inheritance base keyed on it (`httpx.Client`) is a real
    // edge whose symbol name is the same either way — kept via this set below.
    if (ambiguous.size) ambiguousByFile.set(filePath, ambiguous);
  }
  return { byFile, ambiguousByFile };
}

// filePath -> set of names that alias a WHOLE module (`import typing as t` -> t),
// so the external-symbol rung knows `t.NamedTuple` means typing.NamedTuple
// (replace the alias) rather than typing.t.NamedTuple (append). A from-import
// symbol (`from x import y`) is name!==module and is NOT a module alias.
function buildModuleAliasIndex(fileIndex) {
  const byFile = new Map();
  for (const [filePath, facts] of fileIndex.importsByFile || []) {
    const set = new Set();
    for (const fact of facts) {
      if (!fact || !fact.module || isInternalShapedModuleSpec(fact.module)) continue;
      if (fact.alias && fact.name === fact.module) set.add(fact.alias);
    }
    if (set.size) byFile.set(filePath, set);
  }
  return byFile;
}

async function resolveAndWriteEdges(pendingEdges, branchId, _pool = pool, opts = {}) {
  if (!pendingEdges.length) return { written: 0, unresolvedEdges: [], ambiguousRefused: 0, moduleStemResolved: 0, globalLabelResolved: 0, receiverImportResolved: 0, receiverTypeResolved: 0, externalSymbolResolved: 0 };

  const { rows: branchNodes } = await _pool.query(
    `SELECT id, name, node_type FROM nodes WHERE repository_branch_id = $1 AND approval_status != 'ARCHIVED' ORDER BY id`,
    [branchId]
  );

  // A second, file-path-qualified
  // read of the same branch, used ONLY to attempt real import-evidence
  // resolution before falling back to the name-matching heuristics below.
  // Rows lacking file_path (no file join — e.g. this function's own unit
  // tests, which mock a bare id/name/node_type fixture) are skipped by
  // buildFileScopedIndex rather than throwing, so import-evidence resolution
  // degrades to "no evidence available" and every existing name-matching
  // test keeps its behaviour unchanged.
  // module/alias columns feed
  // resolveViaModuleStem via facts.js's importsByFile entries. `->>'` on a
  // row with no `module`/`alias` key (any non-IMPORT node) or no `properties`
  // at all yields SQL NULL, not an error.
  // `fields` (`json_extract(n.properties, '$.fields')`, a jsonb column — the pg
  // driver hands it back pre-parsed as a JS array, never a string) feeds facts.js's
  // `classFieldsById` for CLASS rows. `parent_class_id` is a per-row scalar subquery
  // against the DEFINED_IN edge base.js's walkGeneric already writes at
  // METHOD-creation time — a LEFT JOIN was deliberately avoided here to rule out row
  // multiplication if a node ever carried more than one DEFINED_IN edge.
  // `properties` (the whole jsonb object, not just the flattened module/alias/fields
  // columns above) feeds facts.js#buildFileScopedIndex's `r.properties.imports`
  // explosion — a FILE node carries its file's import facts as an array instead of one
  // IMPORT node per import. Selecting the whole object (rather than a fourth
  // `json_extract(properties, '$.imports')` column under a different name) keeps
  // facts.js's read side to one path (`r.properties.imports`) regardless of whether the
  // row came from this live query or a unit-test fixture literal.
  const { rows: fileScopedRows } = await _pool.query(
    `SELECT n.id, n.name, n.node_type, f.path AS file_path, n.file_id,
            json_extract(n.properties, '$.module') AS module, json_extract(n.properties, '$.alias') AS alias,
            json_extract(n.properties, '$.fields') AS fields, n.properties AS properties,
            (SELECT di.to_node_id FROM edges di
             WHERE di.from_node_id = n.id AND di.edge_type = 'DEFINED_IN' LIMIT 1) AS parent_class_id
     FROM nodes n
     JOIN files f ON f.id = n.file_id
     WHERE n.repository_branch_id = $1 AND n.approval_status != 'ARCHIVED'
     ORDER BY f.path, n.id`,
    [branchId]
  );
  const fileIndex = buildFileScopedIndex(fileScopedRows);

  // The external-import fallback needs a file row to anchor each minted DEPENDENCY node
  // against, which buildFileScopedIndex does not carry (it is keyed on paths, not file rows).
  const fileRowIdByNodeId = new Map();
  for (const r of fileScopedRows) if (r.file_id != null) fileRowIdByNodeId.set(r.id, r.file_id);
  const { byFile: externalImportIndex, ambiguousByFile: ambiguousImportIndex } = buildExternalImportIndex(fileIndex);
  const moduleAliasIndex = buildModuleAliasIndex(fileIndex);
  const writeNodeFn = opts.writeNodeFn || writeNode;
  const dependencyIdByModule = new Map();

  // Every map holds ALL candidates per key, not the first one seen, so the type
  // filter below can discard implausible targets and still fall through to a
  // plausible one with the same name.
  const byName = new Map();       // Rule 1 — exact
  const byNameLower = new Map();  // Rule 2 — case-insensitive exact
  // Rule 3 — suffix-stripped stem (both sides normalised). Only used when exactly ONE
  // node maps to a given stem; if several share it (Owner(ENTITY) and
  // OwnerRepository(CLASS) both stem to "owner") the stem is ambiguous and skipped.
  const byStem = new Map();
  const byStemAmbiguous = new Set();
  // bySimpleName — last segment of an FQN node name; inheritance edges only.
  const bySimpleName = new Map();

  const pushCandidate = (map, key, node) => {
    if (!key) return;
    const list = map.get(key);
    if (list) list.push(node); else map.set(key, [node]);
  };

  // node_type by id, so the import-proven stem/global-label rungs can enforce the
  // same EXTENDS/IMPLEMENTS -> CLASS constraint pickCandidate does; without it a
  // lowercase global-label collision binds `class AppGroup(click.Group)` to a
  // `def group` METHOD.
  const nodeTypeById = new Map();
  for (const n of branchNodes) {
    const candidate = { id: n.id, type: n.node_type };
    nodeTypeById.set(n.id, n.node_type);
    pushCandidate(byName, n.name, candidate);
    pushCandidate(byNameLower, n.name.toLowerCase(), candidate);
    const st = _stem(n.name).toLowerCase();
    if (st) {
      const existing = byStem.get(st);
      if (existing && existing.some((c) => c.id !== n.id)) byStemAmbiguous.add(st);
      pushCandidate(byStem, st, candidate);
    }
    if (n.name.includes('.')) {
      pushCandidate(bySimpleName, n.name.split('.').pop(), candidate);
    }
  }

  const INHERITANCE_EDGE_TYPES = new Set(['EXTENDS', 'IMPLEMENTS']);
  // A base/interface is a type. The stem and global-label rungs don't run through
  // pickCandidate's EDGE_TARGET_TYPES gate, so enforce CLASS-only here for them.
  const inheritTargetOk = (targetId, edgeType) => !INHERITANCE_EDGE_TYPES.has(edgeType)
    || nodeTypeById.get(targetId) === 'CLASS';

  // Type awareness is a PREFERENCE, not a prohibition. When several nodes share a name,
  // prefer a semantically meaningful target over structural noise — that is the real
  // defect (a CALLS binding to an IMPORT when the actual class exists). Banning those
  // types outright measurably destroyed legitimate edges: entities are stored as CLASS,
  // and Java `implements X` resolves to X's IMPORT when the interface is external.
  const DEPRIORITIZED_TARGET_TYPES = new Set(['IMPORT', 'CONFIG_VALUE', 'DEPENDENCY', 'FILE']);
  // Hard constraints only where a cross-type match is definitionally wrong.
  const EDGE_TARGET_TYPES = {
    USES_CONFIG: new Set(['CONFIG_VALUE']),
    // A base/interface is a type, never a method — every extractor emits type
    // declarations (class/struct/interface, across all languages) as CLASS, so a
    // same-named METHOD (a Go accessor, a getter) must not compete with the real
    // CLASS candidate. Without this, `type Codec interface { Encoder; Decoder }`
    // on spf13/viper picks up encoding.go's `Encoder`/`Decoder` METHOD nodes as
    // equally "preferred" and refuses the edge as ambiguous (verified: 3 of
    // viper's 5 EXTENDS truth edges dropped this way, all disambiguated once
    // METHOD is excluded).
    EXTENDS: new Set(['CLASS']),
    IMPLEMENTS: new Set(['CLASS']),
  };

  // Ambiguity must NOT fall back to `(preferred || notSelf[0]).id` — an arbitrary pick among
  // equally-plausible candidates. METHOD name collisions are a large population, and a
  // coin-flip pick there produces edges that look real but point at the wrong target.
  // Type-based preference (DEPRIORITIZED_TARGET_TYPES) is NOT ambiguity —
  // it is a real signal (a CLASS is more meaningful than a same-named IMPORT) and stays.
  // Ambiguity is now only "more than one equally-meaningful candidate survives", and it
  // refuses to guess: no edge, tagged 'ambiguous'.
  const pickCandidate = (list, edgeType, fromNodeId) => {
    if (!list || !list.length) return { id: null, reason: 'no_candidate' };
    const allowed = EDGE_TARGET_TYPES[edgeType];
    const viable = allowed ? list.filter((c) => allowed.has(c.type)) : list;
    if (!viable.length) return { id: null, reason: 'type_incompatible' };
    const notSelf = viable.filter((c) => c.id !== fromNodeId);
    if (!notSelf.length) return { id: null, reason: 'same_node' };
    const preferred = notSelf.filter((c) => !DEPRIORITIZED_TARGET_TYPES.has(c.type));
    // M34: an INSTANTIATES target is a CLASS by definition, and extractors/base.js#resolveCall
    // already prefers classByName for it on the same-file path. Java names a constructor after
    // its class and extracts it as a METHOD, so `new Order(...)` saw CLASS Order plus two
    // constructor METHODs named Order, tied at three "preferred" candidates, and refused —
    // which is why Java alone emitted no constructor edge. Scoped to INSTANTIATES: CALLS still
    // refuses to guess between same-named METHODs.
    if (edgeType === 'INSTANTIATES') {
      const classesOnly = preferred.filter((c) => c.type === 'CLASS');
      if (classesOnly.length === 1) return { id: classesOnly[0].id, reason: null };
    }
    if (preferred.length > 1) return { id: null, reason: 'ambiguous' };
    if (preferred.length === 1) return { id: preferred[0].id, reason: null };
    if (notSelf.length > 1) return { id: null, reason: 'ambiguous' };
    return { id: notSelf[0].id, reason: null };
  };

  // Collect all resolvable edges, tracking fuzzy hits
  const resolved = [];
  const unresolvedEdges = [];
  let fuzzyRecovered = 0;
  let typeRejected = 0;
  let ambiguousRefused = 0;
  let moduleStemResolved = 0;
  let globalLabelResolved = 0;
  let receiverImportResolved = 0;
  let receiverTypeResolved = 0;
  let externalSymbolResolved = 0;
  for (const e of pendingEdges) {
    const tn = e.toName;

    // Import evidence is tried
    // FIRST and, when it uniquely resolves, wins outright — it does not
    // compete with the name-matching attempts below, because a real import
    // binding is proof, not a guess among plausible candidates.
    const importHit = resolveViaImportEvidence(e.fromNodeId, tn, fileIndex);
    if (importHit && inheritTargetOk(importHit.targetId, e.edgeType)) {
      // 'import' is tier 3 in the canonical map (resolution/tiers.js) — the write-time
      // edgeWriteTier call (below) derives the label through the single source. Inheritance
      // still requires a CLASS target here, exactly as the stem/global rungs below do — an
      // imported same-named FUNCTION is not a base class.
      resolved.push([e.fromNodeId, importHit.targetId, e.edgeType, 'import', e.callLine ?? null, tn]);
      continue;
    }

    // Tried SECOND, only for pendingEdges carrying `receiverName` — the accessor
    // residue (`Bar.baz()` where `Bar` couldn't be bound same-file). Stronger than
    // module-stem (tier 5): the receiver token itself is an import alias, not just a
    // bare callee name that happens to share a module stem.
    if (e.receiverName) {
      const receiverHit = resolveViaReceiverImport(e.fromNodeId, e.receiverName, tn, fileIndex);
      if (receiverHit) {
        receiverImportResolved++;
        resolved.push([e.fromNodeId, receiverHit.targetId, e.edgeType, receiverHit.resolution, e.callLine ?? null, tn]);
        continue;
      }

      // Tried after the receiver-import rung refuses: the receiver isn't an import
      // alias, but it may be a DECLARED FIELD of the calling method's own class
      // (`svc.doWork()` where `private FooService svc;`) — see
      // resolve.js#resolveViaReceiverType's header for the tier-3/4 split.
      const receiverTypeHit = resolveViaReceiverType(e.fromNodeId, e.receiverName, tn, fileIndex);
      if (receiverTypeHit) {
        receiverTypeResolved++;
        resolved.push([e.fromNodeId, receiverTypeHit.targetId, e.edgeType, receiverTypeHit.resolution, e.callLine ?? null, tn]);
        continue;
      }
    }

    // Module-stem resolution is tried SECOND, after the relative-path pass and before
    // any name-matching fan-out heuristic — it is also import-proven (deriveConfidenceTier
    // tiers it EXTRACTED alongside 'import'), just via a different import
    // shape (dotted module + symbol-index lookup instead of a relative repo
    // path). moduleStemResolved is surfaced up through runIngest ->
    // reingest-harness.js so a 0 on a Python repo is visible as a failure,
    // not silently absorbed into the name-matching counters below.
    // An explicit import beats every name-matching rung below it, including module-stem.
    // requests/exceptions.py says `from urllib3.exceptions import HTTPError as BaseHTTPError`
    // and also DEFINES its own HTTPError; the stem rung bound the base of
    // `class ContentDecodingError(..., BaseHTTPError)` to the LOCAL class, asserting that
    // requests' own HTTPError is the parent. The import names the referent exactly. Scoped to
    // inheritance, where the base is essentially always imported by name.
    const importBoundName = (() => {
      if (!INHERITANCE_EDGE_TYPES.has(e.edgeType) || !tn || tn.includes('.')) return undefined;
      const fp = fileIndex.fileById.get(e.fromNodeId);
      const imps = fp ? externalImportIndex.get(fp) : undefined;
      return imps ? imps.get(tn) : undefined;
    })();

    const stemHitRaw = importBoundName ? null
      : resolveViaModuleStem(e.fromNodeId, tn, fileIndex, fileIndex.symbolIndex);
    const stemHit = (stemHitRaw && inheritTargetOk(stemHitRaw.targetId, e.edgeType)) ? stemHitRaw : null;
    if (stemHit) {
      moduleStemResolved++;
      resolved.push([e.fromNodeId, stemHit.targetId, e.edgeType, stemHit.resolution, e.callLine ?? null, tn]);
      continue;
    }

    // Global-label fallback, tried THIRD, only on the stem pass's miss — a bare name with a unique (or
    // tie-broken, <=3-candidate) definition anywhere in the branch. Weaker
    // than module-stem (no import proves it), so deriveConfidenceTier's
    // default branch tiers it INFERRED. globalLabelResolved is surfaced
    // alongside moduleStemResolved so a 0 here on a Python repo is visible.
    const globalHitRaw = resolveViaGlobalLabel(e.fromNodeId, tn, fileIndex, fileIndex.labelIndex);
    const globalHit = (globalHitRaw && inheritTargetOk(globalHitRaw.targetId, e.edgeType)) ? globalHitRaw : null;
    if (globalHit) {
      globalLabelResolved++;
      resolved.push([e.fromNodeId, globalHit.targetId, e.edgeType, globalHit.resolution, e.callLine ?? null, tn]);
      continue;
    }

    const attempts = [
      { list: byName.get(tn), fuzzy: false, reason: 'resolved_exact' },
      { list: byNameLower.get(tn.toLowerCase()), fuzzy: true, reason: 'resolved_case_insensitive' },
    ];
    const st = _stem(tn).toLowerCase();
    if (st && !byStemAmbiguous.has(st)) {
      attempts.push({ list: byStem.get(st), fuzzy: true, reason: 'resolved_stem' });
    }
    if (tn.includes('.')) {
      const seg = tn.split('.').pop();
      attempts.push({ list: byName.get(seg), fuzzy: true, reason: 'resolved_fqn' });
      attempts.push({ list: byNameLower.get((seg || '').toLowerCase()), fuzzy: true, reason: 'resolved_fqn' });
    }
    if (INHERITANCE_EDGE_TYPES.has(e.edgeType)) {
      attempts.push({ list: bySimpleName.get(tn), fuzzy: true, reason: 'resolved_simple_name' });
    }

    let toId = null;
    let isFuzzy = false;
    let attemptReason = null;
    let lastReason = st && byStemAmbiguous.has(st) ? 'ambiguous' : 'no_candidate';
    for (const attempt of attempts) {
      if (attempt.fuzzy && importBoundName && INHERITANCE_EDGE_TYPES.has(e.edgeType)) continue;
      const picked = pickCandidate(attempt.list, e.edgeType, e.fromNodeId);
      if (picked.id) { toId = picked.id; isFuzzy = attempt.fuzzy; attemptReason = attempt.reason; break; }
      if (picked.reason !== 'no_candidate') lastReason = picked.reason;
    }

    // A partial type (C# `partial class X` split across files, TS declaration merging) is one
    // type spread over several same-named nodes, so an exact-name base has more than one
    // candidate and the attempts above refuse it as ambiguous. Every part IS the same
    // supertype, so an inheritance edge resolves deterministically to one of them rather than
    // vanishing — the ambiguity that CALLS must refuse does not exist here.
    if (!toId && lastReason === 'ambiguous' && INHERITANCE_EDGE_TYPES.has(e.edgeType)) {
      const exact = byName.get(tn);
      if (exact && exact.length > 1) {
        const allowed = EDGE_TARGET_TYPES[e.edgeType];
        const viable = (allowed ? exact.filter((c) => allowed.has(c.type)) : exact)
          .filter((c) => c.id !== e.fromNodeId);
        if (viable.length && viable.every((c) => c.type === viable[0].type)) {
          toId = viable.slice().sort((a, b) => a.id - b.id)[0].id;
          isFuzzy = true;
          attemptReason = 'resolved_partial_type';
        }
      }
    }

    // LAST rung, tried only once every internal attempt above has refused. The name is not defined anywhere in this
    // branch, but this file's own import statement says where it came from, so
    // the edge binds to that module's DEPENDENCY node instead of being dropped.
    // Without this the whole annotation/type plane (192 DECORATED_BY + 118
    // REFERENCES extracted on petclinic) lands 22 edges in the database,
    // because `Entity`, `Table`, `GetMapping` and `Autowired` have no node in
    // the repository to bind to.
    // An inheritance edge whose base is a BARE type name is handled by the external-base-type
    // rung below, which mints a node named for the TYPE (`http.cookiejar.CookieJar`). Binding
    // it here instead would point it at the MODULE (`cookiejar`), which is a different thing
    // and reads as a false edge: measured on psf/requests, `Style -> style`,
    // `TypedDict -> typing` and `CookieJar -> cookiejar` were 3 of the 4 false EXTENDS edges
    // on the whole repository. Dotted bases still bind here, where the module IS the referent.
    const bareInheritance = (e.edgeType === 'EXTENDS' || e.edgeType === 'IMPLEMENTS')
      && tn && !tn.includes('.');
    if (!toId && !bareInheritance && EXTERNAL_BINDABLE_EDGE_TYPES.has(e.edgeType)) {
      const filePath = fileIndex.fileById.get(e.fromNodeId);
      const fileRowId = fileRowIdByNodeId.get(e.fromNodeId);
      const fileImports = filePath && fileRowId ? externalImportIndex.get(filePath) : undefined;
      // Whole name first, then the ROOT of a dotted one. Python imports the
      // MODULE and qualifies at the use site — `from django.db import models`
      // then `class Forum(models.Model)` — so the name in the edge is
      // `models.Model` and nothing in the import index answers to it, while
      // `models` answers exactly. Measured on django-machina: 107 of 162
      // dropped inheritance edges were this one shape (`migrations.Migration`
      // ×52, `factory.django.DjangoModelFactory` ×14, `admin.ModelAdmin` ×13,
      // `models.Model` ×11, `forms.ModelForm` ×8, `forms.Form` ×7).
      const dotIdx = tn.indexOf('.');
      const root = dotIdx > 0 ? tn.slice(0, dotIdx) : null;
      const wholeHit = fileImports ? fileImports.get(tn) : undefined;
      const rootHit = !wholeHit && root && fileImports ? fileImports.get(root) : undefined;
      // A root match identifies the external symbol EXACTLY, so name the node
      // for the symbol rather than for its package: `models.Model` and
      // `models.Manager` stay distinct instead of collapsing onto one
      // `django.db` node. Which of the two import shapes produced the match
      // decides how the name is rebuilt:
      //   `from django.db import models` + `models.Model`
      //        module=django.db, root=models -> django.db.models.Model
      //   `import pytest`               + `pytest.fixture`
      //        module=pytest,    root=pytest -> pytest.fixture   (not pytest.pytest.fixture)
      let module = wholeHit;
      if (!module && rootHit) {
        // `import typing as t` binds the whole module to `t`, so `t.NamedTuple`
        // is typing.NamedTuple (replace the alias). A from-import symbol
        // (`from django.db import models` + `models.Model`) appends the full name.
        const rootIsModuleAlias = moduleAliasIndex.get(filePath)?.has(root);
        // `.root` covers dotted modules (django.db); `/root` covers Go path-style
        // imports where the binding is the last segment (net/http -> http).
        const importIsTheRoot = rootHit === root || rootHit.endsWith(`.${root}`)
          || rootHit.endsWith(`/${root}`) || rootIsModuleAlias;
        module = importIsTheRoot ? `${rootHit}${tn.slice(dotIdx)}` : `${rootHit}.${tn}`;
      }
      // Root imported but ambiguous (try/except fallback binding the same alias):
      // keep the edge under the base as written rather than dropping it.
      if (!module && root && ambiguousImportIndex.get(filePath)?.has(root)) {
        module = tn;
      }
      if (module) {
        let depId = dependencyIdByModule.get(module);
        if (depId === undefined) {
          depId = await writeNodeFn(
            { node_type: 'DEPENDENCY', name: module, confidence_tier: 'EXTRACTED', confidence: 1.0 },
            fileRowId, branchId, null
          ).catch((err) => {
            console.warn(`[resolveEdges] DEPENDENCY write failed for "${module}": ${err.message}`);
            return null;
          });
          dependencyIdByModule.set(module, depId);
        }
        if (depId && depId !== e.fromNodeId) {
          externalSymbolResolved++;
          resolved.push([e.fromNodeId, depId, e.edgeType, 'external_symbol', e.callLine ?? null, tn]);
          continue;
        }
      }
    }

    // Inheritance to a type this branch does not define is still a real, parsed fact.
    // class MissingSchema(ValueError) and class RequestsCookieJar(CookieJar) both have bases
    // outside the repository, so no node matched and the edge was dropped entirely -- the
    // parser found 60 inheritance edges on psf/requests and only 43 reached the graph.
    // Dropping them makes "what does this class extend?" and any walk up the hierarchy stop
    // silently at the repository boundary.
    //
    // The external_symbol rung above only fires for DOTTED names, so a bare base never reached
    // it. This mints the same kind of DEPENDENCY node imports already mint for external
    // modules, and only on real evidence: (a) an import in this file binds the name, or
    // (b) the name is a base type built into the language. Anything else still refuses —
    // no fabricated edges.
    if (!toId && (e.edgeType === 'EXTENDS' || e.edgeType === 'IMPLEMENTS')
        && tn && !tn.includes('.')) {
      // Recomputed here: the identically-named bindings above are scoped to the dotted-name
      // branch, which a bare base type never enters.
      const basePath = fileIndex.fileById.get(e.fromNodeId);
      const baseRowId = fileRowIdByNodeId.get(e.fromNodeId);
      const baseFileImports = basePath && baseRowId ? externalImportIndex.get(basePath) : undefined;
      const supportingImport = baseFileImports ? baseFileImports.get(tn) : undefined;
      // The supertype is written by name in the `extends`/`implements`/`:` clause, so it is
      // parsed evidence, not a guess — the same standing an imported module name has. A file
      // that imports the type by name gets the qualified spelling; otherwise the bare name is
      // recorded. This matters for languages whose imports name a namespace rather than the
      // type (C# `using System.IO;` never binds `TextReader`), where the base would otherwise
      // vanish at the repository boundary and "what does this class extend?" stop silently.
      const extName = supportingImport ? `${supportingImport}.${tn}` : tn;
      let depId = dependencyIdByModule.get(extName);
      if (depId === undefined) {
        depId = await writeNodeFn(
          { node_type: 'DEPENDENCY', name: extName, confidence_tier: 'EXTRACTED', confidence: 1.0 },
          baseRowId, branchId, null
        ).catch((err) => {
          console.warn(`[resolveEdges] external base write failed: ${err.message}`);
          return null;
        });
        dependencyIdByModule.set(extName, depId);
      }
      if (depId && depId !== e.fromNodeId) {
        externalSymbolResolved++;
        resolved.push([e.fromNodeId, depId, e.edgeType, 'external_base_type', e.callLine ?? null, tn]);
        continue;
      }
    }

    if (!toId) {
      if (lastReason === 'type_incompatible') typeRejected++;
      if (lastReason === 'ambiguous') ambiguousRefused++;
      unresolvedEdges.push({ ...e, resolutionReason: lastReason });
      continue;
    }
    if (isFuzzy) fuzzyRecovered++;
    // confidence_tier is now DERIVED
    // from resolution (import -> EXTRACTED; everything else -> INFERRED), not
    // taken from the caller's e.confidenceTier hint — none of the name-matching
    // reasons here ('resolved_exact' etc.) constitute import evidence, so they
    // are always INFERRED, same as an ambiguous name match would be.
    const resolution = attemptReason || 'no_candidate';
    resolved.push([e.fromNodeId, toId, e.edgeType, resolution, e.callLine ?? null, tn]);
  }

  const dropped = pendingEdges.length - resolved.length;
  console.log(`[resolveEdges] branchId=${branchId} total=${pendingEdges.length} resolved=${resolved.length} dropped=${dropped} (fuzzy recovered: ${fuzzyRecovered}, type-rejected: ${typeRejected}, ambiguous-refused: ${ambiguousRefused}, module-stem: ${moduleStemResolved}, global-label: ${globalLabelResolved}, receiver-import: ${receiverImportResolved}, receiver-type: ${receiverTypeResolved}, external-symbol: ${externalSymbolResolved})`);

  // A drop count alone never says WHICH names the branch cannot bind, so a
  // whole missing plane reads the same as ordinary residue. Naming the top
  // offenders is what makes the next gap findable.
  if (unresolvedEdges.length) {
    const byName = new Map();
    for (const u of unresolvedEdges) {
      const key = `${u.edgeType} ${u.toName}`;
      byName.set(key, (byName.get(key) || 0) + 1);
    }
    const top = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([k, n]) => `${k}×${n}`).join(', ');
    console.log(`[resolveEdges] branchId=${branchId} top unresolved: ${top}`);
  }

  if (!resolved.length) return { written: 0, unresolvedEdges, ambiguousRefused, moduleStemResolved, globalLabelResolved, receiverImportResolved, receiverTypeResolved, externalSymbolResolved };

  const CHUNK = pool.safeChunk(7);
  let written = 0;
  for (let i = 0; i < resolved.length; i += CHUNK) {
    const chunk = resolved.slice(i, i + CHUNK);
    const params = [];
    // edgeWriteTier is the single source for (tier, confidence, label, edgeType) — a
    // CALLS edge landing at tier >=8 here is written as HEURISTIC_CALLS, never plain CALLS.
    const valueClauses = chunk.map(([from, to, type, resolution, callLine, calledName]) => {
      const base = params.length;
      const derived = edgeWriteTier(resolution, type);
      // call_line only when present — never fabricated. called_name (the toName this
      // pass resolved against) follows the same rule.
      const props = { resolution };
      if (Number.isInteger(callLine)) props.call_line = callLine;
      if (calledName) props.called_name = calledName;
      params.push(from, to, derived.edgeType, derived.label, JSON.stringify(props), derived.tier, derived.confidence);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    await _pool.query(
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      params
    );
    written += chunk.length;
  }
  return { written, unresolvedEdges, ambiguousRefused, moduleStemResolved, globalLabelResolved, receiverImportResolved, receiverTypeResolved, externalSymbolResolved };
}

// ─── IMPORTS cross-file resolution (root-cause fix) ────────────────────────
//
// IMPORT nodes are retired: base.js#registerImportFact and
// ast-extractor.js's per-language blocks collect import
// evidence as flat facts instead, attached onto each file's FILE node as
// `properties.imports` ({name,module,alias,line}[] — ingest.js's FILE-node-
// creation loop, above). This function is the branch-wide resolution pass
// for THOSE facts: run once after every file in the branch has a FILE node,
// it reads every FILE node's `properties.imports`, resolves each fact's
// `module`/`name` via the SAME ladder the pre-2e stub-rewiring pass used
// (resolve.js#resolveImportNodeTarget — relative path, tsconfig alias,
// workspace package, dotted-FQN suffix, module-stem/symbol-index), and
// WRITES a fresh FILE -[IMPORTS]-> target edge for each hit — symbol-grain,
// not FILE-to-FILE, since resolveImportNodeTarget already resolves down to
// the declaring CLASS/METHOD node, which is a strictly more useful edge
// than one that stops at the file boundary. A fact whose module doesn't
// resolve internally and isn't a same-repo relative path upserts a
// branch-scoped DEPENDENCY node instead (one per package name, canonical-key
// deduped) and writes FILE -[IMPORTS]-> DEPENDENCY. A relative-looking
// module that still doesn't resolve gets no edge at all — refuse to guess,
// never fabricate a target. No node is ever archived by this pass;
// it is purely additive, run on every full/incremental pass that touches
// edges (idempotent — INSERT ... ON CONFLICT DO NOTHING on
// edges_resolved_unique, migration 026, means re-running it is a no-op for
// facts already resolved to an edge).
//
// Builds the on-disk `opts` that activate resolve.js's tsconfig-alias and
// workspace-package/`exports` tiers. Returns `{}` — the relative-path-only behaviour —
// when no usable checkout is on disk, so a caller that cannot supply one (or a repo
// already cleaned up) degrades silently to the relative-path tiers instead of
// throwing mid-resolution.
//
// resolve.js caches parsed tsconfig/jsconfig by absolute config path and never
// invalidates. That is correct within one pass but wrong across passes: this
// process is a long-running server that re-ingests the same repo — often
// re-cloned to the SAME path — so a tsconfig edited between ingests would
// otherwise resolve against the previous ingest's cached `paths`. Clearing
// once per pass makes each ingest read config fresh and bounds the cache,
// which is otherwise unbounded across every repo the server ever sees.
function buildOnDiskResolutionOpts(repoPath) {
  if (!repoPath) return {};
  try {
    if (!fs.existsSync(repoPath)) return {};
    clearTsconfigCaches();
    const layout = resolveWorkspaceLayout(repoPath);
    const workspacePackages = buildWorkspacePackageIndex(repoPath, layout);
    return { repoRoot: repoPath, workspacePackages };
  } catch (err) {
    // Never let config/manifest discovery fail an ingest — the alias and
    // workspace tiers are additive, so falling back to `{}` only forgoes the
    // extra resolutions it would have supplied.
    console.warn(`[resolveImportStubEdges] on-disk resolution disabled for ${repoPath}: ${err.message}`);
    return {};
  }
}

// A module spec that LOOKS like a same-repo reference (JS/TS relative — `./x`, `../x` —
// or a Python relative-dotted spec — `.foo`, `..foo.bar`) but didn't resolve via
// resolveImportNodeTarget's ladder gets NO edge at all: we have no evidence it names a
// real external package, so writing a DEPENDENCY node for it would be a fabricated
// target. Only a spec that is NOT relative-shaped — and still failed every internal tier
// (dotted-FQN-suffix, module-stem) — is external/package-shaped enough to earn a
// DEPENDENCY node.
const RELATIVE_IMPORT_SPEC_RE = /^\.{1,2}\//;
function isInternalShapedModuleSpec(moduleSpec) {
  if (!moduleSpec) return false;
  if (RELATIVE_IMPORT_SPEC_RE.test(moduleSpec)) return true;
  if (/^\.+/.test(moduleSpec)) return pyDottedRelativeToSlashSpec(moduleSpec) !== null;
  return false;
}

// `opts.repoPath` activates the tsconfig-alias and workspace-package/`exports`
// resolution tiers, which read real files off the cloned checkout and are therefore
// inert unless a caller supplies an on-disk root. Omitting it keeps the relative-path +
// barrel-hop tiers only.
//
// Reads every FILE node's `properties.imports` fact array (registerImportFact/
// ast-extractor.js at extraction time, stamped onto the FILE node by ingest.js's
// FILE-node-creation loop) instead of querying now-retired IMPORT stub nodes. Each fact
// is resolved through resolveImportNodeTarget's ladder; a hit writes a fresh
// FILE -[IMPORTS]-> target edge directly (the FILE node IS the anchor). A miss that
// isn't relative-shaped upserts a branch-scoped DEPENDENCY node and writes
// FILE -[IMPORTS]-> DEPENDENCY at tier 3. A miss that IS relative-shaped gets no edge —
// refuse to guess. Purely additive and idempotent (ON CONFLICT DO NOTHING on
// edges_resolved_unique), safe to run on every full/incremental pass.
async function resolveImportFacts(branchId, _pool = pool, opts = {}) {
  const { rows: fileRows } = await _pool.query(
    `SELECT n.id AS file_node_id, n.file_id AS file_row_id, f.path AS file_path,
            json_extract(n.properties, '$.imports') AS imports
     FROM nodes n
     JOIN files f ON f.id = n.file_id
     WHERE n.repository_branch_id = $1 AND n.node_type = 'FILE' AND n.approval_status != 'ARCHIVED'
       AND json_type(n.properties, '$.imports') IS NOT NULL AND json_array_length(n.properties, '$.imports') > 0`,
    [branchId]
  );
  if (!fileRows.length) {
    console.log(`[resolveImportFacts] branchId=${branchId} files_with_imports=0`);
    return { attempted: 0, resolved: 0, edgesRewired: 0, duplicatesDropped: 0, dependenciesCreated: 0 };
  }

  const facts = [];
  for (const row of fileRows) {
    const imports = Array.isArray(row.imports) ? row.imports : [];
    for (const imp of imports) {
      if (!imp || !imp.module) continue;
      facts.push({
        fileNodeId: row.file_node_id,
        fileRowId: row.file_row_id,
        filePath: row.file_path,
        name: imp.name || imp.alias || null,
        module: imp.module,
        // This loop builds its own fact shape rather than reusing resolution/facts.js, so
        // the flag has to be carried here too. Dropping it silently disarms the refusal in
        // resolveImportNodeTarget — without this an `import { vendorHelper } from 'vendorlib'`
        // gains a first-party IMPORTS edge to a local src/vendorlib.ts via the module-stem
        // tier, which is exactly the false binding the flag exists to prevent.
        firstPartyOnly: !!imp.firstPartyOnly,
      });
    }
  }
  if (!facts.length) {
    console.log(`[resolveImportFacts] branchId=${branchId} files_with_imports=${fileRows.length} facts=0`);
    return { attempted: 0, resolved: 0, edgesRewired: 0, duplicatesDropped: 0, dependenciesCreated: 0 };
  }

  // Same branch-wide file-scoped index shape resolveAndWriteEdges builds (see the
  // sibling query above) — `properties` (the whole jsonb object) is required so
  // facts.js#buildFileScopedIndex can explode every OTHER file's properties.imports too
  // (receiver-import resolution reads the same index).
  const { rows: fileScopedRows } = await _pool.query(
    `SELECT n.id, n.name, n.node_type, f.path AS file_path,
            json_extract(n.properties, '$.module') AS module, json_extract(n.properties, '$.alias') AS alias,
            n.properties AS properties
     FROM nodes n
     JOIN files f ON f.id = n.file_id
     WHERE n.repository_branch_id = $1 AND n.approval_status != 'ARCHIVED'
     ORDER BY f.path, n.id`,
    [branchId]
  );
  const fileIndex = buildFileScopedIndex(fileScopedRows);
  // path -> FILE node id, for resolving RELATIVE import specs to the module they name.
  // writeRelativeImportEdges builds an equivalent map but restricts it to files declaring a
  // CLASS/NODE_SERVICE/SERVICE, so a function-only module (compat.py, utils.py,
  // _internal_utils.py) has no entry and its importers get no edge at all. FILE nodes exist for
  // every file, which is why this map uses them.
  const fileNodeIdByPath = new Map();
  {
    const { rows: fileNodeRows } = await _pool.query(
      `SELECT n.id, f.path FROM nodes n
         JOIN files f ON f.id = n.file_id
        WHERE n.repository_branch_id = $1 AND n.node_type = 'FILE'
          AND n.approval_status != 'ARCHIVED'
        ORDER BY f.path`,
      [branchId]
    );
    // When foo.js and foo.ts coexist, both map to the extensionless stem 'foo'. Without a stable
    // owner the last row wins and the IMPORTS target flips run to run. Prefer the TS source (a
    // compiled .js sits beside its .ts), then lexicographic — deterministic either way.
    const stemRank = (p) => ({
      '.ts': 0, '.tsx': 0, '.mts': 0, '.cts': 0, '.js': 1, '.jsx': 1, '.mjs': 1, '.cjs': 1,
    }[(p.match(/\.[^./]+$/) || [''])[0]] ?? 2);
    const stemOwner = new Map();
    for (const r of fileNodeRows) {
      fileNodeIdByPath.set(r.path, r.id);
      const stem = r.path.replace(/\.[^./]+$/, '');
      const prev = stemOwner.get(stem);
      const rank = stemRank(r.path);
      if (!prev || rank < prev.rank || (rank === prev.rank && r.path < prev.path)) {
        stemOwner.set(stem, { rank, path: r.path });
        fileNodeIdByPath.set(stem, r.id);
      }
    }
  }

  // Resolve a Python-style relative spec ('.compat', '..core.util') against the importing file.
  // Returns a FILE node id or null. Never invents a target: an unresolvable spec returns null and
  // the caller keeps refusing — no fabricated edges.
  const resolveRelativeModule = (fromPath, spec) => {
    // JS/TS style: './x.js', '../a/b.js', './var/isFunction' -- a real path relative to the
    // importing file's directory. The Python branch below reads a leading dot as a PACKAGE
    // level, which mangles these ('../core.js' became ups=2 + '/core/js'), so every relative
    // import in a JS/TS repository would resolve to nothing.
    if (/^\.{1,2}\//.test(spec || '')) {
      const fromDir = String(fromPath).split('/').slice(0, -1);
      const parts = String(spec).split('/');
      const out = fromDir.slice();
      for (const seg of parts) {
        if (seg === '.' || seg === '') continue;
        if (seg === '..') out.pop();
        else out.push(seg);
      }
      const base = out.join('/');
      const stem = base.replace(/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/, '');
      for (const c of [base, stem + '.js', stem + '.mjs', stem + '.cjs', stem + '.jsx',
                       stem + '.ts', stem + '.tsx', stem + '/index.js', stem + '/index.ts',
                       stem]) {
        const id = fileNodeIdByPath.get(c);
        if (id) return id;
      }
      return null;
    }
    const m = /^(\.+)(.*)$/.exec(spec || '');
    if (!m) return null;
    const ups = m[1].length;
    const rest = (m[2] || '').replace(/\./g, '/');
    const parts = String(fromPath).split('/');
    parts.pop();                       // drop the file itself -> its package dir
    for (let i = 1; i < ups; i++) parts.pop();
    const baseDir = parts.join('/');
    const cands = [];
    const joined = [baseDir, rest].filter(Boolean).join('/');
    if (rest) {
      cands.push(joined + '.py', joined + '/__init__.py', joined);
    } else {
      cands.push((baseDir ? baseDir + '/' : '') + '__init__.py', baseDir);
    }
    for (const c of cands) {
      const id = fileNodeIdByPath.get(c);
      if (id) return id;
    }
    return null;
  };
  const resolveOpts = buildOnDiskResolutionOpts(opts.repoPath);
  // writeNode always uses the module-level `pool`, never `_pool` (every other
  // call site relies on that too) — opts.writeNodeFn is a pure test seam
  // (unit tests inject a fake to observe DEPENDENCY writes without a live
  // connection); no production caller passes it, so this defaults to the
  // real writer unconditionally.
  const writeNodeFn = opts.writeNodeFn || writeNode;

  const dependencyIdByModule = new Map();
  const edgeRows = []; // [fromNodeId, toNodeId, resolution]
  let resolvedCount = 0;
  let dependenciesCreated = 0;

  for (const fact of facts) {
    const hit = fact.name
      ? resolveImportNodeTarget(
          { id: fact.fileNodeId, name: fact.name, file_path: fact.filePath, module: fact.module, firstPartyOnly: fact.firstPartyOnly },
          fileIndex,
          resolveOpts
        )
      : null;
    if (hit) {
      resolvedCount++;
      // A symbol-level import (`from x import Style` -> the Style CLASS) is a DIFFERENT
      // relation from a module-level one (`this file imports module x`), and folding both
      // under IMPORTS made the plane unanswerable: "which modules does this file import?"
      // returned a mix of modules and symbols. Measured on psf/requests, 95 of 385 IMPORTS
      // edges pointed at a CLASS/METHOD/CONSTANT, which is the entire precision loss on that
      // plane.
      //
      // Safe to retype: plain IMPORTS is NOT in TRAVERSAL_EDGE_TYPES (graph-vocabulary.js), so
      // no retrieval path traverses these edges today.
      edgeRows.push([fact.fileNodeId, hit.targetId, hit.resolution, 'IMPORTS_SYMBOL']);
      // ...and fall through to ALSO record the module-level edge below.
      //
      // Resolving `from pygments.style import Style` to the `Style` symbol used to `continue`
      // here, so the file's edge to the MODULE `pygments.style` was never written — and only
      // for the imports we understood best. Imports we could not resolve got a module edge via
      // the DEPENDENCY path below, so the same statement produced a different edge shape
      // depending on whether the symbol happened to bind. Measured on psf/requests: the parser
      // finds 263/263 file-module import pairs (100%), the graph exposed 50.3% of them, and the
      // 402 facts were already sitting in FILE.properties.imports — present as data, absent as
      // anything a traversal could follow.
      //
      // The symbol edge is kept; this only ADDS the module edge, so nothing that resolved
      // before resolves differently now.
    }
    if (isInternalShapedModuleSpec(fact.module)) {
      // A relative spec names a real module in this repository. Resolving it to that module's
      // FILE node is resolution, not fabrication — and without it `from .compat import x` left
      // no traversable import edge at all. Measured on psf/requests: 70 of 80 missing
      // file-module import pairs were relative specs whose facts were already stored on the
      // FILE node, i.e. known but unreachable.
      const relTargetId = resolveRelativeModule(fact.filePath, fact.module);
      if (relTargetId && relTargetId !== fact.fileNodeId) {
        edgeRows.push([fact.fileNodeId, relTargetId, 'relative_module']);
      }
      continue; // still refuse to mint a DEPENDENCY for an internal-shaped spec
    }

    let depId = dependencyIdByModule.get(fact.module);
    if (depId === undefined) {
      depId = await writeNodeFn(
        { node_type: 'DEPENDENCY', name: fact.module, confidence_tier: 'EXTRACTED', confidence: 1.0 },
        fact.fileRowId, branchId, null
      ).catch((err) => {
        console.warn(`[resolveImportFacts] DEPENDENCY write failed for "${fact.module}": ${err.message}`);
        return null;
      });
      dependencyIdByModule.set(fact.module, depId);
      if (depId) dependenciesCreated++;
    }
    if (!depId) continue;
    edgeRows.push([fact.fileNodeId, depId, 'dependency_external']);
  }

  let edgesWritten = 0;
  let duplicatesDropped = 0;
  if (edgeRows.length) {
    const CHUNK = pool.safeChunk(7);
    for (let i = 0; i < edgeRows.length; i += CHUNK) {
      const chunk = edgeRows.slice(i, i + CHUNK);
      const params = [];
      const valueClauses = chunk.map(([from, to, resolution, edgeTypeOverride]) => {
        const base = params.length;
        const derived = edgeWriteTier(resolution, edgeTypeOverride || 'IMPORTS');
        params.push(from, to, derived.edgeType, derived.label, JSON.stringify({ resolution }), derived.tier, derived.confidence);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
      });
      const { rowCount } = await _pool.query(
        `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
         VALUES ${valueClauses.join(',')}
         ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
        params
      );
      edgesWritten += rowCount ?? chunk.length;
      duplicatesDropped += chunk.length - (rowCount ?? chunk.length);
    }
  }

  console.log(`[resolveImportFacts] branchId=${branchId} facts=${facts.length} resolved=${resolvedCount} dependenciesCreated=${dependenciesCreated} edgesWritten=${edgesWritten} duplicatesDropped=${duplicatesDropped}`);
  // `edgesRewired` kept as the field name (pre-2e it meant "stub edges
  // rewired"; post-2e there is no stub to rewire, only fresh edges written —
  // ingest-post-tail.js's importStubEdgesRewired counter reads this field,
  // renaming it is a larger diff for no behavioural gain).
  return { attempted: facts.length, resolved: resolvedCount, edgesRewired: edgesWritten, duplicatesDropped, dependenciesCreated };
}

// Backward-compatible alias — the pre-2e name every existing caller
// (ingest-post-tail.js) and test still uses.
const resolveImportStubEdges = resolveImportFacts;

// Cross-repo edge resolution — called after resolveAndWriteEdges with its unresolved edges.
// Looks up to_name against nodes in OTHER branches of the same project and writes
// is_cross_repo=true edges for any matches found.
async function resolveCrossRepoEdges(unresolvedEdges, projectId, branchId) {
  if (!unresolvedEdges.length || !projectId) return 0;

  const { rows: crossBranchNodes } = await pool.query(
    `SELECT n.id, n.name, n.node_type
     FROM nodes n
     JOIN repository_branches rb ON rb.id = n.repository_branch_id
     JOIN repositories r ON r.id = rb.repository_id
     WHERE r.project_id = $1
       AND rb.id != $2
       AND n.approval_status != 'ARCHIVED'`,
    [projectId, branchId]
  );
  if (!crossBranchNodes.length) return 0;

  // This lookup must avoid the naive form — lowercase the name, take the FIRST node of ANY type
  // in ANY other branch, write the edge — which manufactures edges rather than finding them, in
  // three ways.
  //
  //   1. No target-type constraint. `type IOFS
  //      struct { Fs }` in spf13/afero produced `afero -[EXTENDS]-> viper.fs`, where `fs` is a
  //      PRIVATE FIELD of another repository's struct. A base type is a type; a field can never
  //      be one, and an EXTENDS edge into a foreign repo's private field is not a weak signal,
  //      it is a false statement that a blast-radius walk will happily traverse.
  //   2. Case-insensitive matching. In Go, case IS the export marker — `Fs` is exported and `fs`
  //      is not, so folding case makes a public type match a private field by construction. This
  //      is the mechanism behind (1). Case-insensitive matching is defensible for LLM-extracted
  //      names inside one repository; across a repository boundary on a structural edge it only
  //      invents links.
  //   3. First-name-wins with no uniqueness test. Two repos declaring the same common name
  //      silently bound to whichever was read first — an ordering-dependent graph.
  //
  // A cross-repository edge is the highest-consequence, lowest-evidence edge the resolver writes,
  // so it now requires an exact-case, unambiguous, type-appropriate target, and refuses otherwise.
  // IMPORT and DEPENDENCY stay eligible as inheritance targets: the in-branch resolver already
  // treats `implements Serializable` resolving to the IMPORT that names it as a legitimate hit
  // (the type-aware resolution path), and refusing it across repos would drop
  // recall without touching the defect above — which was a FIELD, not an import.
  const TYPE_TARGET_EDGES = new Set(['EXTENDS', 'IMPLEMENTS']);
  const TYPE_NODE_TYPES = new Set(['CLASS', 'INTERFACE', 'ENTITY', 'TYPE', 'IMPORT', 'DEPENDENCY']);
  const NEVER_TARGET = new Set(['FILE', 'DIRECTORY', 'RATIONALE']);

  const crossByName = new Map();
  for (const n of crossBranchNodes) {
    const k = n.name || '';
    if (!k) continue;
    if (!crossByName.has(k)) crossByName.set(k, []);
    crossByName.get(k).push(n);
  }

  const crossResolved = [];
  let refusedAmbiguous = 0, refusedType = 0;
  for (const e of unresolvedEdges) {
    const cands = crossByName.get(e.toName || '');
    if (!cands || !cands.length) continue;
    const typed = TYPE_TARGET_EDGES.has(e.edgeType)
      ? cands.filter(c => TYPE_NODE_TYPES.has(c.node_type))
      : cands.filter(c => !NEVER_TARGET.has(c.node_type));
    if (!typed.length) { refusedType++; continue; }
    if (typed.length > 1) { refusedAmbiguous++; continue; }
    const toId = typed[0].id;
    if (toId === e.fromNodeId) continue;
    crossResolved.push([e.fromNodeId, toId, e.edgeType, e.toName]);
  }
  if (refusedAmbiguous || refusedType) {
    console.log(`[crossRepoEdges] projectId=${projectId} branchId=${branchId} refused ambiguous=${refusedAmbiguous} wrong_target_type=${refusedType}`);
  }

  if (!crossResolved.length) {
    console.log(`[crossRepoEdges] projectId=${projectId} branchId=${branchId} candidates=${unresolvedEdges.length} resolved=0`);
    return 0;
  }

  const CHUNK = pool.safeChunk(7);
  let written = 0;
  for (let i = 0; i < crossResolved.length; i += CHUNK) {
    const chunk = crossResolved.slice(i, i + CHUNK);
    const params = [];
    // 'cross_repo' is a first-name-wins match across OTHER branches with no uniqueness
    // check (weaker than in-branch global_label), so it is honestly tier 8 — a CALLS edge
    // at that tier writes as HEURISTIC_CALLS, same as every other writer in this file.
    const valueClauses = chunk.map(([from, to, type, calledName]) => {
      const base = params.length;
      const derived = edgeWriteTier('cross_repo', type);
      const props = { resolution: 'cross_repo' };
      if (calledName) props.called_name = calledName;
      params.push(from, to, derived.edgeType, derived.label, JSON.stringify(props), derived.tier, derived.confidence);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, true, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    await pool.query(
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, is_cross_repo, properties, resolution_tier, confidence)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      params
    );
    written += chunk.length;
  }

  console.log(`[crossRepoEdges] projectId=${projectId} branchId=${branchId} candidates=${unresolvedEdges.length} resolved=${crossResolved.length} written=${written}`);
  return written;
}

// Write LSP-derived call edges to edges.
// LSP gives us (callerFile, callerMethod, calleeFile, calleeClass, calleeMethod).
// Keyed on (file_path, name) and (class_name, name) — a candidate not uniquely
// resolvable by either key is dropped rather than guessed. Resolving both ends by bare
// method name only would mis-bind when `calleeClass` is ignored.
// Edges get confidence_tier='EXTRACTED' and properties.source='lsp'.
async function _writeLspEdges(lspEdges, branchId, repoPath, _pool = pool) {
  if (!lspEdges.length) return 0;

  const { rows: methodNodes } = await _pool.query(
    `SELECT n.id, n.name, f.path AS file_path, nc.name AS class_name
     FROM nodes n
     LEFT JOIN files f ON f.id = n.file_id
     LEFT JOIN edges e ON e.from_node_id = n.id AND e.edge_type = 'DEFINED_IN'
     LEFT JOIN nodes nc ON nc.id = e.to_node_id AND nc.approval_status != 'ARCHIVED'
     WHERE n.repository_branch_id = $1
       AND n.node_type = 'METHOD'
       AND n.approval_status != 'ARCHIVED'`,
    [branchId]
  );
  if (!methodNodes.length) return 0;

  const toRelPath = (absOrRelPath) => {
    if (!absOrRelPath) return null;
    if (!repoPath) return absOrRelPath;
    return path.isAbsolute(absOrRelPath) ? path.relative(repoPath, absOrRelPath) : absOrRelPath;
  };

  const byFileAndName  = new Map(); // "file_path::name.toLowerCase()" -> [ids]
  const byClassAndName = new Map(); // "class_name.toLowerCase().name.toLowerCase()" -> [ids]

  const pushId = (map, key, id) => {
    if (!key) return;
    const list = map.get(key);
    if (list) { if (!list.includes(id)) list.push(id); } else map.set(key, [id]);
  };

  for (const n of methodNodes) {
    const nameLower = (n.name || '').toLowerCase();
    if (!nameLower) continue;
    if (n.file_path) pushId(byFileAndName, `${n.file_path}::${nameLower}`, n.id);
    if (n.class_name) pushId(byClassAndName, `${n.class_name.toLowerCase()}.${nameLower}`, n.id);
  }

  // Resolve on (file_path, name) first — file is the strongest evidence available.
  // Fall back to (class_name, name) only when file resolution found nothing at all
  // (a null result, not an ambiguous one — ambiguity at the file key means two
  // same-named methods in the same file, and the class key can't disambiguate that
  // either, so it must refuse too). Either key returning >1 candidate is ambiguous:
  // refuse rather than guess.
  const resolveUnique = (filePath, className, name) => {
    const nameLower = (name || '').toLowerCase();
    if (!nameLower) return null;
    const relFile = toRelPath(filePath);
    if (relFile) {
      const byFile = byFileAndName.get(`${relFile}::${nameLower}`);
      if (byFile) return byFile.length === 1 ? byFile[0] : null;
    }
    if (className) {
      const byClass = byClassAndName.get(`${className.toLowerCase()}.${nameLower}`);
      if (byClass) return byClass.length === 1 ? byClass[0] : null;
    }
    return null;
  };

  const seen = new Set();
  const toInsert = [];
  for (const e of lspEdges) {
    const fromId = resolveUnique(e.callerFile, null, e.callerMethod);
    const toId   = resolveUnique(e.calleeFile, e.calleeClass, e.calleeMethod);
    if (!fromId || !toId || fromId === toId) continue;
    const key = `${fromId}:${toId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    toInsert.push([fromId, toId, e.calleeMethod || null]);
  }
  if (!toInsert.length) return 0;

  const CHUNK = pool.safeChunk(3);
  let written = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    const params = [];
    // 'lsp' is a file/class-scoped UNIQUE match (real evidence, same tier band as
    // same_file), so it lands at tier 2 / EXTRACTED — see resolution/tiers.js's
    // RESOLUTION_TO_TIER.lsp.
    const lspDerived = deriveConfidenceTier('lsp'); // tier 2 -> { label: 'EXTRACTED', confidence: 0.95 }
    // called_name added only when the LSP client actually gave us a callee method name.
    const valueClauses = chunk.map(([from, to, calledName]) => {
      const base = params.length;
      const props = calledName ? { source: 'lsp', resolution: 'lsp', called_name: calledName } : { source: 'lsp', resolution: 'lsp' };
      params.push(from, to, JSON.stringify(props));
      return `($${base + 1}, $${base + 2}, 'CALLS', '${lspDerived.label}', $${base + 3}, ${lspDerived.tier}, ${lspDerived.confidence})`;
    });
    const { rowCount } = await _pool.query(
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      params
    );
    written += rowCount;
  }
  return written;
}

// Resolve properties.methods.*.repos_called → CALLS edges at ingest time.
// Also resolves tables_read → READS_TABLE and tables_written → WRITES_TABLE.
// Mirrors query-time logic in ageController.js but writes durable rows to edges.
const PROPS_CALLS_NODE_TYPES = ['SERVICE', 'NODE_SERVICE', 'SCHEDULER'];
const PROPS_TABLE_NODE_TYPES = ['REPOSITORY', 'SERVICE', 'NODE_SERVICE'];
const PROPS_CONFIG_NODE_TYPES = ['SERVICE', 'NODE_SERVICE', 'SCHEDULER', 'REPOSITORY'];
// Union — all node types that may carry repos_called, tables_read/written, or config_deps
const PROPS_METHOD_NODE_TYPES = [...new Set([...PROPS_CALLS_NODE_TYPES, ...PROPS_TABLE_NODE_TYPES, ...PROPS_CONFIG_NODE_TYPES])];

function _repoClassFromRc(rc) {
  const s = String(rc == null ? '' : rc).trim();
  const i = s.indexOf('.');
  return i === -1 ? s : s.slice(0, i);
}

function _resolveTableRef(ref, entityByName, dbTableByName) {
  const r = String(ref || '').trim().toLowerCase();
  if (!r) return null;
  if (entityByName.has(r)) return entityByName.get(r);
  const short = r.includes('.') ? r.slice(r.lastIndexOf('.') + 1) : r;
  if (short !== r && entityByName.has(short)) return entityByName.get(short);
  if (dbTableByName.has(r)) return dbTableByName.get(r);
  if (short !== r && dbTableByName.has(short)) return dbTableByName.get(short);
  return null;
}

function _sourceNodeForReference(nodes, line) {
  if (!nodes?.length) return null;
  if (!Number.isInteger(line)) return nodes[0].node_id;
  const containing = nodes
    .filter((node) => Number.isInteger(node.start_line) && Number.isInteger(node.end_line)
      && node.start_line <= line && line <= node.end_line)
    .sort((a, b) => {
      const methodRank = Number(b.node_type === 'METHOD') - Number(a.node_type === 'METHOD');
      if (methodRank !== 0) return methodRank;
      const spanRank = (a.end_line - a.start_line) - (b.end_line - b.start_line);
      return spanRank || a.node_id - b.node_id;
    });
  return containing[0]?.node_id || nodes[0].node_id;
}

async function writeMethodPropertyEdges(branchId) {
  const { rows: sourceNodes } = await pool.query(
    `SELECT id, node_type, properties
     FROM nodes
     WHERE repository_branch_id = $1
       AND node_type IN (SELECT value FROM json_each($2))
       AND approval_status != 'ARCHIVED'
       AND json_extract(properties, '$.methods') IS NOT NULL`,
    [branchId, PROPS_METHOD_NODE_TYPES]
  );
  if (!sourceNodes.length) return 0;

  // name→id map for the whole branch (for repos_called resolution)
  const { rows: allNodes } = await pool.query(
    `SELECT id, name FROM nodes
     WHERE repository_branch_id = $1
       AND approval_status != 'ARCHIVED'
     ORDER BY id`,
    [branchId]
  );
  const branchByNameLower = new Map();
  for (const r of allNodes) {
    const k = (r.name || '').toLowerCase().trim();
    if (k && !branchByNameLower.has(k)) branchByNameLower.set(k, r.id);
  }
  if (!branchByNameLower.size) return 0;

  // ENTITY nodes in same branch (preferred target for tables_read/written)
  const { rows: entityNodes } = await pool.query(
    `SELECT id, name FROM nodes
     WHERE repository_branch_id = $1
       AND node_type = 'ENTITY'
       AND approval_status != 'ARCHIVED'
     ORDER BY id`,
    [branchId]
  );
  const entityByNameLower = new Map();
  for (const e of entityNodes) {
    const k = (e.name || '').toLowerCase().trim();
    if (k && !entityByNameLower.has(k)) entityByNameLower.set(k, e.id);
  }

  // CONFIG_VALUE nodes in the same branch (targets for USES_CONFIG edges)
  const { rows: configNodes } = await pool.query(
    `SELECT id, name FROM nodes
     WHERE repository_branch_id = $1
       AND node_type = 'CONFIG_VALUE'
       AND approval_status != 'ARCHIVED'
     ORDER BY id`,
    [branchId]
  );
  const configByNameLower = new Map();
  for (const c of configNodes) {
    const k = (c.name || '').toLowerCase().trim();
    if (k && !configByNameLower.has(k)) configByNameLower.set(k, c.id);
  }

  // DB_TABLE nodes across the whole project (fallback for tables_read/written)
  const { rows: branchInfo } = await pool.query(
    `SELECT r.project_id FROM repository_branches rb
     JOIN repositories r ON r.id = rb.repository_id
     WHERE rb.id = $1`,
    [branchId]
  );
  const projectId = branchInfo[0]?.project_id;
  const dbTableByNameLower = new Map();
  if (projectId) {
    const { rows: dbTableNodes } = await pool.query(
      `SELECT id, name FROM (
         SELECT n.id, n.name,
                ROW_NUMBER() OVER (PARTITION BY n.name ORDER BY n.id ASC) AS _rn
         FROM nodes n
         JOIN repository_branches rb ON rb.id = n.repository_branch_id
         JOIN repositories r ON r.id = rb.repository_id
         WHERE r.project_id = $1
           AND n.node_type = 'DB_TABLE'
           AND n.approval_status != 'ARCHIVED'
       ) ranked WHERE _rn = 1`,
      [projectId]
    );
    for (const t of dbTableNodes) {
      const k = (t.name || '').toLowerCase().trim();
      if (k && !dbTableByNameLower.has(k)) dbTableByNameLower.set(k, t.id);
    }
  }

  // Collect (fromId, toId, edgeType) triples — deduplicated
  const triples = new Map(); // key `fromId|toId|edgeType` → [fromId, toId, edgeType]

  for (const n of sourceNodes) {
    const methods = n.properties?.methods;
    if (!methods || typeof methods !== 'object' || Array.isArray(methods)) continue;
    const isCallsNode = PROPS_CALLS_NODE_TYPES.includes(n.node_type);
    const isTableNode = PROPS_TABLE_NODE_TYPES.includes(n.node_type);
    const isConfigNode = PROPS_CONFIG_NODE_TYPES.includes(n.node_type);

    const visited = new Set();
    const collectBlock = (block) => {
      if (!block || typeof block !== 'object') return;

      if (isCallsNode) {
        for (const rc of block.repos_called || []) {
          const repoClass = _repoClassFromRc(rc);
          if (!repoClass) continue;
          const toId = branchByNameLower.get(repoClass.toLowerCase());
          if (toId && toId !== n.id) triples.set(`${n.id}|${toId}|CALLS`, [n.id, toId, 'CALLS', repoClass]);
        }
      }

      if (isTableNode) {
        for (const ref of block.tables_read || []) {
          const toId = _resolveTableRef(ref, entityByNameLower, dbTableByNameLower);
          if (toId && toId !== n.id) triples.set(`${n.id}|${toId}|READS_TABLE`, [n.id, toId, 'READS_TABLE', ref]);
        }
        for (const ref of block.tables_written || []) {
          const toId = _resolveTableRef(ref, entityByNameLower, dbTableByNameLower);
          if (toId && toId !== n.id) triples.set(`${n.id}|${toId}|WRITES_TABLE`, [n.id, toId, 'WRITES_TABLE', ref]);
        }
      }

      if (isConfigNode) {
        for (const cfg of block.config_deps || []) {
          const toId = resolveConfigRef(cfg, configByNameLower);
          if (toId && toId !== n.id) triples.set(`${n.id}|${toId}|USES_CONFIG`, [n.id, toId, 'USES_CONFIG', typeof cfg === 'string' ? cfg : (cfg?.key || cfg?.name || null)]);
        }
      }

      for (const ph of block.private_helpers || []) {
        if (methods[ph] && !visited.has(ph)) { visited.add(ph); collectBlock(methods[ph]); }
      }
    };

    for (const block of Object.values(methods)) collectBlock(block);
  }

  if (!triples.size) return 0;

  const resolved = [...triples.values()];
  const CHUNK = pool.safeChunk(7);
  let written = 0;
  for (let i = 0; i < resolved.length; i += CHUNK) {
    const chunk = resolved.slice(i, i + CHUNK);
    const params = [];
    // This pass resolves entity/table/config CALLS by bare-name lookup with no import
    // evidence — same evidence band as global_label (tier 7) — so labelForTier(7)
    // derives the label through the single source. It stamps resolution_tier/confidence
    // and a real properties.resolution + called_name. Tier 7 stays < 8, so this never
    // produces HEURISTIC_CALLS.
    const valueClauses = chunk.map(([from, to, edgeType, calledName]) => {
      const base = params.length;
      const derived = edgeWriteTier('method_properties_lookup', edgeType);
      const props = { resolution: 'method_properties_lookup' };
      if (calledName) props.called_name = calledName;
      params.push(from, to, derived.edgeType, derived.label, JSON.stringify(props), derived.tier, derived.confidence);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    await pool.query(
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      params
    );
    written += chunk.length;
  }
  return written;
}

// ─── GQ-7b: relative JS/TS import → DEPENDS_ON edges ─────────────────────────
//
// Takes collected [{ fromNodeId, targetRelPath }] from the ingest loop.
// Resolves each target repo-relative path against CLASS/SERVICE/NODE_SERVICE nodes
// in the same branch (using path-with and path-without-extension lookups).
async function writeRelativeImportEdges(pendingRelativeImports, branchId) {
  if (!pendingRelativeImports.length) return { written: 0, unresolvedImports: [] };

  const { rows: branchFiles } = await pool.query(
    `SELECT f.path, n.id AS node_id
     FROM files f
     JOIN nodes n ON n.file_id = f.id
     WHERE f.repository_branch_id = $1
       AND n.node_type IN ('CLASS','NODE_SERVICE','SERVICE')
       AND n.approval_status != 'ARCHIVED'
     ORDER BY n.id ASC`,
    [branchId]
  );

  // path (with and without extension) → first matching node id
  const fileToNodeId = new Map();
  for (const row of branchFiles) {
    if (!fileToNodeId.has(row.path)) fileToNodeId.set(row.path, row.node_id);
    const stripped = row.path.replace(/\.[^./]+$/, '');
    if (!fileToNodeId.has(stripped)) fileToNodeId.set(stripped, row.node_id);
  }

  const triples = new Map();
  // Collect imports that couldn't be resolved within the branch (candidates for cross-repo)
  const unresolvedImports = [];
  for (const { fromNodeId, targetRelPath } of pendingRelativeImports) {
    if (!fromNodeId) continue;
    const toId = fileToNodeId.get(targetRelPath)
      ?? fileToNodeId.get(targetRelPath.replace(/\.[^./]+$/, ''));
    if (toId && toId !== fromNodeId) {
      triples.set(`${fromNodeId}|${toId}|DEPENDS_ON`, [fromNodeId, toId, 'DEPENDS_ON', targetRelPath]);
    } else {
      // Unresolved in this branch — try the basename as the node name for cross-repo lookup.
      // e.g. '../../shared/src/helper' → basename 'helper'
      const base = require('path').basename(targetRelPath).replace(/\.[^./]+$/, '');
      if (base) unresolvedImports.push({ fromNodeId, toName: base, edgeType: 'DEPENDS_ON', confidenceTier: 'EXTRACTED' });
    }
  }
  if (!triples.size && !unresolvedImports.length) return { written: 0, unresolvedImports };

  const resolved = [...triples.values()];
  const CHUNK = pool.safeChunk(7);
  let written = 0;
  for (let i = 0; i < resolved.length; i += CHUNK) {
    const chunk = resolved.slice(i, i + CHUNK);
    const params = [];
    // This triple is a real relative-import resolution (targetRelPath matched a file the
    // branch actually has a node for), not a name guess — resolution:'import' is honest
    // here and keeps EXTRACTED via deriveConfidenceTier.
    const valueClauses = chunk.map(([from, to, type, targetRelPath]) => {
      const base = params.length;
      const derived = edgeWriteTier('import', type);
      const props = { resolution: 'import' };
      if (targetRelPath) props.called_name = targetRelPath;
      params.push(from, to, derived.edgeType, derived.label, JSON.stringify(props), derived.tier, derived.confidence);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    await pool.query(
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      params
    );
    written += chunk.length;
  }
  console.log(`[writeRelativeImportEdges] branchId=${branchId} candidates=${pendingRelativeImports.length} written=${written} unresolved=${unresolvedImports.length}`);
  return { written, unresolvedImports };
}

// ─── GQ-8: SQL/JPQL table reference → READS_TABLE/WRITES_TABLE edges ─────────
//
// Takes collected [{ fileId, refs: [{entityName, operation, line}] }].
// Resolves entity names against ENTITY nodes (same branch) and DB_TABLE nodes
// (same project), writes READS_TABLE / WRITES_TABLE with confidence_tier='EXTRACTED'.
async function writeSqlReferenceEdges(pendingSqlRefs, branchId) {
  if (!pendingSqlRefs.length) return 0;

  // Prefer the narrowest method spanning the reference line; retain the prior
  // first CLASS/REPOSITORY fallback when span evidence is unavailable.
  const allFileIds = [...new Set(pendingSqlRefs.map(r => r.fileId))];
  const { rows: fileNodeRows } = await pool.query(
    `SELECT n.file_id, n.id AS node_id, n.node_type, n.start_line, n.end_line
     FROM nodes n
     WHERE n.file_id IN (SELECT value FROM json_each($1))
       AND n.node_type IN ('METHOD','REPOSITORY','CLASS','NODE_SERVICE','SERVICE')
       AND n.approval_status != 'ARCHIVED'
     ORDER BY n.id ASC`,
    [allFileIds]
  );
  const fileToNodes = new Map();
  for (const row of fileNodeRows) {
    const nodes = fileToNodes.get(row.file_id);
    if (nodes) nodes.push(row); else fileToNodes.set(row.file_id, [row]);
  }

  // ENTITY nodes in same branch
  const { rows: entityNodes } = await pool.query(
    `SELECT id, name FROM nodes
     WHERE repository_branch_id = $1
       AND node_type = 'ENTITY'
       AND approval_status != 'ARCHIVED'
     ORDER BY id`,
    [branchId]
  );
  const entityByNameLower = new Map();
  for (const e of entityNodes) {
    const k = (e.name || '').toLowerCase();
    if (k && !entityByNameLower.has(k)) entityByNameLower.set(k, e.id);
  }

  // DB_TABLE fallback (same project)
  const { rows: branchInfo } = await pool.query(
    `SELECT r.project_id FROM repository_branches rb
     JOIN repositories r ON r.id = rb.repository_id
     WHERE rb.id = $1`,
    [branchId]
  );
  const projectId = branchInfo[0]?.project_id;
  const dbTableByNameLower = new Map();
  if (projectId) {
    const { rows: dbTableNodes } = await pool.query(
      `SELECT id, name FROM (
         SELECT n.id, n.name,
                ROW_NUMBER() OVER (PARTITION BY n.name ORDER BY n.id ASC) AS _rn
         FROM nodes n
         JOIN repository_branches rb ON rb.id = n.repository_branch_id
         JOIN repositories r ON r.id = rb.repository_id
         WHERE r.project_id = $1
           AND n.node_type = 'DB_TABLE'
           AND n.approval_status != 'ARCHIVED'
       ) ranked WHERE _rn = 1`,
      [projectId]
    );
    for (const t of dbTableNodes) {
      const k = (t.name || '').toLowerCase();
      if (k && !dbTableByNameLower.has(k)) dbTableByNameLower.set(k, t.id);
    }
  }

  const triples = new Map();
  for (const { fileId, refs } of pendingSqlRefs) {
    const sourceNodes = fileToNodes.get(fileId);
    if (!sourceNodes?.length) continue;
    for (const { entityName, operation, line } of refs) {
      const fromNodeId = _sourceNodeForReference(sourceNodes, line);
      const toId = _resolveTableRef(entityName, entityByNameLower, dbTableByNameLower);
      if (!toId || toId === fromNodeId) continue;
      const edgeType = operation === 'WRITE' ? 'WRITES_TABLE' : 'READS_TABLE';
      triples.set(`${fromNodeId}|${toId}|${edgeType}`, [fromNodeId, toId, edgeType, entityName]);
    }
  }
  if (!triples.size) return 0;

  const resolved = [...triples.values()];
  const CHUNK = pool.safeChunk(7);
  let written = 0;
  for (let i = 0; i < resolved.length; i += CHUNK) {
    const chunk = resolved.slice(i, i + CHUNK);
    const params = [];
    // 'sql_reference' (tier 5) — a parsed SQL/JPQL table reference matched against a
    // known ENTITY/DB_TABLE name is real evidence, not a name guess.
    const valueClauses = chunk.map(([from, to, type, entityName]) => {
      const base = params.length;
      const derived = edgeWriteTier('sql_reference', type);
      const props = { resolution: 'sql_reference' };
      if (entityName) props.called_name = entityName;
      params.push(from, to, derived.edgeType, derived.label, JSON.stringify(props), derived.tier, derived.confidence);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    await pool.query(
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      params
    );
    written += chunk.length;
  }
  console.log(`[writeSqlReferenceEdges] branchId=${branchId} files=${pendingSqlRefs.length} written=${written}`);
  return written;
}

// ─── Config/env-var USES_CONFIG edge writer (GQ-6a) ──────────────────────────
//
// For each file that had config/env-var refs extracted, prefer the narrowest METHOD
// spanning the reference line, fall back to the first eligible file-level node, and
// emit USES_CONFIG edges to the matching CONFIG_VALUE node in the same branch.
async function writeConfigValueRefEdges(pendingConfigRefs, branchId, _pool = pool) {
  // This function sits behind a swallowed .catch in ingest-post-tail.js, so its 0-edge
  // output must be distinguishable from a silent failure. Every path logs a hard count
  // so "ran, found nothing to wire" (console.log here) reads differently from "threw"
  // (console.error in the caller's .catch).
  if (!pendingConfigRefs.length) {
    console.log(`[writeConfigValueRefEdges] branchId=${branchId} files=0 written=0 (no pending refs)`);
    return 0;
  }

  const allFileIds = [...new Set(pendingConfigRefs.map(r => r.fileId))];
  const { rows: fileNodeRows } = await _pool.query(
    `SELECT n.file_id, n.id AS node_id, n.node_type, n.start_line, n.end_line
     FROM nodes n
     WHERE n.file_id IN (SELECT value FROM json_each($1))
       AND n.node_type IN ('METHOD','CONTROLLER','CLASS','SERVICE','NODE_SERVICE','SCHEDULER','REPOSITORY')
       AND n.approval_status != 'ARCHIVED'
     ORDER BY n.id ASC`,
    [allFileIds]
  );
  const fileToNodes = new Map();
  for (const row of fileNodeRows) {
    const nodes = fileToNodes.get(row.file_id);
    if (nodes) nodes.push(row); else fileToNodes.set(row.file_id, [row]);
  }

  // CONFIG_VALUE nodes in same branch, keyed by config key name (lowercased)
  const { rows: configNodes } = await _pool.query(
    `SELECT id, name FROM nodes
     WHERE repository_branch_id = $1
       AND node_type = 'CONFIG_VALUE'
       AND approval_status != 'ARCHIVED'
     ORDER BY id`,
    [branchId]
  );
  // All nodes per key, not the first. One key exists once per catalogue —
  // spring-petclinic ships ten translations of the same 52 keys, django-machina
  // twenty-four of the same 344 — and binding only the first left the other
  // nine (or twenty-three) catalogues unreachable, which is precisely the
  // 43%-of-the-graph island this pass exists to close. Reaching every
  // translation of a key from its use site is also the ripple the corpus
  // measures, so first-wins was wrong on both counts.
  const configByKeyLower = new Map();
  for (const c of configNodes) {
    const k = (c.name || '').toLowerCase();
    if (!k) continue;
    const list = configByKeyLower.get(k);
    if (list) list.push(c.id); else configByKeyLower.set(k, [c.id]);
  }

  const triples = new Map();
  for (const { fileId, refs } of pendingConfigRefs) {
    const sourceNodes = fileToNodes.get(fileId);
    if (!sourceNodes?.length) continue;
    for (const { configKey, line } of refs) {
      const fromNodeId = _sourceNodeForReference(sourceNodes, line);
      for (const toId of configByKeyLower.get(configKey.toLowerCase()) || []) {
        if (toId === fromNodeId) continue;
        triples.set(`${fromNodeId}|${toId}|USES_CONFIG`, [fromNodeId, toId, 'USES_CONFIG', configKey]);
      }
    }
  }
  if (!triples.size) {
    console.log(`[writeConfigValueRefEdges] branchId=${branchId} files=${pendingConfigRefs.length} written=0 (no triples resolved)`);
    return 0;
  }

  const resolved = [...triples.values()];
  const CHUNK = pool.safeChunk(7);
  let written = 0;
  for (let i = 0; i < resolved.length; i += CHUNK) {
    const chunk = resolved.slice(i, i + CHUNK);
    const params = [];
    // 'config_value_ref' (tier 5) — an extracted config/env-var key matched exactly
    // against a CONFIG_VALUE node's name.
    const valueClauses = chunk.map(([from, to, type, configKey]) => {
      const base = params.length;
      const derived = edgeWriteTier('config_value_ref', type);
      const props = { resolution: 'config_value_ref' };
      if (configKey) props.called_name = configKey;
      params.push(from, to, derived.edgeType, derived.label, JSON.stringify(props), derived.tier, derived.confidence);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    await _pool.query(
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      params
    );
    written += chunk.length;
  }
  console.log(`[writeConfigValueRefEdges] branchId=${branchId} files=${pendingConfigRefs.length} written=${written}`);
  return written;
}

// CONFIG_VALUE nodes are among the largest node types yet almost nothing code-side ever
// resolves a USES_CONFIG edge to them. Tooling/CI/deployment config (buckets C+D below)
// is structurally unreferenceable by any code path, so this pass keeps writing
// source-cache + lexical chunks for those files (full searchability) but stops emitting
// CONFIG_VALUE nodes for them.
//
// DENY-LIST polarity is deliberate: an unrecognised path defaults to 'nodes'. `.env`,
// `bootstrap.yml`, `config/*.yml`, `tsconfig.json`, `pyproject.toml`, `*.tf`,
// `nginx.conf` are unmeasured, and an allow-list would silently suppress CONFIG_VALUE
// nodes on the first non-Java customer repo.
const CONFIG_LEXICAL_ONLY_PATTERNS = [
  /^\.github\//,                              // bucket C: CI workflow config
  /(^|\/)\.(editorconfig|gitattributes|gitpod\.yml)$/, // bucket C: repo tooling dotfiles
  /devcontainer/,                             // bucket C: devcontainer*.json
  /\/wrapper\/[^/]*\.properties$/,            // bucket C: gradle/maven wrapper properties
  /docker-compose/,                           // bucket D: deployment compose files
];

function configNodeEligibility(relPath) {
  return CONFIG_LEXICAL_ONLY_PATTERNS.some((re) => re.test(relPath)) ? 'lexical_only' : 'nodes';
}

// ─── Call-expression CALLS edge resolver ─────────────────────────────────────
//
// GQ-6b: after all AST nodes for a branch are written, each METHOD node's
// properties.callExpressions (set by ast-extractor GQ-6a) is resolved against
// METHOD nodes in the same branch by lowercase name.
//   1 match  → confidence_tier = 'INFERRED'
//   N matches → confidence_tier = 'INFERRED' (edges constraint: EXTRACTED|INFERRED|SYNTHETIC only)
//   0 matches → dropped (cross-repo or external call — handled later in GQ-11)
//
// Bounded fan-out: a callee name matching more than this many methods after
// class narrowing is refused outright rather than emitted against every
// candidate. Set to the same allowance resolve.js#resolveViaGlobalLabel already
// documents for its tie-break (<=3), not chosen freely.
const MAX_CALL_CANDIDATE_FANOUT = 3;

// Above the traversable bound but still recoverable. A callee name matching >3 methods
// after class narrowing, if refused OUTRIGHT — no edge at all, not even a heuristic one —
// makes a Java `save()` implemented across four repositories lose EVERY call edge into
// it, invisibly except for one log line. The bound is right for traversal (a guess among many is
// not evidence) and wrong for the record. Between the two bounds the edge is now written as
// HEURISTIC_CALLS, which context_pack excludes from expansion, so retrieval is unchanged and the
// structure stops being silently deleted. Beyond this ceiling it is still refused: a Django
// `get`/`post` name matching hundreds of handlers is noise at any label.
const HEURISTIC_CALL_FANOUT_CEILING = (() => {
  if (process.env.KORAGRAPH_HEURISTIC_CALL_FANOUT_CEILING) {
    return parseInt(process.env.KORAGRAPH_HEURISTIC_CALL_FANOUT_CEILING, 10);
  }
  return 10;
})();

// Callee names are matched through a lowercased index. That index exists for the receiver side —
// the DI shape where a field `visitRepository` names the type `VisitRepository` — but it also
// case-folds the METHOD name, and in a case-sensitive language that fabricates edges outright.
// In one nestjs/nest spec file the source text `.filter(` bound to `class Filter`, 44 fabricated
// edges from that one class. Restricted to TS/JS here because this work is scoped to those two
// languages; the same fold is wrong in Python, Go, Java and C# and should be measured before it
// is changed there.
const CASE_SENSITIVE_CALL_EXTS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
]);
function extOf(filePath) {
  if (!filePath) return '';
  const dot = filePath.lastIndexOf('.');
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
}
function callMatchIsCaseSensitive(filePath) {
  return CASE_SENSITIVE_CALL_EXTS.has(extOf(filePath));
}
// Languages whose receivers carry declared types, so "no type resolved" is informative.
const TYPED_CALL_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);

// A declaration inside a test tree is not what a production call site binds to. Measured on
// nestjs/nest: 557 of 947 wrong-target call edges pointed into a `test/` directory or a
// `*.spec.ts` file. Narrowing is only kept when it leaves at least one candidate, and a caller
// that is itself in a test file is left alone, so this can remove no reachable target.
const TEST_PATH_RE = /(^|\/)(tests?|specs?|__tests__|testing)\/|(^|\/)[^/]*[._-](spec|test|tests)\.[A-Za-z]+$|(^|\/)test_[^/]*$|Test\.(java|kt|cs)$/;
const isTestPath = (p) => !!p && TEST_PATH_RE.test(p);

// `scopeFileIds`, when given, restricts which CALLERS get re-resolved to those declared in the
// listed files — an untouched caller's edges are already correct, so re-deriving them from
// scratch is wasted work on every incremental ingest. The CANDIDATE index below (fileIndex,
// byName, byClassAndName, ...) stays branch-wide regardless of scope: a touched file's call can
// legitimately target any declaration anywhere, so narrowing the candidate pool would be a
// correctness bug, not an optimization. Omit (or pass a falsy/empty value) for the full,
// unscoped resolution every full ingest and existing caller relies on.
//
// Known, accepted gap: a call that was previously REFUSED as ambiguous (see the fanout/locality
// comments below) can only become resolvable when the declarations it was ambiguous against
// change — and if that caller's own file was not touched, a scoped run will not revisit it, so
// the now-resolvable edge is missed until that caller's file is itself re-ingested (or a full,
// unscoped ingest runs). This does not apply to a caller that already has a written edge — an
// already-resolved edge is never invalidated by an untouched file, only a refused one could ever
// need reconsideration, and only in the caller's favor (more candidates removed, never added).
async function resolveCallExpressionEdges(branchId, scopeFileIds = null) {
  const scoped = Array.isArray(scopeFileIds) && scopeFileIds.length > 0;
  const { rows: callerNodes } = await pool.query(
    scoped
      ? `SELECT id, json_extract(properties, '$.callExpressions') AS call_exprs
         FROM nodes
         WHERE repository_branch_id = $1
           AND node_type = 'METHOD'
           AND approval_status != 'ARCHIVED'
           AND json_type(properties, '$.callExpressions') IS NOT NULL
           AND file_id IN (SELECT value FROM json_each($2))`
      : `SELECT id, json_extract(properties, '$.callExpressions') AS call_exprs
         FROM nodes
         WHERE repository_branch_id = $1
           AND node_type = 'METHOD'
           AND approval_status != 'ARCHIVED'
           AND json_type(properties, '$.callExpressions') IS NOT NULL`,
    scoped ? [branchId, scopeFileIds] : [branchId]
  );
  if (!callerNodes.length) return 0;

  const { rows: fileScopedRows } = await pool.query(
    `SELECT n.id, n.name, n.node_type, f.path AS file_path,
            json_extract(n.properties, '$.module') AS module, json_extract(n.properties, '$.alias') AS alias,
            n.properties AS properties
       FROM nodes n
       JOIN files f ON f.id = n.file_id
      WHERE n.repository_branch_id = $1 AND n.approval_status != 'ARCHIVED'
      ORDER BY f.path, n.id`,
    [branchId]
  );
  const fileIndex = buildFileScopedIndex(fileScopedRows);

  // Single query: fetch all METHOD nodes with their optional DEFINED_IN class (GQH-11a).
  const { rows: methodRows } = await pool.query(
    `SELECT n.id, n.name, e.to_node_id AS class_node_id,
            nc.name AS class_name, nf.path AS def_path,
            json_extract(n.properties, '$.visibility') AS visibility,
            json_extract(n.properties, '$.kind') AS kind
     FROM nodes n
     LEFT JOIN files nf ON nf.id = n.file_id
     LEFT JOIN edges e ON e.from_node_id = n.id
       AND e.edge_type = 'DEFINED_IN'
     LEFT JOIN nodes nc ON nc.id = e.to_node_id
       AND nc.approval_status != 'ARCHIVED'
     WHERE n.repository_branch_id = $1
       -- Constructor calls are calls. Restricting candidates to METHOD meant that
       -- Request(...), Session(...) and new Foo() -- the most common call shape in OO code --
       -- could never resolve to the type being constructed, and the lowercased index below
       -- then mis-bound requests.Request to the unrelated request FUNCTION in api.py.
       -- Measured on psf/requests: Request (64) + Session (57) + RequestsCookieJar (13) +
       -- Response (12) were 146 of 229 missing intra-repo call edges.
       AND n.node_type IN ('METHOD', 'CLASS', 'ENTITY', 'INTERFACE')
       AND n.approval_status != 'ARCHIVED'`,
    [branchId]
  );
  const byName = new Map();         // lowercase name → [id, ...]
  const byClassAndName = new Map(); // "classname.methodname" → [methodId, ...]
  const methodClassId = new Map();  // methodId → classId
  // Exact-case index, consulted BEFORE the lowercased one. Python/Go/TS all distinguish
  // `Request` (a class) from `request` (a function), and folding them into one bucket is what
  // let a case-insensitive collision outrank an exact-case match.
  const byNameExact = new Map();
  const byClassAndNameExact = new Map(); // "classlower#ExactMember" → [methodId, ...]
  const defPathById = new Map();
  const defPrivateById = new Set();
  const defObjPropFnById = new Set();
  for (const row of methodRows) {
    if (row.def_path) defPathById.set(row.id, row.def_path);
    if (row.visibility === 'private') defPrivateById.add(row.id);
    if (row.kind === 'object_prop_fn') defObjPropFnById.add(row.id);
    const exact = (row.name || '').trim();
    if (exact) {
      if (!byNameExact.has(exact)) byNameExact.set(exact, []);
      byNameExact.get(exact).push(row.id);
    }
    const k = (row.name || '').toLowerCase().trim();
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(row.id);
    if (row.class_node_id) {
      const classKey = `${(row.class_name || '').toLowerCase()}.${k}`;
      if (!byClassAndName.has(classKey)) byClassAndName.set(classKey, []);
      byClassAndName.get(classKey).push(row.id);
      // Receiver stays case-folded (a field `visitRepository` names type `VisitRepository`);
      // the member name does not.
      if (exact) {
        const exactKey = `${(row.class_name || '').toLowerCase()}#${exact}`;
        if (!byClassAndNameExact.has(exactKey)) byClassAndNameExact.set(exactKey, []);
        byClassAndNameExact.get(exactKey).push(row.id);
      }
      methodClassId.set(row.id, row.class_node_id);
    }
  }
  if (!byName.size) return 0;

  // Same-class, then same-file, then same-directory. A narrowing is kept only when it leaves at
  // least one candidate, so it can lose no reachable target. Shared by the plain and the dotted
  // branch: once the extractor started carrying the receiver, EVERY member call took the dotted
  // branch, which had no narrowing at all — so a name with 11+ branch-wide matches went from
  // "narrow to the caller's own file, write the edge" to "refuse, too many candidates". Measured
  // on jquery, that alone cost 2.7 points of name-level call recall.
  const narrowByLocality = (list, callerId, callerPath) => {
    const narrow = (l, pred) => { const kept = l.filter(pred); return kept.length > 0 ? kept : l; };
    const callerClass = methodClassId.get(callerId);
    let cands = list;
    if (callerClass) cands = narrow(cands, (id) => methodClassId.get(id) === callerClass);
    if (cands.length > 1 && callerPath) {
      cands = narrow(cands, (id) => defPathById.get(id) === callerPath);
    }
    if (cands.length > 1 && callerPath) {
      const dir = callerPath.slice(0, callerPath.lastIndexOf('/') + 1);
      cands = narrow(cands, (id) => (defPathById.get(id) || '').startsWith(dir));
    }
    return cands;
  };

  const triples = new Map(); // `fromId|toId|CALLS` → [from, to, type, tier]
  let callFanoutRefused = 0;
  let callTestTargetsRefused = 0;
  let callCrossLanguageRefused = 0;
  let callReceiverUnresolved = 0;
  let bareNameUniqueFallback = 0;
  let callPrivateRefused = 0;
  let callObjPropFnRefused = 0;
  let callFanoutDemoted = 0;
  for (const caller of callerNodes) {
    const callExprs = caller.call_exprs;
    if (!Array.isArray(callExprs)) continue;
    for (const expr of callExprs) {
      const rawCallee = (expr.callee || '').trim();
      if (!rawCallee) continue;
      const calleeLower = rawCallee.toLowerCase();

      let targets;
      let fallbackDemoted = false;
      let resolution = null;
      const callerPath = defPathById.get(caller.id);
      const caseSensitive = callMatchIsCaseSensitive(callerPath);
      // The refusal below reads "the receiver named no type we know" as evidence that there is
      // no target. That inference only holds where receivers CAN be typed. In plain JavaScript
      // nothing is annotated, so the same silence means nothing — measured on jquery, applying
      // it there cost 22.5 points of call recall for 1.9 points of precision.
      const hasDeclaredTypes = TYPED_CALL_EXTS.has(extOf(callerPath));
      const importHit = resolveViaImportEvidence(caller.id, rawCallee, fileIndex)
        || resolveViaModuleStem(caller.id, rawCallee, fileIndex, fileIndex.symbolIndex);
      if (importHit) {
        targets = [importHit.targetId];
        resolution = importHit.resolution;
      } else if (rawCallee.includes('.')) {
        // Dotted callee (e.g. "userService.create"): use class-contextual map first.
        const parts = calleeLower.split('.');
        const methodPart = parts[parts.length - 1];
        const classPart = parts[parts.length - 2];
        const exactPart = rawCallee.split('.').pop();
        targets = caseSensitive
          ? byClassAndNameExact.get(`${classPart}#${exactPart}`)
          : byClassAndName.get(`${classPart}.${methodPart}`);
        const classContextMissed = !targets || targets.length === 0;
        // A receiver the extractor resolved to a TYPE is evidence, and falling through to a
        // branch-wide match on the member name throws that evidence away. Measured on
        // nestjs/nest: `protected readonly logger: LoggerService` is declared in a package we
        // ingested as a SEPARATE repository, so `this.logger.error(...)` found no LoggerService
        // here and the bare-name fallback bound it to whichever `error` method it liked — 106
        // wrong edges. When the resolved type is not declared in this branch there is no target,
        // and no edge is the right answer. When the type IS declared but the member is not found
        // under it, the member is inherited or declared on an interface we do not model, and the
        // fallback still earns its keep.
        if ((!targets || targets.length === 0) && expr.type_flow) {
          const typeDeclared = byNameExact.get(rawCallee.split('.')[0]);
          if (!typeDeclared || typeDeclared.length === 0) continue;
        }
        // Exact-case on the final component before the case-folded fallback, so
        // `requests.Request` binds to class Request rather than function request.
        if (!targets || targets.length === 0) targets = byNameExact.get(exactPart);
        // The dotted branch had no narrowing at all: when the receiver named no class we knew,
        // every same-named member in the branch became a candidate and, at 4-10 of them, all of
        // them were written as HEURISTIC_CALLS. `this.logger.error(...)` where `logger` is a
        // field of a BASE class in another file is the shape — the receiver is real, we just
        // cannot see its type, and a branch-wide guess among 10 `error` methods is not evidence.
        // One candidate branch-wide still is, so that case is kept.
        if (classContextMissed && targets && targets.length === 1) {
          // `x.get()` where the receiver named no type we know, and exactly one `get` exists
          // branch-wide. This is the same guess the multi-candidate branch refuses, differing only in how many
          // ways there were to be wrong -- and on a dotted call the receiver is the whole point:
          // in JavaScript `.get(` is usually Map.get, in Python usually dict.get, and in neither
          // case a call to any declared function. Volume: 26% of express's CALLS, 21% of got's,
          // 10% of commons-cli's.
          bareNameUniqueFallback++;
          if (process.env.CALL_BARE_NAME_UNIQUE !== 'keep') fallbackDemoted = true;
        }
        if (classContextMissed && targets && targets.length > 1) {
          if (hasDeclaredTypes) { callReceiverUnresolved++; continue; }
          targets = narrowByLocality(targets, caller.id, callerPath);
        }
        // Fall back to plain name on method part if no class-contextual match. Only where the
        // language does not distinguish `Filter` from `filter` for us.
        if ((!targets || targets.length === 0) && !caseSensitive) targets = byName.get(methodPart);
      } else {
        // Plain callee: if multiple hits, prefer methods in the caller's own class.
        const allTargets = byNameExact.get(rawCallee)
          || (caseSensitive ? null : byName.get(calleeLower));
        if (!allTargets || allTargets.length === 0) continue;
        if (allTargets.length === 1) {
          targets = allTargets;
        } else {
          // Narrow by locality before guessing. Measured on psf/requests the
          // `call_expression_ambiguous` rung was 55.2% correct -- a coin flip -- while every
          // other rung ran 90%+, making it the largest single source of false call edges.
          // Class context alone is too coarse: a module-level function has no class, so every
          // same-named function in the repository stayed a candidate. Same FILE then same
          // DIRECTORY is the ordinary scoping a reader assumes, and it costs no recall because
          // a narrowing is only kept when it leaves at least one candidate.
          targets = narrowByLocality(allTargets, caller.id, callerPath);
        }
      }

      if (!targets || targets.length === 0) continue;

      // A production call site does not bind to a declaration inside a test tree. Measured on
      // nestjs/nest: 557 of 947 wrong-target call edges pointed at a `test/` or `*.spec.ts`
      // declaration. Kept only when a non-test candidate survives, and never applied when the
      // caller is itself a test, so no reachable target can be removed by it.
      // A call site cannot resolve to a declaration in another language, and nothing above this
      // line was checking. Measured on a five-repo, 14,095-node store: 1,544 of 19,595 call edges
      // (7.9%) crossed a real language boundary, 890 of them at the EXTRACTED tier through this
      // writer -- a single Go `func Set` in a referee script collected 180 CALLS from .js files
      // and 41 from .py files, because it was the only declaration in the store with that name
      // once normalizeLabel had lowercased it.
      //
      // Refused outright rather than demoted: unlike the test-path filter below, where a lone
      // surviving candidate in a fixture tree is genuine evidence, a JavaScript call reaching a Go
      // function is not weak evidence of anything. Families, not extensions, so .mjs -> .js and
      // .ts -> .js stay -- measuring by raw suffix first said 11.6% and most of that was those.
      if (callerPath) {
        const beforeLang = targets.length;
        targets = targets.filter((id) => sameLanguageFamily(callerPath, defPathById.get(id)));
        if (!targets.length) { callCrossLanguageRefused += beforeLang; continue; }
      }

      // A private declaration is unreachable from another file. That is a language guarantee, not
      // a heuristic, and it is the one rule here that can refuse without weighing anything.
      //
      // It matters because the bare-name fallback below binds a dotted call to the ONE declaration
      // branch-wide with that member name, and stdlib member names collide with real declarations
      // constantly. Measured on apache/commons-cli: `Option.add` is `private void add(String)`,
      // and it was the target of 56 edges whose call sites are all `matches.add(...)` and
      // `list.add(...)` -- java.util.List, not Option. The single largest group in that plane.
      //
      // Only where visibility was actually EXTRACTED: 574 of commons-cli's METHOD nodes carry no
      // visibility at all, and absent is not private.
      if (callerPath) {
        const beforePriv = targets.length;
        targets = targets.filter((id) => !defPrivateById.has(id) || defPathById.get(id) === callerPath);
        if (!targets.length) { callPrivateRefused += beforePriv; continue; }
      }

      // An object-literal property function (`{ load: () => ... }`, kind=object_prop_fn) is a local
      // callback, not a declaration another file reaches by member name. The bare-name fallback
      // above binds a dotted `X.load()` to the ONE such node branch-wide, so `yaml.load()`,
      // `fs.statSync()`, `db.prepare()` and `Date.now()` all landed on unrelated CLI/config
      // properties at the EXTRACTED tier. Measured on this repository: 71 such edges, every one a
      // builtin/external member call. Refused cross-file only — a same-file `obj.method()` on a
      // local object literal is a real edge and stays.
      if (callerPath) {
        const beforeObjProp = targets.length;
        targets = targets.filter((id) => !defObjPropFnById.has(id) || defPathById.get(id) === callerPath);
        if (!targets.length) { callObjPropFnRefused += beforeObjProp; continue; }
      }

      if (!isTestPath(callerPath)) {
        const before = targets.length;
        const allBeforeTestFilter = targets;
        targets = targets.filter((id) => !isTestPath(defPathById.get(id)));
        // Refusing outright when NOTHING but a test declaration matches is deliberate. Production
        // code does not call test code, so there is no truth edge to lose; the alternative is the
        // shape that produced most of the remaining wrong targets — `this.exceptionFactory(...)`
        // is a FIELD holding a function, which is not an eligible candidate at all, so every
        // candidate was a same-named helper in some spec file and a preference had nothing to
        // prefer.
        // Exactly one declaration branch-wide, and it happens to live in a test tree, is
        // evidence — a fixture helper really is called from a fixture. Two or more is a guess
        // among test declarations, which is the shape that produced 557 of 947 wrong targets.
        if (!targets.length) {
          if (before > 1) { callTestTargetsRefused++; continue; }
          targets = allBeforeTestFilter;
        }
      }

      // A callee name that still matches many methods after class narrowing is
      // not a heuristic — emitting an edge to EVERY candidate is a cross
      // product, and it was the largest source of false structure in the graph.
      //
      // Measured on django-machina: `get` produced 2182 HEURISTIC_CALLS and
      // `post` 909, because Django gives every class-based view a `get`/`post`
      // and `.get(` in Python is usually `dict.get` or `queryset.get` anyway —
      // not a call to any of them. Fan-out per call site: 246 sites had 13+
      // candidates and accounted for 3232 of 4492 edges.
      //
      // The rest of this file already refuses in this situation
      // (resolveAndWriteEdges' pickCandidate: "more than one equally-meaningful
      // candidate survives -> no edge"). This writer was the one place that
      // guessed all of them at once. The bound matches the documented
      // global-label tie-break allowance (<=3 candidates); beyond it, refuse.
      let fanoutDemoted = false;
      if (targets.length > MAX_CALL_CANDIDATE_FANOUT) {
        if (targets.length > HEURISTIC_CALL_FANOUT_CEILING) {
          callFanoutRefused++;
          continue;
        }
        // Recorded, not traversed.
        fanoutDemoted = true;
        callFanoutDemoted++;
      }
      // The label follows match quality — a callee name that resolved to exactly one
      // candidate (branch-wide or class-qualified) is real, if not import-proven,
      // evidence; a callee name that still has multiple candidates even after
      // class-context narrowing is a guess among plausible targets, same as the ladder's
      // other ambiguous-grade strings, so it must be able to land on HEURISTIC_CALLS.
      resolution = fanoutDemoted
        ? 'call_expression_high_fanout'
        : fallbackDemoted
          ? 'call_expression_bare_name'
          : (resolution || (targets.length === 1 ? 'call_expression_unique' : 'call_expression_ambiguous'));
      const line = Number.isInteger(expr.line) ? expr.line : null;
      for (const toId of targets) {
        if (toId === caller.id) continue; // no self-edges
        const key = `${caller.id}|${toId}|CALLS`;
        // First-wins on the key, EXCEPT that a better-resolved edge displaces a worse one.
        // A demoted >3-candidate expression occupies the key too, so `save()` (5 candidates,
        // demoted) reaching the key before `petRepository.save()` (unique) would otherwise
        // leave a traversable CALLS edge written as HEURISTIC_CALLS — decided by call-expression
        // ordering, silently. Uniqueness outranks a guess whichever is seen first.
        const existing = triples.get(key);
        const better = !existing
          || (resolution === 'call_expression_unique' && existing[3] !== 'call_expression_unique');
        if (better) triples.set(key, [caller.id, toId, 'CALLS', resolution, line, rawCallee]);
      }
    }
  }

  if (!triples.size) {
    console.log(`[resolveCallExpressionEdges] branchId=${branchId} written=0 fanout_refused=${callFanoutRefused} (>${HEURISTIC_CALL_FANOUT_CEILING} candidates) fanout_demoted=${callFanoutDemoted}`);
    return 0;
  }

  const resolved = [...triples.values()];
  const CHUNK = pool.safeChunk(7);
  let written = 0;
  for (let i = 0; i < resolved.length; i += CHUNK) {
    const chunk = resolved.slice(i, i + CHUNK);
    const params = [];
    const valueClauses = chunk.map(([from, to, type, resolution, callLine, calledName]) => {
      const base = params.length;
      const derived = edgeWriteTier(resolution, type);
      const props = { resolution };
      if (Number.isInteger(callLine)) props.call_line = callLine;
      if (calledName) props.called_name = calledName;
      params.push(from, to, derived.edgeType, derived.label, JSON.stringify(props), derived.tier, derived.confidence);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    await pool.query(
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      params
    );
    written += chunk.length;
  }
  console.log(`[resolveCallExpressionEdges] branchId=${branchId} written=${written} fanout_refused=${callFanoutRefused} (>${MAX_CALL_CANDIDATE_FANOUT} candidates) test_only_targets_refused=${callTestTargetsRefused} cross_language_refused=${callCrossLanguageRefused} bare_name_demoted=${bareNameUniqueFallback} private_cross_file_refused=${callPrivateRefused} objprop_cross_file_refused=${callObjPropFnRefused} receiver_unresolved_refused=${callReceiverUnresolved}`);
  return written;
}

// GQH-6b: for each EXTENDS pair (child class → parent class), find METHOD nodes
// with DEFINED_IN edges pointing to each class. If a method name appears in both
// the child and the parent, emit an OVERRIDES edge (child-method → parent-method).
async function resolveOverrideEdges(branchId, _pool = pool) {
  // All EXTENDS edges within this branch (both ends in same branch)
  const { rows: extendsPairs } = await _pool.query(
    `SELECT e.from_node_id AS child_class_id, e.to_node_id AS parent_class_id
     FROM edges e
     JOIN nodes fn ON fn.id = e.from_node_id
     JOIN nodes tn ON tn.id = e.to_node_id
     WHERE e.edge_type IN ('EXTENDS', 'IMPLEMENTS')
       AND fn.repository_branch_id = $1
       AND tn.repository_branch_id = $1
       AND fn.approval_status != 'ARCHIVED'
       AND tn.approval_status != 'ARCHIVED'`,
    [branchId]
  );
  if (!extendsPairs.length) return 0;

  // All METHOD → CLASS (DEFINED_IN) edges in this branch
  const { rows: definedInEdges } = await _pool.query(
    `SELECT e.from_node_id AS method_id, e.to_node_id AS class_id,
            n.name AS method_name
     FROM edges e
     JOIN nodes n ON n.id = e.from_node_id
     WHERE e.edge_type = 'DEFINED_IN'
       AND n.repository_branch_id = $1
       AND n.node_type = 'METHOD'
       AND n.approval_status != 'ARCHIVED'`,
    [branchId]
  );
  if (!definedInEdges.length) return 0;

  // Build: classId → Map(methodNameLower → methodId)
  const classMethods = new Map();
  for (const row of definedInEdges) {
    if (!classMethods.has(row.class_id)) classMethods.set(row.class_id, new Map());
    classMethods.get(row.class_id).set((row.method_name || '').toLowerCase(), row.method_id);
  }

  const triples = new Map();
  for (const { child_class_id, parent_class_id } of extendsPairs) {
    const childMethods = classMethods.get(child_class_id);
    const parentMethods = classMethods.get(parent_class_id);
    if (!childMethods || !parentMethods) continue;
    for (const [name, childMethodId] of childMethods) {
      const parentMethodId = parentMethods.get(name);
      if (!parentMethodId || parentMethodId === childMethodId) continue;
      const key = `${childMethodId}|${parentMethodId}|OVERRIDES`;
      if (!triples.has(key)) triples.set(key, [childMethodId, parentMethodId, 'OVERRIDES', name]);
    }
  }

  if (!triples.size) return 0;

  const resolved = [...triples.values()];
  const CHUNK = pool.safeChunk(7);
  let written = 0;
  for (let i = 0; i < resolved.length; i += CHUNK) {
    const chunk = resolved.slice(i, i + CHUNK);
    const params = [];
    // 'override_match' (tier 2) — an EXTENDS-established child/parent pair both defining
    // a METHOD with the identical name is a structural fact, not a guess.
    const valueClauses = chunk.map(([from, to, type, methodName]) => {
      const base = params.length;
      const derived = edgeWriteTier('override_match', type);
      const props = { resolution: 'override_match' };
      if (methodName) props.called_name = methodName;
      params.push(from, to, derived.edgeType, derived.label, JSON.stringify(props), derived.tier, derived.confidence);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    await _pool.query(
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      params
    );
    written += chunk.length;
  }
  return written;
}

// Extracts the base identifier of a raw decorator/annotation string (`@my_decorator`,
// `@app.route('/x')`, `@Test`, `[Table("owners")]`) — the leading identifier token,
// stopping at the first '.', '(', or whitespace. Attribute-style decorators (`@app.route`)
// resolve on 'app', which is deliberate: an object instance, not a same-file/imported
// symbol, so it is refused rather than bound.
function decoratorBaseName(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.replace(/^@/, '').match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
  return m ? m[0] : null;
}

// Resolves each METHOD/CLASS's `properties.decorators` to a real METHOD/CLASS node.
// Two tiers only — same-file lookup (tier 2, 'same_file') then the SAME import-evidence
// proof resolveAndWriteEdges' CALLS waterfall uses (tier 3, 'import',
// resolve.js#resolveViaImportEvidence) — and refuses everything else. Deliberately does
// NOT fall through to module-stem/global-label/fuzzy name matching like
// resolveAndWriteEdges does for CALLS: those are guesses, and the rule here is "tier 2/3
// or nothing, never a dangling edge". Standalone post-tail pass (mirrors
// resolveOverrideEdges/resolveEntityTableEdges) — not routed through the generic
// pendingEdges/resolveAndWriteEdges cascade, specifically so an unresolved decorator can
// never fall through to a lower-confidence heuristic and produce an edge this rule forbids.
async function resolveDecoratedByEdges(branchId, _pool = pool) {
  const { rows: decoratedRows } = await _pool.query(
    `SELECT n.id, f.path AS file_path, json_extract(n.properties, '$.decorators') AS decorators
     FROM nodes n
     JOIN files f ON f.id = n.file_id
     WHERE n.repository_branch_id = $1 AND n.approval_status != 'ARCHIVED'
       AND n.node_type IN ('METHOD', 'CLASS')
       AND json_type(n.properties, '$.decorators') = 'array'
       AND json_array_length(n.properties, '$.decorators') > 0
     ORDER BY n.id`,
    [branchId]
  );
  if (!decoratedRows.length) return 0;

  // Same fileScopedRows shape resolveAndWriteEdges builds its fileIndex from
  // (facts.js#buildFileScopedIndex): declByFileAndName gives the same-file
  // lookup, importsByFile/resolveViaImportEvidence gives the import-evidence
  // lookup, off one branch-wide read.
  const { rows: fileScopedRows } = await _pool.query(
    `SELECT n.id, n.name, n.node_type, f.path AS file_path,
            json_extract(n.properties, '$.module') AS module, json_extract(n.properties, '$.alias') AS alias,
            n.properties AS properties
     FROM nodes n
     JOIN files f ON f.id = n.file_id
     WHERE n.repository_branch_id = $1 AND n.approval_status != 'ARCHIVED'
     ORDER BY f.path, n.id`,
    [branchId]
  );
  const fileIndex = buildFileScopedIndex(fileScopedRows);

  const resolved = [];
  for (const row of decoratedRows) {
    const decorators = Array.isArray(row.decorators) ? row.decorators : [];
    if (!decorators.length) continue;
    const byName = fileIndex.declByFileAndName.get(row.file_path);
    const seenTargets = new Set();
    for (const raw of decorators) {
      const baseName = decoratorBaseName(raw);
      if (!baseName) continue;

      let targetId = null;
      let resolution = null;
      const sameFileCandidates = (byName?.get(baseName) || [])
        .filter((c) => c.id !== row.id && (c.type === 'METHOD' || c.type === 'CLASS'));
      if (sameFileCandidates.length === 1) {
        targetId = sameFileCandidates[0].id;
        resolution = 'same_file';
      } else if (sameFileCandidates.length === 0) {
        const importHit = resolveViaImportEvidence(row.id, baseName, fileIndex);
        if (importHit) { targetId = importHit.targetId; resolution = 'import'; }
      }
      if (targetId && !seenTargets.has(targetId)) {
        seenTargets.add(targetId);
        resolved.push([row.id, targetId, resolution]);
      }
    }
  }
  if (!resolved.length) return 0;

  const CHUNK = pool.safeChunk(7);
  let written = 0;
  for (let i = 0; i < resolved.length; i += CHUNK) {
    const chunk = resolved.slice(i, i + CHUNK);
    const params = [];
    const valueClauses = chunk.map(([from, to, resolution]) => {
      const base = params.length;
      const derived = edgeWriteTier(resolution, 'DECORATED_BY');
      params.push(from, to, derived.edgeType, derived.label, JSON.stringify({ resolution }), derived.tier, derived.confidence);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    await _pool.query(
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      params
    );
    written += chunk.length;
  }
  console.log(`[resolveDecoratedByEdges] branch=${branchId} DECORATED_BY edges written=${written}`);
  return written;
}

// A method belongs to its type even when the two are written in different files.
//
// The extractors emit DEFINED_IN per FILE, so a method can only be linked to an owner declared
// beside it. That is fine for Java and Python, where the method body sits inside the class body,
// and wrong for the languages whose normal style is to separate them: Go spreads `func (v *Viper)`
// methods across every file of the package while `type Viper struct` sits in one, Rust puts `impl`
// blocks wherever it likes, C# has partial classes, Ruby reopens classes, Swift and Kotlin have
// extensions. In all of those the owner link — the single most load-bearing structural fact about
// a method — was simply absent.
//
// Measured on spf13/viper before this pass: 395 METHOD nodes, 156 with any DEFINED_IN edge, and
// **zero** whose owner lived in another file. The cost is not cosmetic. A blast-radius walk from
// `Viper.AddRemoteProvider` (remote.go) could not reach `Viper.AddConfigPath` (viper.go) at any
// depth, because nothing in the graph said both are methods of the same type — they are the
// single largest category of unreachable co-change on that repo.
//
// `parent_class` is the receiver/owner type name the CST itself produced, not an inference.
// Resolution refuses to guess when the name is ambiguous: a type name unique in the branch binds
// directly; otherwise the same directory must disambiguate it (a directory IS the package in Go,
// and is the conventional unit elsewhere); anything still ambiguous gets no edge.
async function resolveMethodOwnerEdges(branchId, _pool = pool) {
  const { rows: methodRows } = await _pool.query(
    `SELECT n.id, json_extract(n.properties, '$.parent_class') AS owner_name, f.path AS file_path
       FROM nodes n
       JOIN files f ON f.id = n.file_id
      WHERE n.repository_branch_id = $1
        AND n.node_type = 'METHOD'
        AND n.approval_status != 'ARCHIVED'
        AND coalesce(json_extract(n.properties, '$.parent_class'), '') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM edges e
           WHERE e.from_node_id = n.id AND e.edge_type = 'DEFINED_IN')`,
    [branchId]
  );
  if (!methodRows.length) return 0;

  const { rows: typeRows } = await _pool.query(
    `SELECT n.id, n.name, f.path AS file_path
       FROM nodes n
       JOIN files f ON f.id = n.file_id
      WHERE n.repository_branch_id = $1
        AND n.node_type IN ('CLASS', 'ENTITY', 'INTERFACE')
        AND n.approval_status != 'ARCHIVED'`,
    [branchId]
  );
  const byName = new Map();
  for (const t of typeRows) {
    if (!byName.has(t.name)) byName.set(t.name, []);
    byName.get(t.name).push(t);
  }

  const dirOf = (p) => (p || '').slice(0, (p || '').lastIndexOf('/') + 1);
  const pairs = [];
  let ambiguous = 0;
  for (const m of methodRows) {
    const candidates = byName.get(m.owner_name);
    if (!candidates || !candidates.length) continue;
    let target = null;
    if (candidates.length === 1) {
      target = candidates[0];
    } else {
      const sameDir = candidates.filter(c => dirOf(c.file_path) === dirOf(m.file_path));
      if (sameDir.length === 1) target = sameDir[0];
    }
    if (!target) { ambiguous++; continue; }
    if (target.id === m.id) continue;
    pairs.push([m.id, target.id]);
  }
  if (!pairs.length) {
    console.log(`[resolveMethodOwnerEdges] branchId=${branchId} candidates=${methodRows.length} written=0 ambiguous=${ambiguous}`);
    return 0;
  }

  const rowCount = await bulkWrite(_pool,
    `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, resolution_tier, properties)
     VALUES ($1, $2, 'DEFINED_IN', 'EXTRACTED', 1, json_object('resolution', 'receiver_type_cross_file'))
     ON CONFLICT DO NOTHING`,
    pairs.map((p) => [p[0], p[1]]));
  console.log(`[resolveMethodOwnerEdges] branchId=${branchId} candidates=${methodRows.length} written=${rowCount} ambiguous=${ambiguous}`);
  return rowCount;
}

// python.js's `_extraWalkPython` records
// a `metaclass=Y` keyword argument's raw name as `properties.metaclass`
// (payload only, no edge — evidence recorded at walk time, resolution
// deferred). Mirrors resolveDecoratedByEdges exactly (same two rungs, same
// fileIndex, same ON CONFLICT DO NOTHING insert shape) — the only structural
// difference is the source column is a single string
// (`json_extract(properties, '$.metaclass')`), not an array to iterate.
async function resolveMetaclassEdges(branchId, _pool = pool) {
  const { rows: metaclassRows } = await _pool.query(
    `SELECT n.id, f.path AS file_path, json_extract(n.properties, '$.metaclass') AS metaclass_name
     FROM nodes n
     JOIN files f ON f.id = n.file_id
     WHERE n.repository_branch_id = $1 AND n.approval_status != 'ARCHIVED'
       AND n.node_type = 'CLASS'
       AND json_type(n.properties, '$.metaclass') IS NOT NULL
     ORDER BY n.id`,
    [branchId]
  );
  if (!metaclassRows.length) return 0;

  const { rows: fileScopedRows } = await _pool.query(
    `SELECT n.id, n.name, n.node_type, f.path AS file_path,
            json_extract(n.properties, '$.module') AS module, json_extract(n.properties, '$.alias') AS alias,
            n.properties AS properties
     FROM nodes n
     JOIN files f ON f.id = n.file_id
     WHERE n.repository_branch_id = $1 AND n.approval_status != 'ARCHIVED'
     ORDER BY f.path, n.id`,
    [branchId]
  );
  const fileIndex = buildFileScopedIndex(fileScopedRows);

  const resolved = [];
  for (const row of metaclassRows) {
    const targetName = row.metaclass_name;
    if (!targetName) continue;
    const byName = fileIndex.declByFileAndName.get(row.file_path);
    const sameFileCandidates = (byName?.get(targetName) || [])
      .filter((c) => c.id !== row.id && c.type === 'CLASS');

    let targetId = null;
    let resolution = null;
    if (sameFileCandidates.length === 1) {
      targetId = sameFileCandidates[0].id;
      resolution = 'same_file';
    } else if (sameFileCandidates.length === 0) {
      const importHit = resolveViaImportEvidence(row.id, targetName, fileIndex);
      if (importHit) { targetId = importHit.targetId; resolution = 'import'; }
    }
    if (targetId) resolved.push([row.id, targetId, resolution]);
  }
  if (!resolved.length) return 0;

  const CHUNK = pool.safeChunk(7);
  let written = 0;
  for (let i = 0; i < resolved.length; i += CHUNK) {
    const chunk = resolved.slice(i, i + CHUNK);
    const params = [];
    const valueClauses = chunk.map(([from, to, resolution]) => {
      const base = params.length;
      const derived = edgeWriteTier(resolution, 'METACLASS');
      params.push(from, to, derived.edgeType, derived.label, JSON.stringify({ resolution }), derived.tier, derived.confidence);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    await _pool.query(
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      params
    );
    written += chunk.length;
  }
  console.log(`[resolveMetaclassEdges] branch=${branchId} METACLASS edges written=${written}`);
  return written;
}

// Declared field TYPE references (java.js#_emitFieldTypeReference's deferred path — a
// type it could not resolve to an ALREADY-REGISTERED same-file CLASS at extraction time)
// queued in `pendingTypeReferences` ({fromNodeId, toName, line}) during the per-file
// commit pass.
//
// Same-file IS retried here: java.js's own extraction-time `classByName` check only sees
// classes registered so far in a preorder walk, so a FORWARD reference within one file (a
// common shape — nothing requires the referenced class to be declared first) always
// misses there and reaches this function. Refusing it here too would silently drop a
// same-file, zero-guesswork case for no reason — same "retry same-file before import"
// shape resolveDecoratedByEdges/resolveMetaclassEdges above already establish, tier 2
// (`same_file`), stronger evidence than tier 3.
//
// Import evidence is the ONLY cross-file rung tried: REFERENCES from a declared field
// type with an import behind it = tier 3; bare-name = refuse (REFERENCES has no heuristic
// variant), no module_stem/global_label fallback, unlike CALLS' own waterfall. Tried BOTH
// ways resolveViaReceiverType's own tier-3 rung does (relative path, then
// dotted-FQN-suffix) — plain resolveViaImportEvidence alone is
// JS/Python-relative-import-shaped and structurally cannot resolve Java's `import a.b.Foo;`
// (not a `./`-relative spec).
//
// A same-package Java type with no `import` statement at all (legal Java — same-package
// types need none) is a known, deliberate gap of this scope, not a bug: resolving it
// would require a package-membership index this pass does not build, and guessing among
// same-named candidates branch-wide is exactly what this pass refuses.
async function resolveTypeReferenceEdges(pendingTypeReferences, branchId, _pool = pool) {
  if (!pendingTypeReferences.length) return 0;

  const { rows: fileScopedRows } = await _pool.query(
    `SELECT n.id, n.name, n.node_type, f.path AS file_path,
            json_extract(n.properties, '$.module') AS module, json_extract(n.properties, '$.alias') AS alias,
            n.properties AS properties
     FROM nodes n
     JOIN files f ON f.id = n.file_id
     WHERE n.repository_branch_id = $1 AND n.approval_status != 'ARCHIVED'
     ORDER BY f.path, n.id`,
    [branchId]
  );
  const fileIndex = buildFileScopedIndex(fileScopedRows);

  const resolved = [];
  const seenPairs = new Set();
  for (const tr of pendingTypeReferences) {
    if (!tr.fromNodeId || !tr.toName) continue;

    let targetId = null;
    let resolution = null;

    const fromFilePath = fileIndex.fileById.get(tr.fromNodeId);
    const sameFileCandidates = fromFilePath
      ? (fileIndex.declByFileAndName.get(fromFilePath)?.get(tr.toName) || [])
          .filter((c) => c.id !== tr.fromNodeId && c.type === 'CLASS')
      : [];
    if (sameFileCandidates.length === 1) {
      targetId = sameFileCandidates[0].id;
      resolution = 'same_file';
    } else if (sameFileCandidates.length === 0) {
      const fileImports = fromFilePath ? fileIndex.importsByFile.get(fromFilePath) : null;
      if (fromFilePath && fileImports && fileImports.length) {
        for (const imp of fileImports) {
          if (imp.name !== tr.toName && imp.alias !== tr.toName) continue;
          const targetFile = resolveRelativeImportPath(fromFilePath, imp.module || imp.name, fileIndex.knownFilePaths)
            || resolveDottedSuffixFile(`${imp.module}.${imp.name}`, fileIndex.dottedPathSuffixIndex);
          if (!targetFile) continue;
          const decls = fileIndex.declByFileAndName.get(targetFile)?.get(tr.toName);
          if (decls && decls.length === 1 && decls[0].id !== tr.fromNodeId) {
            targetId = decls[0].id;
            resolution = 'import';
            break;
          }
        }
      }
    }
    if (!targetId) continue; // bare-name / ambiguous: refuse, per the amendment — no fallback tier

    const key = `${tr.fromNodeId}->${targetId}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    resolved.push([tr.fromNodeId, targetId, resolution, tr.line ?? null]);
  }
  if (!resolved.length) return 0;

  const CHUNK = pool.safeChunk(7);
  let written = 0;
  for (let i = 0; i < resolved.length; i += CHUNK) {
    const chunk = resolved.slice(i, i + CHUNK);
    const params = [];
    const valueClauses = chunk.map(([from, to, resolution, line]) => {
      const base = params.length;
      const derived = edgeWriteTier(resolution, 'REFERENCES');
      const props = { resolution };
      // call_line lives inside `properties`, not a real DB column (writeAstEdges' own
      // `props.call_line`, mirrored here — there is no `edges.evidence_line` column).
      if (Number.isInteger(line)) props.call_line = line;
      params.push(from, to, derived.edgeType, derived.label, JSON.stringify(props), derived.tier, derived.confidence);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    await _pool.query(
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      params
    );
    written += chunk.length;
  }
  console.log(`[resolveTypeReferenceEdges] branch=${branchId} REFERENCES edges written=${written}`);
  return written;
}

// typescript.js's `_extraWalkTs` queues one {module, line} fact per
// `export {x} from './y'`-style re-export (`pendingReExports`, {fileId, refs}). This
// resolves the module spec to a real file the SAME way resolveViaImportEvidence's own
// relative-path ladder does, then writes a FILE-to-FILE RE_EXPORTS edge — unlike every
// other resolver in this file, the FROM node is a FILE (the re-exporting file itself),
// not a CLASS/METHOD, so a pure-barrel file with no CLASS/METHOD at all still gets an anchor.
async function resolveReExportEdges(pendingReExports, branchId, _pool = pool) {
  if (!pendingReExports.length) return 0;

  const { rows: fileRows } = await _pool.query(
    `SELECT f.id AS file_id, f.path FROM files f WHERE f.repository_branch_id = $1`,
    [branchId]
  );
  if (!fileRows.length) return 0;
  const pathToFileId = new Map();
  const idToPath = new Map();
  const knownFilePaths = new Set();
  for (const r of fileRows) {
    pathToFileId.set(r.path, r.file_id);
    idToPath.set(r.file_id, r.path);
    knownFilePaths.add(r.path);
  }

  const { rows: fileNodeRows } = await _pool.query(
    `SELECT n.file_id, n.id AS node_id FROM nodes n
     WHERE n.repository_branch_id = $1 AND n.node_type = 'FILE' AND n.approval_status != 'ARCHIVED'
     ORDER BY n.id ASC`,
    [branchId]
  );
  const fileIdToFileNodeId = new Map();
  for (const r of fileNodeRows) {
    if (!fileIdToFileNodeId.has(r.file_id)) fileIdToFileNodeId.set(r.file_id, r.node_id);
  }

  const triples = new Map();
  for (const { fileId, refs } of pendingReExports) {
    const fromPath = idToPath.get(fileId);
    const fromFileNodeId = fileIdToFileNodeId.get(fileId);
    if (!fromPath || !fromFileNodeId) continue;
    for (const { module: modulePath, line } of refs) {
      if (!modulePath) continue;
      const targetPath = resolveRelativeImportPath(fromPath, modulePath, knownFilePaths);
      if (!targetPath) continue; // non-relative spec (an npm package) — no file in THIS repo to link, refuse
      const targetFileId = pathToFileId.get(targetPath);
      const toFileNodeId = targetFileId !== undefined ? fileIdToFileNodeId.get(targetFileId) : undefined;
      if (!toFileNodeId || toFileNodeId === fromFileNodeId) continue;
      const key = `${fromFileNodeId}|${toFileNodeId}`;
      if (!triples.has(key)) triples.set(key, [fromFileNodeId, toFileNodeId, line ?? null]);
    }
  }
  if (!triples.size) return 0;

  const resolved = [...triples.values()];
  const CHUNK = pool.safeChunk(7);
  let written = 0;
  for (let i = 0; i < resolved.length; i += CHUNK) {
    const chunk = resolved.slice(i, i + CHUNK);
    const params = [];
    const valueClauses = chunk.map(([from, to, line]) => {
      const base = params.length;
      // A resolved relative re-export spec IS real import evidence (the same
      // resolveRelativeImportPath ladder resolveViaImportEvidence uses) —
      // 'import' (tier 3), same honesty convention writeRelativeImportEdges
      // already established for the identical evidence shape.
      const derived = edgeWriteTier('import', 'RE_EXPORTS');
      const props = { resolution: 'import' };
      if (Number.isInteger(line)) props.call_line = line;
      params.push(from, to, derived.edgeType, derived.label, JSON.stringify(props), derived.tier, derived.confidence);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    await _pool.query(
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      params
    );
    written += chunk.length;
  }
  console.log(`[resolveReExportEdges] branch=${branchId} RE_EXPORTS edges written=${written}`);
  return written;
}

async function resolveInheritedColumns(branchId, _pool = pool) {
  const { rows } = await _pool.query(
    `SELECT id, name, properties
     FROM nodes
     WHERE repository_branch_id = $1
       AND node_type IN ('CLASS', 'ENTITY')
       AND approval_status != 'ARCHIVED'`,
    [branchId]
  );

  // Build a map: className → { id, columns, extends }
  const classMap = new Map();
  for (const row of rows) {
    const props = row.properties || {};
    classMap.set(row.name, {
      id: row.id,
      columns: Array.isArray(props.columns) ? props.columns : [],
      extends: typeof props.extends === 'string' ? props.extends : null,
    });
  }

  // Collect all field-name keys used across all column objects (language-agnostic)
  function getColKey(col) {
    return col.field || col.java_field || col.column_name || col.name || null;
  }

  let updated = 0;
  for (const row of rows) {
    const props = row.properties || {};
    if (!props.extends) continue;
    if (!Array.isArray(props.columns)) continue;

    const ownKeys = new Set(props.columns.map(getColKey).filter(Boolean));
    const inherited = [];
    let ancestorName = props.extends;
    let hops = 0;

    while (ancestorName && hops < 5) {
      if (!classMap.has(ancestorName)) {
        console.warn(`[resolveInheritedColumns] branch=${branchId} entity=${row.name}: ancestor "${ancestorName}" not found in graph (external jar or unindexed module) — inherited columns from this ancestor will be missing`);
        break;
      }
      const ancestor = classMap.get(ancestorName);
      for (const col of ancestor.columns) {
        const k = getColKey(col);
        if (k && !ownKeys.has(k)) {
          ownKeys.add(k);
          inherited.push(col);
        }
      }
      ancestorName = ancestor.extends;
      hops++;
    }

    if (inherited.length === 0) continue;

    const mergedColumns = [...props.columns, ...inherited];
    await _pool.query(
      `UPDATE nodes
       SET properties = json_merge(properties, json_object('columns', $1)), last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = $2`,
      [JSON.stringify(mergedColumns), row.id]
    );
    updated++;
  }

  console.log(`[resolveInheritedColumns] branch=${branchId} updated=${updated}`);
  return updated;
}

// For each ENTITY node in the branch, resolve the actual DB table name
// using the language-priority chain (Java @Table, TypeORM @Entity, Python __tablename__,
// Django db_table, Ruby/PHP/Go tableName property, C# [Table]), upsert a DB_TABLE node,
// and write a MAPS_TO edge from ENTITY → DB_TABLE.
// ORM entity markers across the stacks the extractor covers. Kept as SQL rather than a JS filter
// so the decorator scan stays in the same query that selects the candidates.
const ENTITY_DECORATOR_PATTERNS = [
  '@Entity',        // Java JPA / Jakarta Persistence, TypeScript TypeORM
  '@Table',         // Java JPA explicit table, C# EF Core is [Table] and matched below
  '@javax.persistence.Entity',
  '@jakarta.persistence.Entity',
  '[Table',         // C# EF Core
  '__tablename__',  // Python SQLAlchemy
  'db_table',       // Django Meta
  '@@map',          // Prisma
];
const ENTITY_DECORATOR_SQL = `(${ENTITY_DECORATOR_PATTERNS
  .map((p) => `properties LIKE '%${p.replace(/'/g, "''")}%'`)
  .join(' OR ')})`;

/**
 * MAPS_TO from an entity to the table it persists to.
 *
 * 'entity_table_mapping' (tier 2) — the table name came from a real decorator/property read or the
 * documented snake_case-plural fallback, not a name guess.
 */
async function _writeEntityTableEdge(_pool, fromNodeId, dbTableId, tableName) {
  const derived = edgeWriteTier('entity_table_mapping', 'MAPS_TO');
  await _pool.query(
    `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
    [fromNodeId, dbTableId, derived.edgeType, derived.label,
     JSON.stringify({ resolution: 'entity_table_mapping', called_name: tableName }),
     derived.tier, derived.confidence]
  );
}

async function resolveEntityTableEdges(branchId, _pool = pool) {
  // CLASS nodes carrying an ORM entity decorator count as entities here. A JPA codebase
  // annotates its classes with @Entity but the extractor types them CLASS, not ENTITY, so
  // without this the entity->table link is never written and two repos over one database
  // have nothing to join through — any "what else touches this table" question silently
  // misses.
  const { rows: entityRows } = await _pool.query(
    `SELECT id, name, properties
     FROM nodes
     WHERE repository_branch_id = $1
       AND approval_status != 'ARCHIVED'
       AND (
         node_type = 'ENTITY'
         OR (node_type = 'CLASS' AND ${ENTITY_DECORATOR_SQL})
       )`,
    [branchId]
  );
  if (!entityRows.length) return 0;

  // A table is one thing per project, not one per repository. The canonical key below is
  // branch-scoped, so two repos over the same database each minted their own `owners` node and
  // MAPS_TO pointed at different targets — the bridge existed on both sides and still did not
  // close. Prefer an existing DB_TABLE anywhere in this project before creating a branch-local one.
  const { rows: projRows } = await _pool.query(
    `SELECT r.project_id FROM repository_branches rb
     JOIN repositories r ON r.id = rb.repository_id
     WHERE rb.id = $1`,
    [branchId]
  );
  const projectId = projRows[0]?.project_id ?? null;
  const projectTableByName = new Map();
  if (projectId) {
    const { rows: existing } = await _pool.query(
      `SELECT lname, id FROM (
         SELECT lower(n.name) AS lname, n.id,
                ROW_NUMBER() OVER (PARTITION BY lower(n.name) ORDER BY n.id ASC) AS _rn
         FROM nodes n
         JOIN repository_branches rb ON rb.id = n.repository_branch_id
         JOIN repositories r ON r.id = rb.repository_id
         WHERE r.project_id = $1
           AND n.node_type = 'DB_TABLE'
           AND n.approval_status != 'ARCHIVED'
       ) ranked WHERE _rn = 1`,
      [projectId]
    );
    for (const t of existing) projectTableByName.set(t.lname, t.id);
  }

  // Helper: snake_case a name (CamelCase → snake_case)
  function toSnakeCase(name) {
    return name
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .replace(/([a-z\d])([A-Z])/g, '$1_$2')
      .toLowerCase();
  }

  // Helper: naive pluralize (append s unless ends in s/x/z/ch/sh)
  function naivePlural(name) {
    if (/(?:s|x|z|ch|sh)$/.test(name)) return name + 'es';
    if (/y$/.test(name)) return name.slice(0, -1) + 'ies';
    return name + 's';
  }

  // Extract table name from entity properties using language-priority chain.
  function extractTableName(name, props) {
    const decorators = Array.isArray(props.decorators) ? props.decorators : [];

    // 1. Java Spring JPA: @Table(name = "owners") or @Table("owners")
    for (const dec of decorators) {
      const m = /@Table\s*\(\s*(?:name\s*=\s*)?["']([^"']+)["']/.exec(dec);
      if (m) return m[1];
    }

    // 2. TypeScript TypeORM: @Entity('tableName') — explicit arg
    for (const dec of decorators) {
      const m = /@Entity\s*\(\s*["']([^"']+)["']/.exec(dec);
      if (m) return m[1];
    }

    // 3. Prisma @@map, Python SQLAlchemy __tablename__, Django Meta.db_table,
    //    Ruby ActiveRecord, PHP Eloquent, Go GORM — all stored in properties.tableName
    if (typeof props.tableName === 'string' && props.tableName.trim()) {
      return props.tableName.trim();
    }

    // 4. Django: class Meta: db_table
    if (typeof props.dbTable === 'string' && props.dbTable.trim()) {
      return props.dbTable.trim();
    }

    // 5. C# EF Core: [Table("owners")]
    for (const dec of decorators) {
      const m = /\[Table\s*\(\s*["']([^"']+)["']/.exec(dec);
      if (m) return m[1];
    }

    // Fallback: snake_case plural of entity name
    return naivePlural(toSnakeCase(name));
  }

  let written = 0;
  for (const row of entityRows) {
    const props = row.properties || {};
    const tableName = extractTableName(row.name, props);
    if (!tableName) continue;

    // Reuse the project's existing node for this table if there is one, so every repo's entity
    // maps to the same target and `Owner`(repo A) -> `owners` <- `Owner`(repo B) is traversable.
    const sharedId = projectTableByName.get(tableName.toLowerCase());
    if (sharedId) {
      await _writeEntityTableEdge(_pool, row.id, sharedId, tableName);
      written++;
      continue;
    }

    // Upsert DB_TABLE node — use same canonical key pattern as ingest-helpers.js
    const canonicalKey = `${branchId}::dbt::${tableName.toLowerCase()}`;
    const { rows: dbTableRows } = await _pool.query(
      `INSERT INTO nodes
         (repository_branch_id, node_type, name, summary, confidence, confidence_tier, approval_status, canonical_key)
       VALUES ($1, 'DB_TABLE', $2, $3, 1.0, 'EXTRACTED', 'APPROVED', $4)
       ON CONFLICT (canonical_key)
         WHERE canonical_key IS NOT NULL
           AND repository_branch_id IS NOT NULL
           AND approval_status != 'ARCHIVED'
       DO UPDATE SET last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       RETURNING id`,
      [branchId, tableName, `Database table ${tableName}`, canonicalKey]
    );
    const dbTableId = dbTableRows[0]?.id;
    if (!dbTableId) continue;

    // Write MAPS_TO edge from ENTITY → DB_TABLE. 'entity_table_mapping' (tier 2) — the
    // table name came from a real decorator/property read (or the documented fallback),
    // not a guess.
    await _writeEntityTableEdge(_pool, row.id, dbTableId, tableName);
    // Newly created, so later entities in this same pass reuse it instead of racing a duplicate.
    projectTableByName.set(tableName.toLowerCase(), dbTableId);
    written++;
  }

  console.log(`[resolveEntityTableEdges] branch=${branchId} MAPS_TO edges written=${written}`);
  return written;
}

// GQH-11b: For each METHOD node in the branch whose summary/raw_evidence or
// LLM-extracted http_calls contains HTTP client patterns (axios, fetch,
// RestTemplate, requests, HttpClient, http.Get/Post), extract the HTTP method +
// path and match against ENDPOINT nodes in the same project.
// Emits CALLS edges (confidence INFERRED) from the METHOD to the ENDPOINT.
async function resolveHttpClientEdges(branchId, projectId, _pool = pool) {
  // HTTP client patterns that indicate an outbound HTTP call is present.
  // Match against summary + raw_evidence (text scan).
  const HTTP_CLIENT_RE = /\b(?:axios|fetch|RestTemplate|WebClient|FeignClient|requests\s*\.\s*(?:get|post|put|delete|patch)|http\s*\.\s*(?:Get|Post|Put|Delete)|HttpClient|Alamofire|URLSession|okhttp|retrofit)\b/i;

  // HTTP verb + path extractor — captures patterns like:
  //   axios.get('/api/users')  →  GET /api/users
  //   fetch('/api/v1/login', { method: 'POST' }) — path only
  //   restTemplate.postForObject("/owners", ...)  →  POST /owners
  //   http.Get("http://host/api/v1/owners")  →  GET /api/v1/owners
  // Group 1: optional HTTP verb hint; Group 2: URL path (relative or absolute).
  const URL_PATH_RE = /(?:(GET|POST|PUT|DELETE|PATCH|get|post|put|delete|patch)\s*[,('"]\s*|['"(])(\/?(?:api|v\d|\/)[^\s'")\]}>]*|https?:\/\/[^\s'")\]}>]+)/g;
  const VERB_FROM_METHOD_RE = /\.(get|post|put|delete|patch|getForObject|postForObject|exchange|execute)\s*\(/gi;

  // Fetch METHOD nodes with text that suggests HTTP client usage — PROJECT-wide, not just the
  // branch that just finished ingesting. A caller-side query scoped to `branchId` only ever
  // finds a match when the CALLING repo happens to be ingested after the repo it targets already
  // has the ENDPOINT written — order-dependent and usually wrong for a fresh multi-repo ingest
  // (`ingest gateway worker` ingests the caller first). endpointNodes below is already
  // project-scoped for exactly this reason; callerNodes now matches it, so this pass is
  // order-independent like resolveProjectCrossRepoEdges.
  const { rows: callerNodes } = await _pool.query(
    `SELECT n.id, n.name, r.id AS repo_id,
            COALESCE(n.summary, '') || ' ' || COALESCE(n.raw_evidence, '') AS text_body,
            json_extract(n.properties, '$.http_calls') AS http_calls,
            json_extract(n.properties, '$.callExpressions') AS call_exprs
     FROM nodes n
     JOIN repository_branches rb ON rb.id = n.repository_branch_id
     JOIN repositories r ON r.id = rb.repository_id
     WHERE r.project_id = $1
       AND rb.branch_role = 'PRODUCTION'
       AND n.approval_status != 'ARCHIVED'
       AND (
         regexp_i('\\m(axios|fetch|RestTemplate|WebClient|requests\\.(?:get|post|put|delete|patch)|http\\.(?:Get|Post|Put|Delete)|HttpClient|Alamofire|URLSession)\\M', COALESCE(n.summary, '') || COALESCE(n.raw_evidence, ''))
         OR json_type(n.properties, '$.http_calls') IS NOT NULL
         OR (n.properties IS NOT NULL AND json_type(n.properties, '$.callExpressions') IS NOT NULL AND EXISTS (
           SELECT 1 FROM json_each(n.properties, '$.callExpressions') ce
           WHERE json_extract(ce.value, '$.httpTarget') IS NOT NULL
         ))
       )`,
    [projectId]
  );
  if (!callerNodes.length) return 0;

  // Load ENDPOINT nodes from default branches only — avoids matching stale feature/release branches.
  const { rows: endpointNodes } = await _pool.query(
    `SELECT n.id, n.name, r.id AS repo_id
     FROM nodes n
     JOIN repository_branches rb ON rb.id = n.repository_branch_id
     JOIN repositories r ON r.id = rb.repository_id
     WHERE r.project_id = $1
       AND n.node_type = 'ENDPOINT'
       AND n.approval_status != 'ARCHIVED'
       AND rb.branch_role = 'PRODUCTION'`,
    [projectId]
  );
  if (!endpointNodes.length) return 0;

  // Repo of every node this pass can touch, on either side of an edge — the sole purpose is
  // deciding is_cross_repo per edge (this pass matches both a same-repo self-call and a genuine
  // cross-repo one, unlike cross-repo-edge-resolver.js's dedicated pass, which is cross-repo by
  // construction and can hardcode the flag).
  const repoByNodeId = new Map();
  for (const n of callerNodes) repoByNodeId.set(n.id, n.repo_id);
  for (const ep of endpointNodes) repoByNodeId.set(ep.id, ep.repo_id);

  // Build lookup: "VERB /path" → endpointId (lowercase both parts for matching)
  const endpointByKey = new Map();  // "get /api/users" → id
  const endpointByPath = new Map(); // "/api/users" → id (verb-free fallback)
  for (const ep of endpointNodes) {
    const parts = ep.name.split(' ');
    if (parts.length >= 2) {
      const verb = parts[0].toLowerCase();
      const epPath = parts.slice(1).join(' ').toLowerCase();
      endpointByKey.set(`${verb} ${epPath}`, ep.id);
      if (!endpointByPath.has(epPath)) endpointByPath.set(epPath, ep.id);
    }
  }

  const triples = new Map();

  for (const node of callerNodes) {
    // 1. LLM-extracted http_calls: [{ method, url_pattern }] or [{ verb, target }]
    if (Array.isArray(node.http_calls)) {
      for (const hc of node.http_calls) {
        const verb = (hc.method || hc.verb || '').toLowerCase();
        const rawUrl = hc.url_pattern || hc.target || hc.url || '';
        if (!rawUrl) continue;
        const urlPath = _extractPath(rawUrl);
        if (!urlPath) continue;
        const epId = (verb && endpointByKey.get(`${verb} ${urlPath}`)) || endpointByPath.get(urlPath);
        if (epId && epId !== node.id) {
          triples.set(`${node.id}|${epId}|CALLS`, [node.id, epId, 'CALLS', verb ? `${verb} ${urlPath}` : urlPath]);
        }
      }
    }

    // 2b. Structural call-expression hints — ast-extractor.js#_httpCallHint tags a
    // callExpressions entry with httpTarget/httpVerb when the call matches a known HTTP-client
    // shape AND a URL/path literal sits on that call's own source line. Zero LLM: this is the
    // exact material path 2's text scan was designed for, captured at extraction time instead
    // of relying on raw_evidence (which the structural plane never populates — path 2 below is
    // effectively unreachable on a purely structural graph).
    if (Array.isArray(node.call_exprs)) {
      for (const ce of node.call_exprs) {
        if (!ce || !ce.httpTarget) continue;
        const urlPath = _extractPath(ce.httpTarget);
        if (!urlPath) continue;
        const verb = (ce.httpVerb || '').toLowerCase();
        const epId = (verb && endpointByKey.get(`${verb} ${urlPath}`)) || endpointByPath.get(urlPath);
        if (epId && epId !== node.id) {
          triples.set(`${node.id}|${epId}|CALLS`, [node.id, epId, 'CALLS', verb ? `${verb} ${urlPath}` : urlPath]);
        }
      }
    }

    // 2. Text scan of summary + raw_evidence
    const text = node.text_body || '';
    if (!HTTP_CLIENT_RE.test(text)) continue;

    // Extract verb from call patterns (e.g. .get( .post( .postForObject( restTemplate.exchange)
    const verbsInText = new Set();
    VERB_FROM_METHOD_RE.lastIndex = 0;
    let vm;
    while ((vm = VERB_FROM_METHOD_RE.exec(text)) !== null) {
      const v = vm[1].toLowerCase();
      const normalized = v.startsWith('get') ? 'get' : v.startsWith('post') ? 'post' : v.startsWith('put') ? 'put' : v.startsWith('delete') ? 'delete' : v.startsWith('patch') ? 'patch' : v.startsWith('exchange') ? null : null;
      if (normalized) verbsInText.add(normalized);
    }

    URL_PATH_RE.lastIndex = 0;
    let m;
    while ((m = URL_PATH_RE.exec(text)) !== null) {
      const verbHint = (m[1] || '').toLowerCase();
      let urlPath = _extractPath(m[2]);
      if (!urlPath) continue;

      // Try: explicit verb hint first, then any verb found in the same text
      const candidates = new Set();
      if (verbHint) candidates.add(verbHint);
      for (const v of verbsInText) candidates.add(v);

      let matched = false;
      for (const v of candidates) {
        const epId = endpointByKey.get(`${v} ${urlPath}`);
        if (epId && epId !== node.id) {
          triples.set(`${node.id}|${epId}|CALLS`, [node.id, epId, 'CALLS', `${v} ${urlPath}`]);
          matched = true;
          break;
        }
      }
      // Verb-free fallback
      if (!matched) {
        const epId = endpointByPath.get(urlPath);
        if (epId && epId !== node.id) {
          triples.set(`${node.id}|${epId}|CALLS`, [node.id, epId, 'CALLS', urlPath]);
        }
      }
    }
  }

  if (!triples.size) return 0;

  const resolved = [...triples.values()];
  const CHUNK = pool.safeChunk(8);
  let written = 0;
  for (let i = 0; i < resolved.length; i += CHUNK) {
    const chunk = resolved.slice(i, i + CHUNK);
    const params = [];
    // 'http_client_match' (tier 7), whether the match came from an exact verb+path key
    // or the verb-free path-only fallback (neither is import/uniqueness-proven, so both
    // stay in the same band).
    const valueClauses = chunk.map(([from, to, type, calledName]) => {
      const base = params.length;
      const derived = edgeWriteTier('http_client_match', type);
      const props = { resolution: 'http_client_match' };
      if (calledName) props.called_name = calledName;
      // This pass matches a service calling ITS OWN endpoint just as readily as another repo's —
      // the flag has to be computed per edge, not assumed either way.
      const isCrossRepo = repoByNodeId.get(from) !== repoByNodeId.get(to) ? 1 : 0;
      params.push(from, to, derived.edgeType, derived.label, isCrossRepo, JSON.stringify(props), derived.tier, derived.confidence);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
    });
    await _pool.query(
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, is_cross_repo, properties, resolution_tier, confidence)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      params
    );
    written += chunk.length;
  }
  return written;
}

// Extract a normalised /path from a URL string (strips host, query, fragment).
function _extractPath(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let u = rawUrl.trim().replace(/['"]/g, '');
  // Strip protocol + host: http://host/path → /path
  const hostMatch = u.match(/^https?:\/\/[^/]+(\/.+)/);
  if (hostMatch) u = hostMatch[1];
  // Must start with / to be an absolute path
  if (!u.startsWith('/')) return null;
  // Strip query string and fragment
  u = u.split('?')[0].split('#')[0].toLowerCase().replace(/\/$/, '');
  if (!u || u === '/') return null;
  return u;
}

// ─── Job state helpers ────────────────────────────────────────────────────────

async function updateJob(jobId, fields) {
  if (!jobId) return;
  const sets = Object.keys(fields).map((k, i) => `${k} = $${i + 2}`).join(', ');
  await pool.query(
    `UPDATE ingest_jobs SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1`,
    [jobId, ...Object.values(fields)]
  );
}

// ─── Coverage manifest persistence (per-file, auditable) ──────────────────────

async function persistCoverageFiles(jobId, branchId, manifest) {
  if (!jobId || !manifest) return;
  await pool.query('DELETE FROM ingest_coverage_files WHERE job_id = $1', [jobId]);
  const rows = [
    ...(manifest.skipped_files || []).map((f) => ({
      path: f.path,
      tier: f.tier || 'record_only',
      reason: f.reason || null,
      bytes: f.bytes ?? null,
    })),
    ...(manifest.included_files || []).map((f) => ({
      path: f.path,
      tier: f.tier || 'pending',
      reason: null,
      bytes: f.bytes ?? null,
    })),
  ];
  if (!rows.length) return;

  const CHUNK = pool.safeChunk(6);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((r, idx) => {
      const base = idx * 6;
      values.push(jobId, branchId ?? null, r.path, r.tier, r.reason, r.bytes);
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`;
    }).join(',');
    await pool.query(
      `INSERT INTO ingest_coverage_files (job_id, repository_branch_id, path, tier, reason, bytes)
       VALUES ${placeholders}`,
      values
    );
  }
}

// Updates a single per-file coverage row once a later tier (generic_ast, presence,
// contract_*) resolves it beyond the initial 'pending'/'record_only' assignment.
// COALESCE, not assignment: a policy-skip row already carries a real reason from
// persistCoverageFiles ('generated', 'oversize', ...) and must keep it. This only
// fills rows the extraction path left NULL (M43).
async function updateCoverageFileTier(jobId, relPath, tier, nodeCount = 0, reason = null) {
  if (!jobId) return;
  await pool.query(
    `UPDATE ingest_coverage_files
        SET tier = $3, node_count = $4, reason = COALESCE(reason, $5)
     WHERE job_id = $1 AND path = $2`,
    [jobId, relPath, tier, nodeCount, reason]
  );
}

// Bulk variant — moves every path in relPaths from 'pending' to `tier` in one statement,
// for a pass that leaves rows 'pending' because node counts aren't known per-file until
// the per-file loop finishes.
async function updateCoverageFileTierBulk(jobId, relPaths, tier) {
  if (!jobId || !relPaths || relPaths.length === 0) return;
  await pool.query(
    `UPDATE ingest_coverage_files SET tier = $3
     WHERE job_id = $1 AND path IN (SELECT value FROM json_each($2))`,
    [jobId, relPaths, tier]
  );
}

const FLOOR_ELIGIBLE_SKIP_REASONS = new Set([
  SKIP_REASONS.GENERATED,
  SKIP_REASONS.STORY,
  SKIP_REASONS.E2E,
  SKIP_REASONS.TOOLING_CONFIG,
  SKIP_REASONS.TEST_NON_SOURCE,
  SKIP_REASONS.NOT_IN_INCLUDE,
  SKIP_REASONS.EXCLUDE_GLOB,
  SKIP_REASONS.OVERSIZE,
]);
const LFS_POINTER_SIGNATURE = 'version https://git-lfs';

// ENG0c pure decision function — given a file's raw content, decide the presence-floor
// node's summary/properties. No I/O, no DB: kept side-effect-free so the edge-case
// handling (empty / LFS pointer / non-UTF8 / oversize note) is unit-testable without a
// live ingest. `oversize`/`oversizeBytes` come from the OVERSIZE skip-reason candidate.
function computeFloorPresentation(content, { oversize = false, oversizeBytes = null, rawByteLength = null } = {}) {
  if (!content || !content.trim()) {
    return { empty: true, summary: 'empty file', raw_evidence: null, properties: { floor_reason: 'empty' } };
  }
  if (content.startsWith(LFS_POINTER_SIGNATURE)) {
    const sizeMatch = content.match(/^size (\d+)/m);
    return {
      empty: false,
      summary: `LFS pointer — content not fetched (${sizeMatch ? sizeMatch[1] : 'unknown'} bytes upstream)`,
      raw_evidence: null,
      properties: { lfs_pointer: true, floor_reason: 'lfs_pointer' },
    };
  }
  const firstLine = content.split('\n').find((l) => l.trim().length > 0) || '';
  let summary = firstLine.trim().slice(0, 200);
  const properties = {};
  if (content.includes('�')) {
    properties.encoding = 'non-utf8';
  }
  if (oversize) {
    summary = `${summary} (file exceeds size limit — ${oversizeBytes || rawByteLength || 'unknown'} bytes, not indexed)`.slice(0, 300);
    properties.floor_reason = 'oversize';
  }
  return { empty: false, summary, raw_evidence: content.slice(0, MAX_BYTES), properties };
}

function floorCoverageReason(presentation) {
  const props = presentation?.properties || {};
  if (props.floor_reason) return props.floor_reason;
  if (props.encoding === 'non-utf8') return 'decode_failure';
  return 'no_symbols_found';
}

// Binary files are recorded (reason=binary) but otherwise never get a `files`/`nodes`
// row: the classifier never runs on them (walk skips them before classification), so they
// are invisible to any name-shaped query. Pure helper mirrors computeFloorPresentation's
// shape: no I/O, unit-testable without a live ingest. No content pretense — raw_evidence
// stays null; the summary states the honest binary fact (extension + human size) and
// nothing else.
function formatByteSize(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function computeBinaryStubPresentation(relPath, sizeBytes) {
  const rawExt = path.extname(relPath).toLowerCase();
  const ext = rawExt ? rawExt.replace(/^\./, '') : (path.basename(relPath).toLowerCase() || 'unknown');
  const sizeLabel = formatByteSize(sizeBytes);
  return {
    summary: `binary asset (${ext || 'unknown'}, ${sizeLabel})`,
    raw_evidence: null,
    properties: { binary: true },
  };
}

// counters.parseFailures counts every JSON-parse failure, but a file can fail parsing and
// still keep its AST-derived structural nodes (buildAstNodes runs independently of the
// extraction JSON in extractIngestFile), so labeling the raw counter "(lost)" would claim
// total loss for files that kept AST coverage. counters.degradedFiles (isDegraded:
// zeroExtractedNodes && parseFailed && !hasAstCoverage) is the true "fully lost" subset
// and is always <= counters.parseFailures, so the difference is exactly the AST-rescued
// count — no new counter needed, just honest wording of the existing ones.
function formatParseFailureClause(counters) {
  const total = counters.parseFailures || 0;
  const trulyLost = counters.degradedFiles || 0;
  const astRescued = Math.max(0, total - trulyLost);
  const sample = (counters.parseFailureSample || []).join(', ');
  const text = astRescued > 0
    ? `; ${total} file(s) failed LLM semantic extraction JSON parsing (${astRescued} kept AST-derived structural nodes — not lost; ${trulyLost} fully lost with zero nodes, see DEGRADED_FILES): ${sample}`
    : `; ${total} file(s) produced unparseable extraction JSON (fully lost, no AST fallback): ${sample}`;
  return { text, trulyLost, astRescued };
}

// After every tier has resolved node counts for a job, find the text files that still
// ended at zero nodes — legitimate zero-symbol outcomes (package-info.java) AND terminal
// parse failures. Runs after backfillLlmSemanticNodeCounts so those counts are exact, and
// before contract/generic-ast rows would otherwise be mistaken for uncovered.
async function findZeroNodeExtractedFiles(jobId) {
  if (!jobId) return [];
  const { rows } = await pool.query(
    `SELECT path, tier FROM ingest_coverage_files
     WHERE job_id = $1
       AND tier IN ('llm_semantic', 'generic_ast', 'contract_sql', 'contract_openapi', 'contract_config')
       AND node_count = 0`,
    [jobId]
  );
  return rows;
}

// Decide each extractable file's coverage tier from what its own nodes record, not from a
// process-wide flag. `llm_semantic` requires at least one live node stamped with the `llm`
// plane; everything else is honest `generic_ast` with a reason. Scoped to the paths this
// pass just processed, so it never relabels a file another tier (contract_sql, doc,
// presence_floor) already claimed.
async function resolveExtractionTiers(jobId, branchId, relPaths, llmOutcomeByPath) {
  if (!jobId || !branchId || !relPaths || relPaths.length === 0) return;
  await pool.query(
    `UPDATE ingest_coverage_files AS cf SET tier = CASE WHEN sub.llm_nodes > 0 THEN 'llm_semantic' ELSE 'generic_ast' END
       FROM (
         SELECT f.path,
                -- extraction_source is a bare string until writeNode's json_merge_arrays union
                -- turns it into an array; json_each covers both shapes, as jsonb @> did.
                COUNT(*) FILTER (
                  WHERE n.approval_status <> 'ARCHIVED'
                    AND EXISTS (
                      SELECT 1 FROM json_each(n.properties, '$.extraction_source') es
                       WHERE es.value = 'llm'
                    )
                ) AS llm_nodes
           FROM files f
           LEFT JOIN nodes n ON n.file_id = f.id AND n.repository_branch_id = $2
          WHERE f.repository_branch_id = $2
          GROUP BY f.path
       ) sub
      WHERE cf.job_id = $1 AND cf.path = sub.path AND cf.path IN (SELECT value FROM json_each($3))`,
    [jobId, branchId, relPaths]
  );

  const byOutcome = new Map();
  for (const [relPath, outcome] of llmOutcomeByPath) {
    if (!byOutcome.has(outcome)) byOutcome.set(outcome, []);
    byOutcome.get(outcome).push(relPath);
  }
  for (const [outcome, paths] of byOutcome) {
    await pool.query(
      `UPDATE ingest_coverage_files SET reason = COALESCE(reason, $3)
        WHERE job_id = $1 AND path IN (SELECT value FROM json_each($2))`,
      [jobId, paths, outcome]
    );
  }
}

// Backfill node_count for the LLM-semantic tier. The bulk tier update above cannot
// carry per-file counts (the concurrent extraction loop commits nodes by file_id,
// not path), so those rows would otherwise report 0 nodes while the graph holds the
// real counts — defeating the coverage table's "how many nodes per file" purpose.
// Runs after the LLM pass and before later tiers write, so counting all branch nodes
// per file is exact; the tier='llm_semantic' filter keeps generic_ast/presence/
// contract counts (already correct) untouched.
async function backfillLlmSemanticNodeCounts(jobId, branchId) {
  if (!jobId || !branchId) return;
  await pool.query(
    `UPDATE ingest_coverage_files AS cf SET node_count = sub.cnt
     FROM (
       SELECT f.path, COUNT(n.id) AS cnt
       FROM files f
       JOIN nodes n
         ON n.file_id = f.id AND n.repository_branch_id = $2
       WHERE f.repository_branch_id = $2
       GROUP BY f.path
     ) sub
     WHERE cf.job_id = $1 AND cf.tier = 'llm_semantic' AND cf.path = sub.path`,
    [jobId, branchId]
  );
}

// ENG0g/GATE-0: node_count for the non-llm_semantic tiers was whatever the extractor *claimed*
// (contract_sql wrote `tables.length`) and was never reconciled against what actually survived
// the write. Two mechanisms leave a file with a non-zero claimed count but zero live nodes, so
// the floor pass below skipped it and the file was invisible to every name-shaped query while
// the manifest still read "covered":
//   (1) canonical-key dedupe — DB_TABLE keys on branch+name only (ingest-helpers.js
//       computeCanonicalKey), so `owners` in db/postgres/schema.sql collapses into the identical
//       node from db/mysql/schema.sql and the postgres file is left holding none of its own;
//   (2) generation churn — a re-ingest archives the prior generation's node without writing a
//       replacement, leaving only an ARCHIVED row, which the llm_semantic backfill still counted
//       because it has no approval_status filter.
// Runs after every tier has written (unlike the llm_semantic backfill above, which must run
// mid-pipeline), so counting live nodes here is accurate for all of them.
async function reconcileCoverageNodeCounts(jobId, branchId) {
  if (!jobId || !branchId) return;
  await pool.query(
    `UPDATE ingest_coverage_files AS cf SET node_count = COALESCE(sub.cnt, 0)
     FROM (
       SELECT f.path, COUNT(n.id) AS cnt
       FROM files f
       LEFT JOIN nodes n
         ON n.file_id = f.id
        AND n.repository_branch_id = $2
        AND n.approval_status <> 'ARCHIVED'
       WHERE f.repository_branch_id = $2
       GROUP BY f.path
     ) sub
     WHERE cf.job_id = $1
       AND cf.tier IN ('llm_semantic', 'generic_ast', 'contract_sql', 'contract_openapi', 'contract_config')
       AND cf.path = sub.path`,
    [jobId, branchId]
  );

  // The tier goes stale the same way the count did. A file floored on an earlier run keeps its
  // live floor node, so the floor pass below correctly does not re-floor it — but its tier stays
  // at whatever the extraction pass set, leaving the manifest claiming 'llm_semantic' for a file
  // whose only content is a filename stub. That misreports the file AND lets it be counted as
  // comprehension. Reconcile the label to match what the file actually holds.
  await pool.query(
    `UPDATE ingest_coverage_files AS cf SET tier = 'presence_floor'
     WHERE cf.job_id = $1
       AND cf.tier IN ('llm_semantic', 'generic_ast', 'contract_sql', 'contract_openapi', 'contract_config')
       AND cf.node_count > 0
       AND NOT EXISTS (
         SELECT 1
         FROM files f
         JOIN nodes n ON n.file_id = f.id
         WHERE f.repository_branch_id = $2
           AND f.path = cf.path
           AND n.approval_status <> 'ARCHIVED'
           AND COALESCE(
                 json_extract(n.properties, '$.extraction_source'),
                 json_extract(n.properties, '$.provenance'),
                 ''
               ) NOT IN ('presence_floor', 'binary_stub')
       )`,
    [jobId, branchId]
  );
}

async function completeIngestJob({
  jobId,
  projectId,
  branchId,
  repoId,
  filesExtractable,
  semanticFilesSeen,
  counters,
  tailResult,
  touchedFileIds,
  ingestGenerationId,
  beforeSnapshot = null,
  resetIntent = false,
}) {
  // A jobId-less run (test harnesses, scripted re-ingests) still created a generation and still
  // re-stamped every node and chunk onto it. Returning early left that generation VALIDATING
  // forever while the branch's ACTIVE generation kept a pointer to rows nothing writes anymore —
  // i.e. retrieval silently collapsed to whatever few rows the stale generation still owned.
  // Resolve the generation regardless; only the ingest_jobs bookkeeping needs a jobId.
  if (!jobId) {
    if (ingestGenerationId) {
      if (Array.isArray(touchedFileIds)) {
        const { carryForwardGenerationMembership } = require('./changed-file-replacement');
        await carryForwardGenerationMembership({
          branchId,
          generationId: ingestGenerationId,
          touchedFileIds,
        });
      }
      await activateGeneration(ingestGenerationId);
    }
    return null;
  }
  const result = await finalizeIngestJob({
    jobId,
    projectId,
    branchId,
    repoId,
    metrics: {
      filesExtractable,
      semanticFilesSeen: semanticFilesSeen ?? filesExtractable,
      nodesWritten: counters.nodes,
      parseFailures: counters.parseFailures,
      extractionErrors: counters.errors || 0,
      degradedFiles: counters.degradedFiles || 0,
      sourceCacheFailures: counters.sourceCacheFailures || 0,
      unresolvedEdgeCount: tailResult.unresolvedEdgeCount || tailResult.unresolvedEdges?.length || 0,
      degradedPasses: tailResult.degradedPasses || [],
      carryForwardTouchedFileIds: touchedFileIds,
    },
    activateGenerationId: ingestGenerationId,
    beforeNodeCount: beforeSnapshot ? beforeSnapshot.nodeCount : null,
    beforeEdgeCount: beforeSnapshot ? beforeSnapshot.edgeCount : null,
    resetIntent,
    jobFields: {
      files_done: counters.done,
      nodes_written: counters.nodes,
      edges_refused_ambiguous: tailResult.edgesRefusedAmbiguous || 0,
    },
  });

  // A job that saw extractable files but wrote zero nodes must never
  // read as anything but visibly broken. evaluateIngestGates' mandatory-extraction gate
  // already keeps this out of COMPLETE (it recommends FAILED), but a bare FAILED reads
  // identically to "the run threw mid-ingest" to classifyJobHealth's consumers, losing
  // the specific "extraction ran, produced nothing" signal. Tag it DEGRADED with an
  // explicit, honest reason instead of leaving that distinction unrecorded.
  if (filesExtractable > 0 && counters.nodes === 0) {
    await updateJob(jobId, {
      status: 'DEGRADED',
      degraded_modalities: JSON.stringify(
        Array.from(new Set([...(result?.degradedModalities || []), 'zero_nodes']))
      ),
    });
  }

  return result;
}

// ─── Main ingest runner ───────────────────────────────────────────────────────

async function runIngest(opts) {
  try {
    return await _runIngestImpl(opts);
  } catch (err) {
    await updateJob(opts.jobId, {
      status: 'FAILED',
      error_msg: err.message.slice(0, 2000),
      nodes_written: 0,
    }).catch(() => {});
    throw err;
  }
}

async function quarantineFailedGeneration(generationId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      // Read then write inside one transaction, one writer (SQLite has no FOR UPDATE).
      `SELECT id, file_id FROM nodes
        WHERE ingest_generation_id = $1 AND approval_status != 'ARCHIVED'`,
      [generationId],
    );
    const nodeIds = rows.map((row) => row.id);
    const fileIds = [...new Set(rows.map((row) => row.file_id).filter(Number.isFinite))];
    if (nodeIds.length > 0) {
      await client.query(
        'DELETE FROM edges WHERE from_node_id IN (SELECT value FROM json_each($1)) OR to_node_id IN (SELECT value FROM json_each($1))',
        [nodeIds],
      );
      await client.query(
        `UPDATE nodes
            SET approval_status = 'ARCHIVED', last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id IN (SELECT value FROM json_each($1))`,
        [nodeIds],
      );
    }
    if (fileIds.length > 0) {
      await client.query(
        `UPDATE files
            SET index_status = 'FAILED', last_indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id IN (SELECT value FROM json_each($1))`,
        [fileIds],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function _runIngestImpl({ repoPath, projectId, repoName, stack, branch, sourceUrl, jobId = null, limit = Infinity, _isSubPackage = false, _skipMethodTextIndex = false, deferCoChange = false }) {
  // BUG-10: there was no phase timing anywhere in the ingest, which is why nobody could say
  // whether ingest wall time is writes, edge resolution or the post-tail. Five marks, one line.
  const phaseClock = Date.now();
  let phaseMark = phaseClock;
  const phases = {};
  const markPhase = (name) => {
    const now = Date.now();
    phases[name] = +((now - phaseMark) / 1000).toFixed(2);
    phaseMark = now;
  };

  const resolvedPath = path.resolve(repoPath);
  await awaitTreeSitterReady();

  const workspaceLayout = (!_isSubPackage) ? resolveWorkspaceLayout(resolvedPath) : null;

  // Fail loud on a branch mismatch instead of silently ingesting the wrong ref.
  // cloneRepo() never passes --branch (it always clones the remote's HEAD/default
  // branch), so checkedOutBranch below is the true default resolved from the
  // remote — never a hardcoded 'main' guess. null here only ever means "not a git
  // checkout" (zip/archive extraction), in which case there is nothing to compare.
  // Scoped to real remote clones (sourceUrl is an http(s)/git@ URL) — local/zip
  // ingests and test fixtures legitimately use `branch` as an arbitrary row label
  // with no corresponding real git ref to compare against.
  const checkedOutBranch = gitBranch(resolvedPath);
  const isRemoteCloneSource = typeof sourceUrl === 'string' && /^(https?:\/\/|git@)/i.test(sourceUrl);
  if (isRemoteCloneSource && branch && checkedOutBranch && branch !== checkedOutBranch) {
    throw new Error(
      `Requested branch '${branch}' but the repository's actual default branch is ` +
      `'${checkedOutBranch}'. Retry with branch=${checkedOutBranch}, or omit branch to use the repo default.`
    );
  }
  const detectedBranch = branch || checkedOutBranch || 'main';
  const commitSha = gitSha(resolvedPath);

  const ingestPolicy = loadIngestPolicy(resolvedPath);
  const walkResult = walkRepoWithPolicy(resolvedPath, { policy: ingestPolicy });
  const allFiles = walkResult.files.map((f) => ({
    rel: f.rel,
    full: f.full,
    chunked: !!f.chunked,
    sizeBytes: f.sizeBytes,
  }));
  const policyCoverageManifest = buildPolicyCoverageManifest(walkResult);
  const oversizeSkips = walkResult.skipped
    .filter((entry) => entry.reason === SKIP_REASONS.OVERSIZE)
    .map((entry) => ({ path: entry.path, bytes: entry.bytes }));
  const filePaths  = allFiles.map(f => f.rel);
  let resolvedStack = (stack && stack !== 'AUTO') ? stack : detectRepoType(filePaths);
  if (!resolvedStack && workspaceLayout?.isMonorepo && workspaceLayout.stacks.length > 0) {
    resolvedStack = workspaceLayout.stacks[0];
  }

  const resolveFileStack = (relPath) => {
    if (!workspaceLayout?.isMonorepo) return resolvedStack;
    const pkgName = assignPackageMembership(relPath, workspaceLayout.packages);
    if (!pkgName) return resolvedStack;
    const pkg = workspaceLayout.packages.find((p) => p.name === pkgName);
    return pkg?.stack || resolvedStack;
  };

  // Fail loud: AUTO mode with no recognised stack marker. Never silently default to Java.
  if (!resolvedStack) {
    await updateJob(jobId, { files_scanned: allFiles.length, skipped_sample: JSON.stringify(filePaths.slice(0, 25)) });
    throw new Error(
      // The list is the one detectFrom() actually tests, in its order. It previously advertised
      // pubspec.yaml, AndroidManifest.xml and Podfile — none of which are checked (only *.podspec
      // is) — while omitting setup.py, Pipfile, go.mod, Cargo.toml, Gemfile and composer.json,
      // which are. A remedy naming markers the code does not look for sends the reader to add a
      // file that changes nothing.
      `Could not auto-detect a supported stack: no build marker found ` +
      `(pom.xml / build.gradle / *.csproj / *.sln / Package.swift / *.podspec / *.xcodeproj / ` +
      `build.sbt / build.sc / requirements.txt / pyproject.toml / setup.py / Pipfile / go.mod / ` +
      `Cargo.toml / Gemfile / composer.json / angular.json / package.json / CMakeLists.txt). ` +
      `Scanned ${allFiles.length} files. Pass --stack to choose one explicitly.`
    );
  }

  // Path-based classification, with content evidence for OTHER files and strong
  // same-stack contradictions (real repos rarely follow strict directory layouts).
  const classified = allFiles.map(f => {
    const fileStack = resolveFileStack(f.rel);
    let fileType = classify(f.rel, fileStack);
    if (fileType === 'OTHER' || isContentClassifiable(f.rel)) {
      try {
        const content = fs.readFileSync(f.full, 'utf8');
        let byContent = null;
        if (isContentClassifiable(f.rel)) {
          byContent = classifyByContent(f.rel, content, fileStack);
        // Content-sniffing exists for files with NO extractor. A file whose extension HAS a grammar
        // must never be re-classified by body text: the sniff appends a fake extension, and
        // `isExtractable` then routes it to the WRONG bespoke grammar instead of the generic route
        // where it extracts correctly. `.scala` was excluded by name for exactly this reason;
        // Elixir was not, so every `.ex` matched the `def ` branch, became PYTHON_SERVICE, parsed
        // with the Python grammar and landed DEGRADED with zero declarations.
        // Gating on the grammar set fixes the whole class rather than one instance of it.
        } else if (!SUPPORTED_GRAMMAR_EXTS.has(path.extname(f.rel).toLowerCase()) && detectClassifiableContent(content)) {
          if (/^\s*(?:package|import)\s/m.test(content)) {
            byContent = classifyByContent(`${f.rel}.java`, content, fileStack);
          } else if (/export\s+/.test(content)) {
            byContent = classifyByContent(`${f.rel}.ts`, content, fileStack);
          } else if (/^\s*(?:async\s+)?def\s+\w+/m.test(content)) {
            byContent = classifyByContent(`${f.rel}.py`, content, fileStack);
          }
        }
        if (byContent && (fileType === 'OTHER' || shouldPreferContentClassification(fileType, byContent))) {
          fileType = byContent;
        }
      } catch (_) { /* unreadable — leave as OTHER */ }
    }
    const packageName = workspaceLayout?.isMonorepo
      ? assignPackageMembership(f.rel, workspaceLayout.packages)
      : null;
    return { ...f, fileType, fileStack, packageName };
  });

  const extractable = classified.filter(f => isExtractable(f.fileType));
  const toProcess   = extractable.slice(0, limit);

  // ── Coverage manifest (fail-loud) ──────────────────────────────────────────
  const codeExts      = CODE_EXTS_BY_STACK[resolvedStack] || ['.java', '.js', '.ts', '.py', '.cs', '.kt', '.swift', '.dart', '.jsx', '.tsx'];
  const isCodeFile    = (f) => {
    const stackForFile = f.fileStack || resolvedStack;
    const exts = CODE_EXTS_BY_STACK[stackForFile] || codeExts;
    return exts.includes(path.extname(f.rel).toLowerCase())
      && !/(?:^|\/)(?:package-info|module-info)\.java$/.test(f.rel);
  };
  const codeFiles     = classified.filter(isCodeFile);
  const skippedCode   = codeFiles.filter(f => !isExtractable(f.fileType));
  const filesScanned  = policyCoverageManifest.files_discovered;
  // role_labeled_source_pct is coverage_pct's classification-based number under an honest
  // name (same computeCoveragePct behaviour). It answers "of the files classified as this
  // stack's code, how many were extractable" — a number that reuses CODE_EXTS_BY_STACK as
  // its denominator and can report 100.00 while the graph stays empty. coverage_pct itself
  // is kept byte-identical for every existing read site (graph-context-v1.js and others),
  // never renamed.
  const coveragePct   = computeCoveragePct({
    codeFilesCount: codeFiles.length,
    skippedCodeCount: skippedCode.length,
    extractableCount: extractable.length,
  });
  const roleLabeledSourcePct = coveragePct;
  // files_accounted_pct — a genuinely different denominator: of every file this ingest
  // walked, policy-skipped, or rolled into a vendored-tree row (policyCoverageManifest's
  // files_discovered = files_included + files_skipped), how many got a real per-file
  // processing attempt (tier 'pending' → later extracted) rather than being recorded only
  // (tier 'record_only' — skipped_files and vendored subtree rows). Independent of stack
  // classification, so it cannot be inflated by CODE_EXTS_BY_STACK reuse the way
  // coverage_pct/role_labeled_source_pct can.
  const filesAccountedPct = policyCoverageManifest.files_discovered > 0
    ? +((policyCoverageManifest.files_included / policyCoverageManifest.files_discovered) * 100).toFixed(2)
    : 0;
  const skippedSample = skippedCode.slice(0, 25).map(f => `${f.rel} (${f.fileType})`);

  // coverage_pct's denominator is "files the classifier agreed to extract", so a
  // classifier gap RAISES it — a Java repo can report 100.00 while skipping most of its
  // files. This counts every
  // walked file the classifier could not name a role for, against the one
  // denominator that cannot be gamed (files_scanned), and breaks it down by
  // extension so the next gap is a lookup rather than an investigation.
  const skippedAsOther = classified.filter(f => f.fileType === 'OTHER');
  const otherByExt = new Map();
  for (const f of skippedAsOther) {
    const ext = path.extname(f.rel).toLowerCase() || '(no ext)';
    const cur = otherByExt.get(ext) || { ext, count: 0, sample: [] };
    cur.count++;
    if (cur.sample.length < 3) cur.sample.push(f.rel);
    otherByExt.set(ext, cur);
  }
  const skippedAsOtherByExt = [...otherByExt.values()].sort((a, b) => b.count - a.count);
  const skippedAsOtherPct = filesScanned > 0
    ? +((skippedAsOther.length / filesScanned) * 100).toFixed(2)
    : 0;
  // "No role" is not the same as "lost": the contract-config, contract-SQL,
  // template and generic-AST passes all claim files the classifier left as
  // OTHER. What the number measures is how much of the repo the ROLE model does
  // not describe — which is the signal coverage_pct structurally cannot give.
  console.log(`[ingest] [COVERAGE] stack=${resolvedStack} scanned=${filesScanned} extractable=${extractable.length} no_classifier_role=${skippedAsOther.length} (${skippedAsOtherPct}%) by_ext=${skippedAsOtherByExt.slice(0, 8).map(e => `${e.ext}:${e.count}`).join(' ')}`);

  let coverageWarning = null;
  if (extractable.length === 0) {
    coverageWarning = `No extractable source files found among ${filesScanned} scanned files for stack ${resolvedStack}. The graph will be EMPTY — check the Stack selection.`;
  } else if (codeFiles.length > 0 && coveragePct < 40) {
    coverageWarning = `Low coverage: only ${coveragePct}% of ${codeFiles.length} ${resolvedStack} source files were understood (${skippedCode.length} skipped). Many files fell to OTHER.`;
  }
  if (oversizeSkips.length > 0) {
    const oversizeClause = `; ${oversizeSkips.length} file(s) skipped for exceeding ${ingestPolicy.size.max_bytes} bytes`;
    coverageWarning = (coverageWarning || '') + oversizeClause;
  }
  if (policyCoverageManifest.files_chunked > 0) {
    const chunkClause = `; ${policyCoverageManifest.files_chunked} file(s) chunked by policy`;
    coverageWarning = (coverageWarning || '') + chunkClause;
  }
  if (walkResult.skipped.length > 0) {
    const policyClause = `; policy skipped ${walkResult.skipped.length}: ${JSON.stringify(policyCoverageManifest.skip_reasons)}`;
    coverageWarning = (coverageWarning || '') + policyClause;
  }
  if (coverageWarning) console.warn(`[ingest] [COVERAGE] ${coverageWarning}`);

  await updateJob(jobId, {
    status: 'RUNNING',
    error_msg: null,
    files_total: toProcess.length,
    detected_stack: resolvedStack,
    files_scanned: filesScanned,
    files_extractable: extractable.length,
    files_skipped: filesScanned - extractable.length,
    coverage_pct: coveragePct,
    role_labeled_source_pct: roleLabeledSourcePct,
    files_accounted_pct: filesAccountedPct,
    coverage_warning: coverageWarning,
    skipped_sample: JSON.stringify(skippedSample),
    files_skipped_oversize: oversizeSkips.length,
    oversize_sample: oversizeSkips.length > 0 ? JSON.stringify(oversizeSkips.slice(0, 25)) : null,
    files_skipped_as_other: skippedAsOther.length,
    skipped_as_other_sample: JSON.stringify({ pct_of_scanned: skippedAsOtherPct, by_ext: skippedAsOtherByExt.slice(0, 20) }),
  });

  const repoId   = await upsertRepo(projectId, repoName, resolvedStack, sourceUrl, resolvedPath);
  const branchId = await upsertBranch(repoId, detectedBranch, commitSha);

  // Shrink guard — taken before any extraction touches this branch.
  // changed-file-replacement.js archives stale nodes per-file DURING the run, so by the
  // time completeIngestJob runs the "before" picture is already gone; it has to be
  // captured here instead.
  const { snapshotBranchCounts: _snapshotBranchCountsForShrinkGuard } = require('./graph-diff');
  const beforeGenerationSnapshot = await _snapshotBranchCountsForShrinkGuard(branchId)
    .catch(() => ({ nodeCount: 0, edgeCount: 0 }));

  await persistCoverageFiles(jobId, branchId, policyCoverageManifest);

  let ingestGenerationId = null;
  try {
  const ingestGeneration = await beginGeneration({
    projectId,
    repositoryId: repoId,
    branchId,
    revisionSha: commitSha,
    config: {
      stack: resolvedStack,
      parserFirst: process.env.PARSER_FIRST === 'true',
      limit,
      ...(workspaceLayout?.isMonorepo
        ? { workspace: buildWorkspaceManifest(workspaceLayout) }
        : {}),
    },
  });
  ingestGenerationId = ingestGeneration.id;

  const { counters, pending } = createFileProcessorState();
  counters.extractionDecisions.skipped_oversize = oversizeSkips.length;

  const ignorePatterns = loadIgnorePatterns(resolvedPath);

  const CONCURRENCY = Math.min(20, Math.max(1, parseInt(process.env.INGEST_CONCURRENCY || '8', 10)));
  const poolMax = parseInt(process.env.PG_POOL_MAX || '20', 10);
  if (CONCURRENCY + 1 > poolMax) {
    console.warn(`[ingest] WARN: INGEST_CONCURRENCY=${CONCURRENCY} + 1 > PG_POOL_MAX=${poolMax}; raise PG_POOL_MAX to avoid connection wait under full load`);
  }
  let dbWriteChain = Promise.resolve();
  const serializedWrite = (fn) => {
    // Fail-fast is deliberate. Do NOT isolate each link with `.then(fn, handler)`:
    // `processFile` has no try/catch and every worker awaits this, so a rejection
    // re-throws at each worker, `Promise.all` rejects, and the generation is failed loudly.
    // With per-link isolation only the worker owning the bad file re-throws; the other
    // CONCURRENCY-1 workers survive and drain the whole queue detached, and each remaining
    // file still runs replaceChangedFileFacts — archiving the prior generation's nodes and
    // DELETING their edges and method_embeddings against an already-FAILED generation,
    // while the ingest tail never runs. If one bad file should not abort the run, handle it
    // inside the per-file loop (try/catch around this await, increment counters.errors) —
    // not here.
    dbWriteChain = dbWriteChain.then(fn);
    return dbWriteChain;
  };

  let fileIdx = 0;
  const touchedFileIds = [];
  // What actually happened to each file's LLM plane, recorded per file as it happens. The
  // coverage tier below is derived from this and from the extraction_source the written
  // nodes actually carry — never from a process-wide mode flag.
  const llmOutcomeByPath = new Map();
  const processFile = async () => {
    while (fileIdx < toProcess.length) {
      const f = toProcess[fileIdx++];

      // policy + chunked MUST be forwarded: without them oversizeAction defaults to
      // 'skip', so files the walker deliberately chunked were silently dropped here
      // while files_skipped_oversize still reported 0.
      const extractResult = await extractIngestFile({
        relPath: f.rel,
        fullPath: f.full,
        content: fs.readFileSync(f.full, 'utf8'),
        fileType: f.fileType,
        stack: f.fileStack || resolvedStack,
        ignorePatterns,
        policy: ingestPolicy,
        chunked: f.chunked,
        shaSkipEnabled: false,
        counters,
        logPrefix: '[ingest]',
      });

      if (extractResult.status === 'skipped' || extractResult.status === 'sha_skipped') {
        continue;
      }

      // A thrown LLM call must not `continue` here — that would discard the file's COMPLETE,
      // correct AST extraction along with it, so a transient provider fault would silently
      // delete deterministic structure. The error is counted and signalled inside
      // commitIngestFile, which also rescues the file's AST nodes instead of discarding them;
      // this loop only records why the semantic plane contributed nothing, for the coverage
      // reason below.
      if (extractResult.status === 'llm_error') {
        llmOutcomeByPath.set(f.rel, 'llm_provider_error');
      } else if (extractResult.parseFailed) {
        llmOutcomeByPath.set(f.rel, 'llm_output_unparseable');
      } else if (extractResult.schemaRepairFailed && (extractResult.extracted || []).length === 0) {
        llmOutcomeByPath.set(f.rel, 'llm_schema_repair_failed');
      } else if (!extractResult.llmCalled) {
        llmOutcomeByPath.set(f.rel, extractResult.skipLlm ? 'llm_skipped' : 'llm_disabled');
      } else if ((extractResult.extracted || []).length === 0) {
        llmOutcomeByPath.set(f.rel, 'llm_returned_no_nodes');
      }

      await serializedWrite(async () => {
        const commitResult = await commitIngestFile({
          extractResult,
          upsertFileFn: upsertFile,
          branchId,
          projectId,
          projectName: repoName,
          repoId,
          repoName,
          branchName: detectedBranch,
          ingestGenerationId,
          counters,
          pending,
          jobId,
          updateJobFn: updateJob,
          writeAstEdges,
          logPrefix: '[ingest]',
        });
        if (commitResult?.status === 'done' && commitResult.fileId) {
          touchedFileIds.push(commitResult.fileId);
        }
      });
    }
  };
  markPhase('walk_classify');
  await Promise.all(Array.from({ length: CONCURRENCY }, processFile));
  await dbWriteChain;
  markPhase('extract_write');

  // The tier is read back from the nodes the file actually owns — a file is `llm_semantic`
  // only if at least one of its live nodes carries `llm` in its extraction_source, which
  // prepareNodeRow stamps at write time. The reason column explains every file that did not
  // reach that bar, from the per-file outcome recorded above.
  if (toProcess.length > 0) {
    await resolveExtractionTiers(jobId, branchId, toProcess.map(f => f.rel), llmOutcomeByPath);
    await backfillLlmSemanticNodeCounts(jobId, branchId);
  }

  if (counters.errors > 0) {
    const extractionErrorClause = `; ${counters.errors} file(s) failed LLM extraction (llm_error)`;
    coverageWarning = (coverageWarning || '') + extractionErrorClause;
    await updateJob(jobId, { coverage_warning: coverageWarning });
    console.warn(`[ingest] [EXTRACTION_ERRORS] ${counters.errors} file(s) failed LLM extraction`);
  }

  if (counters.truncatedFiles > 0) {
    const truncClause = `; ${counters.truncatedFiles} oversized file(s) indexed from the first chunk only — later chunks not extracted: ${(counters.truncatedFileSample || []).join(', ')}`;
    coverageWarning = (coverageWarning || '') + truncClause;
    await updateJob(jobId, { coverage_warning: coverageWarning });
    console.warn(`[ingest] [TRUNCATED] ${counters.truncatedFiles} file(s) partially indexed: ${(counters.truncatedFileSample || []).join(', ')}`);
  }

  if (counters.spansHarvested > 0) {
    console.log(`[ingest] [SPANS_HARVESTED] ${counters.spansHarvested} node(s) filled with a tree-sitter end_line`);
  }

  if (counters.parseFailures > 0) {
    const { text: parseFailClause, astRescued, trulyLost } = formatParseFailureClause(counters);
    coverageWarning = (coverageWarning || '') + parseFailClause;
    await updateJob(jobId, { coverage_warning: coverageWarning });
    console.warn(`[ingest] [PARSE_FAILURE] ${counters.parseFailures} file(s) failed LLM semantic extraction (${astRescued} AST-rescued, ${trulyLost} fully lost): ${counters.parseFailureSample.join(', ')}`);
  }

  if (counters.degradedFiles > 0) {
    const degradedClause = `; ${counters.degradedFiles} file(s) marked DEGRADED (zero nodes, unparseable extraction, no AST coverage): ${(counters.degradedFileSample || []).join(', ')}`;
    coverageWarning = (coverageWarning || '') + degradedClause;
    await updateJob(jobId, { coverage_warning: coverageWarning });
    console.warn(`[ingest] [DEGRADED_FILES] ${counters.degradedFiles} file(s) degraded: ${(counters.degradedFileSample || []).join(', ')}`);
  }

  // Generic tree-sitter pass on files isExtractable() rejects: 36 grammars sit unused in
  // node_modules/tree-sitter-wasms/out/ for exactly those files. Zero-token, no LLM.
  const genericAstFiles = classified.filter(f =>
    !isExtractable(f.fileType) && SUPPORTED_GRAMMAR_EXTS.has(path.extname(f.rel).toLowerCase())
  );
  if (genericAstFiles.length > 0) {
    let genericAstNodeTotal = 0;
    for (const f of genericAstFiles) {
      try {
        const content = fs.readFileSync(f.full, 'utf8');
        // `f.rel`, not `f.full`: the path becomes each node's `_sourceFile` and
        // therefore part of its canonical_key, so an absolute checkout path would
        // embed the machine's temp directory in node identity and change on every clone.
        const generic = await buildGenericAstResult(f.rel, content);
        const symbolNodes = generic.nodes || [];
        const genericEdges = generic.structuralEdges || [];
        let genericImportFacts = generic.importFacts || [];
        // The generic builder returns no import facts for several of the languages routed
        // through it, while `buildAstNodes` extracts them perfectly well for the same file.
        // A Rust file yields its import facts from buildAstNodes but 0 from the generic path,
        // so without this fallback every Rust FILE node is written with no `imports` property
        // and the entire Cargo cross-repo plane is blind — `use tokio_util::task::TaskTracker`
        // cannot be seen at all.
        //
        // Falling back is additive: it only ever fills an empty array, so no language whose
        // generic builder does supply facts changes at all.
        if (!genericImportFacts.length) {
          try {
            const viaAst = buildAstNodes(content, f.rel);
            if (viaAst && Array.isArray(viaAst.importFacts) && viaAst.importFacts.length) {
              genericImportFacts = viaAst.importFacts;
            }
          } catch (_) { /* a fallback must never fail the file */ }
        }
        const fileSha = crypto.createHash('sha256').update(content).digest('hex').slice(0, 40);
        const genFileId = await upsertFile(branchId, f.rel, 'SOURCE_GENERIC', fileSha);
        let genericAstDecision = null;
        try {
          genericAstDecision = cacheableTextDecision(f.rel, content);
          await writeSourceCache({
            repositoryBranchId: branchId, fileId: genFileId, fileSha, path: f.rel,
            content: genericAstDecision.store ? content : null, skipReason: genericAstDecision.skipReason,
            ingestGenerationId,
          });
        } catch (cacheErr) {
          counters.sourceCacheFailures = (counters.sourceCacheFailures || 0) + 1;
          console.warn(`[ingest] [GENERIC_AST] source-cache ${f.rel}: ${cacheErr.message}`);
        }
        await writeLexicalChunksIfStored(genericAstDecision, {
          repositoryBranchId: branchId, fileId: genFileId, fileSha, path: f.rel,
          content, ingestGenerationId, logTag: 'GENERIC_AST',
        });
        stampMethodIdentities(
          symbolNodes,
          genericEdges.filter((e) => (e.edge_type || e.edgeType) === 'DEFINED_IN'),
        );
        const nodeIndexToId = new Map();
        for (let i = 0; i < symbolNodes.length; i++) {
          const sn = symbolNodes[i];
          const id = await writeNode(
            { ...sn, provenance: 'generic_ast' },
            genFileId, branchId, fileSha, ingestGenerationId
          );
          if (id) nodeIndexToId.set(i, id);
          counters.nodes++;
        }
        if (genericEdges.length > 0) {
          const resolvedEdges = [];
          for (const e of genericEdges) {
            const fromId = nodeIndexToId.get(e.from ?? e.fromIndex);
            const toId = nodeIndexToId.get(e.to ?? e.toIndex);
            const edgeType = e.edge_type || e.edgeType;
            if (fromId && toId && fromId !== toId && edgeType) resolvedEdges.push([fromId, toId, edgeType, e.resolution, e.evidence_line ?? e.evidenceLine ?? null, e.calleeName ?? null]);
          }
          if (resolvedEdges.length > 0) {
            const written = await writeAstEdges(resolvedEdges);
            counters.astEdgesWritten = (counters.astEdgesWritten || 0) + written;
          }
        }
        if (genericImportFacts.length > 0) {
          pending.pendingImportFacts.push({ fileId: genFileId, imports: genericImportFacts });
        }
        // A same-file call is already an edge above; a call whose target lives in another file is
        // only a NAME here. It is queued into the same
        // pendingEdges array ingest-file-processor.js already feeds, so resolveAndWriteEdges'
        // branch-wide ladder resolves them identically.
        for (const uc of generic.unresolvedCalls || []) {
          const fromId = nodeIndexToId.get(uc.fromIndex);
          if (fromId && uc.calleeName) {
            pending.pendingEdges.push({ fromNodeId: fromId, toName: uc.calleeName, edgeType: uc.edgeType || 'CALLS', callLine: uc.line ?? null, receiverName: uc.receiverName ?? null });
          }
        }
        for (const ie of generic.inheritanceEdges || []) {
          const fromId = nodeIndexToId.get(ie.fromIndex);
          if (fromId && ie.toName && ie.edgeType) {
            pending.pendingEdges.push({ fromNodeId: fromId, toName: ie.toName, edgeType: ie.edgeType, confidenceTier: ie.confidenceTier || 'INFERRED' });
          }
        }
        await updateCoverageFileTier(jobId, f.rel, 'generic_ast', symbolNodes.length);
        touchedFileIds.push(genFileId);
        genericAstNodeTotal += symbolNodes.length;
      } catch (genErr) {
        console.warn(`[ingest] [GENERIC_AST] ${f.rel}: ${genErr.message}`);
      }
    }
    console.log(`[ingest] Generic-AST nodes written: ${genericAstNodeTotal} node(s) across ${genericAstFiles.length} file(s)`);
  }

  // Ingest prose docs as DOC nodes (the "why" layer) — one node per file,
  // content in raw_evidence, first 200 chars as summary. No LLM or AST needed.
  //
  // reStructuredText joins Markdown here because Python projects write their
  // documentation in it: django-machina's entire docs tree plus CHANGELOG and
  // CONTRIBUTING is 54 .rst files, every one of which landed in the graph as an
  // empty FILE node. The "why" layer is not a Markdown feature.
  const DOC_EXTS = new Set(['.md', '.rst']);
  const markdownFiles = allFiles.filter(f => DOC_EXTS.has(path.extname(f.rel).toLowerCase()));
  if (markdownFiles.length > 0) {
    for (const mdFile of markdownFiles) {
      try {
        const mdContent = fs.readFileSync(mdFile.full, 'utf8');
        if (!mdContent.trim()) {
          await updateCoverageFileTier(jobId, mdFile.rel, 'doc', 0);
          continue;
        }
        const mdSha   = crypto.createHash('sha256').update(mdContent).digest('hex').slice(0, 40);
        const mdFileId = await upsertFile(branchId, mdFile.rel, 'DOC', mdSha);
        let docDecision = null;
        try {
          docDecision = cacheableTextDecision(mdFile.rel, mdContent);
          await writeSourceCache({
            repositoryBranchId: branchId, fileId: mdFileId, fileSha: mdSha, path: mdFile.rel,
            content: docDecision.store ? mdContent : null, skipReason: docDecision.skipReason,
            ingestGenerationId,
          });
        } catch (cacheErr) {
          counters.sourceCacheFailures = (counters.sourceCacheFailures || 0) + 1;
          console.warn(`[ingest] [DOC] source-cache ${mdFile.rel}: ${cacheErr.message}`);
        }
        await writeLexicalChunksIfStored(docDecision, {
          repositoryBranchId: branchId, fileId: mdFileId, fileSha: mdSha, path: mdFile.rel,
          content: mdContent, ingestGenerationId, logTag: 'DOC',
        });
        // Markdown titles the document with `# Heading`; reStructuredText
        // underlines it with a rule of =, -, ~ or #. Reading only the Markdown
        // form would name every .rst node after its file path.
        const h1Match  = mdContent.match(/^#\s+(.+)/m);
        const rstMatch = mdContent.match(/^[ \t]*(\S[^\n]*)\n[=\-~^"#*+`]{3,}\s*$/m);
        const docName  = h1Match ? h1Match[1].trim() : (rstMatch ? rstMatch[1].trim() : mdFile.rel);
        const summary  = mdContent.replace(/^#{1,6}\s+/gm, '').replace(/\n+/g, ' ').trim().slice(0, 200);
        await writeNode(
          { node_type: 'DOC', name: docName, summary, raw_evidence: mdContent.slice(0, MAX_BYTES), confidence_tier: 'EXTRACTED', provenance: 'doc' },
          mdFileId, branchId, mdSha, ingestGenerationId
        );
        await updateCoverageFileTier(jobId, mdFile.rel, 'doc', 1);
        touchedFileIds.push(mdFileId);
        counters.nodes++;
      } catch (docErr) {
        console.warn(`[ingest] [DOC] ${mdFile.rel}: ${docErr.message}`);
      }
    }
    console.log(`[ingest] DOC nodes written: ${markdownFiles.length} prose file(s)`);
  }

  // Deterministic SQL DDL parser → DB_TABLE nodes for .sql
  // files the LLM/semantic gate never sees. `db/*.sql` (fileType 'SCHEMA') is
  // intentionally excluded here — it is managed via the separate
  // database_schemas manual-upload flow (schemaController.js) and must not be
  // double-written by ingest.js. Zero-token, no LLM: node-sql-parser only.
  const sqlContractFiles = classified.filter(f =>
    path.extname(f.rel).toLowerCase() === '.sql' && f.fileType !== 'SCHEMA'
  );
  if (sqlContractFiles.length > 0) {
    let sqlTableTotal = 0;
    for (const f of sqlContractFiles) {
      try {
        const content = fs.readFileSync(f.full, 'utf8');
        const tables = parseSqlDdl(content);
        const fileSha = crypto.createHash('sha256').update(content).digest('hex').slice(0, 40);
        const sqlFileId = await upsertFile(branchId, f.rel, 'CONTRACT_SQL', fileSha);
        let sqlDecision = null;
        try {
          sqlDecision = cacheableTextDecision(f.rel, content);
          await writeSourceCache({
            repositoryBranchId: branchId, fileId: sqlFileId, fileSha, path: f.rel,
            content: sqlDecision.store ? content : null, skipReason: sqlDecision.skipReason,
            ingestGenerationId,
          });
        } catch (cacheErr) {
          counters.sourceCacheFailures = (counters.sourceCacheFailures || 0) + 1;
          console.warn(`[ingest] [CONTRACT_SQL] source-cache ${f.rel}: ${cacheErr.message}`);
        }
        await writeLexicalChunksIfStored(sqlDecision, {
          repositoryBranchId: branchId, fileId: sqlFileId, fileSha, path: f.rel,
          content, ingestGenerationId, logTag: 'CONTRACT_SQL',
        });
        for (const t of tables) {
          await writeNode(
            {
              node_type: 'DB_TABLE',
              name: t.table,
              summary: `Database table ${t.table}`,
              confidence_tier: 'EXTRACTED',
              provenance: 'contract_sql',
              columns: t.columns,
            },
            sqlFileId, branchId, fileSha, ingestGenerationId
          );
          counters.nodes++;
        }
        await updateCoverageFileTier(jobId, f.rel, 'contract_sql', tables.length);
        touchedFileIds.push(sqlFileId);
        sqlTableTotal += tables.length;
      } catch (sqlErr) {
        console.warn(`[ingest] [CONTRACT_SQL] ${f.rel}: ${sqlErr.message}`);
      }
    }
    console.log(`[ingest] Contract-SQL DB_TABLE nodes written: ${sqlTableTotal} table(s) across ${sqlContractFiles.length} file(s)`);
  }

  // gRPC: a `.proto` IS the cross-repo contract, and the gRPC wire format gives every operation
  // a globally unique name — `/<package>.<Service>/<Method>` (PROTOCOL-HTTP2.md, ":path"). That
  // string is to gRPC exactly what a URL path is to the HTTP plane, so RPCs are minted as
  // ENDPOINT nodes and reuse everything already built on that type. Zero-token: a hand-written
  // scanner over five proto productions, no LLM, no protoc.
  // NAMING DEBT, stated rather than hidden: the node properties below are `grpc` / `grpc_service`
  // / `grpc_method` because gRPC was the first service contract modelled. They now mean "service
  // contract" generally, and `contract_kind` says which dialect. Renaming the properties would
  // re-key every existing node for no behavioural gain, so the names stay and the meaning is
  // documented here and at every read site.
  const protoFiles = classified.filter(f => {
    const e = path.extname(f.rel).toLowerCase();
    return e === '.proto' || e === '.thrift';
  });
  const grpcServiceNames = new Set();
  const grpcMethodsByService = new Map();
  if (protoFiles.length > 0) {
    let rpcTotal = 0;
    for (const f of protoFiles) {
      let content;
      try { content = fs.readFileSync(f.full, 'utf8'); } catch (readErr) {
        console.warn(`[ingest] [CONTRACT_PROTO] ${f.rel}: ${readErr.message}`);
        continue;
      }
      let services;
      const isThrift = path.extname(f.rel).toLowerCase() === '.thrift';
      try { services = isThrift ? parseThrift(content) : parseProto(content); } catch (pErr) {
        console.warn(`[ingest] [CONTRACT_PROTO] ${f.rel}: ${pErr.message}`);
        continue;
      }
      if (!services.length) continue;
      const fileSha = crypto.createHash('sha256').update(content).digest('hex').slice(0, 40);
      const protoFileId = await upsertFile(branchId, f.rel, 'CONTRACT_PROTO', fileSha);
      for (const svc of services) {
        grpcServiceNames.add(svc.service);
        grpcMethodsByService.set(svc.service, svc.methods.map(m => m.name));
        await writeNode({
          node_type: 'SERVICE', name: svc.name, confidence_tier: 'EXTRACTED', confidence: 1.0,
          contract_kind: isThrift ? 'thrift' : 'grpc',
          summary: `${isThrift ? 'Thrift' : 'gRPC'} service ${svc.name} (${svc.methods.length} method${svc.methods.length === 1 ? '' : 's'})`,
          start_line: svc.line, end_line: svc.line,
          // Spread, not nested under a `properties` key: writeNode treats every unrecognised
          // field on the node object AS a property, so `properties: {...}` lands as
          // `properties.properties.grpc` and every consumer's `->>'grpc'` reads null.
          grpc: true, proto_package: svc.package || null, grpc_service: svc.service,
          rpc_count: svc.methods.length, source: isThrift ? 'thrift_contract' : 'proto_contract',
          thrift_extends: svc.extends || null,
        }, protoFileId, branchId, fileSha, ingestGenerationId);
        for (const m of svc.methods) {
          await writeNode({
            node_type: 'ENDPOINT', name: m.canonical, confidence_tier: 'EXTRACTED', confidence: 1.0,
            contract_kind: isThrift ? 'thrift' : 'grpc',
            summary: isThrift
              ? `Thrift ${m.canonical} returns ${m.returnType}${m.inherited ? ` (inherited from ${m.inheritedFrom})` : ''}`
              : `gRPC ${m.canonical} (${m.inputType}) returns (${m.outputType})`,
            start_line: m.line, end_line: m.line,
            grpc: true, proto_package: svc.package || null, grpc_service: svc.service,
            grpc_method: m.name, input_type: m.inputType || null, output_type: m.outputType || m.returnType || null,
            client_streaming: Boolean(m.clientStreaming), server_streaming: Boolean(m.serverStreaming),
            inherited: Boolean(m.inherited), inherited_from: m.inheritedFrom || null,
            source: isThrift ? 'thrift_contract' : 'proto_contract',
          }, protoFileId, branchId, fileSha, ingestGenerationId);
          rpcTotal++;
        }
      }
    }
    console.log(`[ingest] Contract-PROTO: ${grpcServiceNames.size} gRPC service(s), ${rpcTotal} rpc(s) across ${protoFiles.length} file(s)`);
  }

  // Deterministic OpenAPI/Swagger parser → ENDPOINT nodes for
  // .yaml/.yml/.json spec files. Detection is content-based (top-level openapi:/
  // swagger: key) so this only ever fires on actual API specs, never on generic
  // YAML/JSON config. Zero-token: js-yaml only, no LLM.
  const openApiCandidateFiles = classified.filter(f => {
    const ext = path.extname(f.rel).toLowerCase();
    return ext === '.yaml' || ext === '.yml' || ext === '.json';
  });
  const openApiContractFiles = [];
  if (openApiCandidateFiles.length > 0) {
    let openApiEndpointTotal = 0;
    for (const f of openApiCandidateFiles) {
      let content;
      try {
        content = fs.readFileSync(f.full, 'utf8');
      } catch (readErr) {
        console.warn(`[ingest] [CONTRACT_OPENAPI] ${f.rel}: ${readErr.message}`);
        continue;
      }
      let endpoints;
      try {
        endpoints = parseOpenApi(content);
      } catch (oaErr) {
        console.warn(`[ingest] [CONTRACT_OPENAPI] ${f.rel}: ${oaErr.message}`);
        continue;
      }
      if (endpoints.length === 0) continue;
      openApiContractFiles.push(f);
      try {
        const fileSha = crypto.createHash('sha256').update(content).digest('hex').slice(0, 40);
        const oaFileId = await upsertFile(branchId, f.rel, 'CONTRACT_OPENAPI', fileSha);
        let openApiDecision = null;
        try {
          openApiDecision = cacheableTextDecision(f.rel, content);
          await writeSourceCache({
            repositoryBranchId: branchId, fileId: oaFileId, fileSha, path: f.rel,
            content: openApiDecision.store ? content : null, skipReason: openApiDecision.skipReason,
            ingestGenerationId,
          });
        } catch (cacheErr) {
          counters.sourceCacheFailures = (counters.sourceCacheFailures || 0) + 1;
          console.warn(`[ingest] [CONTRACT_OPENAPI] source-cache ${f.rel}: ${cacheErr.message}`);
        }
        await writeLexicalChunksIfStored(openApiDecision, {
          repositoryBranchId: branchId, fileId: oaFileId, fileSha, path: f.rel,
          content, ingestGenerationId, logTag: 'CONTRACT_OPENAPI',
        });
        for (const ep of endpoints) {
          await writeNode(
            {
              node_type: 'ENDPOINT',
              name: ep.name,
              summary: `${ep.method} ${ep.path}`,
              confidence_tier: 'EXTRACTED',
              provenance: 'contract_openapi',
              method: ep.method,
              path: ep.path,
            },
            oaFileId, branchId, fileSha, ingestGenerationId
          );
          counters.nodes++;
        }
        await updateCoverageFileTier(jobId, f.rel, 'contract_openapi', endpoints.length);
        touchedFileIds.push(oaFileId);
        openApiEndpointTotal += endpoints.length;
      } catch (oaWriteErr) {
        console.warn(`[ingest] [CONTRACT_OPENAPI] ${f.rel}: ${oaWriteErr.message}`);
      }
    }
    if (openApiContractFiles.length > 0) {
      console.log(`[ingest] Contract-OpenAPI ENDPOINT nodes written: ${openApiEndpointTotal} endpoint(s) across ${openApiContractFiles.length} file(s)`);
    }
  }

  // Zero-token deterministic parse of structured KV/config
  // formats (.properties, .yml/.yaml, .json, .editorconfig, .gitattributes) into CONFIG_VALUE
  // nodes. The LLM `CONFIG` path is left in place
  // for `application*.properties`/`application*.yml` (BACKEND_RULES) and `appsettings*.json`
  // (DOTNET_RULES) — those files are already `isExtractable`, so this pass only claims files the
  // LLM never sees (docker-compose.yml, CI workflow YAML, generic JSON/properties, dotfiles),
  // which is why it filters on `!isExtractable(f.fileType)`. This *increases* coverage without
  // touching token spend for files already routed to the LLM. `.yaml`/`.yml`/`.json` files
  // already claimed by the OpenAPI contract pass above are excluded via `openApiContractFiles`
  // so a spec file is never double-written as both an ENDPOINT source and a CONFIG_VALUE source.
  const openApiClaimedRel = new Set(openApiContractFiles.map(f => f.rel));
  const configContractFiles = classified.filter(f => {
    if (isExtractable(f.fileType)) return false;
    const base = path.basename(f.rel);
    const ext = path.extname(f.rel).toLowerCase();
    const isConfigShaped = base === '.editorconfig' || base === '.gitattributes' ||
      ext === '.properties' || ext === '.yml' || ext === '.yaml' || ext === '.json' ||
      ext === '.po' || ext === '.pot';
    if (!isConfigShaped) return false;
    if (openApiClaimedRel.has(f.rel)) return false;
    return true;
  });
  if (configContractFiles.length > 0) {
    let configValueTotal = 0;
    for (const f of configContractFiles) {
      let content;
      try {
        content = fs.readFileSync(f.full, 'utf8');
      } catch (readErr) {
        console.warn(`[ingest] [CONTRACT_CONFIG] ${f.rel}: ${readErr.message}`);
        continue;
      }
      let parsed;
      try {
        parsed = parseConfigFile(f.rel, content);
      } catch (cfgErr) {
        // parseConfigFile never throws by contract, but a caller-side guard is cheap
        // insurance against the exact class of bug the C2 adversarial test exists to catch.
        console.warn(`[ingest] [CONTRACT_CONFIG] ${f.rel}: ${cfgErr.message}`);
        continue;
      }
      if (!parsed || parsed.entries.length === 0) {
        // Zero-entry config-shaped files (e.g. an empty i18n bundle) still get a source-cache
        // row — they are readable, non-sensitive text, and the goal is coverage for every
        // such file regardless of whether this pass extracted anything from it. Without this,
        // a file whose coverage tier a later ingest reconciles to 'presence_floor' (because a
        // stale floor node from a prior run survives, see reconcileCoverageNodeCounts) falls
        // through both this pass AND the floor pass, since coveredRelPaths already claims it.
        let zeroDecision = null;
        let zeroFileId = null;
        let zeroFileSha = null;
        try {
          zeroFileSha = crypto.createHash('sha256').update(content).digest('hex').slice(0, 40);
          zeroFileId = await upsertFile(branchId, f.rel, 'CONTRACT_CONFIG', zeroFileSha);
          zeroDecision = cacheableTextDecision(f.rel, content);
          await writeSourceCache({
            repositoryBranchId: branchId, fileId: zeroFileId, fileSha: zeroFileSha, path: f.rel,
            content: zeroDecision.store ? content : null, skipReason: zeroDecision.skipReason,
            ingestGenerationId,
          });
        } catch (cacheErr) {
          counters.sourceCacheFailures = (counters.sourceCacheFailures || 0) + 1;
          console.warn(`[ingest] [CONTRACT_CONFIG] source-cache ${f.rel}: ${cacheErr.message}`);
        }
        if (zeroFileId != null) {
          await writeLexicalChunksIfStored(zeroDecision, {
            repositoryBranchId: branchId, fileId: zeroFileId, fileSha: zeroFileSha, path: f.rel,
            content, ingestGenerationId, logTag: 'CONTRACT_CONFIG',
          });
        }
        await updateCoverageFileTier(jobId, f.rel, 'contract_config', 0);
        continue;
      }
      try {
        const fileSha = crypto.createHash('sha256').update(content).digest('hex').slice(0, 40);
        const cfgFileId = await upsertFile(branchId, f.rel, 'CONTRACT_CONFIG', fileSha);
        let cfgDecision = null;
        try {
          cfgDecision = cacheableTextDecision(f.rel, content);
          await writeSourceCache({
            repositoryBranchId: branchId, fileId: cfgFileId, fileSha, path: f.rel,
            content: cfgDecision.store ? content : null, skipReason: cfgDecision.skipReason,
            ingestGenerationId,
          });
        } catch (cacheErr) {
          counters.sourceCacheFailures = (counters.sourceCacheFailures || 0) + 1;
          console.warn(`[ingest] [CONTRACT_CONFIG] source-cache ${f.rel}: ${cacheErr.message}`);
        }
        await writeLexicalChunksIfStored(cfgDecision, {
          repositoryBranchId: branchId, fileId: cfgFileId, fileSha, path: f.rel,
          content, ingestGenerationId, logTag: 'CONTRACT_CONFIG',
        });
        // Gate the node-emitting loop only —
        // writeSourceCache and writeLexicalChunksIfStored above already ran, so a
        // 'lexical_only' file keeps full T2 searchability and just stops occupying
        // graph nodes. Mirrors the zero-entry branch above: coverage tier recorded
        // at 0, no touchedFileIds push, no counters.nodes/configValueTotal bump.
        if (configNodeEligibility(f.rel) === 'lexical_only') {
          await updateCoverageFileTier(jobId, f.rel, 'contract_config', 0);
          continue;
        }
        // Same defect the presence floor had: cfgDecision already ruled this file secret and
        // withheld it from the source cache and the lexical chunks above, and the summary then
        // carried `KEY = <the actual credential>` into nodes.summary and method_text_index, where
        // search_code hands it straight to the agent. The key is the useful half and is not the
        // secret; the value is.
        const cfgRedacted = cfgDecision && cfgDecision.store === false;
        for (const entry of parsed.entries) {
          if (!entry.key) continue;
          await writeNode(
            {
              node_type: 'CONFIG_VALUE',
              name: entry.key,
              summary: cfgRedacted
                ? `${entry.key} = (value withheld — ${cfgDecision.skipReason})`
                : `${entry.key} = ${String(entry.value).slice(0, 200)}`,
              confidence_tier: 'EXTRACTED',
              provenance: 'contract_config',
              start_line: entry.line || undefined,
              end_line: entry.line || undefined,
              _sourceFile: f.rel,
            },
            cfgFileId, branchId, fileSha, ingestGenerationId
          );
          counters.nodes++;
        }
        if (parsed.truncated) {
          console.warn(`[ingest] [CONTRACT_CONFIG] ${f.rel}: capped at ${parsed.truncated.cap} of ${parsed.truncated.total_entries} entries`);
        }
        await updateCoverageFileTier(jobId, f.rel, 'contract_config', parsed.entries.length);
        touchedFileIds.push(cfgFileId);
        configValueTotal += parsed.entries.length;
      } catch (cfgWriteErr) {
        console.warn(`[ingest] [CONTRACT_CONFIG] ${f.rel}: ${cfgWriteErr.message}`);
      }
    }
    console.log(`[ingest] Contract-Config CONFIG_VALUE nodes written: ${configValueTotal} value(s) across ${configContractFiles.length} file(s)`);
  }

  // Declared dependencies, from the build manifest, deterministically.
  //
  // The graph already knew what the code IMPORTS. It did not know what the
  // project DECLARES, at what version, in which scope — so "we are bumping
  // spring-boot-starter-web, what breaks" had nothing to start from. Measured
  // on spring-petclinic: the LLM-backed POM path found 14 of the 30
  // dependencies, and build.gradle produced nothing.
  // Nine ecosystems, zero tokens. Node names are the ecosystem's own
  // coordinate (`group:artifact`, the npm name, the Go module path), so the
  // post-tail linkage pass can match them against the import-derived
  // DEPENDENCY nodes resolveImportFacts mints.
  const manifestFiles = classified.filter(f => isManifestPath(f.rel));
  if (manifestFiles.length > 0) {
    let declaredTotal = 0;
    for (const f of manifestFiles) {
      try {
        const content = fs.readFileSync(f.full, 'utf8');
        const parsed = parseManifest(f.rel, content);
        if (!parsed || !parsed.entries.length) continue;
        const fileSha = crypto.createHash('sha256').update(content).digest('hex').slice(0, 40);
        const manifestFileId = await upsertFile(branchId, f.rel, 'MANIFEST', fileSha);
        for (const dep of parsed.entries) {
          await writeNode(
            {
              node_type: 'DEPENDENCY',
              name: dep.name,
              summary: `Declared ${parsed.ecosystem} dependency ${dep.name}${dep.version ? ` ${dep.version}` : ''}`,
              confidence_tier: 'EXTRACTED',
              confidence: 1.0,
              provenance: 'manifest',
              ecosystem: parsed.ecosystem,
              declared_version: dep.version,
              dependency_scope: dep.scope,
              declared_in: f.rel,
            },
            manifestFileId, branchId, fileSha, ingestGenerationId
          );
          counters.nodes++;
        }
        await updateCoverageFileTier(jobId, f.rel, 'manifest', parsed.entries.length);
        touchedFileIds.push(manifestFileId);
        declaredTotal += parsed.entries.length;
      } catch (mErr) {
        console.warn(`[ingest] [MANIFEST] ${f.rel}: ${mErr.message}`);
      }
    }
    console.log(`[ingest] Manifest DEPENDENCY nodes written: ${declaredTotal} declared dep(s) across ${manifestFiles.length} manifest(s)`);
  }

  // Presence-floor tail pass — every TEXT file this ingest still ends with zero nodes gets
  // one findable FILE node, whatever the reason. Zero-token, no embedding call (FILE is
  // already an embedded node_type via the standard pipeline). Tagged
  // properties.provenance/tier 'presence_floor' so retrieval can down-rank it and
  // comprehension math can exclude it — a floor is a coverage/audit signal, never semantic
  // content, and must never be counted as understanding.
  //
  // Two source populations:
  //   (a) uncovered / policy skips that are readable, non-sensitive text — EXCLUDES
  //       ignore_pattern/editor_metadata (recorded but never floored) and
  //       binary/secret/vendored_tree/symlink/special_file/unreadable*/git_submodule/skip_dir
  //       (content-sensitive, subtree-level, or not a single readable file).
  //   (b) files that WERE extracted (llm_semantic/generic_ast/contract_sql/
  //       contract_openapi/contract_config) but landed at node_count=0 — legitimate
  //       zero-symbol outcomes and terminal parse/llm failures alike.
  const coveredRelPaths = new Set([
    ...extractable.map(f => f.rel),
    ...genericAstFiles.map(f => f.rel),
    ...markdownFiles.map(f => f.rel),
    ...sqlContractFiles.map(f => f.rel),
    ...openApiContractFiles.map(f => f.rel),
    ...configContractFiles.map(f => f.rel),
  ]);
  const uncoveredFiles = classified.filter(f => !coveredRelPaths.has(f.rel));

  const skippedFloorCandidates = (walkResult.skipped || [])
    .filter((entry) => FLOOR_ELIGIBLE_SKIP_REASONS.has(entry.reason))
    .map((entry) => ({ rel: entry.path, full: path.join(resolvedPath, entry.path), oversize: entry.reason === SKIP_REASONS.OVERSIZE, oversizeBytes: entry.bytes }));

  await reconcileCoverageNodeCounts(jobId, branchId);
  const zeroNodeCoverageRows = await findZeroNodeExtractedFiles(jobId);
  // C-class rows already went through the real classifier and already have a `files` row
  // with the correct file_type (JAVA_CLASS, etc.) — the floor must attach to that same
  // fileId, never re-upsert as generic 'FILE' (that would silently clobber file_type).
  const zeroNodeCandidates = zeroNodeCoverageRows.map((r) => ({
    rel: r.path, full: path.join(resolvedPath, r.path), preserveFileType: true,
  }));

  const seenFloorRel = new Set();
  const floorCandidates = [];
  for (const cand of [...uncoveredFiles, ...skippedFloorCandidates, ...zeroNodeCandidates]) {
    if (seenFloorRel.has(cand.rel)) continue;
    seenFloorRel.add(cand.rel);
    floorCandidates.push(cand);
  }

  // Resolve the fileId to attach a floor node to: reuse the existing row's fileId
  // (preserving its real file_type) for already-classified files, or upsert as 'FILE'
  // for files that never got a `files` row at all (uncovered / policy-skipped).
  async function resolveFloorFileId(candidate, relPath, fileType, fileSha) {
    if (candidate.preserveFileType) {
      const { rows } = await pool.query(
        `SELECT id FROM files WHERE repository_branch_id = $1 AND path = $2`,
        [branchId, relPath]
      );
      if (rows[0]?.id) return rows[0].id;
    }
    return upsertFile(branchId, relPath, fileType, fileSha);
  }

  if (floorCandidates.length > 0) {
    let floorNodeTotal = 0;
    let floorEmptyTotal = 0;
    for (const f of floorCandidates) {
      try {
        let raw;
        try {
          raw = fs.readFileSync(f.full);
        } catch (readErr) {
          console.warn(`[ingest] [PRESENCE_FLOOR] ${f.rel}: unreadable — ${readErr.message}`);
          await updateCoverageFileTier(jobId, f.rel, 'presence_floor', 0, 'unreadable');
          continue;
        }
        const content = raw.toString('utf8');
        const presentation = computeFloorPresentation(content, {
          oversize: !!f.oversize, oversizeBytes: f.oversizeBytes, rawByteLength: raw.length,
        });
        if (presentation.empty) floorEmptyTotal++;

        const fileSha  = crypto.createHash('sha256').update(content).digest('hex').slice(0, 40);
        const fileId   = await resolveFloorFileId(f, f.rel, 'FILE', fileSha);
        let floorDecision = null;
        try {
          floorDecision = cacheableTextDecision(f.rel, raw);
          await writeSourceCache({
            repositoryBranchId: branchId, fileId, fileSha, path: f.rel,
            content: floorDecision.store ? content : null, skipReason: floorDecision.skipReason,
            ingestGenerationId,
          });
        } catch (cacheErr) {
          counters.sourceCacheFailures = (counters.sourceCacheFailures || 0) + 1;
          console.warn(`[ingest] [PRESENCE_FLOOR] source-cache ${f.rel}: ${cacheErr.message}`);
        }
        await writeLexicalChunksIfStored(floorDecision, {
          repositoryBranchId: branchId, fileId, fileSha, path: f.rel,
          content, ingestGenerationId, logTag: 'PRESENCE_FLOOR',
        });
        // Scoped to the node write, not the whole iteration: a mis-decoded file carries
        // embedded NULs, which Postgres rejects outright, and the outer catch used to
        // swallow that and skip the coverage update too — so the one file that most needed
        // an explanation ended with no FILE node AND a NULL reason (M47 + M43).
        // The same floorDecision that already withheld this file from the source cache and the
        // lexical chunks must withhold it here too. `.env` matches SECRET_PATH_RE, so store is
        // false and content is correctly dropped three lines above — but raw_evidence and the
        // summary (the file's first non-blank line, i.e. its first assignment) were passed
        // through unconditionally, putting the whole secret in nodes.raw_evidence.
        const floorRedacted = floorDecision && floorDecision.store === false;
        let floorNodeWritten = false;
        try {
          await writeNode(
            {
              node_type: 'FILE', name: f.rel,
              summary: floorRedacted
                ? `${f.rel} (contents withheld — ${floorDecision.skipReason})`.slice(0, 300)
                : presentation.summary,
              raw_evidence: floorRedacted ? null : presentation.raw_evidence,
              confidence_tier: 'EXTRACTED', provenance: 'presence_floor',
              start_line: 1, end_line: content.split('\n').length,
              ...presentation.properties,
            },
            fileId, branchId, fileSha, ingestGenerationId
          );
          floorNodeWritten = true;
        } catch (nodeErr) {
          console.warn(`[ingest] [PRESENCE_FLOOR] node write ${f.rel}: ${nodeErr.message}`);
        }
        // OC-5 requires every non-llm_semantic row to name why the semantic plane did not
        // contribute. computeFloorPresentation already derived the cause for the node's
        // properties; the coverage row was the one place it was being dropped (M43).
        // node_count on a FAILED node write depends on which candidate class this is.
        // A zeroNodeCandidate (preserveFileType) came from an extraction bucket, so the
        // coveredFilesForFileNode pass below still anchors a FILE node for it and 1 is
        // true. An uncoveredFile or a walk-skipped candidate is in no such bucket and
        // gets nothing — claiming 1 there would be the very manifest lie M2/M43 exist to
        // stop, and invariant 12 would rightly flag it as a node_count_mismatch.
        const floorNodeCount = floorNodeWritten || f.preserveFileType ? 1 : 0;
        await updateCoverageFileTier(jobId, f.rel, 'presence_floor', floorNodeCount, floorCoverageReason(presentation));
        if (!floorNodeWritten) continue;
        touchedFileIds.push(fileId);
        counters.nodes++;
        floorNodeTotal++;
      } catch (presErr) {
        console.warn(`[ingest] [PRESENCE_FLOOR] ${f.rel}: ${presErr.message}`);
      }
    }
    console.log(`[ingest] presence_floor FILE nodes written: ${floorNodeTotal} node(s) across ${floorCandidates.length} file(s) (${floorEmptyTotal} empty)`);
  }

  // Every binary (reason=binary) manifest row gets a FILE stub node so it is at least
  // findable by name — a stub, never a content claim.
  // Binaries never went through the classifier (the walk skips them before classification),
  // so unlike the presence floor there is no existing `files` row to preserve — always
  // upsertFile as 'FILE'. No content read as text (would corrupt on binary bytes); the file
  // is hashed as a raw buffer for fileSha, and the size comes from the walk's recorded
  // `bytes` (falling back to a fresh stat if the read succeeds) — zero LLM either way.
  const binaryStubCandidates = (walkResult.skipped || [])
    .filter((entry) => entry.reason === SKIP_REASONS.BINARY)
    .map((entry) => ({ rel: entry.path, full: path.join(resolvedPath, entry.path), bytes: entry.bytes }));

  if (binaryStubCandidates.length > 0) {
    let binaryStubTotal = 0;
    for (const f of binaryStubCandidates) {
      try {
        let raw;
        try {
          raw = fs.readFileSync(f.full);
        } catch (readErr) {
          console.warn(`[ingest] [BINARY_STUB] ${f.rel}: unreadable — ${readErr.message}`);
          await updateCoverageFileTier(jobId, f.rel, 'binary_stub', 0);
          continue;
        }
        const sizeBytes = raw.length ?? f.bytes;
        const presentation = computeBinaryStubPresentation(f.rel, sizeBytes);
        const fileSha = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40);
        const fileId  = await upsertFile(branchId, f.rel, 'FILE', fileSha);
        try {
          await writeSourceCache({
            repositoryBranchId: branchId, fileId, fileSha, path: f.rel,
            content: null, skipReason: 'binary', ingestGenerationId,
          });
        } catch (cacheErr) {
          counters.sourceCacheFailures = (counters.sourceCacheFailures || 0) + 1;
          console.warn(`[ingest] [BINARY_STUB] source-cache ${f.rel}: ${cacheErr.message}`);
        }
        await writeNode(
          {
            node_type: 'FILE', name: f.rel, summary: presentation.summary,
            raw_evidence: presentation.raw_evidence,
            confidence_tier: 'EXTRACTED', provenance: 'binary_stub',
            start_line: 1, end_line: 1,
            ...presentation.properties,
          },
          fileId, branchId, fileSha, ingestGenerationId
        );
        await updateCoverageFileTier(jobId, f.rel, 'binary_stub', 1);
        touchedFileIds.push(fileId);
        counters.nodes++;
        binaryStubTotal++;
      } catch (stubErr) {
        console.warn(`[ingest] [BINARY_STUB] ${f.rel}: ${stubErr.message}`);
      }
    }
    console.log(`[ingest] binary_stub FILE nodes written: ${binaryStubTotal} node(s) across ${binaryStubCandidates.length} file(s)`);
  }

  // The presence_floor and
  // binary_stub passes above are the ONLY places that ever wrote a FILE node — every
  // file that went through the LLM/AST-extractable, generic-AST, DOC, contract-SQL,
  // contract-OpenAPI or contract-config passes got its symbol/DOC/DB_TABLE/ENDPOINT/
  // CONFIG_VALUE nodes but no node representing the FILE itself. This pass makes FILE
  // node creation universal: same node shape as presence_floor (computeFloorPresentation,
  // EXTRACTED/1.00 — a FILE node is a fact, never a heuristic), covering exactly the
  // complement of the presence_floor/binary_stub candidate sets so no file is double-
  // processed. Deliberately does NOT call upsertFile with type 'FILE' — that would
  // clobber the file's real file_type (the same hazard resolveFloorFileId's
  // preserveFileType branch guards against above) — it only looks up the fileId a
  // prior pass in this same ingest already established. Content is read from
  // file_source_cache (already written by every one of those passes) rather than
  // re-read from disk, and end_line is left unset when no content was cached — never
  // fabricated.
  const coveredFilesForFileNode = [];
  {
    const seenRel = new Set();
    for (const f of [...extractable, ...genericAstFiles, ...markdownFiles, ...sqlContractFiles, ...openApiContractFiles, ...configContractFiles]) {
      if (seenRel.has(f.rel)) continue;
      seenRel.add(f.rel);
      coveredFilesForFileNode.push(f);
    }
  }
  // IMPORT nodes retired — import facts
  // collected per file during extraction (pending.pendingImportFacts,
  // ingest-file-processor.js#commitExtractedNodes) are keyed by fileId here
  // and stamped onto that file's FILE node as `properties.imports`
  // ({name,module,alias,line}[]) — facts.js#buildFileScopedIndex and
  // ingest.js#resolveImportFacts (below) both read this shape.
  const importsByFileId = new Map();
  for (const entry of pending.pendingImportFacts || []) {
    if (!entry || !entry.fileId || !entry.imports?.length) continue;
    const existing = importsByFileId.get(entry.fileId);
    if (existing) existing.push(...entry.imports);
    else importsByFileId.set(entry.fileId, [...entry.imports]);
  }

  if (coveredFilesForFileNode.length > 0) {
    let coveredFileNodeTotal = 0;
    for (const f of coveredFilesForFileNode) {
      try {
        const { rows: fileRows } = await pool.query(
          `SELECT id, file_sha FROM files WHERE repository_branch_id = $1 AND path = $2`,
          [branchId, f.rel]
        );
        const fRow = fileRows[0];
        if (!fRow) continue;
        const { rows: cacheRows } = await pool.query(
          `SELECT content FROM file_source_cache WHERE file_id = $1 AND content IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
          [fRow.id]
        );
        const content = cacheRows[0]?.content ?? null;
        const presentation = content !== null ? computeFloorPresentation(content) : null;
        const fileImports = importsByFileId.get(fRow.id);
        await writeNode(
          {
            node_type: 'FILE', name: f.rel,
            summary: presentation ? presentation.summary : null,
            raw_evidence: presentation ? presentation.raw_evidence : null,
            confidence_tier: 'EXTRACTED', provenance: 'presence_floor',
            start_line: 1,
            end_line: content !== null ? content.split('\n').length : undefined,
            ...(presentation ? presentation.properties : {}),
            ...(fileImports ? { imports: fileImports } : {}),
          },
          fRow.id, branchId, fRow.file_sha, ingestGenerationId
        );
        touchedFileIds.push(fRow.id);
        counters.nodes++;
        coveredFileNodeTotal++;
      } catch (fileNodeErr) {
        console.warn(`[ingest] [FILE_NODE] ${f.rel}: ${fileNodeErr.message}`);
      }
    }
    console.log(`[ingest] FILE nodes written for covered files: ${coveredFileNodeTotal} node(s) across ${coveredFilesForFileNode.length} file(s)`);
  }

  // Which gRPC services each hand-written file SERVES and which it CALLS. Stamped onto the FILE
  // node the same way `imports` is, so cross-repo resolution is a graph read rather than a
  // second filesystem walk (and so an incremental re-ingest refreshes it with the file).
  //
  // Only runs when a .proto in this branch actually declared services: without the contract
  // there is no name to match, and matching `New*Client(` against nothing would be a licence to
  // invent services. Generated protoc output is excluded inside extractGrpcFacts — vendored
  // stubs name every service in the contract and would otherwise make every service appear to
  // call every other one.
  // NOTE the gate is deliberately NOT `grpcServiceNames.size > 0`. In every real fleet the
  // .proto lives somewhere other than the service that consumes it — a shared `protos/` folder,
  // a contract repo, or a vendored copy of the *generated* code only. Online Boutique is exactly
  // that shape: its four Go services vendor `genproto/*.pb.go` and no `.proto` at all, so a
  // branch-local contract gate left every one of them blind.
  //
  // So extraction collects CANDIDATE service names here, and the check "is this a service some
  // .proto in this project actually declares" moves to cross-repo resolution, which is the first
  // place where every member's contract nodes exist. Loose here, strict there.
  {
    // The known-service set must span the PROJECT, not this repository. The contract almost never
    // lives in the service that uses it, and unlike gRPC the Thrift markers (`FooHandler`,
    // `Bar.Client`) are ordinary application names — so their gate cannot be relaxed the way the
    // gRPC one is. Reading the contract SERVICE nodes already written by earlier members gives a
    // real gate without inventing services.
    //
    // Ordering caveat, stated because it is a genuine limitation: a member ingested BEFORE the
    // repo holding the contract sees an empty set and stamps no Thrift roles. Ingest the contract
    // repo first, or re-ingest that member afterwards.
    try {
      const { rows: projectServices } = await pool.query(
        `SELECT DISTINCT json_extract(n.properties, '$.grpc_service') AS svc
           FROM nodes n
           JOIN repository_branches rb ON rb.id = n.repository_branch_id
           JOIN repositories r ON r.id = rb.repository_id
          WHERE r.project_id = $1 AND n.node_type = 'SERVICE'
            AND json_extract(n.properties, '$.grpc') = 1 AND n.approval_status <> 'ARCHIVED'`,
        [projectId],
      );
      for (const row of projectServices) if (row.svc) grpcServiceNames.add(row.svc);
    } catch (svcErr) {
      console.warn(`[ingest] [CONTRACT_SCOPE] project-wide service lookup failed: ${svcErr.message}`);
    }

    let served = 0, called = 0, filesStamped = 0;
    for (const f of classified) {
      let content;
      try { content = fs.readFileSync(f.full, 'utf8'); } catch (_) { continue; }
      let facts;
      try {
        facts = extractGrpcFacts(f.rel, content, {
          knownServices: grpcServiceNames.size > 0 ? grpcServiceNames : null,
          methodsByService: grpcMethodsByService,
        });
        // Thrift roles merge into the same two arrays: a "service contract" role is the same
        // fact whichever IDL declared it, and the resolver joins them identically. Unlike gRPC
        // the Thrift gate is NOT optional — `FooHandler` and `Bar.Client` are ordinary
        // application names, so without a .thrift declaring them this returns nothing.
        if (grpcServiceNames.size > 0) {
          const tf = extractThriftFacts(f.rel, content, { knownServices: grpcServiceNames });
          facts = {
            ...facts,
            serves: [...facts.serves, ...tf.serves],
            calls: [...facts.calls, ...tf.calls],
          };
        }
      } catch (gErr) {
        console.warn(`[ingest] [GRPC_FACTS] ${f.rel}: ${gErr.message}`);
        continue;
      }
      if (!facts.serves.length && !facts.calls.length) continue;
      const payload = {
        grpc_serves: facts.serves,
        grpc_calls: facts.calls,
        grpc_methods: [...facts.methodsMentioned],
      };
      try {
        const { rowCount } = await pool.query(
          `UPDATE nodes AS n SET properties = json_merge(coalesce(n.properties, '{}'), $3)
             FROM files fl
            WHERE fl.id = n.file_id AND n.repository_branch_id = $1 AND n.node_type = 'FILE'
              AND fl.path = $2 AND n.approval_status <> 'ARCHIVED'`,
          [branchId, f.rel, JSON.stringify(payload)],
        );
        if (rowCount) {
          filesStamped++;
          served += facts.serves.length;
          called += facts.calls.length;
        }
      } catch (uErr) {
        console.warn(`[ingest] [GRPC_FACTS] stamp ${f.rel}: ${uErr.message}`);
      }
    }
    console.log(`[ingest] gRPC facts: ${filesStamped} file(s) stamped, ${served} serve(s), ${called} call(s)`);
  }

  // Universal import-fact backfill.
  //
  // A file's imports are computed on whichever branch its CLASSIFICATION sends it down, and not
  // every branch computes them. Many `.rs` files classified as plain `FILE` (rather than
  // RUST_MODEL/RUST_SERVICE) reach this point with no `imports` property at all — including
  // `src/lib.rs` and every file under `tests/`, which is where the cross-crate
  // `use tokio_util::…` statements live, leaving the Cargo cross-repo plane blind to exactly
  // those.
  //
  // Rather than patch each classification branch, any FILE node still missing `imports` is filled
  // here from the extractor directly. Purely additive — a file that already has them is skipped,
  // so no existing behaviour changes — and it is the one place every language passes through.
  {
    const { rows: bare } = await pool.query(
      `SELECT n.id, f.path FROM nodes n
         JOIN files f ON f.id = n.file_id
        WHERE n.repository_branch_id = $1 AND n.node_type = 'FILE'
          AND n.approval_status <> 'ARCHIVED'
          AND (NOT (json_type(n.properties, '$.imports') IS NOT NULL)
               OR json_array_length(coalesce(json_extract(n.properties, '$.imports'),'[]')) = 0)`,
      [branchId],
    );
    // Resolved from the checkout root, NOT from `classified`. A FILE node can exist for a path
    // that never entered `classified` (a different classification branch walked it), and keying
    // off that list silently skipped exactly those — which on tokio was every file under
    // `tests/`, i.e. all the cross-crate `use` statements. Measured: 0 filled via `classified`,
    // 258 filled via the root.
    let filled = 0, factCount = 0;
    for (const row of bare) {
      const full = path.join(resolvedPath, row.path);
      if (!fs.existsSync(full)) continue;
      let content;
      try { content = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
      if (content.length > 400000) continue;
      let facts = [];
      try { facts = (buildAstNodes(content, row.path) || {}).importFacts || []; } catch (_) { continue; }
      if (!facts.length) continue;
      try {
        await pool.query(
          `UPDATE nodes SET properties = json_merge(coalesce(properties, '{}'), $2)
            WHERE id = $1`,
          [row.id, JSON.stringify({ imports: facts })],
        );
        filled++; factCount += facts.length;
      } catch (_) { /* non-fatal */ }
    }
    if (filled) console.log(`[ingest] import backfill: ${filled} FILE node(s) filled, ${factCount} fact(s)`);
  }

  // Qualified cross-package references (`pflag.Flag`, `afero.Fs`) that are NAMED but never
  // called. `callExpressions` cannot see them and no declaration property holds them, yet they
  // are a real dependency on another module's exported type. Stamped on the FILE node so
  // cross-repo resolution can bind them through the same import-alias gate it already uses.
  //
  // Re-parses Go files only, and only when the grammar is available — the cost is one extra AST
  // per .go file, paid because the alternative (a regex over raw text) cannot tell
  // `pkg.Exported` from a field access on a local variable.
  {
    let stampedRefs = 0, totalRefs = 0;
    for (const f of classified) {
      if (path.extname(f.rel).toLowerCase() !== '.go') continue;
      let content;
      try { content = fs.readFileSync(f.full, 'utf8'); } catch (_) { continue; }
      if (content.length > 400000) continue;
      let refs;
      try { refs = extractGoQualifiedRefs(content, f.rel) || []; }
      catch (_) { continue; }
      if (!refs.length) continue;
      totalRefs += refs.length;
      try {
        const { rowCount } = await pool.query(
          `UPDATE nodes AS n SET properties = json_merge(coalesce(n.properties, '{}'), $3)
             FROM files fl
            WHERE fl.id = n.file_id AND n.repository_branch_id = $1 AND n.node_type = 'FILE'
              AND fl.path = $2 AND n.approval_status <> 'ARCHIVED'`,
          [branchId, f.rel, JSON.stringify({ qualified_refs: refs })],
        );
        if (rowCount) stampedRefs++;
      } catch (_) { /* non-fatal */ }
    }
    if (stampedRefs) console.log(`[ingest] qualified refs: ${stampedRefs} file(s), ${totalRefs} ref(s)`);
  }

  // Message-broker topics. Unlike gRPC there is no contract file to anchor against — the only
  // thing joining a producer to a consumer is the topic STRING, and in practice that string is
  // never written at the call site. Two passes: harvest module-level bindings across the repo
  // (`var Topic = getTopic()`, `TopicName = getenv("KAFKA_TOPIC") ?? "orders"`), then resolve
  // call-site identifiers against them. Measured on the OpenTelemetry demo, all three services
  // needed it; a literal-only detector found nothing at all.
  {
    const topicBindings = new Map();
    for (const f of classified) {
      let content;
      try { content = fs.readFileSync(f.full, 'utf8'); } catch (_) { continue; }
      if (content.length > 400000) continue;
      try {
        for (const [k, v] of collectTopicBindings(f.rel, content)) {
          if (!topicBindings.has(k)) topicBindings.set(k, v);
        }
      } catch (_) { /* a binding sweep must never fail an ingest */ }
    }
    let pubs = 0, subs = 0, stamped = 0, unresolved = 0;
    for (const f of classified) {
      let content;
      try { content = fs.readFileSync(f.full, 'utf8'); } catch (_) { continue; }
      if (content.length > 400000) continue;
      let facts;
      try { facts = extractTopicFacts(f.rel, content, { bindings: topicBindings }); }
      catch (tErr) { console.warn(`[ingest] [TOPIC_FACTS] ${f.rel}: ${tErr.message}`); continue; }
      if (!facts.publishes.length && !facts.subscribes.length) continue;
      unresolved += [...facts.publishes, ...facts.subscribes].filter(x => !x.topic).length;
      const payload = {
        topic_publishes: facts.publishes,
        topic_subscribes: facts.subscribes,
        topic_is_test: facts.isTest,
      };
      try {
        const { rowCount } = await pool.query(
          `UPDATE nodes AS n SET properties = json_merge(coalesce(n.properties, '{}'), $3)
             FROM files fl
            WHERE fl.id = n.file_id AND n.repository_branch_id = $1 AND n.node_type = 'FILE'
              AND fl.path = $2 AND n.approval_status <> 'ARCHIVED'`,
          [branchId, f.rel, JSON.stringify(payload)],
        );
        if (rowCount) { stamped++; pubs += facts.publishes.length; subs += facts.subscribes.length; }
      } catch (uErr) {
        console.warn(`[ingest] [TOPIC_FACTS] stamp ${f.rel}: ${uErr.message}`);
      }
    }
    if (stamped) {
      console.log(`[ingest] topic facts: ${stamped} file(s) stamped, ${pubs} publish(es), ${subs} subscribe(s), ${unresolved} unresolved, ${topicBindings.size} binding(s)`);
    }
  }


  // Reap the files that vanished. A FULL ingest re-walks what exists now, so a file deleted
  // since the last ingest is simply never visited — its row stayed COMPLETE and its nodes stayed
  // APPROVED forever. archiveDeletedFileNodes existed for exactly this and only the incremental
  // path called it. Measured on sindresorhus/got across 500 real commits: 10+ phantom files under
  // source/ holding 52 phantom declaration names after a --full re-ingest, which made deleted
  // symbols read as alive to every consumer — retrieval, overview, and the practice layer's
  // orphan check, whose whole contract is positive evidence of deletion.
  //
  // Membership is decided conservatively: a path is reaped only if the walk did not see it AND it
  // is gone from disk. The walk's view alone would archive oversize-skipped and policy-skipped
  // files that still exist.
  {
    const seen = new Set(filePaths);
    const { rows: dbFiles } = await pool.query(
      "SELECT path FROM files WHERE repository_branch_id = $1 AND index_status != 'REMOVED'",
      [branchId],
    );
    const goneFromDisk = dbFiles
      .map((r) => r.path)
      .filter((rel) => !seen.has(rel) && !fs.existsSync(path.join(resolvedPath, rel)));
    if (goneFromDisk.length) {
      const reaped = await archiveDeletedFileNodes(branchId, goneFromDisk);
      console.log(`[ingest] reaped ${goneFromDisk.length} deleted file(s), ${reaped} node(s) archived`);
    }
  }

  await reconcileCoverageNodeCounts(jobId, branchId);
  markPhase('secondary_passes');

  const tailResult = await runIngestPostTail({
    mode: 'full',
    projectId,
    branchId,
    repoId,
    repoPath: resolvedPath,
    resolvedStack,
    pending,
    jobId,
    updateJobFn: updateJob,
    skipMethodTextIndex: _skipMethodTextIndex,
    activateGenerationId: ingestGenerationId,
    carryForwardTouchedFileIds: touchedFileIds,
    invalidation: {
      edgesChanged: true,
      methodTextStale: true,
      summariesStale: true,
      graphHealthStale: true,
      communitiesStale: true,
      couplingStale: true,
      lspStale: true,
      projectCrossRepoStale: true,
    },
    logPrefix: '[ingest]',
    deferCoChange,
  });

  // sourceCacheFailures already drives the job to DEGRADED via evaluateIngestGates'
  // source_verification gate, but nothing ever explained it — the job read DEGRADED with
  // coverage_warning NULL (M44). Must run after every tail pass, since the generic-AST,
  // doc, contract and presence-floor writers all increment this counter above.
  if (counters.sourceCacheFailures > 0) {
    const cacheFailClause = `; ${counters.sourceCacheFailures} file(s) failed to persist retrievable source text (source cache / text chunk write failed) — retrieval will find nothing in them; see each file's coverage reason`;
    coverageWarning = (coverageWarning || '') + cacheFailClause;
    await updateJob(jobId, { coverage_warning: coverageWarning });
    console.warn(`[ingest] [SOURCE_CACHE_FAILURES] ${counters.sourceCacheFailures} file(s) failed to persist source text`);
  }

  await pool.query(
    `UPDATE repository_branches SET last_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1`,
    [branchId]
  );
  markPhase('post_tail');

  const jobResult = await completeIngestJob({
    jobId,
    projectId,
    branchId,
    repoId,
    filesExtractable: extractable.length,
    semanticFilesSeen: toProcess.length,
    counters,
    tailResult,
    touchedFileIds,
    ingestGenerationId,
    beforeSnapshot: beforeGenerationSnapshot,
  });
  markPhase('complete_job');
  phases.total = +((Date.now() - phaseClock) / 1000).toFixed(2);
  console.log(`[ingest] [PHASE] ${Object.entries(phases).map(([k, v]) => `${k}=${v}s`).join(' ')}`);

  console.log(`[ingest] done=${counters.done} skipped=${counters.skipped} errors=${counters.errors} degradedPasses=${(tailResult.degradedPasses || []).length} nodes=${counters.nodes} astEdges=${counters.astEdgesWritten} llmEdges=${tailResult.edgesWritten} crossEdges=${tailResult.crossEdgesWritten} propEdges=${tailResult.propEdgesWritten} relImportEdges=${tailResult.relImportEdgesWritten} methodTexts=${tailResult.methodTextsWritten}`);

  return {
    phases,
    done: counters.done,
    skipped: counters.skipped,
    errors: counters.errors,
    degradedPasses: tailResult.degradedPasses || [],
    nodes: counters.nodes,
    edgesWritten: tailResult.edgesWritten,
    edgesRefusedAmbiguous: tailResult.edgesRefusedAmbiguous || 0,
    astEdgesWritten: counters.astEdgesWritten,
    crossEdgesWritten: tailResult.crossEdgesWritten || 0,
    propEdgesWritten: tailResult.propEdgesWritten || 0,
    relImportEdgesWritten: tailResult.relImportEdgesWritten || 0,
    moduleStemResolved: tailResult.moduleStemResolved || 0,
    globalLabelResolved: tailResult.globalLabelResolved || 0,
    receiverImportResolved: tailResult.receiverImportResolved || 0,
    receiverTypeResolved: tailResult.receiverTypeResolved || 0,
    importStubsResolved: tailResult.importStubsResolved || 0,
    importStubEdgesRewired: tailResult.importStubEdgesRewired || 0,
    postResolutionUpgraded: tailResult.postResolutionUpgraded || 0,
    decoratedByWritten: tailResult.decoratedByWritten || 0,
    metaclassWritten: tailResult.metaclassWritten || 0,
    partialOfWritten: tailResult.partialOfWritten || 0,
    typeReferencesWritten: tailResult.typeReferencesWritten || 0,
    reExportsWritten: tailResult.reExportsWritten || 0,
    methodTextsWritten: tailResult.methodTextsWritten || 0,
    coChangeDeferred: tailResult.coChangeDeferred || false,
    repoId,
    branchId,
    coveragePct,
    unresolvedEdges: tailResult.unresolvedEdges,
    filesSkippedOversize: oversizeSkips.length,
    parseFailures: counters.parseFailures,
    parseFailureSample: counters.parseFailureSample,
    llmCacheMisses: counters.llmCacheMisses,
    llmErrorSample: counters.llmErrorSample,
    schemaRepairAttempts: counters.schemaRepairAttempts,
    schemaRepairRecovered: counters.schemaRepairRecovered,
    schemaRepairFailed: counters.schemaRepairFailed,
    extractionDecisions: counters.extractionDecisions,
    extractionCacheHits: counters.extractionCacheHits || 0,
    extractionCacheMisses: counters.extractionCacheMisses || 0,
    ingestGenerationId,
  };
  } catch (ingestErr) {
    if (ingestGenerationId) {
      await failGeneration(ingestGenerationId, { error: ingestErr.message }).catch(() => {});
      await quarantineFailedGeneration(ingestGenerationId).catch(() => {});
    }
    throw ingestErr;
  }
}

// ─── Archive nodes for deleted source files ───────────────────────────────────
//
// Sets approval_status='ARCHIVED' for all nodes whose source file was deleted
// or renamed. Archives all node types (CLASS, ENDPOINT, METHOD, etc.) — ENDPOINT
// nodes are archived here because they carry the controller's file_id, not a
// separate file_id of their own.
//
// Also marks the corresponding files rows as REMOVED so they are excluded
// from future ingest scans without requiring a full re-walk.
//
// Returns the count of nodes archived.

async function archiveDeletedFileNodes(branchId, removedPaths, _pool = pool) {
  if (!removedPaths || removedPaths.length === 0) return 0;

  // json_each, not one placeholder per path: the two queries below already do this, and a
  // `git rm -r vendor/` webhook with >32,765 removed paths would otherwise blow the parameter
  // ceiling on the one statement that archives their nodes.
  const result = await _pool.query(
    `UPDATE nodes SET approval_status = 'ARCHIVED', last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE file_id IN (
       SELECT id FROM files
       WHERE repository_branch_id = $1 AND path IN (SELECT value FROM json_each($2))
     ) AND approval_status != 'ARCHIVED'`,
    [branchId, removedPaths]
  );
  const archived = result.rowCount || 0;

  await _pool.query(
    `DELETE FROM edges
     WHERE from_node_id IN (
       SELECT n.id FROM nodes n
       JOIN files f ON f.id = n.file_id
       WHERE f.repository_branch_id = $1 AND f.path IN (SELECT value FROM json_each($2))
         AND n.approval_status = 'ARCHIVED'
     ) OR to_node_id IN (
       SELECT n.id FROM nodes n
       JOIN files f ON f.id = n.file_id
       WHERE f.repository_branch_id = $1 AND f.path IN (SELECT value FROM json_each($2))
         AND n.approval_status = 'ARCHIVED'
     )`,
    [branchId, removedPaths]
  );

  await _pool.query(
    `UPDATE files SET index_status = 'REMOVED'
     WHERE repository_branch_id = $1 AND path IN (SELECT value FROM json_each($2))`,
    [branchId, removedPaths]
  );

  logger.info(`[archiveDeletedFileNodes] branch=${branchId} archived=${archived} files=${removedPaths.length}`);
  return archived;
}

// ─── Project-level cross-repo edge resolution ────────────────────
//
// After all branch-scoped ingest work completes, resolve cross-service CALLS edges
// between repos in the same project using HTTP path suffix matching, Flutter/Angular
// API client pairing, SERVICE http_calls traversal, and EXTERNAL_SYSTEM matching.
//
// Branches are grouped by compatible branch_role (PRODUCTION↔MAIN, DEVELOPMENT↔STAGING, etc.)
// or an explicit declared revision set. No arbitrary fallback across incompatible roles.
async function resolveProjectCrossRepoEdges(projectId, _pool = pool, options = {}) {
  if (!projectId) return { created: 0, skipped: 0, tierCount: 0 };

  const { rows: branches } = await _pool.query(
    `SELECT rb.id AS branch_id, rb.branch_name, rb.branch_role, rb.repository_id
     FROM repository_branches rb
     JOIN repositories r ON r.id = rb.repository_id
     WHERE r.project_id = $1`,
    [projectId]
  );

  const branchGroups = buildCrossRepoBranchGroups(branches, options);

  if (branchGroups.length === 0) {
    logger.info(`[resolveProjectCrossRepoEdges] projectId=${projectId} no compatible branch groups — skipping cross-repo resolution`);
    return { created: 0, skipped: 0, tierCount: 0 };
  }

  const { resolveEdges, resolveCrossRepoPackageEdges, resolveCrossRepoGrpcEdges, resolveCrossRepoTopicEdges } = require('./cross-repo-edge-resolver');
  const result = await resolveEdges(branchGroups);
  logger.info(`[resolveProjectCrossRepoEdges] projectId=${projectId} tiers=${result.tierCount} created=${result.created} skipped=${result.skipped} deleted=${result.deleted}`);

  // The HTTP plane above links repos that talk over REST. The package plane links repos that
  // share code — a library, a published package, a monorepo module — which produced zero edges
  // before it existed. It is project-scoped rather than tier-scoped because a published module
  // name is a property of the repository, not of a branch tier.
  const pkg = await resolveCrossRepoPackageEdges(projectId, _pool).catch((err) => {
    logger.error(`[resolveProjectCrossRepoEdges] package plane failed: ${err.message}`);
    return { moduleEdges: 0, symbolEdges: 0 };
  });
  result.packagePlane = pkg;
  result.created += (pkg.moduleEdges || 0) + (pkg.symbolEdges || 0);

  // The third coupling style: services that talk over a .proto contract rather than over REST or
  // a shared library. Same project scope and same reasoning as the package plane above.
  const grpc = await resolveCrossRepoGrpcEdges(projectId, _pool).catch((err) => {
    logger.error(`[resolveProjectCrossRepoEdges] gRPC plane failed: ${err.message}`);
    return { serviceEdges: 0, methodEdges: 0 };
  });
  result.grpcPlane = grpc;
  result.created += (grpc.serviceEdges || 0) + (grpc.methodEdges || 0);

  // The fourth: services coupled through a message broker, which share no contract file at all.
  const topics = await resolveCrossRepoTopicEdges(projectId, _pool).catch((err) => {
    logger.error(`[resolveProjectCrossRepoEdges] topic plane failed: ${err.message}`);
    return { topicEdges: 0 };
  });
  result.topicPlane = topics;
  result.created += (topics.topicEdges || 0);
  return result;
}

// ─── Incremental ingest (webhook-driven) ─────────────────────────────────────
//
// Re-extracts only the files listed in changedPaths and archives nodes for
// removedPaths. Called when a GitHub push webhook fires — avoids a full
// re-clone and full re-extraction of the entire repo.

// Two hazards this guards against.
//
// (a) Do NOT conflate "not already in canonical form" with "unsafe". Computing the canonical
// path and REJECTING the input unless the raw string already equals it drops `./src/a.ts`,
// `src//a.ts`, `src/./a.ts`, `src/sub/../a.ts` and `src/a.ts/` — every one legal, unambiguous
// and resolving inside the checkout — so a webhook that sends any of those forms silently
// loses the file. The canonical form is USED rather than used as a rejection test, and the
// genuine safety checks (empty, NUL, escape above the root, absolute, symlinked component)
// are unchanged.
//
// (b) Rejections must not go only to console.warn while `files_total` is computed from the
// filtered set — a run that dropped half its input would report files_total == files_done and
// look complete. The caller receives the rejections and records them on the job.
function filterIncrementalPaths(repoPath, relPaths, { rejectSymlinks = false, label = 'path' } = {}) {
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  const root = path.resolve(repoPath);
  const reject = (rawPath, reason) => {
    rejected.push({ path: typeof rawPath === 'string' ? rawPath : String(rawPath), reason, label });
    console.warn(`[incremental] rejected ${reason} ${label}: ${JSON.stringify(rawPath)}`);
  };

  for (const rawPath of relPaths || []) {
    if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0')) {
      reject(rawPath, 'malformed');
      continue;
    }

    const slashPath = rawPath.replace(/\\/g, '/');
    const normalized = path.posix.normalize(slashPath);
    const fullPath = path.resolve(root, ...normalized.split('/'));
    const canonical = path.relative(root, fullPath).split(path.sep).join('/');
    const outsideRoot = canonical === '' || canonical === '..' || canonical.startsWith('../') || path.isAbsolute(canonical);
    if (outsideRoot) {
      reject(rawPath, 'outside_root');
      continue;
    }

    let containsSymlink = false;
    if (rejectSymlinks) {
      let cursor = root;
      for (const segment of canonical.split('/')) {
        cursor = path.join(cursor, segment);
        try {
          if (fs.lstatSync(cursor).isSymbolicLink()) {
            containsSymlink = true;
            break;
          }
        } catch (err) {
          if (err?.code === 'ENOENT') break;
          containsSymlink = true;
          break;
        }
      }
    }
    if (containsSymlink) {
      reject(rawPath, 'symlink');
      continue;
    }

    if (!seen.has(canonical)) {
      seen.add(canonical);
      accepted.push(canonical);
    }
  }

  return { accepted, rejected };
}

async function runIncrementalIngest({
  repoPath, projectId, repoId, branchId, branchName,
  changedPaths, removedPaths, newCommitSha, jobId, _skipMethodTextIndex = false,
}) {
  const resolvedPath = path.resolve(repoPath);
  await awaitTreeSitterReady();
  const changedFilter = filterIncrementalPaths(resolvedPath, changedPaths, {
    rejectSymlinks: true,
    label: 'changed path',
  });
  const removedFilter = filterIncrementalPaths(resolvedPath, removedPaths, {
    label: 'removed path',
  });
  const safeChangedPaths = changedFilter.accepted;
  const safeRemovedPaths = removedFilter.accepted;
  const rejectedPaths = [...changedFilter.rejected, ...removedFilter.rejected];
  // A rejected REMOVAL is the worse of the two — the file is gone from the repo but its nodes
  // stay live in the graph forever, and nothing downstream can tell. Called out separately
  // from a rejected change, which merely means the file was not re-extracted.
  const rejectedRemovals = removedFilter.rejected;

  const { snapshotBranchCounts, writeGraphDiff } = require('./graph-diff');
  const beforeSnapshot = await snapshotBranchCounts(branchId).catch(() => ({ nodeCount: 0, edgeCount: 0 }));

  const archived = await archiveDeletedFileNodes(branchId, safeRemovedPaths);

  const { rows: repoRows } = await pool.query(
    'SELECT stack, name FROM repositories WHERE id = $1', [repoId]
  );
  const resolvedStack = repoRows[0]?.stack || 'BACKEND';
  const repoName = repoRows[0]?.name || '';
  const { rows: projRows } = await pool.query(
    'SELECT name FROM projects WHERE id = $1', [projectId]
  );
  const projectName = projRows[0]?.name || '';

  await updateJob(jobId, {
    status: 'RUNNING',
    error_msg: null,
    // files_total must be the count BEFORE filtering, not `safeChangedPaths.length` — a run
    // that dropped half its input would otherwise finish with files_total == files_done and
    // look complete. The job reports what it was ASKED to do; the gap between this and
    // files_done is exactly the rejected set, spelled out in coverage_warning below.
    files_total: Array.isArray(changedPaths) ? changedPaths.length : safeChangedPaths.length,
    detected_stack: resolvedStack,
  });

  if (rejectedPaths.length > 0) {
    const sample = rejectedPaths.slice(0, 10).map((r) => `${r.path} (${r.label}: ${r.reason})`).join(', ');
    const removalClause = rejectedRemovals.length > 0
      ? `; ${rejectedRemovals.length} of them were REMOVALS whose nodes remain live in the graph`
      : '';
    const rejectionClause = `${rejectedPaths.length} incremental path(s) rejected${removalClause}: ${sample}`;
    console.warn(`[incremental] [REJECTED_PATHS] ${rejectionClause}`);
    await updateJob(jobId, { coverage_warning: rejectionClause });
  }

  const { counters, pending } = createFileProcessorState();
  const ignorePatterns = loadIgnorePatterns(resolvedPath);
  const ingestPolicy = loadIngestPolicy(resolvedPath);

  const shaSkipEnabled = process.env.INCREMENTAL_SHA_SKIP !== 'false';
  let storedFileShas = new Map();
  if (shaSkipEnabled && safeChangedPaths.length > 0) {
    const { rows: shaRows } = await pool.query(
      `SELECT path, file_sha FROM files WHERE repository_branch_id = $1 AND path IN (SELECT value FROM json_each($2))`,
      [branchId, safeChangedPaths]
    );
    for (const r of shaRows) {
      if (r.file_sha) storedFileShas.set(r.path, r.file_sha);
    }
  }

  let ingestGenerationId = null;
  try {
    const commitSha = newCommitSha || gitSha(resolvedPath);
    const ingestGeneration = await beginGeneration({
      projectId,
      repositoryId: repoId,
      branchId,
      revisionSha: commitSha,
      config: { stack: resolvedStack, mode: 'incremental' },
    });
    ingestGenerationId = ingestGeneration.id;

    const touchedFileIds = [];

    for (const relPath of safeChangedPaths) {
      const fullPath = path.join(resolvedPath, relPath);
      const extractResult = await extractIngestFile({
        relPath,
        fullPath,
        stack: resolvedStack,
        ignorePatterns,
        policy: ingestPolicy,
        storedFileSha: storedFileShas.get(relPath) || null,
        shaSkipEnabled,
        counters,
        logPrefix: '[incremental]',
      });

      if (extractResult.status === 'skipped' || extractResult.status === 'sha_skipped') {
        continue;
      }

      await commitIngestFile({
        extractResult,
        upsertFileFn: upsertFile,
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
        updateJobFn: updateJob,
        writeAstEdges,
        logPrefix: '[incremental]',
      }).then((commitResult) => {
        if (commitResult?.status === 'done' && commitResult.fileId) {
          touchedFileIds.push(commitResult.fileId);
        }
        return commitResult;
      });
    }

    const importsByFileId = new Map();
    for (const entry of pending.pendingImportFacts || []) {
      if (!entry || !entry.fileId || !entry.imports?.length) continue;
      const existing = importsByFileId.get(entry.fileId);
      if (existing) existing.push(...entry.imports);
      else importsByFileId.set(entry.fileId, [...entry.imports]);
    }

    for (const fileId of touchedFileIds) {
      const { rows: [fileRow] } = await pool.query(
        `SELECT path, file_sha FROM files
          WHERE id = $1 AND repository_branch_id = $2`,
        [fileId, branchId]
      );
      if (!fileRow) continue;
      const { rows: [cacheRow] } = await pool.query(
        `SELECT content FROM file_source_cache
          WHERE file_id = $1 AND content IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`,
        [fileId]
      );
      const content = cacheRow?.content ?? null;
      const presentation = content !== null ? computeFloorPresentation(content) : null;
      const fileImports = importsByFileId.get(fileId);
      await writeNode(
        {
          node_type: 'FILE', name: fileRow.path,
          summary: presentation ? presentation.summary : null,
          raw_evidence: presentation ? presentation.raw_evidence : null,
          confidence_tier: 'EXTRACTED', provenance: 'presence_floor',
          start_line: 1,
          end_line: content !== null ? content.split('\n').length : undefined,
          ...(presentation ? presentation.properties : {}),
          ...(fileImports ? { imports: fileImports } : {}),
        },
        fileId, branchId, fileRow.file_sha, ingestGenerationId
      );
      counters.nodes++;
    }

    // Accumulate these, as the full path already does, so a run with two problems reports both
    // rather than only the last.
    let incrementalWarning = null;
    if (counters.parseFailures > 0) {
      const { text: parseFailClause, astRescued, trulyLost } = formatParseFailureClause(counters);
      incrementalWarning = (incrementalWarning || '') + parseFailClause;
      await updateJob(jobId, { coverage_warning: incrementalWarning });
      console.warn(`[incremental] [PARSE_FAILURE] ${counters.parseFailures} file(s) failed LLM semantic extraction (${astRescued} AST-rescued, ${trulyLost} fully lost): ${counters.parseFailureSample.join(', ')}`);
    }

    if (counters.degradedFiles > 0) {
      const degradedClause = `; ${counters.degradedFiles} file(s) marked DEGRADED (zero nodes, unparseable extraction, no AST coverage): ${(counters.degradedFileSample || []).join(', ')}`;
      incrementalWarning = (incrementalWarning || '') + degradedClause;
      await updateJob(jobId, { coverage_warning: incrementalWarning });
      console.warn(`[incremental] [DEGRADED_FILES] ${counters.degradedFiles} file(s) degraded: ${(counters.degradedFileSample || []).join(', ')}`);
    }

    if (newCommitSha) {
      await pool.query(
        `UPDATE repository_branches SET last_commit_sha = $1, last_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $2`,
        [newCommitSha, branchId]
      );
    }

    const tailResult = await runIngestPostTail({
      mode: 'incremental',
      projectId,
      branchId,
      repoId,
      repoPath: resolvedPath,
      resolvedStack,
      pending,
      jobId,
      updateJobFn: updateJob,
      skipMethodTextIndex: _skipMethodTextIndex,
      activateGenerationId: ingestGenerationId,
      carryForwardTouchedFileIds: touchedFileIds,
      invalidation: {
        edgesChanged: true,
        methodTextStale: true,
        summariesStale: true,
        graphHealthStale: false,
        communitiesStale: false,
        couplingStale: false,
        lspStale: false,
        projectCrossRepoStale: true,
      },
      logPrefix: '[incremental]',
    });

    // Same M44 gap as the full path: commitIngestFile is shared, so a webhook-driven
    // incremental goes DEGRADED on a source-cache failure through the same gate — and,
    // until this, with the same silent coverage_warning.
    if (counters.sourceCacheFailures > 0) {
      const cacheFailClause = `; ${counters.sourceCacheFailures} file(s) failed to persist retrievable source text (source cache / text chunk write failed) — retrieval will find nothing in them; see each file's coverage reason`;
      incrementalWarning = (incrementalWarning || '') + cacheFailClause;
      await updateJob(jobId, { coverage_warning: incrementalWarning });
      console.warn(`[incremental] [SOURCE_CACHE_FAILURES] ${counters.sourceCacheFailures} file(s) failed to persist source text`);
    }

    const jobResult = await completeIngestJob({
      jobId,
      projectId,
      branchId,
      repoId,
      filesExtractable: safeChangedPaths.length,
      semanticFilesSeen: safeChangedPaths.length,
      counters,
      tailResult,
      touchedFileIds,
      ingestGenerationId,
      beforeSnapshot,
    });

    console.log(`[incremental] done=${counters.done} skipped=${counters.skipped} errors=${counters.errors} degradedPasses=${(tailResult.degradedPasses || []).length} nodes=${counters.nodes} archived=${archived} astEdges=${counters.astEdgesWritten} llmEdges=${tailResult.edgesWritten} propEdges=${tailResult.propEdgesWritten} methodTexts=${tailResult.methodTextsWritten}`);

    await writeGraphDiff({
      ingestJobId: jobId,
      branchId,
      before: beforeSnapshot,
      nodesAdded: counters.nodes,
      nodesArchived: archived,
    }).catch((err) => console.error(`[incremental] writeGraphDiff failed: ${err.message}`));

    return {
      done: counters.done,
      skipped: counters.skipped,
      shaSkipped: counters.shaSkipped,
      errors: counters.errors,
      degradedPasses: tailResult.degradedPasses || [],
      nodes: counters.nodes,
      archived,
      edgesWritten: tailResult.edgesWritten,
      edgesRefusedAmbiguous: tailResult.edgesRefusedAmbiguous || 0,
      moduleStemResolved: tailResult.moduleStemResolved || 0,
      globalLabelResolved: tailResult.globalLabelResolved || 0,
      receiverImportResolved: tailResult.receiverImportResolved || 0,
    receiverTypeResolved: tailResult.receiverTypeResolved || 0,
      importStubsResolved: tailResult.importStubsResolved || 0,
      importStubEdgesRewired: tailResult.importStubEdgesRewired || 0,
      postResolutionUpgraded: tailResult.postResolutionUpgraded || 0,
        decoratedByWritten: tailResult.decoratedByWritten || 0,
    metaclassWritten: tailResult.metaclassWritten || 0,
    partialOfWritten: tailResult.partialOfWritten || 0,
    typeReferencesWritten: tailResult.typeReferencesWritten || 0,
    reExportsWritten: tailResult.reExportsWritten || 0,
      methodTextsWritten: tailResult.methodTextsWritten || 0,
      parseFailures: counters.parseFailures,
      parseFailureSample: counters.parseFailureSample,
      llmCacheMisses: counters.llmCacheMisses,
      llmErrorSample: counters.llmErrorSample,
      schemaRepairAttempts: counters.schemaRepairAttempts,
      schemaRepairRecovered: counters.schemaRepairRecovered,
      schemaRepairFailed: counters.schemaRepairFailed,
      ingestGenerationId,
    };
  } catch (incrErr) {
    if (ingestGenerationId) {
      await failGeneration(ingestGenerationId, { error: incrErr.message }).catch(() => {});
      await quarantineFailedGeneration(ingestGenerationId).catch(() => {});
    }
    await updateJob(jobId, {
      status: 'FAILED',
      error_msg: incrErr.message.slice(0, 2000),
      nodes_written: 0,
    }).catch(() => {});
    throw incrErr;
  }
}

module.exports = { walkRepo, runIngest, writeDirectoryHierarchy, runIncrementalIngest, validateRepoUrl, gitBranch, gitSha, gitTopLevel, writeAstEdges, writeContainsEdges, writeMethodPropertyEdges, resolveOverrideEdges, resolveMethodOwnerEdges, resolveDecoratedByEdges, resolveMetaclassEdges, resolveTypeReferenceEdges, resolveReExportEdges, resolveHttpClientEdges, detectWorkspacePackages, resolveInheritedColumns, writeConfigValueRefEdges, resolveEntityTableEdges, archiveDeletedFileNodes, resolveProjectCrossRepoEdges, resolveAndWriteEdges, resolveImportStubEdges, resolveImportFacts, resolveCrossRepoEdges, writeRelativeImportEdges, writeSqlReferenceEdges, resolveCallExpressionEdges, writeLspEdges: _writeLspEdges, persistCoverageFiles, updateCoverageFileTier, updateCoverageFileTierBulk, backfillLlmSemanticNodeCounts, resolveExtractionTiers, reconcileCoverageNodeCounts, CODE_EXTS_BY_STACK, findZeroNodeExtractedFiles, FLOOR_ELIGIBLE_SKIP_REASONS, computeFloorPresentation, formatParseFailureClause, computeBinaryStubPresentation, writeNode, normalizeNodeProvenanceProps, configNodeEligibility };
