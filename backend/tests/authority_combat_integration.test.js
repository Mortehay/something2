const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');
const { STONE_XP_PER_HIT, LEVEL_XP_THRESHOLD } = require('../src/authority/stoneXp.js');

const SECRET = 'test-secret';

// activateChunk (F-018 / SOMET-198) and commitCreatureDeath (SOMET-242) both
// open a client via pool.connect() to wrap their own work in a transaction,
// on top of the plain pool.query() every fake pool below already answers.
// `.connect()` returns a DISTINCT client object per call (its own call log,
// its own release counter) rather than literally `{ query: pool.query,
// release: () => {} }` — that original shape made a checked-out client's
// query indistinguishable from a query issued directly on the bare pool
// (review round 1, finding 2, on progression_kill_xp.test.js). It still
// delegates to the SAME `pool.query` closure for routing/state (so every
// fake pool's own tracking arrays below — `deletes`, `itemInserts`, etc. —
// are unaffected), only connection identity is now real. Neither fake here
// asserts on BEGIN/COMMIT/ROLLBACK identity itself (progression_kill_xp.test.js
// carries that burden for commitCreatureDeath's own transaction), but
// `pool.clients[i].released` is available if a future test here wants it.
function withConnect(pool) {
  pool.clients = [];
  pool.connect = async () => {
    const calls = [];
    const client = {
      calls,
      released: 0,
      query: async (sql, params) => { calls.push({ sql, params }); return pool.query(sql, params); },
      release: () => { client.released += 1; },
    };
    pool.clients.push(client);
    return client;
  };
  return pool;
}

