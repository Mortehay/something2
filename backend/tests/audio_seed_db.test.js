// backend/tests/audio_seed_db.test.js
// Real scratch DB, an in-memory object store (Map key -> Buffer) passed
// directly to exportAudio/seedAudio as the injectable `store` -- these
// functions never touch the real assetStore module, so there is nothing to
// mock at that layer (unlike audioLibrary's storeClip, which always writes
// through the real one). Cleans up only what it created.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { Pool } = require('pg');
const { safeName } = require('../src/services/artSeed.js');
const {
  AUDIO_SEEDS_ROOT, AUDIO_KINDS, exportAudio, seedAudio, parseArgs,
} = require('../src/services/audioSeed.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

function memStore(objects = new Map()) {
  const puts = [];
  return {
    objects,
    puts,
    async getObjectStream(key) {
      if (!objects.has(key)) throw new Error(`The specified key does not exist: ${key}`);
      return Readable.from([objects.get(key)]);
    },
    async putObject(key, buffer) { puts.push({ key, bytes: buffer.length }); objects.set(key, buffer); return key; },
    async objectExists(key) { return objects.has(key); },
  };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audio-seed-'));
}

test('AUDIO_SEEDS_ROOT points at backend/seeds/audio', () => {
  assert.match(AUDIO_SEEDS_ROOT, /backend[/\\]seeds[/\\]audio$/);
  assert.deepStrictEqual(AUDIO_KINDS, ['music', 'ambience', 'sfx']);
});

test('parseArgs reads the flags the Makefile passes, and rejects an unknown kind', () => {
  const d = parseArgs([]);
  assert.deepStrictEqual(d.kinds, ['music', 'ambience', 'sfx']);
  assert.strictEqual(d.only, null);
  assert.strictEqual(d.force, false);

  const a = parseArgs(['--kind=music,sfx', '--only=w1, b1', '--force']);
  assert.deepStrictEqual(a.kinds, ['music', 'sfx']);
  assert.deepStrictEqual(a.only, ['w1', 'b1']);
  assert.strictEqual(a.force, true);

  assert.throws(() => parseArgs(['--kind=drums']), /unknown kind/);
});

test('audio export/seed round trip', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `${process.pid}-${Date.now()}`;
  const worldName = `audio-seed-world-${tag}`;
  const biomeName = `audio-seed-biome-${tag}`;
  const clipIds = [];
  let worldId = null;
  const root = tmpRoot();
  const OGG = Buffer.from(`OggS-fake-clip-bytes-${tag}`);

  t.after(async () => {
    try {
      if (clipIds.length) await pool.query('DELETE FROM audio_clips WHERE id = ANY($1)', [clipIds]);
      if (worldId) await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]).catch(() => {});
      await pool.query('DELETE FROM biomes WHERE name = $1', [biomeName]);
    } finally {
      await pool.end();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await pool.query('INSERT INTO biomes (name) VALUES ($1)', [biomeName]);
  worldId = (await pool.query(
    'INSERT INTO worlds (name, seed, biomes) VALUES ($1, 1, $2::jsonb) RETURNING id',
    [worldName, JSON.stringify([biomeName])],
  )).rows[0].id;

  async function insertClip({ kind, label, storageKey }) {
    const r = await pool.query(
      `INSERT INTO audio_clips (kind, label, storage_key, bytes, duration_ms, loopable, source)
       VALUES ($1,$2,$3,$4,$5,$6,'uploaded') RETURNING id`,
      [kind, label, storageKey, OGG.length, 1000, kind !== 'sfx'],
    );
    const id = r.rows[0].id;
    clipIds.push(id);
    return id;
  }

  const worldLabel = `World Theme ${tag}`;
  const biomeLabel = `Biome Amb ${tag}`;
  const worldClipKey = `audio/music/rmt_${tag}_world.ogg`;
  const biomeClipKey = `audio/ambience/rmt_${tag}_biome.ogg`;
  const unboundClipKey = `audio/sfx/rmt_${tag}_unbound.ogg`;

  const worldClipId = await insertClip({ kind: 'music', label: worldLabel, storageKey: worldClipKey });
  const biomeClipId = await insertClip({ kind: 'ambience', label: biomeLabel, storageKey: biomeClipKey });
  await insertClip({ kind: 'sfx', label: `Unbound ${tag}`, storageKey: unboundClipKey });

  await pool.query(
    "INSERT INTO audio_bindings (subject_kind, subject_key, slot, clip_id) VALUES ('world', $1, 'music', $2)",
    [worldName, worldClipId],
  );
  await pool.query(
    "INSERT INTO audio_bindings (subject_kind, subject_key, slot, clip_id) VALUES ('biome', $1, 'ambience', $2)",
    [biomeName, biomeClipId],
  );

  const store = memStore(new Map([
    [worldClipKey, OGG],
    [biomeClipKey, OGG],
    [unboundClipKey, OGG],
  ]));

  let worldFile;
  let biomeFile;

  await t.test('exportAudio writes only bound clips, correctly named, with sorted manifests', async () => {
    const results = await exportAudio({
      db: pool, store, root, log: () => {},
    });
    assert.strictEqual(results.music.exported, 1);
    assert.strictEqual(results.ambience.exported, 1);
    assert.strictEqual(results.sfx.exported, 0);

    const clips = JSON.parse(fs.readFileSync(path.join(root, 'clips.json'), 'utf8'));
    assert.strictEqual(clips.length, 2);
    const sortedIds = clips.map((c) => c.id).slice().sort((a, b) => a.localeCompare(b));
    assert.deepStrictEqual(clips.map((c) => c.id), sortedIds, 'clips.json sorted by id');

    const byId = Object.fromEntries(clips.map((c) => [c.id, c]));
    worldFile = byId[worldClipId].file;
    biomeFile = byId[biomeClipId].file;
    assert.strictEqual(worldFile, `music/${safeName(worldLabel)}-${worldClipId.slice(0, 8)}.ogg`);
    assert.strictEqual(biomeFile, `ambience/${safeName(biomeLabel)}-${biomeClipId.slice(0, 8)}.ogg`);
    assert.ok(fs.existsSync(path.join(root, worldFile)));
    assert.ok(fs.existsSync(path.join(root, biomeFile)));
    assert.ok(!clips.some((c) => c.label.startsWith('Unbound')), 'the unbound clip is absent');

    const bindings = JSON.parse(fs.readFileSync(path.join(root, 'bindings.json'), 'utf8'));
    assert.strictEqual(bindings.length, 2);
    const keyOf = (b) => `${b.subject_kind}\u0000${b.subject_key}\u0000${b.slot}\u0000${b.clip_id}`;
    const sortedKeys = bindings.map(keyOf).slice().sort((a, b) => a.localeCompare(b));
    assert.deepStrictEqual(bindings.map(keyOf), sortedKeys, 'bindings.json sorted by (subject_kind, subject_key, slot, clip_id)');
    assert.deepStrictEqual(
      bindings.map((b) => [b.subject_kind, b.subject_key]).sort(),
      [['biome', biomeName], ['world', worldName]].sort(),
    );
  });

  await t.test('deleting the clip/binding rows and the world simulates a fresh DB', async () => {
    await pool.query('DELETE FROM audio_clips WHERE id = ANY($1)', [[worldClipId, biomeClipId]]);
    await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
    worldId = null; // already gone -- t.after must not try again
  });

  await t.test('seedAudio recreates both clips, binds only the biome, and flags the missing world', async () => {
    const r = await seedAudio({
      db: pool, store, root, log: () => {},
    });
    assert.strictEqual(r.clips.linked, 2);
    assert.strictEqual(r.clips.skipped, 0);
    assert.strictEqual(r.clips.missingFile, 0);
    assert.strictEqual(r.bindings.bound, 1);
    assert.strictEqual(r.bindings.missingSubject.length, 1);
    assert.ok(r.bindings.missingSubject[0].includes(worldName));

    assert.ok(store.puts.some((p) => p.key === `audio/music/${worldClipId}.ogg`));
    assert.ok(store.puts.some((p) => p.key === `audio/ambience/${biomeClipId}.ogg`));

    const rows = await pool.query(
      'SELECT id, source FROM audio_clips WHERE id = ANY($1) ORDER BY id', [[worldClipId, biomeClipId]],
    );
    assert.strictEqual(rows.rowCount, 2);
    assert.ok(rows.rows.every((row) => row.source === 'seeded'));

    const boundSubjects = await pool.query(
      'SELECT subject_kind FROM audio_bindings WHERE clip_id = ANY($1)', [[worldClipId, biomeClipId]],
    );
    assert.deepStrictEqual(boundSubjects.rows.map((x) => x.subject_kind), ['biome']);
  });

  await t.test('re-running seedAudio without force skips everything already there', async () => {
    const r = await seedAudio({
      db: pool, store, root, log: () => {},
    });
    assert.strictEqual(r.clips.linked, 0);
    assert.strictEqual(r.clips.skipped, 2);
    assert.strictEqual(r.bindings.bound, 0);
  });

  await t.test('force re-links both clips even though the rows already exist', async () => {
    const r = await seedAudio({
      db: pool, store, root, force: true, log: () => {},
    });
    assert.strictEqual(r.clips.linked, 2);
    assert.strictEqual(r.clips.skipped, 0);
  });

  await t.test('a missing on-disk file is reported, not thrown', async () => {
    fs.rmSync(path.join(root, worldFile));
    const r = await seedAudio({
      db: pool, store, root, force: true, log: () => {},
    });
    assert.strictEqual(r.clips.missingFile, 1);
    assert.strictEqual(r.clips.linked, 1);
    // the biome clip's row is untouched and still resolvable for bindings
    assert.strictEqual(r.bindings.bound, 0); // already bound from the earlier run
    assert.strictEqual(r.bindings.missingSubject.length, 1);
  });
});

// SOMET-591 review fix round 1, I-1: `make audio-export KIND=music` is a
// documented usage. Before the fix, clips.json/bindings.json hold every
// kind, but the merge-vs-truncate branch only fired for `only` -- a
// kind-scoped export with no `only` overwrote both files with just that
// kind's rows, silently deleting every other kind's entries (and the next
// `audio-seed` would then skip re-linking them, since they were simply gone).
test('exportAudio: KIND without ONLY merges, and never truncates, the other kinds already in the manifest', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `${process.pid}-${Date.now()}-i1`;
  const worldName = `audio-seed-i1-world-${tag}`;
  const biomeName = `audio-seed-i1-biome-${tag}`;
  const clipIds = [];
  let worldId = null;
  const root = tmpRoot();
  const OGG = Buffer.from(`OggS-i1-${tag}`);

  t.after(async () => {
    try {
      if (clipIds.length) await pool.query('DELETE FROM audio_clips WHERE id = ANY($1)', [clipIds]);
      if (worldId) await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]).catch(() => {});
      await pool.query('DELETE FROM biomes WHERE name = $1', [biomeName]);
    } finally {
      await pool.end();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await pool.query('INSERT INTO biomes (name) VALUES ($1)', [biomeName]);
  worldId = (await pool.query(
    'INSERT INTO worlds (name, seed, biomes) VALUES ($1, 1, $2::jsonb) RETURNING id',
    [worldName, JSON.stringify([biomeName])],
  )).rows[0].id;

  async function insertClip({ kind, label, storageKey }) {
    const r = await pool.query(
      `INSERT INTO audio_clips (kind, label, storage_key, bytes, duration_ms, loopable, source)
       VALUES ($1,$2,$3,$4,$5,$6,'uploaded') RETURNING id`,
      [kind, label, storageKey, OGG.length, 1000, kind !== 'sfx'],
    );
    const id = r.rows[0].id;
    clipIds.push(id);
    return id;
  }

  const musicKey = `audio/music/rmt_${tag}_music.ogg`;
  const ambienceKey = `audio/ambience/rmt_${tag}_ambience.ogg`;
  const musicClipId = await insertClip({ kind: 'music', label: `I1 Music ${tag}`, storageKey: musicKey });
  const ambienceClipId = await insertClip({ kind: 'ambience', label: `I1 Ambience ${tag}`, storageKey: ambienceKey });

  await pool.query(
    "INSERT INTO audio_bindings (subject_kind, subject_key, slot, clip_id) VALUES ('world', $1, 'music', $2)",
    [worldName, musicClipId],
  );
  await pool.query(
    "INSERT INTO audio_bindings (subject_kind, subject_key, slot, clip_id) VALUES ('biome', $1, 'ambience', $2)",
    [biomeName, ambienceClipId],
  );

  const store = memStore(new Map([[musicKey, OGG], [ambienceKey, OGG]]));

  await exportAudio({
    db: pool, store, root, log: () => {},
  });
  const clipsAfterFull = JSON.parse(fs.readFileSync(path.join(root, 'clips.json'), 'utf8'));
  assert.strictEqual(clipsAfterFull.length, 2, 'both kinds present after the first full export');

  await exportAudio({
    db: pool, store, root, kinds: ['music'], log: () => {},
  });

  const clips = JSON.parse(fs.readFileSync(path.join(root, 'clips.json'), 'utf8'));
  const bindings = JSON.parse(fs.readFileSync(path.join(root, 'bindings.json'), 'utf8'));
  assert.ok(clips.some((c) => c.id === ambienceClipId), 'ambience clip entry survives a music-only export');
  assert.ok(clips.some((c) => c.id === musicClipId), 'music clip entry is still there, freshly re-exported');
  assert.ok(
    bindings.some((b) => b.clip_id === ambienceClipId && b.subject_key === biomeName),
    'ambience binding entry survives a music-only export',
  );
  assert.ok(bindings.some((b) => b.clip_id === musicClipId && b.subject_key === worldName));
});

// SOMET-591 review fix round 1, I-2: an `--only=X` export has seen every
// CURRENT binding of X, so a binding the admin removed since the last export
// must be dropped from the merge, not left to be silently recreated by the
// next `audio-seed`. A clip left with zero bindings afterward is pruned from
// clips.json too; a clip still bound to some OTHER, untouched subject is not.
test('exportAudio: --only drops a subject\'s removed binding and prunes the now-orphaned clip', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `${process.pid}-${Date.now()}-i2`;
  const worldName = `audio-seed-i2-world-${tag}`;
  const biomeName = `audio-seed-i2-biome-${tag}`;
  const clipIds = [];
  let worldId = null;
  const root = tmpRoot();
  const OGG = Buffer.from(`OggS-i2-${tag}`);

  t.after(async () => {
    try {
      if (clipIds.length) await pool.query('DELETE FROM audio_clips WHERE id = ANY($1)', [clipIds]);
      if (worldId) await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]).catch(() => {});
      await pool.query('DELETE FROM biomes WHERE name = $1', [biomeName]);
    } finally {
      await pool.end();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await pool.query('INSERT INTO biomes (name) VALUES ($1)', [biomeName]);
  worldId = (await pool.query(
    'INSERT INTO worlds (name, seed, biomes) VALUES ($1, 1, $2::jsonb) RETURNING id',
    [worldName, JSON.stringify([biomeName])],
  )).rows[0].id;

  async function insertClip({ kind, label, storageKey }) {
    const r = await pool.query(
      `INSERT INTO audio_clips (kind, label, storage_key, bytes, duration_ms, loopable, source)
       VALUES ($1,$2,$3,$4,$5,$6,'uploaded') RETURNING id`,
      [kind, label, storageKey, OGG.length, 1000, kind !== 'sfx'],
    );
    const id = r.rows[0].id;
    clipIds.push(id);
    return id;
  }

  const dKey = `audio/music/rmt_${tag}_d.ogg`;
  const eKey = `audio/ambience/rmt_${tag}_e.ogg`;
  // D is bound ONLY to the world (X in the finding); E is bound only to the
  // biome, which this run's `only` never names, so E must be left alone.
  const clipDId = await insertClip({ kind: 'music', label: `I2 D ${tag}`, storageKey: dKey });
  const clipEId = await insertClip({ kind: 'ambience', label: `I2 E ${tag}`, storageKey: eKey });

  await pool.query(
    "INSERT INTO audio_bindings (subject_kind, subject_key, slot, clip_id) VALUES ('world', $1, 'music', $2)",
    [worldName, clipDId],
  );
  await pool.query(
    "INSERT INTO audio_bindings (subject_kind, subject_key, slot, clip_id) VALUES ('biome', $1, 'ambience', $2)",
    [biomeName, clipEId],
  );

  const store = memStore(new Map([[dKey, OGG], [eKey, OGG]]));

  await exportAudio({
    db: pool, store, root, log: () => {},
  });
  const clipsAfterFull = JSON.parse(fs.readFileSync(path.join(root, 'clips.json'), 'utf8'));
  assert.strictEqual(clipsAfterFull.length, 2, 'both D and E present after the first full export');

  // The admin unbinds D from the world in the DB -- D now has zero bindings.
  await pool.query(
    "DELETE FROM audio_bindings WHERE subject_kind = 'world' AND subject_key = $1 AND clip_id = $2",
    [worldName, clipDId],
  );

  await exportAudio({
    db: pool, store, root, only: [worldName], log: () => {},
  });

  const clips = JSON.parse(fs.readFileSync(path.join(root, 'clips.json'), 'utf8'));
  const bindings = JSON.parse(fs.readFileSync(path.join(root, 'bindings.json'), 'utf8'));
  assert.ok(
    !bindings.some((b) => b.subject_key === worldName && b.clip_id === clipDId),
    'the removed world -> D binding is gone from bindings.json',
  );
  assert.ok(!clips.some((c) => c.id === clipDId), 'D is pruned from clips.json -- nothing binds it any more');
  assert.ok(clips.some((c) => c.id === clipEId), 'E is untouched: only names the world, not the biome');
  assert.ok(
    bindings.some((b) => b.clip_id === clipEId && b.subject_key === biomeName),
    'E\'s binding to the (untouched) biome survives',
  );
});
