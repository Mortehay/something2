// The loot filter through the real authority: a fake pool and a real WebSocket client (the
// amber_server_live.test.js harness). No DB.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

// A developer's .env with real SMTP settings switches the email-verification gate on, and this
// harness's fake accounts are not verified. Cleared AFTER the requires (loading the server reads .env).
for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_GATE_FORCE']) delete process.env[k];

const SECRET = 'test-secret-loot-filter-live';
const token = (u) => jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' });

const open = [];
test.afterEach(() => { while (open.length) { try { open.pop().close(); } catch { /* closed */ } } });

function boot(pool) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, { jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 10000 });
    open.push({ close() { handle.close(); if (server.listening) server.close(); } });
    server.listen(0, () => resolve({ url: `ws://127.0.0.1:${server.address().port}/authority`, handle }));
  });
}
function connect(url, uid) {
  const ws = new WebSocket(`${url}?token=${encodeURIComponent(token(uid))}`);
  open.push({ close() { ws.terminate(); } });
  return ws;
}
function nextMsg(ws, type, ms = 3000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { ws.off('message', on); reject(new Error(`timeout waiting for ${type}`)); }, ms);
    function on(data) {
      const m = JSON.parse(data);
      if (m.type === type) { clearTimeout(to); ws.off('message', on); resolve(m); }
    }
    ws.on('message', on);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakePool() {
  const store = new Map();   // user id -> saved filter config
  const claims = [];         // ids of ground items a claim statement was run for
  function route(sql, params) {
    if (/account_loot_filters/i.test(sql) && /^\s*INSERT/i.test(sql)) { store.set(String(params[0]), JSON.parse(params[1])); return { rows: [], rowCount: 1 }; }
    if (/account_loot_filters/i.test(sql)) {
      const v = store.get(String(params[0]));
      return v ? { rows: [{ config: v }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/DELETE FROM world_items/i.test(sql)) { claims.push(params[0]); return { rows: [], rowCount: 0 }; }
    if (/FROM affix_types/i.test(sql)) return { rows: [{ id: 5, key: 'of_might', label: 'of Might', kind: 'stat', effect: {}, min_value: 1, max_value: 2, min_item_level: 1, max_item_level: 150, allowed_slots: null, min_rarity: 'blue', weight: 1, placement: 'suffix', allowed_tags: null, group_key: 'g' }] };
    if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]), entity_type_id: 1 }] };
    if (/FROM worlds w WHERE w\.id/i.test(sql)) return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
    if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
    if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
    if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
    if (/FROM item_types/i.test(sql)) {
      return { rows: [{ id: 1, name: 'dagger', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'melee',
        damage: 8, cooldown: 0.3, reach: 80, arc_width: 6.3, range: null, projectile_speed: null,
        projectile_radius: null, pierce: null, mana_cost: 0, element: null, defense: null, resistances: null }] };
    }
    if (/FROM player_items/i.test(sql)) return { rows: [{ id: 'i1', item_type_id: 1 }] };
    if (/SELECT gold FROM users/i.test(sql)) return { rows: [{ gold: 0 }] };
    if (/FROM player_progression/i.test(sql) && !/^\s*INSERT/i.test(sql)) {
      return { rows: [{ user_id: '1', experience: '0', level: 1, stat_points: 0,
        strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5 }] };
    }
    return { rows: [] };
  }
  const pool = { store, claims, query: async (sql, params) => route(sql, params) };
  pool.connect = async () => ({ query: async (sql, params) => route(sql, params), release() {} });
  return pool;
}

async function join(pool, uid = 1) {
  const { url, handle } = await boot(pool);
  const ws = connect(url, uid);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: uid, world_id: 'w1' }));
  const joined = await nextMsg(ws, 'joined');
  const entry = handle.worlds.get('w1');
  return { ws, handle, entry, joined, p: entry.world.getPlayer(String(uid)) };
}

const hideWhite = () => ({
  activeId: 'a',
  presets: [{ id: 'a', name: 'Mine', rules: [{ id: 'r1', action: 'hide', conditions: { rarities: ['white'] } }] }],
});

test('the joined frame carries the default filter and the affix catalog', async () => {
  const { joined } = await join(fakePool());
  assert.equal(joined.lootFilter.presets.length, 1);
  assert.equal(joined.lootFilter.presets[0].rules.length, 0);
  assert.ok(Array.isArray(joined.lootFilterAffixes));
});