// World w1 (chunk_size 8 → chunk (0,0) center 400,400). One wolf near the
// player's spawn so it aggros. chunk insert rowCount 0 (already materialized).
function fakePool() {
  const deletes = [];
  return withConnect({
    deletes,
    query: async (sql, params) => {
      // SOMET-260: join resolves the character before anything else; a pool
      // that falls through to rows:[] refuses the join, which HANGS the test
      // on nextMsg('joined') rather than failing it.
      if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]), entity_type_id: 1 }] };
      // Plan B slice 3: the join policy's world+visit lookup, which now runs
      // on every join. Falling through to rows:[] refuses it, and the test
      // then HANGS waiting for 'joined' rather than failing. is_entry with no
      // history is the first-join leg -- what these fixtures actually are.
      if (/FROM worlds w WHERE w\.id/i.test(sql)) return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] }; // matches token()'s tv:1 → passes the on-connect version check
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      // SOMET-249: loadCreatureTypes now LEFT JOINs creature_behaviors, so its
      // SELECT reads "FROM entity_types e ... WHERE e.is_creature" rather than
      // the bare "FROM entity_types WHERE is_creature". Keep this pattern in
      // step with that SELECT -- a routing miss here doesn't fail loudly, it
      // falls through and hangs the test waiting on a creature that never
      // loads.
      //
      // SOMET-254: these behaviour columns feed loadCreatureTypes' TYPE
      // catalog only -- the world_creatures row below carries no behaviour
      // fields at all, so the live wolf this test actually drives through
      // combat resolves via the faction fallback, never through this row.
      // Kept genuinely distinct from DEFAULT_BEHAVIOR (not the old
      // byte-identical 400/800/charge/0/1/null) so a broken resolveBehavior
      // mapping would show up here instead of silently agreeing with its own
      // fallback; resolveBehavior's real field mapping is pinned in
      // creature_behaviors_resolve.test.js, and the live wiring end-to-end in
      // creature_mechanics_wiring.test.js.
      if (/FROM entity_types e[\s\S]*WHERE e\.is_creature/i.test(sql)) return { rows: [{
        name: 'Wolf', color: '#c00', hp: 5, attack_element: 'physical',
        behavior_name: 'Line', attack_kind: 'melee', attack_range: 60, attack_cooldown: 1,
        projectile_speed: 0, projectile_radius: 0, aggro_radius: 444, leash_radius: 777,
        chase_style: 'skirmish', preferred_range: 111, move_speed_mult: 1.3, damage_override: 9,
      }] };
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
      // SOMET-260: join now resolves the character before anything else, and a
      // fake pool that falls through to rows:[] refuses the join -- which makes the
      // test HANG waiting for 'joined' rather than fail. Answer it explicitly.
      if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]), entity_type_id: 1 }] };
      // Plan B slice 3: the join policy's world+visit lookup, which now runs
      // on every join. Falling through to rows:[] refuses it, and the test
      // then HANGS waiting for 'joined' rather than failing. is_entry with no
      // history is the first-join leg -- what these fixtures actually are.
      if (/FROM worlds w WHERE w\.id/i.test(sql)) return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
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
  });
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
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
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
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
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
  // commitCreatureDeath now awards XP inside the same transaction (Task 6),
  // so a real kill against this pool reaches player_progression too. A tiny
  // in-memory row (lazily created, mirroring loadProgression's lazy INSERT)
  // is enough to keep awardXp's real read/compute/write logic running
  // truthfully against this fake instead of crashing on an unmocked table —
  // this test isn't about progression, so the row starts and stays at
  // level 1 (the killed wolf has no `level` in its RETURNING row either, so
  // xpForKill falls back to creature level 1 against player level 1).
  const progression = new Map();
  function progressionRow(userId) {
    if (!progression.has(userId)) {
      progression.set(userId, {
        user_id: userId, experience: 0, level: 1, stat_points: 0,
        strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5,
      });
    }
    return progression.get(userId);
  }
  return withConnect({
    deletes, rawDeletes, dropQueries, itemInserts,
    query: async (sql, params) => {
      // SOMET-260: join resolves the character before anything else; a pool
      // that falls through to rows:[] refuses the join, which HANGS the test
      // on nextMsg('joined') rather than failing it.
      if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]), entity_type_id: 1 }] };
      // Plan B slice 3: the join policy's world+visit lookup, which now runs
      // on every join. Falling through to rows:[] refuses it, and the test
      // then HANGS waiting for 'joined' rather than failing. is_entry with no
      // history is the first-join leg -- what these fixtures actually are.
      if (/FROM worlds w WHERE w\.id/i.test(sql)) return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
      if (/^\s*INSERT INTO player_progression/i.test(sql)) { progressionRow(params[0]); return { rows: [], rowCount: 0 }; }
      if (/^\s*UPDATE player_progression/i.test(sql)) {
        const row = progressionRow(params[0]);
        row.experience = Number(params[1]); row.level = Number(params[2]); row.stat_points += Number(params[3]) || 0;
        return { rows: [{ ...row, experience: String(row.experience) }], rowCount: 1 };
      }
      if (/FROM player_progression/i.test(sql)) {
        const row = progressionRow(params[0]);
        return { rows: [{ ...row, experience: String(row.experience) }], rowCount: 1 };
      }
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] }; // matches token()'s tv:1 → passes the on-connect version check
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      // id: 42 (unlike fakePool() above) so creatureTypeIds.get('Wolf') resolves
      // and spawnDrops doesn't bail on an unknown entity type.
      // SOMET-249: see the comment on the identical pattern in fakePool() above
      // -- must stay in step with loadCreatureTypes' SELECT, else this falls
      // through silently and the test hangs instead of failing.
      if (/FROM entity_types e[\s\S]*WHERE e\.is_creature/i.test(sql)) return { rows: [{
        id: 42, name: 'Wolf', color: '#c00', hp: 5, attack_element: 'physical',
        behavior_name: 'Line', attack_kind: 'melee', attack_range: 60, attack_cooldown: 1,
        projectile_speed: 0, projectile_radius: 0, aggro_radius: 400, leash_radius: 800,
        chase_style: 'charge', preferred_range: 0, move_speed_mult: 1, damage_override: null,
      }] };
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
  });
}

