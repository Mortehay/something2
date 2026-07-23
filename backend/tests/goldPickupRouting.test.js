// Regression test for the gold-pickup routing defect: both pickup call sites
// in server.js (manual 'pickup' handler and the auto-loot tick loop) decide
// gold-vs-item by comparing a sim item's field against entry.goldItemTypeId.
// GroundItemSim normalizes the DB column `item_type_id` to `typeId` on the way
// in (see groundItems.js: `typeId: r.item_type_id != null ? r.item_type_id : r.typeId`)
// and never carries `item_type_id` on its returned items. If the routing code
// compares `.item_type_id` instead of `.typeId`, the comparison is always
// `undefined === <number>` — false — so gold silently falls through to
// claimItem and is inserted into the inventory as a junk item. This test
// builds a REAL GroundItemSim (not a mock) and locks the exact field shape
// the server must key its routing on.
const test = require('node:test');
const assert = require('node:assert');
const { GroundItemSim, PICKUP_RADIUS } = require('../src/authority/groundItems');

const CHUNK = 64; // chunk_size; matches groundItems.test.js convention

test('sim items expose typeId (not item_type_id) — the field the server must route on', () => {
  const sim = new GroundItemSim(CHUNK);
  const GOLD_TYPE_ID = 7;
  sim.add([{ id: 'g1', item_type_id: GOLD_TYPE_ID, x: 100, y: 100, expires_at: null, quantity: 5 }]);

  const viaNearest = sim.nearest(100, 100, PICKUP_RADIUS);
  const viaWithin = sim.within(100, 100, PICKUP_RADIUS);

  for (const item of [viaNearest, ...viaWithin]) {
    assert.ok(item, 'gold row must be found within pickup radius');
    // This is the discriminant server.js pickup routing MUST use.
    assert.strictEqual(item.typeId, GOLD_TYPE_ID, 'typeId carries the normalized item_type_id');
    // This is the field the OLD (buggy) code compared against. It must be
    // absent on sim items: if this assertion ever fails, someone re-added
    // item_type_id to the sim's shape and the routing predicates in
    // server.js should be revisited (they may need to change back).
    assert.strictEqual(item.item_type_id, undefined, 'item_type_id must not exist on sim items');
  }
});

test('routing predicate: typeId === goldItemTypeId sends gold, anything else sends item', () => {
  const sim = new GroundItemSim(CHUNK);
  const GOLD_TYPE_ID = 7;
  const SWORD_TYPE_ID = 42;
  sim.add([
    { id: 'gold-1', item_type_id: GOLD_TYPE_ID, x: 0, y: 0, expires_at: null },
    { id: 'sword-1', item_type_id: SWORD_TYPE_ID, x: 0, y: 0, expires_at: null },
  ]);

  // Mirrors the exact predicate at server.js's two pickup call sites.
  const routeOf = (simItem, goldItemTypeId) => (simItem.typeId === goldItemTypeId ? 'gold' : 'item');

  const gold = sim.get('gold-1');
  const sword = sim.get('sword-1');
  assert.strictEqual(routeOf(gold, GOLD_TYPE_ID), 'gold');
  assert.strictEqual(routeOf(sword, GOLD_TYPE_ID), 'item');

  // Pre-migration case: goldItemTypeId is null, so even a coincidental
  // numeric typeId must never match null and must fall through to 'item'.
  assert.strictEqual(routeOf(gold, null), 'item');

  // The old buggy comparison, kept here only to document why it's wrong:
  // simItem.item_type_id is always undefined, so this "routes" everything
  // to 'item' regardless of goldItemTypeId — including actual gold.
  const buggyRouteOf = (simItem, goldItemTypeId) => (simItem.item_type_id === goldItemTypeId ? 'gold' : 'item');
  assert.strictEqual(buggyRouteOf(gold, GOLD_TYPE_ID), 'item', 'documents the regression: buggy predicate never matches gold');
});
