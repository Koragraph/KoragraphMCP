'use strict';

// Java LSP client for GQ-12.
// Spawns jdt-ls, initialises the workspace, uses callHierarchy/outgoingCalls
// per method to return typed call edges.
//
// Uses callHierarchy/outgoingCalls (not textDocument/references) because Spring
// controller methods are invoked by the framework via HTTP dispatch, not called
// directly from Java source — references returns 0 for them.
//
// Workspace is cached at $TMPDIR/jdtls-ws-<hash> to avoid re-downloading Maven/
// Gradle deps on subsequent runs. Cold workspaces (first ingest) can take 5–15
// minutes to download dependencies — the ingest caller passes timeoutMs: 90_000
// which will degrade gracefully (0 LSP edges) for cold workspaces.
//
// The workspace key MUST be a stable repo identity (opts.cacheKey, e.g. the DB
// repoId), not repoPath: production ingests analyse a fresh tmpdir()/uuid() clone
// (job-queue.js, ingestController.js) that is unique per run, so a path-derived
// key never reuses a workspace and leaks one ~40MB dir per ingest forever
// (GOD_GRAPH_ODYSSEY_II_LEDGER.md M33). reapStaleWorkspaces() bounds total disk
// use regardless of whether the caller supplies a stable key.
//
// Graceful degradation: if jdtls binary is not found or the workspace fails
// to initialise within JDTLS_TIMEOUT_MS, logs a warning and returns [].
// The ingest pipeline never fails due to LSP unavailability.

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const crypto = require('crypto');

const JDTLS_TIMEOUT_MS = 120_000;   // 2 min max for init + analysis
const INDEX_POLL_MS    = 500;
const MAX_REFS_PER_RUN = 200;       // cap per-method reference queries to bound runtime

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const WORKSPACE_MAX_AGE_MS = envInt('JDTLS_WORKSPACE_MAX_AGE_MS', 7 * 24 * 60 * 60 * 1000);
const WORKSPACE_MAX_COUNT  = envInt('JDTLS_WORKSPACE_MAX_COUNT', 20);
// A dir touched this recently may belong to a concurrent in-flight run.
const WORKSPACE_GRACE_MS   = 30 * 60 * 1000;
// Bounds the one-off cost of draining a large backlog — the reap is awaited on
// the ingest's critical path, and the first run after this fix can face hundreds
// of ~40MB dirs left behind by the old path-keyed scheme.
const WORKSPACE_REAP_PER_RUN = 25;

// ─── Binary discovery ────────────────────────────────────────────────────────

function findJdtlsBin() {
  if (process.env.JDTLS_BIN && fs.existsSync(process.env.JDTLS_BIN)) {
    return process.env.JDTLS_BIN;
  }
  const fixed = ['/opt/homebrew/bin/jdtls', '/usr/local/bin/jdtls', '/usr/bin/jdtls'];
  for (const p of fixed) { if (fs.existsSync(p)) return p; }
  try {
    const out = execSync('which jdtls 2>/dev/null', { encoding: 'utf8' }).trim();
    if (out) return out;
  } catch {}
  return null;
}

// ─── LSP message framing ─────────────────────────────────────────────────────

