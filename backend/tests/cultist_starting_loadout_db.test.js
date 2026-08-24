// SOMET-492 -- a character that was ONLY ever created, never armed by hand.
//
// WHAT MAKES THIS FILE DIFFERENT FROM life_cost_live_join_db.test.js. That file
// proves the life-cost MECHANIC works, and to do so it hand-builds a loadout
// the game does not hand anybody: it inserts a flame staff and a spell stone
// straight into player_items, calls socketStone itself, and calls setEquipment
// itself. Its own header says why -- a test built on the starting loadout alone
// "would have asserted 'hp did not move' and called it a pass".
//
// This file asserts exactly that starting loadout. Nothing below inserts an
// item, sockets a stone or equips anything. A user row and createCharacter are
// the whole setup; every item, every socket and every equipped slot comes from
// grantStartingLoadout running inside the real websocket join handler. If the
// loadout content regresses, or the grant stops wearing what it grants, the
// numbers here go to zero and this file goes red.
//
// THE NUMBERS, WORKED OUT BY HAND FROM THE CATALOG (asserted against the live
// rows below, so a catalog change breaks the arithmetic loudly rather than
// silently agreeing with itself):
//
//   apprentice staff          mana_cost 8   (the host weapon)
//   stone_of_apprentice staff mana_cost 8   (copied by 1714440167000)
//   Cultist start node        lifeCostMultiplier 0.9
//
//   lifeCostFor(8, 0.9) = ceil(8 * 0.6 * 0.9) = ceil(4.32) = 5 hp per cast
//
// assert.strictEqual throughout, never assert.equal: `12 == '12'` is true, and
// a pg numeric arriving as a string has passed a loose assertion in this epic
// before.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');

