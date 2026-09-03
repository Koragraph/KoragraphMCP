-- The graph store's schema, and the source of truth for it. src/db/pool.js applies this file
-- the first time it opens a database; there is no migration step and nothing regenerates it.
--
-- Hand-edit deliberately. src/db/jsonb-columns.json lists the columns holding JSON and has to
-- be kept in step by hand — a column added here that stores JSON must be added there too.
--
-- On "no LLM": nothing in the shipping path calls a model or the network — no code in src/ imports a
-- model-provider SDK or opens a socket. A few columns here are named
-- for an OPTIONAL summarizer/embedding plane that a caller may wire themselves; this distribution never
-- runs it, so those columns stay at their structural defaults. Specifically: `summary_source`/`summary_model`
-- record HOW a file summary was produced — the shipping path derives it structurally from the file's own
-- nodes (source 'nodes'/'heuristic'), so `summary_model` stays NULL; it is only set if someone wires an
-- 'llm' summarizer. `embedding_status` is a plain active/archived flag on the LEXICAL method-text index
-- (method_text_index below stores text and a hash, not vectors) — the name is legacy. The `embedding_methods`
-- / `embedding_repo` work_type values are reserved and never enqueued. None of these make koragraph less
-- deterministic: ingest the same repo twice, get the same graph.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_synced_at TEXT,
  org_id INTEGER NOT NULL DEFAULT 1,
  is_archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_is_archived ON projects (is_archived);
