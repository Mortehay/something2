const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

// Harness follows authority_use_field_chest_integration.test.js exactly (same
// fakePool shape, same bootWith/nextMsg/connect helpers) -- that file is
// Task 4's own coverage of server.js's message-handler dispatch
// (`messageHandlers`), so `openchest` (this file's subject) reuses the same
// pattern rather than inventing a third parallel harness for the same
// surface.

const SECRET = 'test-secret';

function token(u) { return jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' }); }
function connect(url, uid) { return new WebSocket(`${url}?token=${encodeURIComponent(token(uid))}`); }
function bootWith(pool, opts = {}) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, {
      jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 100, ...opts,
    });
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

// The player is given a PERSISTED spawn point (world_players row) so its
// position is deterministic instead of depending on chooseSpawn's bounded-
// center math -- the chest is placed at/near this same point (or far away,
// for the "nothing in range" case) so proximity is exact rather than
// incidental.
const SPAWN = { x: 500, y: 500 };

// `chestSeed` seeds fetchChests' load-time row (world_chests WHERE world_id),
// which becomes the live-world's entry.chests[0] via mapChestRow. `state`/
// `guardAlive` are mutable closures so the SAME chest id can be read (SELECT
// ... FOR UPDATE), transitioned (UPDATE ... unlocked / CAS ... opened), and
// re-read across multiple `openchest` frames in one test, exactly like a
// real world_chests row would be.
//
// `extraChests` seeds ADDITIONAL fetchChests rows beyond chestSeed (so a
// test can have more than one live chest) and, when an entry has `due:
// true`, also makes it show up in respawnDueFieldChests' own due-chest read
// -- the plumbing the chest-respawn-sweep regression test below needs (two
// chests in one world: one opened via the real `openchest` WS flow, one
// reset by the real `_chestRespawnSweep` test seam, asserting the sweep
// never disturbs the first).
// `progressionAfter` overrides the row UPDATE player_progression returns
// (defaults to the fixed level:1/all-base-stat row every other test in this
// file relies on) -- the level-up/applyDerivedStats test below needs a
// non-base constitution here so entry.world.getPlayer(...).maxHp actually
// moves, proving world.applyDerivedStats really ran with THIS row rather
// than merely not crashing.
function makePool({
  chestSeed, guardAlive = false, extraChests = [], progressionAfter,
} = {}) {
  const calls = [];
  let chestState = chestSeed.state;
  const pool = {
    calls,
    matching(re) { return calls.filter((c) => re.test(c.sql)); },
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM worlds WHERE id/i.test(sql)) {
        return {
          rows: [{
            id: 'w1', seed: '1', chunk_size: 64, width: 10, height: 10,
            is_entry: null, entry_spawn: null, biomes: [], biome_cell: null,
            level_min: 1, level_max: 5,
          }],
        };
      }
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
      // Two answers this fixture predates, both from the player-characters
      // line of work that landed in parallel with chests (SOMET-260/271).
      // Unanswered, the join is REFUSED and the test hangs on
      // nextMsg('joined') rather than failing.
      if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]) || 1, entity_type_id: 1 }] };
      if (/FROM worlds w WHERE w\.id/i.test(sql)) return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      if (/FROM entity_types e[\s\S]*WHERE e\.is_creature/i.test(sql)) return { rows: [] };
      if (/FROM item_types/i.test(sql)) {
        return {
          rows: [
            { id: 1, name: 'dagger', category: 'weapon', stackable: false },
            { id: 2, name: 'loot_map', category: 'consumable', stackable: true },
          ],
        };
      }
      if (/^\s*INSERT INTO world_chunks/i.test(sql)) return { rows: [], rowCount: 0 };
      // Persisted spawn: loadSpawn's own read, distinct from fetchChests'
      // "WHERE world_id" read below.
      if (/SELECT x, y FROM world_players WHERE world_id/i.test(sql)) {
        return { rows: [{ x: SPAWN.x, y: SPAWN.y }] };
      }
      if (/SELECT x, y FROM player_binds/i.test(sql)) return { rows: [] };
      if (/^\s*INSERT INTO world_players/i.test(sql)) return { rows: [] };
      // The guard-alive count query (openChest's own read) -- checked BEFORE
      // the generic "FROM world_creatures" bbox-load fallback below, since
      // both patterns match that fallback's broader regex.
      if (/SELECT count\(\*\) .* FROM world_creatures/i.test(sql)) {
        return { rows: [{ count: guardAlive ? '1' : '0' }], rowCount: 1 };
      }
      // injectGuardIntoSim's per-id load (server.js) -- checked BEFORE the
      // generic bbox-load fallback below for the same reason as the count
      // query above (both match that fallback's broader regex). Returns one
      // full joined-shape row per requested id so entry.world.creatures
      // actually gains the freshly-respawned guard (the respawn-sweep
      // regression test below asserts on this).
      if (/WHERE wc\.id = ANY/i.test(sql)) {
        const ids = params[0] || [];
        return {
          rows: ids.map((id) => ({
            id, type: 'Wolf', x: SPAWN.x, y: SPAWN.y, hp: 30, facing: 'S',
            home_x: SPAWN.x, home_y: SPAWN.y, level: 5, damage: 5, blocks_portal_id: null,
            defense: 2, color: null, resistances: {}, faction: 'hostile', attack_element: 'physical',
            behavior_name: null,
          })),
          rowCount: ids.length,
        };
      }
      if (/FROM world_creatures/i.test(sql)) return { rows: [] }; // bbox load at world load
      if (/^\s*DELETE FROM world_items WHERE expires_at/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT.*FROM world_items/i.test(sql)) return { rows: [], rowCount: 0 }; // ground-item bbox load
      // fetchChests at world load: the seeded chest plus any extras.
      if (/FROM world_chests WHERE world_id/i.test(sql)) {
        return {
          rows: [
            {
              id: chestSeed.id, x: chestSeed.x, y: chestSeed.y, kind: chestSeed.kind,
              guard_entity_type_id: 1, guard_level: chestSeed.guardLevel,
              guard_creature_ids: chestSeed.guardCreatureIds, state: chestSeed.state,
              opened_at: null, respawn_at: null,
            },
            ...extraChests.map((c) => ({
              id: c.id, x: c.x, y: c.y, kind: c.kind,
              guard_entity_type_id: 1, guard_level: c.guardLevel,
              guard_creature_ids: c.guardCreatureIds, state: c.state,
              opened_at: null, respawn_at: null,
            })),
          ],
        };
      }
      // respawnDueFieldChests' own due-chest read (services/chests.js).
      if (/FROM world_chests WHERE kind = 'field' AND state = 'opened'/i.test(sql)) {
        return {
          rows: extraChests
            .filter((c) => c.due)
            .map((c) => ({
              id: c.id, world_id: 'w1', x: c.x, y: c.y, guard_entity_type_id: 1,
            })),
        };
      }
      // entity_types lookup by id -- used by both spawnFieldChest (a
      // different shape, `= ANY($1::text[])`) and respawnDueFieldChests
      // (`= $1`, this one). Checked before the generic catch-all below.
      if (/FROM entity_types WHERE id = \$1/i.test(sql)) {
        return { rows: [{ id: 1, name: 'Wolf', hp: 30, defense: 2, resistances: {} }], rowCount: 1 };
      }
      // respawnDueFieldChests' fresh-guard insert.
      if (/INSERT INTO world_creatures/i.test(sql)) return { rows: [{ id: 'respawned-guard-1' }], rowCount: 1 };
      // respawnDueFieldChests' own reset write.
      if (/UPDATE world_chests SET state = 'locked'/i.test(sql)) return { rows: [], rowCount: 1 };
      // openChest's own locked read.
      if (/FROM world_chests WHERE id = \$1 FOR UPDATE/i.test(sql)) {
        if (params[0] !== chestSeed.id) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            id: chestSeed.id, state: chestState, kind: chestSeed.kind,
            guard_creature_ids: chestSeed.guardCreatureIds, guard_level: chestSeed.guardLevel,
          }],
          rowCount: 1,
        };
      }
      if (/UPDATE world_chests SET state = 'unlocked' WHERE id = \$1/i.test(sql)) {
        chestState = 'unlocked';
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE world_chests SET state = 'opened'/i.test(sql)) {
        if (chestState !== 'unlocked') return { rows: [], rowCount: 0 };
        chestState = 'opened';
        return { rows: [{ id: chestSeed.id, opened_at: '2026-08-10T00:00:00.000Z' }], rowCount: 1 };
      }
      // Field-chest-only respawn timer (chestLoot.js's openChest, branching
      // on `kind`).
      if (/UPDATE world_chests SET respawn_at/i.test(sql)) {
        return { rows: [{ respawn_at: '2026-08-10T02:00:00.000Z' }], rowCount: 1 };
      }
      if (/FROM chest_loot/i.test(sql)) {
        return { rows: [{ item_type_id: 7, chance: '1', min_qty: 1, max_qty: 1 }], rowCount: 1 };
      }
      if (/INSERT INTO player_items/i.test(sql)) {
        return { rows: [{ id: 'pi1', item_type_id: 7, quantity: 1 }], rowCount: 1 };
      }
      if (/FROM player_progression/i.test(sql)) {
        return { rows: [{ level: 1, experience: 0 }], rowCount: 1 };
      }
      if (/UPDATE player_progression/i.test(sql)) {
        return {
          rows: [progressionAfter || {
            user_id: '1', experience: 50, level: 1, stat_points: 0,
            strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5,
          }],
          rowCount: 1,
        };
      }
      if (/^\s*SELECT id, item_type_id, quantity FROM player_items WHERE user_id/i.test(sql)) return { rows: [] };
      if (/FROM player_equipment WHERE user_id/i.test(sql)) return { rows: [] };
      if (/SELECT gold FROM users WHERE id/i.test(sql)) return { rows: [{ gold: 0 }] };
      return { rows: [] };
    },
  };
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  return pool;
}

