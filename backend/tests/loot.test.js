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

test('dropping a stack of N spawns one ground item of quantity N', async () => {
  // The DELETE returns the dropped row's quantity; the INSERT must carry it.
  // Without this a stack of 40 arrows drops as 1 and destroys 39.
  const seen = [];
  const pool = { query: async (sql, params) => {
    seen.push({ sql, params });
    if (/delete\s+from\s+player_items/i.test(sql)) {
      return { rowCount: 1, rows: [{ item_type_id: 7, quantity: 40 }] };
    }
    return { rowCount: 1, rows: [{ id: 'g1', item_type_id: 7, x: 0, y: 0, quantity: 40 }] };
  } };
  const entry = mkEntry();   // existing helper
  const r = await dropItem(pool, entry, 'u1', 'i1');
  assert.equal(r.ok, true);
  const ins = seen.find((c) => /insert\s+into\s+world_items/i.test(c.sql));
  assert.ok(ins.sql.includes('quantity'), 'the world_items INSERT must name quantity');
  assert.ok(ins.params.includes(40), 'the dropped stack size must reach the INSERT');
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
