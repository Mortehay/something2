// backend/tests/enemy_aura_wire.test.js
// SOMET-606. What reaches the client: creature aura names ONCE (intro), and
// the owner's debuffs + effective speed on its OWN frame only. The socket test
// is the anti-"field lost on a named list" guard (server.js builds the frame
// from a named field list, SOMET-528).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { CreatureSim } = require('../src/authority/creatures.js');
const { selfAuraFields, playerSpeedMult } = require('../src/authority/world.js');
const { applyEffect, CHILL } = require('../src/authority/effects.js');
const { attachAuthority } = require('../src/authority/server.js');

const stubMap = () => ({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 });
const mire = { name: 'mire', targetSide: 'enemies', radius: 300, damageMult: 0.8, defenseMult: 1,
  speedMult: 0.6, dotDps: 4, dotElement: 'fire', tickMs: 1000 };

test('snapshotAOI: aura names in the intro only, never on an ordinary creature', () => {
  const s = new CreatureSim(stubMap(), () => 0.5);
  s.addCreatures([
    { id: 'A', type: 'T', x: 0, y: 0, hp: 9, faction: 'hostile', auras: [mire] },
    { id: 'W', type: 'Wolf', x: 0, y: 0, hp: 9, faction: 'hostile' },
  ]);
  const known = new Set();
  const keys = [...new Set(s.all().map(() => '0,0'))];
  const first = s.snapshotAOI(keys, 0, 0, 0, 2000, known);
  assert.deepEqual(first.find((r) => r.id === 'A').auras, ['mire']);
  assert.equal('auras' in first.find((r) => r.id === 'W'), false);
  const second = s.snapshotAOI(keys, 0, 0, 0, 2000, known);
  assert.equal('auras' in second.find((r) => r.id === 'A'), false, 'immutable: sent once');
});

test('selfAuraFields: debuffs + speedMult when debuffed, {} when clear', () => {
  const p = { effects: new Map(), _buff: { damageMult: 0.8, defenseMult: 1, speedMult: 0.6,
    auras: [{ name: 'mire', damageMult: 0.8, defenseMult: 1, speedMult: 0.6, dotDps: 4, dotElement: 'fire', tickMs: 1000, sourceId: 'A' }] } };
  assert.deepEqual(selfAuraFields(p, 0), {
    debuffs: [{ n: 'mire', d: 0.8, f: 1, s: 0.6, dps: 4, el: 'fire' }], speedMult: 0.6 });
  assert.deepEqual(selfAuraFields({ effects: new Map() }, 0), {});
});

test('selfAuraFields.speedMult is the EFFECTIVE multiplier (chill x aura), = playerSpeedMult (G6)', () => {
  const p = { effects: new Map(), _buff: { damageMult: 1, defenseMult: 1, speedMult: 0.6, auras: [] } };
  applyEffect(p, CHILL, { durationMs: 5000, magnitude: 0.5, sourceId: 'x', now: 0 });
  const f = selfAuraFields(p, 100);
  assert.equal(f.speedMult, playerSpeedMult(p, 100));
  assert.ok(Math.abs(f.speedMult - 0.3) < 1e-9, 'chill and aura multiply, not either-or');
  assert.equal('debuffs' in f, false, 'no aura rows -> field omitted');
  // chill alone (no aura) still reports, so prediction does not snap back
  const q = { effects: new Map() };
  applyEffect(q, CHILL, { durationMs: 5000, magnitude: 0.5, sourceId: 'x', now: 0 });
  assert.equal(selfAuraFields(q, 100).speedMult, 0.5);
});

// -- Real socket. Fake pool copied from authority_sfx_frame.test.js; the
// creature row carries the loader's aura_names/aura_defs shape.
const SECRET = 'test-secret';
function fakePool() {
  const pool = { query: async (sql, params) => {
    if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]), entity_type_id: 1 }] };
    if (/FROM worlds w WHERE w\.id/i.test(sql)) return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
    if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
    if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
    if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
    if (/FROM item_types/i.test(sql)) return { rows: [] };
    if (/FROM world_creatures/i.test(sql) && !/DELETE/i.test(sql)) {
      if (params[1] === 0) return { rows: [{ id: 'blighter', type: 'Wolf', x: 410, y: 400, hp: 50, facing: 'S', color: '#c00',
        faction: 'hostile', aura_names: ['mire'],
        aura_defs: [{ name: 'mire', target_side: 'enemies', radius: 2000, damage_mult: 0.8, defense_mult: 1,
          speed_mult: 0.6, dot_dps: 0, dot_element: 'physical', tick_ms: 1000 }] }] };
      return { rows: [] };
    }
    return { rows: [] };
  } };
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  return pool;
}
const token = (u) => jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' });
function boot() {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, fakePool(), { jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 10000 });
    server.listen(0, () => resolve({ url: `ws://127.0.0.1:${server.address().port}/authority`, handle, server }));
  });
}
function nextMsg(ws, type) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout ${type}`)), 3000);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (!type || m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

test('wire: the owner\'s own state frame carries debuffs + speedMult; the shared player row does not', async () => {
  const { url, handle, server } = await boot();
  const ws = new WebSocket(`${url}?token=${encodeURIComponent(token(1))}`);
  try {
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
    await nextMsg(ws, 'joined');
    let intro = null;
    for (let i = 0; i < 20 && !intro; i++) {
      const m = await nextMsg(ws, 'creatures');
      intro = m.creatures.find((c) => c.id === 'blighter' && c.auras) || null;
    }
    assert.ok(intro, 'precondition: the aura creature loaded and was introduced');
    assert.deepEqual(intro.auras, ['mire']);
    let s = null;
    for (let i = 0; i < 40 && !(s && s.debuffs); i++) s = await nextMsg(ws, 'state');
    assert.ok(s.debuffs, 'debuffs reached the frame');
    assert.deepEqual(s.debuffs.map((d) => d.n), ['mire']);
    assert.equal(s.debuffs[0].s, 0.6);
    assert.equal(s.speedMult, 0.6);
    const row = s.players.find((p) => String(p.id) === '1');
    assert.ok(row, 'own row present');
    assert.equal('debuffs' in row, false, 'never on the shared row');
  } finally {
    ws.close(); handle.close(); server.close();
  }
});
