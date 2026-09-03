'use strict';

// `koragraph serve` — an interactive, local, dependency-free view of the graph. Reads nodes and
// edges from the store, keeps a legible backbone (the most-connected declarations, or a symbol's
// neighbourhood), and serves a single self-contained HTML page over localhost. No CDN, no build
// step, no network: the force-directed renderer is vanilla canvas, and the graph data is embedded
// in the page as JSON — the same "all local" contract the rest of the tool holds.

const http = require('node:http');
const fs = require('node:fs');

const { parseCommandArgs } = require('./args');
const { EXIT, usageError } = require('./errors');

const USES_STORE = true;

const OPTIONS = {
  port: { type: 'string', short: 'p', default: '7100' },
  limit: { type: 'string', short: 'n', default: '250' },
  focus: { type: 'string', short: 'f', default: '' },
  repo: { type: 'string', short: 'r', default: '' },
  help: { type: 'boolean', short: 'h', default: false },
};

const USAGE = `Usage: koragraph serve [--port 7100] [--limit 250] [--focus <symbol>] [--repo <name>]

Open an interactive picture of the graph in your browser. All local — it reads the store, embeds a
legible slice of it in one self-contained page, and serves that page on localhost. No network.

By default it shows the backbone: the most-connected declarations and the edges between them. Pass
--focus to centre on one symbol and its neighbours instead, or --repo to restrict to one repository.

Options:
  -p, --port <n>      Port to serve on (default 7100).
  -n, --limit <n>     How many nodes to show (default 250). Higher is busier.
  -f, --focus <sym>   Centre on a symbol name and show its neighbourhood.
  -r, --repo <name>   Restrict to repositories whose name contains this string.
  -h, --help          Show this help.`;

function parse(argv) {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (values.help) return { help: true };
  if (positionals.length) throw usageError(`serve takes no positional arguments (got "${positionals[0]}").`);
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw usageError(`--port must be 1..65535 (got "${values.port}").`);
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw usageError(`--limit must be 1..2000 (got "${values.limit}").`);
  return { help: false, port, limit, focus: values.focus.trim(), repo: values.repo.trim() };
}

// Node types worth showing by default. DIRECTORY nodes and their CONTAINS fan-out are structural
// noise in a force layout, so the backbone view drops them; a focus view keeps whatever it reaches.
const NOISE_TYPES = new Set(['DIRECTORY']);

