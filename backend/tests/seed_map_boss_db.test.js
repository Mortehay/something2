// backend/tests/seed_map_boss_db.test.js
// SOMET-609 (S9). applyMapSpec writes the spec's boss block to
// worlds.dungeon_boss and RE-ASSERTS it: removing the key from the spec must
// clear the column (spec beats any hand edit, memory: spec-beats-migration).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { applyMapSpec } = require('../scripts/seed-map.js');
const { withEntryPreserved } = require('./helpers/entryWorld.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;
const NAME = 'zzS9 Boss Seed World';

const spec = (boss) => ({
  name: 'zz-s9-boss', topology: 'spine',
  worlds: [{
    key: 'zz', name: NAME, grid: [9, -9], seed: 991, width: 64, height: 64, chunk_size: 32,
    biomes: ['Deep Forest'], biome_cell: 32, allowed_creature_types: [], is_entry: true,
    entry_spawn: { x: 3250, y: 3250 }, ...(boss ? { boss } : {}),
  }],
  links: [],
});

test('applyMapSpec writes, then clears, worlds.dungeon_boss', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 3 });
  const read = async () => (await pool.query('SELECT dungeon_boss FROM worlds WHERE name = $1', [NAME])).rows[0].dungeon_boss;
  try {
    await pool.query('DELETE FROM worlds WHERE name = $1', [NAME]);
    await withEntryPreserved(pool, async () => {
      const boss = { entity: 'The Bone Regent', x: 3550, y: 3250, respawn_s: 900 };
      await applyMapSpec(pool, spec(boss));
      assert.deepEqual(await read(), boss);
      await applyMapSpec(pool, spec(null));
      assert.equal(await read(), null, 'a re-seed without the key must clear the column');
    });
  } finally {
    await pool.query('DELETE FROM worlds WHERE name = $1', [NAME]).catch(() => {});
    await pool.end();
  }
});
