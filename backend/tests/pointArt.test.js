const test = require('node:test');
const assert = require('node:assert');
const {
  chestPointKind, resolvePointArt, loadPointKindDefaults, loadPointTypeNames, applyPointArt,
} = require('../src/services/pointArt.js');

test('chestPointKind maps the two chest kinds and rejects others', () => {
  assert.strictEqual(chestPointKind('vault'), 'chest_vault');
  assert.strictEqual(chestPointKind('field'), 'chest_field');
  assert.throws(() => chestPointKind('gold'), /unknown chest kind/);
});

test('resolvePointArt: instance beats default beats nothing', () => {
  const defaults = new Map([['portal', 'portal']]);
  assert.strictEqual(resolvePointArt('portal', 'stone_gate', defaults), 'stone_gate');
  assert.strictEqual(resolvePointArt('portal', null, defaults), 'portal');
  assert.strictEqual(resolvePointArt('portal', undefined, defaults), 'portal');
  assert.strictEqual(resolvePointArt('waypoint', null, defaults), null);
  assert.strictEqual(resolvePointArt('waypoint', null, undefined), null);
});

test('loadPointKindDefaults keeps only kinds that have a default', async () => {
  const db = { query: async (sql) => {
    assert.match(sql, /FROM world_point_kinds/);
    return { rows: [{ kind: 'portal', name: 'portal' }, { kind: 'waypoint', name: null }] };
  } };
  const m = await loadPointKindDefaults(db);
  assert.deepStrictEqual([...m.entries()], [['portal', 'portal']]);
});

test('loadPointTypeNames maps name -> kind for point types only', async () => {
  const db = { query: async (sql) => {
    assert.match(sql, /WHERE point_kind IS NOT NULL/);
    return { rows: [{ name: 'portal', point_kind: 'portal' }, { name: 'bank_post', point_kind: 'bank' }] };
  } };
  const m = await loadPointTypeNames(db);
  assert.deepStrictEqual([...m.entries()], [['portal', 'portal'], ['bank_post', 'bank']]);
});

// Captures every UPDATE so the convergence rule ("spec silent => NULL") is
// asserted on the SQL actually issued, not on a return value.
function capturingClient(typeRows) {
  const writes = [];
  return {
    writes,
    query: async (sql, params) => {
      if (/SELECT id, name, point_kind FROM entity_types/.test(sql)) return { rows: typeRows };
      writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rowCount: 1, rows: [] };
    },
  };
}
const TYPE_ROWS = [
  { id: 1, name: 'stone_gate', point_kind: 'portal' },
  { id: 2, name: 'waypoint_stone', point_kind: 'waypoint' },
  { id: 3, name: 'merchant_post', point_kind: 'merchant' },
  { id: 4, name: 'chest_vault', point_kind: 'chest_vault' },
];
const idByKey = new Map([['a', 'wid-a'], ['b', 'wid-b']]);

test('applyPointArt writes both rows of a portal pair and NULLs an unbound portal', async () => {
  const client = capturingClient(TYPE_ROWS);
  const spec = { worlds: [{ key: 'a' }, { key: 'b' }], links: [
    { kind: 'portal', from: 'a', to: 'b', from_x: 550, from_y: 1550, to_x: 550, to_y: 550, art: 'stone_gate' },
    { kind: 'portal', from: 'a', to: 'b', from_x: 950, from_y: 950, to_x: 1550, to_y: 1550 },
    { kind: 'compass', from: 'a', to: 'b', edge: 'E' },
  ] };
  const n = await applyPointArt(client, spec, idByKey);
  assert.strictEqual(n.portals, 2);
  const portalWrites = client.writes.filter((w) => /UPDATE map_links/.test(w.sql));
  assert.strictEqual(portalWrites.length, 4);
  assert.deepStrictEqual(portalWrites.map((w) => w.params), [
    ['wid-a', 550, 1550, 1], ['wid-b', 550, 550, 1],
    ['wid-a', 950, 950, null], ['wid-b', 1550, 1550, null],
  ]);
  for (const w of portalWrites) assert.match(w.sql, /edge = 'PORTAL'/);
});

test('applyPointArt binds waypoints by name (both authoring routes)', async () => {
  const client = capturingClient(TYPE_ROWS);
  const spec = { worlds: [{ key: 'a', waypoints: [{ x: 1, y: 1, name: 'Stone A', art: 'waypoint_stone' }] }, { key: 'b' }],
    links: [{ kind: 'portal', from: 'a', to: 'b', from_x: 5, from_y: 5, to_x: 6, to_y: 6, is_waypoint: true, waypoint_name: 'Gate A' }] };
  await applyPointArt(client, spec, idByKey);
  const wps = client.writes.filter((w) => /UPDATE waypoints/.test(w.sql)).map((w) => w.params);
  assert.deepStrictEqual(wps, [['Gate A', null], ['Stone A', 2]]);
});

test('applyPointArt writes all four village columns keyed by spec_key, and the vault chest', async () => {
  const client = capturingClient(TYPE_ROWS);
  const spec = { worlds: [
    { key: 'a', village: { key: 'v1', art: { merchant: 'merchant_post' } }, chest: { x: 1, y: 1, art: 'chest_vault' } },
    { key: 'b', villages: [{ key: 'v2' }], chest: { x: 2, y: 2 } },
  ], links: [] };
  const n = await applyPointArt(client, spec, idByKey);
  assert.deepStrictEqual({ villages: n.villages, chests: n.chests }, { villages: 2, chests: 2 });
  const vil = client.writes.filter((w) => /UPDATE villages/.test(w.sql));
  assert.match(vil[0].sql, /merchant_entity_type_id = \$3, bank_entity_type_id = \$4, gem_merchant_entity_type_id = \$5, skill_merchant_entity_type_id = \$6 WHERE world_id = \$1 AND spec_key = \$2/);
  assert.deepStrictEqual(vil.map((w) => w.params), [['wid-a', 'v1', 3, null, null, null], ['wid-b', 'v2', null, null, null, null]]);
  const ch = client.writes.filter((w) => /UPDATE world_chests/.test(w.sql));
  assert.match(ch[0].sql, /WHERE world_id = \$1 AND kind = 'vault'/);
  assert.deepStrictEqual(ch.map((w) => w.params), [['wid-a', 4], ['wid-b', null]]);
});

test('applyPointArt throws on a name of the wrong kind rather than binding it', async () => {
  const client = capturingClient(TYPE_ROWS);
  const spec = { worlds: [{ key: 'a' }, { key: 'b' }],
    links: [{ kind: 'portal', from: 'a', to: 'b', from_x: 1, from_y: 1, to_x: 2, to_y: 2, art: 'merchant_post' }] };
  await assert.rejects(() => applyPointArt(client, spec, idByKey), /"merchant_post" is not a portal type/);
  assert.strictEqual(client.writes.length, 0);
});
