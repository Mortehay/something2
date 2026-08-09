const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { Pool } = require('pg');
const { World } = require('../src/authority/world.js');
const { commitCreatureDeath } = require('../src/authority/loot.js');
const { attachAuthority } = require('../src/authority/server.js');

// ---------------------------------------------------------------------------
// Part 1: commitCreatureDeath unit tests -- mocked pool, no database.
//
// Only the SQL layer (db.query) is faked here; loadProgression, awardXp and
// xpForKill all run for REAL against that fake, so these tests exercise the
// actual formulas end to end, not a mocked-out result. That is what keeps
// the literal expected values below meaningful: they are hand-derived from
// progressionConstants.js, not echoed back from the code under test.
// ---------------------------------------------------------------------------

// Routes queries by SQL pattern. `.connect()` returns a DISTINCT client
// object per call -- its own call log, its own release counter -- rather
// than `{ query: pool.query, release: () => {} }` (the original shape,
// review round 1 finding 2). That original shape meant `client.query(x)`
// and `pool.query(x)` were the SAME function reference: nothing in any test
// could tell "landed on the checked-out client" apart from "landed on the
// bare pool", so a bug that issued BEGIN/DELETE/COMMIT/ROLLBACK on the wrong
// one would look identical to a correct transaction. `pool.calls` now stays
// empty for every test below UNLESS commitCreatureDeath (wrongly) queries
// the bare pool directly, and each client's own `.calls`/`.released` prove
// which connection actually carried each statement.
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
    matching(re) {
      return [...poolCalls, ...clients.flatMap((c) => c.calls)].filter((c) => re.test(c.sql));
    },
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

// SOMET-257 made progression per-character, so commitCreatureDeath resolves
// the killer's character id off the LIVE player rather than reusing
// killerUserId (which is the in-memory identity, not a database key). That
// makes a player object mandatory for a credited kill -- an entry with no
// player is no longer a realistic stand-in for one, so armEntry adds the
// killer it is about to credit.
//
// The dependency is not new in kind: onCreatureDeath already had to find the
// same live player to push a level-up down its socket.
function armEntry({ killerUserId = 'u1', killerCharacterId = 7 } = {}) {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  const world = new World(map, new Map(), null, 8);
  if (killerUserId != null) {
    world.addPlayer(killerUserId, { x: 0, y: 0 }, { items: [], equipment: {} },
      { x: 0, y: 0 }, 0, undefined, killerCharacterId);
  }
  return {
    worldId: 'w1',
    world,
    creatureTypeIds: new Map([['Wolf', 42]]),
  };
}

// A minimal player_progression fake row plus the two routes (INSERT-lazy,
// SELECT) that make loadProgression's real queries behave like a real
// one-row table. The UPDATE route is deliberately NOT included here -- every
// test below either wants the real read/compute/write round trip (and adds
// its own working UPDATE) or wants the UPDATE to fail (test 5), so it stays
// opt-in rather than a shared default that would be silently overridden.
function progressionReadRoutes(row) {
  return [
    [/^\s*INSERT INTO player_progression/i, { rows: [], rowCount: 0 }],
    [/FROM player_progression/i, () => ({ rows: [{ ...row, experience: String(row.experience) }], rowCount: 1 })],
  ];
}

function progressionWriteRoute(row) {
  return [/^\s*UPDATE player_progression/i, (p) => {
    row.experience = Number(p[1]);
    row.level = Number(p[2]);
    row.stat_points += Number(p[3]) || 0;
    return { rows: [{ ...row, experience: String(row.experience) }], rowCount: 1 };
  }];
}

const always = () => 0; // rng: always rolls under chance, always min qty

