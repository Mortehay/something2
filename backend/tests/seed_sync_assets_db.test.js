const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { Pool } = require('pg');
const { withSeedSyncLock, cleanupSx, makeTempSyncDir } = require('./helpers/seedSyncTest.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

const { _withTestGroups } = require('../src/services/seedSync/registry.js');
const { exportGroup, fileFor } = require('../src/services/seedSync/exportGroup.js');
const { diffGroup } = require('../src/services/seedSync/diffGroup.js');
const { previewSeed, applySeed } = require('../src/services/seedSync/applySeed.js');
const { stableStringify } = require('../src/services/seedSync/canonical.js');
const { assetsRoot, localAssetValue, uploadGitAssets, _hashedFiles } = require('../src/services/seedSync/assets.js');
const { shrinkToEdge } = require('../src/services/pngResample.js');
const { encodeRGBA } = require('../src/services/pngTrim.js');

// SOMET-640 plan 3 Task 3: asset columns. A local object key travels as
// { file, sha256 } (repo file + content hash); the per-PC cache
// seed_asset_hashes translates between the two. Throwaway tables live in their
// own schema (see seed_sync_spec_features_db.test.js for why).
const SCHEMA = 'sx_asset';
const ART = 'art group (plan 3)';
const BUCKET = 'sxb';

const artSpec = {
  table: 'sx_art', naturalKey: ['name'], omit: { id: 'local', sync_uuid: 'identity' }, secretColumns: [], refs: {},
  assets: {
    image: { type: 'image', dir: 'sx_tiles', maxEdge: (row) => (row.val === 99 ? 16 : null) },
    sprite: { type: 'sprite', dir: 'sx_sprites' },
  },
};
const clipSpec = {
  table: 'sx_clip', naturalKey: ['label'], omit: { id: 'local', sync_uuid: 'identity' }, secretColumns: [], refs: {},
  assets: { storage_key: { type: 'audio', dir: (row) => `audio/${row.kind}` } },
};
const ownSpec = {
  table: 'sx_own', naturalKey: ['name'], omit: { id: 'local', sync_uuid: 'identity', icon: ART }, secretColumns: [], refs: {},
};
const iconSlice = {
  table: 'sx_own', slice: true, columns: ['icon'], naturalKey: ['name'], secretColumns: [], refs: {},
  assets: { icon: { type: 'image', dir: 'sx_icons' } },
};
const GROUPS = [
  { id: 'sx_assets', label: 'SX assets', tables: [artSpec, clipSpec] },
  { id: 'sx_own', label: 'SX owner', tables: [ownSpec] },
  { id: 'sx_icons', label: 'SX icons', tables: [iconSlice] },
];

const SCHEMA_SQL = `
  DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
  CREATE SCHEMA ${SCHEMA};
  CREATE TABLE ${SCHEMA}.sx_art (
    id serial PRIMARY KEY, name text NOT NULL UNIQUE, val int, image text, sprite jsonb,
    sync_uuid uuid NOT NULL UNIQUE DEFAULT gen_random_uuid());
  CREATE TABLE ${SCHEMA}.sx_clip (
    id serial PRIMARY KEY, label text NOT NULL UNIQUE, kind text NOT NULL, storage_key text, sha1 text, bytes int,
    sync_uuid uuid NOT NULL UNIQUE DEFAULT gen_random_uuid());
  CREATE TABLE ${SCHEMA}.sx_own (
    id serial PRIMARY KEY, name text NOT NULL UNIQUE, val int, icon text,
    sync_uuid uuid NOT NULL UNIQUE DEFAULT gen_random_uuid());`;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

function png(w, h, rgba) {
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set(rgba, i * 4);
  return encodeRGBA(w, h, px);
}
const PNG_A = png(4, 4, [255, 0, 0, 255]);
const PNG_BIG = png(64, 32, [0, 0, 255, 255]);
const ATLAS = png(8, 4, [0, 255, 0, 255]);
const MANIFEST = Buffer.from('{"frames":2}\n');
const OGG = Buffer.from('OggS fake audio payload');
const ICON = png(2, 2, [9, 9, 9, 255]);
const SPRITE = { atlas_key: 'sx/a_atlas.png', manifest_key: 'sx/a_man.json', static_frame: 0, frames: { idle: 2 } };

// Fake object store (art_seed_policy.test.js pattern): counts downloads.
function fakeStore() {
  const objects = new Map([
    ['sx/a.png', PNG_A], ['sx/big.png', PNG_BIG], ['sx/a_atlas.png', ATLAS], ['sx/a_man.json', MANIFEST],
    ['sx/clip.ogg', OGG], ['sx/icon.png', ICON],
  ]);
  const store = {
    objects,
    gets: 0,
    puts: [],
    BUCKET: () => BUCKET,
    async ensureBucket() {},
    async getObjectStream(key) {
      store.gets += 1;
      if (!objects.has(key)) {
        const e = new Error(`The specified key does not exist: ${key}`);
        e.code = 'NoSuchKey';
        throw e;
      }
      return Readable.from([objects.get(key)]);
    },
    async putObject(key, buffer, contentType) {
      store.puts.push({ key, buffer, contentType });
      objects.set(key, buffer);
      return key;
    },
    async objectExists(key) { return objects.has(key); },
  };
  return store;
}

async function cleanupCache(pool) {
  await pool.query(`DELETE FROM seed_asset_hashes WHERE object_key LIKE 'sx%'`);
}

function dbTest(name, body) {
  test(name, async (t) => {
    if (!process.env.TEST_DATABASE_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (seed_sync assets)';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    const dir = makeTempSyncDir();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-assets-'));
    const prev = { dir: process.env.SEED_SYNC_DIR, root: process.env.SEED_ASSETS_ROOT };
    process.env.SEED_SYNC_DIR = dir;
    process.env.SEED_ASSETS_ROOT = root;
    const pool = new Pool({
      connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000, options: `-c search_path=${SCHEMA},public`,
    });
    const pub = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000 });
    t.after(async () => {
      for (const [k, v] of [['SEED_SYNC_DIR', prev.dir], ['SEED_ASSETS_ROOT', prev.root]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
      await pool.end().catch(() => {});
      await pub.end().catch(() => {});
    });
    await withSeedSyncLock(pub, async () => {
      await cleanupSx(pub);
      await cleanupCache(pub);
      await pub.query(SCHEMA_SQL);
      try {
        await _withTestGroups(GROUPS, () => body(t, pool, { root, store: fakeStore() }));
      } finally {
        await pub.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await cleanupCache(pub).catch(() => {});
        await cleanupSx(pub).catch(() => {});
      }
    });
  });
}

