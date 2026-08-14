// backend/tests/villageScreenBudget.test.js
//
// SOMET-282 — a village must fit in a quarter of the 1280x720 screen.
//
// The rule is a constraint on width + height, which is a shape no per-axis
// maximum can express: the projected bounding box of a w x h village is
// 64(w+h) x 32(w+h) screen px, so 8x3 and 3x8 and 5x6 are all the same size on
// screen and 8x6 is nearly twice the budget.
//
// Three things are tested here, in increasing order of what they would catch:
//
//  1. The DERIVATION, against the frontend source text. villages.js has to
//     copy ISO_TILE_W / GAME_WIDTH / GAME_HEIGHT because the frontend module
//     is ESM and the backend is CommonJS. A copy nobody checks is a copy that
//     drifts, so the frontend files are read and parsed here; if someone
//     changes the tile width or the canvas size, or adds a zoom to the camera,
//     this test names it instead of the limit silently becoming wrong.
//  2. The LIMIT itself, re-derived rather than restated: 10 is asserted to be
//     the largest sum inside the budget AND 11 the smallest outside it.
//  3. Both ENFORCEMENT PATHS. The HTTP admin route (validateVillageBody in
//     src/index.js) and the seed-spec validator (validateMapSpec in
//     seeds/mapSpec.js) each get a real over-budget village and must reject
//     it. These are the two doors a village can come through; SOMET-153
//     shipped three broken villages precisely because only one of them was
//     guarded.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');

const { app, __setPool, __setAuthorityHandle } = require('../src/index.js');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { validateMapSpec } = require('../seeds/mapSpec.js');
const {
  VILLAGE_LIMITS, villageSizeError, villageGeometryError,
  villageScreenBox, VILLAGE_SCREEN_BUDGET_PX2, ISO_K,
} = require('../src/services/villages.js');

const FRONTEND = path.join(
  __dirname, '..', '..', 'frontend', 'src', 'games', 'something2', 'src', 'js', 'core',
);
const readCore = (f) => fs.readFileSync(path.join(FRONTEND, f), 'utf8');

// `export const NAME = 123;` -> 123. Deliberately reads the SOURCE TEXT: the
// backend cannot import an ESM module, and a test that re-typed these numbers
// would agree with villages.js's copy by construction and prove nothing.
function exportedNumber(src, name) {
  const m = new RegExp(`export const ${name}\\s*=\\s*(-?[0-9.]+)\\s*;`).exec(src);
  assert.ok(m, `could not find "export const ${name}" in the frontend source`);
  return Number(m[1]);
}

test.afterEach(() => { __setAuthorityHandle(null); });

