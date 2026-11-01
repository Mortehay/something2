const test = require('node:test');
const assert = require('node:assert');
const rep = require('../src/services/reputation.js');
const { REPUTATION_TIERS } = require('../src/services/questsService.js');
const { fetchShop } = require('../src/services/merchantStock.js');
const { buyStock } = require('../src/authority/trade.js');

test('tier thresholds match the quest log tiers', () => {
  const mine = rep.TIERS.map((t) => [t.name, t.at]).sort((a, b) => b[1] - a[1]);
  const theirs = REPUTATION_TIERS.map((t) => [t.name, t.min]);
  assert.deepStrictEqual(mine, theirs);
});

test('tiers, next tier and the sell bonus', () => {
  assert.strictEqual(rep.tierFor(0).name, 'Stranger');
  assert.strictEqual(rep.tierFor(29).name, 'Stranger');
  assert.strictEqual(rep.tierFor(30).name, 'Friend');
  assert.strictEqual(rep.tierFor(250).name, 'Revered');
  assert.deepStrictEqual(rep.nextTierFor(35), { name: 'Honored', at: 100 });
  assert.strictEqual(rep.nextTierFor(999), null);
  const s = rep.shopReputation('sunspire', 35);
  assert.deepStrictEqual([s.tier, s.discountPct, s.sellBonusPct, s.villageKey], ['Friend', 0, 5, 'sunspire']);
  assert.strictEqual(rep.tierNameFor(100), 'Honored');
  assert.strictEqual(rep.tierNameFor(31), 'Honored');
});

test('the sell bonus is clamped so a merchant never pays what an item costs', () => {
  assert.strictEqual(rep.boostedSellFraction(0.5, 0, 0.9), 0.5);
  assert.ok(Math.abs(rep.boostedSellFraction(0.5, 250, 0.9) - 0.65) < 1e-9);
  assert.strictEqual(rep.boostedSellFraction(0.88, 250, 0.9), 0.9, 'never above the cap');
});

function shopPool(rows) {
  return { async query(sql) { return /DELETE/.test(sql) ? { rows: [] } : { rows }; } };
}
const row = (id, name, tier, minRep, price = 100) => ({
  id, item_type_id: id, price, quantity: 1, seller_user_id: null, item_name: name, item_category: 'weapon',
  item_tier: tier, min_reputation: minRep,
});

test('fetchShop opens premium wares at the right standing and lists the rest locked', async () => {
  const rows = [row(1, 'iron-sword', 1, 0), row(2, 'steel-sword', 2, 30), row(3, 'mithril-sword', 3, 100)];
  const none = await fetchShop(shopPool(rows), 1, 5, null, 0);
  assert.deepStrictEqual(none.catalog.map((x) => x.itemTypeId), [1]);
  assert.deepStrictEqual(none.lockedCatalog.map((x) => [x.itemTypeId, x.requiredTier, x.minReputation]), [[2, 'Friend', 30], [3, 'Honored', 100]]);
  const friend = await fetchShop(shopPool(rows), 1, 5, null, 35);
  assert.deepStrictEqual(friend.catalog.map((x) => x.itemTypeId), [1, 2]);
  assert.deepStrictEqual(friend.lockedCatalog.map((x) => x.itemTypeId), [3]);
  const top = await fetchShop(shopPool(rows), 1, 5, null, 500);
  assert.strictEqual(top.lockedCatalog.length, 0);
  assert.strictEqual(top.catalog.length, 3);
});

test('a crafted buy frame cannot get a premium ware without the standing', async () => {
  const seen = [];
  const client = {
    async query(sql) {
      seen.push(sql.replace(/\s+/g, ' ').trim());
      if (/FROM merchant_stock/.test(sql)) return { rows: [{ id: 9, item_type_id: 3, price: 100, seller_user_id: null, village_id: 1, min_reputation: 100 }] };
      if (/FROM character_reputation/.test(sql)) return { rows: [{ points: 10 }] };
      return { rows: [] };
    },
    release() {},
  };
  const entry = {
    worldId: 'w', villages: [{ id: 1, specKey: 'sunspire' }],
    world: { weapons: new Map(), getPlayer: () => ({ inv: { items: [], equipment: {} } }) },
  };
  const r = await buyStock({ connect: async () => client }, entry, 1, 1, 9, 1);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /requires Honored standing/);
  assert.ok(seen.some((s) => /^ROLLBACK/.test(s)), 'rolled back');
  assert.ok(!seen.some((s) => /UPDATE users/.test(s)), 'no gold was touched');
});