const one = async (pool, sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (pool, sql, params) => (await pool.query(sql, params)).rows;
const readDoc = (groupId) => JSON.parse(fs.readFileSync(fileFor(groupId), 'utf8'));
function writeDoc(groupId, doc) {
  for (const [tbl, rows] of Object.entries(doc.tables)) doc.header.row_counts[tbl] = rows.length;
  fs.writeFileSync(fileFor(groupId), `${stableStringify(doc)}\n`);
}
async function apply(pool, groupId, decisions, opts) {
  const { signature } = await previewSeed(pool, groupId);
  return applySeed(pool, groupId, decisions || {}, { signature, ...opts });
}
function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String)
    .filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort();
}

async function seedFixture(pool) {
  await pool.query(
    `INSERT INTO sx_art (name, val, image, sprite) VALUES
       ('sx_a', 1, 'sx/a.png', $1), ('sx_b', 99, 'sx/big.png', NULL), ('sx_c', 2, '', NULL)`,
    [JSON.stringify(SPRITE)]);
  return (await one(pool,
    `INSERT INTO sx_clip (label, kind, storage_key, sha1, bytes) VALUES ('sx_clip1', 'sfx', 'sx/clip.ogg', $1, $2)
     RETURNING sync_uuid`, [sha1(OGG), OGG.length])).sync_uuid;
}

// Local state of a PC that pulled the file but never had these rows.
// sx_art: its cache entries go too (sx_clip has none: audio is uncached).
async function forgetLocally(pool, table) {
  const uuids = (await all(pool, `SELECT sync_uuid FROM ${table}`)).map((r) => r.sync_uuid);
  await pool.query(`DELETE FROM ${table}`);
  await pool.query('DELETE FROM seed_row_hashes WHERE sync_uuid = ANY($1::uuid[])', [uuids]);
  if (table === 'sx_art') await pool.query(`DELETE FROM seed_asset_hashes WHERE object_key LIKE 'sx%'`);
}

dbTest('export writes asset files and translates keys to file+hash', async (t, pool, { root, store }) => {
  assert.strictEqual(assetsRoot(), root, 'SEED_ASSETS_ROOT read at call time');
  const clipUuid = await seedFixture(pool);
  const res = await exportGroup(pool, 'sx_assets', { store });
  assert.strictEqual(res.downloaded, 5, 'four art objects + one clip');
  assert.strictEqual(res.reused, 0);
  assert.strictEqual(res.orphanFiles, 0);

  const doc = readDoc('sx_assets');
  const art = Object.fromEntries(doc.tables.sx_art.map((r) => [r.name, r]));
  const shrunk = shrinkToEdge(PNG_BIG, 16).buffer;
  assert.notDeepStrictEqual(shrunk, PNG_BIG, 'fixture really shrinks');
  assert.deepStrictEqual(art.sx_a.image, { file: 'sx_tiles/sx_a.png', sha256: sha256(PNG_A) });
  assert.deepStrictEqual(art.sx_b.image, { file: 'sx_tiles/sx_b.png', sha256: sha256(shrunk) });
  assert.strictEqual(art.sx_c.image, '', 'empty travels unchanged');
  assert.strictEqual(art.sx_b.sprite, null, 'NULL travels unchanged');
  assert.deepStrictEqual(art.sx_a.sprite, {
    atlas: { file: 'sx_sprites/sx_a.atlas.png', sha256: sha256(ATLAS) },
    manifest: { file: 'sx_sprites/sx_a.manifest.json', sha256: sha256(MANIFEST) },
    static_frame: 0, frames: { idle: 2 },
  });
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'sx_tiles/sx_a.png')), PNG_A);
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'sx_tiles/sx_b.png')), shrunk);
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'sx_sprites/sx_a.atlas.png')), ATLAS);
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'sx_sprites/sx_a.manifest.json')), MANIFEST);

  const clipFile = `audio/sfx/sx_clip1-${clipUuid.slice(0, 8)}.ogg`;
  assert.deepStrictEqual(doc.tables.sx_clip[0].storage_key, { file: clipFile, sha1: sha1(OGG) });
  assert.deepStrictEqual(fs.readFileSync(path.join(root, clipFile)), OGG);

  const cache = await all(pool, `SELECT object_key, sha256, file, bytes FROM seed_asset_hashes
                                  WHERE object_key LIKE 'sx/%' ORDER BY object_key`);
  assert.deepStrictEqual(cache, [
    { object_key: 'sx/a.png', sha256: sha256(PNG_A), file: 'sx_tiles/sx_a.png', bytes: PNG_A.length },
    { object_key: 'sx/a_atlas.png', sha256: sha256(ATLAS), file: 'sx_sprites/sx_a.atlas.png', bytes: ATLAS.length },
    { object_key: 'sx/a_man.json', sha256: sha256(MANIFEST), file: 'sx_sprites/sx_a.manifest.json', bytes: MANIFEST.length },
    { object_key: 'sx/big.png', sha256: sha256(shrunk), file: 'sx_tiles/sx_b.png', bytes: shrunk.length },
  ]);
  assert.strictEqual((await diffGroup(pool, 'sx_assets')).status, 'in_sync', 'baseline == local hash');
  assert.deepStrictEqual(filesUnder(root).filter((f) => f.endsWith('.tmp')), []);
});

