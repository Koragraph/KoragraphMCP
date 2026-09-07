'use strict';

// End-to-end coverage for the shared-database cross-repo plane (resolveCrossRepoTableEdges).
//
// The coupling this proves: two services that share a database table are bound together even
// though neither repo's code names the other — no HTTP call, no contract, no broker. Before this
// plane, two repos that each declared `CREATE TABLE orders` minted two independent DB_TABLE nodes
// that never linked (the per-repo reader resolver only joins by name/lowest-id, and the .sql-file
// table graph is branch-scoped), so a schema change in one repo showed no impact on the other.
//
// This reproduces with a real `koragraph ingest` across two `.sql`-only fixture repos — the exact
// case that previously produced zero cross-repo linkage — and asserts a marked
// `cross_repo_shared_table` REFERENCES edge is drawn between the two repos' `orders` tables.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'koragraph.js');

// Repo A — owns the schema: declares the `orders` table.
const ORDERS_FIXTURE = {
  'db/schema.sql':
    'CREATE TABLE orders (\n'
    + '  id INTEGER PRIMARY KEY,\n'
    + '  customer_id INTEGER,\n'
    + '  total_cents INTEGER\n'
    + ');\n',
  'app/orders.py':
    'def create_order(db, customer_id, total):\n'
    + '    db.execute("INSERT INTO orders (customer_id, total_cents) VALUES (?, ?)", (customer_id, total))\n',
};

// Repo B — a different service that reads the same table. Same table name, no shared code, no
// call between the repos: the invisible coupling.
const BILLING_FIXTURE = {
  'db/schema.sql':
    'CREATE TABLE orders (\n'
    + '  id INTEGER PRIMARY KEY,\n'
    + '  total_cents INTEGER\n'
    + ');\n',
  'app/billing.py':
    'def unbilled_total(db):\n'
    + '    return db.execute("SELECT SUM(total_cents) FROM orders WHERE billed = 0").fetchone()\n',
};

let home;
let ordersRoot;
let billingRoot;
let pool;

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koragraph-crossrepo-table-'));
  home = path.join(tmp, 'home');
  ordersRoot = path.join(tmp, 'orders-service');
  billingRoot = path.join(tmp, 'billing-service');
  fs.mkdirSync(home, { recursive: true });
  writeFixture(ordersRoot, ORDERS_FIXTURE);
  writeFixture(billingRoot, BILLING_FIXTURE);

  // One `ingest` call, two repos, no --project: both land in the default project, so cross-repo
  // resolution (ingest-post-tail.js -> resolveProjectCrossRepoEdges -> resolveCrossRepoTableEdges)
  // runs across them.
  execFileSync('node', [CLI, 'ingest', ordersRoot, billingRoot], {
    env: { ...process.env, KORAGRAPH_HOME: home },
    stdio: 'pipe',
  });

  // The pool singleton resolves KORAGRAPH_HOME at require time, so set it before the first require.
  process.env.KORAGRAPH_HOME = home;
  pool = require('../src/db/pool');
});

test('a cross_repo_shared_table edge links the two repos\' orders tables', async () => {
  const { rows } = await pool.query(
    `SELECT e.from_node_id, e.to_node_id,
            json_extract(e.properties, '$.resolution')                AS resolution,
            json_extract(e.properties, '$.shared_table_confidence')   AS confidence,
            json_extract(e.properties, '$.via')                       AS via,
            e.is_cross_repo                                           AS is_cross_repo,
            fb.repository_id AS from_repo, fn.name AS from_name,
            tb.repository_id AS to_repo,   tn.name AS to_name
       FROM edges e
       JOIN nodes fn ON fn.id = e.from_node_id
       JOIN nodes tn ON tn.id = e.to_node_id
       JOIN repository_branches fb ON fb.id = fn.repository_branch_id
       JOIN repository_branches tb ON tb.id = tn.repository_branch_id
      WHERE e.edge_type = 'REFERENCES'
        AND json_extract(e.properties, '$.resolution') = 'cross_repo_shared_table'`,
    [],
  );

  assert.ok(rows.length > 0, 'expected at least one cross_repo_shared_table edge, got none');

  const orderEdge = rows.find((r) => r.via === 'orders' && r.from_repo !== r.to_repo);
  assert.ok(
    orderEdge,
    `expected a cross-repo edge on the "orders" table between the two repos, got: ${JSON.stringify(rows)}`,
  );
  assert.strictEqual(orderEdge.is_cross_repo, 1, 'edge must be flagged is_cross_repo');
  assert.strictEqual((orderEdge.from_name || '').toLowerCase(), 'orders');
  assert.strictEqual((orderEdge.to_name || '').toLowerCase(), 'orders');
  // Bare-name match, no corroborating schema/database in the fixtures → honest low confidence.
  assert.strictEqual(orderEdge.confidence, 'low', 'a bare-name match should be labelled low confidence');
});

test('the shared-table link is symmetric (drawn from either repo\'s table)', async () => {
  const { rows } = await pool.query(
    `SELECT fb.repository_id AS from_repo, tb.repository_id AS to_repo
       FROM edges e
       JOIN nodes fn ON fn.id = e.from_node_id
       JOIN nodes tn ON tn.id = e.to_node_id
       JOIN repository_branches fb ON fb.id = fn.repository_branch_id
       JOIN repository_branches tb ON tb.id = tn.repository_branch_id
      WHERE e.edge_type = 'REFERENCES'
        AND json_extract(e.properties, '$.resolution') = 'cross_repo_shared_table'
        AND json_extract(e.properties, '$.via') = 'orders'`,
    [],
  );
  const directions = new Set(rows.filter((r) => r.from_repo !== r.to_repo).map((r) => `${r.from_repo}->${r.to_repo}`));
  assert.strictEqual(directions.size, 2, `expected both directions of the shared-table link, got: ${[...directions].join(', ')}`);
});
