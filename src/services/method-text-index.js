// Method Text Index
//
// Builds the text representation of every method on every node and stores one row per
// (node, method) in method_text_index. This is a TEXT index, not a vector index:
// retrieval-channels.js#exact LEFT JOINs it and matches against method_text, which is also
// where a node's `Purpose:` line lives.
//
// Usage:
//   node src/services/method-text-index.js [--branchId=N] [--projectId=N]

// No `override: true` — this module is required by ingest.js, which other code
// (tests, scripts) requires as a library with DATABASE_URL already pointed at a
// specific DB. Overriding here would silently flip it back to the .env value.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const crypto = require('crypto');
const pool = require('../db/pool');

// Node types to skip. IMPORT is skipped because every retrieval channel already excludes it by
// node_type, so its text is unreachable by construction; this also covers any stale
// pre-existing IMPORT row. DIRECTORY nodes exist to
// make the file tree traversable, not to be retrieved: their only text is a path, so indexing them
// would add ~1 low-signal entry per directory competing against real code in every query.
const SKIP_TYPES = new Set(['IMPORT', 'DIRECTORY']);

// ─── _methodTextParts (internal) ─────────────────────────────────────────────
//
// Returns an array of text lines for a single method object.
// Used by both buildNodeText (concatenated) and buildMethodTexts (per-method).
// Supports both 'pseudocode' and 'steps' property names (sager versions differ).

function _methodTextParts(methodName, m) {
  const parts = [`Method: ${methodName}`];

  // Purpose — stored as 'summary' or 'purpose' depending on sager version
  const purpose = m.summary || m.purpose;
  if (purpose) parts.push(`  Purpose: ${purpose}`);

  // Steps — stored as 'pseudocode' OR 'steps' depending on sager version
  const stepsArr = Array.isArray(m.pseudocode) ? m.pseudocode
                 : Array.isArray(m.steps)      ? m.steps
                 : [];
  if (stepsArr.length > 0) {
    parts.push('  Steps:');
    stepsArr.forEach((step, i) => parts.push(`    ${i + 1}. ${step}`));
  }

  if (Array.isArray(m.validation_rules) && m.validation_rules.length > 0)
    parts.push(`  Validation: ${m.validation_rules.join(' | ')}`);

  if (Array.isArray(m.http_calls) && m.http_calls.length > 0) {
    const calls = m.http_calls.map((c) =>
      `${c.method || c.verb || 'POST'} to ${c.target}`
    ).join('; ');
    parts.push(`  HTTP calls: ${calls}`);
  }

  if (m.query_fragment) parts.push(`  Query: ${m.query_fragment}`);
  if (Array.isArray(m.tables_read)    && m.tables_read.length > 0)
    parts.push(`  Reads: ${m.tables_read.join(', ')}`);
  if (Array.isArray(m.tables_written) && m.tables_written.length > 0)
    parts.push(`  Writes: ${m.tables_written.join(', ')}`);

  if (Array.isArray(m.request_keys) && m.request_keys.length > 0)
    parts.push(`  Input keys: ${m.request_keys.join(', ')}`);
  if (Array.isArray(m.error_codes) && m.error_codes.length > 0)
    parts.push(`  Error codes: ${m.error_codes.join(', ')}`);

  if (Array.isArray(m.private_helpers) && m.private_helpers.length > 0) {
    const helpers = m.private_helpers
      .map(h => typeof h === 'string' ? h : `${h.name}: ${h.purpose}`)
      .join('; ');
    parts.push(`  Helpers: ${helpers}`);
  }
  if (Array.isArray(m.utility_calls) && m.utility_calls.length > 0) {
    const utils = m.utility_calls.map((u) => {
      if (typeof u === 'string') return u;
      if (u.method) return `${u.class}.${u.method}${u.purpose ? ` (${u.purpose})` : ''}`;
      return u.class || JSON.stringify(u);
    }).join('; ');
    parts.push(`  Utility: ${utils}`);
  }
  if (Array.isArray(m.repos_called) && m.repos_called.length > 0)
    parts.push(`  Repos: ${m.repos_called.join(', ')}`);
  if (Array.isArray(m.dbx_calls) && m.dbx_calls.length > 0) {
    const calls = m.dbx_calls.map(c => `${c.method || 'call'}("${c.xml_file}", "${c.proc_key}")`).join('; ');
    parts.push(`  DBX calls: ${calls}`);
  }
  if (Array.isArray(m.cache_ops) && m.cache_ops.length > 0) {
    // Support both 'op' (legacy Java prompts) and 'operation' (DOTNET prompts)
    const ops = m.cache_ops.map(c => `${c.op || c.operation} (key: ${c.key_pattern}, ttl: ${c.ttl || 'unset'})`).join('; ');
    parts.push(`  Cache: ${ops}`);
  }

  // ── Flutter ViewModel method fields ───────────────────────────────────────
  // These fields are populated by FLUTTER_VIEWMODEL_PROMPT and equivalent to
  // the Java SERVICE method fields for FSD retrieval purposes.
  if (Array.isArray(m.usecase_calls) && m.usecase_calls.length > 0)
    parts.push(`  UseCase calls: ${m.usecase_calls.join(', ')}`);
  if (Array.isArray(m.form_fields) && m.form_fields.length > 0)
    parts.push(`  Form fields: ${m.form_fields.join(', ')}`);
  if (Array.isArray(m.navigation) && m.navigation.length > 0)
    parts.push(`  Navigation: ${m.navigation.join(' | ')}`);
  if (Array.isArray(m.error_handling) && m.error_handling.length > 0)
    parts.push(`  Error handling: ${m.error_handling.join(' | ')}`);

  return parts;
}