function encodeMessage(obj) {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

// Stateful parser: accumulates bytes and emits complete JSON-RPC messages.
function makeMessageParser(onMessage) {
  let buf = '';
  return function feed(chunk) {
    buf += chunk;
    while (true) {
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header    = buf.slice(0, headerEnd);
      const lenMatch  = header.match(/Content-Length:\s*(\d+)/i);
      if (!lenMatch) { buf = buf.slice(headerEnd + 4); continue; }
      const len = parseInt(lenMatch[1], 10);
      const bodyStart = headerEnd + 4;
      if (buf.length < bodyStart + len) break;
      const body = buf.slice(bodyStart, bodyStart + len);
      buf = buf.slice(bodyStart + len);
      try { onMessage(JSON.parse(body)); } catch {}
    }
  };
}

// ─── Workspace cache key + reaper ─────────────────────────────────────────────

function deriveWorkspaceDir(cacheKey, resolvedRepoPath, tmpBase = os.tmpdir()) {
  const keySource = cacheKey !== undefined && cacheKey !== null
    ? `id:${cacheKey}`
    : `path:${resolvedRepoPath}`;
  const dirHash = crypto.createHash('md5').update(keySource).digest('hex').slice(0, 8);
  return path.join(tmpBase, `jdtls-ws-${dirHash}`);
}

// Deletes jdtls-ws-* dirs that are either older than maxAgeMs or beyond the newest
// maxCount, skipping excludeDir (the workspace this run is about to use) and any
// dir modified within graceMs (could belong to a concurrent in-flight run).
async function reapStaleWorkspaces({
  tmpBase   = os.tmpdir(),
  excludeDir = null,
  maxAgeMs  = WORKSPACE_MAX_AGE_MS,
  maxCount  = WORKSPACE_MAX_COUNT,
  graceMs   = WORKSPACE_GRACE_MS,
  perRun    = WORKSPACE_REAP_PER_RUN,
  now       = Date.now(),
} = {}) {
  let entries;
  try { entries = await fs.promises.readdir(tmpBase, { withFileTypes: true }); } catch { return { removed: [] }; }

  const candidates = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('jdtls-ws-')) continue;
    const full = path.join(tmpBase, e.name);
    if (full === excludeDir) continue;
    let mtimeMs;
    try { mtimeMs = (await fs.promises.stat(full)).mtimeMs; } catch { continue; }
    if (now - mtimeMs < graceMs) continue;
    candidates.push({ full, mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);  // newest first

  const doomed = candidates.filter((c, i) => (now - c.mtimeMs) > maxAgeMs || i >= maxCount);
  const removed = [];
  // Oldest first, so a capped run always drains the least useful dirs.
  for (const c of doomed.reverse().slice(0, perRun)) {
    try { await fs.promises.rm(c.full, { recursive: true, force: true }); removed.push(c.full); } catch {}
  }
  return { removed, deferred: Math.max(0, doomed.length - removed.length) };
}

// Two ingests of one repo derive the SAME workspace dir, and jdt-ls would lose the second to
// its own workspace lock and silently yield 0 edges, so give the loser a private dir instead;
// the reaper collects it later.
//
// The claim token is per-CALL, not per-process. A pid-keyed claim is useless against the
// concurrency that actually happens here: webhooksController fires runIncrementalIngest
// inline, so two overlapping ingests of one repo are usually the SAME OS process, and a
// pid check cannot tell them apart. `wx` makes taking a free dir atomic, so two racing
// callers cannot both win it.
const liveClaims = new Set();

function claimWorkspace(dataDir) {
  const token = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const marker = path.join(dataDir, '.koragraph-inuse');
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}

  if (tryTakeMarker(marker, token)) return { dataDir, marker, token, shared: true };

  // Occupied. A marker left by a process that is gone is stale and may be taken over;
  // one held by a live process — including another in-flight call in THIS process — is not.
  let held = '';
  try { held = fs.readFileSync(marker, 'utf8'); } catch {}
  const heldPid = parseInt(held, 10);
  const heldHere = liveClaims.has(held);
  if (!heldHere && Number.isFinite(heldPid) && !isPidAlive(heldPid)) {
    try { fs.unlinkSync(marker); } catch {}
    if (tryTakeMarker(marker, token)) return { dataDir, marker, token, shared: true };
  }

  const fallback = `${dataDir}-${token}`;
  const fallbackMarker = path.join(fallback, '.koragraph-inuse');
  try { fs.mkdirSync(fallback, { recursive: true }); } catch {}
  tryTakeMarker(fallbackMarker, token);
  return { dataDir: fallback, marker: fallbackMarker, token, shared: false };
}

