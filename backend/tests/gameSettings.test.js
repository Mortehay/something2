// Strict mode is load-bearing here, not decoration: in sloppy-mode CommonJS a
// write to a frozen object fails SILENTLY, so the "DEFAULTS is frozen" test
// below would report "Missing expected exception" against a correctly frozen
// object. Under strict mode the write throws, which is what the assertion means.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { DEFAULTS, getSetting, getSettings, setSetting } = require('../src/services/gameSettings.js');

// A pool that records every call and answers every SELECT with zero rows, so
// "the default came back" is provably the fallback path and not a row that
// happened to be lying around in a database.
function emptyPool() {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; } };
}

test('DEFAULTS carries exactly the four keys the design specifies, with the specified values', () => {
  assert.deepStrictEqual(Object.keys(DEFAULTS).sort(), [
    'ground_item_ttl_seconds', 'passive_points_per_level', 'rarity_weights', 'respec_base_gold',
  ]);
  assert.strictEqual(DEFAULTS.passive_points_per_level, 1);
  assert.strictEqual(DEFAULTS.ground_item_ttl_seconds, 180);
  assert.strictEqual(DEFAULTS.respec_base_gold, 50);
  assert.deepStrictEqual(DEFAULTS.rarity_weights, [
    { item_level: 1, white: 90, blue: 9, yellow: 1, foxy: 0 },
    { item_level: 50, white: 70, blue: 21, yellow: 8, foxy: 1 },
    { item_level: 150, white: 45, blue: 30, yellow: 20, foxy: 5 },
  ]);
});

test('DEFAULTS is frozen, so a caller cannot mutate the fallback for the whole process', () => {
  assert.throws(() => { DEFAULTS.passive_points_per_level = 99; }, TypeError);
  // Belt and braces: even if this file ever loses its 'use strict', the value
  // itself must not have moved.
  assert.strictEqual(DEFAULTS.passive_points_per_level, 1);
});

test('a missing row falls back to the default rather than undefined', async () => {
  const pool = emptyPool();
  assert.strictEqual(await getSetting(pool, 'ground_item_ttl_seconds'), 180);
  assert.strictEqual(pool.calls.length, 1, 'exactly one SELECT, no write');
});

test('getSettings with no key list returns every known key', async () => {
  const bundle = await getSettings(emptyPool());
  assert.deepStrictEqual(Object.keys(bundle).sort(), [
    'ground_item_ttl_seconds', 'passive_points_per_level', 'rarity_weights', 'respec_base_gold',
  ]);
  assert.strictEqual(bundle.respec_base_gold, 50);
});

// A typo'd key that inserts successfully is a setting nothing reads. Both the
// read and the write refuse it, and the write must never reach the database.
test('an unknown key is refused on read and on write, and issues no query', async () => {
  const pool = emptyPool();
  await assert.rejects(() => getSetting(pool, 'passive_points_per_lvl'), /unknown setting/);
  await assert.rejects(() => setSetting(pool, 'passive_points_per_lvl', 2), /unknown setting/);
  assert.strictEqual(pool.calls.length, 0, 'an unknown key must not touch the database at all');
});

test('an unknown key rejects with a 400-shaped error, not a 500-shaped one', async () => {
  await assert.rejects(() => setSetting(emptyPool(), 'nope', 1), (err) => err.status === 400);
});

test('a value of the wrong shape is refused before it reaches the database', async () => {
  const pool = emptyPool();
  for (const bad of [-1, 1.5, 'two', null, undefined, [1]]) {
    await assert.rejects(
      () => setSetting(pool, 'passive_points_per_level', bad),
      /passive_points_per_level/,
      `${JSON.stringify(bad) ?? 'undefined'} must be refused`,
    );
  }
  await assert.rejects(() => setSetting(pool, 'ground_item_ttl_seconds', 0), /ground_item_ttl_seconds/);
  await assert.rejects(() => setSetting(pool, 'rarity_weights', { white: 1 }), /rarity_weights/);
  await assert.rejects(
    () => setSetting(pool, 'rarity_weights', [{ item_level: 1, white: 90, blue: 9, yellow: 1 }]),
    /rarity_weights/,
    'an anchor row missing a rarity must be refused',
  );
  assert.strictEqual(pool.calls.length, 0, 'no invalid value may reach the database');
});

// Weights that do not sum to 100 are ACCEPTED (the roller normalises), but a
// negative weight is not -- that is the one that makes a distribution
// unrepresentable rather than merely unbalanced.
test('rarity weights that do not sum to 100 are accepted; a negative weight is not', async () => {
  const pool = { calls: [], query: async (sql, params) => { pool.calls.push({ sql, params }); return { rows: [{ key: 'rarity_weights', value: [], updated_at: 'now' }], rowCount: 1 }; } };
  await setSetting(pool, 'rarity_weights', [{ item_level: 1, white: 10, blue: 10, yellow: 10, foxy: 10 }]);
  assert.strictEqual(pool.calls.length, 1);
  await assert.rejects(
    () => setSetting(pool, 'rarity_weights', [{ item_level: 1, white: -1, blue: 10, yellow: 10, foxy: 10 }]),
    /rarity_weights/,
  );
});

// --- Design guard: the XP curve is NOT a game setting -----------------------
//
// Design doc section 3.5 is explicit: changing the curve re-levels every
// character in the database on the next read, so it must be a code change with
// a migration attached, not a number an admin types into a form. This test is
// the thing that fails if a later task "helpfully" adds xp_base here.
test('no settings key touches the XP curve, which stays in progressionConstants.js', () => {
  for (const key of Object.keys(DEFAULTS)) {
    assert.doesNotMatch(
      key,
      /xp|experience|curve|exponent|max_level/i,
      `${key} looks like an XP-curve knob; the curve belongs in progressionConstants.js`,
    );
  }

  // The service must not even read the curve module -- an import is how the
  // two would start sharing a value.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../src/services/gameSettings.js'), 'utf8',
  );
  assert.doesNotMatch(source, /progressionConstants|xpToNext|xpFloor|levelForXp/);

  // And the curve really does live there, so this guard is not pinning an
  // empty requirement.
  const constants = require('../src/services/progressionConstants.js');
  assert.strictEqual(typeof constants.XP_BASE, 'number');
  assert.strictEqual(typeof constants.MAX_LEVEL, 'number');
  // The snake_case names those constants would take as settings keys, spelled
  // out by hand rather than derived from the exports, so this stays a real
  // assertion if the constants module is renamed.
  for (const forbidden of ['xp_base', 'xp_exponent', 'max_level', 'xp_curve']) {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(DEFAULTS, forbidden), false,
      `${forbidden} must not be a game setting`,
    );
  }
});

// SOMET-475. RESPEC_BASE stopped being the live respec cost when
// passiveTreeStore started reading gameSettings.respec_base_gold instead, so
// the constant is now a decoy: editable, exported, and read by nothing. The
// one property that still has to hold is that the SETTING's fallback default
// agrees with it, because a database with no game_settings row falls back to
// that default. Without this, someone "updating the respec cost" in
// progressionConstants.js changes nothing at all and no test notices.
test('the retired RESPEC_BASE constant still matches the live setting default', () => {
  const C = require('../src/services/progressionConstants.js');
  assert.strictEqual(DEFAULTS.respec_base_gold, C.RESPEC_BASE);
});