// ─── buildNodeText ─────────────────────────────────────────────────────────────
//
// One rich string for the entire node — all methods concatenated. The `_node` fallback
// text for nodes that carry no method structure.

function buildNodeText(node) {
  const parts = [];
  const props = node.properties || {};

  parts.push(`[${node.node_type}] ${node.name}`);
  if (node.summary) parts.push(`Summary: ${node.summary}`);

  // Additional context for nodes without extracted methods (enriches _node fallback embeddings)
  if (node.file_path) parts.push(`File: ${node.file_path}`);
  if (props.filter_type)       parts.push(`Filter type: ${props.filter_type}`);
  if (props.functional_layer)  parts.push(`Layer: ${props.functional_layer}`);
  if (props.order !== undefined && props.order !== null) parts.push(`Execution order: ${props.order}`);
  if (Array.isArray(props.annotations) && props.annotations.length)
    parts.push(`Annotations: ${props.annotations.join(', ')}`);
  if (Array.isArray(props.implements) && props.implements.length)
    parts.push(`Implements: ${props.implements.join(', ')}`);
  if (props.extends)          parts.push(`Extends: ${props.extends}`);
  if (props.intercepted_urls) parts.push(`Intercepts: ${props.intercepted_urls}`);
  if (props.excluded_urls)    parts.push(`Excludes: ${props.excluded_urls}`);
  // raw_evidence excerpt gives the embedding actual code context when methods are absent
  if (node.raw_evidence && (!props.methods || Object.keys(props.methods).length === 0)) {
    const excerpt = node.raw_evidence.toString().slice(0, 400).replace(/\n/g, ' ');
    if (excerpt.trim()) parts.push(`Evidence: ${excerpt}`);
  }

  const methods = props.methods;
  if (node.node_type === 'DOTNET_PROC_CATALOG') {
    // Proc catalog: render each <proc> entry with its stored-proc details
    if (methods && typeof methods === 'object') {
      for (const [key, proc] of Object.entries(methods)) {
        if (!proc || typeof proc !== 'object') continue;
        let line = `Proc [${key}]`;
        if (proc.proc_name) line += ` → ${proc.proc_name}`;
        if (proc.db) line += ` [db: ${proc.db}]`;
        parts.push(line);
        if (Array.isArray(proc.input_params) && proc.input_params.length > 0)
          parts.push(`  Params: ${proc.input_params.join(', ')}`);
        if (proc.inline_query) parts.push(`  Query: ${proc.inline_query.slice(0, 150)}`);
        if (Array.isArray(proc.tables_read) && proc.tables_read.length > 0)
          parts.push(`  Reads: ${proc.tables_read.join(', ')}`);
        if (Array.isArray(proc.tables_written) && proc.tables_written.length > 0)
          parts.push(`  Writes: ${proc.tables_written.join(', ')}`);
      }
    }
  } else if (methods && typeof methods === 'object') {
    for (const [methodName, m] of Object.entries(methods)) {
      if (!m || typeof m !== 'object') continue;
      parts.push(..._methodTextParts(methodName, m));
    }
  }

  // REPOSITORY / DOTNET_REPOSITORY — query_methods fallback
  if ((node.node_type === 'REPOSITORY' || node.node_type === 'DOTNET_REPOSITORY') && !methods) {
    const queryMethods = props.query_methods;
    if (queryMethods && typeof queryMethods === 'object') {
      for (const [methodName, m] of Object.entries(queryMethods)) {
        if (!m || typeof m !== 'object') continue;
        parts.push(..._methodTextParts(methodName, m));
      }
    }
  }

  if (node.node_type === 'DB_TABLE') {
    const schema = props.schema || props.columns;
    if (schema) parts.push(`Schema: ${JSON.stringify(schema).slice(0, 300)}`);
    const tableName = props.table_name || node.name;
    if (tableName) parts.push(`Table: ${tableName}`);
  }
  if (node.node_type === 'STORED_PROC') {
    // SP data is stored in raw_evidence JSON (not properties), parse it
    let spData = props; // fallback to props if raw_evidence unavailable
    try {
      if (node.raw_evidence) {
        spData = typeof node.raw_evidence === 'string'
          ? JSON.parse(node.raw_evidence)
          : node.raw_evidence;
      }
    } catch (_) { /* leave spData as props */ }
    if (Array.isArray(spData.params) && spData.params.length > 0) {
      parts.push(`Parameters: ${spData.params.map(p => `${p.name} ${p.type}${p.is_output ? ' OUTPUT' : ''}`).join(', ')}`);
    }
    if (Array.isArray(spData.tables_read) && spData.tables_read.length > 0) {
      parts.push(`Reads tables: ${spData.tables_read.join(', ')}`);
    }
    if (Array.isArray(spData.tables_written) && spData.tables_written.length > 0) {
      parts.push(`Writes tables: ${spData.tables_written.join(', ')}`);
    }
    // body (new) or body_preview (legacy nodes before re-upload)
    const body = spData.body || spData.body_preview || '';
    if (body) parts.push(`Body: ${body.slice(0, 800)}`);
  }
  if (node.node_type === 'EXTERNAL_SYSTEM') {
    if (props.protocol)    parts.push(`Protocol: ${props.protocol}`);
    if (props.description) parts.push(`Description: ${props.description}`);
  }
  if (node.node_type === 'SCHEDULER') {
    if (props.cron)      parts.push(`Schedule: ${props.cron}`);
    if (props.job_class) parts.push(`Job class: ${props.job_class}`);
  }

  // ── Flutter node types ────────────────────────────────────────────────────
  // FLUTTER_SCREEN — no methods; embed UI structure directly
  if (node.node_type === 'FLUTTER_SCREEN') {
    if (Array.isArray(props.ui_components) && props.ui_components.length > 0)
      parts.push(`UI components: ${props.ui_components.join(' | ')}`);
    if (Array.isArray(props.user_interactions) && props.user_interactions.length > 0)
      parts.push(`User interactions: ${props.user_interactions.join(' | ')}`);
    if (Array.isArray(props.navigation_triggers) && props.navigation_triggers.length > 0)
      parts.push(`Navigation: ${props.navigation_triggers.join(' | ')}`);
  }

  // FLUTTER_API_CLIENT (individual endpoint nodes — name IS the path, e.g. "POST /api/v1/...")
  if (node.node_type === 'FLUTTER_API_CLIENT') {
    if (props.request_type)  parts.push(`Request body: ${props.request_type}`);
    if (props.response_type) parts.push(`Response type: ${props.response_type}`);
  }

  // FLUTTER_ROUTER — top-N routes for semantic matching
  if (node.node_type === 'FLUTTER_ROUTER' && Array.isArray(props.routes) && props.routes.length > 0) {
    const routeLines = props.routes.slice(0, 15).map(r =>
      `${r.name || '?'}: ${r.path || '?'}${r.page ? ` → ${r.page}` : ''}`
    ).join('\n  ');
    parts.push(`Routes:\n  ${routeLines}`);
  }

  // FLUTTER_NOTIFIER — state type and mutations
  if (node.node_type === 'FLUTTER_NOTIFIER') {
    if (props.state_type)  parts.push(`State type: ${props.state_type}`);
    if (Array.isArray(props.state_values) && props.state_values.length > 0)
      parts.push(`State values: ${props.state_values.join(', ')}`);
    if (Array.isArray(props.mutations) && props.mutations.length > 0)
      parts.push(`Mutations: ${props.mutations.join(', ')}`);
    if (props.provider_name) parts.push(`Provider: ${props.provider_name}`);
  }

  // FLUTTER_USECASE — params schema and repository delegation
  if (node.node_type === 'FLUTTER_USECASE') {
    if (props.params_type)  parts.push(`Params type: ${props.params_type}`);
    if (Array.isArray(props.params_fields) && props.params_fields.length > 0)
      parts.push(`Params fields: ${props.params_fields.join(', ')}`);
    if (props.response_type)     parts.push(`Response type: ${props.response_type}`);
    if (props.repository_method) parts.push(`Repository method: ${props.repository_method}`);
  }

  // FLUTTER_VIEWMODEL class-level fields (complementing the per-method texts)
  if (node.node_type === 'FLUTTER_VIEWMODEL') {
    if (Array.isArray(props.form_fields) && props.form_fields.length > 0)
      parts.push(`Form fields: ${props.form_fields.join(', ')}`);
    if (Array.isArray(props.riverpod_reads) && props.riverpod_reads.length > 0)
      parts.push(`Riverpod reads: ${props.riverpod_reads.join(', ')}`);
  }

  return parts.join('\n');
}

