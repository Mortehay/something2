const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('node:stream');

const { SUBJECTS } = require('../src/services/catalogSubjects.js');
const {
  SEED_POLICY, seededKey, safeName, exportArt, seedArt, parseArgs,
} = require('../src/services/artSeed.js');

// SOMET-572. One export/seed path for every art subject. These tests pin the
// per-kind rules that used to live in four separate scripts, so that a kind
// added to SUBJECTS without a seed policy fails here rather than silently
// being un-exportable.

// A stub pool: `handlers` is a list of [regex, rows] pairs matched against
// the SQL text, so a test can say "SELECT ... FROM tile_types answers this"
// without caring about the exact statement. Every query is recorded.
function stubDb(handlers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, rows] of handlers) {
        if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(params) : rows };
      }
      return { rows: [] };
    },
  };
}

// A stub object store: `objects` is a Map key -> Buffer; puts are recorded.
function stubStore(objects = new Map()) {
  const puts = [];
  return {
    puts,
    objects,
    BUCKET: () => 'sprites',
    async ensureBucket() {},
    async getObjectStream(key) {
      if (!objects.has(key)) throw new Error(`The specified key does not exist: ${key}`);
      return Readable.from([objects.get(key)]);
    },
    async putObject(key, buffer) { puts.push({ key, buffer }); objects.set(key, buffer); return key; },
  };
}

const PNG = Buffer.from('89504e470d0a1a0a', 'hex'); // a header, not an image: trim must degrade, not throw

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'art-seed-'));
}

// --- registry linkage ----------------------------------------------------

test('every subject kind in SUBJECTS has a seed policy, and no policy is orphaned', () => {
  assert.deepStrictEqual(Object.keys(SEED_POLICY).sort(), Object.keys(SUBJECTS).sort());
  for (const [kind, policy] of Object.entries(SEED_POLICY)) {
    assert.strictEqual(policy.kind, kind);
    assert.strictEqual(typeof policy.dir, 'string', `${kind}.dir`);
    assert.strictEqual(typeof policy.manifest, 'string', `${kind}.manifest`);
    assert.strictEqual(typeof policy.exportRows, 'function', `${kind}.exportRows`);
    assert.strictEqual(typeof policy.gate, 'function', `${kind}.gate`);
    assert.strictEqual(typeof policy.link, 'function', `${kind}.link`);
  }
});

test('tiles and entities keep the manifest paths the host-side Python tools hardcode', () => {
  // tools/make-tiles-seamless.py and tools/cutout-entity-textures.py read
  // seeds/textures/tiles.json and seeds/textures/entities.json. Moving them
  // would break both tools without a test noticing.
  assert.strictEqual(SEED_POLICY.tile.dir, 'tiles');
  assert.strictEqual(SEED_POLICY.tile.manifest, 'tiles.json');
  assert.strictEqual(SEED_POLICY.entity.dir, 'entities');
  assert.strictEqual(SEED_POLICY.entity.manifest, 'entities.json');
});

// --- seeded keys ---------------------------------------------------------

test('seededKey keeps the per-kind prefix GET /api/assets already serves from', () => {
  assert.strictEqual(seededKey('sprites', 'tile', 'grass'), 'sprites/tiles/grass/seeded/static.png');
  assert.strictEqual(seededKey('sprites', 'entity', 'Wolf'), 'sprites/Wolf/seeded/static.png');
  assert.strictEqual(seededKey('sprites', 'skill', 'arc_tumble'), 'sprites/objects/arc_tumble/seeded/static.png');
  assert.strictEqual(seededKey('sprites', 'passive_label', 'Focus'), 'sprites/objects/Focus/seeded/static.png');
  assert.strictEqual(seededKey('sprites', 'item', 'void-blade'), 'sprites/objects/void-blade/seeded/static.png');
});

test('seededKey is namespaced away from job-scoped keys and sanitises the subject', () => {
  const k = seededKey('sprites', 'entity', '../../etc/passwd');
  assert.ok(!k.includes('..'));
  assert.ok(!k.includes('rmt_'));
  assert.strictEqual(safeName('stone_of_flame staff'), 'stone_of_flame_staff');
});

// --- export row selection ------------------------------------------------

