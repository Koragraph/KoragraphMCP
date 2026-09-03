-- At most one pre-flight per symbol per session. The guard needs to survive between hook
-- invocations, and a hook is a fresh process every time, so there is nowhere to keep it but here.
CREATE TABLE preflight_shown (
  session_id   TEXT NOT NULL,
  repo_id      TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  symbol_name  TEXT NOT NULL DEFAULT '',
  fact_id      INTEGER,
  shown_at     TEXT NOT NULL,
  PRIMARY KEY (session_id, repo_id, file_path, symbol_name)
);