dbTest('re-export reuses cached files without downloading', async (t, pool, { root, store }) => {
  await seedFixture(pool);
  await exportGroup(pool, 'sx_assets', { store });
  const gets = store.gets;
  fs.writeFileSync(path.join(root, 'sx_tiles', 'stray.png'), 'x');
  const res = await exportGroup(pool, 'sx_assets', { store });
  assert.strictEqual(store.gets, gets, 'no getObjectStream on the second export');
  assert.strictEqual(res.downloaded, 0);
  assert.strictEqual(res.reused, 5);
  assert.strictEqual(res.orphanFiles, 1, 'stray file counted, not deleted');
  assert.ok(fs.existsSync(path.join(root, 'sx_tiles', 'stray.png')));

  // An altered file on disk is re-downloaded to its recorded path.
  fs.writeFileSync(path.join(root, 'sx_tiles', 'sx_a.png'), 'tampered');
  const res2 = await exportGroup(pool, 'sx_assets', { store });
  assert.strictEqual(res2.downloaded, 1);
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'sx_tiles/sx_a.png')), PNG_A);
});

dbTest('colliding file names get a hash suffix; a cached key keeps its path', async (t, pool, { store }) => {
  // safeName('sx a') === safeName('sx_a') === 'sx_a'.
  store.objects.set('sx/a2.png', ICON);
  await pool.query(`INSERT INTO sx_art (name, val, image) VALUES ('sx_a', 1, 'sx/a.png'), ('sx a', 2, 'sx/a2.png')`);
  await exportGroup(pool, 'sx_assets', { store });
  const art = Object.fromEntries(readDoc('sx_assets').tables.sx_art.map((r) => [r.name, r.image.file]));
  // 'sx a' sorts first and takes the plain name.
  assert.strictEqual(art['sx a'], 'sx_tiles/sx_a.png');
  assert.strictEqual(art.sx_a, `sx_tiles/sx_a-${sha256(PNG_A).slice(0, 8)}.png`);
});

dbTest('uncached local key reads as edited here', async (t, pool, { store }) => {
  await seedFixture(pool);
  await exportGroup(pool, 'sx_assets', { store });
  // Another PC: same rows and keys, but no cache and no baselines.
  await pool.query(`DELETE FROM seed_asset_hashes WHERE object_key LIKE 'sx%'`);
  await pool.query(`DELETE FROM seed_row_hashes WHERE group_id = 'sx_assets'`);
  const d = await diffGroup(pool, 'sx_assets');
  const a = d.rows.find((r) => r.key === 'sx_a');
  assert.strictEqual(a.kind, 'edited_here');
  const f = a.fields.find((x) => x.name === 'image');
  assert.deepStrictEqual(f.local, { unhashed: 'sx/a.png' });
  assert.deepStrictEqual(f.git, { file: 'sx_tiles/sx_a.png', sha256: sha256(PNG_A) });
  assert.ok(!d.rows.some((r) => r.key === 'sx_c'), 'a row without asset keys stays in sync');
  // localAssetValue is pure: with a cache entry the same key translates.
  assert.deepStrictEqual(
    localAssetValue(artSpec, 'image', { image: 'sx/a.png' }, new Map([['sx/a.png', { sha256: 'h', file: 'f', bytes: 1 }]])),
    { file: 'f', sha256: 'h' });
});

dbTest('export refuses assets_missing when an object is gone, and writes no file', async (t, pool, { root, store }) => {
  await seedFixture(pool);
  store.objects.delete('sx/big.png');
  await assert.rejects(exportGroup(pool, 'sx_assets', { store }), (e) => {
    assert.strictEqual(e.code, 'assets_missing');
    assert.deepStrictEqual(e.details.rows, [{ table: 'sx_art', key: 'sx_b', objectKey: 'sx/big.png' }]);
    return true;
  });
  assert.deepStrictEqual(filesUnder(root), [], 'no asset file written');
  assert.ok(!fs.existsSync(fileFor('sx_assets')), 'no sync file written');
  assert.strictEqual(store.gets, 0, 'nothing downloaded');
});