test('a creature killed BY A PROJECTILE routes through the shared kill funnel (DELETE ... RETURNING, then a drop roll) — not merely gone from memory', async () => {
  const pool = fakePoolWithBow();
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
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

// --- SOMET-286 review fix ----------------------------------------------
//
// The tick loop's BLOCK site (server.js's `pushImpacts(entry, blocks)` right
// after tickProjectiles) had no test at all. projectiles.js's own tests prove
// step() RETURNS the blocks, and guard_player_immunity.test.js pins the
// descriptor's shape and its direction vector -- but between those two and the
// player's screen sits one line of glue, and this project has shipped a
// protocol field nothing ever read more than once. A destructure whose name
// drifts from step()'s return yields `undefined`, pushImpacts ignores it, and
// every existing test stays green while the cue silently never reaches a
// frame.
//
// A BOW rather than a melee swing, deliberately: a melee block is pushed
// synchronously from the attack handler (server.js's `pushImpacts(entry,
// impacts)`), so a swing would pass this test through the wrong line. A bow's
// attack returns no impacts at all -- the shot only meets the guard a tick or
// more later, inside tickProjectiles -- so the block observed here can only
// have come from the tick-loop site.
//
// A separate pool from fakePoolWithBow above rather than a guard added to it:
// a guard standing next to that test's wolf would ENGAGE the wolf (guards take
// hostiles), and could kill it, which would let its `DELETE issued for the
// projectile kill` assertion pass without the projectile ever landing.
function fakePoolWithGuardAndBow() {
  const deletes = [];
  return withConnect({
    deletes,
    query: async (sql, params) => {
      if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]), entity_type_id: 1 }] };
      if (/FROM worlds w WHERE w\.id/i.test(sql)) return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      // No behaviour profile, exactly like the live Village Guard rows: the
      // guard-ness comes from `faction` on the creature row below, which
      // resolveInstanceBehavior turns into GUARD_DEFAULT_BEHAVIOR (chaseStyle
      // 'guard') -- the one thing the immunity, and therefore the block, keys
      // on. Handing it a profile here would let this test pass against a
      // faction check that the live loader would never satisfy.
      if (/FROM entity_types e[\s\S]*WHERE e\.is_creature/i.test(sql)) return { rows: [{
        id: 43, name: 'Village Guard', color: '#88f', hp: 7005, attack_element: 'physical',
        behavior_name: null, attack_kind: 'melee', attack_range: 60, attack_cooldown: 1,
        projectile_speed: 0, projectile_radius: 0, aggro_radius: null, leash_radius: null,
        chase_style: null, preferred_range: null, move_speed_mult: null, damage_override: null,
      }] };
      // Same bow as fakePoolWithBow: reaches the target within a single tick.
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
      // Recorded so the test can assert the shot did NOT kill what it bounced
      // off: a block that arrived because the guard died would prove nothing.
      if (/DELETE FROM world_creatures/i.test(sql)) { deletes.push(params[0]); return { rows: [], rowCount: 1 }; }
      if (/FROM world_creatures/i.test(sql)) {
        // Standing where fakePoolWithBow's wolf stands, so the same aim vector
        // puts the arrow through it.
        if (params[1] === 0) return { rows: [{
          id: 'guard1', type: 'Village Guard', x: 410, y: 400, hp: 7005, level: 150,
          defense: 84.5, facing: 'S', color: '#88f', faction: 'guard',
          home_x: 434, home_y: 424,
        }] };
        return { rows: [] };
      }
      if (/UPDATE world_creatures/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  });
}

test("a shot that passes through a guard reaches the client as a blocked impact (server.js's tick-loop pushImpacts, not just projectiles.js's return value)", async () => {
  const pool = fakePoolWithGuardAndBow();
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  let loaded = false;
  for (let i = 0; i < 20 && !loaded; i++) {
    const m = await nextMsg(ws, 'creatures');
    if (m.creatures.some((c) => c.id === 'guard1')) loaded = true;
  }
  assert.ok(loaded, 'guard loaded before the shot');
  // Player centre (432,432) -> guard centre (434,424), same aim the projectile
  // kill test above uses.
  ws.send(JSON.stringify({ type: 'attack', ax: 434 - 432, ay: 424 - 432 }));

  let blocked = null;
  for (let i = 0; i < 40 && !blocked; i++) {
    const s = await nextMsg(ws, 'state');
    // The block must ride the EXISTING impacts key -- a second frame field
    // would be a second lifetime for the client to keep in step with.
    const imps = s.impacts;
    if (Array.isArray(imps)) blocked = imps.find((im) => im && im.b === true) || null;
  }
  assert.ok(blocked, "a state frame must carry the refused shot's blocked impact");
  assert.strictEqual(blocked.t, 'c:guard1', 'the cue must name the guard the shot passed through');
  assert.ok(!('v' in blocked) || blocked.v == null,
    'a block carries no effect NAME -- the client draws its built-in shield, which no renamed vfx_effects row can take away');
  assert.ok(Number.isFinite(blocked.nx) && Number.isFinite(blocked.ny),
    'the direction the blow came from must survive the trip to the frame');
  assert.deepStrictEqual(pool.deletes, [],
    'the guard must be unharmed: a block is the refusal being shown, not a kill');
  ws.close(); handle.close(); server.close();
});

