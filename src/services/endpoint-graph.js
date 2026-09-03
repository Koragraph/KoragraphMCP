'use strict';

const pool = require('../db/pool');
const { edgeWriteTier } = require('./resolution/tiers');

// Links every ENDPOINT to the METHOD that implements it.
//
// The semantic (LLM) plane is what koragraph has and a pure AST tool does not:
// 17 ENDPOINT nodes on spring-petclinic, each with a real summary — `GET
// /owners` reads "Searches owners by last name with pagination, returns list or
// redirects to single owner". That is worth the tokens it cost.
//
// It was also almost useless for traversal. Measured on branch 11764: every
// ENDPOINT's only inbound edge was `FILE -[CONTAINS]->`. So "what code handles
// GET /owners/{ownerId}/edit" resolved no further than "somewhere in
// OwnerController.java", and a plane that cost real money could be searched but
// not walked.
//
// The join needed to fix that was already in the database. `@GetMapping(
// "/owners/{ownerId}/edit")` is stored verbatim on the METHOD node's
// `properties.decorators`, and the ENDPOINT node is named `GET
// /owners/{ownerId}/edit`. This is a pure database join — no file reads, no
// tokens, no new extraction.
//
//   ENDPOINT -[MAPS_TO]-> METHOD
//
// MAPS_TO is the existing "this abstract thing corresponds to that concrete
// one" edge (ENTITY -> DB_TABLE); `properties.resolution = 'endpoint_handler'`
// distinguishes the two for anyone querying by kind.

const HTTP_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

// Spring: @GetMapping("/x"), @RequestMapping(value="/x", method=RequestMethod.POST)
// JAX-RS:  @GET + @Path("/x")
// Python:  @app.route("/x", methods=["POST"]), @router.get("/x")
// The path may be the sole positional argument or a named one.
function pathFromDecorator(dec) {
  const named = /(?:value|path)\s*=\s*["']([^"']+)["']/.exec(dec);
  if (named) return named[1];
  const positional = /\(\s*["']([^"']+)["']/.exec(dec);
  return positional ? positional[1] : null;
}

function verbsFromDecorator(dec) {
  const springShorthand = /@(Get|Post|Put|Patch|Delete)Mapping\b/.exec(dec);
  if (springShorthand) return [springShorthand[1].toUpperCase()];
  const pyShorthand = /@\w+\.(get|post|put|patch|delete|head|options)\s*\(/.exec(dec);
  if (pyShorthand) return [pyShorthand[1].toUpperCase()];
  const jaxrs = /@(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.exec(dec);
  if (jaxrs) return [jaxrs[1]];
  const found = [];
  // Spring `method = {RequestMethod.GET, RequestMethod.POST}` and Flask
  // `methods=["GET", "POST"]`.
  for (const m of dec.matchAll(/RequestMethod\.(\w+)/g)) found.push(m[1].toUpperCase());
  const methodsList = /methods\s*=\s*[[({]([^\])}]*)[\])}]/.exec(dec);
  if (methodsList) {
    for (const m of methodsList[1].matchAll(/["'](\w+)["']/g)) found.push(m[1].toUpperCase());
  }
  return found.filter((v) => HTTP_VERBS.includes(v));
}

function isRouteDecorator(dec) {
  return /@(?:Get|Post|Put|Patch|Delete|Request)Mapping\b/.test(dec)
    || /@(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(dec)
    || /@\w+\.(?:route|get|post|put|patch|delete)\s*\(/.test(dec);
}

// `/owners/{ownerId}/edit`, `/owners/<int:owner_id>/edit` and `/owners/:ownerId/edit`
// are the same route. Parameter names are not part of the identity; their
// positions are.
function normalizePath(p) {
  if (!p) return null;
  let s = String(p).trim();
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.replace(/\{[^}]*\}/g, '{}')
       .replace(/<[^>]*>/g, '{}')
       .replace(/:[A-Za-z_]\w*/g, '{}')
       .replace(/\(\?P<[^>]*>[^)]*\)/g, '{}');
  s = s.replace(/\/+/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s.toLowerCase();
}

function parseDecorators(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [raw];
    } catch (_) {
      return [raw];
    }
  }
  return [];
}

function joinPaths(prefix, suffix) {
  if (!prefix) return suffix;
  if (!suffix || suffix === '/') return prefix;
  return `${prefix.replace(/\/$/, '')}/${suffix.replace(/^\//, '')}`;
}

// Control-flow and expression keywords that are followed by `(` but are never a
// handler name. Java/Kotlin/TS share enough of this list to keep it one set.
const NOT_A_HANDLER = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'super', 'this',
  'throw', 'synchronized', 'do', 'else', 'try', 'function', 'await', 'typeof',
]);