dbTest('preview blocks a row whose asset file is missing or altered', async (t, pool, { root, store }) => {
  await seedFixture(pool);
  await exportGroup(pool, 'sx_assets', { store });
  await forgetLocally(pool, 'sx_art');
  fs.unlinkSync(path.join(root, 'sx_tiles/sx_a.png'));
  const b = path.join(root, 'sx_tiles/sx_b.png');
  const bytes = fs.readFileSync(b);
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(b, bytes);

  const p = await previewSeed(pool, 'sx_assets');
  const by = Object.fromEntries(p.rows.map((r) => [r.key, r]));
  assert.strictEqual(by.sx_a.kind, 'new');
  assert.strictEqual(by.sx_a.blockedReason, 'asset_file_missing');
  assert.strictEqual(by.sx_b.blockedReason, 'asset_file_mismatch');
  for (const k of ['sx_a', 'sx_b']) {
    assert.deepStrictEqual(by[k].allowedDecisions, ['local'], `${k}: git unavailable`);
    assert.strictEqual(by[k].defaultDecision, null, `${k}: red`);
    assert.strictEqual(typeof by[k].blockedMessage, 'string');
  }
  assert.strictEqual(by.sx_c.blockedReason, null, 'no asset, no block');

  await assert.rejects(applySeed(pool, 'sx_assets', { [by.sx_a.syncUuid]: 'git', [by.sx_b.syncUuid]: 'local' },
    { signature: p.signature, store }), (e) => e.code === 'asset_file_missing');
  assert.strictEqual(store.puts.length, 0, 'nothing uploaded');
});

dbTest('apply uploads content-addressed objects and writes local keys', async (t, pool, { root, store }) => {
  await seedFixture(pool);
  await exportGroup(pool, 'sx_assets', { store });
  await forgetLocally(pool, 'sx_art');
  const p = await previewSeed(pool, 'sx_assets');
  const by = Object.fromEntries(p.rows.map((r) => [r.key, r]));
  // sx_b is kept local: its (shrunk) image is never uploaded.
  const res = await applySeed(pool, 'sx_assets', { [by.sx_b.syncUuid]: 'local' }, { signature: p.signature, store });
  assert.strictEqual(res.summary.created, 2);

  const a = await one(pool, "SELECT image, sprite FROM sx_art WHERE name = 'sx_a'");
  const key = `${BUCKET}/seedsync/${sha256(PNG_A)}/sx_tiles_sx_a.png`;
  assert.strictEqual(a.image, key);
  assert.deepStrictEqual(store.objects.get(key), PNG_A);
  assert.deepStrictEqual(a.sprite, {
    atlas_key: `${BUCKET}/seedsync/${sha256(ATLAS)}/sx_sprites_sx_a_atlas.png`,
    manifest_key: `${BUCKET}/seedsync/${sha256(MANIFEST)}/sx_sprites_sx_a_manifest.json`,
    static_frame: 0, frames: { idle: 2 },
  });
  assert.deepStrictEqual(store.objects.get(a.sprite.manifest_key), MANIFEST);
  const shrunk = shrinkToEdge(PNG_BIG, 16).buffer;
  assert.ok(!store.puts.some((x) => x.key.includes(sha256(shrunk))), 'a kept-local row is not uploaded');
  assert.ok(!(await one(pool, "SELECT 1 AS x FROM sx_art WHERE name = 'sx_b'")), 'sx_b not inserted');
  assert.deepStrictEqual(await one(pool, 'SELECT sha256, file, bytes FROM seed_asset_hashes WHERE object_key = $1', [key]),
    { sha256: sha256(PNG_A), file: 'sx_tiles/sx_a.png', bytes: PNG_A.length });

  const d = await diffGroup(pool, 'sx_assets');
  // sx_b: 'local' acknowledged git's version (B = hG), so it now reads deleted_here.
  assert.deepStrictEqual(d.rows.map((r) => [r.key, r.kind]), [['sx_b', 'deleted_here']], 'sx_a and sx_c in sync');

  const puts = store.puts.length;
  await pool.query("UPDATE sx_art SET val = 5 WHERE name = 'sx_a'");
  const doc = readDoc('sx_assets');
  doc.tables.sx_art.find((r) => r.name === 'sx_a').val = 7;
  writeDoc('sx_assets', doc);
  // A git write whose asset value equals local keeps the local key, no upload.
  const sxa = (await previewSeed(pool, 'sx_assets')).rows.find((r) => r.key === 'sx_a');
  await apply(pool, 'sx_assets', { [sxa.syncUuid]: 'git', [by.sx_b.syncUuid]: 'local' }, { store });
  assert.strictEqual((await one(pool, "SELECT val, image FROM sx_art WHERE name = 'sx_a'")).image, key);
  assert.strictEqual(store.puts.length, puts, 'nothing uploaded for an unchanged asset');
  assert.ok(fs.existsSync(root));
});