// ─── buildMethodTexts ─────────────────────────────────────────────────────────
//
// Returns one { methodName, text } entry PER METHOD for a node.
// Each text includes the node header + summary as context, then that specific
// method's details only — one focused vector per function.
//
// Nodes without a method structure (ENDPOINT with null properties, DB_TABLE,
// EXTERNAL_SYSTEM) return a single entry with methodName='_node'.

function buildMethodTexts(node) {
  const props = node.properties || {};

  // Shared context prefix for all method texts
  const preambleParts = [`[${node.node_type}] ${node.name}`];
  if (node.summary) preambleParts.push(`Summary: ${node.summary}`);
  const preamble = preambleParts.join('\n');

  const results = [];

  // SERVICE / ENDPOINT / SCHEDULER with a methods object
  const methods = props.methods;
  if (node.node_type === 'DOTNET_PROC_CATALOG') {
    // One embedding per proc key — each includes proc_name, db, params, inline query
    if (methods && typeof methods === 'object') {
      for (const [key, proc] of Object.entries(methods)) {
        if (!proc || typeof proc !== 'object') continue;
        const lines = [`${preamble}`, `Proc [${key}]`];
        if (proc.proc_name) lines.push(`  StoredProc: ${proc.proc_name}`);
        if (proc.db) lines.push(`  DB: ${proc.db}`);
        if (Array.isArray(proc.input_params) && proc.input_params.length > 0)
          lines.push(`  Params: ${proc.input_params.join(', ')}`);
        if (proc.inline_query) lines.push(`  Query: ${proc.inline_query.slice(0, 150)}`);
        if (Array.isArray(proc.tables_read) && proc.tables_read.length > 0)
          lines.push(`  Reads: ${proc.tables_read.join(', ')}`);
        if (Array.isArray(proc.tables_written) && proc.tables_written.length > 0)
          lines.push(`  Writes: ${proc.tables_written.join(', ')}`);
        results.push({ methodName: key, text: lines.join('\n') });
      }
    }
  } else if (methods && typeof methods === 'object') {
    for (const [methodName, m] of Object.entries(methods)) {
      if (!m || typeof m !== 'object') continue;
      results.push({
        methodName,
        text: [preamble, ..._methodTextParts(methodName, m)].join('\n'),
      });
    }
  }

  // REPOSITORY / DOTNET_REPOSITORY — per-SQL-method fallback
  if ((node.node_type === 'REPOSITORY' || node.node_type === 'DOTNET_REPOSITORY') && !results.length) {
    const queryMethods = props.query_methods || props.methods;
    if (queryMethods && typeof queryMethods === 'object') {
      for (const [methodName, m] of Object.entries(queryMethods)) {
        if (!m || typeof m !== 'object') continue;
        results.push({
          methodName,
          text: [preamble, ..._methodTextParts(methodName, m)].join('\n'),
        });
      }
    }
  }

  // Fallback: no method structure found → embed the whole node as _node
  if (results.length === 0) {
    results.push({ methodName: '_node', text: buildNodeText(node) });
  }

  return results;
}