test('a kill awards XP scaled by the creature level, not a flat per-kill amount', async () => {
  const entry = armEntry();
  // Creature level 6, player level 4 -> diff +2 -> factor 1 + 0.2*2 = 1.4 ->
  // amount = round(XP_KILL_BASE(10) * 6 * 1.4) = 84. Deliberately NOT a case
  // several plausible formulas would agree on: ignoring the player's level
  // (flat base*creatureLevel) gives 60; ignoring the creature's level gives
  // a constant regardless of which creature died. 84 only comes out if BOTH
  // levels really feed xpForKill.
  const row = {
    user_id: 'u1', experience: 650, level: 4, stat_points: 0,
    strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5,
  };
  const pool = scriptedPool([
    [/DELETE FROM world_creatures/i, { rows: [{ type: 'Wolf', x: 0, y: 0, level: 6 }], rowCount: 1 }],
    [/FROM creature_drops/i, { rows: [], rowCount: 0 }],
    ...progressionReadRoutes(row),
    progressionWriteRoute(row),
  ]);

  const result = await commitCreatureDeath(pool, entry, 'c1', { rng: always, ttlMs: 1000, killerUserId: 'u1' });

  assert.strictEqual(result.awarded, 84, 'must be the real xpForKill(6, 4) value');
  // xpFloor(4) = 600, xpFloor(5) = 1000 -- 650 and 650+84=734 both sit inside
  // level 4's own range, so this kill alone must not level the player up.
  assert.strictEqual(result.leveledUp, false);
  assert.strictEqual(result.newLevel, 4);
  assert.strictEqual(result.progression.experience, 734);
  assert.strictEqual(result.killerUserId, 'u1');

  // Finding 2/3: the transaction really is one client, and it's released.
  assert.strictEqual(pool.calls.length, 0, 'nothing may be issued directly on the bare pool');
  assert.strictEqual(pool.clients.length, 1, 'exactly one client is checked out');
  const client = pool.clients[0];
  assert.strictEqual(client.matching(/^\s*BEGIN/i).length, 1, 'BEGIN must land on the client');
  assert.strictEqual(client.matching(/DELETE FROM world_creatures/i).length, 1, 'the DELETE must land on the client');
  assert.strictEqual(client.matching(/^\s*COMMIT/i).length, 1, 'COMMIT must land on the client');
  assert.strictEqual(client.released, 1, 'the client must be released exactly once');
});

test('a kill by nobody (a guard) awards nothing and still drops loot', async () => {
  const entry = armEntry();
  const dropRow = { item_type_id: 7, chance: '1', min_qty: 1, max_qty: 1 };
  const pool = scriptedPool([
    [/DELETE FROM world_creatures/i, { rows: [{ type: 'Wolf', x: 100, y: 100, level: 9 }], rowCount: 1 }],
    [/FROM creature_drops/i, { rows: [dropRow], rowCount: 1 }],
    [/INSERT INTO world_items/i, (p) => ({
      rows: [{ id: 'g1', item_type_id: p[1], x: p[2], y: p[3], expires_at: '2999-01-01T00:00:00Z' }],
      rowCount: 1,
    })],
  ]);

  const result = await commitCreatureDeath(pool, entry, 'c1', { rng: always, ttlMs: 1000, killerUserId: null });

  assert.strictEqual(result.awarded, 0);
  assert.strictEqual(result.leveledUp, false);
  assert.strictEqual(result.newLevel, null);
  assert.strictEqual(result.progression, null);
  assert.strictEqual(result.killerUserId, null);
  assert.strictEqual(
    pool.matching(/player_progression/i).length, 0,
    'no killer must mean no progression query at all -- not a zero-amount award',
  );
  assert.strictEqual(entry.world.groundItems.count(), 1, 'the drop must still land');

  assert.strictEqual(pool.calls.length, 0);
  assert.strictEqual(pool.clients.length, 1);
  assert.strictEqual(pool.clients[0].matching(/^\s*COMMIT/i).length, 1, 'COMMIT must land on the client');
  assert.strictEqual(pool.clients[0].released, 1);
});

