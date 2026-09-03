// thrift.js — deterministic (zero-token) Apache Thrift IDL service parser.
//
// The fourth contract kind, alongside `.proto` (gRPC), OpenAPI (HTTP) and package manifests. It
// exists for the same reason: a `.thrift` file IS the contract between repositories, and it names
// every operation unambiguously.
//
// THE JOIN KEY, AND WHY IT IS NOT THE NAMESPACE
// --------------------------------------------
// A Thrift file declares one namespace PER TARGET LANGUAGE (`namespace java tutorial`,
// `namespace cpp tutorial`, `namespace d share`) and they routinely disagree — `shared.thrift` in
// Apache's own tutorial uses `share` for D and `shared` for everything else, because `shared` is a
// D keyword. So a namespace-qualified name is not a single global identity the way a proto package
// is.
//
// Thrift's wire protocol settles it: the method name is sent bare, and the multiplexed protocol
// (TMultiplexedProtocol) prefixes it with the SERVICE name as `Service:method`. So the identity
// that both ends genuinely agree on is `<Service>.<method>`, and that is the key used here.
// Namespaces are still parsed and carried as metadata, because they are what a language-specific
// consumer imports.
//
// INHERITANCE IS PART OF THE CONTRACT
// -----------------------------------
// `service Calculator extends shared.SharedService` means a Calculator client can call
// `getStruct`. A consumer that calls it is depending on SharedService through Calculator, and a
// resolver that ignored `extends` would miss that edge entirely. Inherited methods are therefore
// resolved and returned on the child, flagged `inherited: true` with `inheritedFrom` recorded, so
// a caller can choose to treat them differently without having to re-derive the hierarchy.
//
// Comments and strings are stripped first, for the same reason as the proto parser: every Apache
// file opens with a licence header, and `// service Foo {` inside one would otherwise register.

'use strict';

function stripNoise(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if ((c === '/' && c2 === '/') || c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      out += ' ';
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') i++;
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const NAMESPACE_RE = /(^|\n)\s*namespace\s+([A-Za-z_][A-Za-z0-9_.]*)\s+([A-Za-z_][A-Za-z0-9_.]*)/g;
const SERVICE_RE = /(^|[\s;}])service\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:extends\s+([A-Za-z_][A-Za-z0-9_.]*)\s*)?\{/g;
// `[oneway] <ReturnType> name(...)` — the return type may itself be generic (`map<string,i32>`).
const METHOD_RE = /(?:^|[\s;,{])(oneway\s+)?((?:void|[A-Za-z_][A-Za-z0-9_.]*(?:\s*<[^>()]*>)?))\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

function lineAt(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

function serviceBody(src, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(openBraceIndex + 1, i);
    }
  }
  return src.slice(openBraceIndex + 1);
}

/**
 * Parse a .thrift source into service descriptors.
 *
 * Returns [] for anything without a `service` — never throws.
 *
 * @returns {Array<{service, name, extends, namespaces, methods:Array<{
 *   name, canonical, returnType, oneway, inherited, inheritedFrom, line}>}>}
 */
function parseThrift(content) {
  const raw = typeof content === 'string' ? content : '';
  if (!raw.trim()) return [];
  if (!/\bservice\s+[A-Za-z_]/.test(raw)) return [];

  const src = stripNoise(raw);

  const namespaces = {};
  NAMESPACE_RE.lastIndex = 0;
  let nm;
  while ((nm = NAMESPACE_RE.exec(src)) !== null) namespaces[nm[2]] = nm[3];

  const services = [];
  SERVICE_RE.lastIndex = 0;
  let m;
  while ((m = SERVICE_RE.exec(src)) !== null) {
    const serviceName = m[2];
    const parent = m[3] || null;
    const braceIndex = src.indexOf('{', m.index + m[0].length - 1);
    if (braceIndex === -1) continue;
    const body = serviceBody(src, braceIndex);
    const methods = [];
    const seen = new Set();
    METHOD_RE.lastIndex = 0;
    let r;
    while ((r = METHOD_RE.exec(body)) !== null) {
      const methodName = r[3];
      if (seen.has(methodName)) continue;
      seen.add(methodName);
      methods.push({
        name: methodName,
        // Thrift sends the method name bare; TMultiplexedProtocol prefixes `Service:`. This is the
        // identity both ends agree on regardless of target language.
        canonical: `${serviceName}.${methodName}`,
        returnType: r[2],
        oneway: Boolean(r[1]),
        inherited: false,
        inheritedFrom: null,
        line: lineAt(src, braceIndex + 1 + r.index),
      });
    }
    services.push({
      service: serviceName,
      name: serviceName,
      extends: parent,
      namespaces,
      line: lineAt(src, m.index),
      methods,
    });
  }

  // Resolve `extends` within this file. A parent in another file (`extends shared.SharedService`)
  // cannot be resolved here and is left recorded on `extends` for a project-scoped pass to join.
  const byName = new Map(services.map(s => [s.service, s]));
  for (const svc of services) {
    if (!svc.extends) continue;
    const parentName = svc.extends.includes('.')
      ? svc.extends.slice(svc.extends.lastIndexOf('.') + 1)
      : svc.extends;
    const parent = byName.get(parentName);
    if (!parent || parent === svc) continue;
    const own = new Set(svc.methods.map(x => x.name));
    for (const pm of parent.methods) {
      if (own.has(pm.name)) continue;
      svc.methods.push({
        ...pm,
        canonical: `${svc.service}.${pm.name}`,
        inherited: true,
        inheritedFrom: parent.service,
      });
    }
  }

  return services.filter(s => s.methods.length > 0);
}

function isThriftContract(content) {
  return parseThrift(content).length > 0;
}

module.exports = { parseThrift, isThriftContract };