// ─── computeMethodTextHash ───────────────────────────────────────────────────

function computeMethodTextHash(text) {
  return crypto.createHash('sha256').update(text || '', 'utf8').digest('hex');
}

// ─── storeMethodTexts ────────────────────────────────────────────────────────

async function storeMethodTexts(nodeId, methodTexts, { generationId = null, db } = {}) {
  const pg = db || pool;
  for (const m of methodTexts) {
    await pg.query(
      `INSERT INTO method_text_index
         (node_id, method_name, method_text, method_text_hash, ingest_generation_id, embedding_status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       ON CONFLICT (node_id, method_name) DO UPDATE SET
         method_text          = EXCLUDED.method_text,
         method_text_hash     = EXCLUDED.method_text_hash,
         ingest_generation_id = EXCLUDED.ingest_generation_id,
         embedding_status     = 'active'`,
      [nodeId, m.methodName, m.text, computeMethodTextHash(m.text), generationId],
    );
  }
  return methodTexts.length;
}

// ─── writeMethodTextIndex ────────────────────────────────────────────────────
//
// Rebuilds the index for a scope: writes a row for every (node, method) an APPROVED node
// expects, and archives every active row that is no longer expected. Replaces the vector
// reconciliation loop — with no model there is no profile drift and no work queue, so a
// row is either current (hash matches) or rewritten.

