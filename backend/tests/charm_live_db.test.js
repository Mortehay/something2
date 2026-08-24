// SOMET-473 -- a REAL Druid charms a REAL creature over a REAL socket.
//
// This file exists because this epic has now shipped SEVEN items whose pure
// function was tested and whose wiring was not, every one of them green. So
// nothing here is a stand-in: the authority is booted against the real pool,
// the join goes over a real websocket, the class comes from entity_types, the
// charisma and the treeCharmBonus come from the seeded passive tree through
// loadProgression's own composition, the creature is a real world_creatures
// row, and the pet's behaviour is observed by running the AUTHORITY TICK.
// charmBudget() in isolation proves nothing about any of that.
//
// The only stand-in is the JWT, which every authority test here signs itself.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');

const { attachAuthority } = require('../src/authority/server.js');
const { createCharacter } = require('../src/services/characters.js');
const { loadProgression } = require('../src/services/progressionStore.js');
const { charmBudget } = require('../src/services/charm.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SECRET = 'somet473-test-secret';
const TAG = `s473_${process.pid}_${Date.now().toString(36)}`;

function nextMsg(ws, type, ms = 15000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (!type || m.type === type) {
        clearTimeout(to); ws.off('message', onMsg); resolve(m);
      }
    });
  });
}

test('a real Druid charms a real creature', { skip: !DB_URL ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000, max: 6 });
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    await pool.end().catch(() => {});
    // Loud, not silent. A skipped run of this file verifies nothing, and this
    // is the file that proves the feature is not inert.
    throw new Error(`database unreachable, so nothing here was verified: ${err.message}`);
  }

  const server = http.createServer();
  const handle = attachAuthority(server, pool, { jwtSecret: SECRET, tickMs: 50 });
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/authority`;

  const sockets = [];
  const userIds = [];
  const creatureIds = [];
  // Registered BEFORE anything creates a row, and it deletes the rows before it
  // ends the pool: an end-first hook silently no-ops its own cleanup and leaks
  // fixtures into unrelated files.
  t.after(async () => {
    for (const ws of sockets) { try { ws.terminate(); } catch { /* already gone */ } }
    handle.close();
    if (server.listening) await new Promise((r) => server.close(r));
    if (creatureIds.length) {
      await pool.query('DELETE FROM world_creatures WHERE id = ANY($1::uuid[])', [creatureIds])
        .catch(() => {});
    }
    if (userIds.length) {
      // characters, player_progression, character_summons and the rest all
      // cascade off the user row.
      await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]).catch(() => {});
    }
    await pool.end().catch(() => {});
  });

  const entry = await pool.query('SELECT id FROM worlds WHERE is_entry = true LIMIT 1');
  assert.equal(entry.rows.length, 1, 'the database needs a seeded entry world');
  const entryWorldId = entry.rows[0].id;

  const classes = await pool.query(
    "SELECT id, name FROM entity_types WHERE name IN ('Druid', 'Warrior')");
  const classIdByName = new Map(classes.rows.map((r) => [r.name, r.id]));
  assert.equal(classIdByName.size, 2, 'the database needs both Druid and Warrior');

  // A hostile creature TYPE that really exists in the catalog, so the joined
  // load resolves a colour, a faction and a behaviour rather than falling back.
  const wolf = await pool.query(
    "SELECT name FROM entity_types WHERE is_creature = true AND faction = 'hostile' ORDER BY name LIMIT 1");
  assert.equal(wolf.rows.length, 1, 'the catalog needs at least one hostile creature type');
  const CREATURE_TYPE = wolf.rows[0].name;

  let seq = 0;
  async function join(className, { charisma = null } = {}) {
    const who = `${TAG}_${className}_${seq++}`.toLowerCase();
    const u = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id", [who]);
    const userId = u.rows[0].id;
    userIds.push(userId);
    const character = await createCharacter(
      pool, userId, `${TAG}${className}${seq}`, classIdByName.get(className));
    if (charisma != null) {
      await pool.query(
        `INSERT INTO player_progression (character_id, charisma) VALUES ($1, $2)
         ON CONFLICT (character_id) DO UPDATE SET charisma = EXCLUDED.charisma`,
        [character.id, charisma]);
    }
    const token = jwt.sign({ user_id: userId, tv: 1 }, SECRET, { algorithm: 'HS256' });
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    sockets.push(ws);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.send(JSON.stringify({ type: 'join', character_id: character.id, world_id: entryWorldId }));
    await nextMsg(ws, 'joined');
    const world = handle.worlds.get(entryWorldId).world;
    const player = world.getPlayer(String(userId));
    assert.ok(player, `${className} must actually be in the world after joining`);
    return { userId, characterId: character.id, world, player, ws };
  }

  // A creature standing next to `player`, inserted into the DB and injected
  // into the live sim the same way a mid-session spawn is.
  async function spawnBeside(player, world, { dx = 60, dy = 0, level = 3 } = {}) {
    const r = await pool.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, level, damage)
       VALUES ($1, $2, $3, $4, 40, $5, 4) RETURNING id`,
      [entryWorldId, CREATURE_TYPE, player.x + dx, player.y + dy, level]);
    const id = r.rows[0].id;
    creatureIds.push(id);
    world.creatures.addCreatures([{
      id, type: CREATURE_TYPE, x: player.x + dx, y: player.y + dy, hp: 40,
      level, damage: 4, facing: 'S', color: '#c00', faction: 'hostile',
    }]);
    return id;
  }

  let druid = null;

  await t.test('the Druid start node grants treeCharmBonus +1 through composeStats', async () => {
    druid = await join('Druid', { charisma: 12 });
    const progression = await loadProgression(pool, druid.characterId);
    // The grant has to arrive by the COMPOSED-rules route. The start node costs
    // no point and is not in character_passives, so this is exactly the class
    // of grant that was dead data before SOMET-472.
    assert.equal(progression.rules.treeCharmBonus, 1,
      'the Druid start node must reach composeStats; a 0 here means the grant is dead again');
    assert.deepEqual(progression.allocatedNodeIds, [],
      'the start node is granted, never allocated -- it must not appear as a spent point');
    // And that is what the budget is built from: 12 CHA -> 6, plus the tree's 1.
    assert.equal(progression.charisma, 12);
    assert.equal(charmBudget(progression.charisma, progression.rules.treeCharmBonus), 7);
  });

  await t.test('a Warrior is refused outright', async () => {
    const warrior = await join('Warrior');
    const id = await spawnBeside(warrior.player, warrior.world);
    warrior.ws.send(JSON.stringify({ type: 'charm', creature_id: id }));
    const err = await nextMsg(warrior.ws, 'error');
    assert.match(err.message, /Only a Druid can charm/);
    assert.equal(warrior.world.creatures.get(id).faction, 'hostile');
  });

  let petId = null;

  await t.test('the charm lands, flips the faction and persists both columns', async () => {
    petId = await spawnBeside(druid.player, druid.world, { level: 3 });
    druid.ws.send(JSON.stringify({ type: 'charm', creature_id: petId }));
    const ok = await nextMsg(druid.ws, 'charmed');
    assert.equal(ok.creatureId, petId);

    const pet = druid.world.creatures.get(petId);
    assert.equal(pet.faction, 'charmed');
    assert.equal(pet.charmOwnerUserId, String(druid.userId));
    assert.equal(pet.charmedByCharacterId, druid.characterId);

    const row = await pool.query(
      'SELECT charmed_by_character_id, charm_expires_at FROM world_creatures WHERE id = $1',
      [petId]);
    assert.equal(row.rows[0].charmed_by_character_id, druid.characterId);
    assert.ok(row.rows[0].charm_expires_at > new Date(),
      'a 120s charm must be persisted with a future expiry, not a null or a past one');

    const roster = await pool.query(
      'SELECT creature_type, level FROM character_summons WHERE character_id = $1',
      [druid.characterId]);
    assert.deepEqual(roster.rows, [{ creature_type: CREATURE_TYPE, level: 3 }]);
  });

  await t.test('the pet actually follows its druid when the REAL tick runs', async () => {
    const pet = druid.world.creatures.get(petId);
    // Well beyond CHARM_FOLLOW_RANGE (120), and beyond a hostile's own aggro
    // too, so "it moved toward the player" cannot be ordinary chasing.
    pet.x = druid.player.x + 600;
    pet.y = druid.player.y;
    const before = pet.x;
    // The authority's own loop, over the authority's OWN active chunk set --
    // not creatures.tick() with a hand-rolled key list. This is the exact call
    // server.js makes 20 times a second.
    const entryRec = handle.worlds.get(entryWorldId);
    // The server populates activeChunks from its own loop; an empty set makes
    // tickCreatures skip EVERY creature, which is a silent green-looking pass
    // waiting to happen. Wait for the real set rather than inventing one.
    for (let i = 0; i < 100 && entryRec.activeChunks.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(entryRec.activeChunks.size > 0,
      'the authority never activated a chunk, so nothing below would have ticked');
    for (let i = 0; i < 10; i++) druid.world.tickCreatures(0.05, entryRec.activeChunks);
    const after = druid.world.creatures.get(petId);
    assert.ok(after.x < before, 'a pet closes on its druid across real authority ticks');
    assert.equal(after.mode, 'follow');
    assert.equal(after._targetKind, null, 'and never acquires its own druid as a target');
  });

  await t.test('a second charm past the budget is refused BY LEVEL SUM', async () => {
    // Budget is 7 (12 CHA -> 6, +1 from the tree) and a level-3 pet is already
    // held, leaving 4. A level-5 candidate is one the COUNT rule would have
    // allowed (two pets is not many) and the SUM rule refuses.
    const big = await spawnBeside(druid.player, druid.world, { dx: 70, level: 5 });
    druid.ws.send(JSON.stringify({ type: 'charm', creature_id: big }));
    const err = await nextMsg(druid.ws, 'error');
    assert.match(err.message, /Charm refused: over_budget/);
    assert.equal(druid.world.creatures.get(big).faction, 'hostile');

    // ...and one that fits is accepted, so the refusal above is the budget and
    // not a blanket "one pet only".
    const small = await spawnBeside(druid.player, druid.world, { dx: 80, level: 4 });
    druid.ws.send(JSON.stringify({ type: 'charm', creature_id: small }));
    const ok = await nextMsg(druid.ws, 'charmed');
    assert.equal(ok.creatureId, small);
    assert.equal(druid.world.creatures.get(small).faction, 'charmed');

    // Now 3 + 4 = 7 is spent exactly, and even a level-1 creature is refused.
    const tiny = await spawnBeside(druid.player, druid.world, { dx: 90, level: 1 });
    druid.ws.send(JSON.stringify({ type: 'charm', creature_id: tiny }));
    const err2 = await nextMsg(druid.ws, 'error');
    assert.match(err2.message, /Charm refused: over_budget/);
  });

  await t.test('a charm out of range is silently ignored', async () => {
    const far = await spawnBeside(druid.player, druid.world, { dx: 4000, level: 1 });
    druid.ws.send(JSON.stringify({ type: 'charm', creature_id: far }));
    // No reply of any kind: race a round-trip that WOULD produce one against it.
    druid.ws.send(JSON.stringify({ type: 'charm', creature_id: 'not-a-real-id' }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(druid.world.creatures.get(far).faction, 'hostile');
    const row = await pool.query(
      'SELECT charmed_by_character_id FROM world_creatures WHERE id = $1', [far]);
    assert.equal(row.rows[0].charmed_by_character_id, null,
      'a refused charm must write nothing');
  });

  await t.test('a persisted charm survives a reload of the same creature', async () => {
    // Drop it out of the sim and let the loader put it back -- the path a chunk
    // reload takes. Without the two columns in CREATURE_JOINED_SELECT (and the
    // characters join that turns a characterId into a userId) it comes back
    // hostile and turns on its owner, with every unit test still green.
    druid.world.creatures.creatures.delete(petId);
    assert.equal(druid.world.creatures.get(petId), undefined);
    await handle._reloadCreatures(handle.worlds.get(entryWorldId), [petId]);
    const back = druid.world.creatures.get(petId);
    assert.ok(back, 'the loader must return the creature');
    assert.equal(back.faction, 'charmed', 'and it must come back as a pet, not as a hostile');
    assert.equal(back.charmOwnerUserId, String(druid.userId),
      'as a STRING userId -- a numeric characterId here matches no player and releases on tick 1');
    assert.ok(back.charmExpiresAt > druid.world.now,
      'with the persisted expiry converted into world-clock ms, not left as an epoch timestamp');
  });
});