dbTest('audio value uses sha1 column and per-clip key', async (t, pool, { root, store }) => {
  const clipUuid = await seedFixture(pool);
  await exportGroup(pool, 'sx_assets', { store });
  const file = `audio/sfx/sx_clip1-${clipUuid.slice(0, 8)}.ogg`;
  // localAssetValue is computed from the row alone (no cache).
  assert.deepStrictEqual(
    localAssetValue(clipSpec, 'storage_key', { label: 'sx_clip1', kind: 'sfx', sha1: 'abc', sync_uuid: clipUuid, storage_key: 'k' }, new Map()),
    { file, sha1: 'abc' });

  // Re-export: the file matches the row's sha1, so it is not downloaded again.
  const gets = store.gets;
  await exportGroup(pool, 'sx_assets', { store });
  assert.strictEqual(store.gets, gets);

  await forgetLocally(pool, 'sx_clip');
  await apply(pool, 'sx_assets', {}, { store });
  const row = await one(pool, 'SELECT storage_key, sha1, bytes, sync_uuid FROM sx_clip');
  assert.deepStrictEqual(row, {
    storage_key: `audio/sfx/${clipUuid}-${sha1(OGG).slice(0, 8)}.ogg`, sha1: sha1(OGG), bytes: OGG.length, sync_uuid: clipUuid,
  });
  assert.deepStrictEqual(store.objects.get(row.storage_key), OGG);
  assert.strictEqual(store.puts.find((x) => x.key === row.storage_key).contentType, 'audio/ogg');
  const dd = await diffGroup(pool, 'sx_assets');
  assert.strictEqual(dd.status, 'in_sync', JSON.stringify(dd.rows));

  // An altered clip file blocks its git row.
  await forgetLocally(pool, 'sx_clip');
  fs.writeFileSync(path.join(root, file), 'other bytes');
  const p = await previewSeed(pool, 'sx_assets');
  assert.strictEqual(p.rows.find((r) => r.key === 'sx_clip1').blockedReason, 'asset_file_mismatch');
});

dbTest('asset column on a slice exports and seeds', async (t, pool, { root, store }) => {
  await pool.query("INSERT INTO sx_own (name, val, icon) VALUES ('sx_o', 1, 'sx/icon.png')");
  await exportGroup(pool, 'sx_own', { store });
  await exportGroup(pool, 'sx_icons', { store });
  const doc = readDoc('sx_icons');
  assert.deepStrictEqual(doc.tables.sx_own[0].icon, { file: 'sx_icons/sx_o.png', sha256: sha256(ICON) });
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'sx_icons/sx_o.png')), ICON);
  assert.strictEqual((await diffGroup(pool, 'sx_icons')).status, 'in_sync');

  // Another PC: the owner row is here without art, no cache, no baselines.
  await pool.query("UPDATE sx_own SET icon = NULL WHERE name = 'sx_o'");
  await pool.query(`DELETE FROM seed_asset_hashes WHERE object_key LIKE 'sx%'`);
  await pool.query(`DELETE FROM seed_row_hashes WHERE group_id = 'sx_icons'`);
  const p = await previewSeed(pool, 'sx_icons');
  assert.deepStrictEqual(p.rows.map((r) => [r.key, r.kind]), [['sx_o', 'edited_here']]);
  await apply(pool, 'sx_icons', { [p.rows[0].syncUuid]: 'git' }, { store });
  assert.strictEqual((await one(pool, "SELECT icon FROM sx_own WHERE name = 'sx_o'")).icon,
    `${BUCKET}/seedsync/${sha256(ICON)}/sx_icons_sx_o.png`);
  assert.strictEqual((await diffGroup(pool, 'sx_icons')).status, 'in_sync');
});

dbTest('cancel during prepare throws cancelled and leaves no tmp files', async (t, pool, { root, store }) => {
  await seedFixture(pool);
  const ac = new AbortController();
  let calls = 0;
  await assert.rejects(exportGroup(pool, 'sx_assets', {
    store, signal: ac.signal, onProgress: () => { calls += 1; ac.abort(); },
  }), (e) => e.code === 'cancelled');
  assert.ok(calls >= 1);
  assert.ok(store.gets < 5, 'stopped before the end');
  assert.deepStrictEqual(filesUnder(root).filter((f) => f.endsWith('.tmp')), []);
  assert.ok(!fs.existsSync(fileFor('sx_assets')), 'no sync file written');

  // Apply's upload is cancellable too: nothing is written to the DB.
  await exportGroup(pool, 'sx_assets', { store });
  await forgetLocally(pool, 'sx_art');
  const ac2 = new AbortController();
  ac2.abort();
  const { signature } = await previewSeed(pool, 'sx_assets');
  await assert.rejects(applySeed(pool, 'sx_assets', {}, { signature, store, signal: ac2.signal }),
    (e) => e.code === 'cancelled');
  assert.strictEqual(Number((await one(pool, 'SELECT count(*) AS n FROM sx_art')).n), 0);
});

dbTest('identical bytes in two files seed to two keys, both in sync', async (t, pool, { store }) => {
  store.objects.set('sx/a_copy.png', PNG_A);
  await pool.query(`INSERT INTO sx_art (name, val, image) VALUES ('sx_a', 1, 'sx/a.png'), ('sx_d', 2, 'sx/a_copy.png')`);
  await exportGroup(pool, 'sx_assets', { store });
  await forgetLocally(pool, 'sx_art');
  await apply(pool, 'sx_assets', {}, { store });
  const d = await diffGroup(pool, 'sx_assets');
  assert.strictEqual(d.status, 'in_sync', JSON.stringify(d.rows));
  const keys = await all(pool, 'SELECT name, image FROM sx_art ORDER BY name');
  assert.deepStrictEqual(keys, [
    { name: 'sx_a', image: `${BUCKET}/seedsync/${sha256(PNG_A)}/sx_tiles_sx_a.png` },
    { name: 'sx_d', image: `${BUCKET}/seedsync/${sha256(PNG_A)}/sx_tiles_sx_d.png` },
  ]);
  const cache = await all(pool, `SELECT object_key, file FROM seed_asset_hashes WHERE object_key LIKE '${BUCKET}/%' ORDER BY file`);
  assert.deepStrictEqual(cache.map((c) => c.file), ['sx_tiles/sx_a.png', 'sx_tiles/sx_d.png'], 'two cache entries');
});

