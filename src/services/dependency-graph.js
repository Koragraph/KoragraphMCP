'use strict';

const pool = require('../db/pool');
const { edgeWriteTier } = require('./resolution/tiers');

// Connects the two halves of the dependency picture.
//
// `resolveImportFacts` mints a DEPENDENCY node per imported module — what the
// code USES (`org.springframework.stereotype.Controller`, `django.db.models`,
// `lodash/debounce`). The manifest pass mints one per declared package — what
// the project SHIPS (`org.springframework.boot:spring-boot-starter-webmvc`,
// `Django>=4.2`, `lodash@^4.17`). Neither knew about the other, so the graph
// held both halves of "which declared dependency provides this import" and
// could answer neither it nor its inverse, "what do we declare that nothing
// imports".
//
// Matching is per-ecosystem and unique-or-refuse:
//   npm/packagist  the import specifier's package part IS the declared name
//                  (`lodash/debounce` -> `lodash`, `@scope/pkg/x` -> `@scope/pkg`)
//   pypi           the import root, normalised (PEP 503: case-fold, -/_/. -> -)
//   maven          the declared groupId is a prefix of the imported package
//   go             the declared module path is a prefix of the import path
//
// An import two declared packages could both claim is left unbound rather than
// attached to whichever sorted first.

// PEP 503 normalisation, plus the fact that a distribution rarely shares its
// import name (`Django` -> `django`, `beautifulsoup4` -> `bs4` is NOT derivable
// and is correctly left unmatched).
function pypiKey(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}

function npmPackageOf(specifier) {
  const s = String(specifier);
  if (s.startsWith('@')) {
    const parts = s.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : s;
  }
  return s.split('/')[0];
}

/**
 * resolveDeclaredDependencyEdges(branchId) — link each import-derived
 * DEPENDENCY node to the declared package that provides it.
 * Writes DEPENDENCY -[BELONGS_TO]-> DEPENDENCY.
 */
async function resolveDeclaredDependencyEdges(branchId, _pool = pool) {
  const { rows } = await _pool.query(
    // writeNode renames `provenance` to `extraction_source` on the way in
    // (normalizeNodeProvenanceProps), so that is the column to read back.
    `SELECT id, name, json_extract(properties, '$.extraction_source') AS provenance, json_extract(properties, '$.ecosystem') AS ecosystem
     FROM nodes
     WHERE repository_branch_id = $1 AND node_type = 'DEPENDENCY' AND approval_status != 'ARCHIVED'
     ORDER BY id`,
    [branchId]
  );
  if (!rows.length) return { declared: 0, imported: 0, linked: 0 };

  const declared = rows.filter((r) => r.provenance === 'manifest');
  const imported = rows.filter((r) => r.provenance !== 'manifest');
  if (!declared.length || !imported.length) {
    console.log(`[dependency-graph] branchId=${branchId} declared=${declared.length} imported=${imported.length} linked=0 (one side empty)`);
    return { declared: declared.length, imported: imported.length, linked: 0 };
  }

  // Exact-key lookups (npm, pypi, packagist) and prefix lists (maven, go).
  const exact = new Map();
  const exactAmbiguous = new Set();
  const prefixes = []; // { prefix, id }
  const addExact = (key, id) => {
    if (!key) return;
    const existing = exact.get(key);
    if (existing !== undefined && existing !== id) { exactAmbiguous.add(key); return; }
    exact.set(key, id);
  };

  for (const d of declared) {
    const eco = d.ecosystem || '';
    if (eco === 'npm' || eco === 'packagist') {
      addExact(String(d.name).toLowerCase(), d.id);
    } else if (eco === 'pypi') {
      addExact(pypiKey(d.name), d.id);
    } else if (eco === 'maven') {
      const group = String(d.name).split(':')[0];
      if (group) prefixes.push({ prefix: `${group.toLowerCase()}.`, id: d.id, exact: group.toLowerCase() });
    } else if (eco === 'go') {
      prefixes.push({ prefix: `${String(d.name).toLowerCase()}/`, id: d.id, exact: String(d.name).toLowerCase() });
    } else if (eco === 'cargo' || eco === 'rubygems' || eco === 'nuget') {
      addExact(String(d.name).toLowerCase(), d.id);
      prefixes.push({ prefix: `${String(d.name).toLowerCase()}.`, id: d.id, exact: String(d.name).toLowerCase() });
    }
  }
  for (const k of exactAmbiguous) exact.delete(k);
  // Longest prefix first, so `org.springframework.boot` beats `org.springframework`.
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length);

  const edgeRows = [];
  for (const imp of imported) {
    const raw = String(imp.name || '');
    if (!raw) continue;
    const lower = raw.toLowerCase();

    // npm/packagist specifier, then python root, then the whole lowered name.
    let target = exact.get(npmPackageOf(lower))
      ?? exact.get(pypiKey(raw.split('.')[0]))
      ?? exact.get(lower);

    if (!target) {
      // Prefix ecosystems. Take the longest matching prefix, and refuse when
      // two DIFFERENT declared packages share it — `org.springframework.` is a
      // prefix of six petclinic starters, and picking one would be a guess
      // dressed as a fact.
      const hits = prefixes.filter((p) => lower === p.exact || lower.startsWith(p.prefix));
      if (hits.length) {
        const best = hits[0].prefix.length;
        const tied = hits.filter((h) => h.prefix.length === best);
        const distinct = new Set(tied.map((t) => t.id));
        if (distinct.size === 1) target = tied[0].id;
      }
    }

    if (!target || target === imp.id) continue;
    edgeRows.push([imp.id, target]);
  }

  let linked = 0;
  if (edgeRows.length) {
    const params = [];
    const values = edgeRows.map(([from, to]) => {
      const base = params.length;
      const derived = edgeWriteTier('declared_dependency', 'BELONGS_TO');
      params.push(from, to, derived.edgeType, derived.label, JSON.stringify({ resolution: 'declared_dependency' }), derived.tier, derived.confidence);
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

  console.log(`[dependency-graph] branchId=${branchId} declared=${declared.length} imported=${imported.length} linked=${linked}`);
  return { declared: declared.length, imported: imported.length, linked };
}

module.exports = { resolveDeclaredDependencyEdges, pypiKey, npmPackageOf };
