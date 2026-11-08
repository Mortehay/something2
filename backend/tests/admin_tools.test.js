// backend/tests/admin_tools.test.js
// The in-game admin menu's server side, offline: the amount rules, the restore, the item drop's
// validation (against a fake pool), and source guards that the handler is admin-only and answers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const tools = require('../src/authority/adminTools.js');

test('amountOf: a whole number in [1, max], 0 for anything else', () => {
  assert.equal(tools.amountOf(5, 100), 5);
  assert.equal(tools.amountOf('7', 100), 7);
  assert.equal(tools.amountOf(5.9, 100), 5);
  assert.equal(tools.amountOf(1e12, 100), 100, 'clamped, not refused');
  for (const bad of [0, -3, NaN, 'x', null, undefined, Infinity, '', {}]) assert.equal(tools.amountOf(bad, 100), 0, String(bad));
});

test('giveGold refuses nonsense before it touches the database', async () => {
  const pool = { query: async () => { throw new Error('must not be called'); } };
  for (const bad of [0, -5, 'lots', null]) {
    const r = await tools.giveGold(pool, 1, bad);
    assert.equal(r.ok, false, String(bad));
  }
});

test('giveGold pays through the wallet update and reports a capped grant', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push([sql, params]); return { rows: [{ gold: 5000 }] }; } };
  const r = await tools.giveGold(pool, 9, 2_000_000_000);
  assert.equal(r.ok, true);
  assert.equal(r.granted, tools.MAX_GOLD_GRANT);
  assert.equal(r.capped, true);
  assert.equal(r.gold, 5000);
  assert.deepEqual(calls[0][1], [9, tools.MAX_GOLD_GRANT]);
  const ok = await tools.giveGold(pool, 9, 10);
  assert.equal(ok.capped, false);
});

test('giveGold: an unknown character is an error, not a crash', async () => {
  const r = await tools.giveGold({ query: async () => ({ rows: [] }) }, 404, 100);
  assert.deepEqual(r, { ok: false, error: 'no such character' });
});

test('restorePlayer fills the pools and does not raise the dead', () => {
  const p = { hp: 3, maxHp: 100, mana: 0, maxMana: 50, stamina: 1, maxStamina: 70 };
  assert.deepEqual(tools.restorePlayer(p), { ok: true, hp: 100, mana: 50, stamina: 70 });
  assert.equal(p.hp, 100);
  const dead = { hp: 0, maxHp: 100, mana: 0, maxMana: 5, stamina: 0, maxStamina: 5 };
  assert.equal(tools.restorePlayer(dead).ok, false);
  assert.equal(dead.hp, 0);
  assert.equal(tools.restorePlayer(null).ok, false);
});

test('dropItem validates the pick, the rarity and the item before writing anything', async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const entry = { worldId: 'w', world: {} };
  assert.match((await tools.dropItem(pool, entry, 'u', 0, 0, {})).error, /pick an item/);
  assert.match((await tools.dropItem(pool, entry, 'u', 0, 0, { itemTypeId: 'x' })).error, /pick an item/);
  assert.match((await tools.dropItem(pool, entry, 'u', 0, 0, { itemTypeId: 3, rarity: 'purple' })).error, /rarity/);
  assert.match((await tools.dropItem(pool, entry, 'u', 0, 0, { itemTypeId: 3 })).error, /no such item/);
});

test('dropItem puts a plain stack on the ground for the admin and clamps level and quantity', async () => {
  const inserted = [];
  const pool = {
    query: async (sql, params) => {
      if (/FROM item_types/.test(sql)) return { rows: [{ id: 3, name: 'Health Potion', category: 'consumable' }] };
      inserted.push(params);
      return { rows: [{ id: 77, item_type_id: 3, x: 10, y: 20, quantity: params[5], rarity: params[6], item_level: params[7] }] };
    },
  };
  const added = []; const reserved = [];
  const entry = { worldId: 'w1', world: { groundItems: { add: (r) => added.push(r), reserve: (...a) => reserved.push(a) } } };
  const r = await tools.dropItem(pool, entry, 'u1', 10.4, 20.6, { itemTypeId: 3, rarity: 'foxy', level: 99999, quantity: 99999 });
  assert.deepEqual(r, { ok: true, name: 'Health Potion', rarity: 'white', level: tools.MAX_ITEM_LEVEL, quantity: 9999 });
  assert.equal(inserted[0][5], 9999);
  assert.equal(inserted[0][6], 'white', 'a non-gear item has no rarity');
  assert.equal(inserted[0][8], '[]', 'and no affixes');
  assert.equal(added.length, 1, 'on the ground now');
  assert.equal(reserved[0][0], 77);
  assert.equal(reserved[0][1], 'u1', 'held for the admin');
});

// ---- source guards on the handler ---------------------------------------------------------

const src = fs.readFileSync(path.resolve(__dirname, '../src/authority/server.js'), 'utf8');
const handler = src.slice(src.indexOf('async debugAdmin(ws, msg)'), src.indexOf('async debugWorldBoss(ws, msg)'));

test('debugAdmin is admin-only, decided from the socket role, before anything else', () => {
  assert.ok(handler.length > 200, 'handler found');
  const firstLine = handler.split('\n').slice(1, 3).join('\n');
  // The role first; the admin menu's code lock (adminMenuGate) is a second condition on the same line.
  assert.match(firstLine, /if \(ws\.role !== 'admin'( \|\| !adminMenuGate\.isUnlocked\(ws\.userId\))?\) return;/);
  assert.doesNotMatch(handler, /msg\.role|msg\.isAdmin/, 'never from the message');
});

test('debugAdmin answers every action, including failures, with one adminResult frame', () => {
  for (const a of ['gold', 'level', 'xp', 'points', 'restore', 'item']) {
    assert.match(handler, new RegExp(`action === '${a}'`), a);
  }
  assert.match(handler, /unknown action/);
  assert.match(handler, /you are not in a world/);
  assert.match(handler, /catch \(err\)[\s\S]*server error/, 'a database error is reported, not swallowed');
  assert.match(handler, /type: 'adminResult'/);
});

test('level, xp and points re-derive the stats and push progression to the client', () => {
  assert.equal((handler.match(/await refreshDerivedStats\(ws, entry\)/g) || []).length, 3);
  assert.match(handler, /pushWallet\(r\.gold\)/);
});