async function loadGraph(pool, { limit, focus, repo }) {
  const repoClause = repo ? "AND r.name LIKE '%' || $1 || '%'" : '';
  const { rows: nodeRows } = await pool.query(
    `SELECT n.id, n.name, n.node_type AS type, f.path AS file, r.name AS repo
       FROM nodes n
       LEFT JOIN files f ON f.id = n.file_id
       LEFT JOIN repository_branches rb ON rb.id = n.repository_branch_id
       LEFT JOIN repositories r ON r.id = rb.repository_id
      WHERE n.approval_status != 'ARCHIVED' ${repoClause}`,
    repo ? [repo] : []
  );
  const nodeById = new Map(nodeRows.map((n) => [n.id, n]));
  const { rows: edgeRows } = await pool.query(
    `SELECT from_node_id AS s, to_node_id AS t, edge_type AS type, is_cross_repo AS x FROM edges`
  );
  // Keep only edges whose endpoints both survived the repo filter.
  const edges = edgeRows.filter((e) => nodeById.has(e.s) && nodeById.has(e.t));

  const degree = new Map();
  for (const e of edges) {
    degree.set(e.s, (degree.get(e.s) || 0) + 1);
    degree.set(e.t, (degree.get(e.t) || 0) + 1);
  }

  let keep;
  if (focus) {
    // BFS out from every node whose name matches, up to `limit` nodes / two hops.
    const adj = new Map();
    for (const e of edges) {
      (adj.get(e.s) || adj.set(e.s, []).get(e.s)).push(e.t);
      (adj.get(e.t) || adj.set(e.t, []).get(e.t)).push(e.s);
    }
    const fl = focus.toLowerCase();
    const seeds = nodeRows.filter((n) => n.name && n.name.toLowerCase().includes(fl)).map((n) => n.id);
    keep = new Set(seeds);
    let frontier = [...seeds];
    for (let hop = 0; hop < 2 && keep.size < limit; hop++) {
      const next = [];
      for (const id of frontier) for (const nb of (adj.get(id) || [])) {
        if (!keep.has(nb) && keep.size < limit) { keep.add(nb); next.push(nb); }
      }
      frontier = next;
    }
  } else {
    // Backbone: the most-connected non-noise nodes.
    keep = new Set(nodeRows
      .filter((n) => !NOISE_TYPES.has(n.type))
      .sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0))
      .slice(0, limit)
      .map((n) => n.id));
  }

  // ── the second layer: durable memory, resolved over the WHOLE node set so an anchored
  // declaration is pulled into view even when it is not part of the backbone by degree ──
  const NUL = '|';
  const byFile = new Map(); const bySymFile = new Map(); const bySym = new Map();
  for (const n of nodeById.values()) {
    if (n.file && n.type === 'FILE') byFile.set(n.file, n.id);
    if (n.name && n.file) bySymFile.set(n.name + NUL + n.file, n.id);
    if (n.name && !bySym.has(n.name)) bySym.set(n.name, n.id);
  }
  const resolvedFacts = [];
  for (const r of readPracticeFacts()) {
    let anchor = null;
    if (r.symbol_name) anchor = bySymFile.get(r.symbol_name + NUL + r.file_path) || bySym.get(r.symbol_name) || null;
    else if (r.file_path && r.file_path !== '.') anchor = byFile.get(r.file_path) || null;
    if (anchor == null || !nodeById.has(anchor)) continue;
    // Backbone: pull the anchored declaration into view so the memory always has its code visible.
    // Focus: only annotate nodes already in the neighbourhood — never drag an unrelated fact in.
    if (!focus) keep.add(anchor);
    else if (!keep.has(anchor)) continue;
    resolvedFacts.push({ id: r.id, kind: r.kind, body: r.body, anchor });
  }

  const nodes = [...keep].map((id) => {
    const n = nodeById.get(id);
    return { id, name: n.name || '?', type: n.type || 'NODE', file: n.file || null, repo: n.repo || null, deg: degree.get(id) || 0 };
  });
  const keptEdges = edges
    .filter((e) => keep.has(e.s) && keep.has(e.t) && e.s !== e.t)
    .map((e) => ({ s: e.s, t: e.t, type: e.type, x: e.x ? 1 : 0 }));

  // ── the second layer: durable memory (practice.db), overlaid on the code it is anchored to ──
  // This is what makes koragraph two graphs, not one: facts learned about the code — hazards,
  // rules, corrections, open loops — anchored to a declaration or a file, drawn as a distinct
  // plane linked to the exact node it is about. Best-effort: a missing/empty practice store just
  // means no memory layer, never an error.
  const memNodes = []; const memEdges = []; const seen = new Set();
  for (const f of resolvedFacts) {
    const id = 'mem:' + f.kind + ':' + f.id;
    if (seen.has(id)) continue;
    seen.add(id);
    memNodes.push({ id, name: String(f.body || '').replace(/\s+/g, ' ').slice(0, 90), type: 'MEM', memKind: f.kind, deg: 1, mem: 1 });
    memEdges.push({ s: id, t: f.anchor, type: 'REMEMBERS', x: 0, mem: 1 });
  }

  return { nodes: [...nodes, ...memNodes], edges: [...keptEdges, ...memEdges], memCount: memNodes.length };
}

// Live anchored facts + open loops from practice.db, flattened to {id, kind, body, file_path,
// symbol_name}. Its own read-only connection, closed immediately. Any failure (no store, older
// schema) yields an empty list -- the memory layer is always optional.
function readPracticeFacts() {
  let ppath;
  try { ppath = require("../practice/paths").practiceDbPath(); } catch { return []; }
  if (!ppath || !fs.existsSync(ppath)) return [];
  try {
    const Database = require("better-sqlite3");
    const pdb = new Database(ppath, { readonly: true });
    const facts = pdb.prepare(
      `SELECT f.id AS id, f.kind AS kind, f.body AS body, a.file_path AS file_path, a.symbol_name AS symbol_name
         FROM facts f JOIN anchors a ON a.fact_id = f.id
        WHERE f.expired_at IS NULL`).all();
    let loops = [];
    try {
      loops = pdb.prepare(
        `SELECT l.id AS id, 'open_loop' AS kind, l.body AS body, la.file_path AS file_path, la.symbol_name AS symbol_name
           FROM open_loops l JOIN loop_anchors la ON la.loop_id = l.id
          WHERE l.resolved_at IS NULL`).all();
    } catch { /* older store without loop_anchors */ }
    pdb.close();
    return [...facts, ...loops];
  } catch { return []; }
}