test('a second commit of the same creature id awards nothing and returns null', async () => {
  const entry = armEntry({ killerUserId: 'u2' });
  let deleted = false;
  const row = {
    user_id: 'u2', experience: 0, level: 1, stat_points: 0,
    strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5,
  };
  const pool = scriptedPool([
    [/DELETE FROM world_creatures/i, () => {
      if (deleted) return { rows: [], rowCount: 0 }; // already finalized elsewhere, exactly like a real second DELETE
      deleted = true;
      return { rows: [{ type: 'Wolf', x: 0, y: 0, level: 1 }], rowCount: 1 };
    }],
    [/FROM creature_drops/i, { rows: [], rowCount: 0 }],
    ...progressionReadRoutes(row),
    progressionWriteRoute(row),
  ]);

  const first = await commitCreatureDeath(pool, entry, 'c1', { rng: always, ttlMs: 1000, killerUserId: 'u2' });
  assert.ok(first, 'the first commit finalizes the death');
  assert.strictEqual(first.awarded, 10, 'sanity: level-1 kill vs level-1 player is flat XP_KILL_BASE');
  assert.strictEqual(row.experience, 10, 'sanity: the first write actually landed');

  const second = await commitCreatureDeath(pool, entry, 'c1', { rng: always, ttlMs: 1000, killerUserId: 'u2' });

  assert.strictEqual(second, null, 'the rowCount gate must refuse the second finalize outright');
  assert.strictEqual(row.experience, 10, 'no second award may reach the row');

  // Finding 2: each call checks out its OWN client, and the refused second
  // commit's ROLLBACK/refusal must land on ITS client (not the pool, and not
  // the first call's already-committed-and-released client).
  assert.strictEqual(pool.calls.length, 0, 'nothing may be issued directly on the bare pool');
  assert.strictEqual(pool.clients.length, 2, 'each commitCreatureDeath call must check out its own client');
  const [c1, c2] = pool.clients;
  assert.strictEqual(c1.matching(/^\s*COMMIT/i).length, 1, 'the first (successful) commit must COMMIT on its own client');
  assert.strictEqual(c1.matching(/^\s*UPDATE player_progression/i).length, 1, 'only the first commit may ever write XP');
  assert.strictEqual(c1.released, 1);
  assert.strictEqual(c2.matching(/^\s*ROLLBACK/i).length, 1, 'the second (refused) commit must ROLLBACK on its own client');
  assert.strictEqual(c2.matching(/^\s*COMMIT/i).length, 0);
  assert.strictEqual(c2.matching(/^\s*UPDATE player_progression/i).length, 0, 'the refused commit must never reach the award at all');
  assert.strictEqual(c2.released, 1);
});

test('a failed XP award rolls back the creature deletion', async () => {
  const entry = armEntry({ killerUserId: 'u3' });
  // A tiny stateful "table": DELETE removes the row and stashes it as
  // pending; ROLLBACK restores it; COMMIT drops the stash. This is enough
  // real transactional semantics to make "the row still exists" a genuine
  // assertion about commitCreatureDeath's ROLLBACK call, not a tautology --
  // a mock with no state at all could never fail this check regardless of
  // whether the code under test rolls back anything.
  const creatures = new Map([['c1', { type: 'Wolf', x: 0, y: 0, level: 1 }]]);
  let pendingDelete = null;
  const row = {
    user_id: 'u3', experience: 0, level: 1, stat_points: 0,
    strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5,
  };

  const pool = scriptedPool([
    [/^\s*BEGIN/i, { rows: [], rowCount: 0 }],
    [/^\s*COMMIT/i, () => { pendingDelete = null; return { rows: [], rowCount: 0 }; }],
    [/^\s*ROLLBACK/i, () => {
      if (pendingDelete) { creatures.set(pendingDelete.id, pendingDelete.row); pendingDelete = null; }
      return { rows: [], rowCount: 0 };
    }],
    [/DELETE FROM world_creatures/i, (p) => {
      const id = p[0];
      if (!creatures.has(id)) return { rows: [], rowCount: 0 };
      const r = creatures.get(id);
      creatures.delete(id);
      pendingDelete = { id, row: r };
      return { rows: [{ ...r }], rowCount: 1 };
    }],
    ...progressionReadRoutes(row),
    // The award itself fails, mid-transaction -- this is what must trigger
    // the rollback, not a bad DELETE.
    [/^\s*UPDATE player_progression/i, () => { throw new Error('forced awardXp failure'); }],
  ]);

  await assert.rejects(
    commitCreatureDeath(pool, entry, 'c1', { rng: always, ttlMs: 1000, killerUserId: 'u3' }),
    /forced awardXp failure/,
  );

  assert.ok(
    creatures.has('c1'),
    'the DELETE must be rolled back -- the DB must never disagree with what the player received (nothing)',
  );

  // Finding 2: prove BEGIN/DELETE/ROLLBACK all landed on the CLIENT, not the
  // bare pool -- `pool.calls.length === 0` is the assertion the mutation
  // check below is aimed at (issuing the ROLLBACK on `pool` instead of
  // `client` would show up here, even though the in-memory `creatures` map
  // above happens to still look correct either way).
  assert.strictEqual(pool.calls.length, 0, 'nothing may be issued on the bare pool -- especially not the ROLLBACK');
  assert.strictEqual(pool.clients.length, 1);
  const client = pool.clients[0];
  assert.strictEqual(client.matching(/^\s*BEGIN/i).length, 1, 'BEGIN must land on the client');
  assert.strictEqual(client.matching(/DELETE FROM world_creatures/i).length, 1, 'the DELETE must land on the client');
  assert.strictEqual(client.matching(/^\s*ROLLBACK/i).length, 1, 'the ROLLBACK must land on the client');
  assert.strictEqual(client.matching(/^\s*COMMIT/i).length, 0, 'no COMMIT may follow a failed award');
  // Finding 3: the client must still be released on the error path (the
  // `finally { client.release(); }` branch), not just on success.
  assert.strictEqual(client.released, 1, 'the client must still be released on the error path');
});

