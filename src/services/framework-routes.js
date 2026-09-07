'use strict';

// Express / Koa-router / Fastify route extraction for JavaScript and TypeScript — the call-expression
// framework the decorator-based pass in semantic-typing.js (Spring, Flask, FastAPI, Nest, ASP.NET)
// cannot see. A route here is a plain function call, `app.get('/users', getUsers)`, not an annotation
// on a method, so it never reaches deriveSemanticNodes' astNode loop. This is a pure text pass over
// the source: it takes source, returns { verb, route, handler } records, and writes nothing.
//
// PRECISION is the whole problem. `map.get('key')`, `res.get('Content-Type')`, `axios.get('/users')`
// and `cache.delete(id)` all share the `obj.verb(...)` shape with a real route. Two filters keep them
// out: (1) the receiver must be a route object THIS FILE actually creates — `express()`,
// `express.Router()`, `Router()`, `fastify()` — or, when express/koa/fastify is imported, one of the
// conventional names (app / router / api / *Router); and (2) the first argument must be a path,
// i.e. start with `/` (or be the catch-all `*`). `axios.get('/users')` fails filter (1) unless the
// file literally assigns `axios = express()`, which it does not. Measured against real Express repos
// before shipping — a bogus ENDPOINT plane is worse than none.

const HTTP_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'head', 'options'];
const VERB_ALT = HTTP_VERBS.join('|');

// A file creates a route object when it assigns one of the framework constructors to a name. The
// name it binds becomes a receiver we trust for the verb calls below.
const ROUTE_OBJECT_ASSIGN = new RegExp(
  String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*` +
  String.raw`(?:express\s*\(\s*\)|express\s*\.\s*Router\s*\(|Router\s*\(|new\s+(?:express\s*\.\s*)?Router\s*\(|` +
  String.raw`(?:require\(\s*['"]express['"]\s*\))\s*\(\s*\)|fastify\s*\(|Fastify\s*\()`,
  'g');

// The conventional receiver names, trusted only when a router framework is imported in the file —
// this catches the modular-route file `module.exports = (router) => { router.get(...) }`, where the
// router arrives as a parameter and is never assigned a constructor here.
const CONVENTION_NAMES = /^(?:app|router|api|fastify)$|Router$/;

function importsRouterFramework(source) {
  return /require\(\s*['"](?:express|fastify|@?koa(?:\/router)?|koa-router)['"]\s*\)/.test(source)
    || /from\s+['"](?:express|fastify|@?koa(?:\/router)?|koa-router)['"]/.test(source);
}

function routeObjectsIn(source) {
  const names = new Set();
  ROUTE_OBJECT_ASSIGN.lastIndex = 0;
  let m;
  while ((m = ROUTE_OBJECT_ASSIGN.exec(source)) !== null) names.add(m[1]);
  return names;
}

// From the argument text after the path (`, mw1, getUsers)` for `app.get('/x', mw1, getUsers)`), the
// handler is the LAST bare identifier — middleware come first, the handler last. An inline arrow or
// function literal yields no identifier, so the route is recorded with no handler and simply carries
// no HANDLED_BY edge. A dotted reference (`ctrl.getUsers`) resolves on its last segment.
function handlerFromArgs(argsText) {
  if (!argsText) return null;
  const ids = [];
  const re = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;
  let m;
  while ((m = re.exec(argsText)) !== null) {
    const tok = m[1];
    // Skip inline function keywords and obvious non-handlers.
    if (tok === 'function' || tok === 'async' || tok === 'await') continue;
    ids.push(tok);
  }
  if (!ids.length) return null;
  const last = ids[ids.length - 1];
  const seg = last.split('.');
  return seg[seg.length - 1];
}

function normalizeRoute(p) {
  let s = String(p).trim();
  if (s === '*') return '*';
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.replace(/:[A-Za-z_$][\w$]*/g, '{}').replace(/\*/g, '{}').replace(/\/+/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

// The verb-call matcher. Receiver, verb, a quoted path that must start with `/` (or be `*`), then the
// remaining arguments up to the first `)`. The path guard is inside the pattern so `res.get('host')`
// never even matches. The rest-of-args capture stops at the first `)`, which is exact for a
// single-line named handler and simply yields no handler for a multi-line inline one.
const ROUTE_CALL = new RegExp(
  String.raw`\b([A-Za-z_$][\w$]*)\s*\.\s*(` + VERB_ALT + String.raw`)\s*\(\s*` +
  String.raw`(['"` + '`' + String.raw`])(\/[^'"` + '`' + String.raw`]*|\*)\3\s*([^)]*)\)`,
  'g');

// Detect route registrations in one JS/TS source. Returns [{ verb, route, rawPath, handler, index }].
function detectJsRoutes(source) {
  if (typeof source !== 'string' || !source) return [];
  const objects = routeObjectsIn(source);
  const conventionOk = importsRouterFramework(source);
  const trusted = (name) => objects.has(name) || (conventionOk && CONVENTION_NAMES.test(name));

  const routes = [];
  ROUTE_CALL.lastIndex = 0;
  let m;
  while ((m = ROUTE_CALL.exec(source)) !== null) {
    const [, receiver, verb, , rawPath, argsText] = m;
    if (!trusted(receiver)) continue;
    routes.push({
      verb: verb.toUpperCase(),
      route: normalizeRoute(rawPath),
      rawPath,
      handler: handlerFromArgs(argsText),
      index: m.index,
    });
  }
  return routes;
}

// Ruby route registrations — Sinatra's top-level DSL (`get "/orders/:id" do`) and Rails routes.rb
// (`get "/orders/:id", to: "orders#show"`). Both spell a route as a bare verb keyword at statement
// start followed by a quoted path beginning `/`. The statement-start anchor (the verb is NOT
// preceded by a `.`) keeps a receiver call like `params.get("/x")` or `cache.delete(id)` out — the
// same precision principle as the JS matcher, which is why this needs no framework-import gate.
const RUBY_ROUTE_RE = /^[\t ]*(get|post|put|patch|delete)\s+(['"])(\/[^'"]*)\2/gim;

function detectRubyRoutes(source) {
  if (typeof source !== 'string' || !source) return [];
  const routes = [];
  const seen = new Set();
  RUBY_ROUTE_RE.lastIndex = 0;
  let m;
  while ((m = RUBY_ROUTE_RE.exec(source)) !== null) {
    const verb = m[1].toUpperCase();
    const route = normalizeRoute(m[3]);
    const key = `${verb} ${route}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ verb, route, rawPath: m[3], handler: null, index: m.index });
  }
  return routes;
}

module.exports = {
  detectRubyRoutes,
  detectJsRoutes, routeObjectsIn, handlerFromArgs, normalizeRoute, importsRouterFramework,
  HTTP_VERBS,
};
