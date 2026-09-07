// Cross-Repo Edge Resolver
//
// Second pass, after every repository in a project has been ingested: draws the edges that
// could not exist while each repo was walked on its own. Matching is scoped to a branch tier,
// so a node on one repo's feature branch only matches other repos' feature branches, never
// main. Callers supply `branchGroups: branchId[][]`.
//
// ── What it links ────────────────────────────────────────────────────────────
//
//   Source A  →  Target B  (different repo, same tier)
//
//   Priority 0c — SPA client module → ENDPOINT  (frontend → backend)
//     ANGULAR_* / REACT_* client modules emit CALLS whose to_name is an HTTP path
//     ("POST /api/v1/..."). No node in the frontend repo carries that name, so the edge is
//     stored unresolved (to_node_id NULL). This step suffix-matches properties.to_name
//     against ENDPOINT nodes in another repo in the same tier and UPDATEs the edge to point
//     at the backend ENDPOINT.
//
//   Priority 1 — ENDPOINT → ENDPOINT  (preferred)
//     When repo A's ENDPOINT calls a SERVICE method that has an http_call to an ENDPOINT
//     path in repo B, the edge is drawn ENDPOINT(A) → ENDPOINT(B): "this API in repo A
//     triggers this API in repo B".
//     Back-trace: ENDPOINT(A) → [CALLS edge] → SERVICE(A).method → http_calls → ENDPOINT(B)
//     Fallback: if no ENDPOINT caller is found for the service method, the edge falls back
//     to SERVICE(A) → ENDPOINT(B).
//
//   Priority 2 — EXTERNAL_SYSTEM → SERVICE
//     EXTERNAL_SYSTEM nodes are matched by name against SERVICE nodes in other repos, so a
//     named outside dependency in one repo connects to the service that implements it in
//     another.
//
//   Priority 3 — SERVICE → SERVICE  (fallback)
//     When only a service-name http_call target is present (no path).
//
// ── Stale-only delete ────────────────────────────────────────────────────────
//
//   Only cross_repo_resolved edges whose FROM or TO node is ARCHIVED are deleted before
//   re-resolution. Valid existing edges (both nodes still APPROVED) are preserved and
//   excluded from re-insertion via the insertedEdges dedup set, so re-running this pass is
//   idempotent: it adds what is missing and cleans up what is stale.

const pool = require('../db/pool');
const { bulkWrite } = require('../db/bulk');
const { edgeWriteTier } = require('./resolution/tiers');

// ─── Path normalization helpers ───────────────────────────────────────────────

const VERSION_RE = /^v\d+$/i;

// Split a URL path into lowercase non-empty segments, stripping query strings,
// trailing slashes, and version segments (v1, v2, v3 …).
// A path-parameter segment in any of the spellings the extractors emit:
//   Spring/OpenAPI {ownerId} · Express/Angular:ownerId · Flask/Django <int:pk> or <pk>
const PLACEHOLDER_RE = /^(?:\{.*\}|:.+|<.*>|#\{.*\}|\$\{.*\})$/;

function normalizePathSegments(rawPath) {
  if (!rawPath) return [];
  const clean = rawPath
    .toLowerCase()
    .replace(/\?.*$/, '')   // strip query string
    .replace(/\/+$/, '');   // strip trailing slash
  return clean
    .split('/')
    .filter(s => s && !VERSION_RE.test(s))
    // The NAME of a path parameter is arbitrary — a client calling /pettypes/{typeId} and a
    // backend exposing /api/pettypes/{petTypeId} are the same route, and exact segment
    // equality was refusing them. Canonicalise every placeholder to one token so position,
    // not spelling, decides the match. `endpoint-graph.js` already does this for the
    // endpoint->handler join; cross-repo matching was the one place still comparing names.
    .map(s => (PLACEHOLDER_RE.test(s) ? '{}' : s));
}

// Extract the URL path portion from an http_calls[].target string.
// Handles three patterns:
//   "https://domain/path"     → "/path"
//   "ServiceName /path"       → "/path"
//   "/path"                   → "/path"
//   "ServiceName"             → null  (service-name-only, no path)
function extractPathFromTarget(target) {
  if (!target) return null;
  const t = target.trim();

  if (/^https?:\/\//i.test(t)) {
    try {
      return new URL(t).pathname;
    } catch {
      return null;
    }
  }

  const spacePathMatch = t.match(/\s+(\/\S+)/);
  if (spacePathMatch) return spacePathMatch[1];

  if (t.startsWith('/')) return t;

  return null;  // service name only — no extractable path
}

// Return the path segments of an ENDPOINT node name like "POST /api/v1/pin/change".
function endpointNameToSegments(endpointName) {
  const pathPart = endpointName.replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/i, '');
  return normalizePathSegments(pathPart);
}

// endpointNameToSegments() strips the HTTP verb so a path can be compared, which means the
// verb is then invisible to every caller that only looks at segments. Matching on path alone
// and using the first hit would, on a REST resource exposing GET/POST/PUT/DELETE on one path,
// wire a read-only client to whichever endpoint happened to be indexed first — a client
// performing only `GET /api/orders` could resolve to `DELETE /api/orders`, and a client
// calling PATCH (a verb the backend does not expose at all) would still get an edge.
// Returns the uppercase verb, or null when the name carries none (in which case callers must
// fall back to path-only matching rather than invent a verb).
function endpointVerb(endpointName) {
  const m = /^(GET|POST|PUT|PATCH|DELETE)\s+/i.exec(endpointName || '');
  return m ? m[1].toUpperCase() : null;
}

// True when a client's declared HTTP method and an endpoint's verb are known to disagree.
// Unknown on EITHER side is not a disagreement — an http_call with no recorded method, or an
// ENDPOINT named without a verb prefix, must keep the pre-existing path-only behaviour so
// this change can only ever remove wrong edges, never correct ones.
function verbsConflict(callMethod, endpointName) {
  const a = typeof callMethod === 'string' ? callMethod.trim().toUpperCase() : null;
  const b = endpointVerb(endpointName);
  if (!a || !b) return false;
  return a !== b;
}

// True if targetSegs is a contiguous SUFFIX of endpointSegs.
// "/api/pin/change" (3 segs) matches endpoint "/api/v1/pin/change" (stripped → 3 segs).
// "/change" (1 seg) does NOT match "/api/pin/change-request" — exact segment equality.
function isSuffixMatch(targetSegs, endpointSegs) {
  if (targetSegs.length === 0 || endpointSegs.length === 0) return false;
  if (endpointSegs.length < targetSegs.length) return false;
  const offset = endpointSegs.length - targetSegs.length;
  return targetSegs.every((s, i) => s === endpointSegs[offset + i]);
}

// ─── Core resolver (single tier) ─────────────────────────────────────────────
// Resolves edges within ONE branch tier (e.g., all dev branches).
// Matching is strictly intra-tier: nodes in branch A only match nodes in OTHER
// branches within the same tier array.