// ---------------------------------------------------------------------------
// Part 2: the live session, through the real server (attachAuthority).
//
// applyDerivedStats and the socket push both live in server.js's
// onCreatureDeath, not in loot.js's commitCreatureDeath -- Part 1's direct
// calls above can never exercise them. These are the tests that boot the
// real WS server (mirrors authority_combat_integration.test.js's pattern).
// ---------------------------------------------------------------------------

const SECRET = 'test-secret-progression-kill-xp';
function token(u) { return jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' }); }
function bootWith(pool, opts = {}) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, {
      jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 10000, ...opts,
    });
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
// Finding 2 applies here too: `.connect()` now returns a distinct client
// object (its own call log, its own release counter) instead of literally
// `{ query: pool.query, release: () => {} }`. It still delegates to the
// SAME underlying `pool.query` closure for routing/state (the stateful
// player_progression row in fakeLevelUpPool below), so behavior is
// unchanged -- only connection identity is now real.
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

function fakeLevelUpPool() {
  const row = {
    user_id: '1', experience: 290, level: 2, stat_points: 0,
    // constitution 15 -> 10 above base -> maxHp 100 + 10*10 = 200 once
    // applyDerivedStats picks this row up. XP alone never changes this
    // column, so it is the same before and after the kill -- the tests
    // below force the LIVE player's maxHp/hp DOWN right after join
    // specifically to make the transition (or its absence) observable.
    strength: 5, dexterity: 5, constitution: 15, intelligence: 5, wisdom: 5, charisma: 5,
  };
  return withConnect({
    query: async (sql, params) => {
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
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
      // fields at all, so the live wolf this test drives resolves via the
      // faction fallback, never through this row. Kept genuinely distinct
      // from DEFAULT_BEHAVIOR (not the old byte-identical 400/800/charge/0/
      // 1/null) so a broken resolveBehavior mapping would show up here
      // instead of silently agreeing with its own fallback; resolveBehavior's
      // real field mapping is pinned in creature_behaviors_resolve.test.js,
      // and live wiring end-to-end in creature_mechanics_wiring.test.js.
      if (/FROM entity_types e[\s\S]*WHERE e\.is_creature/i.test(sql)) return { rows: [{
        id: 42, name: 'Wolf', color: '#c00', hp: 5, attack_element: 'physical',
        behavior_name: 'Line', attack_kind: 'melee', attack_range: 60, attack_cooldown: 1,
        projectile_speed: 0, projectile_radius: 0, aggro_radius: 444, leash_radius: 777,
        chase_style: 'skirmish', preferred_range: 111, move_speed_mult: 1.3, damage_override: 9,
      }] };
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
      if (/FROM player_items/i.test(sql)) return { rows: [] };
      if (/FROM player_equipment/i.test(sql)) return { rows: [] };
      if (/INSERT INTO player_items/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO player_equipment/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/DELETE FROM player_equipment/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO world_chunks/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM world_players WHERE/i.test(sql)) return { rows: [] }; // spawn = center 400,400
      if (/SELECT gold FROM users/i.test(sql)) return { rows: [{ gold: 0 }] };
      // Creature level 10 vs player level 2 -> diff 8 -> factor clamps at
      // XP_LEVEL_DIFF_MAX (2) -> amount = 10*10*2 = 200. 290+200=490 lands
      // inside level 3's own range (floor 300, next floor 600): one clean
      // level-up, not two, and not zero.
      if (/DELETE\s+FROM\s+world_creatures[\s\S]*RETURNING/i.test(sql)) {
        return { rows: [{ type: 'Wolf', x: 410, y: 400, level: 10 }], rowCount: 1 };
      }
      if (/DELETE FROM world_creatures/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/FROM creature_drops/i.test(sql)) return { rows: [] };
      if (/FROM world_creatures/i.test(sql)) {
        if (params[1] === 0) return { rows: [{ id: 'wolf1', type: 'Wolf', x: 410, y: 400, hp: 5, facing: 'S', color: '#c00' }] };
        return { rows: [] };
      }
      if (/UPDATE world_creatures/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
      if (/^\s*INSERT INTO player_progression/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/^\s*UPDATE player_progression/i.test(sql)) {
        row.experience = Number(params[1]); row.level = Number(params[2]); row.stat_points += Number(params[3]) || 0;
        return { rows: [{ ...row, experience: String(row.experience) }], rowCount: 1 };
      }
      if (/FROM player_progression/i.test(sql)) return { rows: [{ ...row, experience: String(row.experience) }], rowCount: 1 };
      return { rows: [] };
    },
  });
}

test('a level-up moves the LIVE player pools (maxHp up, hp by the delta, never healed to full) and pushes a progression message', async () => {
  const pool = fakeLevelUpPool();
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  // Force the LIVE session's pools BELOW what the stored progression
  // (constitution 15 -> maxHp 200) already implies. constitution never
  // changes from XP alone, so without this the "before" and "after" derived
  // bundles read by the kill would already be IDENTICAL -- this test could
  // then pass even with the applyDerivedStats call deleted outright, which
  // is exactly the defect this test exists to catch.
  const world = handle.worlds.get('w1').world;
  const player = world.getPlayer('1');
  player.maxHp = 100;
  player.hp = 60;

  let loaded = false;
  for (let i = 0; i < 20 && !loaded; i++) {
    const m = await nextMsg(ws, 'creatures');
    if (m.creatures.some((c) => c.id === 'wolf1')) loaded = true;
  }
  assert.ok(loaded, 'wolf loaded before attack');

  // Re-pin hp/maxHp right before the kill: the wolf is adjacent and hostile
  // (AGGRO_RADIUS 400 >> the ~30px gap here), so real contact damage can
  // land during the wait above and make the pre-kill hp otherwise
  // timing-dependent -- exactly the kind of flake this repo avoids elsewhere
  // (see authority_ratelimit's documented burst-window flake). Re-asserting
  // the fixture immediately before firing the attack keeps the expected
  // post-kill hp a fixed literal instead of a guess about tick timing.
  player.maxHp = 100;
  player.hp = 60;

  const progressionMsgP = nextMsg(ws, 'progression');
  ws.send(JSON.stringify({ type: 'attack' }));
  const prog = await progressionMsgP;

  assert.strictEqual(prog.leveledUp, true);
  assert.strictEqual(prog.newLevel, 3);
  assert.strictEqual(prog.awarded, 200);

  let raised = false;
  let state;
  for (let i = 0; i < 40 && !raised; i++) {
    state = await nextMsg(ws, 'state');
    const me = state.players.find((p) => p.id === '1');
    if (me && me.maxHp === 200) raised = true;
  }
  assert.ok(raised, 'live maxHp must move to 200 (base 100 + 10*10 from constitution 15)');
  const me = state.players.find((p) => p.id === '1');
  assert.strictEqual(me.hp, 160, 'hp must move by the +100 delta (60+100), not snap to the new max (200)');

  ws.close(); handle.close(); server.close();
});

// Finding 1: the p.hp > 0 guard (server.js, onCreatureDeath) had NO test --
// deleting or inverting it left the whole suite green. This is the one
// test in the file whose entire point is that guard.
//
// tickMs is set enormous (1 hour) so the tick loop's resolveDeaths() --
// the ONLY thing that would normally catch and respawn a player sitting at
// hp <= 0 -- never fires during the test. That reproduces, deterministically
// rather than by racing a real tick interval, the exact window the report
// identified as reachable: a PvP hit (world.attack()'s player-vs-player
// branch, which runs synchronously from the `attack` message handler and
// never calls resolveDeaths() itself) can drop a player to hp <= 0 and leave
// them there until the tick loop's own resolveDeaths() next runs. With
// ticks suppressed, that window is held open for the whole test.
//
// The creature is injected directly into the live CreatureSim
// (world.creatures.addCreatures) instead of waiting for a chunk-load
// broadcast, because with tickMs this large recomputeActive()/
// broadcastCreatures() (which normally load and announce it) never run --
// and none of that is needed anyway, since world.attack() reads the live
// creature sim directly.
test('a player mid-death (hp <= 0, awaiting resolveDeaths) is not revived by their own kill leveling them up', async () => {
  const pool = fakeLevelUpPool();
  const { url, handle, server } = await bootWith(pool, { tickMs: 3600000 });
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  const world = handle.worlds.get('w1').world;
  const player = world.getPlayer('1');
  world.creatures.addCreatures([{ id: 'wolf1', type: 'Wolf', x: 410, y: 400, hp: 5, facing: 'S', color: '#c00' }]);

  // Simulate the exact hazard from the report: a fatal hit landed on this
  // player between ticks, and resolveDeaths() has not run (and, with ticks
  // suppressed, never will during this test). constitution 15 (baked into
  // fakeLevelUpPool's row) derives maxHp 200; the LIVE session is forced to
  // 100 here so that, if the guard were gone, applyDerivedStats would both
  // raise maxHp to 200 AND clamp hp up to its floor of 1 -- incorrectly
  // reviving the player.
  player.maxHp = 100;
  player.hp = -5;

  const progressionMsgP = nextMsg(ws, 'progression');
  ws.send(JSON.stringify({ type: 'attack' }));
  const prog = await progressionMsgP;

  // Sanity: the kill and the DB-side award still happened -- this guard is
  // about the LIVE session only, never about refusing the award itself.
  assert.strictEqual(prog.leveledUp, true);
  assert.strictEqual(prog.newLevel, 3);
  assert.strictEqual(prog.awarded, 200);

  assert.strictEqual(player.hp, -5, 'a player mid-death must not be revived by their own kill leveling them up');
  assert.strictEqual(player.maxHp, 100, 'applyDerivedStats must not run at all while hp <= 0 -- maxHp must not move either');

  assert.strictEqual(pool.clients.length, 1);
  assert.strictEqual(pool.clients[0].released, 1, 'the client must still be released');

  ws.close(); handle.close(); server.close();
});

// ---------------------------------------------------------------------------
// Part 3: Finding 4 -- one real-Postgres test for the larger transaction.
//
// progression_store.test.js:194 already proves awardXp alone rolls back with
// its caller's transaction. Nothing yet proved it for the actual transaction
// commitCreatureDeath introduces: DELETE + progression read/write + drop
// INSERTs under one BEGIN/COMMIT. Part 1's "failed XP award rolls back"
// test above proves the CODE issues the right BEGIN/DELETE/ROLLBACK
// sequence against a mock; this test proves real Postgres actually honors
// that sequence -- the DELETE really is undone, not merely re-queued in a
// JS Map.
//
// Gated on TEST_DATABASE_URL alone, same skip-if-unreachable idiom as
// progression_store.test.js. Every row this test writes is one it creates
// itself (a throwaway user, world and creature, each tagged/timestamped),
// deleted unconditionally in a `finally`, scoped by the exact id captured
// at creation. Creating a real killable creature row requires a real world
// row for its FK (world_creatures.world_id -> worlds, NOT NULL) -- there is
// no existing seeded world safe to reuse here, so this test fabricates its
// own throwaway world (INSERT INTO worlds (name, seed) ...) rather than
// touching any seeded/shared map, and deletes it in the same `finally`
// (world_creatures.world_id is ON DELETE CASCADE, so deleting the world row
// alone also removes the creature row even if the test fails partway
// through).
// ---------------------------------------------------------------------------

const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://user:password@localhost:15432/game_db';

function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try { await pool.query('SELECT 1'); return pool; } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: err.message };
  }
}

