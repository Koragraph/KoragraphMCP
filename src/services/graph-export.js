'use strict';

// Pure renderers: a { nodes, edges } graph (from graph-analytics.exportGraph) → one of the
// interchange formats a human evaluating the tool reaches for. No database, no I/O — the caller
// reads the graph and writes the file, so every format here is unit-testable from a literal graph.
// This is the "show me my codebase" surface the agent-facing tools never needed but a buyer expects.

const FORMATS = Object.freeze(['md', 'mermaid', 'graphml', 'dot', 'json', 'cypher']);

// Mermaid node ids must be bare identifiers; the graph's numeric ids become n<id>. A label carries
// the declaration name and kind, with the characters Mermaid treats as syntax neutralised.
function mermaidLabel(node) {
  const raw = `${node.name} (${node.type})`;
  return raw.replace(/["\\]/g, ' ').replace(/[{}|<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

function toMermaid(graph, { title } = {}) {
  const lines = [];
  if (title) lines.push(`%% ${String(title).replace(/\n/g, ' ')}`);
  lines.push('flowchart LR');
  if (!graph.nodes.length) {
    lines.push('  empty["(no declarations to draw)"]');
    return `${lines.join('\n')}\n`;
  }
  for (const node of graph.nodes) {
    lines.push(`  n${node.id}["${mermaidLabel(node)}"]`);
  }
  for (const e of graph.edges) {
    lines.push(`  n${e.from} -->|${String(e.type).replace(/[|\n]/g, ' ')}| n${e.to}`);
  }
  return `${lines.join('\n')}\n`;
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function toGraphml(graph) {
  const head = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="name" for="node" attr.name="name" attr.type="string"/>',
    '  <key id="type" for="node" attr.name="type" attr.type="string"/>',
    '  <key id="file" for="node" attr.name="file" attr.type="string"/>',
    '  <key id="line" for="node" attr.name="line" attr.type="int"/>',
    '  <key id="score" for="node" attr.name="score" attr.type="double"/>',
    '  <key id="edgetype" for="edge" attr.name="type" attr.type="string"/>',
    '  <graph edgedefault="directed">',
  ];
  const body = [];
  for (const node of graph.nodes) {
    body.push(`    <node id="n${node.id}">`);
    body.push(`      <data key="name">${xmlEscape(node.name)}</data>`);
    body.push(`      <data key="type">${xmlEscape(node.type)}</data>`);
    if (node.file) body.push(`      <data key="file">${xmlEscape(node.file)}</data>`);
    if (node.line) body.push(`      <data key="line">${Number(node.line)}</data>`);
    if (node.score != null) body.push(`      <data key="score">${Number(node.score)}</data>`);
    body.push('    </node>');
  }
  let i = 0;
  for (const e of graph.edges) {
    body.push(`    <edge id="e${i++}" source="n${e.from}" target="n${e.to}">`);
    body.push(`      <data key="edgetype">${xmlEscape(e.type)}</data>`);
    body.push('    </edge>');
  }
  return `${head.join('\n')}\n${body.join('\n')}\n  </graph>\n</graphml>\n`;
}

function dotEscape(value) {
  return String(value ?? '').replace(/["\\]/g, '\\$&').replace(/\n/g, ' ');
}

function toDot(graph, { title } = {}) {
  const lines = [`digraph koragraph {`];
  if (title) lines.push(`  label="${dotEscape(title)}";`);
  lines.push('  node [shape=box];');
  for (const node of graph.nodes) {
    lines.push(`  n${node.id} [label="${dotEscape(`${node.name} (${node.type})`)}"];`);
  }
  for (const e of graph.edges) {
    lines.push(`  n${e.from} -> n${e.to} [label="${dotEscape(e.type)}"];`);
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function toJson(graph, meta = {}) {
  return `${JSON.stringify({ ...meta, ...graph }, null, 2)}\n`;
}

// A Cypher script that recreates the subgraph in Neo4j / FalkorDB. Each node id is bound to a
// variable so the relationship MATCHes are cheap and order-independent.
function cypherString(value) {
  return `'${String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ')}'`;
}

function toCypher(graph) {
  const lines = [];
  for (const node of graph.nodes) {
    const props = [`id: ${node.id}`, `name: ${cypherString(node.name)}`, `type: ${cypherString(node.type)}`];
    if (node.file) props.push(`file: ${cypherString(node.file)}`);
    if (node.line) props.push(`line: ${Number(node.line)}`);
    lines.push(`CREATE (n${node.id}:Declaration {${props.join(', ')}})`);
  }
  for (const e of graph.edges) {
    lines.push(`CREATE (n${e.from})-[:${String(e.type).replace(/[^A-Za-z0-9_]/g, '_')}]->(n${e.to})`);
  }
  return lines.length ? `${lines.join('\n')};\n` : '// (no declarations to export)\n';
}

function render(format, graph, meta = {}) {
  switch (format) {
    case 'mermaid': return toMermaid(graph, meta);
    case 'graphml': return toGraphml(graph);
    case 'dot': return toDot(graph, meta);
    case 'json': return toJson(graph, meta);
    case 'cypher': return toCypher(graph);
    default: throw new Error(`unknown export format "${format}"`);
  }
}

// A sensible default file name per format, so `report --format graphml` lands on graph.graphml.
const DEFAULT_FILENAME = Object.freeze({
  md: 'GRAPH_REPORT.md',
  mermaid: 'graph.mmd',
  graphml: 'graph.graphml',
  dot: 'graph.dot',
  json: 'graph.json',
  cypher: 'graph.cypher',
});

module.exports = { FORMATS, DEFAULT_FILENAME, render, toMermaid, toGraphml, toDot, toJson, toCypher };
