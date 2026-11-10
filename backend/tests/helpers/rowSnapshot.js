// Snapshot-and-restore for real rows a DB test has to change (a seeded buff_visuals or
// aura_effects row, a subject's art_prompt_descriptions). Forcing such rows to a "default"
// afterwards overwrites whatever the database really held; this puts back exactly what was
// there: delete what now matches `where`, reinsert the snapshot's full rows, in one
// transaction. Only for tables no foreign key points at (the delete would cascade).
//
//   const restore = await snapshotRows(pool, 'buff_visuals', 'skill_id = $1', ['war_shield_wall']);
//   try { ... } finally { await restore(); }
async function snapshotRows(pool, table, where, params = []) {
  const { rows: [{ rows }] } = await pool.query(
    `SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows FROM ${table} t WHERE ${where}`, params);
  return async function restore() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM ${table} WHERE ${where}`, params);
      if (rows.length) {
        await client.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`,
          [JSON.stringify(rows)]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };
}

// Several snapshots restored together (last taken, first restored).
async function snapshotAll(pool, specs) {
  const restores = [];
  for (const [table, where, params] of specs) {
    // eslint-disable-next-line no-await-in-loop
    restores.push(await snapshotRows(pool, table, where, params));
  }
  return async () => { for (const r of restores.reverse()) await r(); }; // eslint-disable-line no-await-in-loop
}

module.exports = { snapshotRows, snapshotAll };
