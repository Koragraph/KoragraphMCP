// Dumps a koragraph SQLite store into the generic shapes the language-quality
// oracles consume, so koragraph is scored by edge-compare-generic.py and
// score-decls.py exactly like any competitor (edge-dump-codegraph.py etc).
// The store is the source of truth here, not the extractor — this measures what
// actually landed in the graph after resolution.
//
//   node graph-benchmark/langquality/dump-koragraph.js --db X.db \
//        --out-edges edges.json --out-decls decls.json [--branch-id N]
//
// Edge planes map koragraph edge_types -> generic {imports,inheritance,calls}.
// No name reduction is done here; edge-compare-generic.py applies final()/
// module_variants() to every system uniformly.

const Database = require('better-sqlite3');

const args = require('node:util').parseArgs({
  options: {
    db: { type: 'string' },
    'out-edges': { type: 'string' },
    'out-decls': { type: 'string' },
    'branch-id': { type: 'string' },
  },
}).values;

if (!args.db) { console.error('--db required'); process.exit(1); }

const db = new Database(args.db, { readonly: true });

// EMBEDS is koragraph's edge for a Ruby mixin (`include`/`extend`/`prepend`),
// which adds to the ancestor chain — inheritance for scoring. It is Ruby-only
// (Go embedding uses EXTENDS), so this doesn't affect the other languages.
const INHERIT = ['EXTENDS', 'IMPLEMENTS', 'EMBEDS'];
const CALLS = ['CALLS', 'HEURISTIC_CALLS'];
const IMPORTS = ['IMPORTS', 'IMPORTS_SYMBOL'];
const DECL_TYPES = ['CLASS', 'INTERFACE', 'ENUM', 'RECORD', 'STRUCT', 'TRAIT',
  'PROTOCOL', 'METHOD', 'FUNCTION', 'FIELD', 'CONSTANT', 'ANNOTATION', 'TYPE'];

function resolveBranch() {
  if (args['branch-id']) return Number(args['branch-id']);
  // Pick the branch carrying the most live nodes — guards against the
  // detached-HEAD double-branch-row trap (CLAUDE.md §Traps).
  const row = db.prepare(
    `SELECT repository_branch_id AS b, COUNT(*) c FROM nodes
     WHERE approval_status != 'ARCHIVED' GROUP BY repository_branch_id
     ORDER BY c DESC LIMIT 1`).get();
  if (!row) { console.error('no nodes in store'); process.exit(1); }
  return row.b;
}

const branch = resolveBranch();
const inList = (a) => a.map(() => '?').join(',');

// file path for a node: its own file_id, else (FILE nodes) the node name.
const decls = db.prepare(
  `SELECT n.name AS name, n.node_type AS kind, COALESCE(f.path, n.name) AS file
   FROM nodes n LEFT JOIN files f ON n.file_id = f.id
   WHERE n.repository_branch_id = ? AND n.approval_status != 'ARCHIVED'
     AND n.node_type IN (${inList(DECL_TYPES)})`).all(branch, ...DECL_TYPES);

function edgeRows(types) {
  return db.prepare(
    `SELECT a.name AS from_name, b.name AS to_name, e.properties AS props,
            COALESCE(fa.path, a.name) AS file
     FROM edges e
     JOIN nodes a ON e.from_node_id = a.id
     JOIN nodes b ON e.to_node_id = b.id
     LEFT JOIN files fa ON a.file_id = fa.id
     WHERE a.repository_branch_id = ? AND a.approval_status != 'ARCHIVED'
       AND b.approval_status != 'ARCHIVED'
       AND e.edge_type IN (${inList(types)})`).all(branch, ...types);
}

const inheritance = edgeRows(INHERIT).map((r) => ({ file: r.file, child: r.from_name, base: r.to_name }));
function callSiteName(r) {
  if (r.props) { try { const n = JSON.parse(r.props).called_name; if (n) return n; } catch (_) {} }
  return r.to_name;
}
const calls = edgeRows(CALLS).map((r) => ({ file: r.file, caller: r.from_name, callee: callSiteName(r) }));
const imports = edgeRows(IMPORTS).map((r) => ({ file: r.file, name: r.to_name }));

// Rust `use` is LEAF-grained (`use std::io::Read` imports `Read`, not `std::io`),
// but the IMPORTS edge plane records the module a file depends on — the right
// answer to a different question. The leaf names koragraph actually extracted
// live on FILE.properties.imports; the referee (syn) and every competitor score
// at leaf grain. Reading them here — SCOPED TO .rs so every other language's
// dump stays byte-identical — closes the granularity mismatch with real
// extracted data, not a fabricated edge.
const rustFileImports = db.prepare(
  `SELECT COALESCE(f.path, n.name) AS file, n.properties AS props
   FROM nodes n LEFT JOIN files f ON n.file_id = f.id
   WHERE n.repository_branch_id = ? AND n.approval_status != 'ARCHIVED'
     AND n.node_type = 'FILE' AND COALESCE(f.path, n.name) LIKE '%.rs'
     AND n.properties LIKE '%imports%'`).all(branch);
for (const row of rustFileImports) {
  let parsed;
  try { parsed = JSON.parse(row.props); } catch (_) { continue; }
  for (const imp of (parsed && parsed.imports) || []) {
    if (imp && imp.name) imports.push({ file: row.file, name: imp.name });
    if (imp && imp.alias) imports.push({ file: row.file, name: imp.alias });
  }
}

const fs = require('node:fs');
if (args['out-edges']) {
  fs.writeFileSync(args['out-edges'], JSON.stringify({ imports, inheritance, calls }));
}
if (args['out-decls']) {
  fs.writeFileSync(args['out-decls'], JSON.stringify({
    system: 'koragraph',
    decls: decls.map((d) => ({ name: d.name, kind: d.kind, file: d.file })),
  }));
}

console.error(`[dump-koragraph] branch=${branch} decls=${decls.length} `
  + `imports=${imports.length} inheritance=${inheritance.length} calls=${calls.length}`);
