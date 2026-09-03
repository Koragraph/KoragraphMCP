'use strict';

const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { logger } = require('../common-services/logger');
const { edgeWriteTier } = require('./resolution/tiers');

const composeParser = require('./contract-parsers/compose');
const envFileParser = require('./contract-parsers/env-file');

// Sweeps a repository's infrastructure config (docker-compose, .env) and makes it a real, walkable
// part of the graph — not just isolated SERVICE / CONFIG_VALUE vertices. For the ICP (two or three
// services wired by one compose file, a shared .env and a shared database) this IS the multi-repo
// connective tissue, and until now it produced NODES with ZERO edges: a SERVICE node an agent could
// find by name but not traverse from, and a CONFIG_VALUE nobody was shown to read.
//
// Two edge planes, both parsed straight out of the file (EXTRACTED-grade, never a name guess):
//   SERVICE  -[DEPENDS_ON]->  SERVICE       a compose `depends_on` (or an env host reference)
//   SERVICE  -[USES_CONFIG]-> CONFIG_VALUE  an environment key the service declares
//
// CONFIG_VALUE nodes are created from BOTH the compose `environment:` blocks and the `.env` file, on
// the same canonical key (`config:<NAME>`), so the two sources deduplicate into one node per variable
// — the shared `.env` and the compose that consumes it point at the same vertex.

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

async function upsertServiceNode(branchId, name, _pool) {
  const { rows } = await _pool.query(
    `INSERT INTO nodes (repository_branch_id, name, canonical_key, node_type, confidence_tier, confidence, summary, approval_status)
     VALUES ($1, $2, $3, 'SERVICE', 'EXTRACTED', 0.95, $4, 'APPROVED')
     ON CONFLICT (canonical_key) WHERE canonical_key IS NOT NULL AND repository_branch_id IS NOT NULL AND approval_status != 'ARCHIVED'
     DO UPDATE SET summary = EXCLUDED.summary
     RETURNING id`,
    [branchId, name, `service:${name}`, `Docker Compose service ${name}`]);
  return rows[0].id;
}

async function upsertConfigNode(branchId, name, _pool) {
  const { rows } = await _pool.query(
    `INSERT INTO nodes (repository_branch_id, name, canonical_key, node_type, confidence_tier, confidence, summary, approval_status)
     VALUES ($1, $2, $3, 'CONFIG_VALUE', 'EXTRACTED', 0.90, $4, 'APPROVED')
     ON CONFLICT (canonical_key) WHERE canonical_key IS NOT NULL AND repository_branch_id IS NOT NULL AND approval_status != 'ARCHIVED'
     DO UPDATE SET summary = EXCLUDED.summary
     RETURNING id`,
    [branchId, name, `config:${name}`, `Environment variable ${name}`]);
  return rows[0].id;
}

async function writeInfraEdges(edgeRows, _pool) {
  if (!edgeRows.length) return 0;
  const params = [];
  const values = edgeRows.map(({ from, to, edgeType, resolution }) => {
    const base = params.length;
    const derived = edgeWriteTier(resolution, edgeType);
    params.push(from, to, derived.edgeType, derived.label, JSON.stringify({ resolution }), derived.tier, derived.confidence);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  });
  const { rowCount } = await _pool.query(
    `INSERT INTO edges (from_node_id, to_node_id, edge_type, confidence_tier, properties, resolution_tier, confidence)
     VALUES ${values.join(',')}
     ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL DO NOTHING`,
    params);
  return rowCount ?? edgeRows.length;
}

async function resolveConfigInfraGraph({ repoPath, branchId }, _pool = pool) {
  if (!repoPath || !fs.existsSync(repoPath)) return { servicesCreated: 0, configCreated: 0, edgesWritten: 0 };

  let servicesCreated = 0;
  let configCreated = 0;
  const serviceId = new Map();     // service name -> node id
  const configId = new Map();      // config var name -> node id
  const edgeRows = [];

  const configNode = async (name) => {
    if (!name) return null;
    if (configId.has(name)) return configId.get(name);
    const id = await upsertConfigNode(branchId, name, _pool);
    configId.set(name, id);
    configCreated++;
    return id;
  };

  // 1. docker-compose — services, their environment keys, and their dependencies.
  for (const cf of COMPOSE_FILES) {
    const fullPath = path.join(repoPath, cf);
    if (!fs.existsSync(fullPath)) continue;
    let parsed;
    try {
      parsed = composeParser.parseCompose(cf, fs.readFileSync(fullPath, 'utf8'));
    } catch (err) {
      logger.warn(`[config-infra-graph] Compose parse error for ${cf}: ${err.message}`);
      continue;
    }
    if (!parsed || !Array.isArray(parsed.services)) continue;

    for (const svc of parsed.services) {
      if (serviceId.has(svc.name)) continue;
      serviceId.set(svc.name, await upsertServiceNode(branchId, svc.name, _pool));
      servicesCreated++;
    }
    // SERVICE -[USES_CONFIG]-> CONFIG_VALUE, one per environment key the service declares.
    for (const svc of parsed.services) {
      const from = serviceId.get(svc.name);
      for (const entry of svc.environment || []) {
        if (!entry.key) continue;
        const to = await configNode(entry.key);
        if (to) edgeRows.push({ from, to, edgeType: 'USES_CONFIG', resolution: 'config_value_ref' });
      }
    }
    // SERVICE -[DEPENDS_ON]-> SERVICE, from the parser's resolved service references (depends_on
    // and environment host references). A dangling depends_on (naming a service the file does not
    // define) is intentionally absent from serviceRefs, so it never produces a broken edge.
    for (const ref of parsed.serviceRefs || []) {
      const from = serviceId.get(ref.from);
      const to = serviceId.get(ref.to);
      if (from && to && from !== to) {
        edgeRows.push({ from, to, edgeType: 'DEPENDS_ON', resolution: 'compose_depends_on' });
      }
    }
  }

  // 2. .env — every variable becomes a CONFIG_VALUE, deduping with any compose env key of the same
  // name onto one node. No edge here: which code reads a .env var is writeConfigValueRefEdges' job.
  const envPath = path.join(repoPath, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const envResult = envFileParser.parseEnvFile('.env', fs.readFileSync(envPath, 'utf8'));
      for (const entry of envResult?.entries || []) {
        await configNode(entry.key);
      }
    } catch (err) {
      logger.warn(`[config-infra-graph] Env file parse error: ${err.message}`);
    }
  }

  const edgesWritten = await writeInfraEdges(edgeRows, _pool);
  logger.info(`[config-infra-graph] branchId=${branchId} services=${servicesCreated} config=${configCreated} edges=${edgesWritten}`);
  return { servicesCreated, configCreated, edgesWritten };
}

module.exports = { resolveConfigInfraGraph };
