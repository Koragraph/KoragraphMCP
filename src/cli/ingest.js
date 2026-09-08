'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseCommandArgs, positiveInt } = require('./args');
const { EXIT, cliError, usageError } = require('./errors');

const USES_STORE = true;

const OPTIONS = {
  project: { type: 'string' },
  branch: { type: 'string' },
  stack: { type: 'string' },
  full: { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false },
  watch: { type: 'boolean', default: false },
  interval: { type: 'string' },
  'no-hooks': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

// classify() falls back to BACKEND_RULES for any stack it does not know, so an unknown --stack
// would otherwise be accepted and quietly change the answer — this list rejects it. Listed here rather than imported because
// parse() must not load the extraction engine — see the loader note in main.js. This list is
// pinned against the engine's own two tables so it cannot drift.
const STACKS = Object.freeze([
  'BACKEND', 'JAVA_SPRING', 'KOTLIN', 'ANDROID', 'PYTHON', 'GO', 'RUST', 'RUBY', 'PHP', 'DOTNET',
  'NODE', 'REACT', 'ANGULAR', 'VUE', 'CPP', 'SWIFT', 'IOS', 'SCALA', 'FLUTTER',
]);

const USAGE = `Usage: koragraph ingest <path> [<path>...] [options]

Index one or more local git checkouts into the graph. A repository already in the graph is
re-indexed INCREMENTALLY — only the files that changed since the recorded commit are
re-extracted — and the command says which path it took.

Options:
  --project <name>  Group these repositories under one project (default: "default").
                    Repositories in the same project get cross-repo edges between them, so
                    put the two or three services you work on together under one name.
  --branch <name>   Branch label to record (default: the checked-out branch).
  --stack <STACK>   Force the stack instead of detecting it from the build markers. One of:
                    ${STACKS.join(' ')}
  --full            Re-extract every file even if the repository is already indexed.
  --verbose         Print every per-file and per-pass line instead of a summary.
  --watch           Keep running and re-index automatically as files change (save, commit,
                    checkout, rebase). Foreground; Ctrl-C to stop. Indexes once first if needed.
  --interval <ms>   Poll interval for --watch (default 800). Higher is cheaper, lower is snappier.
  --no-hooks        Skip wiring this repo's git re-index and Claude Code memory hooks. By default an
                    ingest installs them (idempotently) so the graph stays fresh and the memory layer
                    is live without a second command. Set KORAGRAPH_INGEST_NO_HOOKS=1 for the same.
  -h, --help        Show this help.

A directory with no build marker (no package.json, pom.xml, pyproject.toml, go.mod, ...) is
still indexed: the stack is inferred from the file extensions and named in the output. Pass
--stack to decide it yourself.

Extraction is tree-sitter, git and SQLite. No network calls, no API keys, no token spend.
Progress goes to stderr; the summary goes to stdout. Expect minutes on a large repository.`;

function parse(argv) {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (values.help) return { help: true };
  if (positionals.length === 0) {
    throw usageError(`ingest needs at least one repository path.\n\n${USAGE}`);
  }
  const stack = values.stack ? String(values.stack).toUpperCase() : null;
  if (stack && !STACKS.includes(stack)) {
    throw usageError(`--stack "${values.stack}" is not a stack this build knows.\n`
      + `Valid values: ${STACKS.join(' ')}\n`
      + 'Or omit --stack: the stack is detected from the build markers, and inferred from the '
      + 'file extensions when there are none.');
  }
  const interval = positiveInt(values.interval, '--interval', 0);
  return {
    help: false,
    paths: positionals,
    project: values.project || 'default',
    branch: values.branch || null,
    stack,
    full: values.full === true,
    verbose: values.verbose === true,
    watch: values.watch === true,
    interval,
    noHooks: values['no-hooks'] === true,
  };
}

function resolveRepoPath(input) {
  const resolved = path.resolve(input);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw cliError(`No such path: ${resolved}`, EXIT.NOT_FOUND);
  }
  if (!stat.isDirectory()) throw cliError(`Not a directory: ${resolved}`, EXIT.USAGE);
  try {
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw cliError(`Cannot read ${resolved} — check its permissions.`, EXIT.FAILURE);
  }
  return resolved;
}

