const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
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

// Routes queries by SQL pattern and records every call. `.connect()` proxies
// to the same routed query fn -- commitCreatureDeath now runs the DELETE,
// the XP award and the drop roll inside one client-owned transaction, so
// every caller needs a checked-out "client", not just a bare pool (mirrors
// authorityLoot.test.js's own scriptedPool, updated the same way).
function scriptedPool(routes = []) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    for (const [re, result] of routes) {
      if (re.test(sql)) return typeof result === 'function' ? result(params) : result;
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    calls,
    matching(re) { return calls.filter((c) => re.test(c.sql)); },
    query,
    connect: async () => ({ query, release: () => {} }),
  };
}

function armEntry() {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  return {
    worldId: 'w1',
    world: new World(map, new Map(), null, 8),
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
});

test('a second commit of the same creature id awards nothing and returns null', async () => {
  const entry = armEntry();
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
  assert.strictEqual(
    pool.matching(/^\s*UPDATE player_progression/i).length, 1,
    'only the first commit may ever write XP',
  );
});

test('a failed XP award rolls back the creature deletion', async () => {
  const entry = armEntry();
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
  assert.strictEqual(pool.matching(/^\s*ROLLBACK/i).length, 1, 'a ROLLBACK must actually be issued');
  assert.strictEqual(pool.matching(/^\s*COMMIT/i).length, 0, 'no COMMIT may follow a failed award');
});

// ---------------------------------------------------------------------------
// Part 2: the live session, through the real server (attachAuthority).
//
// applyDerivedStats and the socket push both live in server.js's
// onCreatureDeath, not in loot.js's commitCreatureDeath -- Part 1's direct
// calls above can never exercise them. This is the one test that boots the
// real WS server (mirrors authority_combat_integration.test.js's pattern).
// ---------------------------------------------------------------------------

const SECRET = 'test-secret-progression-kill-xp';
function token(u) { return jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' }); }
function bootWith(pool) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, {
      jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 10000,
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
function withConnect(pool) {
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  return pool;
}

function fakeLevelUpPool() {
  const row = {
    user_id: '1', experience: 290, level: 2, stat_points: 0,
    // constitution 15 -> 10 above base -> maxHp 100 + 10*10 = 200 once
    // applyDerivedStats picks this row up. XP alone never changes this
    // column, so it is the same before and after the kill -- the test body
    // forces the LIVE player's maxHp/hp DOWN right after join specifically
    // to make the transition observable (see its own comment for why that
    // divergence is necessary, not just convenient).
    strength: 5, dexterity: 5, constitution: 15, intelligence: 5, wisdom: 5, charisma: 5,
  };
  return withConnect({
    query: async (sql, params) => {
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      if (/FROM entity_types WHERE is_creature/i.test(sql)) return { rows: [{ id: 42, name: 'Wolf', color: '#c00', hp: 5 }] };
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
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
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