test('the screen budget is derived from the real frontend constants', () => {
  const constants = readCore('constants.js');
  const iso = readCore('iso.js');
  const camera = readCore('Camera.js');

  const GAME_WIDTH = exportedNumber(constants, 'GAME_WIDTH');
  const GAME_HEIGHT = exportedNumber(constants, 'GAME_HEIGHT');
  const MAP_TILE_SIZE = exportedNumber(constants, 'MAP_TILE_SIZE');
  const ISO_TILE_W = exportedNumber(constants, 'ISO_TILE_W');

  assert.equal(GAME_WIDTH, 1280);
  assert.equal(GAME_HEIGHT, 720);
  assert.equal(MAP_TILE_SIZE, 100);
  assert.equal(ISO_TILE_W, 128);

  // core/iso.js: ISO_K = ISO_TILE_W / (2 * MAP_TILE_SIZE), and worldToScreen
  // is the 2:1 projection the derivation assumes. Asserted as source text so a
  // change to either invalidates the arithmetic loudly.
  assert.match(iso, /ISO_K\s*=\s*ISO_TILE_W\s*\/\s*\(\s*2\s*\*\s*MAP_TILE_SIZE\s*\)/);
  assert.match(iso, /x:\s*\(wx\s*-\s*wy\)\s*\*\s*ISO_K/);
  assert.match(iso, /y:\s*\(wx\s*\+\s*wy\)\s*\*\s*ISO_K\s*\/\s*2/);
  assert.equal(ISO_K, ISO_TILE_W / (2 * MAP_TILE_SIZE));

  // The camera must be TRANSLATE-ONLY. A zoom would multiply the on-screen
  // area by its square and make every number in this file wrong.
  assert.match(camera, /ctx\.translate\(/);
  assert.ok(!/ctx\.scale\(/.test(camera), 'Camera.apply must not scale — the budget assumes 1 projected px = 1 screen px');
  assert.ok(!/ctx\.setTransform\(/.test(camera), 'Camera.apply must not setTransform — see above');

  assert.equal(VILLAGE_SCREEN_BUDGET_PX2, (GAME_WIDTH * GAME_HEIGHT) / 4);

  // The projection, applied to the four corners of a w x h box, by hand:
  // width = K*(W+H), height = K*(W+H)/2, with W = 100w and H = 100h.
  for (const [w, h] of [[3, 3], [6, 4], [6, 5], [8, 6], [4, 7]]) {
    const span = ISO_K * (w * MAP_TILE_SIZE + h * MAP_TILE_SIZE);
    const box = villageScreenBox(w + h);
    assert.ok(Math.abs(box.width - span) < 1e-6, `${w}x${h} width`);
    assert.ok(Math.abs(box.height - span / 2) < 1e-6, `${w}x${h} height`);
    assert.ok(Math.abs(box.area - (span * span) / 2) < 1e-6, `${w}x${h} area`);
  }
});

test('maxSum is the largest tile sum that fits the budget, and 6x5 does not fit', () => {
  assert.equal(VILLAGE_LIMITS.maxSum, 10, 'the derivation yields 10; if this moved, re-read the comment in villages.js');

  const at = (sum) => villageScreenBox(sum).area;
  assert.ok(at(VILLAGE_LIMITS.maxSum) <= VILLAGE_SCREEN_BUDGET_PX2,
    `sum ${VILLAGE_LIMITS.maxSum} must fit: ${at(VILLAGE_LIMITS.maxSum)} > ${VILLAGE_SCREEN_BUDGET_PX2}`);
  assert.ok(at(VILLAGE_LIMITS.maxSum + 1) > VILLAGE_SCREEN_BUDGET_PX2,
    'maxSum is not maximal — one more tile would still fit');

  // The three concrete shapes this ticket is about.
  assert.equal(Math.round(at(10)), 204800);          // 6x4 -> 640x320, 88.9%
  assert.equal(Math.round(at(11)), 247808);          // 6x5 -> 704x352, 107.6%
  assert.equal(Math.round(at(14)), 401408);          // 8x6 -> 896x448, 174.2%
});

test('villageSizeError constrains the SUM, not either axis alone', () => {
  // Same sum, four different shapes: all legal or all illegal together. A
  // per-axis maximum cannot produce this pattern, which is the whole point.
  for (const [w, h] of [[3, 7], [4, 6], [5, 5], [6, 4], [7, 3]]) {
    assert.equal(villageSizeError({ width: w, height: h }), null, `${w}x${h} (sum 10) must be legal`);
  }
  for (const [w, h] of [[4, 7], [5, 6], [6, 5], [7, 4], [8, 6]]) {
    const err = villageSizeError({ width: w, height: h });
    assert.ok(err, `${w}x${h} (sum ${w + h}) must be rejected`);
    assert.match(err, /width \+ height must be at most 10 tiles/);
    assert.match(err, new RegExp(`got ${w} \\+ ${h} = ${w + h}`));
  }
  // Non-integers are somebody else's error to report.
  assert.equal(villageSizeError({ width: 6.5, height: 5 }), null);
  assert.equal(villageSizeError(undefined), null);
});

test('the size rule and the interior-spawn rule are one shared entry point', () => {
  // Both validators -- validateVillageBody (HTTP) and validateMapSpec (seed)
  // -- call villageGeometryError by that one name. A second entry point is
  // how the two paths drift, which is exactly the SOMET-153 failure: the
  // interior-spawn rule existed on the route but not on the seed path, and
  // the seed path is the one that wrote three broken villages.
  const box = { min_row: 28, min_col: 28, width: 6, height: 4, gate_edge: 'S' };
  assert.equal(villageGeometryError({ ...box, spawn_x: 3050, spawn_y: 2950 }), null);
  // Box illegal AND spawn illegal -> the box error wins, because fixing the
  // spawn first would be wasted work.
  assert.match(
    villageGeometryError({ ...box, height: 5, spawn_x: 3250, spawn_y: 3250 }),
    /width \+ height must be at most 10 tiles/,
  );
});

// --- enforcement path 1: the HTTP admin route ------------------------------

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

function mockPool(handlers) {
  const calls = [];
  const dispatch = async (sql, params) => {
    if (isUserLookup(sql)) return ADMIN_USER_ROW;
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return { rows: [] };
    calls.push({ sql, params });
    if (/SELECT level_max FROM worlds WHERE id = \$1/i.test(sql)) return { rows: [{ level_max: 1 }] };
    if (/SELECT hp, defense FROM entity_types WHERE name = \$1/i.test(sql)) return { rows: [{ hp: 300, defense: 10 }] };
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
    throw new Error(`unexpected query: ${sql}`);
  };
  return { calls, query: dispatch, connect: async () => ({ query: dispatch, release: () => {} }) };
}

const routePool = () => mockPool([
  [/SELECT id, width, height FROM worlds WHERE id = \$1/i, (p) => ({ rows: [{ id: p[0], width: 64, height: 64 }] })],
  [/SELECT min_row, min_col, width, height FROM villages WHERE world_id/i, () => ({ rows: [] })],
  [/INSERT INTO villages/i, (p) => ({ rows: [{
    id: 'v1', min_row: p[1], min_col: p[2], width: p[3], height: p[4], gate_edge: p[5],
  }] })],
  [/INSERT INTO world_creatures/i, () => ({ rows: [] })],
  [/INSERT INTO merchant_stock/i, () => ({ rows: [] })],
  [/DELETE FROM world_chunks/i, () => ({ rows: [], rowCount: 0 })],
]);

test('POST /villages rejects a village over the screen budget', async () => {
  const pool = routePool();
  __setPool(pool);
  // 6x5, gate S at (28,28), spawn on a legal INTERIOR tile of that box (row
  // 30, col 31) — so the ONLY thing wrong with this request is its size. A
  // fixture that also broke the spawn rule would pass even with the size check
  // deleted.
  const res = await request(app).post('/api/worlds/w1/villages').set(...AUTH)
    .send({ min_row: 28, min_col: 28, width: 6, height: 5, gate_edge: 'S', spawn_x: 3150, spawn_y: 3050 });

  assert.equal(res.status, 400, `expected rejection, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.match(res.body.error, /width \+ height must be at most 10 tiles/);
  assert.match(res.body.error, /got 6 \+ 5 = 11/);
  assert.equal(pool.calls.filter((c) => /INSERT INTO villages/i.test(c.sql)).length, 0,
    'an over-budget village must not reach the database');
});

test('POST /villages still accepts the same box at a legal size (control)', async () => {
  const pool = routePool();
  __setPool(pool);
  const res = await request(app).post('/api/worlds/w1/villages').set(...AUTH)
    .send({ min_row: 28, min_col: 28, width: 6, height: 4, gate_edge: 'S', spawn_x: 3050, spawn_y: 2950 });

  assert.equal(res.status, 200, `expected acceptance, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(pool.calls.filter((c) => /INSERT INTO villages/i.test(c.sql)).length, 1);
});

// --- enforcement path 2: the seed-spec validator ---------------------------

// entry_spawn is derived from the village rather than written as a literal:
// `hub` is the entry world, and SOMET-335 requires an entry world's
// entry_spawn to BE the spawn of the village it declares. Deriving it keeps
// every case below -- legal and over-budget alike -- about the SIZE rule these
// tests are named for, with no second unrelated error to filter out.
const specWith = (village) => ({
  worlds: [{
    key: 'hub', name: 'Hub', grid: [0, 0], width: 64, height: 64, is_entry: true, village,
    entry_spawn: { x: village.spawn_x, y: village.spawn_y },
  }],
  links: [],
});

test('validateMapSpec rejects a village over the screen budget', () => {
  const errors = validateMapSpec(specWith({
    min_row: 28, min_col: 28, width: 6, height: 5, gate_edge: 'S',
    spawn_x: 3150, spawn_y: 3050,   // legal interior tile of the 6x5 box
  }));
  const sizeErrors = errors.filter((e) => /width \+ height must be at most/.test(e));
  assert.equal(sizeErrors.length, 1, `expected one size error, got ${JSON.stringify(errors)}`);
  assert.match(sizeErrors[0], /world "hub" village/);
  assert.match(sizeErrors[0], /got 6 \+ 5 = 11/);
});

test('validateMapSpec accepts the same box at a legal size (control)', () => {
  assert.deepEqual(validateMapSpec(specWith({
    min_row: 28, min_col: 28, width: 6, height: 4, gate_edge: 'S',
    spawn_x: 3050, spawn_y: 2950,
  })), []);
});

test('every village in every checked-in map spec fits the screen budget', () => {
  const MAPS_DIR = path.join(__dirname, '..', 'seeds', 'maps');
  const files = fs.readdirSync(MAPS_DIR).filter((f) => f.endsWith('.map.json'));
  let seen = 0;
  for (const file of files) {
    const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, file), 'utf8'));
    for (const w of spec.worlds ?? []) {
      if (!w.village) continue;
      seen++;
      assert.equal(
        villageSizeError(w.village), null,
        `${file} world "${w.key}" (${w.name}) village ${w.village.width}x${w.village.height} is over the screen budget`,
      );
    }
  }
  assert.ok(seen >= 4, `expected the four authored villages, found ${seen} — the test is not exercising anything`);
});
