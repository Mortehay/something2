// SOMET-493 -- every class fights with the kit it was handed, and the
// characters that already exist get dressed too.
//
// WHY THIS FILE IS SHAPED THE WAY IT IS. Twelve features in this codebase have
// shipped live in the database, drawn in the UI, and inert in play, every one
// with a green suite. A test asserting `class_loadouts.equip_slot = 'main_hand'`
// would be the thirteenth: it proves a column got set, not that a Warrior swings
// a sword. So nothing below inserts an item, sockets a stone or equips
// anything to set up the per-class table -- a user row, createCharacter and a
// real websocket join are the whole setup, and every number is read back off
// the running sim (world.activeWeapon) or measured as an actual resource spend
// (world.attack). If the directives regress, the numbers collapse to the
// dagger's 8/0.30/free and this file goes red.
//
// assert.strictEqual / deepStrictEqual throughout, never assert.equal:
// `12 == '12'` is true, and a pg numeric arriving as a string has passed a
// loose assertion in this epic before.
//
// THE TABLE, MEASURED BEFORE AND AFTER on a scratch database:
//
//   class    before                        after
//   -------  ----------------------------  ----------------------------------
//   Warrior  dagger 8 / 0.30 / free        short sword 11 / 0.45 / 6 stamina
//   Druid    dagger 8 / 0.30 / free        club        10 / 0.45 / 6 stamina
//   Archer   dagger 8 / 0.30 / free        bow         12 / 0.60 / 8 stamina
//   Monk     dagger 8 / 0.30 / free        stick        7 / 0.35 / free
//   Mage     dagger 8 / 0.30 / free        staff       10 / 0.55 / 8 mana
//   Cultist  staff 10 / 0.55 / 5 hp        unchanged, plus chest armour
//
// The Monk's row is a DOWNGRADE (20.0 dps against the dagger's 26.7) and is
// asserted as one rather than smoothed over: the stick is the Monk's authored
// kit, and this file's job is to make the balance change visible, not to
// disguise it.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');