test('entity export takes static rows only: a directional set is not one still', async () => {
  const db = stubDb([[/FROM entity_types/, (params) => {
    assert.match(db.calls[0].sql, /render_mode = 'static'/);
    return [{ name: 'Wolf', image: 'sprites/Wolf/j1/static.png', prompt: 'a wolf', is_creature: true }];
  }]]);
  const rows = await SEED_POLICY.entity.exportRows(db);
  assert.deepStrictEqual(rows.map((r) => r.key), ['Wolf']);
  assert.strictEqual(rows[0].is_creature, true);
  assert.strictEqual(rows[0].prompt, 'a wolf');
});

test('tile export takes image rows only and carries the biome', async () => {
  const db = stubDb([[/FROM tile_types/, () => {
    assert.match(db.calls[0].sql, /render_mode = 'image'/);
    return [{ name: 'grass', image: 'sprites/tiles/grass/j/static.png', prompt: 'p', art_biome: 'meadow' }];
  }]]);
  const rows = await SEED_POLICY.tile.exportRows(db);
  assert.strictEqual(rows[0].art_biome, 'meadow');
});

test('skill export is keyed by skill id and named by the English name', async () => {
  const db = stubDb([[/FROM catalog_art/, [
    { name: 'arc_tumble', image: 'sprites/objects/Tumble/j/static.png', updated_at: new Date() },
  ]]]);
  const rows = await SEED_POLICY.skill.exportRows(db);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].key, 'arc_tumble');
  assert.strictEqual(rows[0].name, 'Tumble');
  assert.strictEqual(rows[0].image, 'sprites/objects/Tumble/j/static.png');
});

test('skill export drops art whose skill is no longer in the catalogue', async () => {
  const db = stubDb([[/FROM catalog_art/, [
    { name: 'no_such_skill', image: 'sprites/objects/X/j/static.png', updated_at: new Date() },
  ]]]);
  const rows = await SEED_POLICY.skill.exportRows(db);
  assert.deepStrictEqual(rows, []);
});

test('item export reads icon and passive export reads catalog_art', async () => {
  const items = stubDb([[/FROM item_types/, [{ name: 'void-blade', image: 'sprites/objects/void-blade/j/static.png' }]]]);
  const rows = await SEED_POLICY.item.exportRows(items);
  assert.deepStrictEqual(rows.map((r) => [r.key, r.name]), [['void-blade', 'void-blade']]);
  const passives = stubDb([[/FROM catalog_art/, [{ name: 'Focus', image: 'sprites/objects/Focus/j/static.png' }]]]);
  const prows = await SEED_POLICY.passive_label.exportRows(passives);
  assert.deepStrictEqual(prows.map((r) => [r.key, r.name]), [['Focus', 'Focus']]);
});

// --- seed gates ----------------------------------------------------------

test('tile gate: a tile that already draws an image is skipped unless forced', async () => {
  const has = stubDb([[/FROM tile_types/, [{ id: 1, render_mode: 'image' }]]]);
  assert.strictEqual((await SEED_POLICY.tile.gate(has, { name: 'grass' }, { force: false })).skip, 'has-art');
  assert.strictEqual(await SEED_POLICY.tile.gate(has, { name: 'grass' }, { force: true }), null);
  const bare = stubDb([[/FROM tile_types/, [{ id: 1, render_mode: 'color' }]]]);
  assert.strictEqual(await SEED_POLICY.tile.gate(bare, { name: 'grass' }, { force: false }), null);
  const none = stubDb([]);
  assert.strictEqual((await SEED_POLICY.tile.gate(none, { name: 'grass' }, { force: false })).skip, 'missing-row');
});

test('entity gate: needs_regen waits, non-rect art is kept, a missing row is reported', async () => {
  const p = SEED_POLICY.entity;
  assert.strictEqual((await p.gate(stubDb([]), { name: 'X', cutout: true, needs_regen: true }, {})).skip, 'needs-regen');
  const dir = stubDb([[/FROM entity_types/, [{ id: 2, render_mode: 'directional' }]]]);
  assert.strictEqual((await p.gate(dir, { name: 'Wolf', cutout: true }, { force: false })).skip, 'has-art');
  // FORCE is the one way to flatten a directional set, and it is deliberate.
  assert.strictEqual(await p.gate(dir, { name: 'Wolf', cutout: true }, { force: true }), null);
  const rect = stubDb([[/FROM entity_types/, [{ id: 2, render_mode: 'rect' }]]]);
  assert.strictEqual(await p.gate(rect, { name: 'Wolf', cutout: true }, { force: false }), null);
  assert.strictEqual((await p.gate(stubDb([]), { name: 'Ghost', cutout: true }, {})).skip, 'missing-row');
});

