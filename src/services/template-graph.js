'use strict';

const fs = require('fs');
const path = require('path');

const pool = require('../db/pool');
const { edgeWriteTier } = require('./resolution/tiers');
const { parseTemplate, isTemplateFile, viewNameFor } = require('./contract-parsers/template');

// Post-tail resolver for the view layer.
//
// Templates already get a FILE node from the presence floor, but nothing ever
// reads them, so they sit in the graph as isolated vertices — 12 of them on
// spring-petclinic, 75 on django-machina. Everything they name is a link the
// rest of the extraction cannot produce:
//
//   template -[USES_CONFIG]->  CONFIG_VALUE   the i18n key it renders
//   template -[REFERENCES]->   template       the layout it extends
//   template -[REFERENCES]->   ENDPOINT       the route it links to
//   METHOD   -[REFERENCES]->   template       the view a controller returns
//
// The first of those is the one that matters most: on petclinic the ten
// message catalogues hold 480 of 1185 nodes and were reachable from nothing,
// because the only place `findOwners` appears outside the catalogues is a
// Thymeleaf attribute. The last one closes the loop back to the call graph.
//
// Zero-token: regex over files already on disk, then exact-name matching
// against nodes already in the branch. Nothing is minted; an unmatched name is
// dropped, never fabricated into a node.

const SOURCE_EXTS_FOR_VIEW_SCAN = new Set(['.java', '.kt', '.py', '.rb', '.php', '.js', '.ts', '.cs', '.go']);
const MAX_SOURCE_BYTES = 400_000;

function readIfSmall(fullPath) {
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return null;
    return fs.readFileSync(fullPath, 'utf8');
  } catch (_) {
    return null;
  }
}

// A template reference is written the way the framework resolves it, which is
// rarely the repo-relative path: `{% extends "machina/board_base.html" %}`
// against `machina/templates/machina/board_base.html`, or Thymeleaf's
// `fragments/layout` against `.../templates/fragments/layout.html`. Matching on
// the longest unique suffix covers both without hardcoding a view root.
function buildTemplateLookup(templates) {
  const byKey = new Map();
  const ambiguous = new Set();
  const add = (key, id) => {
    if (!key) return;
    const k = key.toLowerCase();
    const existing = byKey.get(k);
    if (existing !== undefined && existing !== id) { ambiguous.add(k); return; }
    byKey.set(k, id);
  };
  for (const t of templates) {
    add(t.viewName, t.nodeId);
    add(t.path, t.nodeId);
    add(t.path.replace(/\.[A-Za-z0-9]+$/, ''), t.nodeId);
    // Progressive path suffixes, so `machina/board_base.html` finds
    // `machina/templates/machina/board_base.html`.
    const segments = t.path.split('/');
    for (let i = 1; i < segments.length; i++) {
      const suffix = segments.slice(i).join('/');
      add(suffix, t.nodeId);
      add(suffix.replace(/\.[A-Za-z0-9]+$/, ''), t.nodeId);
    }
  }
  for (const k of ambiguous) byKey.delete(k);
  return byKey;
}

