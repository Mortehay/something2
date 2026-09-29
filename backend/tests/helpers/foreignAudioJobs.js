// SOMET-591 (game audio slice 2). audioJobQueue.retryFailed and .clear are
// deliberately database-wide (they back the admin "Retry failed" / "Clear"
// buttons), so a test that calls them also re-queues or deletes OTHER files'
// rows in the shared test database. The AUDIO_JOBS_LOCK_KEY lock keeps those
// files from running at the same time, but not from finding their leftovers
// changed afterwards. This snapshots every row in `states` that is NOT this
// file's own (subject_key NOT LIKE ownLike), runs fn(), and puts those rows
// back exactly as they were (delete + reinsert of the full row, in one
// transaction). Returns { result, foreignTouched }: foreignTouched counts the
// snapshot rows fn() changed or deleted, so a caller can assert on its OWN
// share of a database-wide count.
async function restoringForeignJobs(pool, ownLike, states, fn) {
  const snapshot = (await pool.query(
    `SELECT to_jsonb(j) AS row FROM audio_jobs j
      WHERE state = ANY($1) AND subject_key NOT LIKE $2`, [states, ownLike],
  )).rows.map((r) => r.row);
  const ids = snapshot.map((r) => r.id);
  let result;
  let foreignTouched = 0;
  try {
    result = await fn();
  } finally {
    if (ids.length) {
      const unchanged = (await pool.query(
        'SELECT 1 FROM audio_jobs WHERE id = ANY($1) AND state = ANY($2)', [ids, states],
      )).rowCount;
      foreignTouched = ids.length - unchanged;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM audio_jobs WHERE id = ANY($1)', [ids]);
        await client.query(
          'INSERT INTO audio_jobs SELECT * FROM jsonb_populate_recordset(NULL::audio_jobs, $1::jsonb)',
          [JSON.stringify(snapshot)],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
  }
  return { result, foreignTouched };
}

module.exports = { restoringForeignJobs };