test('entity preflight refuses a manifest where NOTHING has been cut out -- the step was skipped', () => {
  assert.throws(
    () => SEED_POLICY.entity.preflight([{ name: 'A' }, { name: 'B' }]),
    /entities-cutout/,
  );
  assert.doesNotThrow(() => SEED_POLICY.entity.preflight([{ name: 'A', cutout: true }]));
  assert.doesNotThrow(() => SEED_POLICY.entity.preflight([]));
});

test('entity gate: one un-cut entry is skipped on its own, not the whole kind', async () => {
  // One opaque file used to block all 308: "these images have not been cut
  // out" fired if ANY entry lacked the flag. Now the un-cut one waits and
  // the rest seed.
  const mixed = [{ name: 'A', cutout: true }, { name: 'B' }];
  assert.doesNotThrow(() => SEED_POLICY.entity.preflight(mixed));
  const rect = stubDb([[/FROM entity_types/, [{ id: 2, render_mode: 'rect' }]]]);
  assert.strictEqual((await SEED_POLICY.entity.gate(rect, mixed[1], { force: false })).skip, 'not-cut-out');
  assert.strictEqual(await SEED_POLICY.entity.gate(rect, mixed[0], { force: false }), null);
});

test('catalog-art gates: skip when the subject already has art unless forced', async () => {
  for (const kind of ['skill', 'passive_label', 'item']) {
    const p = SEED_POLICY[kind];
    // The item gate also looks the row up; give it one so this test is about
    // the art state, not row existence (covered separately below).
    const row = [[/SELECT id FROM item_types WHERE name/, [{ id: 1 }]]];
    const has = stubDb([...row, [/FROM (catalog_art|item_types)/, [{ name: 'k', image: 'sprites/objects/k/j/static.png' }]]]);
    assert.strictEqual((await p.gate(has, { key: 'k', name: 'k' }, { force: false })).skip, 'has-art', kind);
    assert.strictEqual(await p.gate(has, { key: 'k', name: 'k' }, { force: true }), null, kind);
    assert.strictEqual(await p.gate(stubDb(row), { key: 'k', name: 'k' }, { force: false }), null, kind);
  }
});

test('trim policy: tiles are stored as drawn, everything else is trimmed as an object', () => {
  assert.strictEqual(SEED_POLICY.tile.trim, null);
  for (const kind of ['entity', 'skill', 'passive_label', 'item']) {
    assert.strictEqual(SEED_POLICY[kind].trim, 'object', kind);
  }
});

// --- link statements -----------------------------------------------------

test('tile link clears the sprite, promotes to image, and only fills an EMPTY art_biome', async () => {
  const db = stubDb([[/UPDATE tile_types/, [{ id: 1 }]]]);
  await SEED_POLICY.tile.link(db, { name: 'grass', art_biome: 'meadow' }, 'sprites/tiles/grass/seeded/static.png');
  const { sql, params } = db.calls[0];
  assert.match(sql, /sprite = NULL/);
  assert.match(sql, /render_mode = 'image'/);
  assert.match(sql, /CASE WHEN art_biome = ''/);
  assert.ok(params.includes('meadow'));
  assert.ok(params.includes('sprites/tiles/grass/seeded/static.png'));
});

test('entity link clears the sprite and promotes to static', async () => {
  const db = stubDb([[/UPDATE entity_types/, [{ name: 'Wolf' }]]]);
  await SEED_POLICY.entity.link(db, { name: 'Wolf' }, 'sprites/Wolf/seeded/static.png');
  const { sql } = db.calls[0];
  assert.match(sql, /sprite = NULL/);
  assert.match(sql, /render_mode = 'static'/);
});