const { attachAuthority } = require('../src/authority/server.js');
const { createCharacter } = require('../src/services/characters.js');
const { backfillWornStartingKit } = require('../src/services/loadoutBackfill.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SECRET = 'somet493-test-secret';
const TAG = `s493_${process.pid}_${Date.now().toString(36)}`;

// The whole point of the item, as one literal table. Every number here was
// read off the live catalog by the assertions in 'the kit each class is handed
// is the kit the catalog describes' below, so a catalog rebalance breaks the
// arithmetic loudly instead of quietly agreeing with itself.
const EXPECTED = {
  Warrior: {
    equipment: [{ slot: 'chest', name: 'leather-vest' }, { slot: 'main_hand', name: 'short sword' }],
    weapon: 'short sword', damage: 11, cooldown: 0.45, manaCost: 0, staminaCost: 6,
    element: null, spend: { hp: 0, mana: 0, stamina: 6 },
  },
  Druid: {
    equipment: [{ slot: 'chest', name: 'leather-vest' }, { slot: 'main_hand', name: 'club' }],
    weapon: 'club', damage: 10, cooldown: 0.45, manaCost: 0, staminaCost: 6,
    element: null, spend: { hp: 0, mana: 0, stamina: 6 },
  },
  Archer: {
    equipment: [{ slot: 'chest', name: 'leather-vest' }, { slot: 'main_hand', name: 'bow' }],
    weapon: 'bow', damage: 12, cooldown: 0.6, manaCost: 0, staminaCost: 8,
    element: null, spend: { hp: 0, mana: 0, stamina: 8 },
  },
  Monk: {
    // 7 damage against the dagger fallback's 8, on a SLOWER 0.35s cooldown.
    // Wearing its own kit makes the Monk weaker; that is the authored content.
    equipment: [{ slot: 'chest', name: 'leather-vest' }, { slot: 'main_hand', name: 'stick' }],
    weapon: 'stick', damage: 7, cooldown: 0.35, manaCost: 0, staminaCost: 0,
    element: null, spend: { hp: 0, mana: 0, stamina: 0 },
  },
  Mage: {
    // The staff reads 10 arcane at 8 mana ONLY because a stone is socketed
    // into it. Bare, activeWeaponType zeroes it to 8 physical -- worse than
    // the dagger, and it would leave the Mage's own +3 ARCANE start node
    // permanently inert.
    equipment: [{ slot: 'head', name: 'arcane-ward' }, { slot: 'main_hand', name: 'apprentice staff' }],
    weapon: 'apprentice staff', damage: 10, cooldown: 0.55, manaCost: 8, staminaCost: 0,
    element: 'arcane', spend: { hp: 0, mana: 8, stamina: 0 },
  },
  Cultist: {
    equipment: [{ slot: 'chest', name: 'leather-vest' }, { slot: 'main_hand', name: 'apprentice staff' }],
    weapon: 'apprentice staff', damage: 10, cooldown: 0.55, manaCost: 8, staminaCost: 0,
    // ceil(8 * 0.6 * 0.9) = 5. Same stone as the Mage, different pool.
    element: 'arcane', spend: { hp: 5, mana: 0, stamina: 0 },
  },
};

const DAGGER = { damage: 8, cooldown: 0.3 };

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

// Resolves with the first frame whose type is in `types`, so a shot can be
// answered by either 'ammo' (spent one) or 'noammo' (refused) without the test
// having to guess which it will be.
function nextOneOf(ws, types, ms = 15000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting for one of ${types}`)), ms);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (types.includes(m.type)) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

test('every class wears its starting kit', { skip: !DB_URL ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000, max: 8 });
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    await pool.end().catch(() => {});
    // Loud, not silent: a skipped run of this file verifies nothing, and this
    // is the file that proves the change is not inert.
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

  const classRows = await pool.query('SELECT id, name FROM entity_types WHERE is_playable ORDER BY name');
  const classIdByName = new Map(classRows.rows.map((r) => [r.name, r.id]));
  assert.deepStrictEqual([...classIdByName.keys()].sort(), Object.keys(EXPECTED).sort(),
    'this file must have an expectation for every playable class, or a new class passes vacuously');

  let seq = 0;
  async function createOnly(className) {
    const who = `${TAG}_${className}_${seq++}`.toLowerCase();
    const u = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id", [who]);
    const userId = u.rows[0].id;
    userIds.push(userId);
    const character = await createCharacter(
      pool, userId, `${TAG}${className}${seq}`, classIdByName.get(className));
    return { userId, characterId: character.id };
  }

  async function join({ userId, characterId }) {
    const token = jwt.sign({ user_id: userId, tv: 1 }, SECRET, { algorithm: 'HS256' });
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    sockets.push(ws);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.send(JSON.stringify({ type: 'join', character_id: characterId, world_id: entryWorldId }));
    const joined = await nextMsg(ws, 'joined');
    const world = handle.worlds.get(entryWorldId).world;
    const player = world.getPlayer(String(userId));
    assert.ok(player, 'the character must actually be in the world after joining');
    return { userId, characterId, world, player, joined, ws };
  }

  const createAndJoin = async (className) => join(await createOnly(className));

  // One attack, reporting what it actually cost. `_attackCd` is cleared first
  // so the measurement is about cost, not about the cooldown. This is the
  // ammo-FREE path (world.attack); the bow's ammo spend lives in server.js and
  // is exercised over a real socket further down.
  function attackOnce(ctx) {
    ctx.player._attackCd = 0;
    const hp = ctx.player.hp;
    const mana = ctx.player.mana;
    const stamina = ctx.player.stamina;
    const projectiles = ctx.world.projectiles.count();
    ctx.world.attack(String(ctx.userId), 1, 0);
    return {
      hp: hp - ctx.player.hp, mana: mana - ctx.player.mana, stamina: stamina - ctx.player.stamina,
      // A projectile in the air for the ranged weapons; the melee ones put
      // nothing there, so the shared signal is the cooldown stamp --
      // applyAttackCooldown runs on an attack that went through and a refusal
      // is documented to cost nothing, cooldown included. Both are checked so
      // neither weapon kind is reported as "fired" on the other's evidence.
      fired: ctx.world.projectiles.count() > projectiles || ctx.player._attackCd > 0,
    };
  }

  const joined = {};

  for (const className of Object.keys(EXPECTED)) {
    const want = EXPECTED[className];
    await t.test(`a freshly created ${className} joins wearing ${want.weapon}, and it costs what it says`, async () => {
      const ctx = await createAndJoin(className);
      joined[className] = ctx;

      // The paper doll, in the DATABASE -- not just the in-memory copy. A
      // grant that only mutated the world object would come back bare on the
      // next login, which is the shape of half this epic's inert features.
      const eq = await pool.query(
        `SELECT pe.slot, it.name
           FROM player_equipment pe
           JOIN player_items pi ON pi.id = pe.item_id
           JOIN item_types it ON it.id = pi.item_type_id
          WHERE pe.character_id = $1 ORDER BY pe.slot`,
        [ctx.characterId]);
      assert.deepStrictEqual(eq.rows, want.equipment,
        `${className} must join with its whole kit on, not carrying it`);

      // And the sim agrees about the weapon combat will actually resolve.
      const w = ctx.world.activeWeapon(String(ctx.userId));
      assert.strictEqual(w.name, want.weapon,
        `${className} must not be falling back to the dagger`);
      assert.strictEqual(Number(w.damage), want.damage);
      assert.strictEqual(Number(w.cooldown), want.cooldown);
      assert.strictEqual(Number(w.mana_cost), want.manaCost);
      assert.strictEqual(Number(w.stamina_cost || 0), want.staminaCost);
      assert.strictEqual(w.element ?? null, want.element,
        'element decides which resistances apply and which passive damage nodes are live');

      // The measured spend of one real attack, which is the part a column
      // check can never reach.
      const spent = attackOnce(ctx);
      assert.strictEqual(spent.fired, true, 'the attack must actually go off');
      assert.strictEqual(spent.hp, want.spend.hp);
      assert.strictEqual(spent.mana, want.spend.mana);
      assert.strictEqual(spent.stamina, want.spend.stamina);

      // Nothing granted may be sellable on a delete-and-reroll loop
      // (SOMET-277): the per-character claim flag dies with the character, the
      // account-wide gold does not.
      const loose = await pool.query(
        `SELECT it.name FROM player_items pi JOIN item_types it ON it.id = pi.item_type_id
          WHERE pi.character_id = $1 AND pi.soulbound = false ORDER BY it.name`,
        [ctx.characterId]);
      assert.deepStrictEqual(loose.rows, [],
        `every item ${className} is granted must be soulbound`);
    });
  }

  await t.test('no class is left on the dagger fallback', async () => {
    // Stated once, against the live sim, so that "every class" is a fact about
    // the six joins above rather than about six separately-written literals
    // that could all be edited to say 'dagger' at once.
    // The count first: `joined` is filled by the subtests above, so a loop
    // over it would pass vacuously if every one of them had failed to record
    // its context.
    assert.deepStrictEqual(Object.keys(joined).sort(), Object.keys(EXPECTED).sort(),
      'every class must have actually joined, or the loop below checks nothing');
    for (const [className, ctx] of Object.entries(joined)) {
      const w = ctx.world.activeWeapon(String(ctx.userId));
      assert.notStrictEqual(w.name, 'dagger', `${className} is still unarmed`);
    }
    const baseline = await pool.query(
      'SELECT damage, cooldown FROM item_types WHERE name = $1', ['dagger']);
    assert.strictEqual(Number(baseline.rows[0].damage), DAGGER.damage,
      'the before-numbers in this file are the dagger fallback; a changed dagger changes them');
    assert.strictEqual(Number(baseline.rows[0].cooldown), DAGGER.cooldown);
  });

  await t.test('the Monk is WEAKER for wearing its kit, and that is the authored content', () => {
    // Recorded as an assertion rather than a comment so the regression cannot
    // be discovered later as a surprise. The stick is 7 damage on 0.35s
    // against the dagger fallback's 8 on 0.30s.
    const w = joined.Monk.world.activeWeapon(String(joined.Monk.userId));
    const stickDps = Number(w.damage) / Number(w.cooldown);
    const daggerDps = DAGGER.damage / DAGGER.cooldown;
    assert.ok(Number(w.damage) < DAGGER.damage,
      'if the stick ever out-damages the dagger, this note and the ticket both need revisiting');
    assert.ok(stickDps < daggerDps);
    assert.strictEqual(Math.round(stickDps * 10) / 10, 20);
    assert.strictEqual(Math.round(daggerDps * 10) / 10, 26.7);
  });

  await t.test('the Mage pays MANA, the Cultist pays LIFE, for the identical stone', async () => {
    // Both classes now start with the same socketed stone_of_apprentice staff,
    // so this is the only place the two identities can be told apart -- and it
    // is server.js's one usesLifeCost line, watched through the pool each cast
    // actually drains rather than through any proxy for it.
    const stone = await pool.query(
      'SELECT mana_cost FROM item_types WHERE name = $1 AND category = $2',
      ['stone_of_apprentice staff', 'stone']);
    assert.strictEqual(Number(stone.rows[0].mana_cost), 8,
      'the 8-mana and 5-hp literals in this file are computed from this cost');

    assert.strictEqual(joined.Mage.joined.usesLifeCost, false);
    assert.strictEqual(joined.Cultist.joined.usesLifeCost, true);

    const mage = attackOnce(joined.Mage);
    assert.strictEqual(mage.mana, 8);
    assert.strictEqual(mage.hp, 0, 'a Mage must not start paying hp to cast');

    const cultist = attackOnce(joined.Cultist);
    assert.strictEqual(cultist.hp, 5);
    assert.strictEqual(cultist.mana, 0, 'a Cultist never spends mana');
  });

  await t.test("the Mage's staff is socketed, so its arcane start node is not inert", async () => {
    // The failure this guards is silent: an equipped but BARE apprentice staff
    // is forced to physical damage at the dagger's baseline by
    // activeWeaponType, which would leave the Mage dealing 8 physical and its
    // own '+3 arcane damage' start node contributing nothing, forever, with
    // the paper doll looking perfectly correct in the UI.
    const socketed = await pool.query(
      `SELECT st.name AS stone, ht.name AS host
         FROM stone_instances si
         JOIN player_items sp ON sp.id = si.player_item_id
         JOIN item_types st ON st.id = sp.item_type_id
         JOIN player_items hp ON hp.id = si.socketed_into_id
         JOIN item_types ht ON ht.id = hp.item_type_id
        WHERE sp.character_id = $1`,
      [joined.Mage.characterId]);
    assert.deepStrictEqual(socketed.rows,
      [{ stone: 'stone_of_apprentice staff', host: 'apprentice staff' }]);

    const w = joined.Mage.world.activeWeapon(String(joined.Mage.userId));
    assert.strictEqual(w.element, 'arcane',
      'physical here means the staff is bare and the class start node is dead');

    const node = await pool.query(
      'SELECT grants FROM passive_nodes WHERE start_class = $1', ['Mage']);
    assert.deepStrictEqual(node.rows[0].grants,
      [{ type: 'damage', value: 3, element: 'arcane' }],
      'the node this weapon has to match; if it stops being arcane, the staff choice needs revisiting');
  });

  // ------------------------------------------------------------------
  // The Archer, whose weapon can run out.
  // ------------------------------------------------------------------
  await t.test('the Archer really spends its granted arrows, and is not stranded when they run out', async () => {
    const archer = joined.Archer;
    const arrowType = await pool.query('SELECT id FROM item_types WHERE name = $1', ['arrow']);
    const arrowTypeId = arrowType.rows[0].id;

    const held = async () => {
      const r = await pool.query(
        'SELECT COALESCE(SUM(quantity), 0)::int AS n FROM player_items WHERE character_id = $1 AND item_type_id = $2',
        [archer.characterId, arrowTypeId]);
      return r.rows[0].n;
    };

    // The kit contains ammo at all -- checked, not assumed. An equipped bow
    // with an empty quiver would be a character that cannot attack, which is
    // strictly worse than the dagger fallback it replaced.
    assert.strictEqual(await held(), 20, 'the Archer must be handed arrows for the bow it now wears');

    // Fire for real, over the socket, so server.js's ammo path runs.
    archer.player._attackCd = 0;
    archer.ws.send(JSON.stringify({ type: 'attack', ax: 1, ay: 0 }));
    const spent = await nextOneOf(archer.ws, ['ammo', 'noammo']);
    assert.strictEqual(spent.type, 'ammo', 'a bow with 20 arrows must not refuse the shot');
    assert.strictEqual(spent.count, 19);
    assert.strictEqual(await held(), 19, 'the arrow must leave the database, not just the HUD');

    // Fast-forward the quiver to its last arrow. This edits a COUNT, never the
    // kit's composition: the bow, the stack and the equip all still came from
    // the grant.
    await pool.query(
      'UPDATE player_items SET quantity = 1 WHERE character_id = $1 AND item_type_id = $2',
      [archer.characterId, arrowTypeId]);

    archer.player._attackCd = 0;
    archer.ws.send(JSON.stringify({ type: 'attack', ax: 1, ay: 0 }));
    const last = await nextOneOf(archer.ws, ['ammo', 'noammo']);
    assert.strictEqual(last.type, 'ammo', 'the LAST arrow must be firable (SOMET: the stuck-at-1 bug)');
    assert.strictEqual(last.count, 0);
    assert.strictEqual(await held(), 0);

    archer.player._attackCd = 0;
    archer.ws.send(JSON.stringify({ type: 'attack', ax: 1, ay: 0 }));
    const dry = await nextOneOf(archer.ws, ['ammo', 'noammo']);
    assert.strictEqual(dry.type, 'noammo', 'an empty quiver must refuse the shot, not fire free');
    assert.strictEqual(dry.item_type_id, arrowTypeId);

    // ...and the way out is the ordinary one: take the bow off and the dagger
    // fallback comes back. This is what keeps "the Archer's bow consumes ammo"
    // an inconvenience rather than a dead end.
    // unequip acknowledges with the re-derived `progression` frame (the
    // equip/unequip handler's own confirmation), so waiting for that is
    // waiting for the write to have landed.
    archer.ws.send(JSON.stringify({ type: 'unequip', slot: 'main_hand' }));
    await nextMsg(archer.ws, 'progression');
    const w = archer.world.activeWeapon(String(archer.userId));
    assert.strictEqual(w.name, 'dagger');
    assert.strictEqual(Number(w.damage), DAGGER.damage);
    assert.strictEqual(w.ammo_type_id ?? null, null,
      'the fallback must be a weapon that needs no ammunition, or there is no way out');
  });

  await t.test('the GRANT never overwrites a slot that is already filled', async () => {
    // Found by gear_affix_composition_db.test.js going red: its fixture puts
    // an affixed staff in main_hand and THEN joins, and SOMET-492's
    // `ON CONFLICT (character_id, slot) DO UPDATE SET item_id = EXCLUDED.item_id`
    // swapped it out for the granted short sword mid-join. That was survivable
    // while one class equipped one hand; SOMET-493 widened it to two slots on
    // all six. The ON CONFLICT is still there -- it is what stops a unique
    // violation rolling back the claim and locking the character out of
    // joining forever -- but it is now DO NOTHING, so the slot the player
    // already has wins and the granted item stays in the bag.
    const c = await createOnly('Warrior');
    const mine = await pool.query(
      `INSERT INTO player_items (character_id, item_type_id, quantity, soulbound)
       SELECT $1, id, 1, false FROM item_types WHERE name = 'club' RETURNING id`,
      [c.characterId]);
    await pool.query(
      "INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1, 'main_hand', $2)",
      [c.characterId, mine.rows[0].id]);

    const ctx = await join(c);

    const eq = await pool.query(
      `SELECT pe.slot, it.name FROM player_equipment pe
         JOIN player_items pi ON pi.id = pe.item_id
         JOIN item_types it ON it.id = pi.item_type_id
        WHERE pe.character_id = $1 ORDER BY pe.slot`, [c.characterId]);
    assert.deepStrictEqual(eq.rows, [
      { slot: 'chest', name: 'leather-vest' },
      { slot: 'main_hand', name: 'club' },
    ], 'the occupied hand keeps the club; only the EMPTY chest slot is filled by the grant');

    // The grant still happened -- the sword is in the bag, not lost. And the
    // join did not throw, which is the property the ON CONFLICT exists for.
    const bag = await pool.query(
      `SELECT it.name FROM player_items pi JOIN item_types it ON it.id = pi.item_type_id
        WHERE pi.character_id = $1 AND pi.soulbound ORDER BY it.name`, [c.characterId]);
    assert.deepStrictEqual(bag.rows, [{ name: 'leather-vest' }, { name: 'short sword' }]);
    assert.strictEqual(ctx.world.activeWeapon(String(ctx.userId)).name, 'club');
  });

  // ------------------------------------------------------------------
  // The catalog invariants the migration and the seeder both have to satisfy.
  // ------------------------------------------------------------------
  await t.test('the kit each class is handed is the kit the catalog describes', async () => {
    // Every wearable loadout row wears the slot its own item type declares.
    // Written as a mismatch list rather than a per-row loop so the failure
    // names every offender at once.
    const mismatched = await pool.query(
      `SELECT e.name AS class, it.name AS item, cl.equip_slot, it.slot AS catalog_slot
         FROM class_loadouts cl
         JOIN entity_types e ON e.id = cl.entity_type_id
         JOIN item_types it ON it.id = cl.item_type_id
        WHERE cl.socket_into_item_type_id IS NULL
          AND it.category IN ('weapon', 'armor')
          AND (cl.equip_slot IS DISTINCT FROM it.slot)
        ORDER BY e.name, it.name`);
    assert.deepStrictEqual(mismatched.rows, [],
      'a weapon or armour row with no equip_slot is a class back on the dagger fallback');

    // Ammo is the one deliberate exception: no paper-doll slot holds it.
    const ammoWorn = await pool.query(
      `SELECT e.name AS class, it.name AS item
         FROM class_loadouts cl
         JOIN entity_types e ON e.id = cl.entity_type_id
         JOIN item_types it ON it.id = cl.item_type_id
        WHERE it.category = 'ammo' AND cl.equip_slot IS NOT NULL`);
    assert.deepStrictEqual(ammoWorn.rows, [], 'ammo is spent from the bag, not worn');

    // THE BACKFILL'S REQUIREMENT GUARD IS A PROVEN NO-OP, not a hopeful one.
    // loadoutBackfill.js refuses to equip anything gated on level or stats,
    // because it writes player_equipment below canEquip. That guard silently
    // skipping a whole class's weapon would be invisible; this is what makes
    // it visible.
    const gated = await pool.query(
      `SELECT e.name AS class, it.name AS item, it.req_level
         FROM class_loadouts cl
         JOIN entity_types e ON e.id = cl.entity_type_id
         JOIN item_types it ON it.id = cl.item_type_id
        WHERE cl.equip_slot IS NOT NULL
          AND (it.req_level > 1 OR it.req_strength > 0 OR it.req_dexterity > 0
               OR it.req_constitution > 0 OR it.req_intelligence > 0
               OR it.req_wisdom > 0 OR it.req_charisma > 0)
        ORDER BY e.name, it.name`);
    assert.deepStrictEqual(gated.rows, [],
      'a stat-gated kit item would be SKIPPED by the backfill; give it a requirement-aware path first');
  });

  await t.test('a re-seed cannot quietly undo the directives', async () => {
    // SOMET-335's trap, which is why seedOneClassLoadout writes equip_slot and
    // socket_into_item_type_id ON CONFLICT as well as on INSERT. With a bare
    // DO NOTHING the rows below come back with the right ITEMS and no
    // directives -- inventory identical, every class inert, every row-count
    // assertion still green.
    const before = await pool.query(
      `SELECT cl.entity_type_id, cl.item_type_id, cl.equip_slot, cl.socket_into_item_type_id
         FROM class_loadouts cl ORDER BY cl.entity_type_id, cl.item_type_id`);
    assert.ok(before.rows.some((r) => r.equip_slot !== null), 'nothing to lose means nothing proved');

    await pool.query('UPDATE class_loadouts SET equip_slot = NULL, socket_into_item_type_id = NULL');
    const wiped = await pool.query(
      `SELECT count(*)::int AS n FROM class_loadouts
        WHERE equip_slot IS NOT NULL OR socket_into_item_type_id IS NOT NULL`);
    assert.strictEqual(wiped.rows[0].n, 0, 'the wipe must actually happen or the restore proves nothing');

    // eslint-disable-next-line global-require
    const { seedCatalogs } = require('../scripts/seed-catalogs.js');
    await seedCatalogs(pool);

    const after = await pool.query(
      `SELECT cl.entity_type_id, cl.item_type_id, cl.equip_slot, cl.socket_into_item_type_id
         FROM class_loadouts cl ORDER BY cl.entity_type_id, cl.item_type_id`);
    assert.deepStrictEqual(after.rows, before.rows,
      'seeds/data/entityTypes.js is the second source of truth and must restore every directive');
  });

  // ------------------------------------------------------------------
  // The backfill. Characters that already exist.
  // ------------------------------------------------------------------
  //
  // These build their inventories BY HAND, which the per-class tests above
  // deliberately never do -- and they have to: the states under test are
  // "sold it", "banked it", "wearing something else", states no fresh grant
  // can produce. The statements under test are imported from
  // src/services/loadoutBackfill.js, the same text migration 1714440515000
  // runs, so a guard weakened in the migration is a guard weakened here.
  await t.test('the backfill dresses an existing character', async () => {
    const c = await createOnly('Warrior');
    // An existing character: granted its kit, wearing none of it. This is
    // exactly the state every character in the database was in before this
    // migration.
    await pool.query('UPDATE characters SET starting_loadout_granted_at = now() WHERE id = $1',
      [c.characterId]);
    await pool.query('DELETE FROM player_equipment WHERE character_id = $1', [c.characterId]);
    await pool.query(
      `INSERT INTO player_items (character_id, item_type_id, quantity, soulbound)
       SELECT $1, id, 1, true FROM item_types WHERE name IN ('short sword', 'leather-vest')`,
      [c.characterId]);

    await backfillWornStartingKit(pool);

    const eq = await pool.query(
      `SELECT pe.slot, it.name FROM player_equipment pe
         JOIN player_items pi ON pi.id = pe.item_id
         JOIN item_types it ON it.id = pi.item_type_id
        WHERE pe.character_id = $1 ORDER BY pe.slot`, [c.characterId]);
    assert.deepStrictEqual(eq.rows, [
      { slot: 'chest', name: 'leather-vest' },
      { slot: 'main_hand', name: 'short sword' },
    ]);

    // And it is idempotent -- the migration's up() has to be safely re-runnable
    // because its down() is a documented no-op.
    const again = await backfillWornStartingKit(pool);
    assert.strictEqual(again.equipped, 0, 'a second run must not write anything');
    const eqAgain = await pool.query(
      'SELECT count(*)::int AS n FROM player_equipment WHERE character_id = $1', [c.characterId]);
    assert.strictEqual(eqAgain.rows[0].n, 2);
  });

  await t.test('the backfill SKIPS a slot the player has already filled', async () => {
    const c = await createOnly('Warrior');
    await pool.query('UPDATE characters SET starting_loadout_granted_at = now() WHERE id = $1',
      [c.characterId]);
    await pool.query('DELETE FROM player_equipment WHERE character_id = $1', [c.characterId]);
    // Holds the starting sword, but is WEARING a club it found. Stripping that
    // back to the starting kit is the single most damaging thing this
    // migration could do.
    const kit = await pool.query(
      `INSERT INTO player_items (character_id, item_type_id, quantity, soulbound)
       SELECT $1, id, 1, true FROM item_types WHERE name = 'short sword' RETURNING id`,
      [c.characterId]);
    const found = await pool.query(
      `INSERT INTO player_items (character_id, item_type_id, quantity, soulbound)
       SELECT $1, id, 1, false FROM item_types WHERE name = 'club' RETURNING id`,
      [c.characterId]);
    await pool.query(
      "INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1, 'main_hand', $2)",
      [c.characterId, found.rows[0].id]);

    await backfillWornStartingKit(pool);

    const eq = await pool.query(
      `SELECT pe.slot, it.name FROM player_equipment pe
         JOIN player_items pi ON pi.id = pe.item_id
         JOIN item_types it ON it.id = pi.item_type_id
        WHERE pe.character_id = $1 AND pe.slot = 'main_hand'`, [c.characterId]);
    assert.deepStrictEqual(eq.rows, [{ slot: 'main_hand', name: 'club' }],
      'the found club must survive; the starting sword must NOT displace it');
    const swordWorn = await pool.query(
      'SELECT count(*)::int AS n FROM player_equipment WHERE item_id = $1', [kit.rows[0].id]);
    assert.strictEqual(swordWorn.rows[0].n, 0, 'the starting sword stays in the bag');
  });

  await t.test('the backfill SKIPS an item the character has banked', async () => {
    const c = await createOnly('Warrior');
    await pool.query('UPDATE characters SET starting_loadout_granted_at = now() WHERE id = $1',
      [c.characterId]);
    await pool.query('DELETE FROM player_equipment WHERE character_id = $1', [c.characterId]);
    // The state accountChest.js#depositItem leaves behind: the account_items
    // row, and the SAME player_items instance handed over to it -- character_id
    // NULL, account_item_id set. The num_nonnulls(...) = 1 CHECK makes those
    // mutually exclusive, so this instance is genuinely not held by the
    // character any more.
    const held = await pool.query(
      `INSERT INTO player_items (character_id, item_type_id, quantity, soulbound)
       SELECT $1, id, 1, true FROM item_types WHERE name = 'short sword' RETURNING id`,
      [c.characterId]);
    const acct = await pool.query(
      `INSERT INTO account_items (user_id, slot, item_type_id, quantity, soulbound)
       SELECT $1, 1, id, 1, true FROM item_types WHERE name = 'short sword' RETURNING id`,
      [c.userId]);
    await pool.query(
      'UPDATE player_items SET character_id = NULL, account_item_id = $2 WHERE id = $1',
      [held.rows[0].id, acct.rows[0].id]);

    await backfillWornStartingKit(pool);

    const eq = await pool.query(
      'SELECT count(*)::int AS n FROM player_equipment WHERE character_id = $1', [c.characterId]);
    assert.strictEqual(eq.rows[0].n, 0, 'a banked sword must not be pulled onto the paper doll');
    const stillBanked = await pool.query(
      `SELECT character_id, account_item_id FROM player_items WHERE account_item_id = $1`,
      [acct.rows[0].id]);
    assert.strictEqual(stillBanked.rows.length, 1);
    assert.strictEqual(stillBanked.rows[0].character_id, null,
      'and it must still be in the bank afterwards -- nothing here withdraws');
  });

  await t.test('the backfill SKIPS an item the character has sold to a merchant', async () => {
    const c = await createOnly('Druid');
    await pool.query('UPDATE characters SET starting_loadout_granted_at = now() WHERE id = $1',
      [c.characterId]);
    await pool.query('DELETE FROM player_equipment WHERE character_id = $1', [c.characterId]);
    const village = await pool.query('SELECT id, world_id FROM villages LIMIT 1');
    if (!village.rows.length) {
      // Loud rather than silent: an unexercised skip case is not a passing one.
      throw new Error('no village seeded, so the merchant-shelf skip was not verified');
    }
    const stock = await pool.query(
      `INSERT INTO merchant_stock (world_id, village_id, item_type_id, price, quantity)
       SELECT $1, $2, id, 10, 1 FROM item_types WHERE name = 'club' RETURNING id`,
      [village.rows[0].world_id, village.rows[0].id]);
    // The instance itself moves onto the shelf (SOMET-498), exactly as
    // trade.js#sellItem leaves it.
    await pool.query(
      `INSERT INTO player_items (merchant_stock_id, item_type_id, quantity, soulbound)
       SELECT $1, id, 1, false FROM item_types WHERE name = 'club'`, [stock.rows[0].id]);

    await backfillWornStartingKit(pool);

    const eq = await pool.query(
      'SELECT count(*)::int AS n FROM player_equipment WHERE character_id = $1', [c.characterId]);
    assert.strictEqual(eq.rows[0].n, 0, "a club on a merchant's shelf is not the character's to wear");
    const onShelf = await pool.query(
      'SELECT character_id FROM player_items WHERE merchant_stock_id = $1', [stock.rows[0].id]);
    assert.strictEqual(onShelf.rows[0].character_id, null,
      "and it must still be on the shelf -- nothing here takes stock off a merchant");

    // The shelf row does NOT hang off the user, so t.after's `DELETE FROM
    // users` cannot reach it, and a shelf-held instance left behind trips
    // characters_schema_db.test.js's "every state row is reachable through a
    // character" orphan count in whatever file runs next.
    // player_items.merchant_stock_id is ON DELETE CASCADE, so this is enough.
    await pool.query('DELETE FROM merchant_stock WHERE id = $1', [stock.rows[0].id]);
  });

  await t.test('the backfill SKIPS a character who no longer holds the item at all', async () => {
    const c = await createOnly('Monk');
    await pool.query('UPDATE characters SET starting_loadout_granted_at = now() WHERE id = $1',
      [c.characterId]);
    await pool.query('DELETE FROM player_equipment WHERE character_id = $1', [c.characterId]);
    await pool.query('DELETE FROM player_items WHERE character_id = $1', [c.characterId]);

    const before = await backfillWornStartingKit(pool);
    const eq = await pool.query(
      'SELECT count(*)::int AS n FROM player_equipment WHERE character_id = $1', [c.characterId]);
    assert.strictEqual(eq.rows[0].n, 0, 'nothing held means nothing worn -- and nothing conjured');
    const items = await pool.query(
      'SELECT count(*)::int AS n FROM player_items WHERE character_id = $1', [c.characterId]);
    assert.strictEqual(items.rows[0].n, 0, 'the backfill must not re-grant a lost kit');
    assert.strictEqual(before.equipped, 0);
  });

  await t.test('the backfill SKIPS a BOUGHT replacement of a kit item', async () => {
    // The soulbound guard, which is what makes "the starting kit" precise. A
    // Warrior who sold the granted sword and bought another one holds a short
    // sword -- but not THAT short sword, and a migration must not reach into a
    // purchase.
    const c = await createOnly('Warrior');
    await pool.query('UPDATE characters SET starting_loadout_granted_at = now() WHERE id = $1',
      [c.characterId]);
    await pool.query('DELETE FROM player_equipment WHERE character_id = $1', [c.characterId]);
    await pool.query(
      `INSERT INTO player_items (character_id, item_type_id, quantity, soulbound)
       SELECT $1, id, 1, false FROM item_types WHERE name IN ('short sword', 'leather-vest')`,
      [c.characterId]);

    await backfillWornStartingKit(pool);

    const eq = await pool.query(
      'SELECT count(*)::int AS n FROM player_equipment WHERE character_id = $1', [c.characterId]);
    assert.strictEqual(eq.rows[0].n, 0,
      'an unbound short sword is a purchase, not the granted kit');
  });

  await t.test('the backfill gives an existing Mage the socketed stone it was never handed', async () => {
    const c = await createOnly('Mage');
    await pool.query('UPDATE characters SET starting_loadout_granted_at = now() WHERE id = $1',
      [c.characterId]);
    await pool.query('DELETE FROM player_equipment WHERE character_id = $1', [c.characterId]);
    await pool.query('DELETE FROM player_items WHERE character_id = $1', [c.characterId]);
    // A Mage from before this change: staff and ward, no stone at all.
    await pool.query(
      `INSERT INTO player_items (character_id, item_type_id, quantity, soulbound)
       SELECT $1, id, 1, true FROM item_types WHERE name IN ('apprentice staff', 'arcane-ward')`,
      [c.characterId]);

    await backfillWornStartingKit(pool);

    const socketed = await pool.query(
      `SELECT st.name AS stone, ht.name AS host
         FROM stone_instances si
         JOIN player_items sp ON sp.id = si.player_item_id
         JOIN item_types st ON st.id = sp.item_type_id
         JOIN player_items hp ON hp.id = si.socketed_into_id
         JOIN item_types ht ON ht.id = hp.item_type_id
        WHERE sp.character_id = $1`, [c.characterId]);
    assert.deepStrictEqual(socketed.rows,
      [{ stone: 'stone_of_apprentice staff', host: 'apprentice staff' }]);
    const bound = await pool.query(
      `SELECT pi.soulbound FROM player_items pi JOIN item_types it ON it.id = pi.item_type_id
        WHERE pi.character_id = $1 AND it.name = 'stone_of_apprentice staff'`, [c.characterId]);
    assert.deepStrictEqual(bound.rows, [{ soulbound: true }],
      'a backfilled stone must be bound like a granted one, or it is a gold faucet');

    // ...and the character it produces is the one a fresh Mage gets. Proved by
    // joining it, not by reading the rows back.
    const ctx = await join(c);
    const w = ctx.world.activeWeapon(String(ctx.userId));
    assert.strictEqual(w.name, 'apprentice staff');
    assert.strictEqual(w.element, 'arcane');
    assert.strictEqual(Number(w.mana_cost), 8);
    const spent = attackOnce(ctx);
    assert.strictEqual(spent.fired, true);
    assert.strictEqual(spent.mana, 8, 'a backfilled Mage must actually pay for its casts');
  });

  await t.test('the backfill does NOT double-socket a weapon that already has a stone', async () => {
    const c = await createOnly('Cultist');
    await pool.query('UPDATE characters SET starting_loadout_granted_at = now() WHERE id = $1',
      [c.characterId]);
    await pool.query('DELETE FROM player_equipment WHERE character_id = $1', [c.characterId]);
    await pool.query('DELETE FROM player_items WHERE character_id = $1', [c.characterId]);
    const staff = await pool.query(
      `INSERT INTO player_items (character_id, item_type_id, quantity, soulbound)
       SELECT $1, id, 1, true FROM item_types WHERE name = 'apprentice staff' RETURNING id`,
      [c.characterId]);
    // A DIFFERENT, better stone the player socketed themselves, and levelled.
    const mine = await pool.query(
      `INSERT INTO player_items (character_id, item_type_id, quantity, soulbound)
       SELECT $1, id, 1, false FROM item_types WHERE name = 'stone_of_flame staff' RETURNING id`,
      [c.characterId]);
    await pool.query(
      'INSERT INTO stone_instances (player_item_id, socketed_into_id, xp, level) VALUES ($1, $2, 900, 4)',
      [mine.rows[0].id, staff.rows[0].id]);

    await backfillWornStartingKit(pool);

    const socketed = await pool.query(
      `SELECT it.name, si.xp::int AS xp, si.level
         FROM stone_instances si
         JOIN player_items pi ON pi.id = si.player_item_id
         JOIN item_types it ON it.id = pi.item_type_id
        WHERE si.socketed_into_id = $1`, [staff.rows[0].id]);
    assert.deepStrictEqual(socketed.rows, [{ name: 'stone_of_flame staff', xp: 900, level: 4 }],
      "the player's own levelled stone must be left exactly where it is");
    const stones = await pool.query(
      `SELECT count(*)::int AS n FROM player_items pi JOIN item_types it ON it.id = pi.item_type_id
        WHERE pi.character_id = $1 AND it.category = 'stone'`, [c.characterId]);
    assert.strictEqual(stones.rows[0].n, 1, 'and no second stone may be conjured beside it');
  });

  await t.test('the backfill leaves a DELIBERATELY unsocketed stone alone', async () => {
    // Unsocketing carries a destroy roll, so a loose starting stone is a
    // choice the player paid for. Re-socketing it would override that; handing
    // over a SECOND one would duplicate it. Neither happens.
    const c = await createOnly('Cultist');
    await pool.query('UPDATE characters SET starting_loadout_granted_at = now() WHERE id = $1',
      [c.characterId]);
    await pool.query('DELETE FROM player_equipment WHERE character_id = $1', [c.characterId]);
    await pool.query('DELETE FROM player_items WHERE character_id = $1', [c.characterId]);
    await pool.query(
      `INSERT INTO player_items (character_id, item_type_id, quantity, soulbound)
       SELECT $1, id, 1, true FROM item_types WHERE name = 'apprentice staff'`, [c.characterId]);
    const loose = await pool.query(
      `INSERT INTO player_items (character_id, item_type_id, quantity, soulbound)
       SELECT $1, id, 1, true FROM item_types WHERE name = 'stone_of_apprentice staff' RETURNING id`,
      [c.characterId]);
    await pool.query('INSERT INTO stone_instances (player_item_id) VALUES ($1)', [loose.rows[0].id]);

    await backfillWornStartingKit(pool);

    const stones = await pool.query(
      `SELECT si.socketed_into_id FROM stone_instances si
         JOIN player_items pi ON pi.id = si.player_item_id
        WHERE pi.character_id = $1`, [c.characterId]);
    assert.deepStrictEqual(stones.rows, [{ socketed_into_id: null }],
      'exactly one stone, still loose: not re-socketed and not duplicated');
  });

  await t.test('the backfill ignores a character that has not claimed its loadout', async () => {
    // It will get the fully-worn version from grantStartingLoadout on its
    // first join instead, which is the path the per-class tests above cover.
    const c = await createOnly('Druid');
    const claim = await pool.query(
      'SELECT starting_loadout_granted_at FROM characters WHERE id = $1', [c.characterId]);
    assert.strictEqual(claim.rows[0].starting_loadout_granted_at, null,
      'createCharacter must not claim the loadout, or this test is vacuous');
    await pool.query(
      `INSERT INTO player_items (character_id, item_type_id, quantity, soulbound)
       SELECT $1, id, 1, true FROM item_types WHERE name = 'club'`, [c.characterId]);

    await backfillWornStartingKit(pool);

    const eq = await pool.query(
      'SELECT count(*)::int AS n FROM player_equipment WHERE character_id = $1', [c.characterId]);
    assert.strictEqual(eq.rows[0].n, 0);
  });
});