// --- SOMET-245 Task 7 review fix ---------------------------------------
//
// A WS-level end-to-end proof that server.js's glue actually fires an
// UPDATE stone_instances call for a REAL socketed spell stone on a REAL
// landed hit -- not just that world.js/items.js/projectiles.js each
// individually compute the right value in isolation. Mirrors
// fakePoolWithBow's own end-to-end proof for onCreatureDeath ->
// player_progression just above, for the identical reason stated in that
// function's header comment: a field-name mismatch, a dropped `if`, or a
// promise that silently never fires in the glue (server.js:1136/1183/1743's
// `if (stoneHit) onStoneHit(...)` / `for (const h of stoneHits) ...`, and
// onStoneHit itself) is invisible to a pure unit test on
// awardStoneXp/activeWeaponType/attack() alone.
//
// Reuses fakePool()'s wolf/dagger world almost verbatim (same non-RETURNING
// DELETE mock shape, so commitCreatureDeath's `rowCount !== 1` guard bails
// before player_progression is ever touched -- this test is about stone XP,
// not player XP), adding only: a spell-stone item_types row, the
// weapon+stone player_items rows, main_hand equipment, and the
// stone_instances hydration join loadInventory issues at join time (Task 5)
// so the dagger is ALREADY socketed by the time this player attacks --
// the same "already socketed at join" case
// items_socket_cache.test.js/authority_items_inventory.test.js cover at the
// unit level, exercised here through the real join handler instead.
function fakePoolWithSocketedSpellStone() {
  const deletes = [];
  const stoneUpdates = []; // every UPDATE stone_instances SET xp = xp + ... call, {sql, params}
  return withConnect({
    deletes,
    stoneUpdates,
    query: async (sql, params) => {
      if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]), entity_type_id: 1 }] };
      if (/FROM worlds w WHERE w\.id/i.test(sql)) return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      if (/FROM entity_types e[\s\S]*WHERE e\.is_creature/i.test(sql)) return { rows: [{
        name: 'Wolf', color: '#c00', hp: 5, attack_element: 'physical',
        behavior_name: 'Line', attack_kind: 'melee', attack_range: 60, attack_cooldown: 1,
        projectile_speed: 0, projectile_radius: 0, aggro_radius: 444, leash_radius: 777,
        chase_style: 'skirmish', preferred_range: 111, move_speed_mult: 1.3, damage_override: 9,
      }] };
      // Dagger (weapon) + stone_of_dagger (a fire SPELL stone -- element
      // set, so activeWeaponType's merge branch actually fires). Same
      // omnidirectional arc as fakePool()'s own dagger, so this test stays
      // independent of the player's facing at attack time.
      if (/FROM item_types/i.test(sql)) {
        return { rows: [
          { id: 1, name: 'dagger', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'melee',
            damage: 10, cooldown: 0.3, reach: 90, arc_width: Math.PI * 2,
            range: null, projectile_speed: null, projectile_radius: null, pierce: null, mana_cost: 0, element: null,
            defense: null, resistances: null },
          { id: 2, name: 'stone_of_dagger', category: 'stone', slot: null, two_handed: false, kind: null,
            damage: 10, cooldown: 0.3, reach: null, arc_width: null,
            range: null, projectile_speed: null, projectile_radius: null, pierce: null, mana_cost: 0, element: 'fire',
            defense: null, resistances: null },
        ] };
      }
      // This character owns both the dagger and the stone; the dagger is
      // ALREADY socketed with the stone (see the stone_instances hydration
      // route below), matching what a real player would have after Task
      // 4/5's live socket flow, persisted across a reconnect.
      if (/FROM player_items/i.test(sql)) return { rows: [
        { id: 'weapon-1', item_type_id: 1, quantity: 1 },
        { id: 'stone-1', item_type_id: 2, quantity: 1 },
      ] };
      if (/FROM player_equipment/i.test(sql)) return { rows: [{ slot: 'main_hand', item_id: 'weapon-1' }] };
      // loadInventory's join-time hydration query (items.js) -- this exact
      // regex is what makes activeWeaponType see the dagger as socketed
      // WITHOUT a live 'socket' message anywhere in this test.
      if (/SELECT si\.socketed_into_id AS host_id/i.test(sql)) {
        return { rows: [{ host_id: 'weapon-1', stone_item_id: 'stone-1', stone_type_id: 2 }] };
      }
      if (/INSERT INTO player_items/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO player_equipment/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/DELETE FROM player_equipment/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO world_chunks/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM world_players WHERE/i.test(sql)) return { rows: [] }; // spawn = center 400,400
      // DELETE check must come before the generic bbox-SELECT check below,
      // same non-RETURNING shape as fakePool()'s own DELETE mock -- see this
      // function's header comment for why that keeps player_progression out
      // of scope for this test.
      if (/DELETE FROM world_creatures/i.test(sql)) { deletes.push(params[0]); return { rows: [] }; }
      if (/FROM world_creatures/i.test(sql)) {
        if (params[1] === 0) return { rows: [{ id: 'wolf1', type: 'Wolf', x: 410, y: 400, hp: 5, facing: 'S', color: '#c00' }] };
        return { rows: [] };
      }
      if (/UPDATE world_creatures/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
      // stoneXp.js's own two queries -- the whole point of this test.
      if (/SELECT level FROM stone_instances/i.test(sql)) return { rows: [{ level: 1 }], rowCount: 1 };
      if (/UPDATE stone_instances SET xp = xp \+ \$1/i.test(sql)) {
        stoneUpdates.push({ sql, params });
        return { rows: [{ xp: params[0], level: 1 }], rowCount: 1 };
      }
      return { rows: [] };
    },
  });
}