test('catalog-art links go through the registry write, keyed by subject key', async () => {
  const db = stubDb([[/INSERT INTO catalog_art/, [{ subject_key: 'arc_tumble' }]]]);
  await SEED_POLICY.skill.link(db, { key: 'arc_tumble', name: 'Tumble' }, 'sprites/objects/arc_tumble/seeded/static.png');
  assert.match(db.calls[0].sql, /INSERT INTO catalog_art/);
  assert.deepStrictEqual(db.calls[0].params.slice(0, 3), ['skill', 'arc_tumble', 'sprites/objects/arc_tumble/seeded/static.png']);
  const items = stubDb([[/UPDATE item_types/, [{ name: 'void-blade' }]]]);
  await SEED_POLICY.item.link(items, { key: 'void-blade', name: 'void-blade' }, 'k');
  assert.match(items.calls[0].sql, /SET icon = \$1/);
});

// --- export -> seed round trip ------------------------------------------

test('exportArt writes one PNG per row plus a manifest, and seedArt replays it under a seeded key', async () => {
  const root = tmpRoot();
  const objects = new Map([['sprites/objects/Tumble/rmt_1/static.png', PNG]]);
  const store = stubStore(objects);
  const exportDb = stubDb([[/FROM catalog_art/, [{ name: 'arc_tumble', image: 'sprites/objects/Tumble/rmt_1/static.png' }]]]);

  const ex = await exportArt({ db: exportDb, store, root, kinds: ['skill'], log: () => {} });
  assert.strictEqual(ex.skill.exported, 1);
  assert.deepStrictEqual(ex.skill.failed, []);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'skills.json'), 'utf8'));
  // `source: null` is the honest record for a capped kind whose bytes could
  // not be decoded: committed as they came, not resampled.
  assert.deepStrictEqual(manifest, [{ key: 'arc_tumble', name: 'Tumble', file: 'arc_tumble.png', bytes: PNG.length, source: null }]);
  assert.ok(fs.existsSync(path.join(root, 'skills', 'arc_tumble.png')));

  const seedDb = stubDb([[/INSERT INTO catalog_art/, [{ subject_key: 'arc_tumble' }]]]);
  const sd = await seedArt({ db: seedDb, store, root, kinds: ['skill'], log: () => {} });
  assert.strictEqual(sd.skill.linked, 1);
  assert.strictEqual(store.puts.length, 1);
  assert.strictEqual(store.puts[0].key, 'sprites/objects/arc_tumble/seeded/static.png');
  const ins = seedDb.calls.find((c) => /INSERT INTO catalog_art/.test(c.sql));
  assert.strictEqual(ins.params[2], 'sprites/objects/arc_tumble/seeded/static.png');
});

test('exportArt reports a row whose object is gone instead of crashing, and keeps going', async () => {
  const root = tmpRoot();
  const store = stubStore(new Map([['sprites/objects/B/j/static.png', PNG]]));
  const db = stubDb([[/FROM item_types/, [
    { name: 'a', image: 'sprites/objects/A/j/static.png' },
    { name: 'b', image: 'sprites/objects/B/j/static.png' },
  ]]]);
  const r = await exportArt({ db, store, root, kinds: ['item'], log: () => {} });
  assert.deepStrictEqual(r.item.failed, ['a']);
  assert.strictEqual(r.item.exported, 1);
});

test('exportArt with ONLY merges into the existing manifest rather than truncating it', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'items'));
  fs.writeFileSync(path.join(root, 'items.json'), JSON.stringify([
    { key: 'a', name: 'a', file: 'a.png', bytes: 1 },
    { key: 'b', name: 'b', file: 'b.png', bytes: 1, cutout: true },
  ]));
  const store = stubStore(new Map([['sprites/objects/A/j2/static.png', PNG]]));
  const db = stubDb([[/FROM item_types/, [
    { name: 'a', image: 'sprites/objects/A/j2/static.png' },
    { name: 'b', image: 'sprites/objects/B/j/static.png' },
  ]]]);
  await exportArt({ db, store, root, kinds: ['item'], only: ['a'], log: () => {} });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'items.json'), 'utf8'));
  assert.deepStrictEqual(manifest.map((m) => m.key), ['a', 'b']);
  assert.strictEqual(manifest[0].bytes, PNG.length);       // re-exported
  assert.strictEqual(manifest[1].cutout, true);            // untouched
});

