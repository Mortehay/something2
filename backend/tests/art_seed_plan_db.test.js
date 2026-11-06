// SOMET-722. The Orange Pi's seed dialog promised "1,332 art files, an hour or more" for a run that copied nothing.
// planArt runs the seed's own gates: its pending count must equal what seedArt then links, and it must write nothing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { planArt, seedArt } = require('../src/services/artSeed.js');
const { planOutput } = require('../scripts/seed-plan.js');

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

test('planArt counts what seedArt would link, across the gates, and writes nothing', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  const tag = `${process.pid}-${Date.now()}`;
  const tile = (n) => `plan-${n}-${tag}`;
  const entity = (n) => `plan-ent-${n}-${tag}`;
  const skill = `plan-skill-${tag}`;
  const rows = [tile('fresh'), tile('gone'), tile('nofile')];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'art-plan-'));
  try {
    for (const name of rows) await pool.query("INSERT INTO tile_types (name, color) VALUES ($1, '#000000')", [name]);
    await pool.query("INSERT INTO entity_types (name, color) VALUES ($1, '#000000')", [entity('ok')]);
    for (const d of ['tiles', 'entities', 'skills']) fs.mkdirSync(path.join(root, d));
    for (const f of ['tiles/fresh.png', 'tiles/gone.png', 'tiles/later.png', 'tiles/never.png', 'entities/ok.png', 'entities/open.png', 'entities/redo.png', 'skills/s.png']) {
      fs.writeFileSync(path.join(root, f), 'png');
    }
    fs.writeFileSync(path.join(root, 'tiles.json'), JSON.stringify([
      { name: tile('fresh'), file: 'fresh.png' },
      { name: tile('gone'), file: 'gone.png' },
      { name: tile('nofile'), file: 'absent.png' }, // listed, not on disk: the seed reports it missing
      { name: tile('later'), file: 'later.png' }, // no row yet, but the catalog step of this same job creates it
      { name: tile('never'), file: 'never.png' }, // no row, and no catalog creates it: an unknown subject
    ]));
    fs.writeFileSync(path.join(root, 'entities.json'), JSON.stringify([
      { name: entity('ok'), file: 'ok.png', cutout: true },
      { name: entity('open'), file: 'open.png' }, // not cut out
      { name: entity('redo'), file: 'redo.png', cutout: true, needs_regen: true },
    ]));
    fs.writeFileSync(path.join(root, 'skills.json'), JSON.stringify([{ key: skill, name: skill, file: 's.png' }]));
    const catalogDir = path.join(root, 'sync');
    fs.mkdirSync(catalogDir);
    fs.writeFileSync(path.join(catalogDir, 'tile_types.json'), JSON.stringify({ tables: { tile_types: [{ name: tile('later') }] } }));

    const store = memStore();
    const plan = (kinds) => planArt({ db: pool, store, root, kinds, syncFile: null, catalogDir });
    const seed = (kinds) => seedArt({ db: pool, store, root, kinds, syncFile: null, log: () => {} });

    assert.equal((await plan(['tile'])).pending, 3, 'fresh, gone, later');
    assert.equal((await plan(['entity'])).pending, 1, 'only the one a seed accepts');
    assert.equal((await plan(['skill'])).pending, 1);
    assert.equal(store.objects.size, 0, 'a plan uploads nothing');
    const image = async (n) => (await pool.query('SELECT image FROM tile_types WHERE name = $1', [n])).rows[0].image;
    assert.equal(await image(tile('fresh')) || '', '', 'a plan links nothing');

    // The catalog step has run by the time art is seeded, so the later row exists now.
    await pool.query("INSERT INTO tile_types (name, color) VALUES ($1, '#000000')", [tile('later')]);
    rows.push(tile('later'));
    const seeded = await seed(['tile', 'entity', 'skill']);
    assert.deepEqual([seeded.tile.linked, seeded.entity.linked, seeded.skill.linked], [3, 1, 1], 'the same three numbers');
    assert.equal((await plan(['tile', 'entity', 'skill'])).pending, 0);

    // A row whose object left the store is seeded again, so the plan counts it.
    store.objects.delete(await image(tile('gone')));
    assert.equal((await plan(['tile'])).pending, 1);
    assert.equal((await seed(['tile'])).tile.dangling, 1);
    assert.equal((await plan(['tile'])).pending, 0);
  } finally {
    await pool.query('DELETE FROM tile_types WHERE name = ANY($1)', [rows]);
    await pool.query('DELETE FROM entity_types WHERE name = $1', [entity('ok')]);
    await pool.query("DELETE FROM catalog_art WHERE subject_key = $1", [skill]);
    fs.rmSync(root, { recursive: true, force: true });
    await pool.end();
  }
});

// tools/pi-helper/boardJobs.test.js pins the other end: the helper reads these two names from this script.
test('seed-plan prints the two numbers the helper reads, and a bucket not made yet holds nothing', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const noBucket = { listObjectKeys: async () => { throw Object.assign(new Error('no bucket'), { code: 'NoSuchBucket' }); } };
    const m = (await planOutput({ db: pool, store: noBucket })).match(/^art_pending=(\d+)\naudio_pending=(\d+)$/);
    assert.ok(m, 'the exact lines');
    assert.ok(Number(m[1]) > 0 && Number(m[2]) > 0, 'with an empty store the real seeds are pending');
    const broken = { listObjectKeys: async () => { throw Object.assign(new Error('denied'), { code: 'AccessDenied' }); } };
    await assert.rejects(() => planOutput({ db: pool, store: broken }), /denied/, 'any other store failure is not "nothing there"');
  } finally {
    await pool.end();
  }
});