const { attachAuthority } = require('../src/authority/server.js');
const { createCharacter } = require('../src/services/characters.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SECRET = 'somet492-test-secret';
const TAG = `s492_${process.pid}_${Date.now().toString(36)}`;

const STAFF_NAME = 'apprentice staff';
const STONE_NAME = 'stone_of_apprentice staff';
const STONE_MANA_COST = 8;
const CULTIST_HP_PER_CAST = 5;

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

test('a Cultist that was only ever CREATED pays life to cast', { skip: !DB_URL ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000, max: 6 });
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    await pool.end().catch(() => {});
    // Loud, not silent: a skipped run of this file verifies nothing, and this
    // is the file that proves the fix is not inert.
    throw new Error(`database unreachable, so nothing here was verified: ${err.message}`);
  }

  const server = http.createServer();
  const handle = attachAuthority(server, pool, { jwtSecret: SECRET, tickMs: 50 });
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/authority`;

  const sockets = [];
  const userIds = [];
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
  assert.strictEqual(entry.rows.length, 1, 'the database needs a seeded entry world');
  const entryWorldId = entry.rows[0].id;

  const stoneType = await pool.query(
    'SELECT mana_cost FROM item_types WHERE name = $1 AND category = $2', [STONE_NAME, 'stone']);
  assert.strictEqual(stoneType.rows.length, 1, `the catalog needs a ${STONE_NAME}`);
  assert.strictEqual(Number(stoneType.rows[0].mana_cost), STONE_MANA_COST,
    'the HP literals in this file are computed from this exact mana cost');

  const classes = await pool.query(
    "SELECT id, name FROM entity_types WHERE name IN ('Cultist', 'Warrior')");
  const classIdByName = new Map(classes.rows.map((r) => [r.name, r.id]));
  assert.strictEqual(classIdByName.size, 2, 'the database needs both Cultist and Warrior');

  // The ONLY setup: a user, a character, a join. No item insert, no socket, no
  // equip -- that is the whole point of this file.
  let seq = 0;
  async function createAndJoin(className) {
    const who = `${TAG}_${className}_${seq++}`.toLowerCase();
    const u = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id", [who]);
    const userId = u.rows[0].id;
    userIds.push(userId);

    const character = await createCharacter(
      pool, userId, `${TAG}${className}${seq}`, classIdByName.get(className));

    const token = jwt.sign({ user_id: userId, tv: 1 }, SECRET, { algorithm: 'HS256' });
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    sockets.push(ws);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.send(JSON.stringify({ type: 'join', character_id: character.id, world_id: entryWorldId }));
    const joined = await nextMsg(ws, 'joined');

    const world = handle.worlds.get(entryWorldId).world;
    const player = world.getPlayer(String(userId));
    assert.ok(player, `${className} must actually be in the world after joining`);
    return { userId, characterId: character.id, world, player, joined, ws };
  }

  // Fires once and reports what the cast actually cost. `_attackCd` is cleared
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
      // A projectile in the air for the staff. The dagger is MELEE and puts
      // nothing in projectiles, so the shared signal is the cooldown stamp:
      // applyAttackCooldown runs on an attack that went through and a refusal
      // is documented to cost nothing, cooldown included (world.js's
      // resourceRefusal header). Both are checked so neither weapon kind is
      // silently reported as "fired" by the other's evidence.
      fired: ctx.world.projectiles.count() > projectilesBefore || ctx.player._attackCd > 0,
    };
  }

  let cultist = null;
  let warrior = null;

  await t.test('the join arms the Cultist: staff worn, spell stone socketed', async () => {
    cultist = await createAndJoin('Cultist');

    // The paper doll, in the DATABASE -- not just the in-memory copy. A grant
    // that only mutated the world object would come back bare on the next
    // login, which is the shape of half this epic's inert features.
    const eq = await pool.query(
      `SELECT pe.slot, it.name
         FROM player_equipment pe
         JOIN player_items pi ON pi.id = pe.item_id
         JOIN item_types it ON it.id = pi.item_type_id
        WHERE pe.character_id = $1 ORDER BY pe.slot`,
      [cultist.characterId]);
    // SOMET-493 added the chest piece: the Cultist's leather-vest is worn too
    // now, along with every other class's armour. The staff row is what this
    // file is about and is asserted in full rather than by a `some()`, so the
    // day the staff stops being worn this goes red rather than shrinking.
    assert.deepStrictEqual(eq.rows, [
      { slot: 'chest', name: 'leather-vest' },
      { slot: 'main_hand', name: STAFF_NAME },
    ], 'a freshly created Cultist must join with its staff already in hand');

    // The stone is in the socket, in the database, pointing at that same staff.
    const socketed = await pool.query(
      `SELECT st.name AS stone, ht.name AS host
         FROM stone_instances si
         JOIN player_items sp ON sp.id = si.player_item_id
         JOIN item_types st ON st.id = sp.item_type_id
         JOIN player_items hp ON hp.id = si.socketed_into_id
         JOIN item_types ht ON ht.id = hp.item_type_id
        WHERE sp.character_id = $1`,
      [cultist.characterId]);
    assert.deepStrictEqual(socketed.rows, [{ stone: STONE_NAME, host: STAFF_NAME }],
      'the starting spell stone must be socketed into the starting staff');

    // And the sim agrees: the weapon combat will resolve is the staff with the
    // stone's spell on it, not the dagger fallback and not a bare staff.
    const w = cultist.world.activeWeapon(String(cultist.userId));
    assert.strictEqual(w.name, STAFF_NAME);
    assert.strictEqual(Number(w.mana_cost), STONE_MANA_COST,
      'a bare staff reads 0 here -- that zero IS the defect this item is about');

    assert.strictEqual(cultist.joined.usesLifeCost, true);
    assert.strictEqual(cultist.player.stats.lifeCostMultiplier, 0.9,
      'the 5 hp literal below is computed from this multiplier');
  });

  await t.test('the Cultist spends exactly 5 hp, and no mana, on its very first cast', () => {
    const hpBefore = cultist.player.hp;
    const manaBefore = cultist.player.mana;
    const cast = castOnce(cultist);
    assert.strictEqual(cast.fired, true, 'the cast must actually go off');
    assert.strictEqual(cast.hpSpent, CULTIST_HP_PER_CAST);
    assert.strictEqual(cast.manaSpent, 0, 'a Cultist never spends mana');
    assert.strictEqual(cultist.player.hp, hpBefore - CULTIST_HP_PER_CAST);
    assert.strictEqual(cultist.player.mana, manaBefore);
  });

  await t.test('casting is what stops a Cultist: the starting kit drains its whole pool', () => {
    // "Visible in play" measured, not asserted as a vibe. From full hp, cast
    // until the gate refuses, and check the drain consumed essentially the
    // entire pool. Spec 8.3 REFUSES the cast that would drop the caster below
    // 1 hp rather than killing them, so the terminal state is "cannot cast",
    // not "dead" -- that is the designed behaviour, not a shortfall here.
    cultist.player.hp = cultist.player.maxHp;
    const startHp = cultist.player.hp;
    let casts = 0;
    for (;;) {
      const cast = castOnce(cultist);
      if (!cast.fired) break;
      assert.strictEqual(cast.hpSpent, CULTIST_HP_PER_CAST, 'every cast costs the same 5 hp');
      casts += 1;
      assert.ok(casts <= 1000, 'the drain must terminate -- a free cast would loop forever');
    }
    const expectedCasts = Math.floor((startHp - 1) / CULTIST_HP_PER_CAST);
    assert.strictEqual(casts, expectedCasts);
    assert.strictEqual(cultist.player.hp, startHp - (expectedCasts * CULTIST_HP_PER_CAST));
    assert.ok(casts > 0, 'a Cultist that cannot cast at all is not the fix either');
    // The whole pool, spent on casting, from the starting loadout alone.
    assert.ok(startHp - cultist.player.hp >= startHp - CULTIST_HP_PER_CAST,
      'the drain must reach the refusal floor, not stall part-way');
  });

  await t.test('the starting stone is soulbound, so it cannot be sold on a reroll loop', async () => {
    const bound = await pool.query(
      `SELECT pi.soulbound FROM player_items pi
         JOIN item_types it ON it.id = pi.item_type_id
        WHERE pi.character_id = $1 AND it.name = $2`,
      [cultist.characterId, STONE_NAME]);
    assert.strictEqual(bound.rows.length, 1);
    assert.strictEqual(bound.rows[0].soulbound, true);
  });

  // SOMET-493 REPLACED THE TWO TESTS THAT USED TO STAND HERE. They asserted
  // that a fresh Warrior joins bare with the dagger (8 damage, no cost) and
  // that no class but the Cultist carries a wear directive -- both were true
  // of SOMET-492's deliberately narrow content, and the product owner has
  // since approved wearing every class's kit, so both are now false. They are
  // not deleted quietly: their replacements assert the opposite by value, per
  // class, in starting_loadout_worn_by_every_class_db.test.js. What this file
  // keeps proving is the part that is still the Cultist's alone -- that the
  // grant wears and sockets what it grants, and that life cost engages from
  // the very first shot.
  await t.test('the Warrior joins wearing its own kit, and still pays no life', async () => {
    warrior = await createAndJoin('Warrior');

    const eq = await pool.query(
      `SELECT pe.slot, it.name
         FROM player_equipment pe
         JOIN player_items pi ON pi.id = pe.item_id
         JOIN item_types it ON it.id = pi.item_type_id
        WHERE pe.character_id = $1 ORDER BY pe.slot`,
      [warrior.characterId]);
    assert.deepStrictEqual(eq.rows, [
      { slot: 'chest', name: 'leather-vest' },
      { slot: 'main_hand', name: 'short sword' },
    ], 'SOMET-493: every class wears its kit, so the Warrior is no longer bare');

    const w = warrior.world.activeWeapon(String(warrior.userId));
    assert.strictEqual(w.name, 'short sword');
    assert.strictEqual(Number(w.mana_cost), 0);
    assert.strictEqual(Number(w.damage), 11);

    assert.strictEqual(warrior.joined.usesLifeCost, false);
    const hpBefore = warrior.player.hp;
    const manaBefore = warrior.player.mana;
    const cast = castOnce(warrior);
    assert.strictEqual(cast.fired, true);
    assert.strictEqual(cast.hpSpent, 0, 'a Warrior must not start losing hp to its own swing');
    assert.strictEqual(cast.manaSpent, 0, 'and a sword costs no mana');
    assert.strictEqual(warrior.player.hp, hpBefore);
    assert.strictEqual(warrior.player.mana, manaBefore);
  });

  await t.test('the Cultist is still the only class whose kit costs LIFE', async () => {
    // The blast radius of the life-cost identity, which SOMET-493 did not
    // widen: five other classes now wear their kits, and none of them may
    // start paying hp to swing. Read off the catalog rather than by joining
    // five more websockets -- a stone directive on a non-Cultist class is
    // exactly how this would stop being true, and usesLifeCost is a class
    // property the joins above already cover.
    const rows = await pool.query(
      `SELECT e.name AS class, it.name AS stone
         FROM class_loadouts cl
         JOIN entity_types e ON e.id = cl.entity_type_id
         JOIN item_types it ON it.id = cl.item_type_id
        WHERE cl.socket_into_item_type_id IS NOT NULL
        ORDER BY e.name`);
    assert.deepStrictEqual(rows.rows, [
      { class: 'Cultist', stone: 'stone_of_apprentice staff' },
      { class: 'Mage', stone: 'stone_of_apprentice staff' },
    ], 'only the two staff classes carry a socket directive');

    // The Mage now carries the SAME stone with the SAME mana_cost, so the only
    // thing keeping the two classes apart is server.js's usesLifeCost. That is
    // proved where it can actually be proved -- through a join, by watching
    // which pool a cast drains -- in
    // starting_loadout_worn_by_every_class_db.test.js ('the Mage pays MANA,
    // the Cultist pays LIFE, for the identical stone'). Asserting a proxy for
    // it here (a main_stat, a class name) would be a second, weaker copy of a
    // rule that lives in exactly one line of server.js.
  });
});