async function joinAndGetPlayer(url) {
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  return ws;
}

test('openchest with no chest in range sends an error frame', async () => {
  const pool = makePool({
    chestSeed: {
      id: 'chest-1', x: 5000, y: 5000, kind: 'vault', state: 'locked', guardLevel: 5, guardCreatureIds: [],
    },
  });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  ws.send(JSON.stringify({ type: 'openchest' }));
  const err = await nextMsg(ws, 'error');
  assert.match(err.message, /no chest nearby/);
  assert.equal(handle.worlds.get('w1').chests[0].state, 'locked');

  ws.close(); handle.close(); server.close();
});

test('openchest against a chest with a live guard sends an error frame mentioning the guard', async () => {
  const pool = makePool({
    chestSeed: {
      id: 'chest-1', x: SPAWN.x, y: SPAWN.y, kind: 'vault', state: 'locked', guardLevel: 5, guardCreatureIds: ['guard-1'],
    },
    guardAlive: true,
  });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  ws.send(JSON.stringify({ type: 'openchest' }));
  const err = await nextMsg(ws, 'error');
  assert.match(err.message, /guard/i);
  assert.equal(handle.worlds.get('w1').chests[0].state, 'locked', 'a refused open must not flip the in-memory cache');

  ws.close(); handle.close(); server.close();
});

