const test = require('node:test');
const assert = require('node:assert');
const { rollDrops, dropItem, claimItem } = require('../src/authority/loot');
const { World } = require('../src/authority/world');

// Minimal armed entry: one player 'u1' holding item 'i1' (item_type_id 7),
// plus the `claiming` set claimItem needs. Mirrors authorityLoot.test.js's
// armDropEntry/armClaimEntry setup, kept local here since this file only
// needs it for the two stack-quantity cases below.
function mkEntry() {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  const entry = {
    worldId: 'w1',
    world: new World(map, new Map(), null, 8),
    creatureTypeIds: new Map(),
    claiming: new Set(),
  };
  entry.world.addPlayer('u1', { x: 300, y: 400 }, { items: [{ id: 'i1', typeId: 7 }], equipment: {} });
  return entry;
}

// Deterministic rng returning a scripted sequence.
function seq(...vals) { let i = 0; return () => (i < vals.length ? vals[i++] : 0); }

test('no drop rows yields nothing', () => {
  assert.deepStrictEqual(rollDrops([], seq(0)), []);
  assert.deepStrictEqual(rollDrops(undefined, seq(0)), []);
});

test('chance 1 always drops', () => {
  const rows = [{ item_type_id: 5, chance: '1', min_qty: 1, max_qty: 1 }];
  assert.deepStrictEqual(rollDrops(rows, seq(0.999, 0)), [5]);
});

test('chance 0.5 respects the rng on both sides', () => {
  const rows = [{ item_type_id: 5, chance: '0.5', min_qty: 1, max_qty: 1 }];
  assert.deepStrictEqual(rollDrops(rows, seq(0.4, 0)), [5], 'roll under chance drops');
  assert.deepStrictEqual(rollDrops(rows, seq(0.5, 0)), [], 'roll at chance does not drop');
  assert.deepStrictEqual(rollDrops(rows, seq(0.9, 0)), [], 'roll over chance does not drop');
});

test('quantity spans min..max inclusive', () => {
  const rows = [{ item_type_id: 7, chance: '1', min_qty: 2, max_qty: 4 }];
  assert.deepStrictEqual(rollDrops(rows, seq(0, 0)), [7, 7], 'rng 0 -> min');
  assert.deepStrictEqual(rollDrops(rows, seq(0, 0.999)), [7, 7, 7, 7], 'rng ~1 -> max');
});

test('each row rolls independently', () => {
  const rows = [
    { item_type_id: 1, chance: '1', min_qty: 1, max_qty: 1 },
    { item_type_id: 2, chance: '0.1', min_qty: 1, max_qty: 1 },
    { item_type_id: 3, chance: '1', min_qty: 1, max_qty: 1 },
  ];
  // row1: drop(0) qty(0) | row2: 0.9 -> skip | row3: drop(0) qty(0)
  assert.deepStrictEqual(rollDrops(rows, seq(0, 0, 0.9, 0, 0)), [1, 3]);
});

test('malformed quantities degrade to a single drop rather than throwing', () => {
  const rows = [{ item_type_id: 9, chance: '1', min_qty: null, max_qty: null }];
  assert.deepStrictEqual(rollDrops(rows, seq(0, 0)), [9]);
});

test('chance 0 drops nothing', () => {
  const rows = [{ item_type_id: 1, chance: '0', min_qty: 1, max_qty: 1 }];
  assert.deepStrictEqual(rollDrops(rows, seq(0, 0)), []);
});

test('a negative chance drops nothing', () => {
  const rows = [{ item_type_id: 1, chance: '-0.5', min_qty: 1, max_qty: 1 }];
  assert.deepStrictEqual(rollDrops(rows, seq(0, 0)), []);
});

test('a NaN chance drops nothing', () => {
  const rows = [{ item_type_id: 1, chance: 'not-a-number', min_qty: 1, max_qty: 1 }];
  assert.deepStrictEqual(rollDrops(rows, seq(0, 0)), []);
});

