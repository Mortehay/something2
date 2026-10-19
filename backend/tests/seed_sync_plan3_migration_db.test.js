const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const MigrationBuilder = require('node-pg-migrate/dist/migration-builder').default;
const { withSeedSyncLock } = require('./helpers/seedSyncTest.js');

// SOMET-640. Plan-3 migration: travelling sync_uuid on the art/audio tables,
// versioned-identity inheritance, partial uniqueness, seed_asset_hashes.
// Everything runs in ONE transaction that is always rolled back: migrate down,
// insert fixtures, migrate up, assert, rollback.
const DB_URL = process.env.TEST_DATABASE_URL;

function md5uuid(table, key) {
  const h = crypto.createHash('md5').update(`s2sync:${table}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function apply(client, mod, direction) {
  const pgm = new MigrationBuilder({ query: (...a) => client.query(...a) }, {}, false, { debug() {}, info() {}, warn() {}, error() {} });
  await mod[direction](pgm);
  for (const sql of pgm.getSqlSteps()) await client.query(sql);
}

const HAS_COL = `SELECT 1 FROM information_schema.columns WHERE table_name = 'audio_clips' AND column_name = 'sync_uuid'`;

async function inTx(t, body) {
  if (!DB_URL) { t.skip('TEST_DATABASE_URL not set'); return; }
  const mod = require('../migrations/1714440800000_seed_sync_plan3.js');
  const pool = new Pool({ connectionString: DB_URL, max: 2, connectionTimeoutMillis: 3000 });
  t.after(async () => { await pool.end().catch(() => {}); });
  await withSeedSyncLock(pool, async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout = '10s'");
      if ((await c.query(HAS_COL)).rowCount > 0) await apply(c, mod, 'down');
      await body(c, mod);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  });
}

test('plan3 migration backfills deterministic identities and versioned inheritance', async (t) => {
  await inTx(t, async (c, mod) => {
    const tag = `sx_p3_${process.pid}`;
    const ent = (await c.query(`INSERT INTO entity_types (name, color, is_creature) VALUES ($1, '#123456', false) RETURNING id`, [tag])).rows[0].id;
    await c.query(`INSERT INTO catalog_art (subject_kind, subject_key, image) VALUES ('item', $1, 'a.png')`, [tag]);
    await c.query(`INSERT INTO character_appearances (entity_type_id, variant, label) VALUES ($1, 3, 'x')`, [ent]);
    const clip = (await c.query(`INSERT INTO audio_clips (kind, label, storage_key, bytes, duration_ms, source)
      VALUES ('ambience', 'x', $1, 1, 1, 'uploaded') RETURNING id`, [`audio/${tag}.ogg`])).rows[0].id;
    await c.query(`INSERT INTO audio_bindings (subject_kind, subject_key, slot, clip_id) VALUES ('world', $1, 'music', $2)`, [tag, clip]);
    await c.query(`INSERT INTO art_prompt_notes (subject_kind, subject_key, kind, note, active) VALUES
      ('item', $1, 'reshape', 'n1', true), ('item', $1, 'reshape', 'dup', false), ('item', $1, 'reshape', 'dup', false)`, [tag]);
    await c.query(`INSERT INTO art_prompt_descriptions (subject_kind, subject_key, text, active) VALUES ('item', $1, 'old', false), ('item', $1, 'cur', true)`, [tag]);
    await c.query(`INSERT INTO audio_prompts (subject_kind, subject_key, slot, text) VALUES ('world', $1, 'music', 'v1')`, [tag]);

    await apply(c, mod, 'up');

    const one = async (sql, p = [tag]) => (await c.query(sql, p)).rows;
    assert.strictEqual((await one('SELECT sync_uuid FROM catalog_art WHERE subject_key = $1'))[0].sync_uuid,
      md5uuid('catalog_art', `item|${tag}`));
    assert.strictEqual((await one('SELECT sync_uuid FROM character_appearances WHERE entity_type_id = $1', [ent]))[0].sync_uuid,
      md5uuid('character_appearances', `${tag}|3`));
    assert.strictEqual((await one('SELECT sync_uuid, id FROM audio_clips WHERE id = $1', [clip]))[0].sync_uuid, clip);
    assert.strictEqual((await one('SELECT sync_uuid FROM audio_bindings WHERE subject_key = $1'))[0].sync_uuid,
      md5uuid('audio_bindings', `world|${tag}|music|${clip}`));
    const notes = await one('SELECT sync_uuid, note, id, active FROM art_prompt_notes WHERE subject_key = $1 ORDER BY id');
    assert.strictEqual(notes[0].sync_uuid, md5uuid('art_prompt_notes', `item|${tag}|reshape|n1`));
    assert.strictEqual(notes[1].sync_uuid, md5uuid('art_prompt_notes', `item|${tag}|reshape|dup|${notes[1].id}`));
    assert.notStrictEqual(notes[1].sync_uuid, notes[2].sync_uuid, 'inactive duplicates do not collide');
    const descs = await one('SELECT sync_uuid FROM art_prompt_descriptions WHERE subject_key = $1');
    assert.deepStrictEqual(descs.map((r) => r.sync_uuid), Array(2).fill(md5uuid('art_prompt_descriptions', `item|${tag}`)));
    const ap = await one('SELECT sync_uuid FROM audio_prompts WHERE subject_key = $1');
    assert.strictEqual(ap[0].sync_uuid, md5uuid('audio_prompts', `world|${tag}|music`));

    // audioPrompts.save: deactivate old, then insert the new version.
    await c.query('UPDATE audio_prompts SET active = false WHERE subject_key = $1', [tag]);
    await c.query(`INSERT INTO audio_prompts (subject_kind, subject_key, slot, text) VALUES ('world', $1, 'music', 'v2')`, [tag]);
    const v = await one('SELECT sync_uuid, active FROM audio_prompts WHERE subject_key = $1 ORDER BY id');
    assert.strictEqual(v[1].sync_uuid, v[0].sync_uuid, 'new version inherits the old identity');
    assert.strictEqual(v[1].active, true);
    // A brand-new subject falls back to the md5 formula.
    await c.query(`INSERT INTO art_prompt_descriptions (subject_kind, subject_key, text) VALUES ('item', $1, 't')`, [`${tag}_b`]);
    assert.strictEqual((await one('SELECT sync_uuid FROM art_prompt_descriptions WHERE subject_key = $1', [`${tag}_b`]))[0].sync_uuid,
      md5uuid('art_prompt_descriptions', `item|${tag}_b`));

    // Two active rows with one sync_uuid -> 23505 (savepoint keeps the txn alive).
    await c.query('SAVEPOINT s');
    await assert.rejects(
      c.query(`INSERT INTO audio_prompts (subject_kind, subject_key, slot, text, sync_uuid)
        SELECT 'world', $1 || '_z', 'music', 'z', sync_uuid FROM audio_prompts WHERE subject_key = $1 AND active`, [tag]),
      (e) => e.code === '23505');
    await c.query('ROLLBACK TO s');

    // New rows elsewhere default to a random uuid.
    const fresh = (await c.query(`INSERT INTO catalog_art (subject_kind, subject_key, image) VALUES ('item', $1, 'b.png') RETURNING sync_uuid`, [`${tag}_c`])).rows[0].sync_uuid;
    assert.match(fresh, /^[0-9a-f-]{36}$/);

    // seed_asset_hashes
    await c.query(`INSERT INTO seed_asset_hashes (object_key, sha256, file, bytes) VALUES ('k', 'h', 'f', 1)`);
    assert.strictEqual((await c.query('SELECT created_at FROM seed_asset_hashes')).rows.length, 1);

    // Down drops everything it added.
    await apply(c, mod, 'down');
    const left = await c.query(`SELECT 1 FROM information_schema.columns WHERE column_name = 'sync_uuid'
      AND table_name IN ('catalog_art','character_appearances','audio_clips','audio_bindings','art_prompt_notes','art_prompt_descriptions','audio_prompts')`);
    assert.strictEqual(left.rowCount, 0);
    assert.strictEqual((await c.query(`SELECT to_regclass('seed_asset_hashes') AS r`)).rows[0].r, null);
    assert.strictEqual((await c.query(`SELECT 1 FROM pg_proc WHERE proname LIKE '%_sync_uuid_fill'`)).rowCount, 0);
  });
});

test('plan3 pre-check lists active duplicate notes and deletes nothing', async (t) => {
  await inTx(t, async (c, mod) => {
    const tag = `sx_p3d_${process.pid}`;
    await c.query(`INSERT INTO art_prompt_notes (subject_kind, subject_key, kind, note) VALUES ('item', $1, 'reshape', 'same'), ('item', $1, 'reshape', 'same')`, [tag]);
    await assert.rejects(apply(c, mod, 'up'), /seed_sync_plan3.*art_prompt_notes/s);
  });
});
