'use strict';

// Language-agnostic outbound-HTTP-call scan, shared by BOTH extraction systems: the tree-sitter
// planes in ast-extractor.js (Java/Python/TS/JS/Go/C#/PHP/C/C++) and the generic-grammar planes in
// extractors/base.js (Ruby/Rust/Swift/Scala/…). Each system builds call sites its own way and only
// some of them ever reached ast-extractor's JS-shaped `_httpCallHint`, so outbound calls in most
// languages never became http_calls and cross-repo resolution produced nothing for them. This one
// scan closes the gap uniformly: it pairs a recognised HTTP-CLIENT library/function marker with a
// URL literal on the same source line and attaches the call to the innermost declaration that
// encloses it. Precision comes from the URL literal, not the marker — a bare `.get(` is never a
// marker, so a server route definition (`app.get('/x')`, gin `r.GET('/x')`) or an ORM call cannot
// be mistaken for a client call. Pure string logic over source already in memory: no grammar
// re-walk, no network, no model — the same determinism guarantee the rest of the extractor holds.

// A quoted URL: an absolute http(s):// URL, or a path beginning `/`, `/api…`, `/v1…`.
const HTTP_URL_LITERAL_RE = /(['"])(\/?(?:api|v\d|\/)[^'"]*|https?:\/\/[^'"]*)\1/;
const HTTP_VERB_HINT_RE = /\bmethod\s*[:=]\s*['"](get|post|put|delete|patch)['"]/i;

const HTTP_CLIENT_MARKER_RE = new RegExp([
  // JS / TS
  'fetch', 'axios', 'superagent', 'node-fetch', 'got\\.', 'ky\\.',
  // Node / Go stdlib http
  'https?\\.(?:get|post|put|delete|patch|request)', 'http\\.newrequest', 'net/http',
  // Python
  'requests\\.', 'httpx', 'aiohttp', 'urllib\\.request', 'http\\.client', 'session\\.request',
  // Java
  'resttemplate', 'webclient', 'httpclient', 'feignclient', 'okhttp', 'retrofit', 'httprequest',
  // Ruby
  'net::http', 'httparty', 'faraday', 'restclient', 'excon', 'typhoeus',
  // PHP
  'guzzle', 'curl_setopt', 'curl_exec', 'curlopt_url',
  'http::(?:get|post|put|delete|patch)', 'wp_remote_',
  // Rust
  'reqwest', 'hyper::', 'ureq', 'isahc', 'surf::',
  // C#
  'getasync', 'postasync', 'putasync', 'deleteasync', 'patchasync', 'getstringasync',
  'restsharp', 'httpwebrequest', 'webrequest', 'flurl',
  // Swift
  'urlsession', 'urlrequest', 'alamofire', 'af\\.request',
  // C / C++
  'curl_easy_setopt', 'curl_easy_perform', 'cpr::', 'httplib',
].join('|'), 'i');

// Functions that read a URL OR a local file (PHP `file_get_contents`, Python `urlopen`, Ruby
// `open-uri`). Only an ABSOLUTE http(s):// URL makes one of these an outbound call — a relative path
// (`file_get_contents('/etc/passwd')`) is a local file read, not a request.
const LOCAL_OR_HTTP_MARKER_RE = /\bfile_get_contents\b|\burlopen\b|\bopen-uri\b/i;

// Best-effort verb, read off the client method itself (`.getForObject(`, `::post(`, `.GetAsync(`),
// an explicit `method: 'POST'`, or a known verb-bearing function. Deliberately conservative: a wrong
// verb would mis-route the edge, so when nothing clear is on the line it returns null and the
// resolver falls back to path-only matching.
function httpVerbFromLine(line) {
  const hint = (HTTP_VERB_HINT_RE.exec(line) || [])[1];
  if (hint) return hint.toLowerCase();
  const m = /(?:\.|::|->)\s*(get|post|put|delete|patch)(?:for[a-z]*|async|string|json|entity|bytes|[a-z]*)?\s*(?:<[^>]*>)?\s*\(/i.exec(line);
  if (m) return m[1].toLowerCase();
  if (/\bfile_get_contents\b|\bwp_remote_get\b|CURLOPT_HTTPGET/i.test(line)) return 'get';
  if (/\bwp_remote_post\b|CURLOPT_POST\b/i.test(line)) return 'post';
  return null;
}

// A bare client-verb method call: `$client->get(`, `client.Get(`, `session.post(`, `api.request(`.
// Too generic to trust on its own (it is also an ORM `repo.get(id)` or a server route `app.get`),
// so it only counts when paired with an ABSOLUTE http(s):// URL, which route definitions and ORM
// calls never carry.
const GENERIC_CLIENT_METHOD_RE = /(?:->|\.|::)\s*(?:get|post|put|delete|patch|request|send|fetch)\s*(?:async)?\s*(?:<[^>]*>)?\s*\(/i;

function httpCallFromLine(rawLine) {
  if (!rawLine) return null;
  const t = rawLine.trimStart();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('#') || t.startsWith('/*') || t.startsWith('--')) return null;
  const urlMatch = HTTP_URL_LITERAL_RE.exec(rawLine);
  if (!urlMatch) return null;
  const target = urlMatch[2];
  const absolute = /^https?:\/\//i.test(target);
  const markerHit = HTTP_CLIENT_MARKER_RE.test(rawLine)
    || (absolute && LOCAL_OR_HTTP_MARKER_RE.test(rawLine));
  const genericHit = absolute && GENERIC_CLIENT_METHOD_RE.test(rawLine);
  if (!markerHit && !genericHit) return null;
  const verb = httpVerbFromLine(rawLine);
  return { httpTarget: target, callee: 'http_call', ...(verb ? { httpVerb: verb } : {}) };
}

// Declaration kinds an outbound call can belong to. A call is attached to the INNERMOST of these
// that spans its line, so a method's call is not also duplicated onto its enclosing class.
const HTTP_ATTACH_TYPES = new Set([
  'FUNCTION', 'METHOD', 'CONSTRUCTOR', 'CLASS', 'INTERFACE', 'STRUCT', 'TRAIT', 'MODULE', 'NAMESPACE', 'ENUM',
]);

// Mutates `nodes` in place: appends an httpTarget-bearing callExpressions entry to the innermost
// enclosing declaration for each HTTP call site found in `content`. Additive and idempotent
// (dedupes on target+line), so it is safe to run even for languages whose own extractor already
// populated some http_calls.
function augmentHttpCallsAcrossLanguages(nodes, content) {
  if (!Array.isArray(nodes) || nodes.length === 0 || !content) return;
  const lines = content.split('\n');
  const sites = [];
  for (let i = 0; i < lines.length; i++) {
    const hit = httpCallFromLine(lines[i]);
    if (hit) sites.push({ ...hit, line: i + 1 });
  }
  if (sites.length === 0) return;
  const decls = nodes.filter((n) => n && HTTP_ATTACH_TYPES.has(n.node_type)
    && Number.isFinite(n.start_line) && Number.isFinite(n.end_line));
  if (decls.length === 0) return;
  for (const site of sites) {
    let best = null;
    for (const d of decls) {
      if (d.start_line <= site.line && site.line <= d.end_line
        && (!best || (d.end_line - d.start_line) < (best.end_line - best.start_line))) best = d;
    }
    if (!best) continue;
    if (!Array.isArray(best.callExpressions)) best.callExpressions = [];
    const dup = best.callExpressions.some((c) => c && c.httpTarget === site.httpTarget && c.line === site.line);
    if (dup) continue;
    best.callExpressions.push({
      callee: site.callee, line: site.line, httpTarget: site.httpTarget,
      ...(site.httpVerb ? { httpVerb: site.httpVerb } : {}),
    });
  }
}

module.exports = {
  augmentHttpCallsAcrossLanguages,
  httpCallFromLine,
  httpVerbFromLine,
  HTTP_CLIENT_MARKER_RE,
  HTTP_ATTACH_TYPES,
};
