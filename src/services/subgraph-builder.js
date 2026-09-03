// Subgraph → text
//
// Takes the { nodes, edges } returned by graph-retriever.js and converts it into the structured
// text block a reader — an agent, a benchmark harness — actually receives.
//
// Format example:
//
//   KNOWLEDGE GRAPH — exact-name, full-text and graph-expansion retrieval, most relevant first
//   ══════════════════════════════════════════════════════════════════════════════════════════
//
//   [ENDPOINT] POST /api/v1/orders
//     Summary: Creates an order
//     → CALLS → OrderService
//
//   [SERVICE] OrderService
//     Method: submitOrder
//       Purpose: Validates the cart and charges the payment provider
//       Steps:
//         1. Validate the line items
//         2. Reserve stock
//         3. POST to the payment provider
//       Validation: quantity must be positive
//       HTTP calls: POST to the payment provider
//       Reads: orders
//     → CALLS_REPO → OrderRepository
//
//   GRAPH EDGES
//   ───────────
//     POST /api/v1/orders → CALLS → OrderService
//     OrderService → CALLS_REPO → OrderRepository

// Node type display order, most important first. It is the tie-break for the relevance sort
// below and the whole ordering when no node carries a retrieval score. DOMAIN sits near the end
// — it is structural context, not implementation detail.
const TYPE_ORDER = [
  'ENDPOINT', 'FILTER', 'INTERCEPTOR', 'SERVICE', 'NODE_SERVICE', 'NODE_CONTROLLER',
  'REPOSITORY', 'NODE_MODEL', 'NODE_ENTRYPOINT',
  'DB_TABLE', 'EXTERNAL_SYSTEM', 'SCHEDULER', 'DOMAIN',
];

// ─── Serialisation policy flags ───────────────────────────────────────────────
//
// Read per call, not at module load, so a caller can flip one for a single request and so tests
// don't need a fresh module registry. Same idiom as SUBGRAPH_DETAIL_CAP below.
function serialisationPolicy() {
  const env = process.env;
  return {
    // Per-node `→ TYPE → target` arrows restate the GRAPH EDGES block, which is built from the same
    // edge set. Default OFF; SUBGRAPH_NODE_ARROWS=on restores the verbose arrows.
    nodeArrows:   env.SUBGRAPH_NODE_ARROWS === 'on',
    // The grouped GRAPH EDGES block. Stays on because name-presence recall structurally cannot
    // value a relation, so dropping it would remove signal no other line carries.
    edgeBlock:    env.SUBGRAPH_EDGE_BLOCK !== 'off',
    // One line per file instead of one line per symbol. The flat index repeats the same path many
    // times in a single context; symbol and file still share a line, which is all a citing model
    // needs. Default ON; SUBGRAPH_INDEX_GROUPED=0 restores the flat one-line-per-symbol index.
    groupedIndex: env.SUBGRAPH_INDEX_GROUPED !== '0',
    // 'off' drops the banner and the rule lines entirely; 'terse' keeps the one-line header.
    // Default 'terse'; SUBGRAPH_BANNER=full restores the title/rule-line banner.
    banner:       env.SUBGRAPH_BANNER === 'full' ? 'full' : (env.SUBGRAPH_BANNER === 'off' ? 'off' : 'terse'),
  };
}

// ─── Format a single node's properties into readable text ────────────────────