test('openchest against an unlocked chest in range sends chestOpened with items+XP, then a second attempt on the now-opened vault chest is refused', async () => {
  const pool = makePool({
    chestSeed: {
      id: 'chest-1', x: SPAWN.x, y: SPAWN.y, kind: 'vault', state: 'unlocked', guardLevel: 5, guardCreatureIds: [],
    },
  });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  ws.send(JSON.stringify({ type: 'openchest' }));
  const opened = await nextMsg(ws, 'chestOpened');
  assert.equal(opened.chestId, 'chest-1');
  // Final-review fix (SOMET-244 Important #2): the full inserted
  // player_items row, not a bare item_type_id -- see chestLoot.test.js.
  assert.deepEqual(opened.items, [{ id: 'pi1', item_type_id: 7, quantity: 1 }]);
  assert.ok(opened.awarded > 0, 'a guard-level-5 chest opened by a level-1 player must award positive XP');

  const entry = handle.worlds.get('w1');
  assert.equal(entry.chests.length, 1);
  assert.equal(entry.chests[0].state, 'opened', 'the in-memory cache must reflect the DB write openChest committed');
  assert.ok(entry.chests[0].openedAt, 'openedAt must be carried into the in-memory cache too, not just the DB row');
  assert.equal(entry.chests[0].respawnAt, null, 'a vault chest never gets a respawn timer');

  // Final-review fix (SOMET-244 Important #2): the granted item must land
  // on the player's IN-MEMORY inventory too, mirroring claimItem's own
  // pattern (loot.js:232) -- otherwise it cannot be equipped/dropped/sold
  // until the player reconnects and reloads their inventory from the DB.
  const p = entry.world.getPlayer('1');
  assert.ok(
    p.inv.items.some((it) => it.id === 'pi1' && it.typeId === 7 && it.quantity === 1),
    'the chest-granted item must be pushed onto p.inv.items, matching claimItem\'s {id, typeId, quantity} shape',
  );

  // A second attempt: nearestChest excludes an opened vault chest, so this
  // never even reaches openChest / the DB again.
  const insertCallsBefore = pool.matching(/INSERT INTO player_items/i).length;
  ws.send(JSON.stringify({ type: 'openchest' }));
  const err = await nextMsg(ws, 'error');
  assert.match(err.message, /no chest nearby/);
  assert.equal(pool.matching(/INSERT INTO player_items/i).length, insertCallsBefore, 'no second loot grant');

  ws.close(); handle.close(); server.close();
});