CREATE INDEX IF NOT EXISTS idx_projects_org_id ON projects (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS projects_name_key ON projects (name);
-- not carried: idx_projects_tenant_id — indexes a dropped column
-- not carried: projects_pkey — the PRIMARY KEY — declared inline on the column

-- not carried: idx_repositories_repo_embedding_hnsw — hnsw, no SQLite analogue
-- SQLite matches an ON CONFLICT target against a partial unique index
-- TEXTUALLY. Omitting the WHERE, weakening it, or reordering its AND terms all
-- raise "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint".
-- Copy these predicates verbatim into every upsert that targets them.
--   ON CONFLICT (project_id, name) WHERE project_id IS NOT NULL
CREATE TABLE IF NOT EXISTS repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,
  gitlab_project_id INTEGER,
  name TEXT NOT NULL,
  full_path TEXT NOT NULL,
  web_url TEXT,
  repo_type TEXT DEFAULT 'BACKEND',
  last_activity_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  stack TEXT,
  repo_summary TEXT,
  repo_summary_generated_at TEXT,
  repo_file_digests TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  published_modules TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_repositories_is_archived ON repositories (is_archived);
CREATE INDEX IF NOT EXISTS idx_repositories_project_id ON repositories (project_id);
CREATE INDEX IF NOT EXISTS idx_repositories_web_url ON repositories (web_url) WHERE web_url IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS repositories_project_id_name_key ON repositories (project_id, name) WHERE project_id IS NOT NULL;
-- not carried: idx_repositories_embedding_profile — indexes a dropped vector/tsvector column
-- not carried: repositories_pkey — the PRIMARY KEY — declared inline on the column

CREATE TABLE IF NOT EXISTS repository_branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER,
  branch_name TEXT NOT NULL,
  branch_role TEXT NOT NULL,
  is_tracked INTEGER DEFAULT 0,
  last_commit_sha TEXT,
  last_synced_at TEXT,
  sync_status TEXT DEFAULT 'PENDING',
  node_count INTEGER DEFAULT 0,
  role_locked INTEGER NOT NULL DEFAULT 0,
  CHECK ((branch_role IN ('MAIN', 'PRODUCTION', 'DEVELOPMENT', 'STAGING', 'FEATURE'))),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_repository_branches_repo_id ON repository_branches (repository_id);
CREATE UNIQUE INDEX IF NOT EXISTS repository_branches_repository_id_branch_name_key ON repository_branches (repository_id, branch_name);
-- not carried: repository_branches_pkey — the PRIMARY KEY — declared inline on the column

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_branch_id INTEGER,
  path TEXT NOT NULL,
  file_type TEXT,
  file_sha TEXT,
  source_file_id INTEGER,
  last_indexed_at TEXT,
  index_status TEXT DEFAULT 'PENDING',
  summary TEXT,
  summary_generated_at TEXT,
  -- structural provenance, not an LLM: source is 'nodes'/'heuristic' on the shipping path (see
  -- file-summary.js), so summary_model stays NULL unless an optional 'llm' summarizer is wired.
  summary_source TEXT,
  summary_model TEXT,
  summary_generation_id INTEGER,
  FOREIGN KEY (repository_branch_id) REFERENCES repository_branches(id) ON DELETE CASCADE,
  FOREIGN KEY (source_file_id) REFERENCES files(id),
  FOREIGN KEY (summary_generation_id) REFERENCES ingest_generations(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS files_repository_branch_id_path_key ON files (repository_branch_id, path);
CREATE INDEX IF NOT EXISTS idx_files_branch_id ON files (repository_branch_id);
CREATE INDEX IF NOT EXISTS idx_files_koragraph_status ON files (index_status);
CREATE INDEX IF NOT EXISTS idx_files_summary_null ON files (repository_branch_id) WHERE summary IS NULL;
-- not carried: files_pkey — the PRIMARY KEY — declared inline on the column

-- SQLite matches an ON CONFLICT target against a partial unique index
-- TEXTUALLY. Omitting the WHERE, weakening it, or reordering its AND terms all
-- raise "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint".
-- Copy these predicates verbatim into every upsert that targets them.
--   ON CONFLICT (canonical_key) WHERE (canonical_key IS NOT NULL) AND (repository_branch_id IS NOT NULL) AND (approval_status <> 'ARCHIVED')
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_branch_id INTEGER,
  file_id INTEGER,
  node_type TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT,
  raw_evidence TEXT,
  confidence REAL DEFAULT 1.0,
  approval_status TEXT DEFAULT 'APPROVED',
  approved_by TEXT,
  approved_at TEXT,
  file_sha_at_extract TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  properties TEXT DEFAULT '{}',
  canonical_key TEXT,
  confidence_tier TEXT NOT NULL DEFAULT 'INFERRED',
  start_line INTEGER,
  end_line INTEGER,
  ingest_generation_id INTEGER,
  CHECK ((confidence_tier IN ('EXTRACTED', 'INFERRED', 'AMBIGUOUS'))),
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY (ingest_generation_id) REFERENCES ingest_generations(id) ON DELETE CASCADE,
  FOREIGN KEY (repository_branch_id) REFERENCES repository_branches(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_nodes_approval_status ON nodes (approval_status);
CREATE INDEX IF NOT EXISTS idx_nodes_branch_id ON nodes (repository_branch_id);
CREATE INDEX IF NOT EXISTS idx_nodes_branch_type ON nodes (repository_branch_id, node_type);
CREATE INDEX IF NOT EXISTS idx_nodes_branch_type_status ON nodes (repository_branch_id, node_type, approval_status);
CREATE INDEX IF NOT EXISTS idx_nodes_canonical_key ON nodes (canonical_key) WHERE canonical_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_canonical_key_active ON nodes (canonical_key) WHERE (canonical_key IS NOT NULL) AND (repository_branch_id IS NOT NULL) AND (approval_status <> 'ARCHIVED');
CREATE INDEX IF NOT EXISTS idx_nodes_confidence_tier ON nodes (confidence_tier);
CREATE INDEX IF NOT EXISTS idx_nodes_file_id ON nodes (file_id);
CREATE INDEX IF NOT EXISTS idx_nodes_file_span ON nodes (repository_branch_id, file_id, start_line, end_line) WHERE (start_line IS NOT NULL) AND (approval_status = 'APPROVED');
CREATE INDEX IF NOT EXISTS idx_nodes_ingest_generation ON nodes (ingest_generation_id) WHERE ingest_generation_id IS NOT NULL;
-- Exact-name resolution scans without this. `neighbours` reported "No symbol named X" for 7.7% of
-- symbols that were in the graph, and the fix — matching lower(name) ahead of the ranked pool —
-- costs 22.5 ms/query unindexed on a 120k-node store. It must be an EXPRESSION index: a
-- `name COLLATE NOCASE` index measured 22.26 ms because `lower(name) = ?` is not sargable against
-- it, while this one measured 0.00 ms (SEARCH n USING INDEX (<expr>=?)).
CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes (lower(name));
-- not carried: idx_nodes_canonical_key_unique — byte-identical duplicate of idx_nodes_canonical_key_active
-- not carried: idx_nodes_database_schema_id — indexes a dropped column
-- not carried: nodes_pkey — the PRIMARY KEY — declared inline on the column

-- SQLite matches an ON CONFLICT target against a partial unique index
-- TEXTUALLY. Omitting the WHERE, weakening it, or reordering its AND terms all
-- raise "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint".
-- Copy these predicates verbatim into every upsert that targets them.
--   ON CONFLICT (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_node_id INTEGER,
  to_node_id INTEGER,
  edge_type TEXT NOT NULL,
  is_cross_repo INTEGER DEFAULT 0,
  properties TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  confidence_tier TEXT NOT NULL DEFAULT 'INFERRED',
  resolution_tier INTEGER,
  confidence REAL,
  CHECK ((confidence_tier IN ('EXTRACTED', 'INFERRED', 'AMBIGUOUS', 'SYNTHETIC'))),
  FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (to_node_id) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS edges_resolved_unique ON edges (from_node_id, to_node_id, edge_type) WHERE to_node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_edges_confidence_tier ON edges (confidence_tier);
CREATE INDEX IF NOT EXISTS idx_edges_from_node ON edges (from_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_from_type ON edges (from_node_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_to_node ON edges (to_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_to_type ON edges (to_node_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_type_tier ON edges (edge_type, resolution_tier);
-- not carried: edges_pkey — the PRIMARY KEY — declared inline on the column

CREATE TABLE IF NOT EXISTS method_text_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL,
  method_name TEXT NOT NULL DEFAULT '_node',
  method_text TEXT NOT NULL,
  method_text_hash TEXT,
  ingest_generation_id INTEGER,
  -- legacy name: this is a plain active/archived flag on the lexical text index above, not an
  -- embedding state. method_text_index stores text + a hash; no vectors are computed anywhere.
  embedding_status TEXT NOT NULL DEFAULT 'active',
  CHECK ((embedding_status IN ('active', 'archived'))),
  FOREIGN KEY (ingest_generation_id) REFERENCES ingest_generations(id) ON DELETE CASCADE,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_method_text_index_active_search ON method_text_index (node_id, method_name) WHERE embedding_status = 'active';
CREATE INDEX IF NOT EXISTS idx_method_text_index_generation ON method_text_index (ingest_generation_id) WHERE ingest_generation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_method_text_index_node ON method_text_index (node_id);
CREATE UNIQUE INDEX IF NOT EXISTS method_text_index_node_method_uq ON method_text_index (node_id, method_name);
-- not carried: method_text_index_pkey — the PRIMARY KEY — declared inline on the column

-- not carried: file_text_chunks_p0_lexemes_idx — gin, no SQLite analogue
CREATE TABLE IF NOT EXISTS file_text_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_branch_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  file_sha TEXT NOT NULL,
  path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  search_text TEXT NOT NULL,
  ingest_generation_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS file_text_chunks_ingest_generation_id_idx ON file_text_chunks (ingest_generation_id) WHERE ingest_generation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS file_text_chunks_repository_branch_id_file_id_file_sha_c_key ON file_text_chunks (repository_branch_id, file_id, file_sha, chunk_index);
CREATE INDEX IF NOT EXISTS file_text_chunks_repository_branch_id_file_id_idx ON file_text_chunks (repository_branch_id, file_id);
-- not carried: file_text_chunks_p0_pkey — the partitioned table PK — reduced to id alone, see PK_OVERRIDE

CREATE TABLE IF NOT EXISTS file_source_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_branch_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  file_sha TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT,
  byte_size INTEGER,
  skip_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ingest_generation_id INTEGER,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY (ingest_generation_id) REFERENCES ingest_generations(id) ON DELETE CASCADE,
  FOREIGN KEY (repository_branch_id) REFERENCES repository_branches(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS file_source_cache_file_id_file_sha_key ON file_source_cache (file_id, file_sha);
CREATE INDEX IF NOT EXISTS idx_file_source_cache_branch ON file_source_cache (repository_branch_id);
CREATE INDEX IF NOT EXISTS idx_file_source_cache_file ON file_source_cache (file_id);
CREATE INDEX IF NOT EXISTS idx_file_source_cache_generation ON file_source_cache (ingest_generation_id) WHERE ingest_generation_id IS NOT NULL;
-- not carried: file_source_cache_pkey — the PRIMARY KEY — declared inline on the column

CREATE TABLE IF NOT EXISTS file_extraction_cache (
  cache_key TEXT PRIMARY KEY,
  indexer_fingerprint TEXT NOT NULL,
  nodes TEXT NOT NULL,
  edges TEXT NOT NULL DEFAULT '{}',
  partial INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_hit_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS file_extraction_cache_fingerprint_idx ON file_extraction_cache (indexer_fingerprint);
CREATE INDEX IF NOT EXISTS file_extraction_cache_last_hit_at_idx ON file_extraction_cache (last_hit_at);
-- not carried: file_extraction_cache_pkey — the PRIMARY KEY — declared inline on the column

CREATE TABLE IF NOT EXISTS ingest_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,
  github_url TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  stack TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  files_total INTEGER NOT NULL DEFAULT 0,
  files_done INTEGER NOT NULL DEFAULT 0,
  nodes_written INTEGER NOT NULL DEFAULT 0,
  error_msg TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  detected_stack TEXT,
  files_scanned INTEGER NOT NULL DEFAULT 0,
  files_extractable INTEGER NOT NULL DEFAULT 0,
  files_skipped INTEGER NOT NULL DEFAULT 0,
  coverage_pct REAL,
  coverage_warning TEXT,
  skipped_sample TEXT,
  claimed_by TEXT,
  started_at TEXT,
  next_retry_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  job_type TEXT NOT NULL DEFAULT 'FULL',
  changed_files TEXT,
  embedding_failures INTEGER NOT NULL DEFAULT 0,
  files_skipped_oversize INTEGER NOT NULL DEFAULT 0,
  oversize_sample TEXT,
  source_type TEXT NOT NULL DEFAULT 'REMOTE',
  local_path TEXT,
  degraded_modalities TEXT NOT NULL DEFAULT '[]',
  gate_summary TEXT,
  files_with_nodes INTEGER,
  files_accounted INTEGER,
  comprehension_pct REAL,
  edges_refused_ambiguous INTEGER NOT NULL DEFAULT 0,
  role_labeled_source_pct REAL,
  files_accounted_pct REAL,
  files_skipped_as_other INTEGER,
  skipped_as_other_sample TEXT,
  CHECK ((job_type IN ('FULL', 'INCREMENTAL'))),
  CHECK ((source_type IN ('REMOTE', 'LOCAL'))),
  CHECK ((status IN ('PENDING', 'RUNNING', 'COMPLETE', 'FAILED', 'DEGRADED', 'WAITING_RETRY'))),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ingest_jobs_project_id ON ingest_jobs (project_id);
CREATE INDEX IF NOT EXISTS idx_ingest_jobs_project_status ON ingest_jobs (project_id, status);
CREATE INDEX IF NOT EXISTS idx_ingest_jobs_queue ON ingest_jobs (status, next_retry_at, id) WHERE status IN ('PENDING', 'RUNNING');
CREATE INDEX IF NOT EXISTS idx_ingest_jobs_source_type ON ingest_jobs (source_type);
CREATE INDEX IF NOT EXISTS idx_ingest_jobs_status ON ingest_jobs (status);
-- not carried: ingest_jobs_pkey — the PRIMARY KEY — declared inline on the column

-- SQLite matches an ON CONFLICT target against a partial unique index
-- TEXTUALLY. Omitting the WHERE, weakening it, or reordering its AND terms all
-- raise "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint".
-- Copy these predicates verbatim into every upsert that targets them.
--   ON CONFLICT (repository_branch_id) WHERE status = 'ACTIVE'
CREATE TABLE IF NOT EXISTS ingest_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  repository_branch_id INTEGER NOT NULL,
  revision_sha TEXT,
  config_hash TEXT,
  extractor_version TEXT,
  indexer_version TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  previous_generation_id INTEGER,
  diagnostics TEXT,
  CHECK ((status IN ('PENDING', 'VALIDATING', 'ACTIVE', 'FAILED', 'SUPERSEDED'))),
  FOREIGN KEY (previous_generation_id) REFERENCES ingest_generations(id) ON DELETE SET NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (repository_branch_id) REFERENCES repository_branches(id) ON DELETE CASCADE,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_generations_active_branch ON ingest_generations (repository_branch_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_ingest_generations_branch ON ingest_generations (repository_branch_id, started_at DESC);
-- not carried: ingest_generations_pkey — the PRIMARY KEY — declared inline on the column

CREATE TABLE IF NOT EXISTS ingest_coverage_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  repository_branch_id INTEGER,
  path TEXT NOT NULL,
  tier TEXT NOT NULL,
  reason TEXT,
  bytes INTEGER,
  sha TEXT,
  node_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  chunk_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ingest_coverage_files_job_id ON ingest_coverage_files (job_id);
CREATE INDEX IF NOT EXISTS idx_ingest_coverage_files_job_tier ON ingest_coverage_files (job_id, tier);
-- not carried: ingest_coverage_files_pkey — the PRIMARY KEY — declared inline on the column

CREATE TABLE IF NOT EXISTS ingest_retry_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER,
  project_id INTEGER,
  ingest_job_id INTEGER NOT NULL,
  branch_id INTEGER,
  work_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'PENDING',
  next_retry_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((status IN ('PENDING', 'RUNNING', 'COMPLETE', 'FAILED'))),
  -- 'embedding_methods' / 'embedding_repo' are reserved for the optional summarizer plane and are
  -- never enqueued by this distribution; the shipping path only uses the last three.
  CHECK ((work_type IN ('embedding_methods', 'embedding_repo', 'source_cache', 'edge_resolution', 'extraction_retry'))),
  FOREIGN KEY (branch_id) REFERENCES repository_branches(id) ON DELETE CASCADE,
  FOREIGN KEY (ingest_job_id) REFERENCES ingest_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ingest_retry_queue_job ON ingest_retry_queue (ingest_job_id, status);
CREATE INDEX IF NOT EXISTS idx_ingest_retry_queue_pending ON ingest_retry_queue (status, next_retry_at, id) WHERE status = 'PENDING';
CREATE UNIQUE INDEX IF NOT EXISTS ingest_retry_queue_idempotency_key_key ON ingest_retry_queue (idempotency_key);
-- not carried: ingest_retry_queue_pkey — the PRIMARY KEY — declared inline on the column

CREATE TABLE IF NOT EXISTS commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_branch_id INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  author_name TEXT,
  author_email TEXT,
  committed_at TEXT,
  message TEXT,
  FOREIGN KEY (repository_branch_id) REFERENCES repository_branches(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS commits_repository_branch_id_commit_sha_key ON commits (repository_branch_id, commit_sha);
CREATE INDEX IF NOT EXISTS idx_commits_branch_date ON commits (repository_branch_id, committed_at DESC);
-- not carried: commits_pkey — the PRIMARY KEY — declared inline on the column

CREATE TABLE IF NOT EXISTS commit_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  commit_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  change_type TEXT NOT NULL,
  FOREIGN KEY (commit_id) REFERENCES commits(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_commit_files_commit ON commit_files (commit_id);
CREATE INDEX IF NOT EXISTS idx_commit_files_path ON commit_files (file_path);
-- not carried: commit_files_pkey — the PRIMARY KEY — declared inline on the column

CREATE TABLE IF NOT EXISTS graph_diffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingest_job_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  nodes_added INTEGER NOT NULL DEFAULT 0,
  nodes_archived INTEGER NOT NULL DEFAULT 0,
  edges_added INTEGER NOT NULL DEFAULT 0,
  edges_removed INTEGER NOT NULL DEFAULT 0,
  diff_detail TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (branch_id) REFERENCES repository_branches(id) ON DELETE CASCADE,
  FOREIGN KEY (ingest_job_id) REFERENCES ingest_jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_graph_diffs_branch_id ON graph_diffs (branch_id);
CREATE INDEX IF NOT EXISTS idx_graph_diffs_computed_at ON graph_diffs (computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_graph_diffs_ingest_job_id ON graph_diffs (ingest_job_id);
-- not carried: graph_diffs_pkey — the PRIMARY KEY — declared inline on the column

CREATE TABLE IF NOT EXISTS koragraph_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,
  project_name TEXT,
  repository_id INTEGER,
  repository_name TEXT,
  repository_branch_id INTEGER,
  branch_name TEXT,
  file_id INTEGER,
  file_path TEXT,
  file_type TEXT,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  index_status TEXT,
  node_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (repository_branch_id) REFERENCES repository_branches(id) ON DELETE SET NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_koragraph_logs_created_at ON koragraph_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_koragraph_logs_project_id ON koragraph_logs (project_id);
-- not carried: koragraph_logs_pkey — the PRIMARY KEY — declared inline on the column

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  checksum TEXT NOT NULL
);
-- not carried: schema_migrations_pkey — the PRIMARY KEY — declared inline on the column

CREATE VIRTUAL TABLE IF NOT EXISTS file_text_chunks_fts USING fts5(
  chunk_text,
  search_text,
  content = 'file_text_chunks',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS file_text_chunks_ai AFTER INSERT ON file_text_chunks BEGIN
  INSERT INTO file_text_chunks_fts(rowid, chunk_text, search_text)
  VALUES (new.id, new.chunk_text, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS file_text_chunks_ad AFTER DELETE ON file_text_chunks BEGIN
  INSERT INTO file_text_chunks_fts(file_text_chunks_fts, rowid, chunk_text, search_text)
  VALUES ('delete', old.id, old.chunk_text, old.search_text);
END;
CREATE TRIGGER IF NOT EXISTS file_text_chunks_au AFTER UPDATE ON file_text_chunks BEGIN
  INSERT INTO file_text_chunks_fts(file_text_chunks_fts, rowid, chunk_text, search_text)
  VALUES ('delete', old.id, old.chunk_text, old.search_text);
  INSERT INTO file_text_chunks_fts(rowid, chunk_text, search_text)
  VALUES (new.id, new.chunk_text, new.search_text);
END;

-- Full-file lexical index (B2 localization fix, 2026-08-31): file_text_chunks_fts ranks lossy,
-- line-windowed chunks; this ranks the verbatim per-file text already cached at ingest
-- (file_source_cache), for the opt-in 'file_lexical' channel (retrieval-file-lexical.js). Not
-- read by any default retrieval path.
CREATE VIRTUAL TABLE IF NOT EXISTS file_source_cache_fts USING fts5(
  content,
  content = 'file_source_cache',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS file_source_cache_ai AFTER INSERT ON file_source_cache BEGIN
  INSERT INTO file_source_cache_fts(rowid, content)
  VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS file_source_cache_ad AFTER DELETE ON file_source_cache BEGIN
  INSERT INTO file_source_cache_fts(file_source_cache_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS file_source_cache_au AFTER UPDATE ON file_source_cache BEGIN
  INSERT INTO file_source_cache_fts(file_source_cache_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
  INSERT INTO file_source_cache_fts(rowid, content)
  VALUES (new.id, new.content);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name,
  summary,
  raw_evidence,
  tokenize = 'trigram'
);
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, name, summary, raw_evidence)
  VALUES (new.id, new.name, new.summary, new.raw_evidence);
END;
CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  DELETE FROM nodes_fts WHERE rowid = old.id;
END;
CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  DELETE FROM nodes_fts WHERE rowid = old.id;
  INSERT INTO nodes_fts(rowid, name, summary, raw_evidence)
  VALUES (new.id, new.name, new.summary, new.raw_evidence);
END;