function formatNodeDetail(node, policy = serialisationPolicy()) {
  const lines = [];
  const props = node.properties || {};

  if (node.summary) {
    lines.push(`  Summary: ${node.summary}`);
  }

  // ── Filter / Interceptor metadata ────────────────────────────────────────
  if (props.filter_type)       lines.push(`  Filter type: ${props.filter_type}`);
  if (props.order != null)     lines.push(`  Order: ${props.order}`);
  if (Array.isArray(props.annotations)  && props.annotations.length)  lines.push(`  Annotations: ${props.annotations.join(', ')}`);
  if (Array.isArray(props.implements)   && props.implements.length)   lines.push(`  Implements: ${props.implements.join(', ')}`);
  if (Array.isArray(props.intercepted_urls) && props.intercepted_urls.length) lines.push(`  Intercepts: ${props.intercepted_urls.join(', ')}`);
  if (Array.isArray(props.excluded_urls)    && props.excluded_urls.length)    lines.push(`  Excludes: ${props.excluded_urls.join(', ')}`);

  // ── Methods (SERVICE, ENDPOINT) ───────────────────────────────────────────
  const methods = props.methods;
  if (methods && typeof methods === 'object') {
    for (const [methodName, m] of Object.entries(methods)) {
      if (!m || typeof m !== 'object') continue;

      lines.push(`  Method: ${methodName}`);

      if (m.summary || m.purpose) {
        lines.push(`    Purpose: ${m.summary || m.purpose}`);
      }

      if (Array.isArray(m.pseudocode) && m.pseudocode.length > 0) {
        lines.push('    Steps:');
        m.pseudocode.forEach((step, i) => lines.push(`      ${i + 1}. ${step}`));
      }

      if (Array.isArray(m.validation_rules) && m.validation_rules.length > 0) {
        lines.push(`    Validation: ${m.validation_rules.join(' | ')}`);
      }

      if (Array.isArray(m.http_calls) && m.http_calls.length > 0) {
        const calls = m.http_calls.map((c) =>
          `${c.method || c.verb || 'POST'} to ${c.target}`
        ).join('; ');
        lines.push(`    HTTP calls: ${calls}`);
      }

      if (Array.isArray(m.tables_read) && m.tables_read.length > 0) {
        lines.push(`    Reads: ${m.tables_read.join(', ')}`);
      }
      if (Array.isArray(m.tables_written) && m.tables_written.length > 0) {
        lines.push(`    Writes: ${m.tables_written.join(', ')}`);
      }

      if (Array.isArray(m.request_keys) && m.request_keys.length > 0) {
        lines.push(`    Input keys: ${m.request_keys.join(', ')}`);
      }

      if (Array.isArray(m.error_codes) && m.error_codes.length > 0) {
        lines.push(`    Error codes: ${m.error_codes.join(', ')}`);
      }

      if (Array.isArray(m.private_helpers) && m.private_helpers.length > 0) {
        const helpers = m.private_helpers
          .map(h => typeof h === 'string' ? h : `${h.name}: ${h.purpose}`)
          .join('; ');
        lines.push(`    Helpers: ${helpers}`);
      }

      if (Array.isArray(m.utility_calls) && m.utility_calls.length > 0) {
        const utils = m.utility_calls.map((u) => {
          if (typeof u === 'string') return u;
          if (u.method) return `${u.class}.${u.method}${u.purpose ? ` (${u.purpose})` : ''}`;
          return u.class || JSON.stringify(u);
        }).join('; ');
        lines.push(`    Utility: ${utils}`);
      }

      if (Array.isArray(m.repos_called) && m.repos_called.length > 0) {
        lines.push(`    Repos: ${m.repos_called.join(', ')}`);
      }

      if (Array.isArray(m.cache_ops) && m.cache_ops.length > 0) {
        const ops = m.cache_ops.map(c => `${c.op} (key: ${c.key_pattern}, ttl: ${c.ttl || 'unset'})`).join('; ');
        lines.push(`    Cache: ${ops}`);
      }
    }
  }

  // ── REPOSITORY query_methods ──────────────────────────────────────────────
  const queryMethods = props.query_methods;
  if (node.node_type === 'REPOSITORY' && queryMethods && typeof queryMethods === 'object') {
    for (const [methodName, m] of Object.entries(queryMethods)) {
      if (!m || typeof m !== 'object') continue;
      lines.push(`  Method: ${methodName}`);
      if (m.summary || m.purpose) lines.push(`    Purpose: ${m.summary || m.purpose}`);
      if (m.query_fragment)       lines.push(`    Query: ${m.query_fragment}`);
      if (Array.isArray(m.tables_read))    lines.push(`    Reads: ${m.tables_read.join(', ')}`);
      if (Array.isArray(m.tables_written)) lines.push(`    Writes: ${m.tables_written.join(', ')}`);
    }
  }

  // ── STORED_PROC body + signature ─────────────────────────────────────────
  // SP structured data lives in raw_evidence JSON (not properties).
  // Include params, table I/O, and the body so the LLM can reason about
  // variable names, WHERE conditions, and threshold checks inside the proc.
  if (node.node_type === 'STORED_PROC') {
    let spData = {};
    try {
      if (node.raw_evidence) {
        spData = typeof node.raw_evidence === 'string'
          ? JSON.parse(node.raw_evidence)
          : node.raw_evidence;
      }
    } catch (_) { /* leave spData empty */ }
    const params        = spData.params        || props.params        || [];
    const tablesRead    = spData.tables_read    || props.tables_read    || [];
    const tablesWritten = spData.tables_written || props.tables_written || [];
    const body          = spData.body || spData.body_preview || props.body_preview || '';
    if (params.length > 0) {
      lines.push(`  Parameters: ${params.map(p => `${p.name} ${p.type}${p.is_output ? ' OUTPUT' : ''}`).join(', ')}`);
    }
    if (tablesRead.length > 0)    lines.push(`  Reads: ${tablesRead.join(', ')}`);
    if (tablesWritten.length > 0) lines.push(`  Writes: ${tablesWritten.join(', ')}`);
    if (body) lines.push(`  Body:\n${body.slice(0, 2000)}`);
  }

  // ── DB_TABLE schema ───────────────────────────────────────────────────────
  if (node.node_type === 'DB_TABLE') {
    const schema = props.schema || props.columns;
    const tableName = props.table_name || node.name;
    if (tableName) lines.push(`  Table: ${tableName}`);
    if (schema) lines.push(`  Schema: ${JSON.stringify(schema).slice(0, 400)}`);
  }

  // ── EXTERNAL_SYSTEM ───────────────────────────────────────────────────────
  if (node.node_type === 'EXTERNAL_SYSTEM') {
    if (props.protocol)    lines.push(`  Protocol: ${props.protocol}`);
    if (props.description) lines.push(`  Description: ${props.description}`);
  }

  // ── SCHEDULER ─────────────────────────────────────────────────────────────
  if (node.node_type === 'SCHEDULER') {
    if (props.cron)      lines.push(`  Schedule: ${props.cron}`);
    if (props.job_class) lines.push(`  Job class: ${props.job_class}`);
  }

  return lines;
}