async function resolveTier(tierBranchIds, insertedEdges) {
  if (tierBranchIds.length < 2) {
    return {
      created: 0, skipped: 0,
      resolutionStats: {
        candidates: 0, resolved: 0,
        unresolved_by_reason: { no_path: 0, same_repo_guard: 0, no_candidate: 0, zero_segments: 0 },
        ambiguous: 0, false_positive_guarded: 0,
        edge_type_counts: {
          spa_http_to_endpoint: 0,
          service_http_to_endpoint: 0, service_name_to_service: 0, external_system_to_service: 0,
        },
      },
    };
  }

  // ── Load all node sets needed for matching ──────────────────────────────────

  // SERVICE nodes with methods (source of http_calls)
  const { rows: serviceNodes } = await pool.query(
    `SELECT n.id, n.name, n.repository_branch_id,
            json_extract(n.properties, '$.methods') AS methods
     FROM nodes n
     WHERE n.repository_branch_id IN (SELECT value FROM json_each($1))
       AND n.node_type IN ('SERVICE', 'NODE_SERVICE')
       AND n.approval_status = 'APPROVED'
       AND json_extract(n.properties, '$.methods') IS NOT NULL`,
    [tierBranchIds]
  );

  // ENDPOINT nodes — both as match targets and as sources (back-traced callers)
  // `has_handler` distinguishes an endpoint backed by real code from one that
  // only exists because a spec file declared it. Both are legitimate ENDPOINT
  // nodes and the same route routinely appears as both — spring-petclinic-rest
  // publishes `GET /owners` from `src/main/resources/openapi.yml` AND
  // `GET /api/owners` from `OwnerRestControllerV1.java`. Binding a client to
  // the spec node produces an edge that is true but terminal: the spec node has
  // no handler, so the walk dies one hop later. See the preference order at the
  // Step 0c match loop.
  const { rows: endpointRows } = await pool.query(
    `SELECT n.id, n.name, n.repository_branch_id,
            EXISTS (SELECT 1 FROM edges h
                     WHERE h.from_node_id = n.id AND h.edge_type = 'MAPS_TO') AS has_handler
     FROM nodes n
     WHERE n.repository_branch_id IN (SELECT value FROM json_each($1))
       AND n.node_type = 'ENDPOINT'
       AND n.approval_status = 'APPROVED'`,
    [tierBranchIds]
  );

  // SERVICE nodes — used as fallback name-match targets
  const { rows: serviceTargets } = await pool.query(
    `SELECT n.id, n.name, n.repository_branch_id
     FROM nodes n
     WHERE n.repository_branch_id IN (SELECT value FROM json_each($1))
       AND n.node_type IN ('SERVICE', 'NODE_SERVICE')
       AND n.approval_status = 'APPROVED'`,
    [tierBranchIds]
  );

  // EXTERNAL_SYSTEM nodes — matched by name to SERVICE nodes in other repos
  const { rows: externalSystemNodes } = await pool.query(
    `SELECT n.id, n.name, n.repository_branch_id
     FROM nodes n
     WHERE n.repository_branch_id IN (SELECT value FROM json_each($1))
       AND n.node_type = 'EXTERNAL_SYSTEM'
       AND n.approval_status = 'APPROVED'`,
    [tierBranchIds]
  );

  // CALLS edges from ENDPOINT → SERVICE within this tier (for back-tracing callers).
  // Indexed as: service_id::method_name → endpoint_id[]
  // This lets us swap SERVICE(A) → ENDPOINT(B) for ENDPOINT(A) → ENDPOINT(B).
  const { rows: epToSvcEdges } = await pool.query(
    `SELECT e.from_node_id AS endpoint_id,
            e.to_node_id   AS service_id,
            json_extract(e.properties, '$.method') AS method_name
     FROM edges e
     JOIN nodes ep  ON ep.id  = e.from_node_id
                        AND ep.node_type = 'ENDPOINT'
                        AND ep.approval_status = 'APPROVED'
                        AND ep.repository_branch_id IN (SELECT value FROM json_each($1))
     JOIN nodes svc ON svc.id = e.to_node_id
                        AND svc.node_type IN ('SERVICE', 'NODE_SERVICE')
                        AND svc.approval_status = 'APPROVED'
     WHERE e.edge_type = 'CALLS'
       AND e.to_node_id IS NOT NULL`,
    [tierBranchIds]
  );

  // Build caller map: service_id::method_name → Set<endpoint_id>
  // Also a wildcard key service_id::* for when method name is unavailable.
  const callerMap = {};   // key → Set<endpoint_id>
  for (const row of epToSvcEdges) {
    const methodKey   = `${row.service_id}::${row.method_name || '*'}`;
    const wildcardKey = `${row.service_id}::*`;
    if (!callerMap[methodKey])   callerMap[methodKey]   = new Set();
    if (!callerMap[wildcardKey]) callerMap[wildcardKey] = new Set();
    callerMap[methodKey].add(row.endpoint_id);
    callerMap[wildcardKey].add(row.endpoint_id);
  }

  // Pre-build endpoint index with path segments for fast suffix matching
  const endpointIndex = endpointRows.map(ep => ({
    ...ep,
    segments: endpointNameToSegments(ep.name),
  }));

  let created = 0;
  let skipped = 0;

  const resolutionStats = {
    candidates: 0,
    resolved: 0,
    unresolved_by_reason: { no_path: 0, same_repo_guard: 0, no_candidate: 0, zero_segments: 0 },
    ambiguous: 0,
    false_positive_guarded: 0,
    edge_type_counts: {
      spa_http_to_endpoint: 0,
      service_http_to_endpoint: 0,
      service_name_to_service: 0,
      external_system_to_service: 0,
    },
  };

  // ── Helper: insert one cross-repo edge, deduped ─────────────────────────────
  //
  // Cross-repository name/path matching remains heuristic evidence, so
  // edgeWriteTier records it as tier 8 HEURISTIC_CALLS. Before this writer was
  // tiered, this INSERT wrote no
  // `properties`, `resolution_tier`, or `confidence` at all — a live
  // provenance-less writer the original 1c pass missed because it only
  // enumerated `INSERT INTO edges` inside ingest.js, not the full
  // `src/services/**/*.js` glob the slice's own bullet specified.
  async function insertEdge(fromNodeId, toNodeId, httpTarget) {
    const key = `${fromNodeId}::${toNodeId}`;
    if (insertedEdges.has(key)) return;
    insertedEdges.add(key);
    const derived = edgeWriteTier('cross_repo', 'CALLS');
    const props = { source_tag: 'cross_repo_resolved', http_target: httpTarget, resolution: 'cross_repo' };
    await pool.query(
      `INSERT INTO edges
         (from_node_id, to_node_id, edge_type, confidence_tier, is_cross_repo, properties, resolution_tier, confidence)
       VALUES ($1, $2, $3, $4, true, $5, $6, $7)
       ON CONFLICT (from_node_id, to_node_id, edge_type)
         WHERE to_node_id IS NOT NULL
       DO NOTHING`,
      [fromNodeId, toNodeId, derived.edgeType, derived.label, JSON.stringify(props), derived.tier, derived.confidence]
    );
    created++;
  }

  // ── Step 0c: Unresolved HTTP-shaped CALLS from SPA client modules → ENDPOINT
  //
  // React and Angular API modules emit CALLS whose to_name is "METHOD /path"; no node in the
  // frontend repo carries that name, so the edge is written unresolved. Link it to the backend
  // ENDPOINT in a different branch within this tier by path-suffix match.

  const { rows: reactUnresolvedHttpEdges } = await pool.query(
    `SELECT e.id, e.from_node_id, trim(json_extract(e.properties, '$.to_name')) AS to_name,
            fn.repository_branch_id AS from_branch_id
     FROM edges e
     JOIN nodes fn ON fn.id = e.from_node_id
        AND fn.node_type IN ('ANGULAR_SERVICE', 'ANGULAR_COMPONENT', 'REACT_SERVICE', 'REACT_COMPONENT')
        AND fn.approval_status = 'APPROVED'
        AND fn.repository_branch_id IN (SELECT value FROM json_each($1))
     WHERE e.edge_type = 'CALLS'
       AND e.to_node_id IS NULL
       AND COALESCE(json_extract(e.properties, '$.unresolved'), '') = 'true'
       AND regexp_i('^(GET|POST|PUT|PATCH|DELETE)\\s+/', json_extract(e.properties, '$.to_name'))`,
    [tierBranchIds]
  );

  let reactHttpResolved = 0;
  for (const row of reactUnresolvedHttpEdges) {
    resolutionStats.candidates++;
    const toName = row.to_name;
    if (!toName) {
      resolutionStats.unresolved_by_reason.no_candidate++;
      skipped++;
      continue;
    }
    const clientSegs = endpointNameToSegments(toName);
    if (clientSegs.length === 0) {
      resolutionStats.unresolved_by_reason.zero_segments++;
      skipped++;
      continue;
    }

    // The verb guard applies here as well as to Step 1 (http_calls -> ENDPOINT): matching on
    // path alone and taking the first hit would, on a REST resource exposing
    // GET/POST/PUT/DELETE at one path, wire a read-only client to whichever endpoint was
    // indexed first (e.g. Angular `GET /owners` bound to `POST /owners`). Same helper, same
    // "unknown on either side is not a disagreement" rule, so this can only remove wrong edges.
    const clientVerb = endpointVerb(toName);
    let matchedEndpointId = null;
    let matchCount = 0;
    // Suffix matching is deliberately loose (a client's /pin/change must reach /api/v1/pin/change),
    // so one client call routinely matches several endpoints — 30 of 30 were ambiguous on the
    // petclinic demo project. Two things decide which one wins, in this order:
    //
    //   1. an endpoint BACKED BY CODE beats a spec-only endpoint. `GET /owners` (from
    //      openapi.yml, no handler, no evidence) and `GET /api/owners` (from
    //      OwnerRestControllerV1.java) are the same route; binding the client to the spec node
    //      is true but terminal, and measured here it broke the walk exactly one hop past the
    //      cross-repo edge.
    //   2. then the CLOSEST path — fewest extra leading segments. Taking the first indexed hit
    //      bound `PUT /pets/{petId}` to the nested `PUT /api/owners/{ownerId}/pets/{petId}`
    //      while the backend exposes `PUT /pets/{petId}` exactly.
    //
    // Index order breaks a genuine tie, so the choice stays deterministic.
    let best = null;
    for (const ep of endpointIndex) {
      if (ep.repository_branch_id === row.from_branch_id) continue;
      if (verbsConflict(clientVerb, ep.name)) continue;
      if (!isSuffixMatch(clientSegs, ep.segments)) continue;
      matchCount++;
      const cand = { id: ep.id, handler: ep.has_handler ? 1 : 0, extra: ep.segments.length - clientSegs.length };
      if (best === null
          || cand.handler > best.handler
          || (cand.handler === best.handler && cand.extra < best.extra)) {
        best = cand;
      }
    }
    matchedEndpointId = best ? best.id : null;
    if (matchCount > 1) resolutionStats.ambiguous++;

    if (!matchedEndpointId) {
      resolutionStats.unresolved_by_reason.no_candidate++;
      skipped++;
      continue;
    }

    const dupKey = `${row.from_node_id}::${matchedEndpointId}`;
    if (insertedEdges.has(dupKey)) {
      await pool.query(`DELETE FROM edges WHERE id = $1 AND to_node_id IS NULL`, [row.id]);
      continue;
    }

    const { rows: existingResolved } = await pool.query(
      `SELECT id FROM edges
       WHERE from_node_id = $1 AND to_node_id = $2 AND edge_type = 'CALLS'`,
      [row.from_node_id, matchedEndpointId]
    );
    if (existingResolved.length > 0) {
      await pool.query(`DELETE FROM edges WHERE id = $1 AND to_node_id IS NULL`, [row.id]);
      continue;
    }

    const mergedProps = JSON.stringify({
      to_name: toName,
      source_tag: 'cross_repo_resolved',
      http_target: toName,
    });

    const upd = await pool.query(
      `UPDATE edges
       SET to_node_id = $2,
           is_cross_repo = true,
           properties = json_merge(json_remove(COALESCE(properties, '{}'), '$.unresolved'), $3)
       WHERE id = $1
         AND edge_type = 'CALLS'
         AND to_node_id IS NULL`,
      [row.id, matchedEndpointId, mergedProps]
    );

    if (upd.rowCount > 0) {
      reactHttpResolved++;
      insertedEdges.add(dupKey);
      resolutionStats.edge_type_counts.spa_http_to_endpoint++;
      resolutionStats.resolved++;
    }
  }

  created += reactHttpResolved;

  // ── Step 1: SERVICE method http_calls → ENDPOINT or SERVICE in another repo ──
  //
  // For each matched http_call target, prefer ENDPOINT(A) → target as source
  // by back-tracing which ENDPOINT(s) in repo A call this service method.
  // Falls back to SERVICE(A) → target when no caller endpoint is found.

  for (const svcNode of serviceNodes) {
    const methods = svcNode.methods;
    if (!methods || typeof methods !== 'object') continue;

    for (const [methodName, method] of Object.entries(methods)) {
      const httpCalls = method.http_calls;
      if (!Array.isArray(httpCalls) || httpCalls.length === 0) continue;

      for (const call of httpCalls) {
        const target = call.target;
        if (!target) continue;

        resolutionStats.candidates++;
        let matchedNodeId = null;
        let resolvedByPath = false;

        // Priority 1: path suffix match — ENDPOINT in a DIFFERENT repo, same tier
        const targetPath = extractPathFromTarget(target);
        if (targetPath) {
          const targetSegs = normalizePathSegments(targetPath);
          if (targetSegs.length > 0) {
            let matchCount = 0;
            for (const ep of endpointIndex) {
              if (ep.repository_branch_id === svcNode.repository_branch_id) continue;
              // The HTTP verb discriminates before the path does. A client that only GETs
              // must not be wired to the DELETE on the same resource. Skipped only when BOTH
              // sides state a verb and they differ, so an http_call with no method, or an
              // ENDPOINT named without a verb, is unaffected.
              if (verbsConflict(call.method, ep.name)) continue;
              if (isSuffixMatch(targetSegs, ep.segments)) {
                matchCount++;
                if (!matchedNodeId) { matchedNodeId = ep.id; resolvedByPath = true; }
              }
            }
            // Ambiguity must not be counted and then ignored — using the first match anyway
            // makes the chosen target a function of row order. The Step 0 path already refuses
            // on `matchCount > 1`; the http_calls path follows the same rule. Refuse rather
            // than fabricate.
            if (matchCount > 1) {
              resolutionStats.ambiguous++;
              matchedNodeId = null;
              resolvedByPath = false;
            }
          } else {
            resolutionStats.unresolved_by_reason.no_path++;
          }
        } else {
          resolutionStats.unresolved_by_reason.no_path++;
        }

        // Priority 2: SERVICE name match — different repo, same tier
        //
        // Guard: if the target name resolves to a service that already exists
        // locally in the same repo, it's an intra-repo call that has already
        // been captured as a normal CALLS edge — skip cross-repo matching.
        // Example: TopUpService.sendNotification → target "NotificationService"
        // topupservice HAS its own NotificationService → local call → skip.
        // Without this guard, "notificationservice" substring-matches every
        // other repo's NotificationService and creates 100+ false edges.
        //
        // Normalization: strip all whitespace before comparing, so LLM-generated
        // targets like "Notification Service" (with space) still match the actual
        // class name "NotificationService" (no space). This handles cases where
        // the LLM used a descriptive label instead of the exact class name.
        if (!matchedNodeId) {
          const targetNorm = target.toLowerCase().replace(/\s+/g, '');
          const isLocalServiceCall = serviceTargets.some(
            svc => svc.repository_branch_id === svcNode.repository_branch_id &&
                   targetNorm.includes(svc.name.toLowerCase().replace(/\s+/g, ''))
          );
          if (isLocalServiceCall) {
            resolutionStats.false_positive_guarded++;
            resolutionStats.unresolved_by_reason.same_repo_guard++;
          } else {
            for (const svc of serviceTargets) {
              if (svc.repository_branch_id === svcNode.repository_branch_id) continue;
              if (targetNorm.includes(svc.name.toLowerCase().replace(/\s+/g, ''))) {
                matchedNodeId = svc.id;
                break;
              }
            }
          }
        }

        // Priority 3: no match → skip (likely a true external system)
        if (!matchedNodeId) {
          resolutionStats.unresolved_by_reason.no_candidate++;
          skipped++;
          continue;
        }

        // Back-trace: find ENDPOINT(s) in THIS repo that call this specific method.
        // Prefer method-specific match; fall back to any caller of this service.
        const methodKey   = `${svcNode.id}::${methodName}`;
        const wildcardKey = `${svcNode.id}::*`;
        const callers = callerMap[methodKey] || callerMap[wildcardKey];

        if (callers && callers.size > 0) {
          // ENDPOINT(A) → matched target — the preferred "one endpoint calling another" edge
          for (const callerEpId of callers) {
            await insertEdge(callerEpId, matchedNodeId, target);
          }
          if (resolvedByPath) {
            resolutionStats.edge_type_counts.service_http_to_endpoint++;
          } else {
            resolutionStats.edge_type_counts.service_name_to_service++;
          }
        } else {
          // Fallback: SERVICE(A) → matched target (no endpoint caller found)
          await insertEdge(svcNode.id, matchedNodeId, target);
          if (resolvedByPath) {
            resolutionStats.edge_type_counts.service_http_to_endpoint++;
          } else {
            resolutionStats.edge_type_counts.service_name_to_service++;
          }
        }
        resolutionStats.resolved++;
      }
    }
  }

  // ── Step 2: EXTERNAL_SYSTEM nodes → SERVICE in another repo ─────────────────
  //
  // EXTERNAL_SYSTEM nodes are matched by name against SERVICE nodes in other repos. When a
  // match is found, the EXTERNAL_SYSTEM node "lights up" in the graph by
  // connecting to the real service it represents.

  for (const extNode of externalSystemNodes) {
    resolutionStats.candidates++;
    const extNameLower = extNode.name.toLowerCase();
    let matchedNodeId  = null;
    let matchCount = 0;

    for (const svc of serviceTargets) {
      if (svc.repository_branch_id === extNode.repository_branch_id) continue;
      // Match if either name contains the other, so a naming-case difference between the two
      // repos ("PaymentsAPI" ↔ "PaymentsApi") still links.
      if (extNameLower.includes(svc.name.toLowerCase()) ||
          svc.name.toLowerCase().includes(extNameLower)) {
        matchCount++;
        if (!matchedNodeId) matchedNodeId = svc.id;
      }
    }
    if (matchCount > 1) resolutionStats.ambiguous++;

    if (matchedNodeId) {
      await insertEdge(extNode.id, matchedNodeId, extNode.name);
      resolutionStats.edge_type_counts.external_system_to_service++;
      resolutionStats.resolved++;
    } else {
      resolutionStats.unresolved_by_reason.no_candidate++;
      skipped++;
    }
  }

  return { created, skipped, resolutionStats };
}