// Read-then-insert rather than an upsert: `ON CONFLICT (name)` would be valid SQL against
// projects_name_key, but it is a conflict target nothing else in the tree uses, and one writer at
// a time is the whole shape of this product — there is no race to win.
async function ensureProject(pool, name) {
  const existing = await pool.query('SELECT id FROM projects WHERE name = $1', [name]);
  if (existing.rows.length) return existing.rows[0].id;
  const { rows } = await pool.query(
    'INSERT INTO projects (name, description, org_id) VALUES ($1, $2, 1) RETURNING id',
    [name, 'Created by the koragraph CLI'],
  );
  return rows[0].id;
}

async function findIndexedBranch(pool, projectId, repoName, branchName) {
  const { rows } = await pool.query(
    `SELECT rb.id AS branch_id, rb.branch_name, rb.last_commit_sha, r.id AS repo_id
       FROM repository_branches rb
       JOIN repositories r ON r.id = rb.repository_id
      WHERE r.project_id = $1 AND r.name = $2 AND ($3 IS NULL OR rb.branch_name = $3)
      ORDER BY rb.id LIMIT 1`,
    [projectId, repoName, branchName],
  );
  return rows[0] || null;
}

// upsertBranch (services/ingest.js) writes repository_branches.last_commit_sha as soon as the
// branch row exists — before a single node is extracted — so a process killed mid-run (SIGINT,
// OOM, a crash) leaves the branch recorded "at" the target commit with none of the work actually
// done. Without this check, the next plain `ingest` sees last_commit_sha === head and reports
// "already indexed — nothing changed", permanently hiding an empty/partial graph behind a
// confident-looking skip (only `--full` would ever recover it). Cross-checking the most recent
// ingest_jobs row for this exact (project, path, branch) catches an interruption anywhere in the
// run — RUNNING/PENDING means it never finished, FAILED means it finished badly — independent of
// how many nodes happened to land before the process died.
async function lastJobStatus(pool, projectId, repoPath, branchName) {
  const { rows } = await pool.query(
    `SELECT status FROM ingest_jobs
      WHERE project_id = $1 AND local_path = $2 AND branch = $3
      ORDER BY id DESC LIMIT 1`,
    [projectId, repoPath, branchName],
  );
  return rows[0] ? rows[0].status : null;
}

async function openJob(pool, { projectId, repoPath, branchName, stack, jobType }) {
  const { rows } = await pool.query(
    `INSERT INTO ingest_jobs (project_id, github_url, branch, stack, status, job_type, source_type, local_path, started_at)
     VALUES ($1, $2, $3, $4, 'RUNNING', $5, 'LOCAL', $6, strftime('%Y-%m-%dT%H:%M:%fZ','now')) RETURNING id`,
    [projectId, `file://${repoPath}`, branchName, stack, jobType, repoPath],
  );
  return rows[0].id;
}

async function closeJob(pool, jobId, fields) {
  const keys = Object.keys(fields);
  await pool.query(
    `UPDATE ingest_jobs SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')},
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1`,
    [jobId, ...keys.map((k) => fields[k])],
  );
}


// A rename is BOTH a removal of the old path and a change at the new one: without the removal the
// old declarations stay live in the graph forever with nothing pointing at them.
function splitDiff(diff) {
  const changed = [];
  const removed = [];
  for (const d of diff) {
    if (d.deleted_file) { removed.push(d.old_path); continue; }
    changed.push(d.new_path);
    if (d.renamed_file && d.old_path && d.old_path !== d.new_path) removed.push(d.old_path);
  }
  return { changed, removed };
}