// ─── Build edge index: nodeId → outgoing edge descriptions ───────────────────

// How much of a code relationship each edge type asserts. Shared in spirit with graph-ppr.js's
// EDGE_WEIGHTS: CALLS/EXTENDS/IMPLEMENTS are what a reader must follow, while COUPLED_WITH is a
// statistical co-occurrence and belongs last in a context that may be cut.
const EDGE_RENDER_WEIGHT = Object.freeze({
  CALLS: 1.0, EXTENDS: 1.0, IMPLEMENTS: 1.0,
  DEPENDS_ON: 0.9, READS_TABLE: 0.9, WRITES_TABLE: 0.9, MAPS_TO: 0.9,
  PRODUCES: 0.9, CONSUMES: 0.9,
  USES_CONFIG: 0.7, BELONGS_TO: 0.6, CONTAINS: 0.5, DEFINED_IN: 0.5,
  COUPLED_WITH: 0.25,
});

function buildEdgeIndex(edges) {
  // index: fromNodeId → [{ edgeType, toName, isCrossRepo }]
  const index = {};
  for (const e of edges) {
    if (!index[e.from_node_id]) index[e.from_node_id] = [];
    index[e.from_node_id].push({
      edgeType:    e.edge_type,
      toName:      e.to_name,
      iscrossRepo: e.is_cross_repo,
    });
  }
  return index;
}

// ─── Project Context formatter ────────────────────────────────────────────────
// Renders the per-project JSONB context document into a readable LLM text block.
// Returns null when context is empty/missing so callers can omit the section.

function formatProjectContext(context) {
  if (!context || typeof context !== 'object') return null;

  const lines = [];

  // DB alias map section
  const aliases = context.db_aliases;
  if (aliases && typeof aliases === 'object' && Object.keys(aliases).length > 0) {
    lines.push('Database alias map (codebase datasource name → actual database):');
    const maxKeyLen = Math.max(...Object.keys(aliases).map(k => k.length));
    for (const [alias, real] of Object.entries(aliases)) {
      lines.push(`  ${alias.padEnd(maxKeyLen)}  →  ${real}`);
    }
  }

  // Notes section (free-text domain knowledge)
  const notes = (context.notes || '').trim();
  if (notes) {
    if (lines.length > 0) lines.push('');
    lines.push('Notes:');
    lines.push(`  ${notes.split('\n').join('\n  ')}`);
  }

  if (lines.length === 0) return null;

  return [
    'PROJECT CONTEXT',
    '═══════════════',
    ...lines,
  ].join('\n');
}

// ─── Main formatter ───────────────────────────────────────────────────────────