dbTest('a seed that fails after uploading leaves the served audio bytes untouched', async (t, pool, { root, store }) => {
  const clipUuid = await seedFixture(pool);
  await exportGroup(pool, 'sx_assets', { store });
  await forgetLocally(pool, 'sx_clip');
  await apply(pool, 'sx_assets', {}, { store });
  const served = (await one(pool, 'SELECT storage_key FROM sx_clip')).storage_key;
  assert.deepStrictEqual(store.objects.get(served), OGG);

  // Git renames the clip onto a label a kept local row holds, with new bytes:
  // the upload happens, then the write hits the unique label (conflict).
  await pool.query("INSERT INTO sx_clip (label, kind) VALUES ('sx_clip2', 'sfx')");
  const OGG2 = Buffer.from('OggS other payload');
  const doc = readDoc('sx_assets');
  const c = doc.tables.sx_clip[0];
  c.label = 'sx_clip2';
  c.sha1 = sha1(OGG2);
  c.bytes = OGG2.length;
  c.storage_key = { file: `audio/sfx/sx_clip2-${clipUuid.slice(0, 8)}.ogg`, sha1: sha1(OGG2) };
  fs.writeFileSync(path.join(root, c.storage_key.file), OGG2);
  writeDoc('sx_assets', doc);
  const p = await previewSeed(pool, 'sx_assets');
  assert.strictEqual(p.rows.find((r) => r.syncUuid === clipUuid).kind, 'changed');
  await assert.rejects(applySeed(pool, 'sx_assets', {}, { signature: p.signature, store }), (e) => e.code === 'conflict');
  assert.deepStrictEqual(store.objects.get(served), OGG, 'the served object is unchanged');
  const newKey = `audio/sfx/${clipUuid}-${sha1(OGG2).slice(0, 8)}.ogg`;
  assert.deepStrictEqual(store.objects.get(newKey), OGG2, 'the upload did happen (to a new key)');
  assert.strictEqual((await one(pool, 'SELECT storage_key FROM sx_clip WHERE sync_uuid = $1', [clipUuid])).storage_key, served);
});

dbTest('symlinks are never followed: read blocks, write refuses', async (t, pool, { root, store }) => {
  await seedFixture(pool);
  await exportGroup(pool, 'sx_assets', { store });
  await forgetLocally(pool, 'sx_art');
  // A symlinked file whose target has exactly the right bytes still blocks.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-assets-out-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const target = path.join(outside, 'a.png');
  fs.writeFileSync(target, PNG_A);
  const file = path.join(root, 'sx_tiles/sx_a.png');
  fs.unlinkSync(file);
  fs.symlinkSync(target, file);
  const p = await previewSeed(pool, 'sx_assets');
  assert.strictEqual(p.rows.find((r) => r.key === 'sx_a').blockedReason, 'asset_file_mismatch');

  // Export into a symlinked asset dir is refused before anything lands outside.
  await pool.query('DELETE FROM sx_clip');
  await pool.query("DELETE FROM seed_row_hashes WHERE group_id = 'sx_assets'");
  fs.rmSync(fileFor('sx_assets'));
  await pool.query("INSERT INTO sx_art (name, val, image) VALUES ('sx_e', 1, 'sx/a.png')");
  fs.rmSync(path.join(root, 'sx_tiles'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'sx_tiles'));
  await assert.rejects(exportGroup(pool, 'sx_assets', { store }), (e) => e.code === 'asset_path_unsafe');
  assert.deepStrictEqual(fs.readdirSync(outside), ['a.png'], 'nothing written through the link');
});

dbTest('an audio git value without a sha1 is a mismatch', async (t, pool, { store }) => {
  await seedFixture(pool);
  await exportGroup(pool, 'sx_assets', { store });
  await forgetLocally(pool, 'sx_clip');
  const doc = readDoc('sx_assets');
  doc.tables.sx_clip[0].storage_key.sha1 = null;
  writeDoc('sx_assets', doc);
  const p = await previewSeed(pool, 'sx_assets');
  assert.strictEqual(p.rows.find((r) => r.key === 'sx_clip1').blockedReason, 'asset_file_mismatch');
});

dbTest('export refuses a both-sides conflict before writing any asset file', async (t, pool, { root, store }) => {
  store.objects.set('sx/a2.png', ICON);
  await seedFixture(pool);
  await exportGroup(pool, 'sx_assets', { store });
  // Git changed sx_a; here sx_a got new art (an uncached key that would take
  // the file name sx_tiles/sx_a.png).
  const doc = readDoc('sx_assets');
  doc.tables.sx_art.find((r) => r.name === 'sx_a').val = 42;
  writeDoc('sx_assets', doc);
  await pool.query("UPDATE sx_art SET image = 'sx/a2.png' WHERE name = 'sx_a'");
  const gets = store.gets;
  const d = await diffGroup(pool, 'sx_assets');
  assert.strictEqual(d.rows.find((r) => r.key === 'sx_a').kind, 'edited_here');
  await assert.rejects(exportGroup(pool, 'sx_assets', { store }), (e) => e.code === 'git_newer');
  assert.strictEqual(store.gets, gets, 'nothing downloaded');
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'sx_tiles/sx_a.png')), PNG_A, "git's file untouched");
});