// `git diff --name-status` reports paths relative to the git WORKING TREE ROOT, always — but the
// rest of the incremental pipeline (filterIncrementalPaths, the extraction loop) treats every path
// as relative to `repoPath`, the INGEST root. Those two roots are the same for a plain checkout,
// but not when `repoPath` is a subdirectory of a larger repo (a monorepo workspace) — the common,
// realistic case a real multi-package project hits on every ingest, not an edge case.
//
// Left unadjusted, a path like `sub/bar.js` (git-root-relative) gets treated as ingest-root-relative
// and resolved to `<ingestRoot>/sub/bar.js` — a path that does not exist, since the real file is at
// `<ingestRoot>/bar.js`. That file then silently fails to read and is skipped: an incremental
// re-ingest after any rename or add inside the workspace does nothing, with no error anywhere.
// Rebase each path onto the ingest root here, and drop (with a count, not silently) anything that
// falls outside it — a change elsewhere in the monorepo is real, but not this ingest's problem.
// `path.resolve` does not follow SYMLINKS and `git rev-parse --show-toplevel` always returns a
// fully resolved path. On macOS `/tmp` is a symlink to `/private/tmp`, and any checkout reached
// through a symlinked parent has the same shape. The two roots then compare UNEQUAL for what is
// really a plain checkout, every changed path rebases to a `../..` escape, and the entire diff is
// dropped as out-of-scope — while the commit sha still advances at the end of the pass. The index
// is left silently stale and claiming to be current, which is worse than either being stale or
// being current: every anchor over it reads `unknown` and no re-ingest ever repairs it short of
// --full. Canonicalise both sides before they are compared.
function canonicalRoot(p) {
  try { return fs.realpathSync(path.resolve(p)); } catch (_) { return path.resolve(p); }
}

function rebaseDiffToIngestRoot(diffPaths, gitRoot, ingestRoot) {
  const canonGitRoot = gitRoot ? canonicalRoot(gitRoot) : null;
  const canonIngestRoot = canonicalRoot(ingestRoot);
  if (!canonGitRoot || canonGitRoot === canonIngestRoot) return { ...diffPaths, outOfScope: 0 };
  let outOfScope = 0;
  const rebase = (relPaths) => relPaths.map((p) => {
    const abs = path.resolve(canonGitRoot, p);
    const rel = path.relative(canonIngestRoot, abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) { outOfScope++; return null; }
    return rel.split(path.sep).join('/');
  }).filter(Boolean);
  const changed = rebase(diffPaths.changed);
  const removed = rebase(diffPaths.removed);
  return { changed, removed, outOfScope };
}

// The outcome buckets, and only the ones that happened. Every non-zero bucket is reported
// (including `unconfirmed`, a fact whose code changed underneath it and now needs a look);
// zero buckets are dropped so the line does not spend three quarters of itself saying nothing
// happened.
function revalidationTally(r) {
  const parts = [`${r.ok} ok`];
  // `expired` is the one FACT-grained bucket in here; everything else counts anchors. It is
  // labelled as such below rather than silently added to an anchor total.
  const add = (n, label) => { if (n) parts.push(`${n} ${label}`); };
  add(r.renamed, 're-resolved after a rename');
  add(r.moved, 'followed to a moved file');
  add(r.unconfirmed, 'whose code changed underneath — needs a look');
  add(r.orphaned, 'orphaned');
  add(r.unknown, 'unknown');
  add(r.expired.length, 'fact(s) expired');
  return parts.join(', ');
}