test('a huge max_qty is clamped rather than hanging the process', () => {
  // Migration 1714440018000 only enforces min_qty <= max_qty — nothing caps
  // max_qty itself, so a bad catalog row (or a future admin typo) could set
  // max_qty way above MAX_DROP_QTY. rollDrops must clamp internally rather
  // than trust the row. 5000 is far above MAX_DROP_QTY (100) but small enough
  // that an unclamped run still fails fast instead of exhausting the heap.
  const rows = [{ item_type_id: 3, chance: '1', min_qty: 1, max_qty: 5000 }];
  const out = rollDrops(rows, seq(0, 0.999999)); // roll(drop)=0 -> drops; roll(qty)~1 -> picks the max
  assert.ok(out.length <= 100, `expected at most 100 entries, got ${out.length}`);
  assert.ok(out.length > 0, 'still drops something');
  assert.ok(out.every((id) => id === 3));
});

test('a huge min_qty is clamped rather than hanging the process', () => {
  // The DB CHECK only enforces min_qty >= 1 and max_qty >= min_qty — nothing
  // caps min_qty itself. The old clamp only bounded `max`, so a large
  // min_qty (with max_qty == min_qty) sailed straight through unclamped.
  // Use a value far above MAX_DROP_QTY but small enough to fail fast rather
  // than exhaust the heap if the clamp regresses.
  const rows = [{ item_type_id: 4, chance: '1', min_qty: 5000, max_qty: 5000 }];
  const out = rollDrops(rows, seq(0, 0));
  assert.ok(out.length <= 100, `expected at most 100 entries, got ${out.length}`);
  assert.ok(out.length > 0, 'still drops something');
  assert.ok(out.every((id) => id === 4));
});

test('rng closer to 1 never yields fewer items than rng closer to 0, even above MAX_DROP_QTY', () => {
  // min_qty (150) is above MAX_DROP_QTY (100). This exercises the case where
  // the naive "clamp `max` only" approach made `max - min + 1` negative,
  // which made higher rng values roll SMALLER quantities. Clamping the
  // final result instead keeps the roll monotonic in rng regardless of
  // min/max size.
  const rows = [{ item_type_id: 6, chance: '1', min_qty: 150, max_qty: 300 }];
  const low = rollDrops(rows, seq(0, 0));
  const high = rollDrops(rows, seq(0, 0.999999));
  assert.ok(high.length >= low.length, `expected high-rng roll (${high.length}) >= low-rng roll (${low.length})`);
  assert.ok(low.length <= 100 && high.length <= 100);
});

