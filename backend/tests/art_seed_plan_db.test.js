// SOMET-722. The Orange Pi's seed dialog promised "1,332 art files, an hour or more" for a run that copied nothing.
// planArt runs the seed's own gates: its pending count must equal what seedArt then links, and it must write nothing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { planArt, seedArt } = require('../src/services/artSeed.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

function memStore(objects = new Map()) {
  return {
    objects,
    BUCKET: () => 'sprites',
    async ensureBucket() {},
    async putObject(key, buffer) { objects.set(key, buffer); return key; },
    async objectExists(key) { return objects.has(key); },
    async listObjectKeys() { return [...objects.keys()]; },
  };
}

test('planArt counts exactly what seedArt goes on to link, and writes nothing', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  const tag = `${process.pid}-${Date.now()}`;
  const names = { fresh: `plan-fresh-${tag}`, gone: `plan-gone-${tag}`, noFile: `plan-nofile-${tag}`, noRow: `plan-norow-${tag}` };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'art-plan-'));
  const created = [names.fresh, names.gone, names.noFile];
  try {
    for (const name of created) await pool.query("INSERT INTO tile_types (name, color) VALUES ($1, '#000000')", [name]);
    fs.mkdirSync(path.join(root, 'tiles'));
    fs.writeFileSync(path.join(root, 'tiles', 'fresh.png'), 'png');
    fs.writeFileSync(path.join(root, 'tiles', 'gone.png'), 'png');
    fs.writeFileSync(path.join(root, 'tiles', 'norow.png'), 'png');
    fs.writeFileSync(path.join(root, 'tiles.json'), JSON.stringify([
      { name: names.fresh, file: 'fresh.png' },
      { name: names.gone, file: 'gone.png' },
      { name: names.noFile, file: 'absent.png' }, // listed, not on disk: the seed reports it missing
      { name: names.noRow, file: 'norow.png' }, // on disk, no row: the seed reports an unknown subject
    ]));
    const store = memStore();
    const opts = { db: pool, store, root, kinds: ['tile'], syncFile: null };

    assert.deepEqual(await planArt(opts), { total: 4, pending: 2 });
    assert.equal(store.objects.size, 0, 'a plan uploads nothing');
    const image = async (n) => (await pool.query('SELECT image FROM tile_types WHERE name = $1', [n])).rows[0].image;
    assert.equal(await image(names.fresh) || '', '', 'a plan links nothing');

    const first = (await seedArt({ ...opts, log: () => {} })).tile;
    assert.equal(first.linked, 2);
    assert.deepEqual(await planArt(opts), { total: 4, pending: 0 });

    // A row whose object left the store is seeded again, so the plan counts it.
    store.objects.delete(await image(names.gone));
    assert.deepEqual(await planArt(opts), { total: 4, pending: 1 });
    assert.equal((await seedArt({ ...opts, log: () => {} })).tile.dangling, 1);
    assert.deepEqual(await planArt(opts), { total: 4, pending: 0 });
  } finally {
    await pool.query('DELETE FROM tile_types WHERE name = ANY($1)', [created]);
    fs.rmSync(root, { recursive: true, force: true });
    await pool.end();
  }
});