function buildScopeFilters({ repositoryBranchId, projectId }, params) {
  const conditions = [`n.approval_status = 'APPROVED'`];
  if (repositoryBranchId) {
    params.push(repositoryBranchId);
    conditions.push(`n.repository_branch_id = $${params.length}`);
  } else if (projectId) {
    params.push(projectId);
    conditions.push(`n.repository_branch_id IN (
      SELECT rb.id FROM repository_branches rb
      JOIN repositories r ON r.id = rb.repository_id
      WHERE r.project_id = $${params.length}
    )`);
  }
  return conditions;
}

async function writeMethodTextIndex(options = {}) {
  const { repositoryBranchId, projectId, force = false, db } = options;
  const pg = db || pool;

  const params = [];
  const conditions = buildScopeFilters({ repositoryBranchId, projectId }, params);

  const { rows: nodes } = await pg.query(
    `SELECT n.id, n.node_type, n.name, n.summary, n.properties, n.raw_evidence,
            n.ingest_generation_id
       FROM nodes n
      WHERE ${conditions.join(' AND ')}
      ORDER BY n.id`,
    params,
  );

  const existingParams = [];
  const existingConditions = buildScopeFilters({ repositoryBranchId, projectId }, existingParams);
  const { rows: existing } = await pg.query(
    `SELECT mti.id, mti.node_id, mti.method_name, mti.method_text_hash, mti.ingest_generation_id
       FROM method_text_index mti
       JOIN nodes n ON n.id = mti.node_id
      WHERE ${existingConditions.join(' AND ')}
        AND mti.embedding_status = 'active'`,
    existingParams,
  );
  const existingByKey = new Map(existing.map((r) => [`${r.node_id}:${r.method_name}`, r]));

  const expectedKeys = new Set();
  let written = 0;
  for (const node of nodes) {
    if (SKIP_TYPES.has(node.node_type)) continue;
    const texts = buildMethodTexts(node);
    const stale = [];
    for (const m of texts) {
      const key = `${node.id}:${m.methodName}`;
      expectedKeys.add(key);
      const prior = existingByKey.get(key);
      const hash = computeMethodTextHash(m.text);
      if (force || !prior || prior.method_text_hash !== hash ||
          prior.ingest_generation_id !== (node.ingest_generation_id || null)) {
        stale.push(m);
      }
    }
    if (stale.length) written += await storeMethodTexts(node.id, stale, {
      generationId: node.ingest_generation_id || null, db: pg,
    });
  }

  const orphanIds = existing.filter((r) => !expectedKeys.has(`${r.node_id}:${r.method_name}`)).map((r) => r.id);
  let archived = 0;
  if (orphanIds.length) {
    const { rowCount } = await pg.query(
      `UPDATE method_text_index SET embedding_status = 'archived' WHERE id IN (SELECT value FROM json_each($1))`,
      [orphanIds],
    );
    archived = rowCount;
  }

  // An APPROVED node that later becomes ARCHIVED leaves rows the scope query above no longer
  // sees, because that query joins through the same approval filter.
  const inactiveParams = [];
  const inactiveConditions = [];
  if (repositoryBranchId) {
    inactiveParams.push(repositoryBranchId);
    inactiveConditions.push(`n.repository_branch_id = $${inactiveParams.length}`);
  } else if (projectId) {
    inactiveParams.push(projectId);
    inactiveConditions.push(`n.repository_branch_id IN (
      SELECT rb.id FROM repository_branches rb
      JOIN repositories r ON r.id = rb.repository_id
      WHERE r.project_id = $${inactiveParams.length}
    )`);
  }
  const inactiveScope = inactiveConditions.length ? `AND ${inactiveConditions.join(' AND ')}` : '';
  const { rowCount: archivedInactive } = await pg.query(
    `UPDATE method_text_index SET embedding_status = 'archived'
      WHERE embedding_status = 'active'
        AND node_id IN (SELECT n.id FROM nodes n
                         WHERE n.approval_status <> 'APPROVED' ${inactiveScope})`,
    inactiveParams,
  );

  return { written, archived: archived + (archivedInactive || 0), expected: expectedKeys.size };
}

module.exports = {
  buildNodeText,
  buildMethodTexts,
  computeMethodTextHash,
  storeMethodTexts,
  writeMethodTextIndex,
};

if (require.main === module) {
  const arg = (k) => {
    const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
    return hit ? parseInt(hit.split('=')[1], 10) : undefined;
  };
  writeMethodTextIndex({ repositoryBranchId: arg('branchId'), projectId: arg('projectId') })
    .then((r) => { console.log('[method-text-index]', JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error('[method-text-index]', e); process.exit(1); });
}
