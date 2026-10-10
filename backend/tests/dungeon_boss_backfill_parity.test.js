// SOMET-609 (S9, final review I-1). Migration 1714440702000 backfills
// worlds.dungeon_boss on the six p5-descent End/Elite worlds, because no
// deployed DB is ever re-seeded with `seed-map` (deploy.sh runs migrate +
// seed-catalogs only). Its literals are FROZEN copies of the generator's boss
// blocks. This no-DB test pins them to generateSpec() so a generator change
// that moves a post or renames a boss fails here instead of leaving deployed
// DBs disagreeing with every freshly seeded one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateSpec } = require('../scripts/dungeon/gen-p5-map-content.js');
const { DUNGEON_BOSSES } = require('../migrations/1714440702000_backfill_worlds_dungeon_boss.js');

test('the backfill migration literals equal the boss blocks generateSpec() emits', () => {
  const fromSpec = generateSpec().worlds
    .filter((w) => w.boss)
    .map((w) => ({ world: w.name, boss: w.boss }))
    .sort((a, b) => a.world.localeCompare(b.world));
  // Non-vacuity: the generator must still emit the six S9 bosses; an empty
  // spec list would make an empty literal list "equal".
  assert.equal(fromSpec.length, 6, 'generateSpec() should emit six boss blocks (3 End + 3 Elite)');
  const fromMigration = [...DUNGEON_BOSSES].sort((a, b) => a.world.localeCompare(b.world));
  assert.deepEqual(fromMigration, fromSpec);
});