// M-1: a git sprite value is untrusted. Object keys in it would be written
// verbatim (pointing a row at any object); a value with no atlas/manifest
// part is not a sprite this engine exported.
dbTest('a git sprite value carrying object keys or no parts is a mismatch', async (t, pool, { store }) => {
  await seedFixture(pool);
  await exportGroup(pool, 'sx_assets', { store });
  await forgetLocally(pool, 'sx_art');
  const doc = readDoc('sx_assets');
  const a = doc.tables.sx_art.find((r) => r.name === 'sx_a');
  a.sprite.atlas_key = 'sxb/someone-elses/object.png';
  const b = doc.tables.sx_art.find((r) => r.name === 'sx_b');
  b.sprite = { static_frame: 0, frames: { idle: 2 } };
  writeDoc('sx_assets', doc);
  const p = await previewSeed(pool, 'sx_assets');
  const by = Object.fromEntries(p.rows.map((r) => [r.key, r]));
  for (const k of ['sx_a', 'sx_b']) {
    assert.strictEqual(by[k].blockedReason, 'asset_file_mismatch', k);
    assert.deepStrictEqual(by[k].allowedDecisions, ['local'], k);
  }
  // The upload refuses it too (never trusts the preview alone).
  await assert.rejects(uploadGitAssets(store, [{ ...a, image: null }], artSpec), (e) => e.code === 'asset_file_mismatch');
  await assert.rejects(uploadGitAssets(store, [{ ...b, image: null }], artSpec), (e) => e.code === 'asset_file_mismatch');
  const manifestOnly = { ...a, image: null, sprite: { manifest: a.sprite.manifest, manifest_key: 'sxb/x.json' } };
  await assert.rejects(uploadGitAssets(store, [manifestOnly], artSpec), (e) => e.code === 'asset_file_mismatch');
  assert.strictEqual(store.puts.length, 0, 'nothing uploaded');
});

// I-2: whether a row's git files are usable does not depend on its default or
// decision. A red row (default null) whose file is missing must not offer
// 'git' -- a legacy-seeded PC has every art row red, and bulk "take git"
// would then fail as a whole.
dbTest('a red row with a missing git file is blocked in preview', async (t, pool, { root, store }) => {
  await seedFixture(pool);
  await exportGroup(pool, 'sx_assets', { store });
  // Another PC: same rows and keys, no cache, no baselines -> edited_here (red).
  await pool.query(`DELETE FROM seed_asset_hashes WHERE object_key LIKE 'sx%'`);
  await pool.query(`DELETE FROM seed_row_hashes WHERE group_id = 'sx_assets'`);
  fs.unlinkSync(path.join(root, 'sx_tiles/sx_a.png'));
  const p = await previewSeed(pool, 'sx_assets');
  const by = Object.fromEntries(p.rows.map((r) => [r.key, r]));
  assert.strictEqual(by.sx_a.kind, 'edited_here');
  assert.strictEqual(by.sx_a.defaultDecision, null, 'red');
  assert.strictEqual(by.sx_a.blockedReason, 'asset_file_missing');
  assert.deepStrictEqual(by.sx_a.allowedDecisions, ['local'], 'git not offered');
  assert.strictEqual(by.sx_b.blockedReason, null, "sx_b's file is there");
  assert.deepStrictEqual(by.sx_b.allowedDecisions, ['git', 'local']);
  // The same reason under any decision: apply refuses git with it, and
  // accepts 'local' under the preview's signature.
  await assert.rejects(applySeed(pool, 'sx_assets', { [by.sx_a.syncUuid]: 'git', [by.sx_b.syncUuid]: 'local' },
    { signature: p.signature, store }), (e) => e.code === 'asset_file_missing');
  assert.strictEqual(store.puts.length, 0, 'nothing uploaded');
  const decisions = Object.fromEntries(p.rows.map((r) => [r.syncUuid, 'local']));
  await applySeed(pool, 'sx_assets', decisions, { signature: p.signature, store });

  // Repeated previews hash each unchanged file once per process.
  const before = _hashedFiles();
  await previewSeed(pool, 'sx_assets');
  await pool.query(`DELETE FROM seed_row_hashes WHERE group_id = 'sx_assets'`);
  await previewSeed(pool, 'sx_assets');
  await previewSeed(pool, 'sx_assets');
  assert.strictEqual(_hashedFiles(), before, 'no file re-hashed');
  // An edited file (new size/mtime) is hashed again.
  fs.writeFileSync(path.join(root, 'sx_tiles/sx_b.png'), 'edited');
  const p2 = await previewSeed(pool, 'sx_assets');
  assert.strictEqual(p2.rows.find((r) => r.key === 'sx_b').blockedReason, 'asset_file_mismatch');
  assert.ok(_hashedFiles() > before);
});

