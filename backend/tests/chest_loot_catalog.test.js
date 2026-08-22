// SOMET-438. chest_loot existed for months with zero rows, so every chest in
// the game granted XP and nothing else -- and nothing failed, because rolling
// against an empty table returns an empty array, which is a legal outcome.
// That is the shape of bug these tests are for: the pipeline works, the
// content is missing.
//
// The catalog checks run without a database. The rolling checks need one and
// say so rather than passing vacuously.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { CHEST_LOOT, CHEST_LOOT_LEVEL_RANGE } = require('../seeds/data/chestLoot.js');
const { seedOneChestLoot } = require('../scripts/seed-catalogs.js');

test('the bands cover every level a world can produce, with no gap', () => {
  // The failure this prevents is silent: a chest whose guard level falls in a
  // gap rolls against nothing and opens empty, exactly as before the fix.
  const bands = [...new Set(CHEST_LOOT.map((r) => `${r.level_min}-${r.level_max}`))]
    .map((b) => b.split('-').map(Number))
    .sort((a, b) => a[0] - b[0]);

  assert.strictEqual(bands[0][0], CHEST_LOOT_LEVEL_RANGE.min);
  assert.strictEqual(bands[bands.length - 1][1], CHEST_LOOT_LEVEL_RANGE.max);
  for (let i = 1; i < bands.length; i++) {
    assert.strictEqual(bands[i][0], bands[i - 1][1] + 1,
      `gap or overlap between ${bands[i - 1]} and ${bands[i]}: a guard level in there opens an empty chest`);
  }
});

test('every level in range resolves to at least one droppable row', () => {
  for (let lvl = CHEST_LOOT_LEVEL_RANGE.min; lvl <= CHEST_LOOT_LEVEL_RANGE.max; lvl++) {
    const rows = CHEST_LOOT.filter((r) => r.level_min <= lvl && r.level_max >= lvl);
    assert.ok(rows.length > 0, `level ${lvl} has no loot rows`);
  }
});

test('every row satisfies the table\'s own CHECK constraints', () => {
  // chest_loot CHECKs chance in (0,1], max_qty >= min_qty >= 1, level_max >=
  // level_min >= 1. A row violating one of these does not fail the test suite
  // -- it fails the seeder, in whatever environment runs it next.
  for (const r of CHEST_LOOT) {
    assert.ok(r.chance > 0 && r.chance <= 1, `${r.item}: chance ${r.chance} out of range`);
    assert.ok(r.min_qty >= 1 && r.max_qty >= r.min_qty, `${r.item}: qty ${r.min_qty}-${r.max_qty}`);
    assert.ok(r.level_max >= r.level_min && r.level_min >= 1, `${r.item}: band ${r.level_min}-${r.level_max}`);
  }
});

test('a band is worth opening, and is not a guaranteed jackpot', () => {
  // Every row rolls independently, so the chances in a band sum to the
  // EXPECTED ITEM COUNT. Both bounds matter: under ~1 and chests feel empty
  // again, over ~3 and a chest outclasses fighting for gear.
  const byBand = new Map();
  for (const r of CHEST_LOOT) {
    const k = `${r.level_min}-${r.level_max}`;
    byBand.set(k, (byBand.get(k) || 0) + r.chance);
  }
  for (const [band, expected] of byBand) {
    assert.ok(expected >= 1 && expected <= 3,
      `band ${band} expects ${expected.toFixed(2)} items per chest`);
  }
});

test('gold is not in the catalog', () => {
  // gold reaches a player as currency, through rollGold and the gold column.
  // An item_types row named 'gold' exists, and putting it here would grant an
  // inventory entry that spends like nothing -- a bug that would look like
  // loot right up until someone tried to use it.
  assert.ok(!CHEST_LOOT.some((r) => r.item === 'gold'));
});

const TEST_DB = process.env.TEST_DATABASE_URL;

test('every catalog item name exists in item_types', { skip: !TEST_DB && 'TEST_DATABASE_URL not set' }, async () => {
  // Names, not ids, are what the seeder resolves -- so a typo here inserts
  // NOTHING for that row and reports a smaller restore count that nobody
  // reads. This is the test that catches it.
  const pool = new Pool({ connectionString: TEST_DB });
  try {
    const names = [...new Set(CHEST_LOOT.map((r) => r.item))];
    const r = await pool.query('SELECT name FROM item_types WHERE name = ANY($1)', [names]);
    const found = new Set(r.rows.map((x) => x.name));
    const missing = names.filter((n) => !found.has(n));
    assert.deepStrictEqual(missing, [], 'catalog names with no item_types row');
  } finally {
    await pool.end();
  }
});

test('a seeded chest actually rolls items at every band', { skip: !TEST_DB && 'TEST_DATABASE_URL not set' }, async () => {
  // The live symptom was `items: []` at guard_level 2 AND at guard_level 10.
  // rollChestLoot with an rng that always rolls low takes every row whose
  // chance is positive, so a non-empty result here proves the band has rows
  // reachable at that level -- through the real query, not the catalog array.
  const pool = new Pool({ connectionString: TEST_DB });
  try {
    for (const d of CHEST_LOOT) await seedOneChestLoot(pool, d);
    const { rollChestLoot } = require('../src/authority/chestLoot.js');
    for (const lvl of [1, 4, 5, 9, 10, 19, 20, 39, 40, 79, 80, 150]) {
      const items = await rollChestLoot(pool, lvl, () => 0);
      assert.ok(items.length > 0, `guard level ${lvl} rolled nothing`);
    }
    // And an rng that always rolls high takes nothing: an empty chest stays
    // possible, which is what keeps the reward meaningful.
    assert.deepStrictEqual(await rollChestLoot(pool, 10, () => 0.999), []);
  } finally {
    await pool.end();
  }
});

test('re-seeding the catalog does not duplicate a row', { skip: !TEST_DB && 'TEST_DATABASE_URL not set' }, async () => {
  // The same item legitimately appears in several bands, so the guard is on
  // (band, item) rather than on the item -- a guard on the item alone would
  // quietly drop the later bands' rows on a fresh database.
  //
  // Asserted as "no duplicate rows exist", NOT as "the second pass inserted
  // zero". The count version passed alone and failed in a full suite run:
  // chest_loot cascades off item_types, so a peer test deleting an item type
  // between the two passes legitimately removes rows and the second pass
  // legitimately restores them. That is the seeder working, and a test that
  // calls it a failure is measuring the neighbours rather than the code.
  const pool = new Pool({ connectionString: TEST_DB });
  try {
    for (const d of CHEST_LOOT) await seedOneChestLoot(pool, d);
    for (const d of CHEST_LOOT) await seedOneChestLoot(pool, d);
    const dupes = await pool.query(
      `SELECT level_min, level_max, item_type_id, count(*)::int AS n
         FROM chest_loot GROUP BY 1, 2, 3 HAVING count(*) > 1`);
    assert.deepStrictEqual(dupes.rows, [], 'a (band, item) pair appears more than once');
    // Multi-band items are the reason that guard is composite; if the catalog
    // ever loses them this test still passes, so assert they are there.
    const multi = CHEST_LOOT.filter((r) => r.item === 'bolt').length;
    assert.ok(multi > 1, 'the composite-key case must actually be exercised');
  } finally {
    await pool.end();
  }
});
