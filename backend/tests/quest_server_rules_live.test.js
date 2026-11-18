// Quest rules enforced by the real authority: a fake pool, a real WebSocket client, no DB.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const express = require('express');
const supertest = require('supertest');
const { attachAuthority } = require('../src/authority/server.js');

for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_GATE_FORCE']) delete process.env[k];
const SECRET = 'test-secret-quest-rules';
const token = (u) => jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' });

const open = [];
test.afterEach(() => { while (open.length) { try { open.pop().close(); } catch { /* closed */ } } });

function fakePool() {
  const questSql = [];   // every statement that touches character_quests, with its character id
  function route(sql, params) {
    if (/character_quests/i.test(sql)) { questSql.push({ sql, characterId: params && params[0], params }); return { rows: [], rowCount: 0 }; }
    if (/FROM affix_types/i.test(sql)) return { rows: [] };
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
      return { rows: [{ user_id: '1', experience: '0', level: 1, stat_points: 0, strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5 }] };
    }
    return { rows: [] };
  }
  const pool = { questSql, query: async (sql, params) => route(sql, params) };
  pool.connect = async () => ({ query: async (sql, params) => route(sql, params), release() {} });
  return pool;
}

async function join(pool, uids) {
  const server = http.createServer();
  const handle = attachAuthority(server, pool, { jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 10000 });
  open.push({ close() { handle.close(); if (server.listening) server.close(); } });
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/authority`;
  let entry = null;
  for (const uid of uids) {
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token(uid))}`);
    open.push({ close() { ws.terminate(); } });
    await new Promise((r) => ws.on('open', r));
    const joined = new Promise((res) => ws.on('message', (d) => { if (JSON.parse(d).type === 'joined') res(); }));
    ws.send(JSON.stringify({ type: 'join', character_id: uid, world_id: 'w1' }));
    await joined;
    entry = handle.worlds.get('w1');
  }
  return { handle, entry };
}
const tick = () => new Promise((r) => setTimeout(r, 60));

test('a boss kill advances the quests of everyone who damaged it, not only the last hit', async () => {
  const pool = fakePool();
  const { handle, entry } = await join(pool, [1, 2, 3]);
  // player 2 is listed twice and player 1 is the killer: each is credited once; 3 did nothing
  handle._trackQuestKill(entry, '1', 'Ossuary Warden', true, { alsoCredit: ['2', '2', '1'] });
  await tick();
  const credited = pool.questSql.filter((q) => /boss/i.test(q.sql)).map((q) => q.characterId).sort();
  assert.deepEqual(credited, [1, 2], 'the killer and the damager once each; the bystander gets nothing');
});

test('a shared kill carries the boss flag, and a gate boss carries none, for everyone', async () => {
  const pool = fakePool();
  const { handle, entry } = await join(pool, [1, 2]);
  handle._trackQuestKill(entry, '1', 'Cinder Matriarch', true, { bossQuests: false, alsoCredit: ['2'] });
  await tick();
  // recordKill params: [characterId, typeName, isBoss, inSpire]
  const flags = pool.questSql.filter((q) => /boss/i.test(q.sql)).map((q) => q.params[2]);
  assert.deepEqual(flags, [false, false]);
  pool.questSql.length = 0;
  handle._trackQuestKill(entry, '1', 'Ossuary Warden', true, { alsoCredit: ['2'] });
  await tick();
  assert.deepEqual(pool.questSql.filter((q) => /boss/i.test(q.sql)).map((q) => q.params[2]), [true, true]);
});

test('taking back an item you dropped yourself earns no collect-quest credit; a found item does', async () => {
  const pool = fakePool();
  const { handle, entry } = await join(pool, [1]);
  const p = entry.world.getPlayer('1');
  p.ownDrops = new Set(['ground-mine']);
  handle._trackQuestItem(entry, '1', 1, { id: 'a', typeId: 1, quantity: 1 }, 'ground-mine');
  await tick();
  assert.equal(pool.questSql.filter((q) => /collect/i.test(q.sql)).length, 0, 'own drop must not count');
  assert.equal(p.ownDrops.has('ground-mine'), false, 'the memory is consumed');
  handle._trackQuestItem(entry, '1', 1, { id: 'b', typeId: 1, quantity: 1 }, 'ground-found');
  await tick();
  assert.equal(pool.questSql.filter((q) => /collect/i.test(q.sql)).length, 1, 'a found item counts');
});

test('nearQuestGiver: null when not connected, false away from every giver, true at one', async () => {
  const pool = fakePool();
  const { handle, entry } = await join(pool, [1]);
  assert.equal(handle.nearQuestGiver(999, null), null, 'no session');
  assert.equal(handle.nearQuestGiver(1, null), false, 'this world has no quest giver');
  const p = entry.world.getPlayer('1');
  entry.villages = [{ id: 'v1', specKey: 'vale-crossing', questGiverX: p.x + 50, questGiverY: p.y }];
  assert.equal(handle.nearQuestGiver(1, null), true);
  entry.villages = [{ id: 'v1', specKey: 'vale-crossing', questGiverX: p.x + 5000, questGiverY: p.y }];
  assert.equal(handle.nearQuestGiver(1, null), false, 'too far');
});

test('POST /api/quests/start and /complete refuse a connected player who is not at a giver', async () => {
  const { createQuestsRouter } = require('../src/routes/questsRoutes.js');
  const { signToken } = require('../src/auth/tokens.js');
  const pool = {
    query: async (sql) => {
      if (/FROM users WHERE id/i.test(sql)) return { rows: [{ id: 7, username: 'u', role: 'player', token_version: 1, email_verified_at: new Date() }] };
      if (/FROM characters/i.test(sql)) return { rows: [{ id: 5, user_id: 7 }] };
      return { rows: [] };
    },
  };
  let verdict = false;
  const app = express();
  app.use(express.json());
  app.use('/api/quests', createQuestsRouter(pool, { nearQuestGiver: () => verdict }));
  const auth = { Authorization: `Bearer ${signToken({ userId: 7, username: 'u', role: 'player', tokenVersion: 1 })}` };

  const start = await supertest(app).post('/api/quests/start').set(auth).send({ characterId: 5, questKey: 'act1_core_whisper' });
  const complete = await supertest(app).post('/api/quests/complete').set(auth).send({ characterId: 5, questKey: 'act1_core_whisper' });
  for (const res of [start, complete]) {
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(res.body.error, /quest giver/i);
  }
  // Not connected (null): the rule is not applied, the request goes on to the quest logic.
  verdict = null;
  const free = await supertest(app).post('/api/quests/start').set(auth).send({ characterId: 5, questKey: 'no_such_quest' });
  assert.notEqual(free.status, 403);
});

test('joining catches up the level and reputation counters, so achievements unlock without waiting for the next event', async () => {
  const achievements = require('../src/services/achievements.js');
  const real = achievements.bufferTrack;
  const seen = [];
  achievements.bufferTrack = (characterId, counter, amount, mode) => { seen.push([characterId, counter, amount, mode]); };
  try {
    const pool = fakePool();
    const inner = pool.query;
    pool.query = async (sql, params) => (/FROM character_reputation/i.test(sql) ? { rows: [{ m: 40 }] } : inner(sql, params));
    await join(pool, [1]);
    await tick();
    assert.ok(seen.some(([c, k, v, m]) => c === 1 && k === 'level' && v >= 1 && m === 'max'), JSON.stringify(seen));
    assert.ok(seen.some(([c, k, v, m]) => c === 1 && k === 'reputation_max' && v === 40 && m === 'max'), JSON.stringify(seen));
  } finally {
    achievements.bufferTrack = real;
  }
});