// I-1: on a legacy-seeded PC (uncached keys, no baselines) every asset row
// reads edited_here, so the cheap pre-check lets the export through. Its
// uncached key takes the natural file name -- the very file git's row
// references. Local bytes that differ from git's must never land there when
// the export then refuses git_newer.
dbTest("export never overwrites git's file before refusing git_newer", async (t, pool, { root, store }) => {
  store.objects.set('sx/a_legacy.png', ICON);
  await seedFixture(pool);
  await exportGroup(pool, 'sx_assets', { store });
  const before = new Map(filesUnder(root).map((f) => [f, fs.readFileSync(path.join(root, f))]));
  await pool.query("UPDATE sx_art SET image = 'sx/a_legacy.png' WHERE name = 'sx_a'");
  await pool.query(`DELETE FROM seed_asset_hashes WHERE object_key LIKE 'sx%'`);
  await pool.query(`DELETE FROM seed_row_hashes WHERE group_id = 'sx_assets'`);
  const docBefore = fs.readFileSync(fileFor('sx_assets'));

  await assert.rejects(exportGroup(pool, 'sx_assets', { store }), (e) => e.code === 'git_newer');
  assert.deepStrictEqual(filesUnder(root), [...before.keys()], 'no file added, none left as .tmp');
  for (const [f, bytes] of before) assert.ok(fs.readFileSync(path.join(root, f)).equals(bytes), `${f} byte-identical`);
  assert.ok(fs.readFileSync(fileFor('sx_assets')).equals(docBefore), 'sync file untouched');
  assert.strictEqual((await one(pool, "SELECT count(*)::int AS n FROM seed_asset_hashes WHERE object_key = 'sx/a_legacy.png'")).n, 0,
    'the refused key is not cached under a file that does not hold it');

  // A real local edit (baseline == git) still exports over git's file.
  await pool.query("UPDATE sx_art SET image = 'sx/a.png' WHERE name = 'sx_a'");
  await exportGroup(pool, 'sx_assets', { store });
  await pool.query("UPDATE sx_art SET image = 'sx/a_legacy.png' WHERE name = 'sx_a'");
  assert.strictEqual((await diffGroup(pool, 'sx_assets')).rows.find((r) => r.key === 'sx_a').kind, 'not_exported');
  await exportGroup(pool, 'sx_assets', { store });
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'sx_tiles/sx_a.png')), ICON);
  assert.deepStrictEqual(readDoc('sx_assets').tables.sx_art.find((r) => r.name === 'sx_a').image,
    { file: 'sx_tiles/sx_a.png', sha256: sha256(ICON) });
  assert.deepStrictEqual(filesUnder(root).filter((f) => f.endsWith('.tmp')), []);
});

// P-1: seed upload progress counts the whole group (one total up front), like
// the export's download progress -- never restarting per table.
dbTest('seed upload progress is monotonic across the group', async (t, pool, { store }) => {
  await seedFixture(pool);
  await exportGroup(pool, 'sx_assets', { store });
  await forgetLocally(pool, 'sx_art');
  await forgetLocally(pool, 'sx_clip');
  const seen = [];
  await apply(pool, 'sx_assets', {}, { store: fakeStore(), onProgress: (p) => seen.push(p) });
  // sx_a image + sprite, sx_b image (sx_c's is ''), the clip.
  assert.deepStrictEqual(seen.map((p) => [p.phase, p.done, p.total]),
    [['upload', 1, 4], ['upload', 2, 4], ['upload', 3, 4], ['upload', 4, 4]]);
});

// Follow-up (final review, parked): a backend that dies mid-export leaves its
// staged <file>.<pid>.<n>.tmp files under the assets root. The next export
// sweeps those of DEAD processes in the group's dirs; a live process's staging
// (another export in a CLI, say) and other .tmp names are left alone.
dbTest('stale staged tmp files of a dead process are swept at export start', async (t, pool, { root, store }) => {
  const { spawnSync } = require('node:child_process');
  const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
  await seedFixture(pool);
  fs.mkdirSync(path.join(root, 'sx_tiles'), { recursive: true });
  const dead = path.join(root, 'sx_tiles', `sx_a.png.${deadPid}.3.tmp`);
  const live = path.join(root, 'sx_tiles', `sx_b.png.${process.ppid}.0.tmp`);
  const other = path.join(root, 'sx_tiles', 'notes.tmp');
  for (const f of [dead, live, other]) fs.writeFileSync(f, 'x');
  await exportGroup(pool, 'sx_assets', { store });
  assert.ok(!fs.existsSync(dead), "a dead process's staged file is removed");
  assert.ok(fs.existsSync(live), "a live process's staged file is kept");
  assert.ok(fs.existsSync(other), 'a .tmp that is not a staged name is kept');
});

// Follow-up: the pre-export verify diff reads one snapshot (REPEATABLE READ),
// so a concurrent admin commit cannot make its statements disagree.
dbTest('the staged-file verify runs in a REPEATABLE READ transaction', async (t, pool, { root, store }) => {
  const { getGroup } = require('../src/services/seedSync/registry.js');
  const { prepareExportAssets } = require('../src/services/seedSync/assets.js');
  await seedFixture(pool);
  await exportGroup(pool, 'sx_assets', { store });
  fs.writeFileSync(path.join(root, 'sx_tiles', 'sx_a.png'), 'different bytes on disk');
  let iso = null;
  await prepareExportAssets(pool, store, getGroup('sx_assets'), {
    verify: async (c) => { iso = (await c.query('SHOW transaction_isolation')).rows[0].transaction_isolation; },
  });
  assert.strictEqual(iso, 'repeatable read');
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'sx_tiles/sx_a.png')), PNG_A, 'staged file placed after verify');
});
