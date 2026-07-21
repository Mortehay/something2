const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

const SECRET = 'test-secret';

// World w1 (chunk_size 8 → chunk (0,0) center 400,400). One wolf near the
// player's spawn so it aggros. chunk insert rowCount 0 (already materialized).
function fakePool() {
  const deletes = [];
  return {
    deletes,
    query: async (sql, params) => {
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      if (/token_version FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] }; // matches token()'s tv:1 → passes the on-connect version check
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      if (/FROM entity_types WHERE is_creature/i.test(sql)) return { rows: [{ name: 'Wolf', color: '#c00', hp: 5 }] };
      // Dagger tuned as an omnidirectional hit (arc_width = full circle) so this
      // integration test doesn't depend on the player's facing at attack time.
      if (/FROM item_types/i.test(sql)) {
        return { rows: [
          { id: 1, name: 'dagger', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'melee',
            damage: 10, cooldown: 0.3, reach: 90, arc_width: Math.PI * 2,
            range: null, projectile_speed: null, projectile_radius: null, pierce: null, mana_cost: 0, element: null,
            defense: null, resistances: null },
        ] };
      }
      if (/FROM player_items/i.test(sql)) return { rows: [] };
      if (/FROM player_equipment/i.test(sql)) return { rows: [] };
      if (/INSERT INTO player_items/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO player_equipment/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/DELETE FROM player_equipment/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO world_chunks/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM world_players WHERE/i.test(sql)) return { rows: [] }; // spawn = center 400,400
      // DELETE check must come before the generic bbox-SELECT check below:
      // the DELETE SQL text also contains the substring "FROM world_creatures".
      if (/DELETE FROM world_creatures/i.test(sql)) { deletes.push(params[0]); return { rows: [] }; }
      if (/FROM world_creatures/i.test(sql)) {
        // bbox load for chunk (0,0): a wolf ~10px from the player center.
        if (params[1] === 0) return { rows: [{ id: 'wolf1', type: 'Wolf', x: 410, y: 400, hp: 5, facing: 'S', color: '#c00' }] };
        return { rows: [] };
      }
      if (/UPDATE world_creatures/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}
function token(u) { return jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' }); }
function bootWith(pool) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, { jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 10000 });
    server.listen(0, () => resolve({ url: `ws://127.0.0.1:${server.address().port}/authority`, handle, server }));
  });
}
function connect(url, uid) { return new WebSocket(`${url}?token=${encodeURIComponent(token(uid))}`); }
function nextMsg(ws, type) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout ${type}`)), 3000);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (!type || m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

test('an adjacent aggro creature damages the player (state.hp drops)', async () => {
  const { url, handle, server } = await bootWith(fakePool());
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  const joined = await nextMsg(ws, 'joined');
  let hurt = false;
  for (let i = 0; i < 60 && !hurt; i++) {
    const s = await nextMsg(ws, 'state');
    const me = s.players.find((p) => p.id === '1');
    if (me && me.hp < me.maxHp) hurt = true;
  }
  assert.ok(hurt, 'player took contact damage');
  ws.close(); handle.close(); server.close();
});

test('attack kills an adjacent creature (DELETE issued, gone from creatures)', async () => {
  const pool = fakePool();
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  // Chunk activation (DB roundtrip) races the first broadcast — the first
  // 'creatures' message is always empty because recomputeActive() kicks off
  // activateChunk() (async) and broadcastCreatures() runs synchronously right
  // after, before that promise resolves. Wait for a broadcast that actually
  // contains the wolf before attacking.
  let loaded = false;
  for (let i = 0; i < 20 && !loaded; i++) {
    const m = await nextMsg(ws, 'creatures');
    if (m.creatures.some((c) => c.id === 'wolf1')) loaded = true;
  }
  assert.ok(loaded, 'wolf loaded before attack');
  // Two attacks (5 hp wolf, 10 dmg) — one is enough; cooldown-safe with a gap.
  ws.send(JSON.stringify({ type: 'attack' }));
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    const m = await nextMsg(ws, 'creatures');
    if (!m.creatures.some((c) => c.id === 'wolf1')) gone = true;
  }
  assert.ok(gone, 'wolf removed after attack');
  assert.ok(pool.deletes.includes('wolf1'), 'DELETE issued for the killed creature');
  ws.close(); handle.close(); server.close();
});

// F2: the tick loop's PROJECTILE kill site must route through the same
// commitCreatureDeath funnel as the melee attack handler above. Unlike
// fakePool() (whose DELETE mock returns no rowCount, so commitCreatureDeath's
// `r.rowCount !== 1` guard bails before ever reaching spawnDrops), this pool
// arms a real entity_type id and a creature_drops row so the drop roll can
// actually be observed — a raw `DELETE FROM world_creatures WHERE id = $1`
// substituted at the kill site would still make the creature vanish from the
// broadcast (CreatureSim removes it from memory the instant its hp hits 0,
// independent of the DB call) and would still match a loose "DELETE FROM
// world_creatures" substring check, so this distinguishes the funnel's
// `... RETURNING` variant specifically, plus the drop-roll side effects that
// only the funnel produces.
function fakePoolWithBow() {
  const deletes = [];       // funnel deletes: DELETE ... RETURNING
  const rawDeletes = [];    // any other DELETE FROM world_creatures (e.g. a reverted raw query)
  const dropQueries = [];   // creature_drops lookups (only the funnel issues these)
  const itemInserts = [];   // world_items inserts spawned by the drop roll
  return {
    deletes, rawDeletes, dropQueries, itemInserts,
    query: async (sql, params) => {
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      if (/token_version FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] }; // matches token()'s tv:1 → passes the on-connect version check
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      // id: 42 (unlike fakePool() above) so creatureTypeIds.get('Wolf') resolves
      // and spawnDrops doesn't bail on an unknown entity type.
      if (/FROM entity_types WHERE is_creature/i.test(sql)) return { rows: [{ id: 42, name: 'Wolf', color: '#c00', hp: 5 }] };
      // Bow: a projectile weapon, tuned to reach the wolf in a single tick and
      // one-shot its 5 hp. It becomes the default weapon (resolveDefaultWeaponId
      // falls back to "first weapon" when no item named "dagger" is in the
      // catalog), so no equip step is needed.
      if (/FROM item_types/i.test(sql)) {
        return { rows: [
          { id: 3, name: 'bow', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'projectile',
            damage: 10, cooldown: 0.05, range: 2000, projectile_speed: 4000, projectile_radius: 40, pierce: 1,
            mana_cost: 0, element: null, defense: null, resistances: null, reach: null, arc_width: null },
        ] };
      }
      if (/FROM player_items/i.test(sql)) return { rows: [] };
      if (/FROM player_equipment/i.test(sql)) return { rows: [] };
      if (/INSERT INTO player_items/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO player_equipment/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/DELETE FROM player_equipment/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO world_chunks/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM world_players WHERE/i.test(sql)) return { rows: [] }; // spawn = center 400,400
      // The funnel's DELETE ... RETURNING (checked before the generic
      // world_creatures DELETE below, and before the bbox-SELECT check, since
      // both match "FROM world_creatures" as a substring).
      if (/DELETE\s+FROM\s+world_creatures[\s\S]*RETURNING/i.test(sql)) {
        deletes.push(params[0]);
        return { rows: [{ type: 'Wolf', x: 410, y: 400 }], rowCount: 1 };
      }
      if (/DELETE FROM world_creatures/i.test(sql)) {
        rawDeletes.push(params[0]);
        return { rows: [], rowCount: 1 };
      }
      if (/FROM creature_drops/i.test(sql)) {
        dropQueries.push(params[0]);
        return { rows: [{ item_type_id: 99, chance: '1', min_qty: 1, max_qty: 1 }] };
      }
      if (/FROM world_creatures/i.test(sql)) {
        // bbox load for chunk (0,0): a wolf ~10px from the player center.
        if (params[1] === 0) return { rows: [{ id: 'wolf1', type: 'Wolf', x: 410, y: 400, hp: 5, facing: 'S', color: '#c00' }] };
        return { rows: [] };
      }
      if (/UPDATE world_creatures/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_items/i.test(sql)) {
        const row = { id: `drop-${itemInserts.length + 1}`, item_type_id: params[1], x: params[2], y: params[3], expires_at: '2999-01-01T00:00:00Z' };
        itemInserts.push(row);
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [] };
    },
  };
}

test('a creature killed BY A PROJECTILE routes through the shared kill funnel (DELETE ... RETURNING, then a drop roll) — not merely gone from memory', async () => {
  const pool = fakePoolWithBow();
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  let loaded = false;
  for (let i = 0; i < 20 && !loaded; i++) {
    const m = await nextMsg(ws, 'creatures');
    if (m.creatures.some((c) => c.id === 'wolf1')) loaded = true;
  }
  assert.ok(loaded, 'wolf loaded before attack');
  // Aim explicitly at the wolf's centre: player spawns at (400,400) top-left
  // -> centre (432,432); wolf's mocked top-left (410,400) + half CREATURE_SIZE
  // (24) -> centre (434,424). A bow's straight-line projectile (unlike a
  // melee arc) needs a real direction, not the player's default facing.
  ws.send(JSON.stringify({ type: 'attack', ax: 434 - 432, ay: 424 - 432 }));
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    const m = await nextMsg(ws, 'creatures');
    if (!m.creatures.some((c) => c.id === 'wolf1')) gone = true;
  }
  assert.ok(gone, 'wolf removed from the broadcast after the projectile hit');
  assert.ok(pool.deletes.includes('wolf1'),
    "the funnel's DELETE FROM world_creatures ... RETURNING was issued for the projectile kill");
  assert.strictEqual(pool.rawDeletes.length, 0, 'no non-funnel DELETE was issued');
  assert.ok(pool.dropQueries.includes(42), 'a drop roll followed: creature_drops was consulted for the killed entity type');
  assert.ok(pool.itemInserts.length > 0, 'the rolled drop was actually spawned as a world_items row');
  ws.close(); handle.close(); server.close();
});