test('openchest against a field chest carries respawnAt into the in-memory cache, not just the DB row', async () => {
  const pool = makePool({
    chestSeed: {
      id: 'chest-1', x: SPAWN.x, y: SPAWN.y, kind: 'field', state: 'unlocked', guardLevel: 5, guardCreatureIds: [],
    },
  });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  ws.send(JSON.stringify({ type: 'openchest' }));
  const opened = await nextMsg(ws, 'chestOpened');
  assert.equal(opened.chestId, 'chest-1');

  const entry = handle.worlds.get('w1');
  assert.equal(entry.chests[0].state, 'opened');
  assert.ok(entry.chests[0].openedAt, 'openedAt must be carried into the in-memory cache');
  assert.ok(
    entry.chests[0].respawnAt,
    'a field chest open must carry respawnAt into the in-memory cache, or a chest the respawn sweep later relocks would look permanently opened to an already-connected player',
  );
  assert.ok(pool.matching(/UPDATE world_chests SET respawn_at/i).length > 0, 'field chest open must schedule a respawn in the DB');

  ws.close(); handle.close(); server.close();
});

// Regression test for a review finding on this task's own sweep wiring: an
// earlier version refreshed entry.chests by requerying and replacing the
// WHOLE array (`entry.chests = await fetchChests(...)`) whenever ANY chest
// in ANY loaded world reset. That full-array replace raced a concurrent
// openchest handler for an UNRELATED chest in the same world -- see this
// file's `chestRespawnSweep`/`respawnDueFieldChests` header comments for the
// exact race. The fix patches only the reset chest's own element in place
// (Object.assign, driven by respawnDueFieldChests' onReset), so this test
// proves BOTH that the due chest gets reset AND that an unrelated,
// just-opened chest's object is neither reverted nor reallocated.
test('the chest respawn sweep patches only the reset chest in place, leaving a concurrently-opened UNRELATED chest untouched', async () => {
  const pool = makePool({
    chestSeed: {
      id: 'chest-near', x: SPAWN.x, y: SPAWN.y, kind: 'field', state: 'unlocked', guardLevel: 5, guardCreatureIds: [],
    },
    extraChests: [
      {
        id: 'chest-far', x: 5000, y: 5000, kind: 'field', state: 'opened', guardLevel: 5, guardCreatureIds: [], due: true,
      },
    ],
  });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  // Open the near (in-range) field chest first -- nearestChest picks it
  // over the far, already-opened one regardless.
  ws.send(JSON.stringify({ type: 'openchest' }));
  const opened = await nextMsg(ws, 'chestOpened');
  assert.equal(opened.chestId, 'chest-near');

  const entry = handle.worlds.get('w1');
  const chestsArrayBefore = entry.chests;
  const near = entry.chests.find((c) => c.id === 'chest-near');
  const far = entry.chests.find((c) => c.id === 'chest-far');
  assert.equal(near.state, 'opened');
  assert.equal(far.state, 'opened', 'seeded as already-opened and past its respawn_at');

  // Drive one respawn sweep pass deterministically via the real server code
  // path (not a reimplementation): server.js's own _chestRespawnSweep.
  await handle._chestRespawnSweep();

  assert.equal(entry.chests, chestsArrayBefore, 'entry.chests must never be replaced wholesale by the sweep');
  assert.equal(entry.chests.find((c) => c.id === 'chest-near'), near, 'an unrelated chest object must not be reallocated');
  assert.equal(near.state, 'opened', 'an unrelated, just-opened chest must not be reverted by the sweep');
  assert.equal(far.state, 'locked', 'the due chest itself must be reset by the sweep, patched in place');
  assert.equal(far.openedAt, null);
  assert.equal(far.respawnAt, null);
  assert.deepEqual(far.guardCreatureIds, ['respawned-guard-1']);

  ws.close(); handle.close(); server.close();
});

