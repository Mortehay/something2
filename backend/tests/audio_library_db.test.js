// backend/tests/audio_library_db.test.js
// Real scratch DB, fake MinIO client. Cleans up only what it created.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const assetStore = require('../src/services/assetStore');
const lib = require('../src/services/audioLibrary');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;
const OGG = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.ogg'));

test('audio library', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const put = [];
  assetStore.__setAssetClient({
    bucketExists: async () => true,
    putObject: async (bucket, key, buf) => { put.push({ key, bytes: buf.length }); },
  });
  const tag = `${process.pid}-${Date.now()}`;
  const worldName = `audio-test-world-${tag}`;
  const biomeName = `audio-test-biome-${tag}`;
  const ghost = `audio-test-ghost-world-${tag}`;
  const clipIds = [];
  let worldId;
  t.after(async () => {
    try {
      if (clipIds.length) await pool.query('DELETE FROM audio_clips WHERE id = ANY($1)', [clipIds]);
      await pool.query('DELETE FROM audio_misses WHERE subject_key IN ($1, $2, $3)', [worldName, biomeName, ghost]);
      if (worldId) await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
      await pool.query('DELETE FROM biomes WHERE name = $1', [biomeName]);
    } finally { await pool.end(); }
  });
  await pool.query('INSERT INTO biomes (name) VALUES ($1)', [biomeName]);
  worldId = (await pool.query(
    `INSERT INTO worlds (name, seed, biomes) VALUES ($1, 1, $2::jsonb) RETURNING id`,
    [worldName, JSON.stringify([biomeName])])).rows[0].id;

  const store = async (kind) => {
    const c = await lib.storeClip(pool, { buffer: OGG, kind, label: `${kind} ${tag}`, source: 'uploaded', durationMs: 2000 });
    clipIds.push(c.id);
    return c;
  };

  await t.test('storeClip writes MinIO then a row', async () => {
    const c = await store('ambience');
    assert.equal(c.storage_key, `audio/ambience/${c.id}.ogg`);
    assert.ok(put.some((p) => p.key === c.storage_key && p.bytes === OGG.length));
  });

  await t.test('bindClip rejects unknown slots and kind mismatches', async () => {
    const music = await store('music');
    await assert.rejects(lib.bindClip(pool, { subjectKind: 'biome', subjectKey: biomeName, slot: 'music', clipId: music.id }), /slot/);
    await assert.rejects(lib.bindClip(pool, { subjectKind: 'world', subjectKey: worldName, slot: 'ambience', clipId: music.id }), /kind/);
    await assert.rejects(lib.bindClip(pool, { subjectKind: 'dragon', subjectKey: 'x', slot: 'roar', clipId: music.id }), /subject/);
  });

  await t.test('binding clears the matching miss; the bundle carries world + biome slots', async () => {
    assert.equal(await lib.recordMisses(pool, [
      { subject_kind: 'biome', subject_key: biomeName, slot: 'ambience', world: worldName },
      { subject_kind: 'biome', subject_key: biomeName, slot: 'ambience', world: worldName },
      { subject_kind: 'nonsense', subject_key: 'x', slot: 'y' },
    ]), 2, 'unknown subject kinds are dropped');
    const before = await pool.query('SELECT count FROM audio_misses WHERE subject_key = $1', [biomeName]);
    assert.equal(before.rows[0].count, 2);

    const amb = await store('ambience');
    const mus = await store('music');
    await lib.bindClip(pool, { subjectKind: 'biome', subjectKey: biomeName, slot: 'ambience', clipId: amb.id, volume: 0.5 });
    await lib.bindClip(pool, { subjectKind: 'world', subjectKey: worldName, slot: 'music', clipId: mus.id });
    const after = await pool.query('SELECT 1 FROM audio_misses WHERE subject_key = $1', [biomeName]);
    assert.equal(after.rowCount, 0, 'binding a slot clears its miss');

    const bundle = await lib.worldAudioBundle(pool, worldId);
    assert.equal(bundle.world, worldName);
    assert.equal(bundle.bindings[`biome/${biomeName}/ambience`][0].volume, 0.5);
    assert.equal(bundle.bindings[`world/${worldName}/music`][0].key, mus.storage_key);
    assert.equal(await lib.worldAudioBundle(pool, '00000000-0000-0000-0000-000000000000'), null);
  });

  await t.test('misses for subjects that do not exist, or prototype-key kinds, are dropped', async () => {
    assert.equal(await lib.recordMisses(pool, [
      { subject_kind: 'world', subject_key: ghost, slot: 'music', world: ghost },
      { subject_kind: '__proto__', subject_key: 'x', slot: 'constructor' },
      { subject_kind: 'constructor', subject_key: 'x', slot: 'music' },
      { subject_kind: 'world', subject_key: worldName, slot: 'ambience', world: worldName },
    ]), 1, 'only the miss for the real world is kept');
    const junk = await pool.query(
      "SELECT 1 FROM audio_misses WHERE subject_key = $1 OR subject_kind IN ('__proto__', 'constructor')", [ghost]);
    assert.equal(junk.rowCount, 0, 'no row for an unknown subject');
    const real = await pool.query(
      "SELECT count FROM audio_misses WHERE subject_kind = 'world' AND subject_key = $1 AND slot = 'ambience'", [worldName]);
    assert.equal(real.rows[0].count, 1);
  });

  await t.test('bindClip on a checked-out client runs inside the caller\'s own transaction', async () => {
    const mus = await store('music');
    const client = await pool.connect();
    let bindingId;
    try {
      await client.query('BEGIN');
      const binding = await lib.bindClip(client, { subjectKind: 'world', subjectKey: worldName, slot: 'music', clipId: mus.id });
      bindingId = binding.id;
      const visible = await client.query('SELECT 1 FROM audio_bindings WHERE id = $1', [bindingId]);
      assert.equal(visible.rowCount, 1, 'binding is visible on the same client before commit');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const afterRollback = await pool.query('SELECT 1 FROM audio_bindings WHERE id = $1', [bindingId]);
    assert.equal(afterRollback.rowCount, 0, 'rolled-back binding never committed -- bindClip did not run its own transaction');
  });
});
