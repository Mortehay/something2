const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, __setPool, validateItemType } = require('../src/index.js');

// A pool mock whose query() dispatches on the SQL text. `handlers` is an array
// of [regex, (params) => ({ rows }|Promise)] pairs, tried in order.
function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const [re, fn] of handlers) {
        if (re.test(sql)) return fn(params);
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const VALID_MELEE = {
  name: 'shortsword', category: 'weapon', kind: 'melee', reach: 60, arc_width: 0.5,
};

test('GET /api/item-types returns the catalog', async () => {
  __setPool(mockPool([
    [/FROM item_types/i, () => ({ rows: [{ id: 1, name: 'dagger', category: 'weapon' }] })],
  ]));
  const res = await request(app).get('/api/item-types');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, 'dagger');
});

test('POST /api/item-types creates a valid weapon (happy path)', async () => {
  __setPool(mockPool([
    [/INSERT INTO item_types/i, (p) => ({ rows: [{ id: 10, name: p[0], category: p[1] }] })],
  ]));
  const res = await request(app).post('/api/item-types').send(VALID_MELEE);
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 10);
  assert.equal(res.body.name, 'shortsword');
});

test('POST /api/item-types rejects an unknown element', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/item-types').send({
    name: 'x', category: 'weapon', kind: 'melee', reach: 10, arc_width: 1, element: 'plasma',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /element/i);
});

test('POST /api/item-types rejects a melee weapon missing reach/arc_width', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/item-types').send({
    name: 'x', category: 'weapon', kind: 'melee',
  });
  assert.equal(res.status, 400);
});

test('POST /api/item-types rejects armor missing slot/defense', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/item-types').send({
    name: 'x', category: 'armor',
  });
  assert.equal(res.status, 400);
});

test('POST /api/item-types rejects resistances with an unknown element key', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/item-types').send({
    name: 'x', category: 'armor', slot: 'chest', defense: 1, resistances: { plasma: 0.5 },
  });
  assert.equal(res.status, 400);
});

test('POST /api/item-types rejects a non-numeric resistance value', async () => {
  // A string resistance value flows unvalidated into items.js mitigation()
  // (string concat), then damage.js (raw2 * (1 - NaN)), landing hp on NaN —
  // resolveDeaths() never fires on NaN <= 0, so the target is permanently
  // immortal. Must be rejected at the API boundary.
  __setPool(mockPool([]));
  const res = await request(app).post('/api/item-types').send({
    name: 'x', category: 'armor', slot: 'chest', defense: 1, resistances: { fire: 'x' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /resistances/i);
});

test('POST /api/item-types rejects a negative resistance value', async () => {
  // A negative resistance amplifies damage instead of reducing it.
  __setPool(mockPool([]));
  const res = await request(app).post('/api/item-types').send({
    name: 'x', category: 'armor', slot: 'chest', defense: 1, resistances: { fire: -0.5 },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /resistances/i);
});

test('POST /api/item-types accepts a valid in-range resistance value', async () => {
  __setPool(mockPool([
    [/INSERT INTO item_types/i, (p) => ({ rows: [{ id: 11, name: p[0], category: p[1] }] })],
  ]));
  const res = await request(app).post('/api/item-types').send({
    name: 'x', category: 'armor', slot: 'chest', defense: 1, resistances: { fire: 0.25 },
  });
  assert.equal(res.status, 201);
});

test('POST /api/item-types rejects armor with a stray non-null kind (400, not 500)', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/item-types').send({
    name: 'stray-kind-armor', category: 'armor', slot: 'chest', defense: 1, kind: 'anything',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /kind/i);
});

test('PUT /api/item-types/:id rejects armor with a stray non-null kind (400, not 500)', async () => {
  __setPool(mockPool([]));
  const res = await request(app).put('/api/item-types/1').send({
    name: 'stray-kind-armor', category: 'armor', slot: 'chest', defense: 1, kind: 'anything',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /kind/i);
});

test('rejects a negative stamina_cost', () => {
  const err = validateItemType({ name: 'x', category: 'weapon', kind: 'melee', reach: 10, arc_width: 1, stamina_cost: -1 });
  assert.match(err, /stamina_cost/i);
});

test('rejects a non-numeric stamina_cost', () => {
  const err = validateItemType({ name: 'x', category: 'weapon', kind: 'melee', reach: 10, arc_width: 1, stamina_cost: 'lots' });
  assert.match(err, /stamina_cost/i);
});

test('accepts a valid stamina_cost', () => {
  assert.strictEqual(
    validateItemType({ name: 'x', category: 'weapon', kind: 'melee', reach: 10, arc_width: 1, stamina_cost: 5 }),
    null,
  );
});

test('accepts an absent stamina_cost (defaults server-side)', () => {
  assert.strictEqual(
    validateItemType({ name: 'x', category: 'weapon', kind: 'melee', reach: 10, arc_width: 1 }),
    null,
  );
});

// Helpers to pull the column list and the aligned $n placeholders out of the
// actual SQL text sent to the pool, rather than hardcoding positions (which
// would themselves need updating on the next column addition).
function insertColumnsAndPlaceholders(sql) {
  const colMatch = sql.match(/INSERT INTO item_types\s*\(([^)]+)\)/i);
  assert.ok(colMatch, 'INSERT must have an explicit column list');
  const columns = colMatch[1].split(',').map((c) => c.trim());
  const valuesMatch = sql.match(/VALUES\s*\(([^)]+)\)/i);
  assert.ok(valuesMatch, 'INSERT must have an explicit VALUES list');
  const placeholders = valuesMatch[1].split(',').map((p) => p.trim());
  return { columns, placeholders };
}

