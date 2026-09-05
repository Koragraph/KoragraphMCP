'use strict';

// Regression coverage for the five findings from the 2026-09-03 hands-on eval of koragraph MCP
// against a real multi-repo store (agentservice/subscriptionservice/chatservice sharing one base
// package). Each block below maps to one finding from that report.
//
// Two small Java fixture repos, sharing a base package and a class name (`Subscription`), ingested
// under the SAME project — the actual shape that produced the eval's misattribution and the
// project_id no-op.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'koragraph.js');

const AGENT_FIXTURE = {
  'src/main/java/com/example/app/model/Subscription.java':
    'package com.example.app.model;\n\npublic class Subscription {\n  private String id;\n}\n',
  'src/main/java/com/example/app/model/ProfileData.java':
    'package com.example.app.model;\n\nimport java.util.List;\n\npublic class ProfileData {\n'
    + '  private List<Subscription> subscriptions;\n}\n',
};

// A second repository with a class of the SAME name at the SAME relative path — the exact
// collision shape a shared base package produces across sibling services.
const OTHER_FIXTURE = {
  'src/main/java/com/example/app/model/Subscription.java':
    'package com.other.app.model;\n\npublic class Subscription {\n  private String otherField;\n}\n',
};

let home;
let agentRoot;
let otherRoot;
let th; // tool-handlers, required only after KORAGRAPH_HOME is set for this process

function writeFixture(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'initial');
}

test.before(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koragraph-eval-'));
  home = path.join(tmp, 'home');
  agentRoot = path.join(tmp, 'agentservice');
  otherRoot = path.join(tmp, 'otherservice');
  fs.mkdirSync(home, { recursive: true });
  writeFixture(agentRoot, AGENT_FIXTURE);
  writeFixture(otherRoot, OTHER_FIXTURE);

  // One `ingest` call, two repos, no --project: both land in the default project — the shape
  // the eval's 9-repo store had, and the shape that made a repo-name `project_id` a no-op.
  execFileSync('node', [CLI, 'ingest', agentRoot, otherRoot, '--stack', 'JAVA_SPRING'], {
    env: { ...process.env, KORAGRAPH_HOME: home },
    stdio: 'pipe',
  });

  // The pool singleton in THIS process resolves KORAGRAPH_HOME at require time, so it must be set
  // before the first require of anything that touches it.
  process.env.KORAGRAPH_HOME = home;
  th = require('../src/mcp/tool-handlers');
});

// ---------------------------------------------------------------------------
// Finding 1 — blast_radius must see a field/generic-type reference, not only CALLS.
// ---------------------------------------------------------------------------

test('finding 1: blast_radius surfaces a field-type (REFERENCES) caller, not only CALLS callers', async () => {
  const result = await th.blastRadius({
    files_changed: ['src/main/java/com/example/app/model/Subscription.java'],
    project_id: 'agentservice',
    detail: 'full',
  }, {});
  const callers = result.data.callers || [];
  const profileData = callers.find((c) => c.name === 'ProfileData');
  assert.ok(profileData, `expected ProfileData among callers, got: ${JSON.stringify(callers.map((c) => c.name))}`);
  assert.strictEqual(profileData.edge_type, 'REFERENCES');
});

// ---------------------------------------------------------------------------
// Finding 2 — project_id/repo scoping must actually narrow the walk to one repository.
// ---------------------------------------------------------------------------

test('finding 2: repo-scoped project_id actually narrows the walk (unscoped conflates both repos’ same-path file)', async () => {
  const unscoped = await th.blastRadius({
    files_changed: ['src/main/java/com/example/app/model/Subscription.java'],
    detail: 'full',
    // No project_id: this store holds exactly one (default) project holding both repos, so
    // resolveBlastRadiusScope's env/sole-project fallback picks it — the unscoped case.
  }, {});
  const scoped = await th.blastRadius({
    files_changed: ['src/main/java/com/example/app/model/Subscription.java'],
    project_id: 'agentservice',
    detail: 'full',
  }, {});

  assert.strictEqual(scoped.data.meta.repo_scoped, 'agentservice');
  // Exactly two repos share this path and each contributes the same node shape for
  // Subscription.java, so an unscoped walk should count exactly double what a walk scoped to one
  // of them counts — the precise signature of the two repos' files being conflated as one.
  assert.strictEqual(unscoped.data.changed_node_count, scoped.data.changed_node_count * 2,
    `expected unscoped to double-count both repos' Subscription.java (unscoped=${unscoped.data.changed_node_count}, scoped=${scoped.data.changed_node_count})`);

  const callers = scoped.data.callers || [];
  assert.ok(callers.some((c) => c.name === 'ProfileData'), 'expected ProfileData among the scoped callers');
  for (const c of callers) {
    assert.strictEqual(c.repo, 'agentservice', `caller ${c.name} leaked in from the wrong repo: ${JSON.stringify(c)}`);
  }
});

test('finding 2: an unknown project_id/repo name still errors loudly (no silent no-op)', async () => {
  await assert.rejects(
    th.blastRadius({
      files_changed: ['src/main/java/com/example/app/model/Subscription.java'],
      project_id: 'does-not-exist',
    }, {}),
    (err) => /No project or repository named/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Finding 3 — coverage self-report: which edge types were walked, and a standing structural
// blind-spot note, always present.
// ---------------------------------------------------------------------------

test('finding 3: blast_radius reports which edge types it walked and its structural blind spots', async () => {
  const result = await th.blastRadius({
    files_changed: ['src/main/java/com/example/app/model/Subscription.java'],
    project_id: 'agentservice',
    detail: 'full',
  }, {});
  assert.ok(Array.isArray(result.data.edge_types_included) && result.data.edge_types_included.includes('REFERENCES'));
  assert.ok(Array.isArray(result.data.edge_types_excluded));
  assert.ok(typeof result.data.coverage_note === 'string' && result.data.coverage_note.length > 0);
});

// ---------------------------------------------------------------------------
// Finding 4 — every result row carries which repository it came from.
// ---------------------------------------------------------------------------

test('finding 4: search_code results carry a per-row repo field that tells the two Subscriptions apart', async () => {
  const result = await th.searchCode({ query: 'Subscription', detail: 'full' }, {});
  const results = result.data.results || [];
  const repos = new Set(results.map((r) => r.repo));
  assert.ok(results.length >= 2, `expected matches from both repos, got ${JSON.stringify(results)}`);
  assert.ok(repos.has('agentservice') && repos.has('otherservice'),
    `expected rows attributed to both repos, got repos: ${JSON.stringify([...repos])}`);
});

// ---------------------------------------------------------------------------
// Finding 5 — remember's "not inside a git repository" error should point at how to name the repo.
// ---------------------------------------------------------------------------

test('finding 5: remember\'s git-repo-missing error suggests running overview', async () => {
  const { rememberFact } = require('../src/practice/author');
  const { openPracticeDb } = require('../src/practice/db');
  const { openGraphDb } = require('../src/practice/resolve');
  const pdb = openPracticeDb({ file: path.join(home, 'e2e-remember.db') });
  const graphDb = openGraphDb();
  try {
    const result = rememberFact(pdb, graphDb, {
      body: 'this is a fact with no repo and a cwd outside any git checkout',
      kind: 'hazard',
      cwd: os.tmpdir(),
    });
    assert.strictEqual(result.status, 'rejected');
    assert.ok(/run overview/.test(result.reason || ''), `expected an overview hint, got: ${result.reason}`);
  } finally {
    pdb.close();
    graphDb.close();
  }
});