// ─── Public entry point ───────────────────────────────────────────────────────
//
// branchGroups: branchId[][] — each inner array is a same-tier set of branch IDs.
//   Example (a project with 3 repos):
//     [ [devBranch1, devBranch2, devBranch3],     ← dev tier
//       [masterBranch1, masterBranch2, masterBranch3] ]  ← baseline tier
//
// Behaviour:
//   1. Deletes stale cross_repo_resolved edges — those where the from or to node
//      is now ARCHIVED (replaced by a newer ingest).
//   2. Deletes same-repo cross_repo_resolved edges — always incorrect, arise from
//      service name collisions (e.g. topupservice → its own NotificationService).
//   3. Seeds the insertedEdges dedup set with all surviving valid edges so they
//      are not re-inserted (idempotent — safe to call multiple times).
//   4. Resolves new edges for any http_calls / EXTERNAL_SYSTEM matches not yet
//      covered by a surviving edge.

async function resolveEdges(branchGroups) {
  if (!branchGroups || branchGroups.length === 0) {
    return { created: 0, skipped: 0, tierCount: 0 };
  }

  const allBranchIds = [...new Set(branchGroups.flat())];
  if (allBranchIds.length === 0) {
    return { created: 0, skipped: 0, tierCount: 0 };
  }

  // ── Step A: Delete ONLY stale edges ──────────────────────────────────────────
  // A cross_repo_resolved edge is stale when its FROM or TO node has been
  // ARCHIVED (i.e. that node was re-ingested and replaced with a new node ID).
  // Valid edges (both nodes still APPROVED) are kept — they don't need rebuilding.
  const { rowCount: deleted } = await pool.query(
    `DELETE FROM edges
     WHERE json_extract(properties, '$.source_tag') = 'cross_repo_resolved'
       AND (
         from_node_id IN (
           SELECT id FROM nodes
           WHERE repository_branch_id IN (SELECT value FROM json_each($1)) AND approval_status = 'ARCHIVED'
         )
         OR
         to_node_id IN (
           SELECT id FROM nodes
           WHERE repository_branch_id IN (SELECT value FROM json_each($1)) AND approval_status = 'ARCHIVED'
         )
       )`,
    [allBranchIds]
  );

  // ── Step A2: Delete same-repo cross_repo_resolved edges — always wrong ────────
  // A cross_repo_resolved edge where FROM and TO nodes are in the same repo is
  // always incorrect. These arise when a service calls a local service that
  // happens to share its name with services in other repos (e.g. topupservice
  // endpoints → topupservice's own NotificationService, tagged is_cross_repo=true).
  // The Priority 2 guard prevents new ones from being created, but existing
  // ones must be removed explicitly since their nodes are still APPROVED.
  const { rowCount: deletedSameRepo } = await pool.query(
    `DELETE FROM edges
     WHERE json_extract(properties, '$.source_tag') = 'cross_repo_resolved'
       AND id IN (
         SELECT e.id
         FROM edges e
         JOIN nodes n1 ON n1.id = e.from_node_id
         JOIN nodes n2 ON n2.id = e.to_node_id
         WHERE n1.repository_branch_id = n2.repository_branch_id
           AND n1.repository_branch_id IN (SELECT value FROM json_each($1))
       )`,
    [allBranchIds]
  );

  // ── Step B: Seed dedup set with surviving valid edges ─────────────────────────
  // Any cross_repo_resolved edge that survived the stale-delete (both nodes
  // still APPROVED) is pre-loaded so we don't re-insert it.
  const insertedEdges = new Set();
  const { rows: existingEdges } = await pool.query(
    `SELECT e.from_node_id, e.to_node_id
     FROM edges e
     JOIN nodes fn ON fn.id = e.from_node_id AND fn.approval_status = 'APPROVED'
     JOIN nodes tn ON tn.id = e.to_node_id   AND tn.approval_status = 'APPROVED'
     WHERE json_extract(e.properties, '$.source_tag') = 'cross_repo_resolved'
       AND fn.repository_branch_id IN (SELECT value FROM json_each($1))`,
    [allBranchIds]
  );
  for (const e of existingEdges) {
    insertedEdges.add(`${e.from_node_id}::${e.to_node_id}`);
  }

  // ── Step C: Resolve new edges per tier ───────────────────────────────────────
  let totalCreated = 0;
  let totalSkipped = 0;
  const aggregatedStats = {
    candidates: 0,
    resolved: 0,
    unresolved_by_reason: { no_path: 0, same_repo_guard: 0, no_candidate: 0, zero_segments: 0 },
    ambiguous: 0,
    stale_deleted: deleted,
    same_repo_deleted: deletedSameRepo,
    false_positive_guarded: 0,
    edge_type_counts: {
      spa_http_to_endpoint: 0,
      service_http_to_endpoint: 0,
      service_name_to_service: 0,
      external_system_to_service: 0,
    },
  };

  for (const tierBranchIds of branchGroups) {
    const { created, skipped, resolutionStats } = await resolveTier(tierBranchIds, insertedEdges);
    totalCreated += created;
    totalSkipped += skipped;
    aggregatedStats.candidates += resolutionStats.candidates;
    aggregatedStats.resolved += resolutionStats.resolved;
    aggregatedStats.ambiguous += resolutionStats.ambiguous;
    aggregatedStats.false_positive_guarded += resolutionStats.false_positive_guarded;
    for (const [k, v] of Object.entries(resolutionStats.unresolved_by_reason)) {
      aggregatedStats.unresolved_by_reason[k] = (aggregatedStats.unresolved_by_reason[k] || 0) + v;
    }
    for (const [k, v] of Object.entries(resolutionStats.edge_type_counts)) {
      aggregatedStats.edge_type_counts[k] = (aggregatedStats.edge_type_counts[k] || 0) + v;
    }
  }

  console.log(
    `[cross-repo-resolver] ${deleted} stale + ${deletedSameRepo} same-repo edge(s) removed,` +
    ` ${totalCreated} new edge(s) created,` +
    ` ${totalSkipped} unmatched across ${branchGroups.length} tier(s), ${allBranchIds.length} branch(es)` +
    ` [fp_guarded=${aggregatedStats.false_positive_guarded} ambiguous=${aggregatedStats.ambiguous}]`
  );

  return {
    deleted:          deleted + deletedSameRepo,
    deletedStale:     deleted,
    deletedSameRepo:  deletedSameRepo,
    created:          totalCreated,
    skipped:          totalSkipped,
    tierCount:        branchGroups.length,
    branchCount:      allBranchIds.length,
    resolution_stats: aggregatedStats,
  };
}