function formatSubgraph(nodes, edges, projectContext = null) {
  if (!nodes || nodes.length === 0) {
    return 'KNOWLEDGE GRAPH\n══════════════\n(No relevant nodes retrieved — no declaration, source text or graph neighbour matched this query on the indexed branch)';
  }

  const policy = serialisationPolicy();
  const edgeIndex = buildEdgeIndex(edges);

  // Sort nodes by type priority, then by name.
  // SERVICE nodes with properties.filter_type are treated as FILTER for ordering —
  // they rank between ENDPOINT and generic SERVICE so the LLM sees them near the top.
  const effectiveType = (n) => {
    const isFilterLike = (n.node_type === 'SERVICE' || n.node_type === 'NODE_SERVICE')
      && n.properties?.filter_type;
    return isFilterLike ? 'FILTER' : n.node_type;
  };

  // Rank by retrieval relevance when the retriever supplied it (graph-retriever's
  // attachRetrievalScores() puts retrieval_score on every node); a consumer with a context limit
  // truncating in type/alphabetical order — uncorrelated with relevance — would drop the node that
  // answered the question. Type order is the tie-break, and the whole ordering when no node carries
  // a score, so callers that pass unscored nodes see byte-identical output.
  const typeRank = (n) => {
    const i = TYPE_ORDER.indexOf(effectiveType(n));
    return i === -1 ? 99 : i;
  };
  const hasScores = nodes.some(n => Number.isFinite(Number(n.retrieval_score)));
  const sorted = [...nodes].sort((a, b) => {
    if (hasScores) {
      const d = (Number(b.retrieval_score) || 0) - (Number(a.retrieval_score) || 0);
      if (d) return d;
    }
    return typeRank(a) - typeRank(b) || a.name.localeCompare(b.name);
  });

  // Detail for what retrieval judged relevant; pointers for the neighbourhood it expanded into.
  // The SYMBOLS index above already locates every node by name and file:line, and expansion nodes
  // are structural neighbours pulled in by traversal, not candidates retrieval scored as answering
  // the question — so spending a summary and edge list on each is wasteful. Seeds and exact-name
  // matches keep full detail; expansion nodes keep only their index line. When the retriever
  // supplies no origin, every node keeps its detail, so callers that pass unscored nodes are
  // unchanged.
  const relevantOrigins = new Set(['seed', 'seed_exact_name', 'expansion_exact_name']);
  const hasOrigins = nodes.some(n => n.retrieval_origin);
  // Seed count scales with the caller's budget (graph-retriever#deriveTopKFromBudget); past a
  // couple of dozen candidates the useful surface is the index, which already locates every node.
  // The cap is on the DETAIL section only: every node keeps its index line, so nothing becomes
  // unreachable, and callers that pass unscored nodes are unaffected.
  const detailCap = parseInt(process.env.SUBGRAPH_DETAIL_CAP || '25', 10);
  const detailed = hasOrigins
    ? sorted.filter(n => relevantOrigins.has(n.retrieval_origin)).slice(0, detailCap)
    : sorted;

  const nodeBlocks = (detailed.length ? detailed : sorted).map(node => {
    // No file:line in the detail header — the SYMBOLS index above already carries it for every
    // node, so repeating it here pays for the same information twice.
    const header = `[${node.node_type}] ${node.name}`;
    const detail = formatNodeDetail(node, policy);

    // Append outgoing edge arrows
    const outEdges = policy.nodeArrows ? (edgeIndex[node.id] || []).map(e => {
      // Field is spelled `iscrossRepo` to match buildEdgeIndex.
      const crossLabel = e.iscrossRepo ? ' [cross-repo]' : '';
      return `  → ${e.edgeType} → ${e.toName}${crossLabel}`;
    }) : [];

    const parts = [header, ...detail, ...outEdges];
    return parts.join('\n');
  });

  // ── Edges: grouped by source, ordered by the source's own relevance ──────────
  //
  // Grouping by (source, edge type) prints a source node's name once and lists its targets,
  // instead of repeating it per callee. Ordering is: the source node's rank in `sorted` (retrieval
  // relevance), then edge type by how much of a code relationship it asserts, then target name — so
  // a truncated context keeps the relationships of the nodes retrieval judged most relevant and
  // drops the weakest association edges of the least relevant ones.
  const rankOfNode = new Map(sorted.map((n, i) => [String(n.id), i]));

  // Scope: edges incident to a node retrieval judged RELEVANT (a seed or an exact-name match) —
  // the same set that keeps its DETAIL block above. An expansion node is a structural neighbour
  // that was pulled in, not something the caller asked about; its index line locates it, and
  // printing its own neighbourhood spends the caller's budget answering a question nobody asked.
  // When the retriever supplies no origin at all, every node counts as relevant and the block is
  // unchanged, exactly as the DETAIL policy behaves.
  const relevantIds = hasOrigins
    ? new Set(nodes.filter(n => relevantOrigins.has(n.retrieval_origin)).map(n => String(n.id)))
    : null;
  const edgeInScope = (e) => !relevantIds
    || relevantIds.has(String(e.from_node_id))
    || relevantIds.has(String(e.to_node_id));

  const edgeGroups = new Map();
  for (const e of (policy.edgeBlock ? edges : [])) {
    if (!edgeInScope(e)) continue;
    const key = `${e.from_node_id}\u0000${e.edge_type}`;
    let g = edgeGroups.get(key);
    if (!g) {
      g = {
        fromId: String(e.from_node_id),
        fromName: e.from_name,
        edgeType: e.edge_type,
        targets: new Map(),
      };
      edgeGroups.set(key, g);
    }
    const label = `${e.to_name}${e.is_cross_repo ? ' [cross-repo]' : ''}`;
    if (!g.targets.has(label)) g.targets.set(label, true);
  }

  const orderedGroups = [...edgeGroups.values()].sort((a, b) => {
    const ra = rankOfNode.has(a.fromId) ? rankOfNode.get(a.fromId) : Number.MAX_SAFE_INTEGER;
    const rb = rankOfNode.has(b.fromId) ? rankOfNode.get(b.fromId) : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    const wa = EDGE_RENDER_WEIGHT[a.edgeType] ?? 1.0;
    const wb = EDGE_RENDER_WEIGHT[b.edgeType] ?? 1.0;
    if (wa !== wb) return wb - wa;
    return String(a.fromName || '').localeCompare(String(b.fromName || ''));
  });

  const edgeLines = orderedGroups.map(g =>
    `  ${g.fromName} →[${g.edgeType}]→ ${[...g.targets.keys()].join(', ')}`);

  const edgesBlock = edgeLines.length
    ? edgeLines.join('\n')
    : '  (none)';

  const contextBlock = formatProjectContext(projectContext);

  const parts = [];
  if (contextBlock) {
    parts.push(contextBlock);
    parts.push('');
  }
  // Pointer-first index: every retrieved symbol, in relevance order, one line each, BEFORE the
  // detailed blocks. A consuming model (or a human) sees the full candidate list immediately and
  // can jump to the detail it wants, instead of reading prose until it reaches the answer. At a
  // tight budget a pointer-only line fits more candidates in the same tokens than a detail block.
  const lineOf = (node) =>
    (node.start_line != null && Number.isFinite(Number(node.start_line))) ? String(node.start_line) : null;

  // Grouped form emits the path once per file instead of once per symbol. The symbol name and the
  // file still share a line — a citing model needs that co-location. Line numbers are kept so the
  // agent can jump to the line.
  //
  // Files are ordered by their most relevant member, members keep relevance order within the file,
  // so a truncated index still loses the least relevant files last. Nodes with no file_path form a
  // single unlabelled group placed at its own first-appearance rank, so one ordering rule covers
  // every node.
  const indexLines = policy.groupedIndex
    ? (() => {
        const groups = new Map();
        for (const node of sorted) {
          const key = node.file_path || '';
          if (!groups.has(key)) groups.set(key, []);
          const line = lineOf(node);
          groups.get(key).push(`${node.node_type} ${node.name}${line ? `:${line}` : ''}`);
        }
        return [...groups.entries()].map(([file, members]) =>
          file ? `  ${file}: ${members.join(', ')}` : `  ${members.join(', ')}`);
      })()
    : sorted.map((node) => {
        const line = lineOf(node);
        const loc = node.file_path ? ` @ ${node.file_path}${line ? `:L${line}` : ''}` : '';
        return `  ${node.node_type} ${node.name}${loc}`;
      });

  if (policy.banner === 'full') {
    parts.push(
      'KNOWLEDGE GRAPH — exact-name, full-text and graph-expansion retrieval, most relevant first',
      '══════════════════════════════════════════════════════════════════════════════════════════',
      '',
      'SYMBOLS (most relevant first)',
      '─────────────────────────────',
      indexLines.join('\n'),
    );
  } else if (policy.banner === 'terse') {
    parts.push('SYMBOLS (most relevant first)', indexLines.join('\n'));
  } else {
    parts.push(indexLines.join('\n'));
  }

  const rule = policy.banner === 'full';
  parts.push('');
  if (policy.banner === 'off') {
    parts.push(nodeBlocks.join('\n\n'));
  } else {
    parts.push('DETAIL', ...(rule ? ['──────'] : []), '', nodeBlocks.join('\n\n'));
  }

  if (policy.edgeBlock) {
    parts.push('');
    if (policy.banner === 'off') {
      parts.push(edgesBlock);
    } else {
      parts.push('GRAPH EDGES', ...(rule ? ['───────────'] : []), edgesBlock);
    }
  }

  return parts.join('\n');
}

module.exports = { formatSubgraph, formatProjectContext, EDGE_RENDER_WEIGHT };
