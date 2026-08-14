const test = require('node:test');
const assert = require('node:assert');
const { loadInventory, grantStartingLoadout } = require('../src/authority/items.js');

// Records queries so we can assert what was written.
function recordingPool(handlers) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql, params);
    return { rows: [], rowCount: 0 };
  };
  return {
    calls,
    query,
    // SOMET-79: grantStartingLoadout runs its claim + inserts in ONE
    // transaction, so it checks out a client rather than using pool.query.
    // A fake pool without `connect` makes it throw before any assertion runs
    // -- the same trap the authority join-path fixtures hit when a new query
    // appeared there. BEGIN/COMMIT/ROLLBACK land in `calls` like any other
    // statement, so a test can still assert on the statements issued.
    connect: async () => ({ query, release: () => {} }),
  };
}

// SOMET-316. The join snapshot is the ONLY loader that can emit soulbound:true
// (grantStartingLoadout is the sole writer of the flag), so if it is dropped
// here no panel can ever mark a carried item bound -- which is exactly what
// shipped with SOMET-310 and left the account chest labelling a stored item and
// not the identical carried one.
//
// Asserted per instance, mixed true/false in one row set, because the bug this
// guards is not "the field is missing" but "the field is constant": a mapper
// that hardcoded false would satisfy the all-false case above and still be
// wrong for every bound item in the game.
test('loadInventory reports soulbound per instance, not per item type', async () => {
  const pool = recordingPool([
    [/FROM player_items/i, () => ({ rows: [
      // Same item_type_id, different provenance: one granted at creation, one
      // looted or bought. That distinction is the entire point of the column.
      { id: 'granted', item_type_id: 10, quantity: 1, soulbound: true },
      { id: 'looted', item_type_id: 10, quantity: 1, soulbound: false },
    ] })],
    [/FROM player_equipment/i, () => ({ rows: [] })],
  ]);
  const inv = await loadInventory(pool, 'c1');
  assert.deepEqual(inv.items.map((i) => [i.id, i.soulbound]), [['granted', true], ['looted', false]]);
});

test('loadInventory selects the soulbound column', async () => {
  const pool = recordingPool([
    [/FROM player_items/i, () => ({ rows: [] })],
    [/FROM player_equipment/i, () => ({ rows: [] })],
  ]);
  await loadInventory(pool, 'c1');
  // Reading the field off a row the query never asked for yields undefined and
  // silently degrades every item to "not bound", so the SELECT list is worth
  // pinning directly rather than only through a fixture that supplies the
  // column regardless of whether it was requested.
  const itemsQuery = pool.calls.find((c) => /FROM player_items/i.test(c.sql));
  assert.match(itemsQuery.sql, /SELECT[^;]*\bsoulbound\b[^;]*FROM player_items/i);
});

test('loadInventory returns owned instances and the equipment map', async () => {
  const pool = recordingPool([
    [/FROM player_items/i, () => ({ rows: [
      { id: 'i1', item_type_id: 1 },
      { id: 'i2', item_type_id: 5 },
    ] })],
    [/FROM player_equipment/i, () => ({ rows: [
      { slot: 'main_hand', item_id: 'i1' },
    ] })],
  ]);
  const inv = await loadInventory(pool, 'u1');
  assert.deepEqual(inv.items, [
    { id: 'i1', typeId: 1, quantity: 1, soulbound: false },
    { id: 'i2', typeId: 5, quantity: 1, soulbound: false },
  ]);
  assert.deepEqual(inv.equipment, { main_hand: 'i1' });
});

// Magic-stones Task 5: loadInventory hydrates each host item's
// socketedStoneTypeId from stone_instances at LOAD time, not just from live
// socketStone/unsocketStone writes during the session (Task 4). Without
// this, a character who joins with an already-socketed weapon -- every
// migration-converted magic weapon included -- would have an empty
// in-memory cache despite the DB truthfully recording a socketed stone.
test('loadInventory hydrates socketedStoneTypeId for a host that already has a stone socketed in the DB', async () => {
  const pool = recordingPool([
    [/FROM player_items/i, () => ({ rows: [
      { id: 'weapon-1', item_type_id: 5 },
      { id: 'stone-1', item_type_id: 40 },
    ] })],
    [/FROM player_equipment/i, () => ({ rows: [{ slot: 'main_hand', item_id: 'weapon-1' }] })],
    [/FROM stone_instances/i, () => ({ rows: [
      { host_id: 'weapon-1', stone_type_id: 40 },
    ] })],
  ]);
  const inv = await loadInventory(pool, 'char-1');
  const hostItem = inv.items.find((it) => it.id === 'weapon-1');
  assert.equal(hostItem.socketedStoneTypeId, 40,
    'a weapon already socketed in the DB must have its cache hydrated at load, not just from a live socketStone call');
  const stoneItem = inv.items.find((it) => it.id === 'stone-1');
  assert.equal(stoneItem.socketedStoneTypeId, undefined, 'only the HOST gets the cache field, not the stone itself');
  // Same ownership-scoping convention as every other query in this file:
  // the hydration join is predicated on this character's id.
  const stoneCall = pool.calls.find((c) => /FROM stone_instances/i.test(c.sql));
  assert.deepEqual(stoneCall.params, ['char-1']);
});

