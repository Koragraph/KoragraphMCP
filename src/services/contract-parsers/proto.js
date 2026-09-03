// proto.js — deterministic (zero-token) Protocol Buffers / gRPC service parser.
//
// WHY THIS EXISTS
// ---------------
// `cross-repo-edge-resolver.js` could link two repositories over HTTP (a client's `POST /path`
// matched to another repo's ENDPOINT) and over shared packages. Neither
// covers the way most microservice fleets actually talk: gRPC. For those customers the graph
// asserted the services were unrelated.
//
// A `.proto` file IS the contract, and it carries a globally unique name for every operation.
// The gRPC wire format specifies the path as `/<package>.<Service>/<Method>` (grpc over HTTP/2
// PROTOCOL-HTTP2.md, ":path" pseudo-header), so that string is the join key between the repo
// that serves an RPC and every repo that calls it — the exact analogue of a URL path in the HTTP
// plane, and of a package moniker in the package plane.
//
// WHAT IS PARSED, AND WHY BY HAND
// -------------------------------
// Only what the join needs: `package`, `service`, `rpc` (name, input, output, streaming), and
// `import`. Not messages, not options, not extensions. The proto3 grammar for these five
// productions is small and unambiguous, and a hand-written scanner over it has no dependency,
// cannot fail on a proto2/proto3 dialect difference, and never throws — the same contract the
// OpenAPI and SQL-DDL parsers next door honour (a non-proto file returns an empty result rather
// than an error).
//
// COMMENTS AND STRINGS are stripped first. Without that, `// service Foo {` inside a licence
// header — which is how every file in a Google-authored proto tree begins — registers as a
// service, and `option go_package = "…/service…";` can too.
//
// STREAMING is recorded but does not change the name. `rpc Watch(Req) returns (stream Res)` is
// still `/pkg.Svc/Watch` on the wire; a caller and a server that disagree about streaming are
// still talking about the same operation, and the disagreement is worth being able to see.

'use strict';

// Remove line comments, block comments and string literals, preserving newlines so that any
// line/offset arithmetic a caller does stays truthful.
function stripNoise(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
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
        if (src[i] === '\\') { i++; }
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

const PACKAGE_RE = /(^|\n)\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/;
const IMPORT_RE = /(^|\n)\s*import\s+(?:public\s+|weak\s+)?/g;
const SERVICE_RE = /(^|[\s;}])service\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
// rpc Name ( [stream] Input ) returns ( [stream] Output )
const RPC_RE = /(^|[\s;}])rpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(stream\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*\)\s*returns\s*\(\s*(stream\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*\)/g;

function lineAt(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

// Find the body of a `service X { ... }` by brace matching from its opening brace.
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
 * Parse a .proto source into gRPC service descriptors.
 *
 * Returns [] for anything that is not a proto file with at least one `service` — never throws.
 *
 * @param {string} content raw file text
 * @returns {Array<{package: string, service: string, name: string, methods: Array<{
 *   name: string, canonical: string, inputType: string, outputType: string,
 *   clientStreaming: boolean, serverStreaming: boolean, line: number }>}>}
 */
function parseProto(content) {
  const raw = typeof content === 'string' ? content : '';
  if (!raw.trim()) return [];
  // Cheap rejection before any scanning: a file with no `service` keyword defines messages only
  // and contributes no cross-repo operations.
  if (!/\bservice\s+[A-Za-z_]/.test(raw)) return [];

  const src = stripNoise(raw);
  const pkgMatch = PACKAGE_RE.exec(src);
  const pkg = pkgMatch ? pkgMatch[2] : '';

  const services = [];
  SERVICE_RE.lastIndex = 0;
  let m;
  while ((m = SERVICE_RE.exec(src)) !== null) {
    const serviceName = m[2];
    const braceIndex = src.indexOf('{', m.index + m[0].length - 1);
    if (braceIndex === -1) continue;
    const body = serviceBody(src, braceIndex);
    const methods = [];
    RPC_RE.lastIndex = 0;
    let r;
    while ((r = RPC_RE.exec(body)) !== null) {
      const methodName = r[2];
      methods.push({
        name: methodName,
        // The gRPC wire path. This is the cross-repo join key.
        canonical: `/${pkg ? pkg + '.' : ''}${serviceName}/${methodName}`,
        inputType: r[4],
        outputType: r[6],
        clientStreaming: Boolean(r[3]),
        serverStreaming: Boolean(r[5]),
        line: lineAt(src, braceIndex + 1 + r.index),
      });
    }
    if (!methods.length) continue;
    services.push({
      package: pkg,
      service: serviceName,
      name: `${pkg ? pkg + '.' : ''}${serviceName}`,
      line: lineAt(src, m.index),
      methods,
    });
  }
  return services;
}

/** True when the text looks like a Protocol Buffers definition carrying at least one service. */
function isProtoContract(content) {
  return parseProto(content).length > 0;
}

module.exports = { parseProto, isProtoContract, _stripNoise: stripNoise };