test('exportArt refuses two subjects whose file names would collide', async () => {
  const root = tmpRoot();
  const store = stubStore(new Map([['k', PNG]]));
  const db = stubDb([[/FROM item_types/, [
    { name: 'stone_of_flame staff', image: 'k' },
    { name: 'stone_of_flame_staff', image: 'k' },
  ]]]);
  await assert.rejects(
    () => exportArt({ db, store, root, kinds: ['item'], log: () => {} }),
    /collide/,
  );
});

test('seedArt without a manifest says which export to run', async () => {
  const root = tmpRoot();
  await assert.rejects(
    () => seedArt({ db: stubDb([]), store: stubStore(), root, kinds: ['tile'], log: () => {} }),
    /make art-export KIND=tile/,
  );
});

test('seedArt honours the gates: existing art is counted as skipped, not re-uploaded', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'passives'));
  fs.writeFileSync(path.join(root, 'passives', 'Focus.png'), PNG);
  fs.writeFileSync(path.join(root, 'passives.json'), JSON.stringify([
    { key: 'Focus', name: 'Focus', file: 'Focus.png', bytes: PNG.length },
    { key: 'Gone', name: 'Gone', file: 'Gone.png', bytes: 1 },
  ]));
  const store = stubStore();
  const db = stubDb([[/SELECT .* FROM catalog_art/, [{ name: 'Focus', image: 'sprites/objects/Focus/j/static.png' }]]]);
  const r = await seedArt({ db, store, root, kinds: ['passive_label'], log: () => {} });
  assert.strictEqual(r.passive_label.skipped, 1);
  assert.strictEqual(r.passive_label.missingFile, 1);
  assert.strictEqual(store.puts.length, 0);
});

test('seedArt refuses an entity manifest that skipped the cutout, before touching the store', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'entities'));
  fs.writeFileSync(path.join(root, 'entities.json'), JSON.stringify([{ name: 'Wolf', file: 'Wolf.png', bytes: 1 }]));
  const store = stubStore();
  await assert.rejects(
    () => seedArt({ db: stubDb([]), store, root, kinds: ['entity'], log: () => {} }),
    /entities-cutout/,
  );
  assert.strictEqual(store.puts.length, 0);
});

// --- CLI -----------------------------------------------------------------

test('parseArgs reads the flags the Makefile passes', () => {
  const a = parseArgs(['--kind=skill,item', '--only=a, b', '--force']);
  assert.deepStrictEqual(a.kinds, ['skill', 'item']);
  assert.deepStrictEqual(a.only, ['a', 'b']);
  assert.strictEqual(a.force, true);
  const d = parseArgs([]);
  assert.deepStrictEqual(d.kinds, Object.keys(SEED_POLICY));
  assert.strictEqual(d.only, null);
  assert.strictEqual(d.force, false);
});

test('parseArgs rejects an unknown kind instead of silently exporting nothing', () => {
  assert.throws(() => parseArgs(['--kind=sprites']), /unknown kind/);
});

// --- SOMET-573: display-sized committed copies --------------------------

test('only the three icon kinds are capped on export; tiles and entities are written as drawn', () => {
  assert.strictEqual(SEED_POLICY.tile.maxEdge, null);
  assert.strictEqual(SEED_POLICY.entity.maxEdge, null);
  for (const kind of ['skill', 'passive_label', 'item']) {
    assert.strictEqual(SEED_POLICY[kind].maxEdge, 256, kind);
  }
});

test('exportArt shrinks a capped kind to the cap and records the source size in the manifest', async () => {
  const { encodeRGBA } = require('../src/services/pngTrim.js');
  const { decodeRGBA } = require('../src/services/pngAlpha.js');
  const big = encodeRGBA(512, 384, Buffer.alloc(512 * 384 * 4, 200));
  const root = tmpRoot();
  const store = stubStore(new Map([['sprites/objects/A/j/static.png', big]]));
  const db = stubDb([[/FROM item_types/, [{ name: 'a', image: 'sprites/objects/A/j/static.png' }]]]);
  await exportArt({ db, store, root, kinds: ['item'], log: () => {} });
  const written = decodeRGBA(fs.readFileSync(path.join(root, 'items', 'a.png')));
  assert.strictEqual(written.width, 256);
  assert.strictEqual(written.height, 192);
  const [entry] = JSON.parse(fs.readFileSync(path.join(root, 'items.json'), 'utf8'));
  assert.deepStrictEqual(entry.source, { width: 512, height: 384 });
  assert.ok(entry.bytes < big.length);
});

