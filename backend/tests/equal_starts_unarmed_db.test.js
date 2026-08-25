// SOMET-509 -- every character starts unarmed and identical, and unarmed is
// genuinely weak.
//
// WHAT THIS FILE REPLACED, AND WHY THAT MATTERS. It stands where
// starting_loadout_worn_by_every_class_db.test.js stood, which asserted the
// exact opposite: that each of the six classes joined WEARING an authored kit
// (SOMET-492/493/503). The product owner has since chosen equal starts -- no
// kit, no per-class weapon or armour, all differentiation from the passive tree
// and found gear. Keeping both files would have meant asserting both
// directions at once, so the old one is gone and this one carries its harness,
// its anti-vacuous stance and its measurement technique forward.
//
// THE DEFECT THE OLD FILE RECORDED AND COULD NOT FIX. Its own header ends:
// "The real defect is the fallback's tuning, not the Monk's weapon. It is out
// of scope here and is recorded so the next person does not re-derive it."
// This is that fix. items.js#DEFAULT_WEAPON_NAME was 'dagger', so a character
// holding nothing swung 8 damage on 0.30s -- 26.7 dps, free -- which was the
// STRONGEST option in the starting band and better than every kit the decision
// deletes. Remove the kits without touching that and every weapon a player
// finds becomes a downgrade from bare hands.
//
// THE NUMBERS, MEASURED ON THE LIVE CATALOG rather than assumed. SOMET-509
// itself named crude-blade (10.9 dps) as the floor of the starting band; that
// is wrong, and sizing unarmed against it would have left bare hands beating
// every wand in the game. Ascending, for weapons a level-1 character can equip:
//
//   crude-wand    5 / 0.70 =  7.1 dps   <- the real floor
//   crude-spear   8 / 0.80 = 10.0
//   crude-blade   6 / 0.55 = 10.9
//   iron-wand     8 / 0.70 = 11.4
//   storm staff  15 / 1.10 = 13.6
//   dagger        8 / 0.30 = 26.7       <- the old free fallback, still droppable
//
//   unarmed       3 / 0.60 =  5.0 dps, free in both pools
//
// Nothing below hardcodes that table. Every comparison is a query against
// item_types, so a rebalance that undercuts unarmed fails HERE rather than in
// play -- which is acceptance criterion 2 in as many words.
//
// WHY THE SETUP IS SO THIN. Twelve features in this codebase have shipped live
// in the database, drawn in the UI and inert in play, every one with a green
// suite. A test asserting `class_loadouts` is empty would be the thirteenth: it
// proves a table got cleared, not that a Warrior punches for 3. So nothing here
// inserts an item or equips anything to set up the per-class table -- a user
// row, createCharacter and a real websocket join are the whole setup, and every
// number is read back off the running sim (world.activeWeapon) or measured as
// an actual resource spend (world.attack). The two subtests that DO hand-build
// an inventory say so, and they are the ones proving the opposite direction:
// that a found weapon beats bare hands.
//
// assert.strictEqual / deepStrictEqual throughout, never assert.equal:
// `12 == '12'` is true, and a pg numeric arriving as a string has passed a
// loose assertion in this epic before.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');
const MigrationBuilder = require('node-pg-migrate/dist/migration-builder').default;

