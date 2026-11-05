// SOMET-734. `seed-art.js --kind=sprites`: the 13 committed animation sheets reach the object store and the
// `sprite` columns, and nothing else changes. Scratch database, in-memory store, temp repo root.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { Pool } = require('pg');

const { seedSprites } = require('../src/services/spriteSeed.js');
const { parseArgs } = require('../src/services/artSeed.js');

const DB_URL = process.env.TEST_DATABASE_URL;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const P = `sps${process.pid}`;

function memStore() {
  const objects = new Map();
  return {
    objects,
    puts: [],
    BUCKET: () => 'sprites',
    async ensureBucket() {},
    async putObject(key, buf) { this.puts.push(key); objects.set(key, Buffer.from(buf)); return key; },
    async objectExists(key) { return objects.has(key); },
    async getObjectStream(key) { if (!objects.has(key)) throw new Error('no such key'); return Readable.from([objects.get(key)]); },
  };
}

function dbTest(name, body) {
  test(name, async (t) => {
    if (!DB_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping (sprite seed)';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    const pool = new Pool({ connectionString: DB_URL, max: 2 });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-seed-'));
    t.after(async () => {
      await pool.query('DELETE FROM seed_asset_hashes WHERE object_key LIKE $1', [`%${P}%`]);
      await pool.query('DELETE FROM character_appearances WHERE entity_type_id IN (SELECT id FROM entity_types WHERE name LIKE $1)', [`${P}%`]);
      await pool.query('DELETE FROM entity_types WHERE name LIKE $1', [`${P}%`]);
      await pool.end();
      fs.rmSync(root, { recursive: true, force: true });
    });
    await body({ pool, root });
  });
}

