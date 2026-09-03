'use strict';

const path = require('node:path');
const { parseCommandArgs } = require('./args');
const { EXIT, cliError, usageError } = require('./errors');
const { resolveRepoPath } = require('./ingest');

const USES_STORE = true;

const OPTIONS = {
  project: { type: 'string' },
  git: { type: 'boolean', default: false },
  claude: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const VERBS = new Set(['install', 'uninstall', 'status']);

const USAGE = `Usage: koragraph hooks <install|uninstall|status> [<path>...] [--git] [--claude] [options]

Make a repository use koragraph automatically. Two kinds of hook, and by default install writes BOTH:

  git hooks     re-index the repo whenever HEAD moves (commit / checkout / merge / rebase). The
                re-index is incremental and runs detached, so it never blocks the git command.
  claude hooks  wire the practice (memory) layer into your Claude Code sessions in this repo — the
                correction channel, per-edit pre-flight, recall delivery and end-of-session harvest.
                Written to .claude/settings.json, merged with anything already there.

  install     Write the hooks (both kinds unless you pass --git or --claude to scope it).
  uninstall   Remove only the blocks koragraph added; anything else you have is left alone.
  status      Report, per hook, whether koragraph manages it.

With no path, every repository already in the graph is targeted.

Options:
  --git             Only the git re-index hooks.
  --claude          Only the Claude Code practice (memory) hooks.
  --project <name>  Project to re-index the repo under (default: the one it is already indexed as,
                    or "default"). The git hook bakes this in.
  -h, --help        Show this help.

Hooks call this exact node binary and CLI entry by absolute path, because a hook does not inherit
your shell's PATH. Uninstall or re-run install if you move your node install or checkout.`;

function parse(argv) {
  const { values, positionals } = parseCommandArgs(argv, OPTIONS);
  if (values.help) return { help: true };
  const [verb, ...paths] = positionals;
  if (!verb) throw usageError(`hooks needs a verb.\n\n${USAGE}`);
  if (!VERBS.has(verb)) {
    throw usageError(`hooks: unknown verb "${verb}" (expected install, uninstall or status).\n\n${USAGE}`);
  }
  // Neither flag means both kinds; either flag scopes to just that kind.
  const both = !values.git && !values.claude;
  return {
    help: false, verb, paths, project: values.project || null,
    doGit: both || values.git, doClaude: both || values.claude,
  };
}

// Every repo in the graph, with its project and the absolute checkout path recorded at ingest. A
// full_path that carries no path separator is a bare repo NAME from before that column held a path
// (see upsertRepo's note) — it cannot be located, so it is dropped here rather than guessed at.
async function indexedRepos(pool) {
  const { rows } = await pool.query(
    `SELECT DISTINCT p.name AS project, r.name AS repo, r.full_path
       FROM repositories r JOIN projects p ON p.id = r.project_id
      WHERE r.full_path IS NOT NULL
      ORDER BY p.name, r.name`,
  );
  return rows.filter((r) => String(r.full_path).includes(path.sep));
}

async function projectForPath(pool, absPath) {
  const { rows } = await pool.query(
    `SELECT p.name AS project FROM repositories r JOIN projects p ON p.id = r.project_id
      WHERE r.full_path = $1 ORDER BY r.id LIMIT 1`,
    [absPath],
  );
  return rows[0]?.project || null;
}

// The two absolute paths the hook script needs. cliEntry is this package's bin entry, resolved from
// here rather than from PATH so a checkout install works.
function cliInvocation() {
  return { nodeBin: process.execPath, cliEntry: path.resolve(__dirname, '../../bin/koragraph.js') };
}

async function resolveTargets(parsed, pool) {
  if (parsed.paths.length) {
    const targets = [];
    for (const input of parsed.paths) {
      const abs = resolveRepoPath(input);
      const project = parsed.project || await projectForPath(pool, abs);
      if (!project) {
        throw cliError(
          `${abs} is not in the graph yet, so I don't know which project to re-index it under.\n`
          + `Ingest it first (\`koragraph ingest ${abs}\`), or pass --project.`,
          EXIT.NOT_FOUND);
      }
      targets.push({ repoPath: abs, project });
    }
    return targets;
  }
  const rows = await indexedRepos(pool);
  if (!rows.length) {
    throw cliError('No repositories are in the graph yet — ingest one first, then install its hooks.', EXIT.NOT_FOUND);
  }
  return rows.map((r) => ({ repoPath: r.full_path, project: parsed.project || r.project }));
}

async function run(parsed, io) {
  const { out, err } = io;
  const pool = require('../db/pool');
  const hooks = require('../services/git-hooks');
  const claude = require('../services/practice-hooks');
  // A programmatic caller (or a test) that sets neither flag means both — the same default parse() gives.
  const doGit = parsed.doGit === undefined && parsed.doClaude === undefined ? true : Boolean(parsed.doGit);
  const doClaude = parsed.doGit === undefined && parsed.doClaude === undefined ? true : Boolean(parsed.doClaude);
  parsed = { ...parsed, doGit, doClaude };
  // A non-default store is baked into the claude hook commands so a per-repo graph still anchors and
  // delivers against the right graph; unset means the hooks use koragraph's own default paths.
  const storeOpts = {
    graphDb: process.env.KORAGRAPH_DB || null,
    practiceDb: process.env.KORAGRAPH_PRACTICE_DB || null,
  };

  const targets = await resolveTargets(parsed, pool);
  const invocation = cliInvocation();
  let hadForeign = false;

  for (const { repoPath, project } of targets) {
    // ── git re-index hooks ──
    if (parsed.doGit) {
      let result;
      try {
        if (parsed.verb === 'install') result = hooks.installHooks(repoPath, { ...invocation, repoPath, project });
        else if (parsed.verb === 'uninstall') result = hooks.uninstallHooks(repoPath);
        else result = hooks.statusHooks(repoPath);
      } catch (e) {
        err(`${repoPath}: not a git checkout (${e.message.split('\n')[0]}) — skipped git hooks.\n`);
        result = null;
      }
      if (result) {
        if (parsed.verb === 'status') {
          out(`${project}  ${repoPath}  git: ${result.results.map((r) => `${r.hook}:${r.state}`).join('  ')}\n`);
        } else {
          const verbed = parsed.verb === 'install' ? 'installed' : 'removed';
          const counts = result.results.reduce((m, r) => { m[r.action] = (m[r.action] || 0) + 1; return m; }, {});
          out(`${project}  ${repoPath}  git ${verbed}: ${Object.entries(counts).map(([a, n]) => `${n} ${a}`).join(', ')}\n`);
          if (result.results.some((r) => r.action === 'appended')) {
            hadForeign = true;
            const appended = result.results.filter((r) => r.action === 'appended').map((r) => r.hook).join(', ');
            err(`  ${appended}: you already had a hook here — koragraph's block was appended after it. `
              + 'If that hook exits early, the auto-reindex will not run; move koragraph\'s block up to fix it.\n');
          }
        }
      }
    }

    // ── claude practice (memory) hooks ──
    if (parsed.doClaude) {
      try {
        let cres;
        if (parsed.verb === 'install') cres = claude.installClaudeHooks(repoPath, storeOpts);
        else if (parsed.verb === 'uninstall') cres = claude.uninstallClaudeHooks(repoPath);
        else cres = claude.claudeHookStatus(repoPath);
        if (parsed.verb === 'status') {
          out(`${project}  ${repoPath}  claude: ${cres.results.map((r) => `${r.event}:${r.state}`).join('  ')}\n`);
        } else if (cres.results.length) {
          const counts = cres.results.reduce((m, r) => { m[r.action] = (m[r.action] || 0) + 1; return m; }, {});
          out(`${project}  ${repoPath}  claude ${Object.entries(counts).map(([a, n]) => `${n} ${a}`).join(', ')} → ${cres.settingsFile}\n`);
        } else if (parsed.verb === 'uninstall') {
          out(`${project}  ${repoPath}  claude: nothing to remove\n`);
        }
      } catch (e) {
        err(`${repoPath}: could not write .claude/settings.json (${e.message.split('\n')[0]}).\n`);
      }
    }
  }

  if (parsed.verb === 'install') {
    if (parsed.doGit) err('Auto-reindex is on: commit, checkout, merge or rebase and the graph follows on its own.\n');
    if (parsed.doClaude) err('Memory is on: corrections you state and lessons you hit are captured and recalled in your Claude Code sessions here.\n');
    err('`koragraph hooks status` shows which hooks are managed.\n');
    if (hadForeign) err('Re-run with a clean hook, or edit the hook, if the note above applies to you.\n');
  }
  return EXIT.OK;
}

module.exports = { parse, run, USAGE, USES_STORE, OPTIONS, VERBS, resolveTargets };