function skipMsg(what) {
  return `NO DATABASE at ${DB_URL} -- ${what} is UNVERIFIED on this run`;
}

async function createTestUser(pool, tag) {
  const username = `progression-kill-xp-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id`,
    [username],
  );
  return r.rows[0].id;
}

// Wraps a REAL pg Pool so every statement except the XP award's own UPDATE
// runs for real against Postgres -- BEGIN, the DELETE, loadProgression's
// lazy INSERT + SELECT, and the eventual ROLLBACK are all genuine. Only
// `UPDATE player_progression` (awardXp's actual write) is intercepted and
// forced to throw, so "the award" specifically is what fails, matching the
// mock-based test above -- while everything else stays real.
function poolWithForcedAwardFailure(pgPool) {
  return {
    query: (sql, params) => pgPool.query(sql, params),
    connect: async () => {
      const real = await pgPool.connect();
      return {
        query: async (sql, params) => {
          if (/^\s*UPDATE player_progression/i.test(sql)) {
            throw new Error('forced awardXp failure (real DB)');
          }
          return real.query(sql, params);
        },
        release: (...args) => real.release(...args),
      };
    },
  };
}

test('a failed XP award rolls back the creature deletion -- against a real database', async (t) => {
  if (!requireTestDb(t, 'this test creates a throwaway world, creature and user, then forces a real award to fail mid-transaction')) return;
  const pgPool = await openPool();
  if (pgPool.unreachable) {
    const m = skipMsg('real-DB death-commit rollback');
    if (process.env.CI) assert.fail(m);
    t.skip(m);
    return;
  }

  let user;
  let worldId;
  let creatureId;
  try {
    user = await createTestUser(pgPool, 'rollback');
    const w = await pgPool.query(
      `INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id`,
      [`progression-kill-xp-test-world-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`],
    );
    worldId = w.rows[0].id;
    const c = await pgPool.query(
      `INSERT INTO world_creatures (world_id, type, x, y, level) VALUES ($1, 'TestWolf', 0, 0, 3) RETURNING id`,
      [worldId],
    );
    creatureId = c.rows[0].id;

    const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
    const entry = { worldId, world: new World(map, new Map(), null, 8), creatureTypeIds: new Map() };
    const pool = poolWithForcedAwardFailure(pgPool);

    await assert.rejects(
      commitCreatureDeath(pool, entry, creatureId, { killerUserId: user }),
      /forced awardXp failure/,
    );

    const stillThere = await pgPool.query('SELECT id FROM world_creatures WHERE id = $1', [creatureId]);
    assert.equal(stillThere.rows.length, 1, 'the DELETE must be rolled back against real Postgres -- the creature row must still exist');

    // loadProgression's lazy INSERT ran inside the SAME transaction as the
    // failed UPDATE, so a real rollback must undo BOTH -- not just leave
    // the row present-but-unmodified. Zero rows is the proof that nothing
    // XP-adjacent survived, matching progression_store.test.js's own
    // rolled-back-transaction assertion at line 194.
    const prog = await pgPool.query('SELECT count(*)::int AS n FROM player_progression WHERE user_id = $1', [user]);
    assert.equal(prog.rows[0].n, 0, 'no progression row (not even the lazy-created one) may survive a failed award');
  } finally {
    if (worldId != null) await pgPool.query('DELETE FROM worlds WHERE id = $1', [worldId]).catch(() => {}); // cascades to world_creatures
    if (user != null) await pgPool.query('DELETE FROM users WHERE id = $1', [user]).catch(() => {}); // cascades to player_progression, if any survived
    await pgPool.end().catch(() => {});
  }
});