// SOMET-245 Task 7: loadInventory must also hydrate the stone's OWN
// player_items.id (si.player_item_id, aliased stone_item_id), not just its
// catalog type -- stone XP is written against stone_instances.player_item_id,
// and a weapon loaded already-socketed at join time (rather than socketed
// live this session) needs this cached the same way socketStone caches it
// live (see items.js).
test('loadInventory hydrates socketedStoneItemId (the stone\'s OWN instance id) alongside socketedStoneTypeId', async () => {
  const pool = recordingPool([
    [/FROM player_items/i, () => ({ rows: [
      { id: 'weapon-1', item_type_id: 5 },
      { id: 'stone-1', item_type_id: 40 },
    ] })],
    [/FROM player_equipment/i, () => ({ rows: [{ slot: 'main_hand', item_id: 'weapon-1' }] })],
    [/FROM stone_instances/i, () => ({ rows: [
      { host_id: 'weapon-1', stone_item_id: 'stone-1', stone_type_id: 40 },
    ] })],
  ]);
  const inv = await loadInventory(pool, 'char-1');
  const hostItem = inv.items.find((it) => it.id === 'weapon-1');
  assert.equal(hostItem.socketedStoneItemId, 'stone-1',
    'must be the STONE\'s own player_items id, distinct from its catalog type (40)');
});

test('loadInventory leaves socketedStoneTypeId unset when nothing is socketed', async () => {
  const pool = recordingPool([
    [/FROM player_items/i, () => ({ rows: [{ id: 'weapon-1', item_type_id: 5 }] })],
    [/FROM player_equipment/i, () => ({ rows: [] })],
    [/FROM stone_instances/i, () => ({ rows: [] })],
  ]);
  const inv = await loadInventory(pool, 'char-1');
  assert.equal(inv.items[0].socketedStoneTypeId, undefined);
});

test('grantStartingLoadout inserts the class loadout for a fresh character (never granted)', async () => {
  const inserts = [];
  const pool = recordingPool([
    // F-013: the gate is a single conditional UPDATE, not a SELECT against
    // player_items — see items.js for why (once per CHARACTER, not once per
    // empty inventory; a re-derived-from-ownership gate is what let
    // sell-and-reconnect / drop-and-reconnect regrant for free). SOMET-258
    // moved the flag from users to characters, because the loadout is
    // class-dependent and a second character must get its own.
    [/UPDATE characters SET starting_loadout_granted_at/i, () => ({ rows: [{ id: 3 }], rowCount: 1 })],
    // The item list comes from class_loadouts keyed by the character's class,
    // not from a hardcoded array.
    [/FROM class_loadouts/i, () => ({ rows: [
      { item_type_id: 1, quantity: 1 },
      { item_type_id: 5, quantity: 1 },
    ] })],
    [/INSERT INTO player_items/i, (sql, p) => { inserts.push(p); return { rows: [{ id: 'new' }] }; }],
  ]);
  const itemTypes = new Map([
    [1, { id: 1, name: 'short sword', category: 'weapon' }],
    [5, { id: 5, name: 'leather-vest', category: 'armor' }],
  ]);
  const granted = await grantStartingLoadout(pool, { id: 3, entityTypeId: 11 }, itemTypes);
  assert.equal(granted, true);
  assert.equal(inserts.length, 2);
  // each insert carries (character_id, item_type_id, quantity)
  assert.deepEqual(inserts.map((p) => p[0]), [3, 3]);
  assert.deepEqual(inserts.map((p) => p[1]).sort(), [1, 5]);
  assert.deepEqual(inserts.map((p) => p[2]), [1, 1]);
});

test('grantStartingLoadout is a no-op when the character already claimed its grant', async () => {
  let inserted = 0;
  const pool = recordingPool([
    // WHERE starting_loadout_granted_at IS NULL excludes the row -> 0 rows
    // affected, regardless of whether player_items is currently empty.
    [/UPDATE characters SET starting_loadout_granted_at/i, () => ({ rows: [], rowCount: 0 })],
    [/FROM class_loadouts/i, () => ({ rows: [{ item_type_id: 1, quantity: 1 }] })],
    [/INSERT INTO player_items/i, () => { inserted++; return { rows: [] }; }],
  ]);
  const granted = await grantStartingLoadout(pool, { id: 3, entityTypeId: 11 },
    new Map([[1, { id: 1, name: 'short sword' }]]));
  assert.equal(granted, false);
  assert.equal(inserted, 0);
});

test('grantStartingLoadout skips loadout entries missing from the catalog (no crash)', async () => {
  const inserts = [];
  const pool = recordingPool([
    [/UPDATE characters SET starting_loadout_granted_at/i, () => ({ rows: [{ id: 3 }], rowCount: 1 })],
    // The class wants two items; the in-memory catalog the world was built
    // from only knows one of them.
    [/FROM class_loadouts/i, () => ({ rows: [
      { item_type_id: 1, quantity: 1 },
      { item_type_id: 99, quantity: 1 },
    ] })],
    [/INSERT INTO player_items/i, (sql, p) => { inserts.push(p); return { rows: [] }; }],
  ]);
  const granted = await grantStartingLoadout(pool, { id: 3, entityTypeId: 11 },
    new Map([[1, { id: 1, name: 'short sword' }]]));
  assert.equal(granted, true);
  assert.equal(inserts.length, 1); // only the short sword existed
});