// Final-review fix (SOMET-244 Critical #1), respawn-sweep half. The `use`
// handler's half of this same fix is covered in
// authority_use_field_chest_integration.test.js -- this proves the
// respawn sweep's freshly-INSERTed guard (world_creatures row
// 'respawned-guard-1' from the sweep above) actually lands in
// entry.world.creatures, not just the DB, once the sweep resolves. Before
// the fix, a chunk holding a player never unloads (every world in the live
// DB fits inside one player's 3x3 neighborhood), so activateChunk never
// re-fires to pick up this row -- the respawned guard stayed invisible and
// unkillable for the rest of the session.
test('the chest respawn sweep injects the freshly-respawned guard into entry.world.creatures, not just the DB', async () => {
  const pool = makePool({
    chestSeed: {
      id: 'chest-near', x: SPAWN.x, y: SPAWN.y, kind: 'field', state: 'unlocked', guardLevel: 5, guardCreatureIds: [],
    },
    extraChests: [
      {
        id: 'chest-far', x: 5000, y: 5000, kind: 'field', state: 'opened', guardLevel: 5, guardCreatureIds: [], due: true,
      },
    ],
  });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  const entry = handle.worlds.get('w1');
  assert.equal(entry.world.creatures.creatures.has('respawned-guard-1'), false, 'not present before the sweep');

  await handle._chestRespawnSweep();

  assert.equal(
    entry.world.creatures.creatures.has('respawned-guard-1'), true,
    'the respawn sweep must inject the new guard into the live sim, or openchest can never see it die',
  );

  ws.close(); handle.close(); server.close();
});

// Final-review fix (SOMET-244 Important #3). Mirrors the kill path's own
// coverage (progression_kill_xp.test.js) for the chest-open path: a
// level-up must both raise the running game's derived stats (maxHp here)
// AND push a `progression` frame, not just persist the new level to the
// DB. guardLevel 20 vs. a level-1 player guarantees xpForChest's XP-diff
// factor is capped at its max (guard 19+ levels above the player), so the
// single chest-open XP award crosses the level-2 (xp>=100) AND level-3
// (xp>=300) thresholds in one shot.
test('openchest applies derived stats and sends a progression frame on a level-up', async () => {
  const pool = makePool({
    chestSeed: {
      id: 'chest-1', x: SPAWN.x, y: SPAWN.y, kind: 'vault', state: 'unlocked', guardLevel: 20, guardCreatureIds: [],
    },
    progressionAfter: {
      user_id: '1', experience: 400, level: 3, stat_points: 6,
      strength: 5, dexterity: 5, constitution: 15, intelligence: 5, wisdom: 5, charisma: 5,
    },
  });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  const entry = handle.worlds.get('w1');
  const p = entry.world.getPlayer('1');
  assert.equal(p.maxHp, 100, 'sanity: a fresh level-1 player starts at base maxHp');

  // Both listeners registered BEFORE the triggering send: the handler emits
  // chestOpened and progression back-to-back with no await between them, so
  // awaiting nextMsg(ws, 'chestOpened') and only THEN calling nextMsg(ws,
  // 'progression') can miss the second frame if it already arrived (the
  // exact race progression_kill_xp.test.js's own harness avoids the same
  // way, at its line 439).
  const openedP = nextMsg(ws, 'chestOpened');
  const progressionMsgP = nextMsg(ws, 'progression');
  ws.send(JSON.stringify({ type: 'openchest' }));
  const opened = await openedP;
  assert.equal(opened.leveledUp, true, 'a guard 19 levels above a level-1 player must level them up');
  assert.equal(opened.newLevel, 3);

  const progressionMsg = await progressionMsgP;
  assert.equal(progressionMsg.leveledUp, true);
  assert.equal(progressionMsg.newLevel, 3);
  assert.equal(progressionMsg.awarded, opened.awarded);
  assert.equal(
    progressionMsg.progression.constitution, 15,
    'the progression frame must carry the same progression openChest/awardXp returned',
  );

  // The defect this fix closes: without calling world.applyDerivedStats,
  // maxHp would still read 100 here -- correct in the DB (constitution:
  // 15), invisible in the running game until reconnect.
  assert.equal(p.maxHp, 200, 'applyDerivedStats must raise the running player\'s maxHp on a chest-open level-up');

  ws.close(); handle.close(); server.close();
});
