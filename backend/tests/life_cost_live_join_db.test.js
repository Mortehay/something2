// SOMET-472 -- a REAL Cultist loses HP, a REAL Warrior loses mana.
//
// This file exists because this epic has now shipped SIX items whose pure
// function was tested and whose wiring was not, every one of them green. So
// nothing here is a stand-in: the authority is booted against the real pool,
// the join goes over a real websocket, the class comes from entity_types, the
// staff and its spell stone come from item_types, the life-cost multiplier
// comes from the seeded passive tree, and the attack is World.attack on the
// player object the join handler actually put in the world. The only stand-in
// is the JWT, which every authority test here signs itself.
//
// THE TRAP THIS FILE IS SHAPED AROUND. Since 1714440167000 a bare weapon's own
// item_types.mana_cost column is VESTIGIAL: activeWeaponType neutralises it to
// zero unless a spell stone is socketed. The Cultist's starting loadout is an
// unsocketed apprentice staff, so a Cultist who just rolled a character pays
// nothing for anything, and a test built on the starting loadout alone would
// have asserted "hp did not move" and called it a pass. Every cast below is
// through a staff with a real socketed spell stone.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');

const { attachAuthority } = require('../src/authority/server.js');
const { createCharacter, ownedCharacter } = require('../src/services/characters.js');
const { loadProgression } = require('../src/services/progressionStore.js');
const { socketStone } = require('../src/authority/items.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SECRET = 'somet472-test-secret';
const TAG = `s472_${process.pid}_${Date.now().toString(36)}`;

// The flame staff and its spell stone, both straight out of the seeded
// catalog. The stone's mana_cost is 18, and every HP figure below is written
// out by hand from that:
//
//   multiplier 1.0  ->  ceil(18 * 0.6 * 1.0)  = ceil(10.8) = 11
//   multiplier 0.9  ->  ceil(18 * 0.6 * 0.9)  = ceil(9.72) = 10
//
// The two differ, deliberately: at 8 mana (the apprentice staff) both round to
// 5 and the test could not tell whether the tree rule reached the gate at all.
const STAFF_NAME = 'flame staff';
const STONE_NAME = 'stone_of_flame staff';
const STONE_MANA_COST = 18;
const CULTIST_HP_PER_CAST = 10;      // with the start node's 0.9
const UNDISCOUNTED_HP_PER_CAST = 11; // what it would cost at multiplier 1

function nextMsg(ws, type, ms = 15000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (m.type === 'error') {
        clearTimeout(to); ws.off('message', onMsg); reject(new Error(`server error: ${m.message}`));
      } else if (!type || m.type === type) {
        clearTimeout(to); ws.off('message', onMsg); resolve(m);
      }
    });
  });
}