function renderPage(graph, meta) {
  const json = JSON.stringify({ graph, meta }).replace(/</g, '\\u003c');
  return PAGE.replace('/*__DATA__*/null', json);
}

async function run(parsed, { out, err }) {
  const pool = require('../db/pool');
  const graph = await loadGraph(pool, parsed);
  if (graph.nodes.length === 0) {
    err('koragraph: the graph is empty (or the --repo/--focus filter matched nothing). Run `koragraph ingest .` first.\n');
    return EXIT.OK;
  }
  const codeNodes = graph.nodes.length - (graph.memCount || 0);
  const meta = {
    nodes: codeNodes,
    edges: graph.edges.length,
    mem: graph.memCount || 0,
    focus: parsed.focus || null,
    repo: parsed.repo || null,
    generated: new Date().toISOString(),
  };
  const page = renderPage(graph, meta);

  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(page);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });

  return await new Promise((resolve) => {
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') err(`koragraph: port ${parsed.port} is in use — pass a different --port.\n`);
      else err(`koragraph: server error: ${e.message}\n`);
      resolve(EXIT.RUNTIME || 1);
    });
    server.listen(parsed.port, '127.0.0.1', () => {
      const url = `http://localhost:${parsed.port}/`;
      out(`koragraph graph view: ${url}\n`);
      out(`  ${meta.nodes} code nodes, ${meta.edges} edges${meta.mem ? `, ${meta.mem} memory fact(s)` : ''}${meta.focus ? ` focused on "${meta.focus}"` : ' (backbone)'}. Ctrl+C to stop.\n`);
      const stop = () => { server.close(() => resolve(EXIT.OK)); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  });
}

// ─── The page: one self-contained file, vanilla canvas, no external anything ─────────────────────
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>koragraph</title>
<style>
  :root{ --bg:#f4f6f7; --panel:#ffffff; --ink:#111a1f; --soft:#5a6b74; --line:#dde3e6; --accent:#0b8ba3; }
  @media (prefers-color-scheme:dark){ :root{ --bg:#0b1013; --panel:#141c21; --ink:#e8eef1; --soft:#8aa0ab; --line:#243139; --accent:#3bc3da; } }
  *{box-sizing:border-box} html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);
    font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;overflow:hidden}
  #c{display:block;width:100vw;height:100vh;cursor:grab} #c:active{cursor:grabbing}
  .panel{position:fixed;background:var(--panel);border:1px solid var(--line);border-radius:12px;
    box-shadow:0 6px 24px rgba(0,0,0,.12)}
  #hud{top:16px;left:16px;padding:14px 16px;max-width:280px}
  #hud h1{margin:0 0 2px;font-size:16px;letter-spacing:.02em}
  #hud h1 b{color:var(--accent)}
  #hud .m{color:var(--soft);font-size:12px;font-variant-numeric:tabular-nums}
  #hud input{margin-top:10px;width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:8px;
    background:var(--bg);color:var(--ink);font-size:13px;outline:none}
  #hud input:focus{border-color:var(--accent)}
  #legend{bottom:16px;left:16px;padding:11px 14px;font-size:12px;max-width:220px}
  #legend .row{display:flex;align-items:center;gap:8px;margin:3px 0;color:var(--soft);cursor:pointer;user-select:none}
  #legend .row.off{opacity:.35;text-decoration:line-through}
  #legend .dot{width:10px;height:10px;border-radius:50%;flex:none}
  #legend .dia{width:9px;height:9px;border-radius:2px;transform:rotate(45deg);flex:none}
  #legend .h{font-weight:600;color:var(--ink);margin:9px 0 4px;letter-spacing:.05em;font-size:10.5px;text-transform:uppercase}
  #legend .h:first-child{margin-top:0}
  #legend .h.mem{color:#e5b53a;cursor:pointer}
  #tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--bg);padding:6px 9px;
    border-radius:7px;font-size:12px;max-width:340px;opacity:0;transition:opacity .08s;z-index:9;white-space:nowrap}
  #tip .t2{opacity:.7;font-size:11px}
  #hint{bottom:16px;right:16px;padding:9px 13px;color:var(--soft);font-size:11.5px;max-width:230px}
  kbd{font:inherit;background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:0 4px}