async function branchTotals(pool, branchId) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*) FROM nodes n WHERE n.repository_branch_id = $1 AND n.approval_status != 'ARCHIVED') AS nodes,
       (SELECT count(*) FROM nodes nd WHERE nd.repository_branch_id = $1 AND nd.approval_status != 'ARCHIVED'
          AND nd.node_type NOT IN ('FILE', 'DIRECTORY')) AS decls,
       (SELECT count(*) FROM edges e
          JOIN nodes n2 ON n2.id = e.from_node_id
          JOIN nodes t2 ON t2.id = e.to_node_id
         WHERE n2.repository_branch_id = $1
           AND n2.approval_status != 'ARCHIVED' AND t2.approval_status != 'ARCHIVED') AS edges,
       (SELECT count(*) FROM edges e
          JOIN nodes n3 ON n3.id = e.from_node_id
          JOIN nodes t3 ON t3.id = e.to_node_id
         WHERE n3.repository_branch_id = $1 AND e.edge_type = 'CO_CHANGES'
           AND n3.approval_status != 'ARCHIVED' AND t3.approval_status != 'ARCHIVED') AS cochange`,
    [branchId],
  );
  return rows[0] || { nodes: 0, edges: 0, cochange: 0 };
}

// detectRepoType() returns null on purpose and its comment says the CALLER decides how to fail.
// Aborting was the wrong decision for this product: a developer pointing the tool at a plain
// source directory is the first thing that happens on install, and "no pom.xml" is not a reason to
// refuse to read Python. Matched on the message because that is the only handle the engine offers;
// it is kept in step with the message the engine produces.
const STACK_UNDETECTED = /Could not auto-detect a supported stack/;

// Ambiguous extensions (.ts, .js) belong to four stacks; first match in this order wins so the
// answer is the same on every run. BACKEND is the floor because classify() already falls back to
// BACKEND_RULES for any stack it does not recognise — picking it introduces no new behaviour, and
// role assignment for every content-classifiable extension is driven by the file, not the stack.
const INFERENCE_ORDER = Object.freeze([
  'PYTHON', 'GO', 'RUST', 'DOTNET', 'RUBY', 'PHP', 'KOTLIN', 'BACKEND', 'IOS', 'FLUTTER',
  'NODE', 'REACT', 'ANGULAR', 'VUE', 'CPP',
]);
const FALLBACK_STACK = 'BACKEND';

function inferStack(repoPath) {
  const { walkRepo, CODE_EXTS_BY_STACK } = require('../services/ingest');
  const counts = new Map();
  for (const f of walkRepo(repoPath)) {
    const ext = path.extname(f.rel).toLowerCase();
    if (ext) counts.set(ext, (counts.get(ext) || 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [ext, files] of ranked) {
    for (const stack of INFERENCE_ORDER) {
      if ((CODE_EXTS_BY_STACK[stack] || []).includes(ext)) return { stack, ext, files };
    }
  }
  return { stack: FALLBACK_STACK, ext: null, files: 0 };
}

async function fullIngest(runIngest, args, { label, err }) {
  try {
    return { result: await runIngest(args), stack: args.stack || null };
  } catch (e) {
    if (args.stack || !STACK_UNDETECTED.test(String(e.message))) throw e;
    const guess = inferStack(args.repoPath);
    err(`${label}: no build marker found — indexing as ${guess.stack}`
      + `${guess.ext ? ` (inferred from ${guess.files} ${guess.ext} file(s))` : ''}`
      + '. Pass --stack to decide it yourself.\n');
    return { result: await runIngest({ ...args, stack: guess.stack }), stack: guess.stack };
  }
}

async function run(parsed, io) {
  const { err } = io;
  // Watch mode is a long-running foreground loop, not a one-shot index — it owns its own output
  // and lifetime and never falls through to the batch summary/practice tail below.
  if (parsed.watch) {
    const { runWatch } = require('./watch');
    return runWatch(parsed, io);
  }
  const log = require('./stderr-filter').install({ verbose: parsed.verbose });
  let failed;
  try {
    failed = await ingestAll(parsed, io);
  } finally {
    log.restore();
  }

  const hidden = log.summary();
  if (hidden.length) {
    err('Quiet by default — re-run with --verbose to see these in full:\n');
    for (const line of hidden) err(`  ${line}\n`);
  }

  const repoPaths = parsed.paths.map(resolveRepoPath);
  revalidatePractice(err, repoPaths);
  wireHooks(err, repoPaths, parsed);

  if (failed) return EXIT.FAILURE;
  err('Done. Run `koragraph status` to see the graph, or `koragraph mcp` to serve it.\n');
  return EXIT.OK;
}

// Wire each ingested repo's hooks as part of the index, so the retrieval and memory layers are live
// without a second command: git hooks that re-index when HEAD moves, and the Claude Code hooks that
// deliver/capture memory and redirect a cold grep to the graph. Both installers are idempotent —
// they refresh koragraph's own entries in place and never touch a hook the developer wrote — so
// running this on every ingest also self-heals a settings.json that drifted, and stays quiet unless
// something was newly installed. Best-effort throughout: a hook that cannot be written (not a git
// checkout, an unwritable .claude) is skipped, never a reason to fail an index. Opt out per-run with
// --no-hooks, or globally with KORAGRAPH_INGEST_NO_HOOKS.
function wireHooks(err, repoPaths, parsed) {
  if (parsed.noHooks || process.env.KORAGRAPH_INGEST_NO_HOOKS) return;
  let gitHooks;
  let claudeHooks;
  try {
    gitHooks = require('../services/git-hooks');
    claudeHooks = require('../services/practice-hooks');
  } catch (e) {
    if (process.env.KORAGRAPH_CLI_TRACE) err(`Hook wiring skipped: ${e.message}\n`);
    return;
  }
  const invocation = { nodeBin: process.execPath, cliEntry: path.resolve(__dirname, '../../bin/koragraph.js') };
  const storeOpts = {
    graphDb: process.env.KORAGRAPH_DB || null,
    practiceDb: process.env.KORAGRAPH_PRACTICE_DB || null,
  };
  let installedGit = false;
  let installedClaude = false;
  for (const repoPath of repoPaths || []) {
    try {
      const r = gitHooks.installHooks(repoPath, { ...invocation, repoPath, project: parsed.project });
      // git-hooks reports created/appended for a fresh write and unchanged for a refresh — announce
      // only when something was actually newly written.
      if ((r.results || []).some((h) => h.action !== 'unchanged')) installedGit = true;
    } catch (e) {
      if (process.env.KORAGRAPH_CLI_TRACE) err(`${repoPath}: git hooks skipped (${e.message.split('\n')[0]}).\n`);
    }
    try {
      const c = claudeHooks.installClaudeHooks(repoPath, storeOpts);
      if ((c.results || []).some((h) => h.action === 'installed')) installedClaude = true;
    } catch (e) {
      if (process.env.KORAGRAPH_CLI_TRACE) err(`${repoPath}: .claude/settings.json not written (${e.message.split('\n')[0]}).\n`);
    }
  }
  // Announce only a first-time install; a refresh on an already-wired repo is silent so a routine
  // re-ingest stays quiet. The one line names both what turned on and how to opt out next time.
  if (installedGit || installedClaude) {
    const parts = [];
    if (installedGit) parts.push('auto-reindex on HEAD move');
    if (installedClaude) parts.push('memory + graph-first search in Claude Code');
    err(`Hooks wired: ${parts.join(', ')}. \`koragraph hooks status\` to inspect; re-ingest with --no-hooks to skip.\n`);
  }
}