const { attachAuthority } = require('../src/authority/server.js');
const { createCharacter } = require('../src/services/characters.js');
const { DEFAULT_WEAPON_NAME } = require('../src/authority/items.js');
const { entryWorldForJoin } = require('./helpers/entryWorld.js');
const { SEED_ROWS } = require('./fixtures/weapon_catalog.js');
const equalStartsMigration = require('../migrations/1714440517000_equal_starts_no_starting_kit.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SECRET = 'somet509-test-secret';
const TAG = `s509_${process.pid}_${Date.now().toString(36)}`;

// The authored floor, as one literal. Every one of these is asserted against
// the live item_types row below, so the arithmetic in this file breaks loudly
// on a catalog change instead of quietly agreeing with itself.
const UNARMED = {
  name: 'unarmed', damage: 3, cooldown: 0.6, reach: 55, arc_width: 0.5,
  mana_cost: 0, stamina_cost: 0,
};
const UNARMED_DPS = UNARMED.damage / UNARMED.cooldown; // 5.0

// authority/world.js PLAYER_STAMINA_REGEN. Read here rather than imported
// because it is not exported; the assertion that uses it says what it assumes.
const PLAYER_STAMINA_REGEN = 10;

function nextMsg(ws, type, ms = 15000) {
  return new Promise((resolve, reject) => {
    const types = Array.isArray(type) ? type : [type];
    const to = setTimeout(() => reject(new Error(`timed out waiting for ${types.join('|')}`)), ms);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (types.includes(m.type)) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

test('equal starts: every character begins unarmed and identical',
  { skip: !DB_URL ? 'no database URL' : false }, async (t) => {
    const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000, max: 8 });
    try {
      await pool.query('SELECT 1');
    } catch (err) {
      await pool.end().catch(() => {});
      // Loud, not silent: a skipped run of this file verifies nothing, and this
      // is the file that proves the decision is not inert.
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

    // NOT `WHERE is_entry = true` (SOMET-505). That flag is globally exclusive
    // and peer test files borrow it onto throwaway worlds they then DELETE.
    const { id: entryWorldId } = await entryWorldForJoin(pool);

    const classRows = await pool.query('SELECT id, name FROM entity_types WHERE is_playable ORDER BY name');
    const classIdByName = new Map(classRows.rows.map((r) => [r.name, r.id]));
    assert.strictEqual(classIdByName.size, 6,
      'this file expects the six playable classes; a class added or removed must be looked at here');

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
    // so the measurement is about cost, not about the cooldown.
    function attackOnce(ctx) {
      ctx.player._attackCd = 0;
      const hp = ctx.player.hp;
      const mana = ctx.player.mana;
      const stamina = ctx.player.stamina;
      const projectiles = ctx.world.projectiles.count();
      ctx.world.attack(String(ctx.userId), 1, 0);
      return {
        hp: hp - ctx.player.hp, mana: mana - ctx.player.mana, stamina: stamina - ctx.player.stamina,
        // Unarmed is MELEE and puts nothing in projectiles, so the shared signal
        // is the cooldown stamp -- applyAttackCooldown runs on an attack that
        // went through, and a refusal is documented to cost nothing, cooldown
        // included. Both are checked so neither weapon kind is reported as
        // "fired" on the other's evidence.
        fired: ctx.world.projectiles.count() > projectiles || ctx.player._attackCd > 0,
      };
    }

    const CLASSES = [...classIdByName.keys()];
    const joined = {};

    // ---------------------------------------------------------------- AC 1 --
    await t.test('the catalog carries the authored `unarmed` row, and it IS the default weapon',
      async () => {
        // The two halves that make everything below mean something. If the
        // migration did not run, the row is missing and resolveDefaultWeaponId
        // silently falls through to "the first weapon in the catalog" -- which
        // on the real catalog is an arbitrary, possibly strong, weapon. That
        // would leave every other assertion in this file measuring something
        // nobody chose.
        assert.strictEqual(DEFAULT_WEAPON_NAME, UNARMED.name,
          'items.js must resolve the default weapon by this name; putting `dagger` back re-arms every empty hand');

        const r = await pool.query(
          `SELECT name, category, kind, damage, cooldown, reach, arc_width,
                  mana_cost, stamina_cost, value
             FROM item_types WHERE name = $1`, [UNARMED.name]);
        assert.strictEqual(r.rowCount, 1,
          'the live catalog has no `unarmed` row -- migration 1714440517000 has not run on this database');
        const row = r.rows[0];
        assert.strictEqual(row.category, 'weapon');
        assert.strictEqual(row.kind, 'melee');
        assert.strictEqual(Number(row.damage), UNARMED.damage);
        assert.strictEqual(Number(row.cooldown), UNARMED.cooldown);
        assert.strictEqual(Number(row.reach), UNARMED.reach);
        assert.strictEqual(Number(row.arc_width), UNARMED.arc_width);
        assert.strictEqual(Number(row.mana_cost), UNARMED.mana_cost);
        assert.strictEqual(Number(row.stamina_cost), UNARMED.stamina_cost);
        assert.strictEqual(Number(row.value), 0,
          'a stray unarmed instance must be worth nothing at a merchant');
      });

    await t.test('no class is handed a starting kit', async () => {
      // The catalog side of acceptance criterion 1, and the guard that makes
      // re-adding a grant visible (criterion 6). Rendered per row rather than
      // counted, so a failure names the class and the item.
      const r = await pool.query(
        `SELECT e.name AS class, i.name AS item, l.quantity, l.equip_slot
           FROM class_loadouts l
           JOIN entity_types e ON e.id = l.entity_type_id
           JOIN item_types  i ON i.id = l.item_type_id
          ORDER BY e.name, i.name`);
      assert.deepStrictEqual(
        r.rows.map((x) => `${x.class}:${x.item}x${x.quantity}${x.equip_slot ? `@${x.equip_slot}` : ''}`), [],
        'SOMET-509: no class may carry a loadout row');
      // Said over the raw table too: the JOIN above reports [] for a row whose
      // ids resolve to nothing, which is a different defect wearing the same green.
      const raw = await pool.query('SELECT count(*)::int AS n FROM class_loadouts');
      assert.strictEqual(raw.rows[0].n, 0, 'class_loadouts must be empty, not merely unresolvable');
    });

    for (const className of CLASSES) {
      await t.test(`a freshly created ${className} joins with empty hands and an empty bag`, async () => {
        const ctx = await createAndJoin(className);
        joined[className] = ctx;

        // The paper doll and the bag, in the DATABASE -- not just the in-memory
        // copy. A grant that only mutated the world object would come back on
        // the next login, which is the shape of half this epic's inert features.
        const eq = await pool.query(
          'SELECT count(*)::int AS n FROM player_equipment WHERE character_id = $1', [ctx.characterId]);
        assert.strictEqual(eq.rows[0].n, 0, `${className} must join with an EMPTY paper doll`);

        const bag = await pool.query(
          'SELECT count(*)::int AS n FROM player_items WHERE character_id = $1', [ctx.characterId]);
        assert.strictEqual(bag.rows[0].n, 0, `${className} must join with an EMPTY bag`);

        // ...and the running sim agrees. This is the assertion that goes red if
        // the dagger fallback is ever restored.
        const w = ctx.world.activeWeapon(String(ctx.userId));
        assert.ok(w, `${className} must resolve SOME weapon, or it cannot attack at all`);
        assert.strictEqual(w.name, UNARMED.name,
          `${className} resolved ${w.name}; a class holding nothing must fight unarmed`);
        assert.strictEqual(Number(w.damage), UNARMED.damage);
        assert.strictEqual(Number(w.cooldown), UNARMED.cooldown);
      });
    }

    await t.test('all six classes have IDENTICAL combat numbers, by value', async () => {
      // "Identical" asserted as one deep-equal over the whole set rather than
      // six comparisons against a literal: a bug that gave every class the same
      // WRONG weapon would pass the per-class tests above and fail here only if
      // the literal is included, so both are.
      const seen = CLASSES.map((c) => {
        const w = joined[c].world.activeWeapon(String(joined[c].userId));
        return {
          name: w.name,
          damage: Number(w.damage),
          cooldown: Number(w.cooldown),
          reach: Number(w.reach),
          arc_width: Number(w.arc_width),
          mana_cost: Number(w.mana_cost || 0),
          stamina_cost: Number(w.stamina_cost || 0),
        };
      });
      const want = {
        name: UNARMED.name,
        damage: UNARMED.damage,
        cooldown: UNARMED.cooldown,
        reach: UNARMED.reach,
        arc_width: UNARMED.arc_width,
        mana_cost: UNARMED.mana_cost,
        stamina_cost: UNARMED.stamina_cost,
      };
      assert.deepStrictEqual(seen, CLASSES.map(() => want),
        'every class must start on the same profile -- differentiation comes from the tree, not the start');
    });

    // ---------------------------------------------------------------- AC 5 --
    await t.test('no class is unable to attack, and the swing costs nothing', async () => {
      // Criterion 5, plus the reason unarmed is free: this is where a player
      // lands when the mana is gone or the quiver is empty, so a cost on the
      // floor would mean a drained player cannot act at all.
      for (const className of CLASSES) {
        const spent = attackOnce(joined[className]);
        assert.strictEqual(spent.fired, true, `${className} must actually be able to swing`);
        assert.strictEqual(spent.hp, 0, `${className} must not pay LIFE to punch`);
        assert.strictEqual(spent.mana, 0, `${className} must not pay MANA to punch`);
        assert.strictEqual(spent.stamina, 0, `${className} must not pay STAMINA to punch`);
      }
    });

    await t.test("the Cultist's life-cost identity is DORMANT at the start, and that is accepted", async () => {
      // SOMET-509 records this as an accepted consequence rather than a defect,
      // so it is asserted rather than left to be rediscovered as a surprise: a
      // Cultist that has found no magic weapon pays nothing, because it is
      // punching. The mechanic itself is unchanged and is covered end-to-end by
      // life_cost_live_join_db.test.js, which hand-builds a staff and a stone.
      //
      // This replaces cultist_starting_loadout_db.test.js, whose entire premise
      // -- "the join arms the Cultist: staff worn, spell stone socketed" -- is
      // what the decision removed.
      const spent = attackOnce(joined.Cultist);
      assert.strictEqual(spent.hp, 0,
        'a Cultist holding nothing pays no life: there is no spell to pay for yet');
      assert.strictEqual(joined.Cultist.player.usesLifeCost, true,
        'the Cultist must still BE a life-caster -- dormant is not the same as removed, and this is '
        + 'what makes the identity reappear the moment it finds a magic weapon');
    });

    // ---------------------------------------------------------------- AC 2 --
    await t.test('unarmed is worse than EVERY weapon a level-1 character can equip -- burst', async () => {
      // Criterion 2, asserted against real catalog values so a future weapon
      // edit that undercuts unarmed fails here rather than in play.
      // SCOPED TO AUTHORED WEAPONS, BY NAME, and that scoping is load-bearing.
      // `node --test` runs files in parallel and peers create throwaway weapon
      // types mid-run -- a 0-damage fixture staff named s496_..._staff_... made
      // an earlier version of this test fail on a weapon nobody ships. The
      // names come from tests/fixtures/weapon_catalog.js, the checked-in mirror
      // of the migrations, which authority_items_catalog.test.js holds honest
      // against the live database: a migration that adds a weapon without
      // listing it there goes red in THAT file, so this scoping cannot quietly
      // stop covering something.
      //
      // The VALUES are still read live, which is what criterion 2 asks for --
      // only the row SET is taken from the fixture.
      const authored = SEED_ROWS
        .filter((x) => x.category === 'weapon' && x.name !== UNARMED.name)
        .map((x) => x.name);
      const r = await pool.query(
        `SELECT name, damage, cooldown, (damage / cooldown) AS dps
           FROM item_types
          WHERE category = 'weapon' AND req_level <= 1 AND name = ANY($1::text[])
          ORDER BY damage / cooldown ASC`, [authored]);
      assert.ok(r.rows.length > 5,
        `only ${r.rows.length} authored level-1 weapons found; this comparison is not meaningful`);

      const undercut = r.rows.filter((x) => Number(x.dps) <= UNARMED_DPS);
      assert.deepStrictEqual(undercut.map((x) => `${x.name} ${Number(x.dps).toFixed(1)} dps`), [],
        `these weapons are no better than bare hands (${UNARMED_DPS.toFixed(1)} dps), so finding one `
        + 'is not an upgrade -- either the weapon or the unarmed profile is wrong');

      // And say what the margin actually is, so a change that erodes it to
      // nothing without crossing the line is still visible in the failure text.
      const floor = r.rows[0];
      assert.ok(Number(floor.dps) > UNARMED_DPS * 1.2,
        `the weakest level-1 weapon (${floor.name}, ${Number(floor.dps).toFixed(1)} dps) is within 20% of `
        + `unarmed (${UNARMED_DPS.toFixed(1)}); the floor has drifted and someone should choose deliberately`);
    });

    await t.test('unarmed is worse than every STAMINA weapon on sustained damage too', async () => {
      // The other half of criterion 2. A stamina weapon cannot swing on cooldown
      // forever: it settles at whatever rate regen pays for. Unarmed costs
      // nothing, so its sustained rate IS its burst rate and the comparison is
      // meaningful without a second number.
      //
      // Scoped to stamina deliberately. A MANA weapon's long-run rate is bounded
      // by mana regen and really can fall below unarmed once the pool is dry --
      // which is not a defect but the documented shape of the magic economy
      // (1714440514000's header), and precisely why unarmed costs nothing: an
      // empty caster still has a floor to fall back to.
      // Authored-only, for the same reason as the burst test above.
      const authored = SEED_ROWS
        .filter((x) => x.category === 'weapon' && x.name !== UNARMED.name)
        .map((x) => x.name);
      const r = await pool.query(
        `SELECT name, damage, cooldown, stamina_cost
           FROM item_types
          WHERE category = 'weapon' AND req_level <= 1
            AND stamina_cost > 0 AND mana_cost = 0
            AND name = ANY($1::text[])
          ORDER BY name`, [authored]);
      assert.ok(r.rows.length > 0, 'no level-1 stamina weapons found; this assertion is vacuous');

      const weak = [];
      for (const x of r.rows) {
        const swingsPerSecond = Math.min(1 / Number(x.cooldown), PLAYER_STAMINA_REGEN / Number(x.stamina_cost));
        const sustained = Number(x.damage) * swingsPerSecond;
        if (sustained <= UNARMED_DPS) weak.push(`${x.name} ${sustained.toFixed(1)} sustained dps`);
      }
      assert.deepStrictEqual(weak, [],
        `these weapons sustain no better than bare hands at ${PLAYER_STAMINA_REGEN} stamina/s regen`);
    });

    // ---------------------------------------------------------------- AC 3 --
    await t.test('picking up and equipping a starting-band weapon IS an upgrade, live', async () => {
      // Criterion 3 -- "the criterion that was inverted before" -- proven
      // through a real join rather than by arithmetic. This is one of the two
      // subtests that hand-builds an inventory, and it has to: there is no grant
      // left to do it, and a found weapon is exactly what the decision says
      // differentiation now comes from.
      //
      // crude-blade is the gear ladder's tier-1 melee rung: the weakest MELEE
      // thing a level-1 character can realistically find, so if this one is an
      // upgrade, everything above it is too.
      const c = await createOnly('Warrior');
      const found = await pool.query(
        `INSERT INTO player_items (character_id, item_type_id, quantity, soulbound)
         SELECT $1, id, 1, false FROM item_types WHERE name = 'crude-blade' RETURNING id`,
        [c.characterId]);
      assert.strictEqual(found.rowCount, 1, 'the catalog needs a crude-blade for this test to mean anything');
      await pool.query(
        "INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1, 'main_hand', $2)",
        [c.characterId, found.rows[0].id]);

      const ctx = await join(c);
      const w = ctx.world.activeWeapon(String(ctx.userId));
      assert.strictEqual(w.name, 'crude-blade', 'the equipped weapon must win over the unarmed fallback');

      const armedDps = Number(w.damage) / Number(w.cooldown);
      assert.ok(armedDps > UNARMED_DPS,
        `crude-blade sustains ${armedDps.toFixed(1)} dps against unarmed's ${UNARMED_DPS.toFixed(1)} -- `
        + 'finding a weapon must never be a downgrade');
      assert.ok(Number(w.damage) > UNARMED.damage,
        'and it must hit harder per swing, not merely faster');
    });

    // ---------------------------------------------------------------- AC 4 --
    await t.test('the change takes NOTHING away from a character that already has gear', async () => {
      // Criterion 4, proven with counts before and after, against a character
      // holding and WEARING items -- the state SOMET-503's backfill left 9 of 10
      // live characters in.
      //
      // The migration is applied for real, inside a transaction that is always
      // rolled back, using node-pg-migrate's own MigrationBuilder -- the same
      // technique migration_convert_magic_weapons_db.test.js uses, and for the
      // same reason: running its DELETE for real against a shared database is
      // exactly the kind of global mutation SOMET-508 just removed from this
      // suite.
      const c = await createOnly('Warrior');
      const owned = await pool.query(
        `INSERT INTO player_items (character_id, item_type_id, quantity, soulbound)
         SELECT $1, id, 1, true FROM item_types WHERE name IN ('short sword', 'leather-vest')
         RETURNING id`, [c.characterId]);
      assert.strictEqual(owned.rowCount, 2, 'setup: the character must actually hold two items');
      await pool.query(
        "INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1, 'main_hand', $2)",
        [c.characterId, owned.rows[0].id]);

      const countsFor = async (q) => {
        const items = await q.query(
          'SELECT count(*)::int AS n FROM player_items WHERE character_id = $1', [c.characterId]);
        const eq = await q.query(
          'SELECT count(*)::int AS n FROM player_equipment WHERE character_id = $1', [c.characterId]);
        return { items: items.rows[0].n, equipment: eq.rows[0].n };
      };

      const before = await countsFor(pool);
      assert.deepStrictEqual(before, { items: 2, equipment: 1 }, 'setup: two items, one worn');

      const client = await pool.connect();
      let rollbackFailed = false;
      try {
        await client.query('BEGIN');
        const pgm = new MigrationBuilder({}, {}, false,
          { debug() {}, info() {}, warn() {}, error() {} });
        equalStartsMigration.up(pgm);
        for (const sql of pgm.getSqlSteps()) await client.query(sql);

        const after = await countsFor(client);
        assert.deepStrictEqual(after, before,
          'the migration must not remove a single item or unequip a single slot');

        // ...and it really did the thing it is supposed to do, or the assertion
        // above would pass against a migration that did nothing at all.
        const kits = await client.query('SELECT count(*)::int AS n FROM class_loadouts');
        assert.strictEqual(kits.rows[0].n, 0, 'the migration must actually clear the kits');
      } finally {
        try {
          await client.query('ROLLBACK');
        } catch {
          rollbackFailed = true;
        }
        client.release(rollbackFailed);
      }
    });

    // ------------------------------------------------------- SOMET-335 -----
    await t.test('the seed list that would hand the kits back is empty', async () => {
      // SOMET-335's trap is the most likely way this decision gets undone: a
      // migration-authored fact that the SEEDER still knows about is silently
      // restored on the next re-seed, with the migration still recorded as
      // applied and every row-count test still green. That is why the change is
      // in seeds/data/entityTypes.js as well as in 1714440517000.
      //
      // Asserted here as the cheap, local, names-the-file guard. The expensive
      // half -- actually running seedCatalogs and proving class_loadouts is
      // still empty afterwards -- is NOT duplicated here: playable_classes_db
      // .test.js already runs the real seeder twice inside a rolled-back
      // transaction and asserts exactly that count. A second concurrent
      // transactional seedCatalogs bought no coverage and did add real lock
      // contention against the map-seeding suites.
      // eslint-disable-next-line global-require
      const { CLASS_LOADOUTS } = require('../seeds/data/entityTypes.js');
      assert.deepStrictEqual(CLASS_LOADOUTS, [],
        'CLASS_LOADOUTS must stay empty, or the next re-seed hands every class its kit back');
    });

    await t.test('the kit MECHANISM is intact, just unused', async () => {
      // SOMET-509 is explicit: keep the mechanism, delete only the data, so
      // restoring kits stays a data change rather than a re-implementation.
      // Without this, someone tidying up "dead" columns would drop equip_slot
      // and socket_into_item_type_id and every assertion above would stay green,
      // because an empty table satisfies them all.
      const client = await pool.connect();
      let rollbackFailed = false;
      try {
        await client.query('BEGIN');
        const ins = await client.query(
          `INSERT INTO class_loadouts (entity_type_id, item_type_id, quantity, equip_slot)
           SELECT e.id, i.id, 1, 'main_hand'
             FROM entity_types e, item_types i
            WHERE e.name = 'Warrior' AND i.name = 'short sword'
           RETURNING equip_slot, socket_into_item_type_id`);
        assert.strictEqual(ins.rowCount, 1, 'a worn-kit row must still be insertable');
        assert.strictEqual(ins.rows[0].equip_slot, 'main_hand');

        const socketed = await client.query(
          `INSERT INTO class_loadouts (entity_type_id, item_type_id, quantity, socket_into_item_type_id)
           SELECT e.id, s.id, 1, w.id
             FROM entity_types e, item_types s, item_types w
            WHERE e.name = 'Warrior' AND s.name = 'stone_of_apprentice staff'
              AND w.name = 'apprentice staff'
           RETURNING socket_into_item_type_id`);
        assert.strictEqual(socketed.rowCount, 1, 'a socketed-kit row must still be insertable');
        assert.ok(socketed.rows[0].socket_into_item_type_id != null);
      } finally {
        try {
          await client.query('ROLLBACK');
        } catch {
          rollbackFailed = true;
        }
        client.release(rollbackFailed);
      }
    });
  });