test('a melee hit landed with a socketed spell stone awards stone XP end-to-end (server.js wiring: attack -> onStoneHit -> UPDATE stone_instances)', async () => {
  const pool = fakePoolWithSocketedSpellStone();
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  let loaded = false;
  for (let i = 0; i < 20 && !loaded; i++) {
    const m = await nextMsg(ws, 'creatures');
    if (m.creatures.some((c) => c.id === 'wolf1')) loaded = true;
  }
  assert.ok(loaded, 'wolf loaded before attack');

  ws.send(JSON.stringify({ type: 'attack' }));

  // onStoneHit is deliberately fire-and-forget (server.js never awaits it --
  // it's on the hot path), so there is no reply frame to wait on. Poll the
  // fake pool's own call log instead, the same technique this file already
  // uses above to wait for the wolf's removal from the creature broadcast,
  // just against a different observable.
  let awarded = false;
  for (let i = 0; i < 40 && !awarded; i++) {
    if (pool.stoneUpdates.length > 0) { awarded = true; break; }
    await new Promise((r) => { setTimeout(r, 20); });
  }
  assert.ok(awarded, 'server.js must fire an UPDATE stone_instances call after a landed spell-stone hit');
  assert.equal(pool.stoneUpdates.length, 1, 'exactly one landed swing must award exactly one stone-XP call');
  assert.deepEqual(pool.stoneUpdates[0].params, [STONE_XP_PER_HIT, LEVEL_XP_THRESHOLD, 'stone-1'],
    'must award STONE_XP_PER_HIT to stone-1 SPECIFICALLY -- the stone\'s own instance id, not the weapon\'s (weapon-1) or the stone\'s catalog type id (2)');

  ws.close(); handle.close(); server.close();
});
