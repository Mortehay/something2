// Image shrink Task 3: catalog, shrink/undo service, serve map. Real private
// database (TEST_DATABASE_URL only -- never the dev DB) and an in-memory fake
// object store holding real PNG bytes made with sharp. Rows this file creates
// are named with PREFIX and removed before and after every case.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to touch a real database' : false;

const {
  listImages, shrinkSubject, undoSubject, reactivateSubject, getServeMap, invalidateServeMap, webArt,
} = require('../src/services/imageVariants.js');
const { imageColumns, defaultParams } = require('../src/services/imageCatalog.js');

const PREFIX = 'imgshrink-t3-';
const IMG = `${PREFIX}img`;
const TINY = `${PREFIX}tiny`;
const SHEET = `${PREFIX}sheet`;
const MANIFEST = { cell: [96, 128], frames: { 'idle/s/0': [0, 0, 96, 128], 'idle/s/1': [96, 0, 96, 128] }, quality: [{ x: 1 }] };

function fakeStore(objects) {
  const store = {
    objects: new Map(objects),
    puts: [],
    async statObject(key) {
      const b = store.objects.get(key);
      return b ? { size: b.length, etag: crypto.createHash('md5').update(b).digest('hex') } : null;
    },
    async readObject(key) {
      if (!store.objects.has(key)) {
        const e = new Error(`The specified key does not exist: ${key}`);
        e.code = 'NoSuchKey';
        throw e;
      }
      return store.objects.get(key);
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

// Random pixels: PNG cannot compress them, so the file is big.
function noisePng(width, height) {
  const raw = crypto.randomBytes(width * height * 4);
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
function solidPng(width, height, rgb = { r: 200, g: 40, b: 40 }) {
  return sharp({ create: { width, height, channels: 4, background: { ...rgb, alpha: 1 } } }).png().toBuffer();
}

async function cleanup(pool) {
  await pool.query('DELETE FROM image_operations WHERE subject_key LIKE $1', [`${PREFIX}%`]);
  await pool.query('DELETE FROM image_variants WHERE subject_key LIKE $1', [`${PREFIX}%`]);
  await pool.query('DELETE FROM entity_types WHERE name LIKE $1', [`${PREFIX}%`]);
}

// Fresh rows + store for one case.
async function fixture(pool) {
  await cleanup(pool);
  invalidateServeMap();
  const store = fakeStore([
    ['t3/img.png', await noisePng(600, 400)],
    ['t3/tiny.png', await solidPng(8, 8)],
    ['t3/sheet.png', await solidPng(192, 128)],
    ['t3/sheet.json', Buffer.from(JSON.stringify(MANIFEST))],
  ]);
  const sprite = { atlas_key: 't3/sheet.png', manifest_key: 't3/sheet.json', fps: 8 };
  await pool.query(`INSERT INTO entity_types (name, color, image) VALUES ($1, '#000000', 't3/img.png'),
                    ($2, '#000000', 't3/tiny.png')`, [IMG, TINY]);
  await pool.query(`INSERT INTO entity_types (name, color, sprite) VALUES ($1, '#000000', $2::jsonb)`,
    [SHEET, JSON.stringify(sprite)]);
  return { store, sprite };
}

const subj = (key, column = 'image') => ({ table: 'entity_types', key, column });
const ops = async (pool, key) => (await pool.query(
  'SELECT * FROM image_operations WHERE subject_key = $1 ORDER BY id', [key])).rows;
const variantOf = async (pool, key, column = 'image') => (await pool.query(
  'SELECT * FROM image_variants WHERE subject_table = $1 AND subject_key = $2 AND subject_column = $3',
  ['entity_types', key, column])).rows[0];
const mine = (rows) => rows.filter((r) => r.subject.key.startsWith(PREFIX));

test('image catalog (pure)', async (t) => {
  await t.test('imageColumns walks the registry art group', () => {
    const cols = imageColumns();
    const find = (table, column) => cols.find((c) => c.table === table && c.column === column);
    assert.deepEqual(find('entity_types', 'image'), { table: 'entity_types', column: 'image', assetType: 'image', strip: false, kind: 'entity' });
    assert.deepEqual(find('entity_types', 'sprite'), { table: 'entity_types', column: 'sprite', assetType: 'sprite', strip: false, kind: 'entity_sheet' });
    assert.equal(find('tile_types', 'sprite').kind, 'tile_sheet');
    assert.equal(find('character_appearances', 'image').kind, 'appearance');
    assert.equal(find('item_types', 'icon').kind, 'item');
    assert.equal(find('catalog_art', 'image').kind, 'art');
    const vfx = find('vfx_effects', 'sprite_image');
    assert.equal(vfx.kind, 'effect:vfx_effects');
    assert.equal(vfx.strip, true);
    for (const t2 of ['aura_effects', 'buff_visuals', 'status_visuals']) assert.equal(find(t2, 'sprite_image').strip, true);
    assert.ok(!cols.some((c) => c.table === 'image_variants'), 'web copies are not game images');
  });

  await t.test('defaultParams per Global Constraints', () => {
    assert.deepEqual(defaultParams('entity'), { maxEdge: 256, quality: 85 });
    assert.deepEqual(defaultParams('tile'), { maxEdge: 256, quality: 85 });
    assert.deepEqual(defaultParams('appearance'), { maxEdge: 384, quality: 85 });
    assert.deepEqual(defaultParams('item'), { maxEdge: 128, quality: 85 });
    assert.deepEqual(defaultParams('art:skill'), { maxEdge: 128, quality: 85 });
    assert.deepEqual(defaultParams('art:passive_label'), { maxEdge: 128, quality: 85 });
    assert.deepEqual(defaultParams('art:character_appearance'), { maxEdge: 256, quality: 85 });
    assert.deepEqual(defaultParams('entity_sheet'), { scale: 1, quality: 85 });
    assert.deepEqual(defaultParams('effect:vfx_effects'), { scale: 1, quality: 85 });
  });

  await t.test('webArt leaves an unmapped def as the same object', () => {
    const def = { image: 'a.png', sprite: { atlas_key: 'b.png', manifest_key: 'b.json' } };
    assert.equal(webArt(new Map(), def), def);
    assert.equal(webArt(new Map(), null), null);
  });

  await t.test('webArt swaps icon and sprite_image too', () => {
    const map = new Map([['i.png', { web_key: 'i.webp' }], ['s.png', { web_key: 's.webp' }]]);
    const def = { icon: 'i.png', sprite_image: 's.png', name: 'x' };
    assert.deepEqual(webArt(map, def), { icon: 'i.webp', sprite_image: 's.webp', name: 'x' });
    assert.equal(def.icon, 'i.png', 'input not mutated');
  });
});

test('image variants (db)', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 4 });
  t.after(async () => { await cleanup(pool).catch(() => {}); await pool.end(); });

  await t.test('shrink writes a webp, keeps the column, logs ok', async () => {
    const { store } = await fixture(pool);
    const before = Buffer.from(store.objects.get('t3/img.png'));
    const op = await shrinkSubject(pool, store, subj(IMG), null, { actor: null, batchId: null });
    assert.equal(op.op, 'shrink');
    assert.equal(op.status, 'ok', op.error);
    assert.match(op.web_key, /^seedsync\/[0-9a-f]{64}\/img\.webp$/);
    const web = store.objects.get(op.web_key);
    assert.ok(web, 'web copy written');
    assert.equal(web.subarray(8, 12).toString('latin1'), 'WEBP');
    assert.equal(op.web_key.split('/')[1], crypto.createHash('sha256').update(web).digest('hex'));
    assert.equal(store.puts.find((p) => p.key === op.web_key).contentType, 'image/webp');
    const meta = await sharp(web).metadata();
    assert.deepEqual([meta.width, meta.height], [256, 171]);
    assert.ok(before.equals(store.objects.get('t3/img.png')), 'original bytes untouched');
    assert.ok(!store.puts.some((p) => p.key === 't3/img.png'), 'original never written');
    const row = (await pool.query('SELECT image FROM entity_types WHERE name = $1', [IMG])).rows[0];
    assert.equal(row.image, 't3/img.png', 'column keeps the original key');
    const logged = await ops(pool, IMG);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].op, 'shrink');
    assert.equal(logged[0].status, 'ok');
    assert.equal(logged[0].original_key, 't3/img.png');
    assert.equal(logged[0].bytes_before, before.length);
    assert.equal(logged[0].bytes_after, web.length);
    const v = await variantOf(pool, IMG);
    assert.equal(v.active, true);
    assert.equal(v.original_key, 't3/img.png');
    assert.equal(v.original_etag, (await store.statObject('t3/img.png')).etag);
    assert.equal(v.web_key, op.web_key);
    assert.deepEqual(v.params, { maxEdge: 256, quality: 85 });
    assert.deepEqual([v.original_width, v.original_height, v.web_width, v.web_height], [600, 400, 256, 171]);
  });

  await t.test('serve map swaps only active variants', async () => {
    const { store } = await fixture(pool);
    const op = await shrinkSubject(pool, store, subj(IMG), null, {});
    invalidateServeMap();
    const def = { name: IMG, image: 't3/img.png' };
    const swapped = webArt(await getServeMap(pool, store), def);
    assert.equal(swapped.image, op.web_key);
    assert.equal(swapped.name, IMG);
    assert.equal(def.image, 't3/img.png', 'def not mutated');

    const undo = await undoSubject(pool, subj(IMG), { actor: null, batchId: null });
    assert.equal(undo.op, 'undo');
    assert.equal(undo.status, 'ok');
    assert.equal((await variantOf(pool, IMG)).active, false);
    assert.ok(store.objects.has(op.web_key), 'undo keeps the web copy');
    invalidateServeMap();
    assert.equal(webArt(await getServeMap(pool, store), def), def);

    const re = await reactivateSubject(pool, store, subj(IMG), {});
    assert.equal(re.op, 'reactivate');
    assert.equal(re.status, 'ok');
    invalidateServeMap();
    assert.equal(webArt(await getServeMap(pool, store), def).image, op.web_key);
  });

  await t.test('stale when original rewritten under same key', async () => {
    const { store } = await fixture(pool);
    await shrinkSubject(pool, store, subj(IMG), null, {});
    store.objects.set('t3/img.png', await noisePng(600, 400)); // same key, new bytes -> new etag
    invalidateServeMap();
    const listed = mine(await listImages(pool, store, { kind: 'entity' })).find((r) => r.subject.key === IMG);
    assert.equal(listed.state, 'stale');
    const def = { image: 't3/img.png' };
    assert.equal(webArt(await getServeMap(pool, store), def), def, 'players get the new original, never old art');
    const re = await reactivateSubject(pool, store, subj(IMG), {});
    assert.equal(re.status, 'failed');
    assert.equal(re.error, 'stale');
    // Re-shrink clears it.
    await shrinkSubject(pool, store, subj(IMG), null, {});
    const after = mine(await listImages(pool, store, { kind: 'entity' })).find((r) => r.subject.key === IMG);
    assert.equal(after.state, 'shrunk');
  });

  await t.test('stale when column points elsewhere', async () => {
    const { store } = await fixture(pool);
    await shrinkSubject(pool, store, subj(IMG), null, {});
    store.objects.set('t3/other.png', await solidPng(50, 50));
    await pool.query("UPDATE entity_types SET image = 't3/other.png' WHERE name = $1", [IMG]);
    invalidateServeMap();
    const listed = mine(await listImages(pool, store, {})).find((r) => r.subject.key === IMG);
    assert.equal(listed.state, 'stale');
    assert.equal(listed.original_key, 't3/other.png');
    const map = await getServeMap(pool, store);
    assert.ok(!map.has('t3/img.png'), 'old key no longer served a web copy');
    const def = { image: 't3/other.png' };
    assert.equal(webArt(map, def), def);
  });

  await t.test('sheet refusal logs failed, writes nothing', async () => {
    const { store } = await fixture(pool);
    const op = await shrinkSubject(pool, store, subj(SHEET, 'sprite'), { scale: 0.3 }, {});
    assert.equal(op.op, 'shrink');
    assert.equal(op.status, 'failed');
    assert.equal(op.error, 'fractional_cell');
    assert.equal(store.puts.length, 0, 'no objects written');
    assert.equal(await variantOf(pool, SHEET, 'sprite'), undefined, 'no variant row');
    const logged = await ops(pool, SHEET);
    assert.deepEqual(logged.map((o) => [o.op, o.status]), [['shrink', 'failed']]);
  });

  await t.test('bad params and a missing original log failed without throwing', async () => {
    const { store } = await fixture(pool);
    for (const params of [{ scale: 0 }, { scale: 1.5 }, { scale: Number.NaN }, { scale: 0.5, quality: 0 }]) {
      const op = await shrinkSubject(pool, store, subj(SHEET, 'sprite'), params, {});
      assert.equal(op.status, 'failed', JSON.stringify(params));
      assert.equal(op.error, 'bad_params', JSON.stringify(params));
    }
    for (const params of [{ maxEdge: 1.5 }, { maxEdge: -4 }, { maxEdge: 128, quality: 101 }, { maxEdge: 128, quality: 8.5 }]) {
      const op = await shrinkSubject(pool, store, subj(IMG), params, {});
      assert.equal(op.error, 'bad_params', JSON.stringify(params));
    }
    // R8: a supplied params object must carry the field that applies to the subject.
    const noEdge = await shrinkSubject(pool, store, subj(IMG), { scale: 0.5 }, {});
    assert.equal(noEdge.error, 'bad_params', 'single image with scale but no maxEdge');
    const noScale = await shrinkSubject(pool, store, subj(SHEET, 'sprite'), { maxEdge: 128 }, {});
    assert.equal(noScale.error, 'bad_params', 'sheet with maxEdge but no scale');
    assert.equal(store.puts.length, 0, 'refusals write nothing');
    assert.equal(await variantOf(pool, IMG), undefined);
    assert.equal(await variantOf(pool, SHEET, 'sprite'), undefined);
    store.objects.delete('t3/tiny.png');
    const miss = await shrinkSubject(pool, store, subj(TINY), null, {});
    assert.equal(miss.status, 'failed');
    assert.equal(miss.error, 'missing_original');
    assert.equal(store.puts.length, 0);
    await assert.rejects(shrinkSubject(pool, store, { table: 'entity_types', key: IMG, column: 'nope' }, null, {}),
      /entity_types\.nope is not an image column/);
  });

  await t.test('sheet shrink serves new atlas and manifest', async () => {
    const { store, sprite } = await fixture(pool);
    const op = await shrinkSubject(pool, store, subj(SHEET, 'sprite'), { scale: 0.5 }, {});
    assert.equal(op.status, 'ok', op.error);
    const v = await variantOf(pool, SHEET, 'sprite');
    assert.equal(v.web_key, null);
    assert.match(v.web_sprite.atlas_key, /^seedsync\/[0-9a-f]{64}\/sheet\.webp$/);
    assert.match(v.web_sprite.manifest_key, /^seedsync\/[0-9a-f]{64}\/manifest\.json$/);
    const manBuf = store.objects.get(v.web_sprite.manifest_key);
    assert.equal(v.web_sprite.manifest_key.split('/')[1], crypto.createHash('sha256').update(manBuf).digest('hex'));
    assert.equal(store.puts.find((p) => p.key === v.web_sprite.manifest_key).contentType, 'application/json');
    const man = JSON.parse(manBuf.toString('utf8'));
    assert.deepEqual(man.cell, [48, 64]);
    assert.deepEqual(man.frames, { 'idle/s/0': [0, 0, 48, 64], 'idle/s/1': [48, 0, 48, 64] });
    assert.deepEqual(man.quality, [{ x: 1 }]);
    const meta = await sharp(store.objects.get(v.web_sprite.atlas_key)).metadata();
    assert.deepEqual([meta.width, meta.height], [96, 64]);

    invalidateServeMap();
    const def = { name: SHEET, sprite };
    const out = webArt(await getServeMap(pool, store), def);
    assert.deepEqual(out.sprite, { atlas_key: v.web_sprite.atlas_key, manifest_key: v.web_sprite.manifest_key, fps: 8 });
    assert.equal(def.sprite.atlas_key, 't3/sheet.png', 'def.sprite not mutated');
  });

  await t.test('listImages filters', async () => {
    const { store } = await fixture(pool);
    const all = mine(await listImages(pool, store, {}));
    const byKey = (rows, key, column) => rows.find((r) => r.subject.key === key && r.subject.column === column);
    const img = byKey(all, IMG, 'image');
    assert.equal(img.kind, 'entity');
    assert.equal(img.label, IMG);
    assert.equal(img.state, 'original');
    assert.equal(img.variant, null);
    assert.equal(img.manifest_key, null);
    assert.equal(img.bytes, store.objects.get('t3/img.png').length);
    const sheet = byKey(all, SHEET, 'sprite');
    assert.equal(sheet.kind, 'entity_sheet');
    assert.equal(sheet.original_key, 't3/sheet.png');
    assert.equal(sheet.manifest_key, 't3/sheet.json');

    const ents = mine(await listImages(pool, store, { kind: 'entity' }));
    assert.deepEqual(ents.map((r) => r.subject.key).sort(), [IMG, TINY]);
    assert.ok(ents.every((r) => r.kind === 'entity'));

    const big = mine(await listImages(pool, store, { minBytes: 10000 }));
    assert.ok(big.some((r) => r.subject.key === IMG));
    assert.ok(!big.some((r) => r.subject.key === TINY), 'small excluded');

    await shrinkSubject(pool, store, subj(IMG), null, {});
    await shrinkSubject(pool, store, subj(TINY), null, {});
    await undoSubject(pool, subj(TINY), {});
    await shrinkSubject(pool, store, subj(SHEET, 'sprite'), null, {});
    store.objects.set('t3/sheet.png', await solidPng(192, 128, { r: 1, g: 2, b: 3 })); // sheet now stale
    const shrunk = mine(await listImages(pool, store, { state: 'shrunk' }));
    assert.deepEqual(shrunk.map((r) => r.subject.key), [IMG]);
    assert.equal(shrunk[0].variant.active, true);
    const undone = mine(await listImages(pool, store, { state: 'undone' }));
    assert.deepEqual(undone.map((r) => r.subject.key), [TINY]);
    const stale = mine(await listImages(pool, store, { state: 'stale' }));
    assert.deepEqual(stale.map((r) => r.subject.key), [SHEET]);
  });

  await t.test('extra inapplicable params are ignored', async () => {
    const { store } = await fixture(pool);
    const op = await shrinkSubject(pool, store, subj(SHEET, 'sprite'), { scale: 0.5, maxEdge: 999 }, {});
    assert.equal(op.status, 'ok', op.error);
    assert.deepEqual(op.params, { scale: 0.5, quality: 85 });
    const img = await shrinkSubject(pool, store, subj(IMG), { maxEdge: 100, scale: 0.3 }, {});
    assert.equal(img.status, 'ok', img.error);
    assert.deepEqual(img.params, { maxEdge: 100, quality: 85 });
  });

  await t.test('subjects sharing one original: latest active variant is served (R7)', async () => {
    const { store } = await fixture(pool);
    const IMG2 = `${PREFIX}img2`;
    await pool.query(`INSERT INTO entity_types (name, color, image) VALUES ($1, '#000000', 't3/img.png')`, [IMG2]);
    const a = await shrinkSubject(pool, store, subj(IMG), { maxEdge: 200 }, {});
    const b = await shrinkSubject(pool, store, subj(IMG2), { maxEdge: 100 }, {});
    assert.notEqual(a.web_key, b.web_key);
    invalidateServeMap();
    assert.equal(webArt(await getServeMap(pool, store), { image: 't3/img.png' }).image, b.web_key, 'later shrink wins');
    let rows = mine(await listImages(pool, store, { kind: 'entity' }));
    assert.equal(rows.find((r) => r.subject.key === IMG).served_by.key, IMG2);
    assert.equal(rows.find((r) => r.subject.key === IMG2).served_by, null);

    await undoSubject(pool, subj(IMG2), {});
    invalidateServeMap();
    assert.equal(webArt(await getServeMap(pool, store), { image: 't3/img.png' }).image, a.web_key, 'earlier copy served');
    rows = mine(await listImages(pool, store, { kind: 'entity' }));
    const undone = rows.find((r) => r.subject.key === IMG2);
    assert.equal(undone.state, 'undone');
    assert.deepEqual(undone.served_by, subj(IMG));
    assert.equal(rows.find((r) => r.subject.key === IMG).served_by, null);
    assert.equal(rows.find((r) => r.subject.key === TINY).served_by, null);
  });

  await t.test('sheet goes stale when only its manifest changes (R5)', async () => {
    const { store, sprite } = await fixture(pool);
    await shrinkSubject(pool, store, subj(SHEET, 'sprite'), { scale: 0.5 }, {});
    const v = await variantOf(pool, SHEET, 'sprite');
    assert.equal(v.original_manifest_key, 't3/sheet.json');
    assert.equal(v.original_manifest_etag, (await store.statObject('t3/sheet.json')).etag);
    store.objects.set('t3/sheet.json', Buffer.from(JSON.stringify({ ...MANIFEST, rows: ['s'] })));
    invalidateServeMap();
    const listed = mine(await listImages(pool, store, {})).find((r) => r.subject.key === SHEET);
    assert.equal(listed.state, 'stale');
    const def = { sprite };
    assert.equal(webArt(await getServeMap(pool, store), def), def, 'players get the original sprite');
    assert.equal((await reactivateSubject(pool, store, subj(SHEET, 'sprite'), {})).error, 'stale');
  });

  await t.test('sheet goes stale when the column points at another manifest', async () => {
    const { store, sprite } = await fixture(pool);
    await shrinkSubject(pool, store, subj(SHEET, 'sprite'), { scale: 0.5 }, {});
    store.objects.set('t3/sheet2.json', Buffer.from(JSON.stringify(MANIFEST)));
    const moved = { ...sprite, manifest_key: 't3/sheet2.json' };
    await pool.query('UPDATE entity_types SET sprite = $2::jsonb WHERE name = $1', [SHEET, JSON.stringify(moved)]);
    invalidateServeMap();
    const listed = mine(await listImages(pool, store, {})).find((r) => r.subject.key === SHEET);
    assert.equal(listed.state, 'stale');
    assert.equal(webArt(await getServeMap(pool, store), { sprite: moved }).sprite, moved);
  });

  await t.test('binding a seeded sheet variant records the manifest too', async () => {
    const { store, sprite } = await fixture(pool);
    await pool.query(`INSERT INTO image_variants (subject_table, subject_key, subject_column, web_sprite, params)
                      VALUES ('entity_types', $1, 'sprite', '{"atlas_key":"seedsync/x/sheet.webp","manifest_key":"seedsync/y/manifest.json"}',
                              '{"scale":1,"quality":85}')`, [SHEET]);
    invalidateServeMap();
    const out = webArt(await getServeMap(pool, store), { sprite });
    assert.equal(out.sprite.atlas_key, 'seedsync/x/sheet.webp');
    const v = await variantOf(pool, SHEET, 'sprite');
    assert.equal(v.original_key, 't3/sheet.png');
    assert.equal(v.original_manifest_key, 't3/sheet.json');
    assert.equal(v.original_manifest_etag, (await store.statObject('t3/sheet.json')).etag);
  });

  await t.test('serve map binds an unbound (seeded) variant to the current original', async () => {
    const { store } = await fixture(pool);
    store.objects.set('seedsync/abc/img.webp', await sharp(await solidPng(10, 10)).webp().toBuffer());
    await pool.query(`INSERT INTO image_variants (subject_table, subject_key, subject_column, web_key, params)
                      VALUES ('entity_types', $1, 'image', 'seedsync/abc/img.webp', '{"maxEdge":256,"quality":85}')`, [IMG]);
    invalidateServeMap();
    const map = await getServeMap(pool, store);
    assert.equal(webArt(map, { image: 't3/img.png' }).image, 'seedsync/abc/img.webp');
    const v = await variantOf(pool, IMG);
    assert.equal(v.original_key, 't3/img.png');
    assert.equal(v.original_etag, (await store.statObject('t3/img.png')).etag);
    const listed = mine(await listImages(pool, store, { kind: 'entity' })).find((r) => r.subject.key === IMG);
    assert.equal(listed.state, 'shrunk');
  });
});
