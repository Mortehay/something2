const test = require('node:test');
const assert = require('node:assert');
const { fetchLinks } = require('../src/services/mapLinks.js');
const { fetchWaypoints } = require('../src/services/waypoints.js');
const { fetchVillages } = require('../src/services/villages.js');
const { fetchChests, mapChestRow } = require('../src/services/chests.js');

// Each fetcher must carry its art NAME out of the one query it already
// makes -- a second loader is the SOMET-249 inertness trap.
test('fetchLinks joins the art name onto every row', async () => {
  const pool = { query: async (sql) => {
    assert.match(sql, /LEFT JOIN entity_types \w+ ON \w+\.id = ml\.entity_type_id/);
    assert.match(sql, /AS art/);
    return { rows: [{ id: 1, edge: 'PORTAL', art: 'stone_gate' }] };
  } };
  const rows = await fetchLinks(pool, 'w');
  assert.strictEqual(rows[0].art, 'stone_gate');
});

test('fetchWaypoints maps art', async () => {
  const pool = { query: async (sql) => {
    assert.match(sql, /LEFT JOIN entity_types/);
    return { rows: [{ id: 'a', world_id: 'w', x: '1', y: '2', name: 'S', map_link_id: null, art: null }] };
  } };
  const [w] = await fetchWaypoints(pool, 'w');
  assert.strictEqual(w.art, null);
});

test('fetchVillages maps the four post art names', async () => {
  const pool = { query: async (sql) => {
    for (const c of ['merchant_entity_type_id', 'bank_entity_type_id', 'gem_merchant_entity_type_id', 'skill_merchant_entity_type_id']) {
      assert.match(sql, new RegExp(c));
    }
    return { rows: [{ id: 'v', min_row: 0, min_col: 0, width: 8, height: 8, gate_edge: 'S', spawn_x: 1, spawn_y: 1,
      merchant_x: 450, merchant_y: 450, merchant_art: 'merchant_post', bank_art: null, gem_merchant_art: null, skill_merchant_art: 'lectern' }] };
  } };
  const [v] = await fetchVillages(pool, 'w');
  assert.deepStrictEqual(
    { m: v.merchantArt, b: v.bankArt, g: v.gemMerchantArt, s: v.skillMerchantArt },
    { m: 'merchant_post', b: null, g: null, s: 'lectern' },
  );
});

test('mapChestRow carries art and defaults it to null for a raw RETURNING row', () => {
  assert.strictEqual(mapChestRow({ id: 1, x: 1, y: 1, kind: 'vault', state: 'locked', art: 'chest_vault' }).art, 'chest_vault');
  assert.strictEqual(mapChestRow({ id: 1, x: 1, y: 1, kind: 'field', state: 'locked' }).art, null);
});

test('fetchChests joins the art name', async () => {
  const pool = { query: async (sql) => {
    assert.match(sql, /LEFT JOIN entity_types/);
    return { rows: [{ id: 1, x: 1, y: 1, kind: 'vault', state: 'locked', art: 'chest_vault' }] };
  } };
  const [c] = await fetchChests(pool, 'w');
  assert.strictEqual(c.art, 'chest_vault');
});

// A source gate -- it proves the call is WRITTEN, not that it runs; the live
// test (landmarks_joined_live.test.js) proves it runs.
test('resolvePointArt is what the joined frame and the chests frame call', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/authority/server.js'), 'utf8');
  assert.match(src, /art: resolvePointArt\('merchant', v\.merchantArt, entry\.pointArtDefaults\)/);
  assert.match(src, /art: resolvePointArt\('bank', v\.bankArt, entry\.pointArtDefaults\)/);
  assert.match(src, /art: resolvePointArt\('gem_merchant', v\.gemMerchantArt, entry\.pointArtDefaults\)/);
  assert.match(src, /art: resolvePointArt\('skill_merchant', v\.skillMerchantArt, entry\.pointArtDefaults\)/);
  assert.match(src, /art: resolvePointArt\(chestPointKind\(c\.kind\), c\.art, entry\.pointArtDefaults\)/);
  assert.match(src, /artDefaults: entry\.pointArtDefaults/);
});