test('a Cultist casts with life and a Warrior casts with mana', { skip: !DB_URL ? 'no database URL' : false }, async (t) => {
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
  // Registered BEFORE anything creates a row, and it deletes the rows before
  // it ends the pool: an end-first hook silently no-ops its own cleanup and
  // leaks fixtures into unrelated files.
  t.after(async () => {
    for (const ws of sockets) { try { ws.terminate(); } catch { /* already gone */ } }
    handle.close();
    if (server.listening) await new Promise((r) => server.close(r));
    if (userIds.length) {
      // player_items, player_equipment, stone_instances, characters and
      // player_progression all cascade off the user row.
      await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]).catch(() => {});
    }
    await pool.end().catch(() => {});
  });

  const entry = await pool.query('SELECT id FROM worlds WHERE is_entry = true LIMIT 1');
  assert.equal(entry.rows.length, 1, 'the database needs a seeded entry world');
  const entryWorldId = entry.rows[0].id;

  const types = await pool.query(
    'SELECT id, name, mana_cost FROM item_types WHERE name = ANY($1::text[])',
    [[STAFF_NAME, STONE_NAME]]);
  const typeByName = new Map(types.rows.map((r) => [r.name, r]));
  assert.ok(typeByName.get(STAFF_NAME), `the catalog needs a ${STAFF_NAME}`);
  assert.ok(typeByName.get(STONE_NAME), `the catalog needs a ${STONE_NAME}`);
  assert.equal(Number(typeByName.get(STONE_NAME).mana_cost), STONE_MANA_COST,
    'the HP literals below are computed from this exact mana cost');

  const classes = await pool.query(
    "SELECT id, name FROM entity_types WHERE name IN ('Cultist', 'Warrior')");
  const classIdByName = new Map(classes.rows.map((r) => [r.name, r.id]));
  assert.equal(classIdByName.size, 2, 'the database needs both Cultist and Warrior');

  // Joins for real, then arms the joined player with the socketed staff
  // through items.js's own socketStone and World.setEquipment -- the same two
  // calls the websocket `socket` and `equip` handlers make.
  let seq = 0;
  async function joinArmed(className, progressionPatch = null) {
    // Suffixed: this file joins as a Cultist TWICE (base CON and raised CON),
    // and users.username is unique.
    const who = `${TAG}_${className}_${seq++}`.toLowerCase();
    const u = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id",
      [who]);
    const userId = u.rows[0].id;
    userIds.push(userId);

    const character = await createCharacter(
      pool, userId, `${TAG}${className}${seq}`, classIdByName.get(className));

    if (progressionPatch) {
      await pool.query(
        `INSERT INTO player_progression (character_id, constitution)
         VALUES ($1, $2)
         ON CONFLICT (character_id) DO UPDATE SET constitution = EXCLUDED.constitution`,
        [character.id, progressionPatch.constitution]);
    }

    const staff = await pool.query(
      'INSERT INTO player_items (character_id, item_type_id) VALUES ($1, $2) RETURNING id',
      [character.id, typeByName.get(STAFF_NAME).id]);
    const stone = await pool.query(
      'INSERT INTO player_items (character_id, item_type_id) VALUES ($1, $2) RETURNING id',
      [character.id, typeByName.get(STONE_NAME).id]);
    await pool.query('INSERT INTO stone_instances (player_item_id) VALUES ($1)', [stone.rows[0].id]);

    const token = jwt.sign({ user_id: userId, tv: 1 }, SECRET, { algorithm: 'HS256' });
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    sockets.push(ws);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.send(JSON.stringify({ type: 'join', character_id: character.id, world_id: entryWorldId }));
    const joined = await nextMsg(ws, 'joined');

    const world = handle.worlds.get(entryWorldId).world;
    const player = world.getPlayer(String(userId));
    assert.ok(player, `${className} must actually be in the world after joining`);

    const socketed = await socketStone(
      pool, character.id, player.inv, stone.rows[0].id, staff.rows[0].id, world.weapons);
    assert.equal(socketed.ok, true, `socketing the spell stone failed: ${socketed.reason}`);
    const equipped = await world.setEquipment(pool, String(userId), staff.rows[0].id, 'main_hand');
    assert.equal(equipped.ok, true, `equipping the staff failed: ${equipped.reason}`);

    return {
      userId, characterId: character.id, world, player, joined, ws,
    };
  }

  // Fires once and returns what the cast actually cost. `_attackCd` is cleared
  // first so a repeat cast is about cost, not about the cooldown.
  function castOnce(ctx) {
    ctx.player._attackCd = 0;
    const hpBefore = ctx.player.hp;
    const manaBefore = ctx.player.mana;
    const projectilesBefore = ctx.world.projectiles.count();
    ctx.world.attack(String(ctx.userId), 1, 0);
    return {
      hpSpent: hpBefore - ctx.player.hp,
      manaSpent: manaBefore - ctx.player.mana,
      fired: ctx.world.projectiles.count() > projectilesBefore,
    };
  }

  let cultist = null;
  let warrior = null;

  await t.test('the join frame tells the client the Cultist spends life', async () => {
    cultist = await joinArmed('Cultist');
    // The WIRE, not an internal. Without this the client would keep drawing a
    // mana orb that never moves.
    assert.equal(cultist.joined.usesLifeCost, true);
    // And the sim agrees with the wire, from the same one derivation.
    assert.equal(cultist.player.usesLifeCost, true);

    const character = await ownedCharacter(pool, cultist.userId, cultist.characterId);
    assert.equal(character.className, 'Cultist',
      'the join keys life-cost off this exact string');
  });

  await t.test('the Cultist start node grants lifeCostMultiplier 0.9 through composeStats', async () => {
    // The multiplier has to arrive by the composed-rules route, not a literal.
    // The start node costs no point and is NOT in character_passives, so this
    // is exactly the grant that was dead data before SOMET-472.
    const progression = await loadProgression(pool, cultist.characterId);
    assert.equal(progression.rules.lifeCostMultiplier, 0.9);
    assert.deepEqual(progression.allocatedNodeIds, [],
      'the start node is granted, never allocated -- it must not appear as a spent point');
    // And it is on the bundle the world is actually living with.
    assert.equal(cultist.player.stats.lifeCostMultiplier, 0.9);
  });

  await t.test('a real Cultist attack spends HP and no mana', () => {
    const before = { hp: cultist.player.hp, mana: cultist.player.mana };
    const cast = castOnce(cultist);
    assert.equal(cast.fired, true, 'the cast must actually go off');
    assert.equal(cast.hpSpent, CULTIST_HP_PER_CAST,
      `a Cultist pays ${CULTIST_HP_PER_CAST} hp for an 18-mana spell at the start node's 0.9`);
    assert.equal(cast.manaSpent, 0, 'a Cultist never spends mana');
    assert.equal(cultist.player.hp, before.hp - CULTIST_HP_PER_CAST);
    assert.equal(cultist.player.mana, before.mana);
    // The discount is real: without the tree rule this would be 11.
    assert.notEqual(CULTIST_HP_PER_CAST, UNDISCOUNTED_HP_PER_CAST);
  });

  await t.test('a real Warrior with the identical staff spends mana and no HP', async () => {
    warrior = await joinArmed('Warrior');
    assert.equal(warrior.joined.usesLifeCost, false);
    assert.equal(warrior.player.usesLifeCost, false);

    const before = { hp: warrior.player.hp, mana: warrior.player.mana };
    const cast = castOnce(warrior);
    assert.equal(cast.fired, true);
    assert.equal(cast.manaSpent, 18, 'the stone costs 18 mana and a Warrior pays it in mana');
    assert.equal(cast.hpSpent, 0, 'a mana caster must not lose hp to its own spell');
    assert.equal(warrior.player.hp, before.hp, 'a Warrior joins and stays at full hp');
    assert.equal(warrior.player.mana, before.mana - 18);
  });

  await t.test('a Cultist near death is REFUSED, not killed, and the refusal is free', () => {
    // 10 hp against a 10 hp cost would land them on 0. Spec 8.3 refuses it.
    cultist.player.hp = 10;
    const before = {
      hp: cultist.player.hp, mana: cultist.player.mana, stamina: cultist.player.stamina,
    };
    const cast = castOnce(cultist);
    assert.equal(cast.fired, false, 'a refused cast must not put a projectile in the air');
    assert.equal(cultist.player.hp, before.hp, 'not one point of hp');
    assert.equal(cultist.player.mana, before.mana);
    assert.equal(cultist.player.stamina, before.stamina);
    assert.equal(cultist.player._attackCd, 0, 'and the cooldown is not consumed either');
    assert.ok(cultist.player.hp > 0, 'the Cultist is alive: the cast was refused, not lethal');

    // One more hp and it goes off, landing on exactly 1.
    cultist.player.hp = 11;
    const ok = castOnce(cultist);
    assert.equal(ok.fired, true);
    assert.equal(cultist.player.hp, 1);
  });

  // AC4. There is no second cost formula for CON -- CON raises max HP, and max
  // HP is the pool the cost comes out of, so more CON is strictly more casts.
  await t.test('raising CON raises the castable resource, with no separate formula', async () => {
    // 12 CON is 7 above BASE_STAT(5), and HP_PER_CON is 10, so a Cultist's
    // 110 base becomes 110 + 70 = 180. Written out, not computed.
    const tanky = await joinArmed('Cultist', { constitution: 12 });
    assert.equal(tanky.player.maxHp, 180);
    assert.equal(tanky.player.hp, 180);

    // The COST is unchanged -- it is a function of the spell and the tree, not
    // of CON. That is the whole point: one formula, not two.
    const cast = castOnce(tanky);
    assert.equal(cast.hpSpent, CULTIST_HP_PER_CAST);

    // So the resource simply goes further. floor((180 - 1) / 10) = 17 casts
    // against floor((110 - 1) / 10) = 10 for the base-CON Cultist.
    const castsAt180 = Math.floor((180 - 1) / CULTIST_HP_PER_CAST);
    const castsAt110 = Math.floor((110 - 1) / CULTIST_HP_PER_CAST);
    assert.equal(castsAt180, 17);
    assert.equal(castsAt110, 10);
    assert.ok(castsAt180 > castsAt110);
  });
});
