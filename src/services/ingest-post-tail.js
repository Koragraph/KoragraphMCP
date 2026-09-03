'use strict';

const { writeMethodTextIndex } = require('./method-text-index');
const { runInheritanceReresolve, linkCrossFileConstructs } = require('./resolution/post-resolution');

async function runIngestPostTail({
  mode = 'full',
  projectId,
  branchId,
  repoId,
  repoPath,
  resolvedStack,
  pending,
  jobId = null,
  updateJobFn = null,
  skipMethodTextIndex = false,
  activateGenerationId = null,
  carryForwardTouchedFileIds = null,
  invalidation = {},
  logPrefix = '[ingest]',
  deferCoChange = false,
}) {
  const {
    edgesChanged = true,
    methodTextStale = true,
    summariesStale = true,
    couplingStale = mode === 'full',
    lspStale = mode === 'full',
    projectCrossRepoStale = true,
  } = invalidation;

  const ingest = require('./ingest');
  const {
    resolveAndWriteEdges,
    resolveImportStubEdges,
    resolveCrossRepoEdges,
    writeMethodPropertyEdges,
    writeContainsEdges,
    writeDirectoryHierarchy,
    resolveOverrideEdges,
    resolveMethodOwnerEdges,
    resolveDecoratedByEdges,
    resolveMetaclassEdges,
    resolveHttpClientEdges,
    resolveEntityTableEdges,
    resolveInheritedColumns,
    resolveProjectCrossRepoEdges,
    writeLspEdges,
  } = ingest;

  const pendingEdges = pending?.pendingEdges || [];
  const pendingRelativeImports = pending?.pendingRelativeImports || [];
  const pendingSqlRefs = pending?.pendingSqlRefs || [];
  const pendingConfigRefs = pending?.pendingConfigRefs || [];
  const pendingTypeReferences = pending?.pendingTypeReferences || [];
  const pendingReExports = pending?.pendingReExports || [];

  let edgesWritten = 0;
  let unresolvedEdges = [];
  let edgesRefusedAmbiguous = 0;
  let crossEdgesWritten = 0;
  let propEdgesWritten = 0;
  let relImportEdgesWritten = 0;
  let moduleStemResolved = 0;
  let globalLabelResolved = 0;
  let receiverImportResolved = 0;
  let receiverTypeResolved = 0;
  let importStubsResolved = 0;
  let importStubEdgesRewired = 0;
  let containsEdgesWritten = 0;
  let postResolutionUpgraded = 0;
  let decoratedByWritten = 0;
  let metaclassWritten = 0;
  let partialOfWritten = 0;
  let typeReferencesWritten = 0;
  let reExportsWritten = 0;
  let coChangeDeferred = false;

  // The `.catch()` on every pass below is deliberate — one broken resolver must not cost the
  // whole graph — but a console.error is not a report. resolveCallExpressionEdges hitting
  // SQLite's parameter ceiling printed one line and the ingest still ended "done ... errors=0"
  // with the entire intra-repo CALLS plane missing. Degrading stays; degrading silently does not.
  const degradedPasses = [];
  const soften = (pass, fallback, level = 'error') => (err) => {
    degradedPasses.push({ pass, error: err.message });
    console[level](`${logPrefix} ${pass} failed: ${err.message}`);
    return fallback;
  };

  if (edgesChanged) {
    const edgeResult = await resolveAndWriteEdges(pendingEdges, branchId);
    edgesWritten = edgeResult.written;
    unresolvedEdges = edgeResult.unresolvedEdges || [];
    edgesRefusedAmbiguous = edgeResult.ambiguousRefused || 0;
    moduleStemResolved = edgeResult.moduleStemResolved || 0;
    globalLabelResolved = edgeResult.globalLabelResolved || 0;
    receiverImportResolved = edgeResult.receiverImportResolved || 0;
    receiverTypeResolved = edgeResult.receiverTypeResolved || 0;

    crossEdgesWritten = await resolveCrossRepoEdges(unresolvedEdges, projectId, branchId).catch(soften('resolveCrossRepoEdges', 0));

    propEdgesWritten = await writeMethodPropertyEdges(branchId).catch(soften('writeMethodPropertyEdges', 0));

    // A full ingest touches every file, so scoping would just recompute the same unscoped query
    // through an extra IN-list — only an incremental pass has a genuinely small touched set worth
    // scoping to. See resolveCallExpressionEdges' own header comment for what scoping does and
    // does not cover, and the accepted staleness gap it trades for the speedup.
    const callScope = mode === 'incremental' && Array.isArray(carryForwardTouchedFileIds)
      && carryForwardTouchedFileIds.length ? carryForwardTouchedFileIds : null;
    await ingest.resolveCallExpressionEdges(branchId, callScope).catch(soften('resolveCallExpressionEdges'));

    // Must run BEFORE resolveOverrideEdges: that pass walks DEFINED_IN to pair a child's methods
    // with its parent's, so a method whose owner lives in another file was invisible to it too.
    await resolveMethodOwnerEdges(branchId).catch(soften('resolveMethodOwnerEdges'));

    await resolveOverrideEdges(branchId).catch(soften('resolveOverrideEdges'));

    // Reads properties.decorators off already-written METHOD/CLASS nodes and the branch-wide
    // file-scoped import index — belongs alongside resolveOverrideEdges as a post-write
    // structural pass (it has no dependency beyond nodes+edges already being current, same as
    // override resolution).
    decoratedByWritten = await resolveDecoratedByEdges(branchId).catch(soften('resolveDecoratedByEdges', 0));

    // python.js records `metaclass=Y` evidence as `properties.metaclass` payload only (no
    // inline edge) — same post-write same-file/import resolution shape as
    // resolveDecoratedByEdges immediately above, so it belongs right beside it.
    metaclassWritten = await resolveMetaclassEdges(branchId).catch(soften('resolveMetaclassEdges', 0));

    // Same same-file/import-evidence post-write shape as resolveDecoratedByEdges/
    // resolveMetaclassEdges above, for declared field TYPE references (REFERENCES) queued in
    // pendingTypeReferences during the per-file pass.
    typeReferencesWritten = await ingest.resolveTypeReferenceEdges(pendingTypeReferences, branchId).catch(soften('resolveTypeReferenceEdges', 0));

    // FILE-to-FILE RE_EXPORTS, resolved against the branch's own FILE nodes — independent of
    // the name-resolution waterfall, same "pure structural fact" shape as
    // writeContainsEdges/linkCrossFileConstructs.
    reExportsWritten = await ingest.resolveReExportEdges(pendingReExports, branchId).catch(soften('resolveReExportEdges', 0));

    // Cross-file C# `partial` CLASS linking — pure structural fact (name + `partial` modifier
    // match across files), independent of the name-resolution waterfall, same as
    // writeContainsEdges below.
    partialOfWritten = await linkCrossFileConstructs(branchId).catch(soften('linkCrossFileConstructs', 0));

    // Zero-token post-resolution pass — upgrades HEURISTIC_CALLS (tier 8/9) edges whose
    // called_name resolves uniquely (directly, or via EXTENDS/IMPLEMENTS reachability from a
    // type the caller's file imports) to tier 10 CALLS. postResolutionUpgraded is threaded
    // through tailResult AND runIngest's/runIncrementalIngest's own return.
    postResolutionUpgraded = await runInheritanceReresolve(branchId).catch(soften('runInheritanceReresolve', 0));

    // Pure structural fact (file_id match), independent of the name-resolution waterfall
    // above — safe to run on every edgesChanged pass, idempotent via ON CONFLICT DO NOTHING.
    containsEdgesWritten = await writeContainsEdges(branchId).catch(soften('writeContainsEdges', 0));

    await resolveHttpClientEdges(branchId, projectId).catch(soften('resolveHttpClientEdges'));

    const relImportResult = await ingest.writeRelativeImportEdges(pendingRelativeImports, branchId).catch(soften('writeRelativeImportEdges', { written: 0, unresolvedImports: [] }));
    relImportEdgesWritten = relImportResult.written || 0;
    unresolvedEdges.push(...(relImportResult.unresolvedImports || []));

    // repoPath activates resolve.js's on-disk tsconfig-alias and
    // workspace-package/`exports` tiers — see buildOnDiskResolutionOpts.
    // `resolveImportStubEdges` is kept as an alias for `resolveImportFacts` — it reads
    // FILE.properties.imports facts instead of IMPORT stub nodes (retired) and also upserts
    // DEPENDENCY nodes for external packages.
    const importStubResult = await resolveImportStubEdges(branchId, undefined, { repoPath }).catch(soften('resolveImportStubEdges', { resolved: 0, edgesRewired: 0 }));
    importStubsResolved = importStubResult.resolved || 0;
    importStubEdgesRewired = importStubResult.edgesRewired || 0;

    await ingest.writeSqlReferenceEdges(pendingSqlRefs, branchId).catch(soften('writeSqlReferenceEdges'));

    await ingest.writeConfigValueRefEdges(pendingConfigRefs, branchId).catch(soften('writeConfigValueRefEdges'));

    // The view layer. Runs after CONFIG_VALUE/ENDPOINT/METHOD nodes exist,
    // because every edge it writes is an exact match against one of them.
    if (repoPath) {
      const { resolveTemplateEdges } = require('./template-graph');
      await resolveTemplateEdges(branchId, repoPath).catch(soften('resolveTemplateEdges'));
      const { resolveSqlFileTableEdges } = require('./sql-file-graph');
      await resolveSqlFileTableEdges(branchId, repoPath).catch(soften('resolveSqlFileTableEdges'));

      // The "why" layer. Binds by line span, so it runs after every METHOD and
      // CLASS node exists and after spans have been harvested.
      const { resolveRationaleNodes } = require('./rationale-graph');
      const rationaleResult = await resolveRationaleNodes(branchId, repoPath, activateGenerationId).catch(soften('resolveRationaleNodes', { nodes: 0 }));
      // writeContainsEdges ran before these DOC nodes existed, and a rationale
      // node with no FILE -[CONTAINS]-> edge is an orphan no traversal reaches.
      // Idempotent (ON CONFLICT DO NOTHING), so re-running it only fills the gap.
      if (rationaleResult?.nodes > 0) {
        containsEdgesWritten += await writeContainsEdges(branchId).catch(soften('writeContainsEdges (rationale)', 0));
      }

      // Two features independently model the same "why" layer, and only one of them links it.
      // ast-extractor.js emits node_type='RATIONALE' for every docstring it sees, and nothing
      // ever writes an edge for those. resolveRationaleNodes above re-reads the same docstrings
      // and emits node_type='DOC' bound to the declaration it documents. The result is the same
      // text stored twice: once traversable, once inert.
      //
      // Measured on requests (project 15229, 1944 nodes): 305 RATIONALE nodes, 286 of them
      // byte-identical to a DOC node in the same file, 100% of them with no non-containment
      // edge. That is 15% of the graph's nodes duplicated, and it inflated both the node count
      // and the semantic orphan rate.
      //
      // HARD-DELETE the duplicates, do not archive them: a RATIONALE is retired only when a DOC
      // node in the SAME FILE carries the same text, so kinds the rationale parser does not produce
      // (todo/fixme markers, module-level docstrings with no owning declaration) survive. Deletion
      // rather than archival because the duplicate is re-extracted from astNodes on every ingest and
      // the canonical-key upsert cannot resurrect an ARCHIVED row (the partial index excludes them),
      // so archiving here accumulated a fresh tombstone every `--full` — measured +17/round on
      // unchanged express, unbounded. A DOC-covered duplicate carries no non-containment edge and no
      // consumer reads an archived RATIONALE (cross-repo-edge-resolver only reaps cross-repo edges,
      // which it never has; practice/resolve.js excludes the type), so deleting it loses nothing the
      // traversable DOC does not already hold. Its containment edge goes with it.
      const { rows: dupRows } = await require('../db/pool').query(
        `DELETE FROM nodes
          WHERE id IN (
            SELECT r.id FROM nodes r
             WHERE r.repository_branch_id = $1
               AND r.node_type = 'RATIONALE'
               AND r.approval_status != 'ARCHIVED'
               AND EXISTS (
                 SELECT 1 FROM nodes d
                  WHERE d.repository_branch_id = r.repository_branch_id
                    AND d.node_type = 'DOC'
                    AND d.file_id IS r.file_id
                    AND d.approval_status != 'ARCHIVED'
                    AND substr(d.summary, 1, 120) = substr(r.summary, 1, 120)))
          RETURNING id`,
        [branchId]
      ).catch(soften('rationale dedupe', { rows: [] }));
      const rationaleDupes = dupRows.length;
      if (rationaleDupes > 0) {
        await require('../db/pool').query(
          `DELETE FROM edges WHERE from_node_id IN (SELECT value FROM json_each($1)) OR to_node_id IN (SELECT value FROM json_each($1))`,
          [JSON.stringify(dupRows.map((r) => r.id))]
        ).catch(soften('rationale dedupe edges', { rowCount: 0 }));
        console.log(`${logPrefix} deleted ${rationaleDupes} duplicate RATIONALE node(s) already covered by a linked DOC node`);
      }
    }

    // Runs LAST of the containment passes, so every FILE node that will exist already does.
    // A file whose parser produced nothing has no child to hang from; the directory spine is
    // what keeps it reachable instead of degree-0.
    if (typeof writeDirectoryHierarchy === 'function') {
      const dirResult = await writeDirectoryHierarchy(branchId).catch(soften('writeDirectoryHierarchy', { directories: 0, edges: 0 }));
      containsEdgesWritten += dirResult.edges || 0;
    }

    // Runs after resolveImportFacts has minted the import-side DEPENDENCY
    // nodes and after the manifest pass has written the declared-side ones —
    // it joins the two, so both must already exist.
    const { resolveDeclaredDependencyEdges } = require('./dependency-graph');
    await resolveDeclaredDependencyEdges(branchId).catch(soften('resolveDeclaredDependencyEdges'));

    // Makes the semantic plane walkable: an ENDPOINT whose only edge is
    // FILE -[CONTAINS]-> can be searched but not traversed, so "what code
    // handles this route" stopped at the file. Pure database join over
    // decorators already stored on the METHOD nodes.
    const { resolveEndpointHandlerEdges } = require('./endpoint-graph');
    await resolveEndpointHandlerEdges(branchId).catch(soften('resolveEndpointHandlerEdges'));

    // Joins the structural node (CLASS/METHOD) to the LLM plane's role node
    // (SERVICE/REPOSITORY/ANGULAR_SERVICE/...) for the same declaration. Callers
    // bind to the structural node while the role node owns the semantic edges,
    // so without this every such pair is a break in the graph — 122 of them on
    // the petclinic demo project alone. Must run AFTER the LLM plane's nodes
    // exist, hence its position here rather than in the write path.
    const { resolveSemanticPlaneJoins } = require('./plane-join');
    await resolveSemanticPlaneJoins(branchId).catch(soften('resolveSemanticPlaneJoins'));

    const JAVA_STACKS = new Set(['BACKEND', 'JAVA_SPRING', 'ANDROID', 'KOTLIN']);
    // analyzeRepo's internal JDTLS_TIMEOUT_MS races real JVM/workspace-index startup time,
    // which is load-dependent — a reproduced source of run-to-run CALLS-count divergence (e.g.
    // 86, 200 and 0 lsp-resolved CALLS across three runs of ONE unchanged spring-petclinic
    // checkout). This is deliberate graceful degradation, not a bug — the LSP layer is
    // best-effort and must stay that way for real ingests.
    //
    // Therefore OPT-IN (LSP_ANALYSIS=on), not on by default: a plane whose output varies run
    // to run cannot be on by default in a tool whose claim is a byte-identical ingest. The cost
    // is also real — on a cold workspace jdtls can burn the whole timeout ceiling and return
    // ZERO edges, turning a 2 s ingest into a multi-minute one for nothing. jdtls's own header
    // budgets 5-10 minutes for a cold workspace, so the ceiling is not the problem and lowering
    // it would only cut the analysis earlier — the default is.
    if (lspStale && JAVA_STACKS.has(resolvedStack) && repoPath && process.env.LSP_ANALYSIS === 'on') {
      try {
        const { analyzeRepo } = require('./lsp/java-lsp-client');
        // A timeout ceiling below what jdtls needs on a cold workspace (its own header budgets
        // 5-10 min for dep download and indexing) cuts the run mid-analysis and returns
        // whatever the clock allowed — the source of the run-to-run CALLS spread. That spread
        // is the jdtls session, not this repo — raising the ceiling helps the cold case and
        // does nothing for a session that hangs, so it is a knob (LSP_TIMEOUT_MS), not a fix,
        // and the outcome is logged every run instead of vanishing into a swallowed catch.
        //
        // Treat the LSP plane as a best-effort ENRICHMENT, never as substrate:
        // a branch whose experiments depend on tier-2 CALLS being present must
        // check this count, and LSP_ANALYSIS=off is the way to take the whole
        // source of variance out of a determinism run.
        const lspTimeoutMs = Number(process.env.LSP_TIMEOUT_MS) > 0
          ? Number(process.env.LSP_TIMEOUT_MS)
          : 180_000;
        const lspStart = Date.now();
        // cacheKey: repoId is stable across runs of the same repo, unlike repoPath,
        // which is a fresh clone/extract dir every ingest (see M33 note in the LSP client).
        const lspEdges = await analyzeRepo(repoPath, { timeoutMs: lspTimeoutMs, cacheKey: repoId });
        const lspSecs = ((Date.now() - lspStart) / 1000).toFixed(1);
        if (lspEdges.length === 0) {
          console.warn(`${logPrefix} LSP analysis returned 0 edges in ${lspSecs}s (ceiling ${lspTimeoutMs}ms) — this branch is missing its tier-2 CALLS plane and is NOT comparable to a branch where LSP completed`);
        } else {
          console.log(`${logPrefix} LSP analysis: ${lspEdges.length} edge(s) in ${lspSecs}s (ceiling ${lspTimeoutMs}ms)`);
        }
        if (lspEdges.length) {
          await writeLspEdges(lspEdges, branchId, repoPath);
        }
      } catch (err) {
        soften('LSP analysis', undefined, 'warn')(err);
      }
    }
  }

  if (summariesStale) {
    await resolveInheritedColumns(branchId).catch(soften('resolveInheritedColumns'));
    await resolveEntityTableEdges(branchId).catch(soften('resolveEntityTableEdges'));
  }

  let methodTextResult = { written: 0, archived: 0, expected: 0 };

  if (methodTextStale && !skipMethodTextIndex) {
    methodTextResult = await writeMethodTextIndex({ repositoryBranchId: branchId }).catch(soften('method text index', { written: 0, archived: 0, expected: 0 }));
  } else if (skipMethodTextIndex) {
    console.log(`${logPrefix} skipMethodTextIndex=true — skipping writeMethodTextIndex`);
  }

  if (projectCrossRepoStale) {
    await resolveProjectCrossRepoEdges(projectId).catch(soften('resolveProjectCrossRepoEdges'));
  }

  if (couplingStale && repoPath) {
    const { analyzeCoupling } = require('./git-coupling-analyzer');
    await analyzeCoupling(repoPath, branchId).catch(soften('git-coupling', undefined, 'warn'));

    // Declaration-grain co-change (CO_CHANGES). No `until` here — production has no "future"
    // to leak from, so the whole history is read; a temporally-split benchmark's cutoff exists
    // only to keep the gold honest.
    //
    // This mine is 50-84% of an ingest's wall time. `deferCoChange` moves it OFF this critical
    // path: the caller (the CLI) commits and reports the structural graph, then spawns a detached
    // worker that merges the same CO_CHANGES plane in the background (see cochange-defer.js). The
    // in-process mine here stays the default so the MCP/webhook path and the tests are unchanged.
    if (process.env.COCHANGE_EDGES !== 'off') {
      if (deferCoChange) {
        coChangeDeferred = true;
      } else {
        const { mineCoChangeEdges } = require('./cochange-miner');
        const { coChangeMineOptions } = require('./cochange-defer');
        await mineCoChangeEdges(repoPath, branchId, coChangeMineOptions()).then((r) => {
          console.log(`${logPrefix} cochange branchId=${branchId} ${JSON.stringify(r)}`);
        }).catch(soften('cochange', undefined, 'warn'));
      }
    }
  }

  // Test-coverage and infrastructure-topology planes. Both are additive and neither may take an
  // ingest down, so the pass itself is softened — but a module that fails to LOAD is a different
  // thing from a pass that found nothing, and swallowing it silently is how a whole edge plane
  // stops being written with `errors=0`. The require is reported at the same level as the pass.
  for (const [module, fn] of [['coverage-graph', 'processCoverageArtifacts'], ['config-infra-graph', 'resolveConfigInfraGraph']]) {
    let run = null;
    try {
      run = require(`./${module}`)[fn];
    } catch (err) {
      soften(module, undefined, 'warn')(err);
    }
    if (typeof run === 'function') {
      await run({ repoPath, branchId }).catch(soften(module, undefined, 'warn'));
    }
  }

  // Chunk retention: runs on every post-tail — full AND incremental — so pruning covers both
  // call sites in ingest.js. The new generation
  // (activateGenerationId) has not been activated yet (that happens later, in
  // finalizeIngestJob) so it is unioned onto the currently-active set: rows this run just
  // wrote carry that id, and must not be treated as "not active" while validation is pending.
  let chunksPruned = 0;
  try {
    const { getActiveGenerationIds } = require('./ingest-generation-service');
    const { pruneSupersededChunks } = require('./lexical-text-store');
    const activeMap = await getActiveGenerationIds([branchId]);
    const activeGenerationIds = [...new Set([...activeMap.values(), activateGenerationId].filter((id) => Number.isFinite(id)))];
    const pruneResult = await pruneSupersededChunks({ branchId, activeGenerationIds });
    chunksPruned = pruneResult.deleted;
  } catch (err) {
    soften('pruneSupersededChunks', undefined, 'warn')(err);
  }

  if (degradedPasses.length) {
    console.error(`${logPrefix} DEGRADED: ${degradedPasses.length} pass(es) did not complete — the graph is missing whatever they write. ${degradedPasses.map((d) => `${d.pass} (${d.error})`).join('; ')}`);
  }

  return {
    degradedPasses,
    edgesWritten,
    unresolvedEdges,
    unresolvedEdgeCount: unresolvedEdges.length,
    edgesRefusedAmbiguous,
    crossEdgesWritten,
    propEdgesWritten,
    relImportEdgesWritten,
    moduleStemResolved,
    globalLabelResolved,
    receiverImportResolved,
    receiverTypeResolved,
    importStubsResolved,
    importStubEdgesRewired,
    containsEdgesWritten,
    postResolutionUpgraded,
    decoratedByWritten,
    metaclassWritten,
    partialOfWritten,
    typeReferencesWritten,
    reExportsWritten,
    methodTextsWritten: methodTextResult.written,
    methodTextsArchived: methodTextResult.archived,
    coChangeDeferred,
    activateGenerationId,
    carryForwardTouchedFileIds,
    chunksPruned,
  };
}

module.exports = { runIngestPostTail };
