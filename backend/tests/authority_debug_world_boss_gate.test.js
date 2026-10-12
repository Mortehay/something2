const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

// SOMET-614: debugWorldBoss is a dev tool (spawn / slay / damage a world boss,
// guaranteed legendary loot). It used to be dispatched with no role check, so
// any logged-in player could drive it. Harness shape copied from
// authority_socket_stone_integration.test.js (fake pool, real ws server).

const SECRET = 'test-secret';
// Every action the handler supports. 'spawn' / 'warning' omit bossIndex on
// purpose: that branch reads WORLD_BOSS_CATALOG, which is a separate defect
// (SOMET-603) and not what this file is about.
const ACTIONS = [
  { action: 'spawn' }, { action: 'warning' }, { action: 'slay' }, { action: 'damage' },
  { action: 'buff' }, { action: 'despawn' }, { action: 'setTimer' },
  { action: 'teleport_to_boss' }, { action: 'teleport_to_world', worldId: 'w1' },
  { action: 'phase' }, { action: 'enrage' },
];
// Frames only the debug handler produces in response to these messages.
const DEBUG_FRAMES = new Set(['announcement', 'transition', 'world_boss_status', 'world_boss_spawn', 'error']);

function token(u) { return jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' }); }

function makePool(role) {
  const calls = [];
  const pool = {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM worlds WHERE id/i.test(sql)) {
        return { rows: [{
          id: 'w1', seed: '1', chunk_size: 64, width: 10, height: 10,
          is_entry: null, entry_spawn: null, biomes: [], biome_cell: null,
          level_min: 1, level_max: 5,
        }] };
      }
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1, role }] };
      if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]) || 1, entity_type_id: 1 }] };
      if (/FROM worlds w WHERE w\.id/i.test(sql)) return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      if (/rowCount/.test(sql)) return { rows: [], rowCount: 0 };
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [] };
    },
  };
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  return pool;
}

async function boot(role) {
  const pool = makePool(role);
  const server = http.createServer();
  const handle = attachAuthority(server, pool, {
    jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 100,
  });
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/authority`;
  const ws = new WebSocket(`${url}?token=${encodeURIComponent(token(1))}`);
  const frames = [];
  ws.on('message', (d) => frames.push(JSON.parse(d)));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  await waitFor(() => frames.some((f) => f.type === 'joined'));
  return { pool, server, handle, ws, frames };
}

async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function close({ ws, handle, server }) { ws.close(); handle.close(); server.close(); }

test('a non-admin socket sending debugWorldBoss changes nothing, for every action', async () => {
  const h = await boot('player');
  try {
  await new Promise((r) => setTimeout(r, 100)); // let join-time frames settle
  const framesBefore = h.frames.length;
  const callsBefore = h.pool.calls.length;

  for (const a of ACTIONS) h.ws.send(JSON.stringify({ type: 'debugWorldBoss', ...a }));
  h.ws.send(JSON.stringify({ type: 'ping' }));
  await waitFor(() => h.frames.slice(framesBefore).some((f) => f.type === 'pong'));
  await new Promise((r) => setTimeout(r, 100));

  const after = h.frames.slice(framesBefore).filter((f) => DEBUG_FRAMES.has(f.type));
  assert.deepEqual(after, [], 'no debug-handler frame may reach a non-admin');
  const writes = h.pool.calls.slice(callsBefore).filter((c) => /^\s*(INSERT|UPDATE|DELETE)/i.test(c.sql)
    && /world_items|world_chests|player_items|world_creatures/i.test(c.sql));
  assert.deepEqual(writes, [], 'no loot / item / chest / creature write');
  } finally { close(h); }
});

test('an admin socket still reaches debugWorldBoss', async () => {
  const h = await boot('admin');
  try {
  await new Promise((r) => setTimeout(r, 100));
  const framesBefore = h.frames.length;
  h.ws.send(JSON.stringify({ type: 'debugWorldBoss', action: 'buff' }));
  await waitFor(() => h.frames.slice(framesBefore).some((f) => f.type === 'announcement' && f.kind === 'buff_granted'));
  await waitFor(() => h.frames.slice(framesBefore).some((f) => f.type === 'world_boss_status'));
  } finally { close(h); }
});

test('an admin reaches the phase/enrage triggers (an error frame proves the branch ran)', async () => {
  const h = await boot('admin');
  try {
    await new Promise((r) => setTimeout(r, 100));
    const framesBefore = h.frames.length;
    h.ws.send(JSON.stringify({ type: 'debugWorldBoss', action: 'phase' }));
    h.ws.send(JSON.stringify({ type: 'debugWorldBoss', action: 'enrage' }));
    await waitFor(() => h.frames.slice(framesBefore).filter((f) => f.type === 'error' && /no active world boss/.test(f.message)).length === 2);
  } finally { close(h); }
});