test('a saved filter is stored, echoed normalised, and comes back on the next join', async () => {
  const pool = fakePool();
  const first = await join(pool);
  first.ws.send(JSON.stringify({ type: 'lootFilterSave', config: hideWhite() }));
  const echo = await nextMsg(first.ws, 'lootFilter');
  assert.equal(echo.config.presets[0].name, 'Mine');
  assert.equal(echo.config.presets[0].rules[0].enabled, true, 'defaults filled in');
  assert.equal(pool.store.size, 1);
  assert.deepEqual(first.p.lootFilter.rules.map((r) => r.id), ['r1'], 'the player carries the active rules for auto-loot');

  const second = await join(pool);
  assert.equal(second.joined.lootFilter.presets[0].name, 'Mine');
});

test('a bad filter is refused with a reason and stores nothing', async () => {
  const pool = fakePool();
  const { ws } = await join(pool);
  ws.send(JSON.stringify({ type: 'lootFilterSave', config: { presets: [{ id: 'a', rules: [{ action: 'nuke' }] }] } }));
  const refused = await nextMsg(ws, 'lootFilterRejected');
  assert.match(refused.message, /action must be/);
  assert.equal(pool.store.size, 0);
  ws.send(JSON.stringify({ type: 'lootFilterSave' }));
  assert.match((await nextMsg(ws, 'lootFilterRejected')).message, /filter must be an object/);
});

test('ground items reach the client with their level and affixes', async () => {
  const { ws, entry, p } = await join(fakePool());
  entry.world.groundItems.add([
    { id: 'g1', typeId: 1, x: p.x, y: p.y, rarity: 'yellow', itemLevel: 64, affixIds: [5] },
  ]);
  const items = await nextMsg(ws, 'items');
  const g1 = items.items.find((i) => i.id === 'g1');
  assert.ok(g1, 'the item was broadcast');
  assert.equal(g1.lv, 64);
  assert.deepEqual(g1.ax, [5]);
});

test('auto-loot skips an item the filter hides, and still takes the rest', async () => {
  const pool = fakePool();
  const { ws, entry, p } = await join(pool);
  ws.send(JSON.stringify({ type: 'lootFilterSave', config: hideWhite() }));
  await nextMsg(ws, 'lootFilter');
  const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
  entry.world.groundItems.add([
    { id: 'white-1', typeId: 1, x: cx, y: cy, rarity: 'white' },
    { id: 'blue-1', typeId: 1, x: cx + 5, y: cy, rarity: 'blue' },
  ]);
  ws.send(JSON.stringify({ type: 'autoloot', on: true }));
  await wait(400);
  assert.ok(pool.claims.includes('blue-1'), 'the visible item is claimed');
  assert.equal(pool.claims.includes('white-1'), false, 'the hidden item is left on the ground');
  assert.ok(entry.world.groundItems.get('white-1'), 'and it is still there');
});

test('with "auto-loot skips hidden" off the hidden item is taken after all', async () => {
  const pool = fakePool();
  const { ws, entry, p } = await join(pool);
  const cfg = hideWhite();
  cfg.presets[0].autolootSkipHidden = false;
  ws.send(JSON.stringify({ type: 'lootFilterSave', config: cfg }));
  await nextMsg(ws, 'lootFilter');
  const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
  entry.world.groundItems.add([{ id: 'white-2', typeId: 1, x: cx, y: cy, rarity: 'white' }]);
  ws.send(JSON.stringify({ type: 'autoloot', on: true }));
  await wait(300);
  assert.ok(pool.claims.includes('white-2'));
});

test('a deliberate pickup key still takes a hidden item', async () => {
  const pool = fakePool();
  const { ws, entry, p } = await join(pool);
  ws.send(JSON.stringify({ type: 'lootFilterSave', config: hideWhite() }));
  await nextMsg(ws, 'lootFilter');
  const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
  entry.world.groundItems.add([{ id: 'white-3', typeId: 1, x: cx, y: cy, rarity: 'white' }]);
  ws.send(JSON.stringify({ type: 'pickup' }));
  await wait(300);
  assert.ok(pool.claims.includes('white-3'));
});