</style>
</head>
<body>
<canvas id="c"></canvas>
<div id="hud" class="panel">
  <h1><b>kora</b>graph</h1>
  <div class="m" id="meta"></div>
  <input id="q" placeholder="highlight a symbol…" autocomplete="off" spellcheck="false">
</div>
<div id="legend" class="panel"></div>
<div id="hint" class="panel">drag a node to pin &middot; scroll to zoom &middot; drag to pan &middot; click a node to isolate &middot; double-click to re-frame</div>
<div id="tip"></div>
<script id="graph-data" type="application/json">/*__DATA__*/null</script>
<script>
(function(){
  var DATA = JSON.parse(document.getElementById('graph-data').textContent);
  var G = DATA.graph, META = DATA.meta;
  var cv = document.getElementById('c'), ctx = cv.getContext('2d');
  var DPR = Math.min(window.devicePixelRatio||1, 2);
  function css(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

  // CODE layer — cool palette. MEMORY layer — warm gold/amber, kept deliberately distinct so the
  // two planes never read as one.
  var TYPE_COLOR = {
    FILE:'#8a9aa5', CLASS:'#0b8ba3', METHOD:'#3b82f6', FUNCTION:'#22a06b', INTERFACE:'#8b5cf6',
    ENDPOINT:'#f0883e', ENTITY:'#e0567a', STRUCT:'#e0567a', TRAIT:'#8b5cf6', ENUM:'#0891b2',
    CONSTANT:'#0891b2', MODULE:'#6b7280', NAMESPACE:'#6b7280', DEPENDENCY:'#94a3b8', DOC:'#94a3b8'
  };
  var MEM_COLOR = { hazard:'#e8654a', correction:'#d98324', law:'#e5b53a', ritual:'#c9a227',
    open_loop:'#e0a458', tombstone:'#9a8c7a', revert:'#c96a3a' };
  function colorFor(t){ return TYPE_COLOR[t] || '#7c8b94'; }
  function memColor(k){ return MEM_COLOR[k] || '#e5b53a'; }

  // nodes/edges as physics bodies
  var idx = {}, nodes = G.nodes.map(function(n,i){ idx[n.id]=i; return {
    id:n.id, name:n.name, type:n.type, file:n.file, repo:n.repo, deg:n.deg,
    mem:n.mem?1:0, memKind:n.memKind||null,
    x:(Math.random()-0.5)*600, y:(Math.random()-0.5)*600, vx:0, vy:0, pinned:false
  };});
  var edges = G.edges.map(function(e){ return { s:idx[e.s], t:idx[e.t], type:e.type, x:e.x }; })
                     .filter(function(e){ return e.s!=null && e.t!=null; });
  var maxDeg = 1; nodes.forEach(function(n){ if(!n.mem && n.deg>maxDeg) maxDeg=n.deg; });
  function radius(n){ return n.mem? 6 : (3.5 + 7*Math.sqrt(n.deg/maxDeg)); }

  // view transform
  var view = { x:0, y:0, k:1 };
  var W=0, H=0;
  function resize(){ W=cv.clientWidth; H=cv.clientHeight; cv.width=W*DPR; cv.height=H*DPR;
    ctx.setTransform(DPR,0,0,DPR,0,0); }
  window.addEventListener('resize', resize); resize();
  view.x = W/2; view.y = H/2;

  // hidden types (legend toggles) + a master switch for the whole memory plane
  var hidden = {}, showMem = true;
  function visibleNode(n){ if(n.mem) return showMem && !hidden['mem:'+n.memKind]; return !hidden[n.type]; }

  // ---- force simulation (simple, O(n^2) — fine for a few hundred nodes) ----
  var alpha = 1;
  function step(){
    var i,j,a,b,dx,dy,d2,d,f;
    // repulsion
    for(i=0;i<nodes.length;i++){ a=nodes[i]; if(!visibleNode(a)) continue;
      for(j=i+1;j<nodes.length;j++){ b=nodes[j]; if(!visibleNode(b)) continue;
        dx=a.x-b.x; dy=a.y-b.y; d2=dx*dx+dy*dy+0.01; if(d2>120000) continue;
        f = 780/d2; dx*=f; dy*=f; a.vx+=dx; a.vy+=dy; b.vx-=dx; b.vy-=dy;
      }
    }
    // springs
    for(i=0;i<edges.length;i++){ var e=edges[i]; a=nodes[e.s]; b=nodes[e.t];
      if(!visibleNode(a)||!visibleNode(b)) continue;
      dx=b.x-a.x; dy=b.y-a.y; d=Math.sqrt(dx*dx+dy*dy)+0.01;
      f=(d-(e.mem?26:58))*(e.mem?0.05:0.02)/d;   // facts hug the declaration they annotate
      dx*=f; dy*=f; a.vx+=dx; a.vy+=dy; b.vx-=dx; b.vy-=dy;
    }
    // gravity to centre — strong enough to bound the equilibrium radius + integrate
    for(i=0;i<nodes.length;i++){ a=nodes[i]; if(!visibleNode(a)) continue;
      a.vx += -a.x*0.006; a.vy += -a.y*0.006;
      if(a.pinned){ a.vx=0; a.vy=0; continue; }
      a.vx*=0.86; a.vy*=0.86; a.x+=a.vx*alpha; a.y+=a.vy*alpha;
    }
    if(alpha>0.05) alpha*=0.995;
  }

  // ---- interaction ----
  var hover=null, isolate=null, drag=null, panning=false, last=null;
  function screenToWorld(sx,sy){ return { x:(sx-view.x)/view.k, y:(sy-view.y)/view.k }; }
  function nodeAt(sx,sy){ var w=screenToWorld(sx,sy), best=null, bd=1e9;
    for(var i=0;i<nodes.length;i++){ var n=nodes[i]; if(!visibleNode(n)) continue;
      var dx=n.x-w.x, dy=n.y-w.y, d=dx*dx+dy*dy, r=radius(n)+4;
      if(d<r*r && d<bd){ bd=d; best=n; } } return best; }

  cv.addEventListener('mousemove', function(ev){
    var r=cv.getBoundingClientRect(), sx=ev.clientX-r.left, sy=ev.clientY-r.top;
    if(drag){ var w=screenToWorld(sx,sy); drag.x=w.x; drag.y=w.y; drag.vx=0; drag.vy=0; alpha=Math.max(alpha,0.3); return; }
    if(panning && last){ view.x+=sx-last.x; view.y+=sy-last.y; last={x:sx,y:sy}; return; }
    hover = nodeAt(sx,sy);
    var tip=document.getElementById('tip');
    if(hover){ tip.style.opacity=1; tip.style.left=(ev.clientX+14)+'px'; tip.style.top=(ev.clientY+14)+'px';
      if(hover.mem){
        tip.style.whiteSpace='normal';
        tip.innerHTML = '<div class=t2 style="color:#e5b53a">koramemory &middot; '+esc(hover.memKind)+'</div><div>'+esc(hover.name)+'</div>';
      } else {
        tip.style.whiteSpace='nowrap';
        tip.innerHTML = '<div>'+esc(hover.name)+' <span class=t2>'+esc(hover.type)+'</span></div>'
          + (hover.file?'<div class=t2>'+esc(hover.file)+'</div>':'')
          + (hover.repo?'<div class=t2>'+esc(hover.repo)+' &middot; '+hover.deg+' links</div>':'<div class=t2>'+hover.deg+' links</div>');
      }
      cv.style.cursor='pointer';
    } else { tip.style.opacity=0; cv.style.cursor = panning?'grabbing':'grab'; }
  });
  cv.addEventListener('mousedown', function(ev){
    var r=cv.getBoundingClientRect(), n=nodeAt(ev.clientX-r.left, ev.clientY-r.top);
    if(n){ drag=n; n.pinned=true; } else { panning=true; last={x:ev.clientX-r.left,y:ev.clientY-r.top}; }
  });
  window.addEventListener('mouseup', function(){ drag=null; panning=false; last=null; });
  cv.addEventListener('click', function(ev){
    var r=cv.getBoundingClientRect(), n=nodeAt(ev.clientX-r.left, ev.clientY-r.top);
    if(n){ isolate = (isolate===n)? null : n; } else { isolate=null; }
  });
  cv.addEventListener('wheel', function(ev){ ev.preventDefault();
    var r=cv.getBoundingClientRect(), sx=ev.clientX-r.left, sy=ev.clientY-r.top;
    var before=screenToWorld(sx,sy), f=Math.exp(-ev.deltaY*0.0015);
    view.k=Math.max(0.15,Math.min(5, view.k*f));
    view.x=sx-before.x*view.k; view.y=sy-before.y*view.k;
  }, {passive:false});

  // search highlight
  var query='';
  document.getElementById('q').addEventListener('input', function(e){ query=e.target.value.trim().toLowerCase(); alpha=Math.max(alpha,0.15); });
  function matches(n){ return query && n.name.toLowerCase().indexOf(query)>=0; }

  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // neighbour set for isolate mode
  function neighboursOf(node){ var set={}; set[node.id]=1;
    for(var i=0;i<edges.length;i++){ var e=edges[i];
      if(nodes[e.s]===node) set[nodes[e.t].id]=1; if(nodes[e.t]===node) set[nodes[e.s].id]=1; }
    return set; }

  // ---- render ----
  var autoFit=100;
  function draw(){
    step();
    if(autoFit>0){ fit(); autoFit--; }   // keep the assembling layout framed while it settles
    ctx.setTransform(DPR,0,0,DPR,0,0);
    ctx.clearRect(0,0,W,H);
    ctx.save(); ctx.translate(view.x,view.y); ctx.scale(view.k,view.k);
    var iso = isolate? neighboursOf(isolate): null;
    var accent = css('--accent');

    // edges — code (grey), cross-repo (orange), and memory (dashed gold) drawn distinctly
    for(var i=0;i<edges.length;i++){ var e=edges[i], a=nodes[e.s], b=nodes[e.t];
      if(!visibleNode(a)||!visibleNode(b)) continue;
      var dim = iso && !(iso[a.id] && iso[b.id]);
      if(e.mem){ ctx.setLineDash([4/view.k,3/view.k]); ctx.strokeStyle = dim?'rgba(229,181,58,0.14)':'rgba(229,181,58,0.72)'; ctx.lineWidth=1.4/view.k; }
      else if(e.x){ ctx.setLineDash([]); ctx.strokeStyle = dim? 'rgba(240,136,62,0.08)':'rgba(240,136,62,0.55)'; ctx.lineWidth=2/view.k; }
      else { ctx.setLineDash([]); ctx.strokeStyle = dim? 'rgba(130,150,160,0.05)':'rgba(130,150,160,0.22)'; ctx.lineWidth=1/view.k; }
      ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
    }
    ctx.setLineDash([]);
    // nodes — code as circles (cool), memory as diamonds (warm gold)
    for(var k=0;k<nodes.length;k++){ var n=nodes[k]; if(!visibleNode(n)) continue;
      var dim = iso && !iso[n.id];
      var rad = radius(n);
      ctx.globalAlpha = dim? 0.18: 1;
      ctx.beginPath();
      if(n.mem){ ctx.moveTo(n.x,n.y-rad); ctx.lineTo(n.x+rad,n.y); ctx.lineTo(n.x,n.y+rad); ctx.lineTo(n.x-rad,n.y); ctx.closePath(); ctx.fillStyle=memColor(n.memKind); }
      else { ctx.arc(n.x,n.y,rad,0,6.2832); ctx.fillStyle=colorFor(n.type); }
      ctx.fill();
      if(n.mem && !dim){ ctx.lineWidth=1.5/view.k; ctx.strokeStyle='rgba(255,240,190,0.95)'; ctx.stroke(); }
      if(matches(n) || n===hover || n===isolate){ ctx.lineWidth=2/view.k; ctx.strokeStyle=n.mem?'#fff0be':accent; ctx.stroke(); }
      ctx.globalAlpha=1;
      // labels for the well-connected code nodes, the hovered, and matches (never the long fact bodies)
      if(!n.mem && (n.deg> maxDeg*0.22 || n===hover || matches(n)) && view.k>0.5 && !dim){
        ctx.fillStyle = css('--ink'); ctx.font=(11/view.k)+'px system-ui';
        ctx.fillText(n.name, n.x+rad+2/view.k, n.y+3/view.k);
      }
    }
    ctx.restore();
    requestAnimationFrame(draw);
  }

  // frame the whole (visible) graph in the viewport
  function fit(){
    var minx=1e9,miny=1e9,maxx=-1e9,maxy=-1e9,any=false;
    for(var i=0;i<nodes.length;i++){ var n=nodes[i]; if(!visibleNode(n)) continue; any=true;
      if(n.x<minx)minx=n.x; if(n.y<miny)miny=n.y; if(n.x>maxx)maxx=n.x; if(n.y>maxy)maxy=n.y; }
    if(!any) return;
    var pad=70, gw=Math.max(maxx-minx,1), gh=Math.max(maxy-miny,1);
    view.k=Math.max(0.25,Math.min(1.6, Math.min((W-2*pad)/gw,(H-2*pad)/gh)));
    view.x=W/2-(minx+maxx)/2*view.k; view.y=H/2-(miny+maxy)/2*view.k;
  }
  // settle the layout before the first paint, then frame it — the page opens on a composed graph,
  // not a hairball flying apart. Double-click re-frames after you have moved things.
  for(var _w=0; _w<250; _w++) step();
  alpha=0.5; fit();
  window.addEventListener('dblclick', fit);
  window.addEventListener('keydown', function(e){ if(e.key==='f'||e.key==='F') fit(); });

  // meta + legend — the legend is where the two layers are named apart
  document.getElementById('meta').innerHTML = META.nodes+' code nodes &middot; '+META.edges+' edges'
     + (META.mem? ' &middot; <span style="color:#e5b53a">'+META.mem+' memory facts</span>' : '')
     + '<br>' + (META.focus? 'focus: '+esc(META.focus) : 'backbone') + (META.repo? ' &middot; '+esc(META.repo) : '');
  (function legend(){
    var box=document.getElementById('legend'); box.innerHTML='';
    function header(txt, cls){ var h=document.createElement('div'); h.className='h'+(cls?' '+cls:''); h.textContent=txt; box.appendChild(h); return h; }
    function row(swatchCls, color, label, count, onclick){
      var r=document.createElement('div'); r.className='row';
      r.innerHTML='<span class="'+swatchCls+'" style="background:'+color+'"></span>'+esc(label)+' <span style="margin-left:auto">'+count+'</span>';
      if(onclick) r.onclick=onclick;
      return r;
    }
    // CODE
    header('Code layer');
    var codeCounts={}; nodes.forEach(function(n){ if(!n.mem) codeCounts[n.type]=(codeCounts[n.type]||0)+1; });
    Object.keys(codeCounts).sort(function(a,b){return codeCounts[b]-codeCounts[a];}).forEach(function(t){
      var r=row('dot', colorFor(t), t, codeCounts[t], function(){ hidden[t]=!hidden[t]; r.classList.toggle('off',!!hidden[t]); alpha=Math.max(alpha,0.3); });
      box.appendChild(r);
    });
    var cr = edges.filter(function(e){return e.x;}).length;
    if(cr) box.appendChild(row('dot', '#f0883e', 'cross-repo edge', cr));
    // MEMORY
    var memCounts={}; nodes.forEach(function(n){ if(n.mem) memCounts[n.memKind]=(memCounts[n.memKind]||0)+1; });
    var memKeys=Object.keys(memCounts);
    if(memKeys.length){
      var mh=header('Memory layer', 'mem');
      mh.onclick=function(){ showMem=!showMem; mh.classList.toggle('off', !showMem); alpha=Math.max(alpha,0.3); };
      memKeys.sort(function(a,b){return memCounts[b]-memCounts[a];}).forEach(function(k){
        var r=row('dia', memColor(k), k, memCounts[k], function(){ hidden['mem:'+k]=!hidden['mem:'+k]; r.classList.toggle('off',!!hidden['mem:'+k]); alpha=Math.max(alpha,0.3); });
        box.appendChild(r);
      });
    }
  })();

  draw();
})();
</script>
</body>
</html>`;

module.exports = { USES_STORE, USAGE, parse, run };
