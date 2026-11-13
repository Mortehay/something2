// Image shrink Task 7: image_variants travels with the art seed. The REAL
// registry spec of image_variants runs in a test group over a copy of the
// table in a throwaway schema (seed_sync_assets_db.test.js pattern), with an
// in-memory object store. The target subjects are real entity_types rows
// named sx_* (cleanupSx removes them).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const sharp = require('sharp');
const { Pool } = require('pg');
const { withSeedSyncLock, cleanupSx, makeTempSyncDir } = require('./helpers/seedSyncTest.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

const { getGroup, tableSpecs, _withTestGroups } = require('../src/services/seedSync/registry.js');
const { exportGroup, fileFor } = require('../src/services/seedSync/exportGroup.js');
const { diffGroup } = require('../src/services/seedSync/diffGroup.js');
const { previewSeed, applySeed } = require('../src/services/seedSync/applySeed.js');
const { stableStringify } = require('../src/services/seedSync/canonical.js');
const { getServeMap, invalidateServeMap, webArt, bindUnbound } = require('../src/services/imageVariants.js');
const { findAutoShrinkWork } = require('../src/services/imageAutoShrink.js');
const { imageColumns } = require('../src/services/imageCatalog.js');

const SCHEMA = 'sx_iv';
const BUCKET = 'sxb';
const ENT = 'sx_iv_ent';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

const variantSpec = () => tableSpecs(getGroup('art')).find((s) => s.table === 'image_variants');
const groups = () => [{ id: 'sx_iv', label: 'SX image variants', tables: [variantSpec()] }];

function fakeStore(objects) {
  const store = {
    objects: new Map(objects),
    puts: [],
    BUCKET: () => BUCKET,
    async ensureBucket() {},
    async getObjectStream(key) {
      if (!store.objects.has(key)) { const e = new Error(`no key ${key}`); e.code = 'NoSuchKey'; throw e; }
      return Readable.from([store.objects.get(key)]);
    },
    async readObject(key) {
      if (!store.objects.has(key)) { const e = new Error(`no key ${key}`); e.code = 'NoSuchKey'; throw e; }
      return store.objects.get(key);
    },
    async statObject(key) {
      const b = store.objects.get(key);
      return b ? { size: b.length, etag: md5(b) } : null;
    },
    async putObject(key, buffer, contentType) {
      store.puts.push({ key, buffer, contentType });
      store.objects.set(key, buffer);
      return key;
    },
    async objectExists(key) { return store.objects.has(key); },
  };
  return store;
}

const one = async (pool, sql, params) => (await pool.query(sql, params)).rows[0];
const readDoc = (groupId) => JSON.parse(fs.readFileSync(fileFor(groupId), 'utf8'));
function writeDoc(groupId, doc) {
  for (const [tbl, rows] of Object.entries(doc.tables)) doc.header.row_counts[tbl] = rows.length;
  fs.writeFileSync(fileFor(groupId), `${stableStringify(doc)}\n`);
}
async function apply(pool, groupId, decisions, opts) {
  const { signature } = await previewSeed(pool, groupId);
  return applySeed(pool, groupId, decisions || {}, { signature, ...opts });
}
async function cleanupCache(pool) {
  await pool.query(`DELETE FROM seed_asset_hashes WHERE object_key LIKE 'sx%' OR object_key LIKE 'seedsync/%sx_iv%'`);
}

function dbTest(name, body) {
  test(name, async (t) => {
    if (!process.env.TEST_DATABASE_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (seed_sync image variants)';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    const dir = makeTempSyncDir();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-iv-'));
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
      await pub.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
        CREATE TABLE ${SCHEMA}.image_variants (LIKE public.image_variants INCLUDING ALL);`);
      invalidateServeMap();
      try {
        await _withTestGroups(groups(), () => body(t, pool, { root }));
      } finally {
        invalidateServeMap();
        await pub.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await cleanupCache(pub).catch(() => {});
        await cleanupSx(pub).catch(() => {});
      }
    });
  });
}

const webp = (w, h, seed) => sharp(Buffer.alloc(w * h * 4, seed), { raw: { width: w, height: h, channels: 4 } })
  .webp({ quality: 80 }).toBuffer();
const png = (w, h, seed) => sharp(Buffer.alloc(w * h * 4, seed), { raw: { width: w, height: h, channels: 4 } })
  .png().toBuffer();

// Source PC: one image variant and one sheet variant for ENT, made from the
// source's originals (which the seed never names). Fresh on the source: the
// entity row holds those originals and their etags match (R14: only fresh
// copies are exported).
async function sourceFixture(pool) {
  const WEB = await webp(48, 32, 7);
  const ATLAS = await webp(64, 32, 9);
  const MAN = Buffer.from('{"cell":[32,32],"frames":{"s":[[0,0]]}}');
  const SRC = await png(96, 64, 5);
  const SRC_ATLAS = await png(128, 64, 6);
  const SRC_MAN = Buffer.from('{"cell":[64,64],"frames":{"s":[[0,0]]}}');
  const webKey = `seedsync/${sha256(WEB)}/sx_iv_src.webp`;
  const sprite = { atlas_key: `seedsync/${sha256(ATLAS)}/sx_iv_sheet.webp`, manifest_key: `seedsync/${sha256(MAN)}/manifest.json` };
  const store = fakeStore([[webKey, WEB], [sprite.atlas_key, ATLAS], [sprite.manifest_key, MAN],
    ['sx/src.png', SRC], ['sx/src_atlas.png', SRC_ATLAS], ['sx/src_man.json', SRC_MAN]]);
  const srcSprite = { atlas_key: 'sx/src_atlas.png', manifest_key: 'sx/src_man.json', static_frame: 0 };
  await pool.query(`INSERT INTO entity_types (name, color, image, sprite) VALUES ($1, '#000000', 'sx/src.png', $2)`,
    [ENT, JSON.stringify(srcSprite)]);
  await pool.query(
    `INSERT INTO image_variants (subject_table, subject_key, subject_column, original_key, original_etag, web_key, params,
                                 original_bytes, web_bytes, original_width, original_height, web_width, web_height)
     VALUES ('entity_types', $1, 'image', 'sx/src.png', $3, $2, '{"maxEdge":48,"quality":80}', 9000, $4, 96, 64, 48, 32)`,
    [ENT, webKey, md5(SRC), WEB.length]);
  await pool.query(
    `INSERT INTO image_variants (subject_table, subject_key, subject_column, original_key, original_etag,
                                 original_manifest_key, original_manifest_etag, web_sprite, params)
     VALUES ('entity_types', $1, 'sprite', 'sx/src_atlas.png', $3, 'sx/src_man.json', $4, $2,
             '{"scale":0.5,"quality":80}')`,
    [ENT, JSON.stringify(sprite), md5(SRC_ATLAS), md5(SRC_MAN)]);
  return { WEB, ATLAS, MAN, SRC, SRC_ATLAS, SRC_MAN, webKey, sprite, srcSprite, store };
}

// The target PC never had these variant rows (nor their cache entries).
async function forgetVariants(pool) {
  const uuids = (await pool.query('SELECT sync_uuid FROM image_variants')).rows.map((r) => r.sync_uuid);
  await pool.query('DELETE FROM image_variants');
  await pool.query('DELETE FROM seed_row_hashes WHERE sync_uuid = ANY($1::uuid[])', [uuids]);
  await pool.query(`DELETE FROM seed_asset_hashes WHERE object_key LIKE 'seedsync/%' AND file LIKE 'textures/web%sx_iv%'`);
}

test('image_variants is registered in the art group, after character_appearances, never shrinkable itself', () => {
  const spec = variantSpec();
  assert.ok(spec, 'art group has image_variants');
  const names = tableSpecs(getGroup('art')).map((s) => s.table);
  assert.strictEqual(names.indexOf('image_variants'), names.indexOf('character_appearances') + 1);
  assert.deepStrictEqual(spec.naturalKey, ['subject_table', 'subject_key', 'subject_column']);
  for (const c of ['original_key', 'original_etag', 'original_manifest_key', 'original_manifest_etag',
    'original_bytes', 'original_width', 'original_height', 'stale_at', 'id', 'created_at', 'updated_at']) {
    assert.ok(Object.prototype.hasOwnProperty.call(spec.omit, c), `${c} omitted`);
  }
  assert.ok(!('source_asset_sha256' in spec.omit), 'the source sha travels');
  assert.ok(spec.unbindOnSeed.includes('stale_at'), 'a git write clears a local stale mark');
  assert.deepStrictEqual(spec.assets, {
    web_key: { type: 'image', dir: 'textures/web' },
    web_sprite: { type: 'sprite', dir: 'textures/web_sprites' },
  });
  assert.ok(!imageColumns().some((c) => c.table === 'image_variants'), 'web copies are not game images');
});

dbTest('a WebP web copy exports as .webp and seeds back as image/webp, bytes unchanged', async (t, pool, { root }) => {
  const { WEB, ATLAS, MAN, SRC, SRC_ATLAS, store } = await sourceFixture(pool);
  await exportGroup(pool, 'sx_iv', { store });
  const rows = Object.fromEntries(readDoc('sx_iv').tables.image_variants.map((r) => [r.subject_column, r]));
  // The subject's exported file (entity images are not resampled; a sheet's atlas).
  assert.strictEqual(rows.image.source_asset_sha256, sha256(SRC));
  assert.strictEqual(rows.sprite.source_asset_sha256, sha256(SRC_ATLAS));
  assert.deepStrictEqual(rows.image.web_key, { file: `textures/web/entity_types_${ENT}_image.webp`, sha256: sha256(WEB) });
  assert.deepStrictEqual(rows.sprite.web_sprite, {
    atlas: { file: `textures/web_sprites/entity_types_${ENT}_sprite.atlas.webp`, sha256: sha256(ATLAS) },
    manifest: { file: `textures/web_sprites/entity_types_${ENT}_sprite.manifest.json`, sha256: sha256(MAN) },
  });
  for (const c of ['original_key', 'original_etag', 'original_manifest_key', 'original_manifest_etag',
    'original_bytes', 'original_width', 'original_height']) {
    assert.ok(!(c in rows.image) && !(c in rows.sprite), `${c} is local, not exported`);
  }
  assert.deepStrictEqual(fs.readFileSync(path.join(root, rows.image.web_key.file)), WEB, 'not resampled');
  assert.deepStrictEqual(fs.readFileSync(path.join(root, rows.sprite.web_sprite.atlas.file)), ATLAS);

  await forgetVariants(pool);
  const res = await apply(pool, 'sx_iv', {}, { store });
  assert.strictEqual(res.summary.created, 2);
  const img = await one(pool, "SELECT * FROM image_variants WHERE subject_column = 'image'");
  assert.strictEqual(img.web_key, `${BUCKET}/seedsync/${sha256(WEB)}/textures_web_entity_types_${ENT}_image.webp`);
  assert.strictEqual(img.original_key, null);
  assert.strictEqual(img.original_etag, null);
  assert.deepStrictEqual([img.original_bytes, img.original_width, img.original_height], [null, null, null]);
  assert.deepStrictEqual([img.web_bytes, img.web_width, img.web_height], [WEB.length, 48, 32], 'web facts travel');
  const sheet = await one(pool, "SELECT * FROM image_variants WHERE subject_column = 'sprite'");
  assert.strictEqual(sheet.original_manifest_key, null);
  assert.strictEqual(sheet.original_manifest_etag, null);
  const put = (k) => store.puts.find((p) => p.key === k);
  assert.strictEqual(put(img.web_key).contentType, 'image/webp');
  assert.deepStrictEqual(put(img.web_key).buffer, WEB);
  assert.strictEqual(put(sheet.web_sprite.atlas_key).contentType, 'image/webp');
  assert.ok(sheet.web_sprite.atlas_key.endsWith('.webp'));
  assert.strictEqual(put(sheet.web_sprite.manifest_key).contentType, 'application/json');
});

dbTest('a seeded variant never binds to different art on the target (R14): the original is served', async (t, pool) => {
  const { store } = await sourceFixture(pool);
  await exportGroup(pool, 'sx_iv', { store });
  await forgetVariants(pool);
  // The target's entity holds DIFFERENT art than the source shrank.
  const TGT = await png(96, 64, 3);
  const TGT_ATLAS = await png(128, 64, 4);
  const TGT_MAN = Buffer.from('{"cell":[64,64],"frames":{"s":[[0,0]]}}');
  for (const [k, b] of [['sx/tgt.png', TGT], ['sx/tgt_atlas.png', TGT_ATLAS], ['sx/tgt_man.json', TGT_MAN]]) store.objects.set(k, b);
  const tgtSprite = { atlas_key: 'sx/tgt_atlas.png', manifest_key: 'sx/tgt_man.json', static_frame: 0 };
  await pool.query('UPDATE entity_types SET image = $2, sprite = $3 WHERE name = $1', [ENT, 'sx/tgt.png', JSON.stringify(tgtSprite)]);

  await apply(pool, 'sx_iv', {}, { store });
  await bindUnbound(pool, store);
  const img = await one(pool, "SELECT * FROM image_variants WHERE subject_column = 'image'");
  const sheet = await one(pool, "SELECT * FROM image_variants WHERE subject_column = 'sprite'");
  assert.strictEqual(img.original_key, null, 'not bound to unrelated art');
  assert.strictEqual(sheet.original_key, null);
  const def = { image: 'sx/tgt.png', sprite: tgtSprite };
  assert.strictEqual(webArt(await getServeMap(pool, store), def), def, 'players get the target\'s own original');
  // The unbindable seeded rows are git's own: no phantom diff.
  const d = await diffGroup(pool, 'sx_iv');
  assert.deepStrictEqual(d.rows.filter((r) => r.table === 'image_variants').map((r) => r.kind), []);
  // Auto-shrink may replace an unbindable seeded copy with this PC's own.
  const work = await findAutoShrinkWork(pool, store, { only: (s) => s.key === ENT });
  assert.deepStrictEqual(work.map((w) => w.subject.column).sort(), ['image', 'sprite']);
  assert.deepStrictEqual(work.find((w) => w.subject.column === 'image').params, { maxEdge: 48, quality: 80 });
});

dbTest('a seeded variant binds to the matching seeded art, is served at once, and shows no diff after', async (t, pool) => {
  const { SRC, SRC_ATLAS, SRC_MAN, srcSprite, store } = await sourceFixture(pool);
  await exportGroup(pool, 'sx_iv', { store });
  await forgetVariants(pool);
  // The target got the same art through the seed: content-addressed keys.
  const tgtImage = `${BUCKET}/seedsync/${sha256(SRC)}/textures_entities_${ENT}.png`;
  const tgtSprite = {
    ...srcSprite,
    atlas_key: `${BUCKET}/seedsync/${sha256(SRC_ATLAS)}/textures_sprites_${ENT}.atlas.png`,
    manifest_key: `${BUCKET}/seedsync/${sha256(SRC_MAN)}/textures_sprites_${ENT}.manifest.json`,
  };
  store.objects.set(tgtImage, SRC);
  store.objects.set(tgtSprite.atlas_key, SRC_ATLAS);
  store.objects.set(tgtSprite.manifest_key, SRC_MAN);
  await pool.query('UPDATE entity_types SET image = $2, sprite = $3 WHERE name = $1', [ENT, tgtImage, JSON.stringify(tgtSprite)]);

  // A serve map cached before the seed must not hide the seeded copies.
  assert.strictEqual((await getServeMap(pool, store)).get(tgtImage), undefined);
  await apply(pool, 'sx_iv', {}, { store });
  const map = await getServeMap(pool, store); // apply bound them; the map itself never binds
  const img = await one(pool, "SELECT * FROM image_variants WHERE subject_column = 'image'");
  const sheet = await one(pool, "SELECT * FROM image_variants WHERE subject_column = 'sprite'");
  assert.strictEqual(img.original_key, tgtImage);
  assert.strictEqual(img.original_etag, md5(SRC));
  assert.strictEqual(sheet.original_key, tgtSprite.atlas_key);
  assert.strictEqual(sheet.original_manifest_key, tgtSprite.manifest_key);
  assert.strictEqual(sheet.original_manifest_etag, md5(SRC_MAN));
  const served = webArt(map, { image: tgtImage, sprite: tgtSprite });
  assert.strictEqual(served.image, img.web_key);
  assert.deepStrictEqual(served.sprite, { ...tgtSprite, ...sheet.web_sprite });
  assert.strictEqual(img.original_bytes, SRC.length, 'bind records the target original size');
  // Binding is local state: the seeded rows still read as in sync, not edited here.
  const d = await diffGroup(pool, 'sx_iv');
  assert.deepStrictEqual(d.rows.filter((r) => r.table === 'image_variants').map((r) => r.kind), []);
});

dbTest('only copies fresh on the source are exported (stale, undone, unbound are skipped)', async (t, pool) => {
  const { store } = await sourceFixture(pool);
  // The image's original was rewritten under the same key (etag differs): stale.
  store.objects.set('sx/src.png', await png(96, 64, 11));
  // The sheet was undone.
  await pool.query("UPDATE image_variants SET active = false WHERE subject_column = 'sprite'");
  // An unbound row with no source sha (cannot name its art) for another subject.
  await pool.query(`INSERT INTO entity_types (name, color, image) VALUES ($1, '#000000', 'sx/src.png')`, [`${ENT}_2`]);
  await pool.query(`INSERT INTO image_variants (subject_table, subject_key, subject_column, web_key, params)
                    VALUES ('entity_types', $1, 'image', $2, '{"maxEdge":48,"quality":80}')`,
  [`${ENT}_2`, (await one(pool, "SELECT web_key FROM image_variants WHERE subject_column = 'image'")).web_key]);
  await exportGroup(pool, 'sx_iv', { store });
  assert.deepStrictEqual(readDoc('sx_iv').tables.image_variants, [], 'nothing stale, undone or unbound travels');
  assert.ok((await one(pool, "SELECT stale_at FROM image_variants WHERE subject_key = $1 AND subject_column = 'image'", [ENT])).stale_at,
    'the export marked the rewritten original stale');
  // And the Seed tab agrees with the file: nothing to export, nothing from git.
  const d = await diffGroup(pool, 'sx_iv');
  assert.deepStrictEqual(d.rows.filter((r) => r.table === 'image_variants').map((r) => r.kind), []);
});

// A bound copy without a source sha (shrunk after the export stamped, or its
// subject file could not be read) never travels: a target could not bind it.
dbTest('a bound row with no source sha is not exported', async (t, pool) => {
  const { store } = await sourceFixture(pool);
  // The image's original cannot be read: the stamp cannot name its file.
  store.objects.delete('sx/src.png');
  await exportGroup(pool, 'sx_iv', { store });
  const img = await one(pool, "SELECT * FROM image_variants WHERE subject_column = 'image'");
  assert.ok(img.original_key && img.active && !img.stale_at, 'bound, active, unmarked');
  assert.strictEqual(img.source_asset_sha256, null);
  assert.deepStrictEqual(readDoc('sx_iv').tables.image_variants.map((r) => r.subject_column), ['sprite']);
  const d = await diffGroup(pool, 'sx_iv');
  assert.deepStrictEqual(d.rows.filter((r) => r.table === 'image_variants').map((r) => r.kind), []);
  // The export already tried it: not "waiting for export" forever.
  assert.strictEqual(d.pendingWebCopies, 0);
  assert.strictEqual(d.status, 'in_sync');
});

// The Seed tab must not read "in sync" while copies shrunk here wait for an
// export (their sha is stamped only BY the export, so the row diff cannot see
// them): they count as local edits until an export has checked them.
dbTest('copies shrunk since the last export show as local edits until exported', async (t, pool) => {
  const { store, webKey } = await sourceFixture(pool);
  let d = await diffGroup(pool, 'sx_iv');
  assert.strictEqual(d.status, 'never_exported');
  await exportGroup(pool, 'sx_iv', { store });
  d = await diffGroup(pool, 'sx_iv');
  assert.strictEqual(d.pendingWebCopies, 0);
  assert.strictEqual(d.status, 'in_sync');
  // A first shrink here of another subject (what shrinkSubject writes: bound,
  // active, sha NULL). Not in git and filtered out of the row diff.
  await pool.query(`INSERT INTO entity_types (name, color, image) VALUES ($1, '#000000', 'sx/src.png')`, [`${ENT}_2`]);
  await pool.query(`INSERT INTO image_variants (subject_table, subject_key, subject_column, original_key, original_etag,
                                                web_key, params, updated_at)
                    VALUES ('entity_types', $1, 'image', 'sx/src.png', 'e', $2, '{"maxEdge":48,"quality":80}',
                            now() + interval '1 second')`, [`${ENT}_2`, webKey]);
  d = await diffGroup(pool, 'sx_iv');
  assert.strictEqual(d.pendingWebCopies, 1);
  assert.strictEqual(d.status, 'local_edits');
  assert.strictEqual(d.localEdits, 1);
  // Undone or stale copies never travel, so they are not waiting.
  await pool.query('UPDATE image_variants SET stale_at = now() WHERE subject_key = $1', [`${ENT}_2`]);
  assert.strictEqual((await diffGroup(pool, 'sx_iv')).pendingWebCopies, 0);
  await pool.query('UPDATE image_variants SET stale_at = NULL WHERE subject_key = $1', [`${ENT}_2`]);
  // A re-shrink of a copy already in git: the row diff lists it; counted once.
  await pool.query(`UPDATE image_variants SET source_asset_sha256 = NULL, updated_at = now() + interval '1 second'
                    WHERE subject_key = $1 AND subject_column = 'image'`, [ENT]);
  d = await diffGroup(pool, 'sx_iv');
  assert.strictEqual(d.pendingWebCopies, 1);
  assert.strictEqual(d.localEdits, 2);
  // An export checks them all: nothing waits afterwards.
  await exportGroup(pool, 'sx_iv', { store });
  d = await diffGroup(pool, 'sx_iv');
  assert.strictEqual(d.pendingWebCopies, 0);
  assert.strictEqual(d.status, 'in_sync');
});

dbTest('a seed that rewrites a variant re-binds it to the target\'s current original', async (t, pool) => {
  const { store, SRC } = await sourceFixture(pool);
  await exportGroup(pool, 'sx_iv', { store });
  const TGT = `${BUCKET}/seedsync/${sha256(SRC)}/textures_entities_${ENT}.png`;
  store.objects.set(TGT, SRC);
  await pool.query('UPDATE entity_types SET image = $2 WHERE name = $1', [ENT, TGT]);
  // The local row is bound to an original the column no longer holds (stale).
  await pool.query("UPDATE image_variants SET original_key = 'sx/old.png', original_etag = 'old' WHERE subject_column = 'image'");
  const doc = readDoc('sx_iv');
  const git = doc.tables.image_variants.find((r) => r.subject_column === 'image');
  git.params = { maxEdge: 40, quality: 70 };
  writeDoc('sx_iv', doc);
  const row = (await previewSeed(pool, 'sx_iv')).rows.find((r) => r.syncUuid === git.sync_uuid);
  assert.ok(row, 'the changed variant is in the preview');
  assert.strictEqual(row.kind, 'changed');
  await apply(pool, 'sx_iv', { [row.syncUuid]: 'git' }, { store });
  const after = await one(pool, "SELECT * FROM image_variants WHERE subject_column = 'image'");
  assert.deepStrictEqual(after.params, { maxEdge: 40, quality: 70 });
  assert.notStrictEqual(after.original_key, 'sx/old.png');
  const bound = await one(pool, "SELECT * FROM image_variants WHERE subject_column = 'image'");
  assert.strictEqual(bound.original_key, TGT, 'git\'s variant replaces the local binding; apply re-binds it');
  assert.strictEqual(after.web_key, bound.web_key);
  const map = await getServeMap(pool, store);
  assert.strictEqual(map.get(TGT).web_key, bound.web_key);
});
