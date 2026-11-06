// SOMET-722. The Seed/Export tab commits .ogg files and seeds/sync/audio.json, and does not touch the legacy
// clips.json / bindings.json / prompts.json. Reading those alone left 2,258 of 7,202 sounds off the Orange Pi
// while the seed said "0 missing files". Real scratch DB, in-memory object store.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { withAdvisoryLock, AUDIO_CLIPS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const { seedAudio, planAudio } = require('../src/services/audioSeed.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

function memStore(objects = new Map()) {
  return {
    objects,
    async putObject(key, buffer) { objects.set(key, buffer); return key; },
    async objectExists(key) { return objects.has(key); },
    async listObjectKeys() { return [...objects.keys()]; },
  };
}

function clipFields(id, label) {
  return {
    kind: 'sfx', label, bytes: 5, duration_ms: 100, loopable: false, loop_start_ms: null, loop_end_ms: null,
    prompt: `prompt ${label}`, style_or_cue: 'hit', engine: 'realistic', seed: 7,
    provider_id: null, source: 'generated', sha1: 'a'.repeat(40), sync_uuid: id,
  };
}

// A manifest clip (A) that is also in the sync file, a clip only the sync file names (B), and an .ogg nothing names.
async function withFixture(body) {
  const pool = new Pool({ connectionString: url });
  const tag = `${process.pid}-${Date.now()}`;
  const worldName = `audio-sync-world-${tag}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-sync-'));
  const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
  const aFile = `sfx/a-${a.slice(0, 8)}.ogg`;
  const bFile = `sfx/b-${b.slice(0, 8)}.ogg`;
  fs.mkdirSync(path.join(root, 'sfx'), { recursive: true });
  fs.writeFileSync(path.join(root, aFile), 'aaaaa');
  fs.writeFileSync(path.join(root, bFile), 'bbbbb');

  const worldId = (await pool.query(
    "INSERT INTO worlds (name, seed, biomes) VALUES ($1, 1, '[]'::jsonb) RETURNING id", [worldName],
  )).rows[0].id;
  const binding = (clipId) => ({
    subject_kind: 'world', subject_key: worldName, slot: 'music', clip_id: clipId, volume: 1, weight: 1, sort: 0,
  });
  const promptOf = (slot, text) => ({
    subject_kind: 'world', subject_key: worldName, slot, style: null, text, source_input: null, hint: null, model: null, via: 'test',
  });
  fs.writeFileSync(path.join(root, 'clips.json'), JSON.stringify([{ id: a, file: aFile, ...clipFields(a, 'manifest label') }]));
  fs.writeFileSync(path.join(root, 'bindings.json'), JSON.stringify([binding(a)]));
  fs.writeFileSync(path.join(root, 'prompts.json'), JSON.stringify([promptOf('music', 'manifest prompt')]));
  const syncFile = path.join(root, 'audio.json');
  fs.writeFileSync(syncFile, JSON.stringify({
    header: {},
    tables: {
      audio_clips: [
        { ...clipFields(a, 'sync label for a'), storage_key: { file: `audio/${aFile}`, sha1: 'a'.repeat(40) } },
        { ...clipFields(b, 'sync only'), storage_key: { file: `audio/${bFile}`, sha1: 'a'.repeat(40) } },
      ],
      audio_bindings: [binding(a), binding(b)],
      audio_prompts: [promptOf('music', 'sync prompt'), promptOf('ambience', 'sync only prompt')],
    },
  }));
  try {
    await body({ pool, root, syncFile, a, b, worldName });
  } finally {
    await pool.query('DELETE FROM audio_prompts WHERE subject_key = $1', [worldName]);
    await pool.query('DELETE FROM audio_clips WHERE id = ANY($1)', [[a, b]]);
    await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
    fs.rmSync(root, { recursive: true, force: true });
    await pool.end();
  }
}

// Cleanup stays inside the lock: a t.after hook would run outside it, where another file's clips are in play.
function locked(body) {
  return async () => {
    const lockPool = new Pool({ connectionString: url });
    try {
      await withAdvisoryLock(lockPool, AUDIO_CLIPS_LOCK_KEY, () => withFixture(body));
    } finally {
      await lockPool.end();
    }
  };
}

test('seedAudio links a clip, binding and prompt only the sync file names; the manifest wins for one in both', { skip }, locked(async ({ pool, root, syncFile, a, b, worldName }) => {
  const store = memStore();
  const res = await seedAudio({ db: pool, store, root, syncFile, log: () => {} });
  assert.equal(res.clips.linked, 2);
  assert.equal(res.clips.missingFile, 0);
  assert.equal(res.bindings.bound, 2);

  const rows = (await pool.query('SELECT id, label, storage_key, sync_uuid FROM audio_clips WHERE id = ANY($1) ORDER BY label', [[a, b]])).rows;
  assert.deepEqual(rows.map((r) => r.label), ['manifest label', 'sync only']);
  assert.equal(rows[1].id, b, 'a clip keeps the id git gave it, so its binding resolves');
  assert.equal(rows[1].sync_uuid, b);
  assert.ok(store.objects.has(rows[1].storage_key), 'the sync-only clip has its bytes in the store');

  const prompts = (await pool.query(
    'SELECT slot, text FROM audio_prompts WHERE subject_key = $1 AND active ORDER BY slot', [worldName],
  )).rows;
  assert.deepEqual(prompts, [{ slot: 'ambience', text: 'sync only prompt' }, { slot: 'music', text: 'manifest prompt' }]);

  const again = await seedAudio({ db: pool, store, root, syncFile, log: () => {} });
  assert.equal(again.clips.linked, 0);
  assert.equal(again.clips.skipped, 2);
  assert.equal(again.bindings.bound, 0);
  const versions = await pool.query('SELECT count(*)::int AS n FROM audio_prompts WHERE subject_key = $1', [worldName]);
  assert.equal(versions.rows[0].n, 2, 'a re-seed piles up no prompt versions');
}));

test('seedAudio with no sync file still reads the manifests alone', { skip }, locked(async ({ pool, root, a }) => {
  const res = await seedAudio({ db: pool, store: memStore(), root, syncFile: path.join(root, 'none.json'), log: () => {} });
  assert.equal(res.clips.linked, 1);
  assert.equal((await pool.query('SELECT 1 FROM audio_clips WHERE id = $1', [a])).rowCount, 1);
}));

test('seedAudio counts a file on disk that no list names; "0 missing" can no longer hide it', { skip }, locked(async ({ pool, root, syncFile }) => {
  const logged = [];
  const clean = await seedAudio({ db: pool, store: memStore(), root, syncFile, log: () => {} });
  assert.equal(clean.clips.unlisted, 0);
  fs.writeFileSync(path.join(root, 'sfx', 'stray.ogg'), 'x');
  const res = await seedAudio({ db: pool, store: memStore(), root, syncFile, log: (l) => logged.push(l) });
  assert.equal(res.clips.unlisted, 1);
  assert.ok(logged.some((l) => /stray\.ogg/.test(l)), 'the file is named');
}));

test('planAudio counts exactly what seedAudio goes on to copy, and writes nothing', { skip }, locked(async ({ pool, root, syncFile, a, b }) => {
  const store = memStore();
  const opts = { db: pool, store, root, syncFile };

  assert.deepEqual(await planAudio(opts), { total: 2, pending: 2 });
  assert.equal(store.objects.size, 0, 'a plan uploads nothing');
  assert.equal((await pool.query('SELECT 1 FROM audio_clips WHERE id = ANY($1)', [[a, b]])).rowCount, 0, 'a plan inserts nothing');

  await seedAudio({ ...opts, log: () => {} });
  assert.deepEqual(await planAudio(opts), { total: 2, pending: 0 });

  // A row whose object is gone is copied again, so it counts.
  const { storage_key: key } = (await pool.query('SELECT storage_key FROM audio_clips WHERE id = $1', [b])).rows[0];
  store.objects.delete(key);
  assert.deepEqual(await planAudio(opts), { total: 2, pending: 1 });
  assert.equal((await seedAudio({ ...opts, log: () => {} })).clips.linked, 1);

  // A listed file that is not on disk cannot be copied: seedAudio reports it missing, so it is not pending.
  await pool.query('DELETE FROM audio_clips WHERE id = $1', [b]);
  for (const f of fs.readdirSync(path.join(root, 'sfx'))) if (f.startsWith('b-')) fs.rmSync(path.join(root, 'sfx', f));
  assert.deepEqual(await planAudio(opts), { total: 2, pending: 0 });
  assert.equal((await seedAudio({ ...opts, log: () => {} })).clips.missingFile, 1);
}));
