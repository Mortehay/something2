const test = require('node:test');
const assert = require('node:assert');
const { sellPriceFor } = require('../src/services/merchantStock');
const { derivePlayerStats, DEFAULT_PROGRESSION } = require('../src/services/playerStats.js');
const { World } = require('../src/authority/world.js');
const { sellItem } = require('../src/authority/trade.js');

const at = (over) => ({ ...DEFAULT_PROGRESSION, ...over });

test('sellPriceFor is unchanged for every existing caller', () => {
  // The pre-A2 literal: merchantStock.test.js already pins this at the
  // default-only call shape (SELL_FRACTION == 0.5), this pins it again at
  // the two-arg call shape callers now use, so a broken default cannot
  // silently move every existing caller's payout.
  assert.equal(sellPriceFor(100), 50);
});

test('charisma raises what a merchant pays', () => {
  const mult = derivePlayerStats(at({ charisma: 15 })).priceMult;
  assert.equal(mult, 0.7, 'sanity: matches player_stats.test.js\'s own literal for CHA 15');
  assert.equal(sellPriceFor(100, mult), 70);
});

// THE exploit test. The village base catalog sells at `value` and never
// expires; a priceMult reaching or exceeding 1.0 turns buy-then-sell into an
// infinite-gold loop against an infinite shop. Asserted here, at
// sellPriceFor -- the actual seam where a merchant's UPDATE users SET
// gold = gold + price runs -- and not merely by re-checking priceMult's own
// clamp, so a clamp removed from playerStats.js (Task 8's mutation check)
// fails a test in THIS file too, independently of player_stats.test.js.
test('no charisma makes an item sell for at least what it costs to buy', () => {
  for (const cha of [5, 10, 50, 500, 9999]) {
    const mult = derivePlayerStats(at({ charisma: cha })).priceMult;
    const price = sellPriceFor(100, mult);
    assert.ok(price < 100,
      `charisma ${cha} sells a 100-gold item for ${price} -- an infinite-gold loop against the never-expiring base catalog`);
  }
});

// ---------------------------------------------------------------------------
// The seam test: trade.js's sellItem (the real handler behind the 'sell' WS
// message) must price with the SELLER's OWN p.stats.priceMult, not the
// module default and not some other player's. A mocked pool whose
// .connect() returns a distinct client (own call log, own release counter)
// -- the same shape progression_kill_xp.test.js's review round fixed a real
// mock-input-blindness bug on -- so BEGIN/COMMIT landing on the wrong object
// would be visible, not silently absorbed by a shared query closure.
// ---------------------------------------------------------------------------

function scriptedPool(routes = []) {
  const poolCalls = [];
  const clients = [];
  function route(sql, params) {
    for (const [re, result] of routes) {
      if (re.test(sql)) return typeof result === 'function' ? result(params) : result;
    }
    return { rows: [], rowCount: 0 };
  }
  return {
    calls: poolCalls,
    clients,
    query: async (sql, params) => { poolCalls.push({ sql, params }); return route(sql, params); },
    connect: async () => {
      const calls = [];
      const client = {
        calls,
        released: 0,
        matching(re) { return calls.filter((c) => re.test(c.sql)); },
        query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
        release: () => { client.released += 1; },
      };
      clients.push(client);
      return client;
    },
  };
}

function armEntry() {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  return { worldId: 'w1', world: new World(map, new Map(), null, 8) };
}

test("sell prices with the SELLER's own priceMult, not the default and not another player's", async () => {
  const entry = armEntry();

  // CHA 15 -> priceMult 0.7 (matches player_stats.test.js's own literal), a
  // value deliberately far from both SELL_FRACTION's default 0.5 and any
  // round number a copy-paste bug might produce -- so a hardcoded
  // sellPriceFor(value) (dropping the multiplier entirely) OR a swap with
  // another player's stats would both be caught, not just clamp removal.
  const sellerStats = derivePlayerStats(at({ charisma: 15 }));
  entry.world.addPlayer('seller', { x: 0, y: 0 }, { items: [{ id: 'itm1', typeId: 9 }], equipment: {} }, { x: 0, y: 0 }, 0, sellerStats);

  // A second live player with DIFFERENT stats in the same world -- proves
  // the price comes from the seller's own p.stats, not merely "whichever
  // player object happened to be resolved last" or a shared/global default.
  const bystanderStats = derivePlayerStats(at({ charisma: 999 }));
  entry.world.addPlayer('bystander', { x: 0, y: 0 }, { items: [], equipment: {} }, { x: 0, y: 0 }, 0, bystanderStats);

  // SOMET-484: the sale no longer DELETEs the instance, it locks it and then
  // hands it to the merchant. This scriptedPool falls back to
  // {rows: [], rowCount: 0} for anything unrouted, so a route left naming the
  // old DELETE would make the ownership read come back empty and this test
  // would fail on 'you do not own that item' rather than on the price.
  const pool = scriptedPool([
    [/FROM player_items WHERE id = \$1 AND character_id = \$2 FOR UPDATE/i, { rows: [{ item_type_id: 9, quantity: 1, soulbound: false }], rowCount: 1 }],
    [/FROM player_equipment WHERE item_id/i, { rows: [], rowCount: 0 }],
    [/FROM item_types WHERE id/i, { rows: [{ value: 100 }], rowCount: 1 }],
    [/UPDATE users SET gold/i, (p) => ({ rows: [{ gold: Number(p[1]) }], rowCount: 1 })],
    [/INSERT INTO merchant_stock/i, { rows: [{ id: 'b1' }], rowCount: 1 }],
    [/UPDATE player_items SET character_id = NULL, merchant_stock_id/i, { rows: [], rowCount: 1 }],
  ]);

  // The full six-argument signature. This call used to be
  // sellItem(pool, entry, 'seller', 'v1', 'itm1') -- five arguments against a
  // six-parameter function, so characterId was 'v1', villageId was 'itm1' and
  // itemId was undefined. The mock ignored bind parameters, so it passed
  // anyway; with SOMET-484's handover asserting on its own parameters, a
  // mis-shaped call is worth not carrying forward.
  const r = await sellItem(pool, entry, 'seller', 31, 'v1', 'itm1');

  assert.equal(r.ok, true);
  // value(100) * priceMult(0.7) = 70, floored. A hardcoded default (0.5)
  // would give 50; the bystander's 0.9-capped stats would give 90 -- either
  // wrong path produces a DIFFERENT number from this one.
  assert.equal(r.price, 70, "must use the SELLER's own priceMult (0.7), not the 0.5 default or the bystander's 0.9");
  assert.equal(r.gold, 70);

  // The transaction itself: proves the price really was computed and paid
  // out on the client's own connection, not floating loose on the bare pool.
  assert.equal(pool.calls.length, 0, 'nothing may be issued directly on the bare pool');
  assert.equal(pool.clients.length, 1);
  const client = pool.clients[0];
  assert.equal(client.matching(/^\s*COMMIT/i).length, 1);
  assert.equal(client.released, 1);
});