test('exportArt writes an uncapped kind byte-for-byte, even when it is large', async () => {
  const { encodeRGBA } = require('../src/services/pngTrim.js');
  const big = encodeRGBA(512, 512, Buffer.alloc(512 * 512 * 4, 90));
  const root = tmpRoot();
  const store = stubStore(new Map([['sprites/tiles/grass/j/static.png', big]]));
  const db = stubDb([[/FROM tile_types/, [{ name: 'grass', image: 'sprites/tiles/grass/j/static.png', prompt: 'p', art_biome: '' }]]]);
  await exportArt({ db, store, root, kinds: ['tile'], log: () => {} });
  assert.ok(fs.readFileSync(path.join(root, 'tiles', 'grass.png')).equals(big));
  const [entry] = JSON.parse(fs.readFileSync(path.join(root, 'tiles.json'), 'utf8'));
  assert.strictEqual(entry.source, undefined);
});

// --- export marks the cutout state from the bytes it writes ---------------

test('entity export marks an already-transparent PNG cutout:true and an opaque one not', async () => {
  const { encodeRGBA } = require('../src/services/pngTrim.js');
  const W = 20; const H = 20;
  // Half the frame transparent: a keyed silhouette.
  const keyed = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i += 1) keyed.set([200, 50, 50, i % W < 10 ? 255 : 0], i * 4);
  const opaque = Buffer.alloc(W * H * 4, 255);
  const root = tmpRoot();
  const store = stubStore(new Map([
    ['sprites/Wolf/j/static.png', encodeRGBA(W, H, keyed)],
    ['sprites/Crate/j/static.png', encodeRGBA(W, H, opaque)],
  ]));
  const db = stubDb([[/FROM entity_types/, [
    { name: 'Wolf', image: 'sprites/Wolf/j/static.png', prompt: 'p', is_creature: true },
    { name: 'Crate', image: 'sprites/Crate/j/static.png', prompt: 'p', is_creature: false },
  ]]]);
  await exportArt({ db, store, root, kinds: ['entity'], log: () => {} });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'entities.json'), 'utf8'));
  const byName = Object.fromEntries(manifest.map((m) => [m.name, m]));
  assert.strictEqual(byName.Wolf.cutout, true);
  assert.strictEqual(byName.Crate.cutout, undefined);
  // Never invents the redraw flag: that is the cutout tool's judgment.
  assert.strictEqual(byName.Wolf.needs_regen, undefined);
  assert.strictEqual(byName.Crate.needs_regen, undefined);
});

test('seedArt with a mixed entity manifest seeds the cut-out entry and counts the other as waiting', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'entities'));
  fs.writeFileSync(path.join(root, 'entities', 'A.png'), PNG);
  fs.writeFileSync(path.join(root, 'entities', 'B.png'), PNG);
  fs.writeFileSync(path.join(root, 'entities.json'), JSON.stringify([
    { name: 'A', file: 'A.png', bytes: 1, cutout: true },
    { name: 'B', file: 'B.png', bytes: 1 },
  ]));
  const store = stubStore();
  const db = stubDb([[/FROM entity_types/, [{ id: 1, render_mode: 'rect' }]], [/UPDATE entity_types/, [{}]]]);
  const r = await seedArt({ db, store, root, kinds: ['entity'], log: () => {} });
  assert.strictEqual(r.entity.linked, 1);
  assert.strictEqual(r.entity.notCutOut, 1);
  assert.deepStrictEqual(store.puts.map((p) => p.key), ['sprites/A/seeded/static.png']);
});

test('item gate reports a subject with no item_types row instead of counting a no-op UPDATE as linked', async () => {
  const noRow = stubDb([[/SELECT .* FROM item_types WHERE name/, []]]);
  assert.strictEqual((await SEED_POLICY.item.gate(noRow, { key: 'ghost-blade', name: 'ghost-blade' }, { force: false })).skip, 'missing-row');
  const hasRow = stubDb([[/SELECT .* FROM item_types WHERE name/, [{ id: 1 }]]]);
  assert.strictEqual(await SEED_POLICY.item.gate(hasRow, { key: 'void-blade', name: 'void-blade' }, { force: false }), null);
});