test('dropping a stack carries the DELETEd quantity through to the INSERT via SQL, not a JS param', async () => {
  // dropItem's DELETE and INSERT are one CTE statement (F-016 / SOMET-196:
  // they used to be two independent pool.query calls with no transaction,
  // which could destroy a dropped item if the second failed after the first
  // committed). Because the pair is now one statement, `quantity` for the
  // INSERT can only come from the SQL projecting it out of the CTE's `d`
  // (the deleted row) -- there is no JS-side params entry to inspect anymore.
  // Without that projection a stack of 40 arrows would drop as 1 and destroy
  // the other 39, so pin the SQL shape directly: the INSERT names `quantity`
  // in its column list and the SELECT ... FROM d projects it (not a literal).
  let sql = '';
  // SOMET-245 final review Critical #1: dropItem now issues a preliminary
  // read-only stone_instances check before the CTE below (see loot.js) --
  // must report "not a stone" (rowCount 0) so it doesn't interfere with this
  // test's SQL-shape assertions on the CTE itself.
  const pool = { query: async (q) => {
    if (/FROM stone_instances/i.test(q)) return { rowCount: 0, rows: [] };
    // SOMET-277: dropItem now also issues a preliminary read-only soulbound
    // check ahead of the CTE (see loot.js) -- same fixture accommodation the
    // stone_instances line above already makes, for the same reason. Must
    // report "not soulbound" (rowCount 0) so the drop proceeds and this
    // test's SQL-shape assertions still see the CTE.
    if (/^\s*SELECT 1 FROM player_items WHERE id/i.test(q)) return { rowCount: 0, rows: [] };
    sql = q;
    return { rowCount: 1, rows: [{ id: 'g1', item_type_id: 7, x: 0, y: 0, quantity: 40 }] };
  } };
  const entry = mkEntry();   // existing helper
  const r = await dropItem(pool, entry, 'u1', 'i1');
  assert.equal(r.ok, true);

  const m = sql.match(/insert\s+into\s+world_items\s*\(([^)]*)\)/i);
  assert.ok(m, 'could not locate the world_items INSERT column list');
  const cols = m[1].split(',').map((c) => c.trim().toLowerCase());
  assert.ok(cols.includes('quantity'), `the drop INSERT must name quantity (found: ${cols.join(', ')})`);

  const sel = sql.match(/select\s+(.*?)\s+from\s+d/is);
  assert.ok(sel, 'could not locate the SELECT ... FROM d projection');
  const exprs = sel[1].split(',').map((e) => e.trim());
  assert.equal(exprs.length, cols.length,
    `the INSERT names ${cols.length} columns but the SELECT projects ${exprs.length} expressions — Postgres would reject this at runtime`);
  assert.ok(exprs.some((e) => /^quantity$/i.test(e)),
    'quantity must be projected FROM d (the deleted row), not a hardcoded literal');
});

test('claiming a stack grants the full quantity', async () => {
  let sql = '';
  const pool = { query: async (q) => {
    sql = q;
    return { rowCount: 1, rows: [{ id: 'i9', item_type_id: 7, quantity: 40 }] };
  } };
  const entry = mkEntry();
  entry.world.addPlayer('u1', { x: 0, y: 0 });
  const r = await claimItem(pool, entry, 'u1', 'g1');
  assert.equal(r.quantity, 40);
  assert.ok(sql.includes('quantity'), 'the claim CTE must carry quantity across');
});

// A bare sql.includes('quantity') does NOT guard this statement: the word
// appears in the DELETE's RETURNING, in the SELECT list and in the final
// RETURNING, so dropping it from the INSERT's column list alone leaves such a
// test green while every claimed stack silently collapses to the column
// default of 1. Parse the INSERT's own column list instead, and check the
// SELECT projects as many expressions as the INSERT names — a mismatch is a
// runtime Postgres error the mock pool can never surface.
test('the claim CTE INSERT names quantity in its own column list', async () => {
  let sql = '';
  const pool = { query: async (q) => {
    sql = q;
    return { rowCount: 1, rows: [{ id: 'i9', item_type_id: 7, quantity: 40 }] };
  } };
  const entry = mkEntry();
  entry.world.addPlayer('u1', { x: 0, y: 0 });
  await claimItem(pool, entry, 'u1', 'g1');

  const m = sql.match(/insert\s+into\s+player_items\s*\(([^)]*)\)/i);
  assert.ok(m, 'could not locate the player_items INSERT column list');
  const cols = m[1].split(',').map((c) => c.trim().toLowerCase());
  assert.ok(cols.includes('quantity'),
    `the claim INSERT must name quantity in its column list (found: ${cols.join(', ')}) — without it a claimed stack of 40 becomes 1`);

  const sel = sql.match(/select\s+(.*?)\s+from\s+d/is);
  assert.ok(sel, 'could not locate the SELECT ... FROM d projection');
  const exprs = sel[1].split(',').map((e) => e.trim());
  assert.equal(exprs.length, cols.length,
    `the INSERT names ${cols.length} columns but the SELECT projects ${exprs.length} expressions — Postgres would reject this at runtime`);
});
