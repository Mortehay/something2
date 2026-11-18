// SOMET-775: spec-authored ruins and monuments through applyMapSpec.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { applyMapSpec, requiredTilesFor } = require('../scripts/seed-map.js');
const { resolveSpecStructures } = require('../src/services/structureSites');
const { STRUCTURE_TYPES, MONUMENT_TYPES } = require('../seeds/data/structureTypes.js');

const NAME = 'zzTestStructA';
const STRUCTURES = [
  { type: 'burned_cabin', min_row: 10, min_col: 10, size: [5, 4], poi: false },
  { type: 'broken_statue', min_row: 44, min_col: 44 },
];
const spec = (over = {}) => ({
  name: 'zz-test-structures', topology: 'spine',
  worlds: [{
    key: 'a', name: NAME, grid: [9, -9], seed: 4711, width: 64, height: 64, chunk_size: 64,
    biomes: ['Deep Forest'], biome_cell: 32, allowed_creature_types: [], is_entry: true,
    entry_spawn: { x: 3200, y: 3200 }, structures: STRUCTURES, structures_auto: false, ...over,
  }],
  links: [],
});

function pool(t) {
  if (!process.env.TEST_DATABASE_URL) {
    if (process.env.CI) assert.fail('TEST_DATABASE_URL not set');
    t.skip('TEST_DATABASE_URL not set -- skipping to avoid mutating a real database');
    return null;
  }
  return new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
}
const cleanup = (p) => p.query('DELETE FROM worlds WHERE name = $1', [NAME]);
const rowOf = async (p) => (await p.query('SELECT structures, structures_auto FROM worlds WHERE name = $1', [NAME])).rows[0];

test('spec structures are stored as source "spec", auto off is stored, and a second apply changes nothing', async (t) => {
  const p = pool(t); if (!p) return;
  try {
    await cleanup(p);
    await applyMapSpec(p, spec(), { moveEntry: false });
    const row = await rowOf(p);
    const want = resolveSpecStructures(spec().worlds[0], { styles: STRUCTURE_TYPES, monuments: MONUMENT_TYPES });
    assert.deepEqual(row.structures, want, 'exactly the authored sites, no auto ones');
    assert.equal(row.structures_auto, false);
    await applyMapSpec(p, spec(), { moveEntry: false });
    assert.deepEqual(await rowOf(p), row);

    // Turning auto back on keeps the spec sites and adds auto ones clear of them.
    await applyMapSpec(p, spec({ structures_auto: undefined }), { moveEntry: false });
    const on = await rowOf(p);
    assert.equal(on.structures_auto, true);
    assert.deepEqual(on.structures.slice(0, 2), want);
    const auto = on.structures.filter((s) => s.source === 'auto');
    assert.ok(auto.length > 0, 'a 64x64 forest gets auto sites');
    for (const a of auto) for (const s of want) {
      const apart = a.minRow > s.minRow + s.height || s.minRow > a.minRow + a.height
        || a.minCol > s.minCol + s.width || s.minCol > a.minCol + a.width;
      assert.ok(apart, `auto ${a.type} touches spec ${s.type}`);
    }

    // Deleting an entry from the spec removes it from the world.
    await applyMapSpec(p, spec({ structures: [STRUCTURES[0]] }), { moveEntry: false });
    const fewer = (await rowOf(p)).structures;
    assert.equal(fewer.filter((s) => s.source === 'spec').length, 1);
    assert.equal(fewer.some((s) => s.type === 'broken_statue' && s.source === 'spec'), false);
  } finally {
    await cleanup(p).catch(() => {});
    await p.end();
  }
});

test('export writes the spec back unchanged, structures and structures_auto included; re-seeding it is identical', async (t) => {
  const p = pool(t); if (!p) return;
  const { specFromDb, canonicalSpecJson } = require('../src/services/mapSpecExport');
  try {
    await cleanup(p);
    await applyMapSpec(p, spec(), { moveEntry: false });
    const before = await rowOf(p);
    const { spec: out, notes } = await specFromDb(p, spec());
    assert.deepEqual(notes, []);
    assert.equal(canonicalSpecJson(out), canonicalSpecJson(spec()));
    await applyMapSpec(p, out, { moveEntry: false });
    assert.deepEqual(await rowOf(p), before);
  } finally {
    await cleanup(p).catch(() => {});
    await p.end();
  }
});

test('an invalid structure entry is a seed error, and nothing is written', async (t) => {
  const p = pool(t); if (!p) return;
  try {
    await cleanup(p);
    await assert.rejects(
      () => applyMapSpec(p, spec({ structures: [{ type: 'castle', min_row: 5, min_col: 5 }] }), { moveEntry: false }),
      /structure 0 unknown type "castle"/);
    assert.equal(await rowOf(p), undefined);
  } finally {
    await cleanup(p).catch(() => {});
    await p.end();
  }
});

test('the seal guard requires every spec ruin interior and monument front', () => {
  const w = spec().worlds[0];
  const row = { width: 64, height: 64, entry_spawn: w.entry_spawn,
    structures: [...resolveSpecStructures(w, { styles: STRUCTURE_TYPES, monuments: MONUMENT_TYPES }), { type: 'x', minRow: 30, minCol: 30, width: 3, height: 3, source: 'auto' }] };
  const req = requiredTilesFor(w, spec(), row, []).map((r) => `${r.what}@${r.row},${r.col}`);
  assert.ok(req.includes('ruin burned_cabin interior@11,11'), req.join(' '));
  assert.ok(req.includes('monument broken_statue front@46,44'), req.join(' '));
  assert.ok(!req.some((r) => r.includes('@31,31')), 'auto sites prove themselves when placed');
});