async function ingestAll(parsed, io) {
  const { out, err } = io;
  const repoPaths = parsed.paths.map(resolveRepoPath);

  const pool = require('../db/pool');
  const { runIngest, runIncrementalIngest, gitSha, gitBranch, gitTopLevel } = require('../services/ingest');
  const { LocalProvider } = require('../services/vcs/local-provider');

  const projectId = await ensureProject(pool, parsed.project);
  let failed = 0;

  for (const [i, repoPath] of repoPaths.entries()) {
    const repoName = path.basename(repoPath);
    const branchName = parsed.branch || gitBranch(repoPath) || 'main';
    const head = gitSha(repoPath);
    const label = `[${i + 1}/${repoPaths.length}] ${repoName}`;

    const indexed = parsed.full ? null : await findIndexedBranch(pool, projectId, repoName, parsed.branch);
    let forceFull = false;
    if (indexed && head && indexed.last_commit_sha === head) {
      const totals = await branchTotals(pool, indexed.branch_id);
      const lastStatus = await lastJobStatus(pool, projectId, repoPath, branchName);
      const incomplete = totals.nodes === 0
        || lastStatus === 'RUNNING' || lastStatus === 'PENDING' || lastStatus === 'FAILED';
      if (!incomplete) {
        err(`${label}: already indexed at ${head.slice(0, 8)} — nothing changed. Use --full to re-extract.\n`);
        out(`${parsed.project}/${repoName} ${indexed.branch_name}  unchanged  ${totals.nodes} nodes  ${totals.edges} edges\n`);
        continue;
      }
      err(`${label}: recorded as indexed at ${head.slice(0, 8)} but the previous run never finished `
        + `(${totals.nodes} node(s) written, last job ${lastStatus || 'unknown'}) — re-indexing in full.\n`);
      forceFull = true;
    }

    let mode = !forceFull && indexed && indexed.last_commit_sha && head ? 'incremental' : 'full';
    let diffPaths = null;
    if (mode === 'incremental') {
      try {
        diffPaths = splitDiff(await new LocalProvider().getDiff(repoPath, indexed.last_commit_sha, head));
        const gitRoot = gitTopLevel(repoPath);
        const rebased = rebaseDiffToIngestRoot(diffPaths, gitRoot, path.resolve(repoPath));
        if (rebased.outOfScope) {
          err(`${label}: ${rebased.outOfScope} changed path(s) outside this ingest's subdirectory ignored\n`);
        }
        diffPaths = rebased;
      } catch (e) {
        // A rebase, a force-push or a shallow clone can leave the recorded commit unreachable.
        // Re-indexing everything is correct then; silently indexing nothing would not be.
        err(`${label}: cannot diff ${indexed.last_commit_sha.slice(0, 8)}..${head.slice(0, 8)} (${e.message}) — falling back to a full index.\n`);
        mode = 'full';
      }
    }

    const started = Date.now();
    err(`${label}: ${mode} index of ${repoPath} (branch ${branchName})\n`);

    // The graceful wall: a full index reads the whole tree, so an enterprise-scale repo is where a
    // local process risks running out of memory. Measure the file count first (cheap — one git call)
    // and, if it is large, say so plainly before the heavy work rather than after an OOM. Never a
    // block: indexing proceeds. Incremental runs touch only changed files, so they skip this.
    if (mode === 'full') {
      const { classifyScale, countIngestFiles } = require('../services/scale-guard');
      const fileCount = countIngestFiles(repoPath);
      if (fileCount !== null) {
        const scale = classifyScale({ files: fileCount });
        if (scale.message) err(`${label}: ${scale.message}\n`);
      }
    }

    const jobId = await openJob(pool, {
      projectId, repoPath, branchName, stack: parsed.stack,
      jobType: mode === 'incremental' ? 'INCREMENTAL' : 'FULL',
    });

    try {
      let result;
      let usedStack = parsed.stack;
      if (mode === 'incremental') {
        err(`${label}: ${diffPaths.changed.length} changed, ${diffPaths.removed.length} removed\n`);
        result = await runIncrementalIngest({
          repoPath,
          projectId,
          repoId: indexed.repo_id,
          branchId: indexed.branch_id,
          branchName: indexed.branch_name,
          changedPaths: diffPaths.changed,
          removedPaths: diffPaths.removed,
          newCommitSha: head,
          jobId,
        });
      } else {
        const done = await fullIngest(runIngest, {
          repoPath,
          projectId,
          repoName,
          stack: parsed.stack || undefined,
          branch: parsed.branch || undefined,
          sourceUrl: `file://${repoPath}`,
          jobId,
          // The structural graph is committed and reported below before co-change is mined; the
          // mine (50-84% of wall time) runs detached instead — spawned once the branch id is known.
          deferCoChange: true,
        }, { label, err });
        result = done.result;
        usedStack = done.stack;
      }
      err(`${label}: ${result.done || 0} file(s) indexed, ${result.skipped || 0} skipped, `
        + `${result.errors || 0} error(s)\n`);
      await closeJob(pool, jobId, {
        status: result.errors > 0 ? 'DEGRADED' : 'COMPLETE',
        files_done: result.done || 0,
        files_total: (result.done || 0) + (result.skipped || 0),
        nodes_written: result.nodes || 0,
        detected_stack: usedStack || null,
      });
    } catch (e) {
      failed += 1;
      await closeJob(pool, jobId, { status: 'FAILED', error_msg: e.message.slice(0, 2000) }).catch(() => {});
      err(`${label}: FAILED — ${e.message}\n`);
      if (process.env.KORAGRAPH_CLI_TRACE) err(`${e.stack}\n`);
      continue;
    }

    const branch = await findIndexedBranch(pool, projectId, repoName, branchName);
    const totals = branch ? await branchTotals(pool, branch.branch_id) : { nodes: 0, edges: 0, cochange: 0, decls: 0 };
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    out(`${parsed.project}/${repoName} ${branchName}  ${mode}  ${totals.nodes} nodes  ${totals.edges} edges  graph ready  ${secs}s\n`);
    // An empty declaration graph exits 0 today, so a repo whose language is unsupported (or whose
    // stack was misdetected) looks like success. Say it plainly rather than let a silent 0 read as OK.
    if (branch && Number(totals.decls) === 0) {
      err(`${label}: WARNING — 0 declarations were extracted. The graph holds only file entries, so `
        + `search/blast_radius will find nothing. Likely an unsupported language or a misdetected `
        + `stack — try --stack, or check the file types.\n`);
    }

    // The structural graph is now committed and queryable. Co-change mining is the slow part
    // (50-84% of wall time), so it runs in a DETACHED process that merges CO_CHANGES into this
    // same WAL store while the graph already serves reads. Spawned on BOTH modes so subsequent
    // (incremental) ingests keep the plane fresh, and skipped entirely under COCHANGE_EDGES=off.
    if (branch) {
      const { spawnDetachedCoChange } = require('../services/cochange-defer');
      const spawned = spawnDetachedCoChange({ branchId: branch.branch_id, repoPath });
      if (spawned.spawned) {
        err(`${label}: co-change mining in the background (pid ${spawned.pid}); `
          + `${totals.cochange} edge(s) so far, more appear as it finishes. `
          + '`koragraph status` shows the count.\n');
      }
    }
  }

  return failed;
}