// Candidate handler names in an ENDPOINT's raw_evidence: an identifier that is
// immediately applied or declared, i.e. followed by `(`. In
//   "@PreAuthorize(\"hasRole(@roles.OWNER_ADMIN)\") public ResponseEntity<OwnerDto> getOwner(Integer ownerId)"
// that yields ["hasRole", "getOwner"], and in
//   "OwnerV2Api interface defines GET /owners; method: listOwnersPage(String lastName, ...)"
// it yields ["listOwnersPage"]. Type names are excluded by requiring a
// lower-case initial (Java/TS method convention), annotations by the same rule.
// Everything surviving is still only a CANDIDATE — the caller intersects it with
// the METHOD nodes actually declared in that file, which is what rejects
// `hasRole` and anything else the evidence happens to mention.
function handlerNamesFromEvidence(evidence) {
  if (!evidence) return [];
  const out = [];
  for (const m of String(evidence).matchAll(/\b([a-z][A-Za-z0-9_]*)\s*\(/g)) {
    if (!NOT_A_HANDLER.has(m[1])) out.push(m[1]);
  }
  return [...new Set(out)];
}

async function resolveEndpointHandlerEdges(branchId, _pool = pool) {
  const { rows: endpointRows } = await _pool.query(
    `SELECT n.id, n.name, n.file_id, n.raw_evidence,
            json_extract(n.properties, '$.path') AS ep_path, json_extract(n.properties, '$.method') AS ep_method
     FROM nodes n
     WHERE n.repository_branch_id = $1 AND n.node_type = 'ENDPOINT' AND n.approval_status != 'ARCHIVED'`,
    [branchId]
  );
  if (!endpointRows.length) {
    console.log(`[endpoint-graph] branchId=${branchId} endpoints=0`);
    return { endpoints: 0, linked: 0 };
  }

  const { rows: methodRows } = await _pool.query(
    `SELECT n.id, n.name, n.file_id, json_extract(n.properties, '$.decorators') AS decorators,
            (SELECT json_extract(nc.properties, '$.decorators') FROM edges de
               JOIN nodes nc ON nc.id = de.to_node_id
              WHERE de.from_node_id = n.id AND de.edge_type = 'DEFINED_IN' LIMIT 1) AS class_decorators
     FROM nodes n
     WHERE n.repository_branch_id = $1 AND n.node_type IN ('METHOD','ENDPOINT')
       AND n.approval_status != 'ARCHIVED' AND json_type(n.properties, '$.decorators') IS NOT NULL`,
    [branchId]
  );

  // route key -> method node ids. Two keys per method: "VERB /path" and the
  // path alone, so an ENDPOINT whose verb the extractor never recorded still
  // binds.
  const byRoute = new Map();
  const ambiguous = new Set();
  const add = (key, id) => {
    if (!key) return;
    const existing = byRoute.get(key);
    if (existing !== undefined && existing !== id) { ambiguous.add(key); return; }
    byRoute.set(key, id);
  };

  let annotated = 0;
  for (const m of methodRows) {
    const decs = parseDecorators(m.decorators).filter(isRouteDecorator);
    if (!decs.length) continue;
    const classDecs = parseDecorators(m.class_decorators).filter((d) => /@RequestMapping\b/.test(d));
    const prefix = classDecs.length ? pathFromDecorator(classDecs[0]) : null;

    for (const dec of decs) {
      const rawPath = pathFromDecorator(dec);
      // A verb-only annotation (`@GET` in JAX-RS, `@GetMapping` with no path)
      // still names a route when the class carries the path.
      const full = normalizePath(joinPaths(prefix, rawPath) || prefix);
      if (!full) continue;
      annotated++;
      const verbs = verbsFromDecorator(dec);
      add(full, m.id);
      for (const v of (verbs.length ? verbs : HTTP_VERBS)) add(`${v} ${full}`, m.id);
    }
  }
  for (const k of ambiguous) byRoute.delete(k);

  // Strategy 2 index: METHOD nodes per file, keyed by name. Used only for the
  // endpoints strategy 1 could not bind. Names that repeat within a file are
  // dropped outright — an overload pair is not a unique handler.
  const methodsByFile = new Map();
  {
    const { rows: fileMethods } = await _pool.query(
      `SELECT n.id, n.name, n.file_id FROM nodes n
        WHERE n.repository_branch_id = $1 AND n.node_type = 'METHOD'
          AND n.approval_status != 'ARCHIVED' AND n.file_id IS NOT NULL AND n.name IS NOT NULL`,
      [branchId]
    );
    for (const m of fileMethods) {
      if (!methodsByFile.has(m.file_id)) methodsByFile.set(m.file_id, new Map());
      const byName = methodsByFile.get(m.file_id);
      byName.set(m.name, byName.has(m.name) ? null : m.id); // null marks an overload
    }
  }

  const edgeRows = [];
  let viaEvidence = 0;
  for (const ep of endpointRows) {
    const raw = String(ep.name || '').trim();
    const spaceIdx = raw.indexOf(' ');
    const verb = ep.ep_method
      ? String(ep.ep_method).toUpperCase()
      : (spaceIdx > 0 && HTTP_VERBS.includes(raw.slice(0, spaceIdx).toUpperCase()) ? raw.slice(0, spaceIdx).toUpperCase() : null);
    const pathPart = ep.ep_path || (spaceIdx > 0 ? raw.slice(spaceIdx + 1) : raw);
    const norm = normalizePath(pathPart);

    let target = norm
      ? ((verb ? byRoute.get(`${verb} ${norm}`) : undefined) ?? byRoute.get(norm))
      : undefined;
    let usedEvidence = false;

    // Strategy 2 — same-file handler name from the endpoint's own evidence.
    // Only where the annotation join found nothing: frameworks that put the
    // route on a generated interface leave the implementing method with no
    // route decorator at all, so strategy 1 has nothing to key on.
    if (!target && ep.file_id) {
      const byName = methodsByFile.get(ep.file_id);
      if (byName) {
        const unique = [...new Set(
          handlerNamesFromEvidence(ep.raw_evidence)
            .map((n) => byName.get(n))
            .filter(Boolean)          // present in this file AND not an overload
        )];
        // Exactly one method in this file is named by the evidence, or nothing.
        if (unique.length === 1) { target = unique[0]; usedEvidence = true; viaEvidence++; }
      }
    }

    // Strategy 3 — gRPC / RPC endpoint matching by method name across project.
    if (!target) {
      const rpcMatch = /^(?:RPC\s+)?(?:\w+\/)?(\w+)$/.exec(raw);
      if (rpcMatch) {
        const cleanRpc = rpcMatch[1];
        const { rows: rpcMethods } = await _pool.query(
          `SELECT n.id FROM nodes n
           WHERE n.repository_branch_id = $1 AND n.node_type = 'METHOD'
             AND n.approval_status != 'ARCHIVED' AND lower(n.name) = lower($2)
           LIMIT 2`,
          [branchId, cleanRpc]
        );
        if (rpcMethods.length === 1) {
          target = rpcMethods[0].id;
          usedEvidence = true;
        }
      }
    }

    if (!target || target === ep.id) continue;
    edgeRows.push({ from: ep.id, to: target, calledName: raw, usedEvidence });
  }

  let linked = 0;
  if (edgeRows.length) {
    const params = [];
    const values = edgeRows.map(({ from, to, calledName, usedEvidence }) => {
      const base = params.length;
      // Each edge records the strategy that produced it, and carries that
      // strategy's tier — the annotation join is a parsed fact (EXTRACTED),
      // the evidence join reads an LLM-written string (INFERRED). Collapsing
      // them onto one resolution would overstate the weaker half.
      const resolution = usedEvidence ? 'endpoint_handler_evidence' : 'endpoint_handler';
      const derived = edgeWriteTier(resolution, 'MAPS_TO');
      params.push(from, to, derived.edgeType, derived.label,
        JSON.stringify({ resolution, called_name: calledName }),
        derived.tier, derived.confidence);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    const { rowCount } = await _pool.query(
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
       VALUES ${values.join(',')}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      params
    );
    linked = rowCount ?? edgeRows.length;
  }

  console.log(`[endpoint-graph] branchId=${branchId} endpoints=${endpointRows.length} route_annotated_methods=${annotated} linked=${linked} via_evidence=${viaEvidence}`);
  return { endpoints: endpointRows.length, annotated, linked, viaEvidence };
}

module.exports = {
  resolveEndpointHandlerEdges, normalizePath, verbsFromDecorator, pathFromDecorator,
  handlerNamesFromEvidence,
};
