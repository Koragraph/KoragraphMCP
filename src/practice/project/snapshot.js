'use strict';

// Read the practice store into a plain, ordered data structure the renderer can consume. Two rules
// hold here: the read is one transaction (the render sees one consistent instant, never a fact
// without its just-written anchor), and the ordering is fixed in SQL so the same store always
// yields the same snapshot regardless of page cache or row layout.

const FACTS_SQL = `
  SELECT id, kind, tier, body, source, recurrence, created_at,
         expired_at, expiry_reason, expiry_note,
         contradicted_at, contradicted_reason, unconfirmed_since
  FROM facts
  ORDER BY id
`;

const ANCHORS_SQL = `
  SELECT fact_id, repo_id, file_path, symbol_name, grain, renamed_from
  FROM anchors
  ORDER BY repo_id, file_path, symbol_name, fact_id
`;

// db is a better-sqlite3 handle, opened read-only by the caller. Returns { facts: [...] } with each
// fact carrying its anchors in stable order.
function readSnapshot(db) {
  const read = db.transaction(() => {
    const facts = db.prepare(FACTS_SQL).all();
    const anchors = db.prepare(ANCHORS_SQL).all();
    const byFact = new Map();
    for (const f of facts) {
      f.anchors = [];
      byFact.set(f.id, f);
    }
    for (const a of anchors) {
      const f = byFact.get(a.fact_id);
      if (f) f.anchors.push(a);
    }
    return { facts };
  });
  // deferred: a read-only handle cannot take a write lock, and we only read.
  return read.deferred();
}

module.exports = { readSnapshot };