// ─── Package plane: imports that cross a repository boundary ──────────────────
//
// Everything above this line links repositories through HTTP: a client CALLS edge named
// "POST /api/v1/thing" is suffix-matched against an ENDPOINT node in another repo. That is one
// real integration style and it is the only one the resolver could see. A shared library, a
// published package, a gRPC stub, a queue topic and a monorepo module boundary all produced
// exactly zero cross-repo edges — so for any organisation whose services are coupled by a common
// library rather than by REST, the graph asserted the repositories were unrelated.
//
// This plane closes the largest part of that. It is the same join Sourcegraph's SCIP uses for
// cross-repository go-to-definition: a symbol's identity is (package name, qualified symbol), so
// linking repositories is a join on the name each ecosystem's manifest already declares. We hold
// both graphs, so unlike an indexer we need no version dimension and no re-indexing of
// dependencies — only the two names, and both are read from manifests, never guessed.
//
// TWO GRAINS, and the second is the one that carries blast radius:
//
//   module  FILE(A) -[IMPORTS]-> FILE(B)          A imports the package B publishes. Coarse, and
//                                                 always available: it needs only the import
//                                                 statement and B's manifest.
//   symbol  FILE(A) -[IMPORTS_SYMBOL]-> decl(B)   A names a specific declaration B exports.
//                                                 This is what makes "rename this exported type,
//                                                 what breaks in the other repos" answerable.
//
// The symbol grain has two sources, because languages spell the same thing differently:
//   * an import fact that carries the symbol itself (`from lib import thing`, `import {thing}`)
//   * a qualified use of a package-scoped alias (`pflag.NewFlagSet`), which is how Go, and only
//     Go among these, spells it — the import binds a package name and the symbol appears at the
//     use site as a `receiver.callee` pair the extractor already records.
//
// Ambiguity is refused, not guessed: an exported name declared in more than one file of the
// target repo produces no symbol edge (the module edge still stands), because binding it would
// need the type resolution this layer does not have.
async function resolveCrossRepoPackageEdges(projectId, _pool = pool) {
  const { rows: repoRows } = await _pool.query(
    `SELECT r.id AS repo_id, r.published_modules, rb.id AS branch_id
       FROM repositories r
       JOIN repository_branches rb ON rb.repository_id = r.id
      WHERE r.project_id = $1 AND r.is_archived = false`,
    [projectId],
  );
  if (repoRows.length < 2) {
    return { moduleEdges: 0, symbolEdges: 0, providers: 0, reason: repoRows.length < 2 ? 'single_repo' : null };
  }

  // published module name -> provider branch. Longest first so `x/y` beats `x`.
  let providers = [];
  for (const r of repoRows) {
    const mods = Array.isArray(r.published_modules) ? r.published_modules : [];
    for (const m of mods) {
      if (m && typeof m.name === 'string' && m.name.trim()) {
        providers.push({ name: m.name.trim(), subdir: m.subdir || '', files: m.files || 0, branchId: r.branch_id, repoId: r.repo_id });
      }
    }
  }
  providers.sort((a, b) => b.name.length - a.name.length);
  if (!providers.length) return { moduleEdges: 0, symbolEdges: 0, providers: 0, reason: 'no_published_modules' };

  const branchIds = repoRows.map(r => r.branch_id);

  // Consumer side: every FILE node's recorded import facts.
  const { rows: fileRows } = await _pool.query(
    `SELECT n.id AS file_node_id, n.repository_branch_id AS branch_id,
            json_extract(n.properties, '$.imports') AS imports
       FROM nodes n
      WHERE n.repository_branch_id IN (SELECT value FROM json_each($1))
        AND n.node_type = 'FILE' AND n.approval_status <> 'ARCHIVED'
        AND json_type(n.properties, '$.imports') IS NOT NULL AND json_array_length(n.properties, '$.imports') > 0`,
    [branchIds],
  );

  // Provider side: exported declarations, and the repo-root FILE node used as the module anchor.
  const { rows: declRows } = await _pool.query(
    `SELECT n.id, n.name, n.node_type, n.repository_branch_id AS branch_id, f.path,
            json_extract(n.properties, '$.parent_class') AS owner
       FROM nodes n
       JOIN files f ON f.id = n.file_id
      WHERE n.repository_branch_id IN (SELECT value FROM json_each($1))
        AND n.node_type IN ('CLASS','INTERFACE','ENTITY','METHOD','CONSTANT','TYPE')
        AND n.approval_status <> 'ARCHIVED'`,
    [branchIds],
  );
  const declIndex = new Map(); // branchId -> name -> [nodes]
  for (const d of declRows) {
    if (!declIndex.has(d.branch_id)) declIndex.set(d.branch_id, new Map());
    const byName = declIndex.get(d.branch_id);
    if (!byName.has(d.name)) byName.set(d.name, []);
    byName.get(d.name).push(d);
  }
  const dirOfPath = (p) => {
    const i = (p || '').lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
  };

  // An exported name can be declared once per PACKAGE, and an import path names the package
  // directory — `github.com/spf13/afero/mem` is the `mem/` directory of the afero repo. So when
  // a name is declared in several files of the target repo, those files are in different
  // packages and the import path itself says which one is meant. Without this the resolver had
  // to refuse every such name as ambiguous: `afero.ReadFile` and `afero.Exists` are both
  // declared more than once across afero's packages, and both were silently dropped.
  const pickDecl = (branchId, name, importPath, provider) => {
    const cands = (declIndex.get(branchId) || new Map()).get(name) || [];
    if (cands.length <= 1) return cands.length === 1 ? cands[0] : null;
    let sub = '';
    if (importPath && provider && importPath.length > provider.name.length) {
      sub = importPath.slice(provider.name.length).replace(/^\//, '');
    }
    const wanted = provider && provider.subdir
      ? (sub ? `${provider.subdir}/${sub}` : provider.subdir)
      : sub;
    let pool2 = cands.filter(c => dirOfPath(c.path) === wanted);
    if (pool2.length <= 1) return pool2.length === 1 ? pool2[0] : null;
    // `pkg.Symbol` can only name a PACKAGE-LEVEL declaration. A method of the same name on some
    // type in that package is spelled `value.Symbol` and is unreachable through the package
    // qualifier — so an owned declaration is not a candidate at all. afero declares both
    // `func Exists(fs Fs, path string)` and `func (a Afero) Exists(path string)` in one file;
    // only the first is what `afero.Exists` means.
    const free = pool2.filter(c => !c.owner);
    if (free.length) pool2 = free;
    if (pool2.length === 1) return pool2[0];
    // A type reference and a constructor can share a name; the type is what a qualified
    // reference denotes.
    const types = pool2.filter(c => c.node_type === 'CLASS' || c.node_type === 'INTERFACE' || c.node_type === 'ENTITY' || c.node_type === 'TYPE');
    if (types.length === 1) return types[0];
    return null;
  };

  const { rows: anchorRows } = await _pool.query(
    `SELECT id, branch_id, path FROM (
       SELECT n.id, n.repository_branch_id AS branch_id, f.path,
              ROW_NUMBER() OVER (
                PARTITION BY n.repository_branch_id ORDER BY length(f.path), f.path
              ) AS _rn
         FROM nodes n
         JOIN files f ON f.id = n.file_id
        WHERE n.repository_branch_id IN (SELECT value FROM json_each($1)) AND n.node_type = 'FILE'
          AND n.approval_status <> 'ARCHIVED'
     ) ranked WHERE _rn = 1`,
    [branchIds],
  );
  const anchorByBranch = new Map(anchorRows.map(a => [a.branch_id, a.id]));

  // Each ecosystem spells the same identity differently at the import site than in its manifest,
  // and every rule below is the ecosystem's own documented behaviour rather than a guess:
  //
  //   Go / npm   the import path IS the module name, optionally with `/sub` beneath it.
  //   Rust       Cargo replaces `-` with `_` to form the crate identifier, and code writes
  //              `tokio_util::codec::Framed` — so the crate is the FIRST `::` segment, compared
  //              with separators folded. `tokio-util` and `tokio_util` are the same crate.
  //   Java/JVM   the manifest names a groupId:artifactId coordinate, but source imports a PACKAGE
  //              (`org.springframework.samples.petclinic.customers.Foo`). The groupId is emitted
  //              as its own identity for exactly this reason, matched as a dotted prefix.
  //   C#         namespaces are dotted and behave like the JVM case.
  //
  // Without the Rust rule the whole Cargo plane scores zero: no crate is ever written with the
  // hyphen its own Cargo.toml uses.
  const foldSep = (v) => v.replace(/[-_]/g, '');
  const firstSeg = (m) => m.split(/[/.]|::/)[0] || m;
  const prefixMatch = (moduleName, p, rustCrate) => {
    if (moduleName === p.name
        || moduleName.startsWith(p.name + '/')
        || moduleName.startsWith(p.name + '.')
        || moduleName.startsWith(p.name + '::')) return p.name.length;
    if (rustCrate && foldSep(rustCrate) === foldSep(p.name)) return p.name.length;
    // Python/PEP 503 (and any ecosystem that swaps `-` and `_`): a distribution named `my-lib` in
    // the manifest is imported in code as `my_lib`, and a submodule as `my_lib.utils`. Fold
    // separators on the LEADING package segment so the two spellings of one identity bind.
    // Additive — it only ever supplies a match the exact/prefix rules above missed, and only when
    // the folded leading segments are equal (and non-trivial).
    if (foldSep(firstSeg(moduleName)) === foldSep(p.name) && foldSep(p.name).length > 1) return p.name.length;
    return -1;
  };

  // LONGEST match wins, and the consumer's OWN repo competes.
  //
  // Two things go wrong without this. First, modules of one build share package roots — ftgo's
  // `ftgo-restaurant-service-api` and `ftgo-restaurant-service` both sit under
  // `net.chrisrichardson.ftgo.restaurantservice` — so first-match binds an import to whichever
  // was read first rather than to the module that declares the specific sub-package.
  //
  // Second, and worse: skipping the consumer's own branch outright turns an INTERNAL import into
  // a cross-repo edge. `ftgo-order-service-api` importing
  // `net.chrisrichardson.ftgo.orderservice.api.events.OrderDomainEvent` — its own package — was
  // being attributed to `ftgo-order-service`, because that module was the best remaining
  // candidate once the real owner had been excluded. The consumer's own repo therefore competes
  // on equal terms and, when it wins, the answer is "not a cross-repo edge at all".
  const matchProvider = (moduleName, consumerBranchId) => {
    if (!moduleName) return null;
    const rustCrate = moduleName.includes('::') ? moduleName.slice(0, moduleName.indexOf('::')) : null;
    // Winner = longest matching identity, ties broken by how many files the module actually has
    // in that package. The tiebreak is what separates the OWNER of a package from a module that
    // merely holds a copied class in it: ftgo's accounting service has 1 file in
    // `net.chrisrichardson.ftgo.consumerservice.domain` against consumer-service's 8.
    let winner = null, winLen = -1, winFiles = -1;
    for (const p of providers) {
      const len = prefixMatch(moduleName, p, rustCrate);
      if (len < 0) continue;
      const files = p.files || 0;
      if (len > winLen || (len === winLen && files > winFiles)) {
        winner = p; winLen = len; winFiles = files;
      }
    }
    const best = winner && winner.branchId !== consumerBranchId ? winner : null;
    const selfLen = winner && winner.branchId === consumerBranchId ? winLen : -1;
    // If the consumer's OWN repository declares a package containing this import, the import is
    // internal — whatever any other repository declares. Requiring the self-match to also be the
    // LONGEST was not enough: ftgo's `ftgo-accounting-service` contains one copied class in
    // `net.chrisrichardson.ftgo.consumerservice.domain`, which is longer than consumer-service's
    // own `...consumerservice`, so every one of consumer-service's internal imports was attributed
    // to accounting and the graph asserted the exact reverse of the true dependency.
    //
    // The cost is a false negative in the rare case where a module legitimately imports a longer
    // package of another module beneath a namespace it also occupies. Suppressing that is far
    // cheaper than asserting a reversed dependency, which sends an impact query the wrong way.
    if (selfLen >= 0) return null;
    return best;
  };

  const moduleEdges = new Map();
  const symbolEdges = new Map();
  let ambiguousSymbols = 0;
  // consumer file node -> local package alias -> provider, so a qualified use site can be bound.
  const aliasByFile = new Map();

  for (const row of fileRows) {
    const imports = Array.isArray(row.imports) ? row.imports : [];
    for (const imp of imports) {
      if (!imp || !imp.module) continue;
      const provider = matchProvider(String(imp.module), row.branch_id);
      if (!provider) continue;

      const anchor = anchorByBranch.get(provider.branchId);
      if (anchor && anchor !== row.file_node_id) {
        moduleEdges.set(`${row.file_node_id}|${anchor}`, [row.file_node_id, anchor, String(imp.module)]);
      }

      const alias = imp.alias || String(imp.module).split('/').pop();
      if (alias) {
        if (!aliasByFile.has(row.file_node_id)) aliasByFile.set(row.file_node_id, new Map());
        aliasByFile.get(row.file_node_id).set(alias, { provider, importPath: String(imp.module) });
      }

      if (imp.name) {
        const hit = pickDecl(provider.branchId, imp.name, String(imp.module), provider);
        if (hit) symbolEdges.set(`${row.file_node_id}|${hit.id}`, [row.file_node_id, hit.id, imp.name]);
        else if (((declIndex.get(provider.branchId) || new Map()).get(imp.name) || []).length) ambiguousSymbols++;
      }
    }
  }

  // Qualified use sites (`pflag.NewFlagSet`): the extractor records these as callExpressions with
  // a `receiver`, which for a package-qualified call IS the import alias bound above.
  //
  // Call expressions alone reach only 75% of the referee's symbol edges, and the missing quarter
  // is one category: a type NAMED rather than called — `fs afero.Fs`, `flags *pflag.FlagSet`,
  // `pflag.ContinueOnError`. Those appear in parameter and field type text, never as a call. The
  // second source below reads that text, through the SAME alias gate and the same declaration
  // index, so it can only bind names the file actually imported and the target repo actually
  // exports. Only exported (capitalised) names are considered, which is exactly the set another
  // package is able to reference.
  if (aliasByFile.size) {
    const { rows: useRows } = await _pool.query(
      `SELECT n.file_id, json_extract(n.properties, '$.callExpressions') AS calls, n.repository_branch_id AS branch_id,
              concat_ws(' ', json_extract(n.properties, '$.params'), json_extract(n.properties, '$.type'),
                             json_extract(n.properties, '$.signature'), json_extract(n.properties, '$.return_type'),
                             json_extract(n.properties, '$.field_type')) AS type_text
         FROM nodes n
        WHERE n.repository_branch_id IN (SELECT value FROM json_each($1)) AND n.approval_status <> 'ARCHIVED'
          AND (json_type(n.properties, '$.callExpressions') IS NOT NULL OR json_type(n.properties, '$.params') IS NOT NULL
               OR json_type(n.properties, '$.type') IS NOT NULL OR json_type(n.properties, '$.signature') IS NOT NULL
               OR json_type(n.properties, '$.field_type') IS NOT NULL)`,
      [branchIds],
    );
    const { rows: fileNodeRows } = await _pool.query(
      `SELECT n.id, n.file_id FROM nodes n
        WHERE n.repository_branch_id IN (SELECT value FROM json_each($1)) AND n.node_type = 'FILE'
          AND n.approval_status <> 'ARCHIVED'`,
      [branchIds],
    );
    const fileNodeByFileId = new Map(fileNodeRows.map(r => [r.file_id, r.id]));
    const { rows: qrefRows } = await _pool.query(
      `SELECT n.id, json_extract(n.properties, '$.qualified_refs') AS refs
         FROM nodes n
        WHERE n.repository_branch_id IN (SELECT value FROM json_each($1)) AND n.node_type = 'FILE'
          AND json_type(n.properties, '$.qualified_refs') IS NOT NULL AND n.approval_status <> 'ARCHIVED'`,
      [branchIds],
    );
    const fileQualifiedRefs = new Map(qrefRows.map(r => [r.id, r.refs]));
    for (const u of useRows) {
      const fileNodeId = fileNodeByFileId.get(u.file_id);
      const aliases = fileNodeId != null ? aliasByFile.get(fileNodeId) : null;
      if (!aliases) continue;
      for (const call of (Array.isArray(u.calls) ? u.calls : [])) {
        if (!call || !call.receiver || !call.callee) continue;
        const bound = aliases.get(call.receiver);
        if (!bound) continue;
        // Go/PHP/C#/Python/JS/TS have a dedicated tree-sitter pass here and `callee` is already
        // the bare symbol name (`pflag.NewFlagSet` -> receiver "pflag", callee "NewFlagSet"). Java
        // has none and falls back to ast-extractor.js's generic regex scanner
        // (extractCallExpressionsFromBody), which folds receiver INTO callee
        // (`ConfigUtils.getValue` -> callee "ConfigUtils.getValue") and carries the bare name
        // separately as `method` — so looking declarations up by `callee` there can never match
        // one, since every declaration is indexed by its bare name. Preferring `method` when
        // present fixes the Java shape without touching the languages that never set it.
        const symbolName = call.method || call.callee;
        const hit = pickDecl(bound.provider.branchId, symbolName, bound.importPath, bound.provider);
        if (hit) symbolEdges.set(`${fileNodeId}|${hit.id}`, [fileNodeId, hit.id, symbolName]);
        else if (((declIndex.get(bound.provider.branchId) || new Map()).get(symbolName) || []).length) ambiguousSymbols++;
      }

      // Qualified references the extractor recorded for the whole file (ingest.js stamps
      // `qualified_refs`): `pflag.Flag` in a closure parameter, `&pflag.Flag{}` in a composite
      // literal, `pflag.ContinueOnError` as an argument. Same alias gate as everything else.
      for (const q of (Array.isArray(fileQualifiedRefs.get(fileNodeId)) ? fileQualifiedRefs.get(fileNodeId) : [])) {
        if (!q || !q.pkg || !q.name) continue;
        const bound = aliases.get(q.pkg);
        if (!bound) continue;
        const hit = pickDecl(bound.provider.branchId, q.name, bound.importPath, bound.provider);
        if (hit) symbolEdges.set(`${fileNodeId}|${hit.id}`, [fileNodeId, hit.id, q.name]);
      }

      // Qualified TYPE references in parameter / field / return text.
      const typeText = u.type_text || '';
      if (typeText) {
        const qualified = typeText.matchAll(/(?<![A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Z][A-Za-z0-9_]*)/g);
        for (const q of qualified) {
          const bound = aliases.get(q[1]);
          if (!bound) continue;
          const hit = pickDecl(bound.provider.branchId, q[2], bound.importPath, bound.provider);
          if (hit) symbolEdges.set(`${fileNodeId}|${hit.id}`, [fileNodeId, hit.id, q[2]]);
        }
      }
    }
  }

  const write = async (pairs, edgeType, resolution) => {
    if (!pairs.length) return 0;
    return bulkWrite(_pool,
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, is_cross_repo, confidence_tier, resolution_tier, properties)
       VALUES ($1, $2, $3, true, 'INFERRED', 2,
               json_object('resolution', $4, 'cross_repo_resolved', json('true'), 'via', $5))
       ON CONFLICT DO NOTHING`,
      pairs.map((p) => [p[0], p[1], edgeType, resolution, p[2]]));
  };

  const modWritten = await write([...moduleEdges.values()], 'IMPORTS', 'cross_repo_package');
  const symWritten = await write([...symbolEdges.values()], 'IMPORTS_SYMBOL', 'cross_repo_symbol');

  console.log(`[resolveCrossRepoPackageEdges] project=${projectId} providers=${providers.length} moduleEdges=${modWritten}/${moduleEdges.size} symbolEdges=${symWritten}/${symbolEdges.size} ambiguousSymbols=${ambiguousSymbols}`);
  return {
    moduleEdges: modWritten, symbolEdges: symWritten, providers: providers.length,
    moduleCandidates: moduleEdges.size, symbolCandidates: symbolEdges.size, ambiguousSymbols,
  };
}

// ─── gRPC plane: services that call each other over a.proto contract ────────
//
// The HTTP plane matches a URL path; the package plane matches a published module name. This one
// matches the third way repositories are coupled, and the one most microservice fleets actually
// use: an RPC declared in a `.proto`, served by one repository and called by another.
//
// The join key is the gRPC wire path — `/<package>.<Service>/<Method>` — which the protocol
// itself defines as globally unique, so no heuristic is needed to decide that two repositories
// mean the same operation. `ingest.js` supplies both halves: ENDPOINT nodes minted from the
// contract, and `grpc_serves` / `grpc_calls` stamped on each hand-written FILE node.
//
// Two edges are written per (consumer file, provider service):
//   FILE(consumer) -[CALLS]-> SERVICE(provider)    the dependency a blast-radius walk needs
//   FILE(consumer) -[CALLS]-> ENDPOINT(provider)   per RPC, where the call site named the method
//
// A provider is the repo whose non-generated code SERVES the service. When two repositories both
// claim to serve one service the edge is refused rather than split — that is a real ambiguity
// (a fork, a migration in progress) and guessing would misdirect an impact query.
async function resolveCrossRepoGrpcEdges(projectId, _pool = pool) {
  const { rows: repoRows } = await _pool.query(
    `SELECT r.id AS repo_id, rb.id AS branch_id
       FROM repositories r
       JOIN repository_branches rb ON rb.repository_id = r.id
      WHERE r.project_id = $1 AND r.is_archived = false`,
    [projectId],
  );
  if (repoRows.length < 2) return { serviceEdges: 0, methodEdges: 0, reason: 'single_repo' };
  const branchIds = repoRows.map(r => r.branch_id);
  const branchOfRepo = new Map(repoRows.map(r => [r.branch_id, r.repo_id]));

  const { rows: fileRows } = await _pool.query(
    `SELECT n.id, n.repository_branch_id AS branch_id,
            json_extract(n.properties, '$.grpc_serves') AS serves,
            json_extract(n.properties, '$.grpc_calls')  AS calls,
            json_extract(n.properties, '$.grpc_methods') AS methods,
            n.file_id
       FROM nodes n
      WHERE n.repository_branch_id IN (SELECT value FROM json_each($1)) AND n.node_type = 'FILE'
        AND n.approval_status <> 'ARCHIVED'
        AND (json_type(n.properties, '$.grpc_serves') IS NOT NULL OR json_type(n.properties, '$.grpc_calls') IS NOT NULL)`,
    [branchIds],
  );
  if (!fileRows.length) return { serviceEdges: 0, methodEdges: 0, reason: 'no_grpc_facts' };

  const { rows: contractRows } = await _pool.query(
    `SELECT n.id, n.node_type, n.repository_branch_id AS branch_id,
            json_extract(n.properties, '$.grpc_service') AS grpc_service,
            json_extract(n.properties, '$.grpc_method')  AS grpc_method
       FROM nodes n
      WHERE n.repository_branch_id IN (SELECT value FROM json_each($1))
        AND n.node_type IN ('SERVICE', 'ENDPOINT')
        AND json_extract(n.properties, '$.grpc') = 1
        AND n.approval_status <> 'ARCHIVED'`,
    [branchIds],
  );
  // The contract is the authority on what a gRPC service IS. Extraction ran per repository and
  // could not consult it — in every real fleet the `.proto` lives somewhere other than the
  // service consuming it (a shared `protos/` folder, a contract repo, or only the *generated*
  // code vendored in). Online Boutique is exactly that: its four Go services vendor
  // `genproto/*.pb.go` and no `.proto` at all. So extraction collects candidates loosely and
  // everything not declared by some.proto in THIS project is discarded here, the first point
  // where every member's contract is visible. Loose there, strict here.
  const declaredServices = new Set(contractRows.map(c => c.grpc_service).filter(Boolean));

  // service name -> set of branches that serve it
  const providersByService = new Map();
  for (const row of fileRows) {
    for (const sv of (Array.isArray(row.serves) ? row.serves : [])) {
      if (!sv || !sv.service || !declaredServices.has(sv.service)) continue;
      if (!providersByService.has(sv.service)) providersByService.set(sv.service, new Set());
      providersByService.get(sv.service).add(row.branch_id);
    }
  }

  const serviceNodeByBranch = new Map();   // `${branch}|${service}` -> node id
  const endpointNodeByBranch = new Map();  // `${branch}|${service}|${method}` -> node id
  for (const c of contractRows) {
    if (!c.grpc_service) continue;
    if (c.node_type === 'SERVICE') {
      serviceNodeByBranch.set(`${c.branch_id}|${c.grpc_service}`, c.id);
    } else if (c.grpc_method) {
      endpointNodeByBranch.set(`${c.branch_id}|${c.grpc_service}|${c.grpc_method}`, c.id);
    }
  }

  // Method-level refinement, done HERE rather than at extraction.
  //
  // Done at extraction it fails for a service that vendors only generated stubs (Go, only
  // `genproto/*.pb.go`) and has no local `.proto`, producing zero method edges. Resolution is
  // the first place where both the contract and the call sites are visible, so the refinement
  // belongs here. Same loose/strict split as everything else on this plane.
  //
  // The call sites come from `callExpressions`, which the extractor already records on every
  // declaration node, so this costs one query and no re-parse.
  const { rows: calleeRows } = await _pool.query(
    `SELECT n.file_id, json_extract(ce.value, '$.callee') AS callee
       FROM nodes n
       JOIN json_each(json_extract(n.properties, '$.callExpressions')) ce
      WHERE n.repository_branch_id IN (SELECT value FROM json_each($1)) AND n.approval_status <> 'ARCHIVED'
        AND json_type(n.properties, '$.callExpressions') = 'array'`,
    [branchIds],
  );
  const calleesByFileId = new Map();
  for (const r of calleeRows) {
    if (!r.callee) continue;
    if (!calleesByFileId.has(r.file_id)) calleesByFileId.set(r.file_id, new Set());
    calleesByFileId.get(r.file_id).add(r.callee);
  }
  const methodsOfService = new Map(); // service -> Set(method)
  for (const c of contractRows) {
    if (c.node_type !== 'ENDPOINT' || !c.grpc_service || !c.grpc_method) continue;
    if (!methodsOfService.has(c.grpc_service)) methodsOfService.set(c.grpc_service, new Set());
    methodsOfService.get(c.grpc_service).add(c.grpc_method);
  }

  const serviceEdges = new Map();
  const methodEdges = new Map();
  let ambiguousProviders = 0, unserved = 0, undeclared = 0;

  for (const row of fileRows) {
    const calls = Array.isArray(row.calls) ? row.calls : [];
    const methods = new Set(Array.isArray(row.methods) ? row.methods : []);
    for (const c of calls) {
      if (!c || !c.service) continue;
      if (!declaredServices.has(c.service)) { undeclared++; continue; }
      const providers = providersByService.get(c.service);
      if (!providers || !providers.size) { unserved++; continue; }
      const foreign = [...providers].filter(b => branchOfRepo.get(b) !== branchOfRepo.get(row.branch_id));
      if (!foreign.length) continue;                 // served in the caller's own repo
      if (foreign.length > 1) { ambiguousProviders++; continue; }
      const providerBranch = foreign[0];

      // The contract node may live in the provider's tree, the consumer's, or a shared contract
      // repo — every service vendoring the same.proto is the norm. Prefer the provider's copy;
      // fall back to any branch that holds it, since the node identifies the OPERATION, not a repo.
      const svcNode = serviceNodeByBranch.get(`${providerBranch}|${c.service}`)
        ?? [...serviceNodeByBranch].find(([k]) => k.endsWith(`|${c.service}`))?.[1];
      if (svcNode) {
        serviceEdges.set(`${row.id}|${svcNode}`, [row.id, svcNode, c.service]);
      }
      // Methods of THIS service that this file actually calls. The conjunction is what makes a
      // bare name safe: the file must already be shown to call the service, and the name must be
      // one the contract declares for it.
      const declaredMethods = methodsOfService.get(c.service) || new Set();
      const calledHere = calleesByFileId.get(row.file_id) || new Set();
      const named = new Set([...methods]
        .map(q => (q.split('.')[0] === c.service ? q.split('.')[1] : null))
        .filter(Boolean));
      for (const m of declaredMethods) if (calledHere.has(m)) named.add(m);
      for (const method of named) {
        const epNode = endpointNodeByBranch.get(`${providerBranch}|${c.service}|${method}`)
          ?? [...endpointNodeByBranch].find(([k]) => k.endsWith(`|${c.service}|${method}`))?.[1];
        if (epNode) methodEdges.set(`${row.id}|${epNode}`, [row.id, epNode, `${c.service}.${method}`]);
      }
    }
  }

  const write = async (pairs, resolution) => {
    if (!pairs.length) return 0;
    return bulkWrite(_pool,
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, is_cross_repo, confidence_tier, resolution_tier, properties)
       VALUES ($1, $2, 'CALLS', true, 'INFERRED', 2,
               json_object('resolution', $3, 'cross_repo_resolved', json('true'), 'via', $4))
       ON CONFLICT DO NOTHING`,
      pairs.map((p) => [p[0], p[1], resolution, p[2]]));
  };

  const svcWritten = await write([...serviceEdges.values()], 'cross_repo_grpc_service');
  const mWritten = await write([...methodEdges.values()], 'cross_repo_grpc_method');
  console.log(`[resolveCrossRepoGrpcEdges] project=${projectId} serviceEdges=${svcWritten}/${serviceEdges.size} methodEdges=${mWritten}/${methodEdges.size} ambiguousProviders=${ambiguousProviders} calledButUnserved=${unserved} notInContract=${undeclared}`);
  return {
    serviceEdges: svcWritten, methodEdges: mWritten,
    serviceCandidates: serviceEdges.size, methodCandidates: methodEdges.size,
    ambiguousProviders, calledButUnserved: unserved, notInContract: undeclared,
  };
}

// ─── Topic plane: services coupled by a message broker ───────────────────────
//
// The fourth transport. HTTP matches a path, gRPC matches a wire name, packages match a module
// identity — all three have a declared contract somewhere. A Kafka/RabbitMQ/NATS fleet has none:
// producer and consumer share only a **string**, often reached through an environment variable
// with a literal default in three different languages. `topic-facts.js` does that resolution; this
// joins the two ends.
//
// A TOPIC node is minted per distinct resolved name so the topic itself is addressable in the
// graph — "who touches `orders`?" is a question a buyer asks, and it has no answer if the topic
// exists only as an edge property.
//
// Direction is producer -> consumer, which is the direction impact flows: change what you publish
// and every subscriber is affected. Publisher-to-publisher and subscriber-to-subscriber are not
// edges; sharing a topic is not a dependency between two readers of it.
async function resolveCrossRepoTopicEdges(projectId, _pool = pool) {
  const { rows: repoRows } = await _pool.query(
    `SELECT r.id AS repo_id, rb.id AS branch_id
       FROM repositories r
       JOIN repository_branches rb ON rb.repository_id = r.id
      WHERE r.project_id = $1 AND r.is_archived = false`,
    [projectId],
  );
  if (repoRows.length < 2) return { topicEdges: 0, topics: 0, reason: 'single_repo' };
  const branchIds = repoRows.map(r => r.branch_id);
  const repoOfBranch = new Map(repoRows.map(r => [r.branch_id, r.repo_id]));

  const { rows: fileRows } = await _pool.query(
    `SELECT n.id, n.repository_branch_id AS branch_id, n.file_id,
            json_extract(n.properties, '$.topic_publishes')  AS pubs,
            json_extract(n.properties, '$.topic_subscribes') AS subs
       FROM nodes n
      WHERE n.repository_branch_id IN (SELECT value FROM json_each($1)) AND n.node_type = 'FILE'
        AND n.approval_status <> 'ARCHIVED'
        AND (json_type(n.properties, '$.topic_publishes') IS NOT NULL OR json_type(n.properties, '$.topic_subscribes') IS NOT NULL)`,
    [branchIds],
  );
  if (!fileRows.length) return { topicEdges: 0, topics: 0, reason: 'no_topic_facts' };

  const producers = new Map(); // topic -> [{fileNodeId, branchId}]
  const consumers = new Map();
  const add = (map, topic, row) => {
    if (!map.has(topic)) map.set(topic, []);
    map.get(topic).push({ fileNodeId: row.id, branchId: row.branch_id });
  };
  let unresolved = 0;
  for (const row of fileRows) {
    for (const p of (Array.isArray(row.pubs) ? row.pubs : [])) {
      if (p && p.topic) add(producers, p.topic, row); else unresolved++;
    }
    for (const c of (Array.isArray(row.subs) ? row.subs : [])) {
      if (c && c.topic) add(consumers, c.topic, row); else unresolved++;
    }
  }

  // Mint a TOPIC node per name that has at least one end, on the branch of its first producer
  // (else its first consumer) so it lives somewhere real rather than in a synthetic repo.
  const allTopics = new Set([...producers.keys(), ...consumers.keys()]);
  const topicNodeId = new Map();
  for (const topic of allTopics) {
    const home = (producers.get(topic) || consumers.get(topic))[0];
    const { rows } = await _pool.query(
      `INSERT INTO nodes
         (repository_branch_id, file_id, node_type, name, summary, confidence_tier, confidence,
          canonical_key, properties)
       VALUES ($1, NULL, 'ENDPOINT', $2, $3, 'EXTRACTED', 1.0, $4,
               json_object('topic', true, 'topic_name', $5, 'source', 'topic_facts'))
       ON CONFLICT (canonical_key) WHERE canonical_key IS NOT NULL
         AND repository_branch_id IS NOT NULL AND approval_status <> 'ARCHIVED'
         DO UPDATE SET last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       RETURNING id`,
      [home.branchId, `topic:${topic}`, `message topic "${topic}"`,
       `${home.branchId}::TOPIC::${topic}`, topic],
    );
    if (rows[0]) topicNodeId.set(topic, rows[0].id);
  }

  const edges = new Map();
  let sameRepoOnly = 0, noCounterparty = 0;
  for (const topic of allTopics) {
    const ps = producers.get(topic) || [];
    const cs = consumers.get(topic) || [];
    if (!ps.length || !cs.length) { noCounterparty++; continue; }
    let crossed = false;
    for (const p of ps) {
      for (const c of cs) {
        if (repoOfBranch.get(p.branchId) === repoOfBranch.get(c.branchId)) continue;
        crossed = true;
        edges.set(`${p.fileNodeId}|${c.fileNodeId}`, [p.fileNodeId, c.fileNodeId, topic]);
      }
    }
    if (!crossed) sameRepoOnly++;
  }

  let written = 0;
  if (edges.size) {
    const pairs = [...edges.values()];
    written = await bulkWrite(_pool,
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, is_cross_repo, confidence_tier, resolution_tier, properties)
       VALUES ($1, $2, 'CALLS', true, 'INFERRED', 2,
               json_object('resolution', 'cross_repo_topic', 'cross_repo_resolved', json('true'), 'via', $3))
       ON CONFLICT DO NOTHING`,
      pairs.map((p) => [p[0], p[1], p[2]]));
  }

  console.log(`[resolveCrossRepoTopicEdges] project=${projectId} topics=${allTopics.size} topicEdges=${written}/${edges.size} unresolvedNames=${unresolved} oneSidedTopics=${noCounterparty} sameRepoOnly=${sameRepoOnly}`);
  return {
    topicEdges: written, topics: allTopics.size, candidates: edges.size,
    unresolvedNames: unresolved, oneSidedTopics: noCounterparty, sameRepoOnly,
  };
}

// ─── Shared-database plane: services coupled by a common table ───────────────
//
// The fifth coupling style, and the one teams see least. Two services need no call, no contract
// and no broker to be bound together — writing and reading the same database table couples them
// just as tightly, and nothing in either repo's code names the other, so it stays invisible until
// a schema change breaks a service nobody thought to check. koragraph already mints a DB_TABLE
// node per repo (from CREATE TABLE DDL, ORM entities, and in-source SQL); this pass links the same
// logical table across repos, so "change this column — who breaks?" reaches every service that
// touches it, not just the ones in the table's home repo.
//
// Matching is recall-first: two DB_TABLE nodes with the same normalized name in different repos
// are treated as the same table. That is deliberately loose —
// `events` in an analytics service and `events` in a billing service may be unrelated — so every
// edge carries a `shared_table_confidence` and a `match` reason in its properties. A bare-name
// match is 'low'; a corroborating schema or database name on both sides lifts it. A consumer can
// trust a high-confidence edge outright and treat a low one as a lead. The edge is written in both
// directions: a shared table is a symmetric coupling and an impact query starts from either end.
//
// Order-independent by construction: it links every sibling in a name group to every other, so it
// does not matter which repo was ingested first — unlike the by-name/lowest-id lookup the
// per-repo reader resolver falls back to. Two `.sql`-only repos, which never linked before (their
// table→file edges are branch-scoped), link here.
async function resolveCrossRepoTableEdges(projectId, _pool = pool) {
  const { rows: repoRows } = await _pool.query(
    `SELECT r.id AS repo_id, rb.id AS branch_id
       FROM repositories r
       JOIN repository_branches rb ON rb.repository_id = r.id
      WHERE r.project_id = $1 AND r.is_archived = false`,
    [projectId],
  );
  if (repoRows.length < 2) return { tableEdges: 0, sharedTables: 0, readerEdges: 0, reason: 'single_repo' };
  const branchIds = repoRows.map(r => r.branch_id);
  const repoIds = [...new Set(repoRows.map(r => r.repo_id))];
  const repoOfBranch = new Map(repoRows.map(r => [r.branch_id, r.repo_id]));

  // Pass 1 — the reader/writer coupling. The per-repo SQL-reference resolver already points a
  // `SELECT … FROM orders` in one repo at the DB_TABLE node another repo declared (it looks tables
  // up project-wide by name), but it never flagged that edge as crossing a repo boundary — so the
  // graph held the coupling without knowing it was cross-repo, and no impact query surfaced it.
  // Mark every READS_TABLE / WRITES_TABLE edge whose reader and table live in different repos of
  // this project, so "who reads this table across the fleet?" finds them. Confidence is 'low': the
  // reader was bound to the table by name alone (recall-first), same policy as the rest of the plane.
  const { rows: readerRows } = await _pool.query(
    `SELECT e.id
       FROM edges e
       JOIN nodes fn ON fn.id = e.from_node_id
       JOIN nodes tn ON tn.id = e.to_node_id
       JOIN repository_branches fb ON fb.id = fn.repository_branch_id
       JOIN repository_branches tb ON tb.id = tn.repository_branch_id
      WHERE e.edge_type IN ('READS_TABLE', 'WRITES_TABLE')
        AND e.is_cross_repo = 0
        AND tn.node_type = 'DB_TABLE'
        AND fb.repository_id <> tb.repository_id
        AND fb.repository_id IN (SELECT value FROM json_each($1))
        AND tb.repository_id IN (SELECT value FROM json_each($1))`,
    [repoIds],
  );
  let readerEdges = 0;
  if (readerRows.length) {
    await _pool.query(
      `UPDATE edges SET is_cross_repo = 1, resolution_tier = 2,
         properties = json_patch(COALESCE(properties, '{}'),
           json_object('resolution', 'cross_repo_shared_table', 'cross_repo_resolved', json('true'),
                       'match', 'reader', 'shared_table_confidence', 'low'))
        WHERE id IN (SELECT value FROM json_each($1))`,
      [readerRows.map(r => r.id)],
    );
    readerEdges = readerRows.length;
  }

  // Pass 2 — the declaration coupling: two repos that each DECLARE a table of the same name.
  const { rows: tableRows } = await _pool.query(
    `SELECT n.id, n.name, n.repository_branch_id AS branch_id,
            json_extract(n.properties, '$.schema')   AS schema_name,
            json_extract(n.properties, '$.database') AS database_name
       FROM nodes n
      WHERE n.repository_branch_id IN (SELECT value FROM json_each($1))
        AND n.node_type = 'DB_TABLE'
        AND n.approval_status <> 'ARCHIVED'`,
    [branchIds],
  );
  if (!tableRows.length) return { tableEdges: 0, sharedTables: 0, readerEdges, reason: readerEdges ? 'readers_only' : 'no_tables' };

  // Group by normalized bare table name — the recall-first join key. A schema/catalog prefix
  // (`analytics.events`) is stripped for grouping but kept on the row so it can corroborate.
  const norm = (s) => (s || '').trim().toLowerCase().replace(/^.*\./, '');
  const byName = new Map(); // name -> [{ id, branchId, schema, database }]
  for (const t of tableRows) {
    const key = norm(t.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({ id: t.id, branchId: t.branch_id, schema: t.schema_name, database: t.database_name });
  }

  const edges = new Map(); // "from|to" -> [from, to, confidence, match, name]
  let sharedTables = 0, sameRepoOnly = 0;
  for (const [name, group] of byName) {
    if (new Set(group.map(g => repoOfBranch.get(g.branchId))).size < 2) { sameRepoOnly++; continue; }
    sharedTables++;
    for (const a of group) {
      for (const b of group) {
        if (a.id === b.id) continue;
        if (repoOfBranch.get(a.branchId) === repoOfBranch.get(b.branchId)) continue; // link across repos only
        // A name match is the floor. A schema or database that agrees on both sides corroborates
        // it — same name AND same database is a strong signal these are one table; a bare name is
        // a lead worth surfacing but not trusting blindly.
        let match = 'name', confidence = 'low';
        if (a.database && b.database && String(a.database).toLowerCase() === String(b.database).toLowerCase()) {
          match = 'database'; confidence = 'high';
        } else if (a.schema && b.schema && String(a.schema).toLowerCase() === String(b.schema).toLowerCase()) {
          match = 'schema'; confidence = 'medium';
        }
        edges.set(`${a.id}|${b.id}`, [a.id, b.id, confidence, match, name]);
      }
    }
  }

  let written = 0;
  if (edges.size) {
    const pairs = [...edges.values()];
    written = await bulkWrite(_pool,
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, is_cross_repo, confidence_tier, resolution_tier, properties)
       VALUES ($1, $2, 'REFERENCES', true, 'INFERRED', 2,
               json_object('resolution', 'cross_repo_shared_table', 'cross_repo_resolved', json('true'),
                           'shared_table_confidence', $3, 'match', $4, 'via', $5))
       ON CONFLICT DO NOTHING`,
      pairs.map((p) => [p[0], p[1], p[2], p[3], p[4]]));
  }

  console.log(`[resolveCrossRepoTableEdges] project=${projectId} sharedTables=${sharedTables} tableEdges=${written}/${edges.size} readerEdges=${readerEdges} sameRepoOnly=${sameRepoOnly}`);
  return { tableEdges: written, sharedTables, readerEdges, candidates: edges.size, sameRepoOnly };
}

module.exports = { resolveEdges, resolveCrossRepoPackageEdges, resolveCrossRepoGrpcEdges, resolveCrossRepoTopicEdges, resolveCrossRepoTableEdges, normalizePathSegments, endpointNameToSegments, isSuffixMatch, extractPathFromTarget };
