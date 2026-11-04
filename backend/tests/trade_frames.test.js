'use strict';

// SOMET-728. The freeze list against the REAL handler table: the list of frames a
// player in a session may send is an allowlist, so this test is what proves a
// handler added tomorrow is refused without anybody remembering to say so.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { attachAuthority } = require('../src/authority/server.js');
const {
  TRADE_ALLOWED_FRAMES, isFrozenFrame, tradeStateFrame, tradeEndedFrame, tradeInvitedFrame,
} = require('../src/authority/tradeFrames.js');

function realFrameTypes() {
  const server = http.createServer();
  const pool = { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) };
  const handle = attachAuthority(server, pool, { jwtSecret: 'x' });
  const types = handle.frameTypes;
  handle.close();
  server.close();
  return types;
}

test('every handler except the allowlist is frozen', () => {
  const types = realFrameTypes();
  // The inventory movers by their real names: an empty or stale list passes the loop below.
  for (const known of ['sell', 'buy', 'equip', 'unequip', 'drop', 'use', 'socket', 'unsocket',
    'enchant', 'deposit', 'withdraw', 'openbank', 'pickup', 'interact', 'openchest', 'travel']) {
    assert.ok(types.includes(known), `${known} is a real handler`);
    assert.strictEqual(isFrozenFrame(known, true), true, `${known} is frozen`);
  }
  const frozen = types.filter((t) => !TRADE_ALLOWED_FRAMES.has(t));
  assert.ok(frozen.length >= 20, `only ${frozen.length} frozen handlers`);
  for (const t of frozen) assert.strictEqual(isFrozenFrame(t, true), true, `${t} is frozen`);
  for (const t of types.filter((n) => TRADE_ALLOWED_FRAMES.has(n))) {
    assert.strictEqual(isFrozenFrame(t, true), false, `${t} stays allowed`);
  }
});

test('every allowed frame names a handler that exists', () => {
  const types = realFrameTypes();
  for (const t of TRADE_ALLOWED_FRAMES) assert.ok(types.includes(t), `${t} has a handler`);
});

test('a frame nobody has written yet is frozen by default', () => {
  assert.strictEqual(isFrozenFrame('someFutureInventoryFrame', true), true);
});

test('join stays open to a socket that has not joined, and only to that one', () => {
  // A reconnect has to reach the settling wait. A refusal here would strand them.
  assert.strictEqual(isFrozenFrame('join', false), false);
  assert.strictEqual(isFrozenFrame('join', true), true);
  assert.strictEqual(isFrozenFrame('sell', false), true);
});

test('every transition push ends the trade of the player being moved', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/authority/server.js'), 'utf8');
  const pushes = [...src.matchAll(/type: 'transition'/g)].length;
  const ends = [...src.matchAll(/trade\.onWorldChange\(/g)].length;
  assert.ok(pushes >= 6, `found ${pushes} transition pushes`);
  assert.strictEqual(ends, pushes, 'one trade.onWorldChange beside each transition frame');
});

const sessionWith = (over = {}) => ({
  id: 't1',
  worldId: 'w',
  phase: 'open',
  secondOkAt: null,
  a: { userId: '1', characterId: 11, name: 'Ann', itemIds: ['i1'], gold: 5, locked: true, confirmed: false },
  b: { userId: '2', characterId: 22, name: 'Bob', itemIds: ['i2', 'gone'], gold: 0, locked: false, confirmed: false },
  ...over,
});
const items = new Map([
  ['i1', { id: 'i1', typeId: 7, rarity: 'foxy', itemLevel: 9, enchantLevel: 2, affixes: [{ label: 'x' }], quantity: 1 }],
  ['i2', { id: 'i2', typeId: 99, rarity: 'white', itemLevel: 1, enchantLevel: 0, affixes: [], quantity: 1 }],
]);
const types = new Map([[7, { id: 7, name: 'Sword', category: 'weapon' }]]);

test('tradeStateFrame shows each viewer their own side as mine', () => {
  const asAnn = tradeStateFrame(sessionWith(), '1', items, types, 1000);
  assert.strictEqual(asAnn.type, 'tradeState');
  assert.strictEqual(asAnn.partnerName, 'Bob');
  assert.strictEqual(asAnn.mine.gold, 5);
  assert.strictEqual(asAnn.mine.locked, true);
  assert.strictEqual(asAnn.theirs.locked, false);
  const asBob = tradeStateFrame(sessionWith(), '2', items, types, 1000);
  assert.strictEqual(asBob.partnerName, 'Ann');
  assert.strictEqual(asBob.theirs.gold, 5);
});

test('tradeStateFrame carries the type row and the roll of an item the viewer does not own', () => {
  const asBob = tradeStateFrame(sessionWith(), '2', items, types, 1000);
  const [item] = asBob.theirs.items;
  assert.deepStrictEqual(item.type, { id: 7, name: 'Sword', category: 'weapon' });
  assert.strictEqual(item.rarity, 'foxy');
  assert.strictEqual(item.itemLevel, 9);
  assert.strictEqual(item.enchantLevel, 2);
  assert.deepStrictEqual(item.affixes, [{ label: 'x' }]);
});

test('tradeStateFrame leaves out an id with no cached item, and gives an unknown type null', () => {
  const asAnn = tradeStateFrame(sessionWith(), '1', items, types, 1000);
  assert.deepStrictEqual(asAnn.theirs.items.map((i) => i.id), ['i2']);
  assert.strictEqual(asAnn.theirs.items[0].type, null);
});

test('confirmOpensInMs counts down, stops at zero, and is null outside both_locked', () => {
  assert.strictEqual(tradeStateFrame(sessionWith(), '1', items, types, 1000).confirmOpensInMs, null);
  const locked = sessionWith({ phase: 'both_locked', secondOkAt: 2500 });
  assert.strictEqual(tradeStateFrame(locked, '1', items, types, 1000).confirmOpensInMs, 1500);
  assert.strictEqual(tradeStateFrame(locked, '1', items, types, 9000).confirmOpensInMs, 0);
});

test('tradeEndedFrame has every field either way', () => {
  assert.deepStrictEqual(tradeEndedFrame('Bob left'), {
    type: 'tradeEnded', completed: false, reason: 'Bob left', removedItemIds: [], addedItems: [], gold: null,
  });
  const outcome = { characterId: 3, removedItemIds: ['r'], addedItems: [{ id: 'a' }], gold: 12 };
  assert.deepStrictEqual(tradeEndedFrame(null, outcome, true), {
    type: 'tradeEnded', completed: true, reason: null, removedItemIds: ['r'], addedItems: [{ id: 'a' }], gold: 12,
  });
});

test('a completed tradeEnded for another character of the account carries only the gold', () => {
  const outcome = { characterId: 3, removedItemIds: ['r'], addedItems: [{ id: 'a' }], gold: 12 };
  assert.deepStrictEqual(tradeEndedFrame(null, outcome, false), {
    type: 'tradeEnded', completed: true, reason: null, removedItemIds: [], addedItems: [], gold: 12,
  });
});

test('tradeInvitedFrame', () => {
  assert.deepStrictEqual(tradeInvitedFrame('Ann', 30000), { type: 'tradeInvited', fromName: 'Ann', expiresInMs: 30000 });
});
