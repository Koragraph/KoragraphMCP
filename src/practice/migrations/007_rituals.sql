-- Rituals are mined from `events` on demand (2,999 command rows in 4 ms), so there is no cache
-- table here and deliberately so: a cache would be a second copy of a number that is already cheap
-- to recompute, and it would go stale in exactly the direction the freshness rules exist to stop.
--
-- What DOES have to persist is that a session has already been told. The rulebook is pushed once
-- per session, and a hook is a fresh process every time, so there is nowhere to keep that but here
-- (same reason as preflight_shown in 002).
--
-- `forms` is the rendered lines, kept so `why did it say that` is answerable after the fact
-- without replaying the mine against an events table that has moved on.
CREATE TABLE ritual_pushes (
  session_id  TEXT NOT NULL,
  repo_id     TEXT NOT NULL,
  pushed_at   TEXT NOT NULL,
  forms       TEXT,
  PRIMARY KEY (session_id, repo_id)
);