function updateColumnsAndPlaceholders(sql) {
  const setMatch = sql.match(/SET([\s\S]*?)WHERE/i);
  assert.ok(setMatch, 'UPDATE must have a SET...WHERE clause');
  const pairs = [...setMatch[1].matchAll(/(\w+)\s*=\s*\$(\d+)/g)];
  assert.ok(pairs.length > 0, 'UPDATE SET clause must assign at least one column');
  return { columns: pairs.map((m) => m[1]), placeholders: pairs.map((m) => `$${m[2]}`) };
}

// index into `params` (the array actually passed to pool.query) for `col`,
// found by its position in the column list, not a hardcoded number.
function paramFor(columns, placeholders, params, col) {
  const idx = columns.indexOf(col);
  assert.ok(idx >= 0, `column list must include ${col}`);
  const n = parseInt(placeholders[idx].replace('$', ''), 10);
  return params[n - 1];
}

const LOAD_BEARING_COLUMNS = [
  'stamina_cost', 'mana_cost', 'element', 'damage', 'cooldown', 'reach', 'arc_width',
  'range', 'projectile_speed', 'projectile_radius', 'pierce', 'defense', 'resistances',
  'category', 'slot', 'two_handed', 'kind', 'name',
];

// The mock pool dispatches on SQL text but never asserted the column list or
// parameter positions, so neither an arity break (dropping a column from the
// list while leaving its placeholder in VALUES) nor a positional swap
// (e.g. stamina_cost and element trading places in the params array) could
// ever fail this suite — verified both independently leave it green without
// this test. Assert on the actual SQL + params sent to the pool.
test('POST /api/item-types INSERT names every load-bearing column with a positionally-aligned placeholder', async () => {
  const pool = mockPool([
    [/INSERT INTO item_types/i, (p) => ({ rows: [{ id: 10, name: p[0], category: p[1] }] })],
  ]);
  __setPool(pool);
  const body = {
    name: 'x', category: 'weapon', kind: 'melee', reach: 10, arc_width: 1,
    stamina_cost: 7, element: 'fire',
  };
  const res = await request(app).post('/api/item-types').send(body);
  assert.equal(res.status, 201);

  const call = pool.calls.find((c) => /INSERT INTO item_types/i.test(c.sql));
  assert.ok(call, 'expected an INSERT to have been issued');
  const { columns, placeholders } = insertColumnsAndPlaceholders(call.sql);

  for (const col of LOAD_BEARING_COLUMNS) {
    assert.ok(columns.includes(col), `INSERT column list must name ${col}`);
  }
  assert.equal(
    placeholders.length, columns.length,
    'every INSERT column must have exactly one aligned $n placeholder',
  );
  assert.strictEqual(paramFor(columns, placeholders, call.params, 'stamina_cost'), body.stamina_cost);
  assert.strictEqual(paramFor(columns, placeholders, call.params, 'element'), body.element);
  assert.strictEqual(paramFor(columns, placeholders, call.params, 'name'), body.name);
});

test('PUT /api/item-types/:id UPDATE names every load-bearing column with a positionally-aligned placeholder', async () => {
  const pool = mockPool([
    [/UPDATE item_types/i, (p) => ({ rows: [{ id: 1, name: p[0], category: p[1] }] })],
  ]);
  __setPool(pool);
  const body = {
    name: 'y', category: 'weapon', kind: 'melee', reach: 20, arc_width: 2,
    stamina_cost: 9, element: 'ice',
  };
  const res = await request(app).put('/api/item-types/1').send(body);
  assert.equal(res.status, 200);

  const call = pool.calls.find((c) => /UPDATE item_types/i.test(c.sql));
  assert.ok(call, 'expected an UPDATE to have been issued');
  const { columns, placeholders } = updateColumnsAndPlaceholders(call.sql);

  for (const col of LOAD_BEARING_COLUMNS) {
    assert.ok(columns.includes(col), `UPDATE SET clause must name ${col}`);
  }
  assert.equal(
    placeholders.length, columns.length,
    'every UPDATE SET column must have exactly one aligned $n placeholder',
  );
  assert.strictEqual(paramFor(columns, placeholders, call.params, 'stamina_cost'), body.stamina_cost);
  assert.strictEqual(paramFor(columns, placeholders, call.params, 'element'), body.element);
  assert.strictEqual(paramFor(columns, placeholders, call.params, 'name'), body.name);
});

test('POST /api/players/:userId/items grants an item instance', async () => {
  const pool = mockPool([
    [/INSERT INTO player_items/i, (p) => ({ rows: [{ id: 'pi1', user_id: p[0], item_type_id: p[1] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/players/user-1/items').send({ item_type_id: 3 });
  assert.equal(res.status, 201);
  assert.equal(res.body.item_type_id, 3);
  assert.ok(pool.calls.some((c) => /INSERT INTO player_items/i.test(c.sql)));
});