// 'wx' fails with EEXIST rather than truncating, so the create IS the lock.
function tryTakeMarker(marker, token) {
  try {
    const fd = fs.openSync(marker, 'wx');
    try { fs.writeSync(fd, token); } finally { fs.closeSync(fd); }
    liveClaims.add(token);
    return true;
  } catch {
    return false;
  }
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function releaseWorkspace(claim) {
  if (!claim) return;
  liveClaims.delete(claim.token);
  try {
    // Only drop the marker if it is still ours — never unlink a successor's claim.
    if (fs.readFileSync(claim.marker, 'utf8') === claim.token) fs.unlinkSync(claim.marker);
  } catch {}
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Analyse a Java repository using jdt-ls.
 *
 * @param {string} repoPath  Absolute path to the repository root.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]          Override JDTLS_TIMEOUT_MS.
 * @param {number} [opts.maxRefsPerRun]      Override MAX_REFS_PER_RUN.
 * @param {boolean} [opts.verbose]           Log extra debug info.
 * @param {string|number} [opts.cacheKey]    Stable repo identity (e.g. DB repoId) to key
 *   the jdt-ls workspace cache on, so index reuse actually works across ephemeral clone
 *   paths. Falls back to hashing repoPath when omitted.
 * @returns {Promise<Array<{callerFile:string, callerMethod:string, calleeFile:string, calleeClass:string, calleeMethod:string}>>}
 */
async function analyzeRepo(repoPath, opts = {}) {
  const timeout     = opts.timeoutMs    ?? JDTLS_TIMEOUT_MS;
  const maxRefs     = opts.maxRefsPerRun ?? MAX_REFS_PER_RUN;
  const verbose     = opts.verbose ?? false;
  const log = (...args) => verbose && console.log('[lsp-java]', ...args);

  const bin = findJdtlsBin();
  if (!bin) {
    console.warn('[lsp-java] jdtls binary not found — skipping LSP call-edge extraction');
    return [];
  }

  const resolved = path.resolve(repoPath);
  if (!fs.existsSync(resolved)) {
    console.warn(`[lsp-java] repoPath does not exist: ${resolved}`);
    return [];
  }

  // Discover .java files (limit to 50 files per run to bound time)
  const javaFiles = findJavaFiles(resolved, 50);
  if (!javaFiles.length) {
    log('no .java files found in', resolved);
    return [];
  }

  // Keyed on repo identity, not repoPath, so the index survives the ephemeral
  // clone dir each ingest runs from. See M33 note above.
  const keyedDir = deriveWorkspaceDir(opts.cacheKey, resolved);
  const claim = claimWorkspace(keyedDir);
  const dataDir = claim.dataDir;
  await reapStaleWorkspaces({ excludeDir: dataDir })
    .catch((err) => log('reapStaleWorkspaces failed:', err.message));
  const rootUri = `file://${resolved}`;

  return new Promise((resolve) => {
    let done     = false;
    let msgId    = 1;
    const pending   = new Map();  // id → { resolve, reject }
    const openedUris = new Set(); // track files opened via didOpen to avoid duplicate opens
    const edges  = [];

    const timer = setTimeout(() => {
      console.warn(`[lsp-java] timeout after ${timeout}ms — returning ${edges.length} edges collected so far`);
      finish();
    }, timeout);

    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killServer();
      cleanup();
      resolve(edges);
    }

    // jdtls holds an exclusive lock on `-data <dataDir>`, and dataDir is keyed
    // by repo path so it is reused by every later ingest of the same repo. A
    // jdtls left running therefore does not just leak a JVM: it makes the NEXT
    // ingest of that repo block on the lock until its ceiling and return zero
    // edges. Observed exactly that — an ingest killed mid-run orphaned its
    // jdtls, and the following ingest of the same checkout spent its full
    // ceiling to produce 0 edges while the same call standalone produced 200 in
    // 30s. SIGTERM first, SIGKILL if the JVM ignores it, and the same teardown
    // on process exit so a crashed ingest cannot poison the next one.
    function killServer() {
      process.removeListener('exit', killServer);
      try { proc.kill(); } catch {}
      const hard = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
      if (typeof hard.unref === 'function') hard.unref();
    }

    function cleanup() {
      // dataDir itself is preserved deliberately — it is the index cache. Growth is
      // bounded by reapStaleWorkspaces() on the NEXT run, since reaping while jdt-ls
      // still holds files open here is unsafe. The claim is NOT released here: finish()
      // runs synchronously after proc.kill(), so the JVM is still shutting down and a
      // rival call could take the workspace out from under it. Released on 'exit'.
    }

    const proc = spawn(bin, ['-data', dataDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    process.on('exit', killServer);

    proc.stderr.on('data', (d) => log('jdtls stderr:', d.toString().trim()));
    // A failed spawn emits 'error' with no 'exit', so the claim has to be dropped here too
    // or it would outlive the process and push every later run onto a fallback dir.
    // releaseWorkspace is idempotent — it only unlinks a marker still holding our token.
    proc.on('error', (err) => {
      console.warn(`[lsp-java] failed to spawn jdtls: ${err.message}`);
      releaseWorkspace(claim);
      finish();
    });
    proc.on('exit', () => { releaseWorkspace(claim); finish(); });

    const feedParser = makeMessageParser(onMessage);
    proc.stdout.on('data', (chunk) => feedParser(chunk.toString('utf8')));

    function send(obj) {
      if (done) return;
      proc.stdin.write(encodeMessage(obj));
    }

    function request(method, params, perReqTimeoutMs) {
      return new Promise((res, rej) => {
        const id = msgId++;
        let t;
        if (perReqTimeoutMs) {
          t = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`request timeout: ${method}`));
          }, perReqTimeoutMs);
        }
        pending.set(id, {
          resolve: (v) => { if (t) clearTimeout(t); res(v); },
          reject:  (e) => { if (t) clearTimeout(t); rej(e); },
        });
        send({ jsonrpc: '2.0', id, method, params });
      });
    }

    function notify(method, params) {
      send({ jsonrpc: '2.0', method, params });
    }

    let indexingDone = false;

    function onMessage(msg) {
      // Dispatch JSON-RPC responses
      if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
        return;
      }

      // jdt-ls signals readiness via language/status.
      // Observed type values in jdtls 1.58: Starting, ProjectStatus, Started, ServiceReady
      // NOTE: ServiceReady fires before Maven/Gradle dep download completes — not usable as
      // "index ready" signal. We rely on $/progress end + documentSymbol polling instead.
      if (msg.method === 'language/status') {
        log('language/status:', msg.params?.type);
        return;
      }

      // Also accept $/progress "end" tokens (some versions of jdt-ls use these)
      if (msg.method === '$/progress') {
        const value = msg.params?.value;
        if (value?.kind === 'end') {
          log('workspace progress end:', value.message);
          indexingDone = true;
        }
        return;
      }

      // workspace/semanticTokens/refresh signals the index is usable
      if (msg.method === 'workspace/semanticTokens/refresh') {
        indexingDone = true;
        return;
      }

      // Handle server-initiated requests (e.g., client/registerCapability)
      if (msg.id !== undefined && msg.id !== null && !pending.has(msg.id)) {
        send({ jsonrpc: '2.0', id: msg.id, result: null });
        return;
      }
    }

    async function run() {
      const initStart = Date.now();

      // 1. Initialize
      try {
        await request('initialize', {
          processId: process.pid,
          rootUri,
          capabilities: {
            textDocument: {
              references: { dynamicRegistration: false },
              synchronization: { dynamicRegistration: false },
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              callHierarchy: { dynamicRegistration: false },
            },
            workspace: { workspaceFolders: true },
          },
          workspaceFolders: [{ uri: rootUri, name: path.basename(resolved) }],
          initializationOptions: {
            bundles: [],
            workspaceFolders: [rootUri],
            settings: {
              java: {
                configuration: { updateBuildConfiguration: 'automatic' },
                import: {
                  gradle: { enabled: false },   // Gradle fails without network/binary — prefer Maven
                  maven: { enabled: true },
                },
              },
            },
          },
        });
        notify('initialized', {});
      } catch (err) {
        console.warn(`[lsp-java] initialize failed: ${err.message}`);
        finish();
        return;
      }

      log(`initialized in ${((Date.now() - initStart) / 1000).toFixed(1)}s — waiting for indexing…`);

      // 2. Wait for indexing to complete.
      // Primary signal: language/status Ready. Fallback: poll a documentSymbol request
      // on a known file until it returns non-empty results (proves the index is usable).
      // A cold Maven/Gradle workspace can take 5-10 minutes to download deps and index.
      const pollDeadline = Date.now() + Math.min(timeout * 0.85, 480_000);
      if (!indexingDone && javaFiles.length > 0) {
        // Open the first file to prime the index
        const firstFile = javaFiles[0];
        const firstUri = `file://${firstFile}`;
        const firstSrc = fs.readFileSync(firstFile, 'utf8');
        openedUris.add(firstUri);
        notify('textDocument/didOpen', {
          textDocument: { uri: firstUri, languageId: 'java', version: 1, text: firstSrc },
        });
        // Poll documentSymbol until it returns a non-empty result
        let probeSymbols = null;
        while (!done && Date.now() < pollDeadline) {
          await sleep(2000);
          if (indexingDone) break;
          try {
            probeSymbols = await request('textDocument/documentSymbol', { textDocument: { uri: firstUri } });
            if (Array.isArray(probeSymbols) && probeSymbols.length > 0) {
              indexingDone = true;
              log('index ready (polled documentSymbol)');
              break;
            }
          } catch {}
        }
      }
      // Wait for cross-file reference index to build (runs after compilation).
      // jdt-ls logs "0 problems reported" per file when it's compiled, but the reference
      // index is built asynchronously afterward. Give it 10s to settle.
      if (!done) await sleep(10_000);

      const elapsed = ((Date.now() - initStart) / 1000).toFixed(1);
      log(`workspace ready in ${elapsed}s — analysing ${javaFiles.length} file(s)`);
      console.log(`[lsp-java] Initialised workspace in ${elapsed}s`);

      if (done) return;

      // 3. Open documents and query outgoing call hierarchy per method.
      // callHierarchy/outgoingCalls works for Spring apps where controller methods
      // are never called directly from Java source (they're called via HTTP dispatch),
      // while textDocument/references would return 0 for such methods.
      let refCount = 0;
      const methodsQueried = new Set();

      for (const filePath of javaFiles) {
        if (done) break;
        const uri = `file://${filePath}`;
        const src = fs.readFileSync(filePath, 'utf8');

        if (!openedUris.has(uri)) {
          openedUris.add(uri);
          notify('textDocument/didOpen', {
            textDocument: { uri, languageId: 'java', version: 1, text: src },
          });
          await sleep(200);
        }

        let symbols;
        try {
          symbols = await request('textDocument/documentSymbol', { textDocument: { uri } });
        } catch {
          continue;
        }
        if (!symbols) continue;

        const methods = flattenSymbols(symbols).filter(s => s.kind === 6 /* Method */);
        const callerClass = guessClassName(filePath, src);

        for (const method of methods) {
          if (done || refCount >= maxRefs) break;
          const key = `${filePath}::${method.name}`;
          if (methodsQueried.has(key)) continue;
          methodsQueried.add(key);

          const pos = method.selectionRange?.start ?? method.range?.start;
          if (!pos) continue;

          // Step 1: prepare call hierarchy item for this method
          let items;
          try {
            items = await request('textDocument/prepareCallHierarchy', {
              textDocument: { uri },
              position: pos,
            }, 8_000);
          } catch {
            continue;
          }
          if (!items?.length) continue;

          // Step 2: get outgoing calls from this method
          let outgoing;
          try {
            outgoing = await request('callHierarchy/outgoingCalls', { item: items[0] }, 8_000);
          } catch {
            continue;
          }
          if (!outgoing?.length) continue;

          const callerMethod = stripParens(method.name);

          for (const call of outgoing) {
            if (call.to?.kind !== 6 /* Method */) continue;  // skip constructors, fields
            const calleeFile   = uriToPath(call.to.uri);
            const calleeSrc    = safeReadFile(calleeFile);
            const calleeClass  = calleeSrc ? guessClassName(calleeFile, calleeSrc) : path.basename(calleeFile, '.java');
            const calleeMethod = stripParens(call.to.name);
            edges.push({ callerFile: filePath, callerMethod, calleeFile, calleeClass, calleeMethod });
            refCount++;
            console.log(`[lsp-java] ${callerClass}.${callerMethod}() → ${calleeClass}.${calleeMethod}()`);
          }
        }
      }

      console.log(`[lsp-java] Found ${edges.length} call references in ${javaFiles.length} files`);
      finish();
    }

    run().catch((err) => {
      console.warn(`[lsp-java] analysis error: ${err.message}`);
      finish();
    });
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function findJavaFiles(root, limit) {
  const out = [];
  function walk(dir) {
    if (out.length >= limit) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'target' && e.name !== 'build') {
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.java')) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

// Flatten nested LSP DocumentSymbol tree
function flattenSymbols(symbols) {
  const out = [];
  function walk(arr) {
    if (!Array.isArray(arr)) return;
    for (const s of arr) {
      out.push(s);
      if (s.children) walk(s.children);
    }
  }
  walk(symbols);
  return out;
}

// Guess the primary class name for a .java file (filename without extension)
function guessClassName(filePath, _src) {
  return path.basename(filePath, '.java');
}

// Strip parameter list from method name: "save(Owner)" → "save"
function stripParens(name) {
  const i = name.indexOf('(');
  return i === -1 ? name : name.slice(0, i);
}

function uriToPath(uri) {
  return uri.replace(/^file:\/\//, '');
}

function safeReadFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

// Return the name of the enclosing method for a given 0-based line number.
// Uses a simple regex scan — good enough for Java with one method per block.
function methodAtLine(src, line) {
  const lines = src.split('\n');
  // Walk backwards from line to find the nearest method signature
  const METHOD_RE = /(?:public|private|protected|static|\s)+[\w<>\[\]]+\s+(\w+)\s*\(/;
  for (let i = Math.min(line, lines.length - 1); i >= 0; i--) {
    const m = lines[i].match(METHOD_RE);
    if (m) return m[1];
  }
  return 'unknown';
}

module.exports = { analyzeRepo, findJdtlsBin, deriveWorkspaceDir, reapStaleWorkspaces, claimWorkspace, releaseWorkspace };
