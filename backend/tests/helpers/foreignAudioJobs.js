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

// A claim (claimNext/claimBatch, or a drain) takes ANY claimable queued row,
// not only the calling file's. This parks every claimable queued row that is
// NOT this file's own (subject_key NOT LIKE ownLike) an hour out for the
// duration of fn(), then puts each not_before back to its EXACT previous
// value (NULL or a past timestamp). Same pattern audio_dispatcher_db and
// audio_jobs_routes_db carry inline.
async function parkingForeignQueued(pool, ownLike, fn) {
  const rows = (await pool.query(
    `SELECT id, not_before FROM audio_jobs
      WHERE state = 'queued' AND (not_before IS NULL OR not_before <= now())
        AND subject_key NOT LIKE $1`, [ownLike],
  )).rows;
  if (rows.length) {
    await pool.query(
      `UPDATE audio_jobs SET not_before = now() + interval '1 hour' WHERE id = ANY($1)`,
      [rows.map((r) => r.id)],
    );
  }
  try {
    return await fn();
  } finally {
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query('UPDATE audio_jobs SET not_before = $2 WHERE id = $1', [r.id, r.not_before]);
    }
  }
}

module.exports = { restoringForeignJobs, parkingForeignQueued };