function normalizeRef(ref) {
  return ref.replace(/^\.\//, '').replace(/^\//, '').toLowerCase();
}

async function writeEdges(rows, _pool) {
  if (!rows.length) return 0;
  const CHUNK = pool.safeChunk(7);
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const params = [];
    const values = chunk.map(({ from, to, edgeType, resolution, calledName, line }) => {
      const base = params.length;
      const derived = edgeWriteTier(resolution, edgeType);
      const props = { resolution };
      if (calledName) props.called_name = calledName;
      if (Number.isInteger(line)) props.call_line = line;
      params.push(from, to, derived.edgeType, derived.label, JSON.stringify(props), derived.tier, derived.confidence);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    const { rowCount } = await _pool.query(
      `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
       VALUES ${values.join(',')}
       ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
      params
    );
    written += rowCount ?? chunk.length;
  }
  return written;
}

/**
 * resolveTemplateEdges(branchId, repoPath) — read every template in the branch
 * and wire it to the config, template and endpoint nodes it names, then wire
 * the source methods that return its view name back to it.
 */
async function resolveTemplateEdges(branchId, repoPath, _pool = pool) {
  if (!repoPath || !fs.existsSync(repoPath)) {
    console.log(`[template-graph] branchId=${branchId} skipped — no checkout on disk`);
    return { templates: 0, configEdges: 0, includeEdges: 0, endpointEdges: 0, viewEdges: 0 };
  }

  const { rows: fileNodeRows } = await _pool.query(
    `SELECT n.id AS node_id, f.path
     FROM nodes n
     JOIN files f ON f.id = n.file_id
     WHERE n.repository_branch_id = $1 AND n.node_type = 'FILE' AND n.approval_status != 'ARCHIVED'`,
    [branchId]
  );

  const templates = fileNodeRows
    .filter((r) => isTemplateFile(r.path))
    .map((r) => ({ nodeId: r.node_id, path: r.path, viewName: viewNameFor(r.path) }));

  if (!templates.length) {
    console.log(`[template-graph] branchId=${branchId} templates=0`);
    return { templates: 0, configEdges: 0, includeEdges: 0, endpointEdges: 0, viewEdges: 0 };
  }

  const { rows: configRows } = await _pool.query(
    `SELECT id, name FROM nodes
     WHERE repository_branch_id = $1 AND node_type = 'CONFIG_VALUE' AND approval_status != 'ARCHIVED'
     ORDER BY id`,
    [branchId]
  );
  // One key exists once per catalogue (petclinic ships ten translations of the
  // same 52 keys). Every one of them is a legitimate target — a key added to
  // the graph should reach all its translations, which is the ripple the
  // corpus tasks measure — so this maps a key to ALL its nodes, not the first.
  const configByKey = new Map();
  for (const c of configRows) {
    const k = (c.name || '').toLowerCase();
    if (!k) continue;
    const list = configByKey.get(k);
    if (list) list.push(c.id); else configByKey.set(k, [c.id]);
  }

  const { rows: endpointRows } = await _pool.query(
    `SELECT id, name FROM nodes
     WHERE repository_branch_id = $1 AND node_type = 'ENDPOINT' AND approval_status != 'ARCHIVED'
     ORDER BY id`,
    [branchId]
  );
  const endpointByPath = new Map();
  const endpointAmbiguous = new Set();
  for (const e of endpointRows) {
    // ENDPOINT names are either "VERB /path" or a bare path.
    const raw = (e.name || '').trim();
    const pathPart = (raw.includes(' ') ? raw.slice(raw.indexOf(' ') + 1) : raw).toLowerCase();
    if (!pathPart) continue;
    const existing = endpointByPath.get(pathPart);
    if (existing !== undefined && existing !== e.id) { endpointAmbiguous.add(pathPart); continue; }
    endpointByPath.set(pathPart, e.id);
  }
  for (const p of endpointAmbiguous) endpointByPath.delete(p);

  // Static assets a template links to (`th:href="@{/resources/css/petclinic.css}"`,
  // `<img src="/resources/images/pets.png">`). These are real files with real
  // FILE nodes, and without this edge every stylesheet, font and image in the
  // repo is an isolated vertex — 13 of spring-petclinic's 42 remaining orphans.
  // Keyed on path suffix because the URL is server-relative, not repo-relative.
  const assetBySuffix = new Map();
  const assetAmbiguous = new Set();
  for (const r of fileNodeRows) {
    const segments = r.path.split('/');
    for (let i = 0; i < segments.length; i++) {
      const suffix = `/${segments.slice(i).join('/')}`.toLowerCase();
      const existing = assetBySuffix.get(suffix);
      if (existing !== undefined && existing !== r.node_id) { assetAmbiguous.add(suffix); continue; }
      assetBySuffix.set(suffix, r.node_id);
    }
  }
  for (const s of assetAmbiguous) assetBySuffix.delete(s);

  const templateLookup = buildTemplateLookup(templates);
  const edgeRows = [];
  let configEdges = 0, includeEdges = 0, endpointEdges = 0, assetEdges = 0;
  const viewNameTargets = new Map(); // literal a controller could return -> template node id

  for (const t of templates) {
    const content = readIfSmall(path.join(repoPath, t.path));
    if (content === null) continue;
    const parsed = parseTemplate(content);

    for (const { value, line } of parsed.messageKeys) {
      const targets = configByKey.get(value.toLowerCase());
      if (!targets) continue;
      for (const target of targets) {
        if (target === t.nodeId) continue;
        edgeRows.push({ from: t.nodeId, to: target, edgeType: 'USES_CONFIG', resolution: 'config_value_ref', calledName: value, line });
        configEdges++;
      }
    }

    for (const { value, line } of parsed.templateRefs) {
      const target = templateLookup.get(normalizeRef(value));
      if (!target || target === t.nodeId) continue;
      edgeRows.push({ from: t.nodeId, to: target, edgeType: 'REFERENCES', resolution: 'template_include', calledName: value, line });
      includeEdges++;
    }

    for (const { value, line } of parsed.urlRefs) {
      const key = value.split('?')[0].toLowerCase();
      const target = endpointByPath.get(key) || endpointByPath.get(`/${key.replace(/^\//, '')}`);
      if (target && target !== t.nodeId) {
        edgeRows.push({ from: t.nodeId, to: target, edgeType: 'REFERENCES', resolution: 'template_include', calledName: value, line });
        endpointEdges++;
        continue;
      }
      // Not a route — try it as a static asset path.
      const asset = assetBySuffix.get(`/${key.replace(/^\//, '')}`);
      if (!asset || asset === t.nodeId) continue;
      edgeRows.push({ from: t.nodeId, to: asset, edgeType: 'REFERENCES', resolution: 'template_include', calledName: value, line });
      assetEdges++;
    }

    if (t.viewName) viewNameTargets.set(t.viewName, t.nodeId);
  }

  // Controller -> view. A handler selects a template by naming it in a string
  // literal, which no AST edge can follow because the target is a file, not a
  // symbol. Frameworks disagree on the form of that string — Spring drops the
  // extension and the view root (`return "owners/findOwners";`), Django keeps
  // the extension and only part of the path (`template_name = 'forum/index.html'`
  // for `machina/templates/machina/forum/index.html`) — so the source scan uses
  // the same suffix lookup the include resolution does, which already discards
  // any key two templates could both answer to.
  const viewLookup = new Map(templateLookup);
  for (const [name, id] of viewNameTargets) if (!viewLookup.has(name.toLowerCase())) viewLookup.set(name.toLowerCase(), id);
  const viewEdges = await resolveViewNameEdges(branchId, repoPath, viewLookup, edgeRows, _pool);

  const written = await writeEdges(edgeRows, _pool);
  console.log(`[template-graph] branchId=${branchId} templates=${templates.length} config=${configEdges} include=${includeEdges} endpoint=${endpointEdges} asset=${assetEdges} view=${viewEdges} written=${written}`);
  return { templates: templates.length, configEdges, includeEdges, endpointEdges, assetEdges, viewEdges, written };
}

async function resolveViewNameEdges(branchId, repoPath, viewNameTargets, edgeRows, _pool) {
  if (!viewNameTargets.size) return 0;

  const { rows: sourceRows } = await _pool.query(
    `SELECT n.id AS node_id, n.node_type, n.start_line, n.end_line, f.path
     FROM nodes n
     JOIN files f ON f.id = n.file_id
     WHERE n.repository_branch_id = $1
       AND n.node_type IN ('METHOD','CONTROLLER','CLASS','SERVICE','PYTHON_CONTROLLER','PYTHON_SERVICE','NODE_CONTROLLER')
       AND n.approval_status != 'ARCHIVED'
     ORDER BY f.path, n.id`,
    [branchId]
  );
  const byPath = new Map();
  for (const r of sourceRows) {
    const list = byPath.get(r.path);
    if (list) list.push(r); else byPath.set(r.path, [r]);
  }

  // Longest view names first: `owners/createOrUpdateOwnerForm` must win over a
  // shorter name that happens to be its suffix.
  const viewNames = [...viewNameTargets.keys()].sort((a, b) => b.length - a.length);
  let count = 0;

  for (const [filePath, nodes] of byPath) {
    const ext = path.extname(filePath).toLowerCase();
    if (!SOURCE_EXTS_FOR_VIEW_SCAN.has(ext)) continue;
    const content = readIfSmall(path.join(repoPath, filePath));
    if (content === null) continue;
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('"') && !line.includes("'")) continue;
      // The lookup is keyed lowercase (paths are compared case-insensitively so
      // a `Templates/` root matches a `templates/` reference), so the line has
      // to be folded too — comparing a lowercased key against raw source found
      // only the view names that happened to be all-lowercase, 8 of 40 on
      // spring-petclinic.
      const lineLower = line.toLowerCase();
      for (const viewName of viewNames) {
        if (!lineLower.includes(viewName)) continue;
        // The literal has to be the WHOLE quoted string, not a substring of a
        // longer path — `"owners/findOwners"` binds, `"/owners/findOwnersX"`
        // does not.
        const quoted = new RegExp(`["'\`]${viewName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\`]`);
        if (!quoted.test(lineLower)) continue;
        const target = viewNameTargets.get(viewName);
        const lineNum = i + 1;
        // Narrowest node spanning the literal, so the edge lands on the handler
        // method rather than the whole class where both exist.
        const owner = nodes
          .filter((n) => n.start_line != null && n.end_line != null && n.start_line <= lineNum && lineNum <= n.end_line)
          .sort((a, b) => (a.end_line - a.start_line) - (b.end_line - b.start_line))[0]
          || nodes[0];
        if (!owner || owner.node_id === target) break;
        edgeRows.push({ from: owner.node_id, to: target, edgeType: 'REFERENCES', resolution: 'template_view_name', calledName: viewName, line: lineNum });
        count++;
        break;
      }
    }
  }
  return count;
}

module.exports = { resolveTemplateEdges };
