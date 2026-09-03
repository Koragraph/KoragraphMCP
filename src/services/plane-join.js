'use strict';

const pool = require('../db/pool');
const { edgeWriteTier } = require('./resolution/tiers');

// Joins the two planes that describe the same symbol.
//
// Koragraph writes a node from the structural/AST plane (CLASS, METHOD) and,
// for the same declaration, a second node from the LLM plane carrying its
// architectural ROLE (SERVICE, REPOSITORY, ANGULAR_SERVICE, ANGULAR_COMPONENT,
// NODE_SERVICE, ...). Nothing connected them, and that split is load-bearing:
//
//   OwnerListComponent -[CALLS]-> CLASS OwnerService            (structural)
//                                 ANGULAR_SERVICE OwnerService  (semantic)
//                                     -[CALLS]-> ENDPOINT GET /owners
//
// Callers resolve to the structural node because that is what the symbol index
// holds; the semantic node owns the role, the summary and — after cross-repo
// resolution — the outbound API edges. So both halves of
// "component -> service -> endpoint" existed and the path did not. Measured on
// the petclinic demo project: 122 split pairs, spanning CLASS<->REPOSITORY (31),
// CLASS<->SERVICE (27), CLASS<->ANGULAR_COMPONENT (23), CLASS<->NODE_SERVICE
// (21) and CLASS<->ANGULAR_SERVICE (7). It is not an Angular problem; any file
// whose declaration comes from the AST plane and whose role comes from the LLM
// plane splits the same way, which silently halves reachability.
//
//   STRUCTURAL -[MAPS_TO]-> SEMANTIC   (properties.resolution = 'plane_join')
//
// MAPS_TO is the existing "this thing corresponds to that thing" edge
// (ENTITY -> DB_TABLE, ENDPOINT -> METHOD) and is already in
// TRAVERSAL_EDGE_TYPES, so the joined path is walkable by default retrieval.
//
// Direction is structural -> semantic because that is the direction that
// unblocks traversal: callers arrive at the structural node and need to reach
// the role node's edges.

// The AST/structural plane's declaration types.
const STRUCTURAL_TYPES = ['CLASS', 'METHOD'];

// Types that are never a "role view" of a structural declaration and must not
// be joined to one: FILE is a container, TEST is a different declaration that
// merely shares a name, and IMPORT/DEPENDENCY/CONFIG_VALUE/DOC are not
// declarations at all.
const NON_ROLE_TYPES = ['FILE', 'TEST', 'IMPORT', 'DEPENDENCY', 'CONFIG_VALUE', 'DOC'];

// Pairs structural nodes with the semantic node describing the same declaration.
//
// The pairing key is exact equality on (file_id, name) — a role node the LLM
// minted for a declaration always lands on that declaration's file and carries
// its name. Deliberately kept as a pure function over already-fetched rows so
// the refusal rules below are unit-testable without a database.
//
// Two refusals, both matching the "more than one equally-meaningful candidate
// survives -> no edge" rule the rest of the resolvers follow:
//   * a (file, name) with more than one STRUCTURAL node — an overload pair, so
//     which declaration the role describes is unknowable;
//   * a (file, name) with more than one SEMANTIC node — two competing roles.
// A pair whose two sides are the same node id is not a pair.
function pairPlanes(nodes) {
  const structural = new Set(STRUCTURAL_TYPES);
  const nonRole = new Set(NON_ROLE_TYPES);
  const buckets = new Map();

  for (const n of nodes) {
    if (n.file_id === null || n.file_id === undefined || !n.name) continue;
    const isStructural = structural.has(n.node_type);
    if (!isStructural && nonRole.has(n.node_type)) continue;
    const key = `${n.file_id}\x00${n.name}`;
    if (!buckets.has(key)) buckets.set(key, { structural: [], semantic: [] });
    buckets.get(key)[isStructural ? 'structural' : 'semantic'].push(n);
  }

  const pairs = [];
  for (const { structural: s, semantic: l } of buckets.values()) {
    if (s.length !== 1 || l.length !== 1) continue;
    if (s[0].id === l[0].id) continue;
    pairs.push({
      from_id: s[0].id,
      to_id: l[0].id,
      from_type: s[0].node_type,
      to_type: l[0].node_type,
      name: s[0].name,
    });
  }
  return pairs;
}

async function resolveSemanticPlaneJoins(branchId, _pool = pool) {
  const { rows } = await _pool.query(
    `SELECT id, file_id, name, node_type FROM nodes
      WHERE repository_branch_id = $1 AND approval_status = 'APPROVED'
        AND file_id IS NOT NULL AND name IS NOT NULL`,
    [branchId]
  );

  const pairs = pairPlanes(rows);
  if (!pairs.length) {
    console.log(`[plane-join] branchId=${branchId} pairs=0 linked=0`);
    return { pairs: 0, linked: 0 };
  }

  const derived = edgeWriteTier('plane_join', 'MAPS_TO');
  const params = [];
  const values = pairs.map(({ from_id, to_id, from_type, to_type, name }) => {
    const base = params.length;
    params.push(from_id, to_id, derived.edgeType, derived.label,
      JSON.stringify({ resolution: 'plane_join', joined_name: name, from_type, to_type }),
      derived.tier, derived.confidence);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  });

  const { rowCount } = await _pool.query(
    `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
     VALUES ${values.join(',')}
     ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
    params
  );

  const linked = rowCount ?? pairs.length;
  console.log(`[plane-join] branchId=${branchId} pairs=${pairs.length} linked=${linked}`);
  return { pairs: pairs.length, linked };
}

module.exports = { resolveSemanticPlaneJoins, pairPlanes, STRUCTURAL_TYPES, NON_ROLE_TYPES };