// A repo root with sync/art.json and the sheet files; returns what the rows should end up as.
function fixture(root, { names }) {
  const dir = (d) => { fs.mkdirSync(path.join(root, d), { recursive: true }); return d; };
  const files = {};
  const sprite = (kind, base) => {
    const d = dir(`textures/sprites/${kind}`);
    const atlas = Buffer.from(`atlas-${base}`);
    const manifest = Buffer.from(JSON.stringify({ version: 1, base }));
    fs.writeFileSync(path.join(root, d, `${base}.atlas.png`), atlas);
    fs.writeFileSync(path.join(root, d, `${base}.manifest.json`), manifest);
    files[base] = { atlas, manifest };
    return {
      atlas: { file: `${d}/${base}.atlas.png`, sha256: sha(atlas) },
      manifest: { file: `${d}/${base}.manifest.json`, sha256: sha(manifest) },
      static_frame: 'idle/s/0',
    };
  };
  const entityUuid = {};
  const entities = names.map((n) => {
    entityUuid[n] = crypto.randomUUID();
    const base = n.replace(/ /g, '_');
    return { name: n, sync_uuid: entityUuid[n], sprite: sprite('entity_types', base), render_mode: 'static', image: null };
  });
  // one entity with no sheet, and one appearance sheet for the first entity
  const plain = { name: `${P} plain`, sync_uuid: crypto.randomUUID(), sprite: null, render_mode: 'static', image: null };
  const looks = [{ entity_type_id: entityUuid[names[0]], variant: 2, label: 'Appearance 2', sprite: sprite('character_appearances', `${names[0].replace(/ /g, '_')}_2`), render_mode: 'static', image: null, sync_uuid: crypto.randomUUID() }];
  const doc = { header: { group: 'art' }, tables: { entity_types: [...entities, plain], character_appearances: looks } };
  fs.mkdirSync(path.join(root, 'sync'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sync/art.json'), JSON.stringify(doc));
  return { files, entities, looks, plain };
}

const opts = (root, store, pool, extra = {}) => ({ db: pool, store, root, syncFile: path.join(root, 'sync/art.json'), log: () => {}, ...extra });

async function addEntity(pool, name, sprite = null, extra = {}) {
  const r = await pool.query(
    `INSERT INTO entity_types (name, color, sprite, image, render_mode) VALUES ($1, '#222222', $2, $3, $4) RETURNING id`,
    [name, sprite ? JSON.stringify(sprite) : null, extra.image ?? null, extra.mode ?? 'static']);
  return r.rows[0].id;
}
const entityRow = async (pool, name) => (await pool.query('SELECT * FROM entity_types WHERE name = $1', [name])).rows[0];
const lookRow = async (pool, name, variant) => (await pool.query(
  'SELECT ca.* FROM character_appearances ca JOIN entity_types e ON e.id = ca.entity_type_id WHERE e.name = $1 AND ca.variant = $2', [name, variant])).rows[0];
const readKey = async (store, key) => {
  const chunks = [];
  for await (const c of await store.getObjectStream(key)) chunks.push(c);
  return Buffer.concat(chunks);
};

test('parseArgs: sprites is its own kind and is never part of the default run', () => {
  assert.deepStrictEqual(parseArgs([]).sprites, false);
  const only = parseArgs(['--kind=sprites']);
  assert.strictEqual(only.sprites, true);
  assert.deepStrictEqual(only.kinds, []);
  const mixed = parseArgs(['--kind=tile,sprites']);
  assert.strictEqual(mixed.sprites, true);
  assert.deepStrictEqual(mixed.kinds, ['tile']);
  assert.throws(() => parseArgs(['--kind=nope']), /unknown kind/);
});

dbTest('a creature without a sheet gets its atlas and manifest uploaded and linked; art around it stays', async ({ pool, root }) => {
  const names = [`${P} bat`];
  const fx = fixture(root, { names });
  const id = await addEntity(pool, names[0], null, { image: 'sprites/own/still.png', mode: 'static' });
  const other = await addEntity(pool, `${P} plain`, null, { image: 'keep.png' });
  const otherBefore = await entityRow(pool, `${P} plain`);
  const store = memStore();
  const out = await seedSprites(opts(root, store, pool));
  assert.strictEqual(out.entity_types.linked, 1);
  const row = await entityRow(pool, names[0]);
  assert.match(row.sprite.atlas_key, new RegExp(`^sprites/seedsync/${fx.entities[0].sprite.atlas.sha256}/`));
  assert.strictEqual(row.sprite.static_frame, 'idle/s/0');
  assert.deepStrictEqual(await readKey(store, row.sprite.atlas_key), fx.files[names[0].replace(/ /g, '_')].atlas);
  assert.deepStrictEqual(await readKey(store, row.sprite.manifest_key), fx.files[names[0].replace(/ /g, '_')].manifest);
  // the still and the render mode are not this seed's business
  assert.strictEqual(row.image, 'sprites/own/still.png');
  assert.strictEqual(row.render_mode, 'static');
  assert.strictEqual(row.id, id);
  assert.deepStrictEqual(await entityRow(pool, `${P} plain`), otherBefore);
  assert.ok(other);
  // and the cache the art group reads is filled, so its status does not call this a local edit
  const cached = await pool.query('SELECT file FROM seed_asset_hashes WHERE object_key = $1', [row.sprite.atlas_key]);
  assert.strictEqual(cached.rows[0].file, fx.entities[0].sprite.atlas.file);
});

dbTest('an appearance sheet goes to the right slot only, and no character or other slot is written', async ({ pool, root }) => {
  const names = [`${P} cultist`];
  fixture(root, { names });
  const id = await addEntity(pool, names[0]);
  for (const v of [1, 2, 3]) {
    await pool.query(`INSERT INTO character_appearances (entity_type_id, variant, label, image, render_mode) VALUES ($1, $2, $3, $4, 'static')`, [id, v, `Appearance ${v}`, `own/${v}.png`]);
  }
  const before = {
    one: await lookRow(pool, names[0], 1), three: await lookRow(pool, names[0], 3),
    characters: (await pool.query('SELECT count(*)::int AS n, md5(string_agg(c::text, \'|\' ORDER BY c.id)) AS h FROM characters c')).rows[0],
  };
  const out = await seedSprites(opts(root, memStore(), pool));
  assert.strictEqual(out.character_appearances.linked, 1);
  const two = await lookRow(pool, names[0], 2);
  assert.ok(two.sprite.atlas_key && two.sprite.manifest_key);
  assert.strictEqual(two.image, 'own/2.png');
  assert.deepStrictEqual(await lookRow(pool, names[0], 1), before.one);
  assert.deepStrictEqual(await lookRow(pool, names[0], 3), before.three);
  const after = (await pool.query('SELECT count(*)::int AS n, md5(string_agg(c::text, \'|\' ORDER BY c.id)) AS h FROM characters c')).rows[0];
  assert.deepStrictEqual(after, before.characters);
});

dbTest('a second run changes nothing: no uploads, no row writes', async ({ pool, root }) => {
  const names = [`${P} bat`, `${P} slime`];
  fixture(root, { names });
  for (const n of names) await addEntity(pool, n);
  const id0 = (await entityRow(pool, names[0])).id;
  await pool.query(`INSERT INTO character_appearances (entity_type_id, variant, label) VALUES ($1, 2, 'Appearance 2')`, [id0]);
  const store = memStore();
  await seedSprites(opts(root, store, pool));
  const snap = async () => JSON.stringify([await entityRow(pool, names[0]), await entityRow(pool, names[1]), await lookRow(pool, names[0], 2)]);
  const xmins = async () => (await pool.query(`SELECT string_agg(xmin::text, ',' ORDER BY id) AS x FROM entity_types WHERE name LIKE $1`, [`${P}%`])).rows[0].x;
  const first = await snap();
  const firstX = await xmins();
  store.puts.length = 0;
  const again = await seedSprites(opts(root, store, pool));
  assert.strictEqual(again.entity_types.linked, 0);
  assert.strictEqual(again.entity_types.skipped, 2);
  assert.strictEqual(again.character_appearances.skipped, 1);
  assert.deepStrictEqual(store.puts, []);
  assert.strictEqual(await snap(), first);
  assert.strictEqual(await xmins(), firstX, 'no UPDATE ran');
});

dbTest('a dangling sheet (row points at objects the store lost) is uploaded again and relinked', async ({ pool, root }) => {
  const names = [`${P} bat`];
  fixture(root, { names });
  await addEntity(pool, names[0]);
  const store = memStore();
  await seedSprites(opts(root, store, pool));
  const row = await entityRow(pool, names[0]);
  store.objects.delete(row.sprite.manifest_key); // only one half lost
  store.puts.length = 0;
  const out = await seedSprites(opts(root, store, pool));
  assert.strictEqual(out.entity_types.dangling, 1);
  assert.strictEqual(out.entity_types.linked, 1);
  assert.ok(store.objects.has(row.sprite.manifest_key));
  assert.ok(store.puts.length >= 1);
  const after = await seedSprites(opts(root, store, pool));
  assert.strictEqual(after.entity_types.linked, 0);
});

dbTest("a sheet this machine already has (even a different one) is never replaced, unless --force", async ({ pool, root }) => {
  const names = [`${P} bat`];
  fixture(root, { names });
  const own = { atlas_key: `sprites/${P}/own-atlas.png`, manifest_key: `sprites/${P}/own-man.json`, static_frame: 'walk/e/0' };
  await addEntity(pool, names[0], own);
  const store = memStore();
  store.objects.set(own.atlas_key, Buffer.from('mine'));
  store.objects.set(own.manifest_key, Buffer.from('{}'));
  const out = await seedSprites(opts(root, store, pool));
  assert.strictEqual(out.entity_types.skipped, 1);
  assert.deepStrictEqual((await entityRow(pool, names[0])).sprite, own);
  assert.deepStrictEqual(store.puts, []);
  const forced = await seedSprites(opts(root, store, pool, { force: true }));
  assert.strictEqual(forced.entity_types.linked, 1);
  assert.notDeepStrictEqual((await entityRow(pool, names[0])).sprite, own);
});

dbTest('a missing file, an altered file and an unknown creature are counted and skipped, the rest still seeds', async ({ pool, root }) => {
  const names = [`${P} bat`, `${P} slime`, `${P} ghost`];
  const fx = fixture(root, { names });
  await addEntity(pool, names[0]);
  await addEntity(pool, names[1]);
  // ghost has no row on this machine
  fs.rmSync(path.join(root, fx.entities[0].sprite.atlas.file));
  fs.writeFileSync(path.join(root, fx.entities[1].sprite.manifest.file), 'tampered');
  const lines = [];
  const out = await seedSprites(opts(root, memStore(), pool, { log: (l) => lines.push(l) }));
  assert.strictEqual(out.entity_types.missingFile, 2);
  assert.strictEqual(out.entity_types.missingRow, 1);
  assert.strictEqual(out.entity_types.linked, 0);
  assert.strictEqual((await entityRow(pool, names[0])).sprite, null);
  assert.strictEqual((await entityRow(pool, names[1])).sprite, null);
  assert.ok(lines.some((l) => /ghost/.test(l) && /no such/.test(l)));
});

dbTest('--only limits the run to the named creatures', async ({ pool, root }) => {
  const names = [`${P} bat`, `${P} slime`];
  fixture(root, { names });
  for (const n of names) await addEntity(pool, n);
  const out = await seedSprites(opts(root, memStore(), pool, { only: [names[1]] }));
  assert.strictEqual(out.entity_types.linked, 1);
  assert.strictEqual((await entityRow(pool, names[0])).sprite, null);
  assert.ok((await entityRow(pool, names[1])).sprite);
});

test('the seeder names only the two catalog tables it writes, never a player table', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/spriteSeed.js'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const writes = [...src.matchAll(/UPDATE\s+(\w+)|INSERT\s+INTO\s+(\w+)|DELETE\s+FROM\s+(\w+)/gi)].map((m) => m[1] || m[2] || m[3]);
  assert.deepStrictEqual([...new Set(writes)].sort(), ['character_appearances', 'entity_types']);
  assert.doesNotMatch(src, /\b(characters|users|character_id|user_id)\b/);
});
