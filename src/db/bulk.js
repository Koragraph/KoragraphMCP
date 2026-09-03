'use strict';

// Bulk insert without unnest().
//
// Postgres's idiom is one statement carrying N parallel arrays; SQLite has no unnest. The
// replacement is one PREPARED statement executed N times inside a single transaction, which is
// faster rather than a compromise: the shim caches by statement text, so the parse happens once
// and each row is a bind plus a step.
//
// Always wrapped in BEGIN/COMMIT. Callers that are already inside a transaction are safe because
// the shim's depth counter turns the inner BEGIN into a SAVEPOINT — a literal nested BEGIN is a
// hard error in SQLite, not a no-op.

async function bulkWrite(pool, sql, rowsOfParams) {
  if (!rowsOfParams.length) return 0;
  let written = 0;
  await pool.query('BEGIN');
  try {
    for (const params of rowsOfParams) {
      const res = await pool.query(sql, params);
      written += res.rowCount ?? 0;
    }
    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => {});
    throw err;
  }
  return written;
}

module.exports = { bulkWrite };
