// status_visuals table and the 'status' subject kind (1714440885000). Gated on TEST_DATABASE_URL.
// The up/down round trip runs inside a transaction that is always rolled back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const migration = require('../migrations/1714440885000_status_visuals.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to touch a real database' : false;

const JOB = (kind) => `INSERT INTO effect_sprite_jobs (subject_kind, subject_name, prompt, kind, frames, size, loop, blend, seed)
  VALUES ('${kind}', 'amber_stance_1', 'p', 'aura', 8, 128, true, 'alpha', 1)`;
const OPTIN = (kind) => `INSERT INTO sprite_prompt_optins (subject_kind, subject_key) VALUES ('${kind}', 'amber_stance_1')`;

// A pgm stand-in that runs the migration's statements on one client.
function pgmOn(client, queue) {
  const q = (sql) => queue.push(client.query(sql));
  return {
    func: (f) => ({ __func: f }),
    sql: q,
    dropConstraint: (t, c) => q(`ALTER TABLE ${t} DROP CONSTRAINT ${c}`),
    addConstraint: (t, c, def) => q(`ALTER TABLE ${t} ADD CONSTRAINT ${c} ${typeof def === 'string' ? def : def.check}`),
    dropTable: (t) => q(`DROP TABLE ${t}`),
    createTable: () => { throw new Error('use sql in the migration'); },
  };
}

test('status_visuals migration', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 2 });
  t.after(() => pool.end());

  await t.test('seeds amber_stance 1..10 with no sprite, with defaults and a generated subject_key', async () => {
    const { rows } = await pool.query("SELECT * FROM status_visuals WHERE status_key = 'amber_stance' ORDER BY variant");
    assert.deepEqual(rows.map((r) => r.variant), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const r of rows) {
      assert.equal(r.subject_key, `amber_stance_${r.variant}`);
      assert.equal(r.sprite_image, null);
      assert.equal(r.sprite_frames, 1);
      assert.equal(r.sprite_additive, false);
      assert.equal(r.sprite_fps, null);
      assert.ok(r.sync_uuid);
      assert.ok(r.updated_at);
    }
  });

  await t.test("effect_sprite_jobs and sprite_prompt_optins accept 'status' and still refuse unknown kinds", async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(JOB('status'));
      await c.query(OPTIN('status'));
      await c.query('SAVEPOINT s');
      await assert.rejects(c.query(JOB('item')), (e) => e.code === '23514');
      await c.query('ROLLBACK TO s');
      await assert.rejects(c.query(OPTIN('item')), (e) => e.code === '23514');
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  await t.test('(status_key, variant) is the primary key and subject_key is unique', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await assert.rejects(c.query("INSERT INTO status_visuals (status_key, variant) VALUES ('amber_stance', 1)"), (e) => e.code === '23505');
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  await t.test('down removes the table and the status rows and kinds; up restores them', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(JOB('status'));
      await c.query(OPTIN('status'));
      let queue = [];
      migration.down(pgmOn(c, queue));
      for (const p of queue) await p; // eslint-disable-line no-await-in-loop
      assert.equal((await c.query("SELECT to_regclass('status_visuals') AS t")).rows[0].t, null);
      assert.equal((await c.query("SELECT count(*)::int AS n FROM effect_sprite_jobs WHERE subject_kind = 'status'")).rows[0].n, 0);
      assert.equal((await c.query("SELECT count(*)::int AS n FROM sprite_prompt_optins WHERE subject_kind = 'status'")).rows[0].n, 0);
      await assert.rejects(c.query('SAVEPOINT x').then(() => c.query(JOB('status'))), (e) => e.code === '23514');
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      queue = [];
      migration.down(pgmOn(c, queue));
      for (const p of queue) await p; // eslint-disable-line no-await-in-loop
      queue = [];
      migration.up(pgmOn(c, queue));
      for (const p of queue) await p; // eslint-disable-line no-await-in-loop
      assert.equal((await c.query("SELECT count(*)::int AS n FROM status_visuals WHERE status_key = 'amber_stance'")).rows[0].n, 10);
      await c.query(JOB('status'));
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
});
