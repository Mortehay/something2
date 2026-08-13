// Landmarks on the `joined` frame, driven through the running authority
// (SOMET-297).
//
// WHY THIS HARNESS. buildLandmarks is unit-tested next door in landmarks.test.js
// and that proves nothing about whether anything CALLS it. The defect this whole
// ticket exists to fix is a shipped-but-invisible feature: SOMET-292/293 wired a
// working waypoint network that no surface ever drew. Repeating that mistake at
// the delivery layer -- a read model nothing sends -- is the obvious way to fail
// again. So this boots a real attachAuthority against a fake pool: the waypoint
// and the portal must arrive through loadWorld's OWN queries, and the assertion
// is made against the bytes a real client would receive.
//
// Same harness as waypoint_activation_live.test.js, for the same reason.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

const SECRET = 'test-secret-landmarks';
function token(u) { return jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' }); }

const openResources = [];
test.afterEach(() => {
  while (openResources.length) {
    const r = openResources.pop();
    try { r.close(); } catch { /* already closed */ }
  }
});

function bootWith(pool, opts = {}) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, {
      jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 10000, ...opts,
    });
    openResources.push({ close() { handle.close(); if (server.listening) server.close(); } });
    server.listen(0, () => resolve({ url: `ws://127.0.0.1:${server.address().port}/authority`, handle }));
  });
}
function connect(url, uid) {
  const ws = new WebSocket(`${url}?token=${encodeURIComponent(token(uid))}`);
  openResources.push({ close() { ws.terminate(); } });
  return ws;
}
function nextMsg(ws, type, ms = 3000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout ${type}`)), ms);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (!type || m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

const WAYPOINT_ID = 'wp-1';
const WAYPOINT_X = 1050, WAYPOINT_Y = 1050;   // tile (10,10)
const PORTAL_X = 2050, PORTAL_Y = 3050;       // tile (30,20)

// One world holding exactly one waypoint and one portal. `activatedRows` is a
// knob, not a constant: the same waypoint must read lit for a character who has
// activated it and unlit for one who has not, and only the database can say
// which.
function fakeLandmarkPool({ activatedRows = [], portalRows = null, waypointRows = null } = {}) {
  const calls = [];
  function route(sql, params) {
    if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]), entity_type_id: 1 }] };
    if (/FROM worlds w WHERE w\.id/i.test(sql)) {
      return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
    }
    if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
    if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
    if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
    if (/FROM world_players WHERE/i.test(sql)) return { rows: [] };
    if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
    if (/FROM player_binds WHERE/i.test(sql)) return { rows: [] };
    if (/FROM item_types/i.test(sql)) {
      return { rows: [
        { id: 1, name: 'dagger', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'melee',
          damage: 8, cooldown: 0.3, reach: 80, arc_width: 6.3, range: null, projectile_speed: null,
          projectile_radius: null, pierce: null, mana_cost: 0, element: null, defense: null, resistances: null },
      ] };
    }
    if (/FROM player_items/i.test(sql)) return { rows: [{ id: 'i1', item_type_id: 1 }] };
    if (/FROM player_equipment/i.test(sql)) return { rows: [] };
    if (/SELECT gold FROM users/i.test(sql)) return { rows: [{ gold: 0 }] };
    if (/^\s*INSERT INTO player_progression/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM player_progression/i.test(sql)) {
      return { rows: [{ user_id: '1', experience: '0', level: 1, stat_points: 0,
        strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5 }] };
    }
    // fetchLinks. Keyed on the caller's own world id for the same reason the
    // waypoint route below is: a mock answering regardless of input would prove
    // nothing about which world the authority asked for.
    if (/FROM map_links ml JOIN worlds/i.test(sql)) {
      if (params[0] !== 'w1') return { rows: [] };
      return { rows: portalRows ?? [
        { id: 'pl-1', edge: 'PORTAL', to_world_id: 'w2', to_width: 64, to_height: 64,
          to_name: 'Windwatch Pass',
          from_x: PORTAL_X, from_y: PORTAL_Y, to_x: 500, to_y: 500 },
      ] };
    }
    if (/FROM villages WHERE/i.test(sql)) return { rows: [] };
    if (/FROM waypoints WHERE world_id/i.test(sql)) {
      if (params[0] !== 'w1') return { rows: [] };
      return { rows: waypointRows ?? [
        { id: WAYPOINT_ID, world_id: 'w1', x: WAYPOINT_X, y: WAYPOINT_Y, name: 'Trailhead Well', map_link_id: null },
      ] };
    }
    // The per-join activation read. Scoped to the character the join names.
    if (/FROM character_waypoints WHERE character_id/i.test(sql)) {
      if (String(params[0]) !== '7') return { rows: [] };
      return { rows: activatedRows };
    }
    if (/INSERT INTO character_waypoints/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/FROM world_creatures wc/i.test(sql)) return { rows: [] };
    if (/FROM world_items/i.test(sql)) return { rows: [] };
    return { rows: [] };
  }
  const pool = {
    calls,
    matching(re) { return calls.filter((c) => re.test(c.sql)); },
    query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
  };
  pool.connect = async () => ({
    query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
    release() {},
  });
  return pool;
}

async function join(pool, characterId = 7) {
  const { url, handle } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: characterId, world_id: 'w1' }));
  const joined = await nextMsg(ws, 'joined');
  return { ws, handle, joined };
}

test('the joined frame carries both landmark kinds, from the loaders that already run', async () => {
  const { joined } = await join(fakeLandmarkPool());
  assert.ok(Array.isArray(joined.landmarks), 'joined must carry a landmarks array');
  assert.deepStrictEqual(joined.landmarks, [
    { kind: 'waypoint', x: WAYPOINT_X, y: WAYPOINT_Y, name: 'Trailhead Well', activated: false },
    { kind: 'portal', x: PORTAL_X, y: PORTAL_Y, name: 'To Windwatch Pass', activated: false },
  ]);
});

test('a waypoint this character has activated arrives lit', async () => {
  const pool = fakeLandmarkPool({ activatedRows: [{ waypoint_id: WAYPOINT_ID }] });
  const { joined } = await join(pool);
  const wp = joined.landmarks.find((l) => l.kind === 'waypoint');
  assert.strictEqual(wp.activated, true);
  // ...and the portal beside it is still unlit. Portals are not activated, so a
  // blanket "everything is lit" bug would pass the assertion above alone.
  assert.strictEqual(joined.landmarks.find((l) => l.kind === 'portal').activated, false);
});

test('the same waypoint arrives unlit for a character who has not activated it', async () => {
  // Rows exist in the table, but for character 7 only; this join is character 8.
  const pool = fakeLandmarkPool({ activatedRows: [{ waypoint_id: WAYPOINT_ID }] });
  const { joined } = await join(pool, 8);
  assert.strictEqual(joined.landmarks.find((l) => l.kind === 'waypoint').activated, false);
});

test('a world with no landmarks joins successfully with an empty list', async () => {
  // 86 live worlds hold neither. The failure mode being guarded is not "no
  // marker drawn" -- it is a join that throws and puts the player nowhere.
  const pool = fakeLandmarkPool({ waypointRows: [], portalRows: [] });
  const { joined } = await join(pool);
  assert.deepStrictEqual(joined.landmarks, []);
});

test('a failed activation read degrades to unlit rather than failing the join', async () => {
  const pool = fakeLandmarkPool();
  const inner = pool.query;
  pool.query = async (sql, params) => {
    if (/FROM character_waypoints WHERE character_id/i.test(sql)) throw new Error('boom');
    return inner(sql, params);
  };
  const { joined } = await join(pool);
  assert.strictEqual(joined.landmarks.length, 2, 'the join must still complete');
  assert.strictEqual(joined.landmarks.find((l) => l.kind === 'waypoint').activated, false);
});

// A column the authority forgets to SELECT is the exact defect that shipped in
// SOMET-288: the world SELECT omitted two new columns, Number(undefined) || 0
// made the value silently 0, and every test passed because the OTHER read path
// used SELECT *. Here the equivalent silent failure is every portal label
// collapsing to "Portal". Guard the column list by source text.
test('fetchLinks still selects the destination name a portal label is built from', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/mapLinks.js'), 'utf8');
  const select = src.slice(src.indexOf('async function fetchLinks'));
  assert.match(select.slice(0, 600), /w\.name AS to_name/,
    'fetchLinks must select w.name AS to_name -- without it every portal is labelled "Portal"');
});