// The pass that expires a fact when the code it describes changes. An ingest is the only moment the
// graph moves, so it is the only moment an anchor's verdict can change; running it anywhere else is
// either too early or wasted. Wrapped because a fault in the second layer must never fail an ingest
// of the first: the graph is the product, the practice store is the bonus.
function revalidatePractice(err, repoPaths = []) {
  const fsp = require('node:fs');
  try {
    const { practiceDbPath } = require('../practice/paths');
    if (!fsp.existsSync(practiceDbPath())) return;
    const { openPracticeDb } = require('../practice/db');
    const { revalidate } = require('../practice/revalidate');
    const { openGraphDb } = require('../practice/resolve');

    const practice = openPracticeDb();
    // A stated_rules row is an audit trail only, never auto-promoted (see author.js's own note on
    // why). Nothing wakes this tail besides live facts.
    // Counted before the guard because the guard now consults it. A store with no facts but with
    // captured events is the BOOTSTRAP case, not an idle one: refusing to do any work there is
    // self-fulfilling, because harvesting is the only thing that would have produced the first fact.
    const liveFacts = practice.prepare('SELECT count(*) c FROM facts WHERE expired_at IS NULL').get().c;
    const unharvested = practice.prepare('SELECT count(*) c FROM events WHERE harvested_at IS NULL').get().c;
    if (!liveFacts && !unharvested) {
      practice.close();
      return;
    }
    const graph = openGraphDb();
    try {
      // Harvest with the graph IN HAND. The SessionEnd hook cannot open graph.db (its 5 s budget
      // forbids a synchronous busy wait against an ingest), so it calls harvestSession(db, null, …)
      // and every lesson it promotes lands at file grain, unable to ever bind to the declaration it
      // is about. Its own comment points at `practice harvest` to re-resolve them offline — but
      // that verb selects `harvested_at IS NULL` and the hook has already stamped every row it saw,
      // so the re-resolve could never see them and in 14 days of real use it never once ran.
      // An ingest is the one moment the graph is already open, which makes it the right place.
      if (unharvested) {
        try {
          const { harvestSession, lessonKey } = require('../practice/harvest');
          // UNHARVESTED rows only, and harvestSession's own replay default rather than a wide
          // window. Re-reading rows the hook already stamped cannot produce anything: those
          // lessons are in harvested_lessons and dedup by identity, so a wider window is pure
          // cost — measured at +3.4s per ingest against a 17k-event store, on a pass that runs
          // every time a watcher fires. What this pass is FOR is the rows the hook has not
          // reached (a session still open, a hook that never fired) and, unlike the hook, it
          // holds the graph, so those lessons anchor to a declaration instead of to a file.
          const rows = practice.prepare(
            'SELECT * FROM events WHERE harvested_at IS NULL ORDER BY ts, id',
          ).all();
          // Per SCOPE, never one pass over every session at once: runFailFix pairs a failure with
          // a later pass, and a mixed-session stream pairs them across sessions that never met.
          // A NULL agent_id is the main loop and is a scope of its own, so it is carried through
          // as null rather than collapsed with the subagents that ran beside it.
          const scopes = new Map();
          for (const e of rows) {
            const key = `${e.session_id}\x00${e.agent_id || ''}`;
            if (!scopes.has(key)) scopes.set(key, { session_id: e.session_id, agent_id: e.agent_id });
          }
          for (const sc of scopes.values()) {
            harvestSession(practice, graph, { sessionId: sc.session_id, agentId: sc.agent_id });
          }
          // The other half of a long debug: what was tried and BACKED OUT. Uses the rows read
          // above, because harvestSession stamps `harvested_at` as it goes and a second query
          // here would come back empty.
          const { harvestTombstones } = require('../practice/tombstones');
          harvestTombstones(practice, graph, rows, lessonKey);
        } catch (_) { /* harvesting is best-effort; never fail an ingest over it */ }
      }

      // Recounted AFTER harvesting: the pass above may have produced the store's first fact, and
      // revalidating nothing prints a line about nothing on every ingest.
      const factsToCheck = practice.prepare('SELECT count(*) c FROM facts WHERE expired_at IS NULL').get().c;
      if (!factsToCheck) return;

      const r = revalidate(practice, graph);
      // Open-loop anchors ride the same cadence as fact anchors — an ingest is the only moment the
      // graph moves, so it is the only moment a loop's rename/move can be followed. Best-effort and
      // reported only when something happened: this is a much smaller, quieter pass than fact
      // revalidation and must not turn a routine ingest noisy.
      try {
        const { revalidateLoopAnchors } = require('../practice/loop-anchors');
        const lr = revalidateLoopAnchors(practice, graph);
        if (lr.renamed || lr.moved || lr.dropped) {
          err(`Practice: ${lr.renamed + lr.moved} open-loop anchor(s) followed, `
            + `${lr.dropped} fell back to repo-wide (the code they named is gone).\n`);
        }
      } catch { /* loop-anchor revalidation is best-effort; never fail an ingest over it */ }
      practice.prepare('INSERT INTO ops_runs (kind, ran_at, event_watermark, summary) VALUES (?,?,?,?)')
        .run('revalidate', new Date().toISOString(),
          practice.prepare('SELECT max(id) m FROM events').get().m || null, JSON.stringify(r));
      // ANCHORS, not facts. `ok`/`orphaned`/`drifted` are per-anchor and one fact can carry
      // several, so heading the line with facts_checked produced arithmetic that cannot be read:
      // a replication on psf/requests printed "90 fact(s) re-checked — 97 orphaned", because 100
      // facts carried 175 anchors. The buckets sum over anchors; the headline must too, and the
      // fact count is reported separately because it is what a developer actually has.
      err(`Practice: ${r.facts_checked} fact(s) over ${r.anchors_checked} anchor(s) `
        + `— ${revalidationTally(r)}.\n`);
      if (r.expired.length) {
        err(`  expired: ${r.expired.map((e) => `p#${e.fact_id} (${e.reason})`).join(', ')}\n`);
      }
      // A contradiction is the one revalidation outcome the developer has to SETTLE rather than
      // just be told about: the repository now says something different from what they did, and
      // this layer deliberately refuses to decide which is right. Printed with the reason, because
      // "p#3 contradicted" is not actionable and the reason is.
      for (const c of r.contradicted || []) {
        err(`  contradicted: p#${c.fact_id} — ${c.reason}\n`
          + '    it is no longer being delivered; `koragraph practice forget ' + `${c.fact_id}\` if it is wrong.\n`);
      }
      if (r.uncontradicted) {
        err(`  ${r.uncontradicted} previously-contradicted rule(s) agree with the repository again.\n`);
      }
      // Refresh the agent rule files this repo ALREADY uses so the rulebook a Cursor/Cline/Codex
      // session reads stays current with what revalidation just expired — the whole point of the
      // layer, delivered where the agent actually looks. maintainOnly: never CREATE a file on
      // ingest (a surprise), only update ones koragraph already manages. Best-effort.
      try {
        const { syncRepo } = require('../practice/sync');
        for (const rp of repoPaths || []) {
          const s = syncRepo(practice, { cwd: rp, maintainOnly: true });
          const touched = (s.written || []).filter((w) => w.status !== 'unchanged').map((w) => w.file);
          if (touched.length) err(`Practice: refreshed ${touched.join(', ')}.\n`);
        }
      } catch (e) {
        if (process.env.KORAGRAPH_CLI_TRACE) err(`Practice sync skipped: ${e.message}\n`);
      }
    } finally {
      graph.close();
      practice.close();
    }
  } catch (e) {
    if (process.env.KORAGRAPH_CLI_TRACE) err(`Practice revalidation skipped: ${e.message}\n`);
  }
}

module.exports = { parse, run, revalidationTally, resolveRepoPath, splitDiff, rebaseDiffToIngestRoot, inferStack, USAGE, USES_STORE, OPTIONS, STACKS, INFERENCE_ORDER, STACK_UNDETECTED, ensureProject, findIndexedBranch, lastJobStatus, openJob, closeJob, branchTotals };
