// SOMET-286 — the block cue, proven on a guard the LIVE loader produced.
//
// WHY THIS FILE EXISTS. guard_player_immunity.test.js proves the whole cue
// against `guardRow()`, a hand-built object whose header claims it is "a guard
// exactly as server.js loads one ... no behaviour profile of its own". That
// claim is false of the only guard in the game. The live `Village Guard`
// entity_type carries behavior_id -> creature_behaviors 'Guard'
// (chase_style 'guard'), so CREATURE_JOINED_SELECT hands
// resolveInstanceBehavior a row with `behavior_name` set, and it takes the
// resolveBehavior branch. `guardRow()` sets no behaviour columns at all, so it
// takes the OTHER branch -- the `faction === 'guard'` fallback meant for a
// creature whose type has no profile. Both branches happen to land on
// chaseStyle 'guard' today, so those 26 tests are green and the feature does
// work; but every one of them exercises a branch the running game never takes,
// which means none of them would notice if the live branch stopped producing a
// guard. That is the same "green suite, dead live path" shape SOMET-249 shipped
// once already, and creature_skittish_db.test.js was written to close for
// behaviours; this closes it for the guard rule the cue keys on.
//
// So the fixture here is not built, it is LOADED: a real world_creatures row of
// the real type, read back through the EXACT CREATURE_JOINED_SELECT text
// server.js exports (never a retyped copy -- retyping is how the two creature
// loaders drifted apart in the first place), fed through the same
// CreatureSim.addCreatures call activateChunk makes, and swung at through
// World.attack with the real item catalog and the real default weapon. Nothing
// on the path between the database row and the impact descriptor is stubbed.
//
// Fixture rows live in a world named zzGuardCueWorld and are deleted BY NAME,
// unconditionally, in a finally -- never by an id captured mid-test.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const { World } = require('../src/authority/world.js');
const { CREATURE_JOINED_SELECT } = require('../src/authority/server.js');
const { loadItemTypes, resolveDefaultWeaponId } = require('../src/authority/items.js');
const { CREATURE_SIZE } = require('../src/authority/creatures.js');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

const FIXTURE_WORLD = 'zzGuardCueWorld';
// The live level-150 guard block (world_creatures 3814199e... in Old Trailhead
// at the time of writing): the instance columns are what make the immunity
// worth having, and hp far above any one swing is what lets "took no damage"
// be an assertion rather than a rounding argument.
const GUARD_HP = 7005;
const GUARD_POST = { x: 3250, y: 3350 };

const openMap = () => ({
  chunkSize: 128, isWalkable: () => true, speedAt: () => 1, getChunk: () => [],
});

// Insert one real world_creatures row of `type`, read it back through the
// query the live tick reads, and hand the row straight to the live World --
// the activateChunk sequence, with the DB in the middle of it.
//
// The rows are pulled into memory BEFORE the fixture world is dropped, so the
// returned World is independent of the cleanup.
async function liveWorldWith(pool, rows) {
  const world = await pool.query(
    'INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id', [FIXTURE_WORLD],
  );
  const worldId = world.rows[0].id;
  let loaded;
  try {
    const ids = [];
    for (const r of rows) {
      const ins = await pool.query(
        `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y, level, damage, defense)
         VALUES ($1, $2, $3, $4, $5, 'S', $6, $7, $8, $9, $10) RETURNING id`,
        [worldId, r.type, r.x, r.y, r.hp, r.homeX, r.homeY, r.level, r.damage, r.defense],
      );
      ids.push(ins.rows[0].id);
    }
    const q = await pool.query(`${CREATURE_JOINED_SELECT} WHERE wc.id = ANY($1::uuid[])`, [ids]);
    assert.equal(q.rowCount, rows.length,
      'CREATURE_JOINED_SELECT did not find the fixture rows at all');
    loaded = { rows: q.rows, ids };
  } finally {
    // By name, unconditionally. world_creatures.world_id is ON DELETE CASCADE
    // (migration 1714440013000), so this alone removes the creature rows too.
    await pool.query('DELETE FROM worlds WHERE name = $1', [FIXTURE_WORLD]);
  }

  // The real catalog and the real default weapon, not a literal: the live
  // probe that prompted this file swung with an empty paper-doll, so
  // activeWeaponType fell back to defaultWeaponId (the dagger, reach 80 /
  // arc 0.6). Reproducing that exactly is the point.
  const itemTypes = await loadItemTypes(pool);
  const defaultWeaponId = resolveDefaultWeaponId(itemTypes);
  assert.ok(defaultWeaponId != null, 'the item catalog has no weapon to fall back to');
  const w = new World(openMap(), itemTypes, defaultWeaponId);
  w.addPlayer('u1', { x: 0, y: 0 });
  w.creatures.addCreatures(loaded.rows);
  // `rows` comes back too: addCreatures resolves the behaviour and keeps only
  // the resolved object, so the raw joined columns the branch is chosen ON
  // (behavior_name, chase_style) are only assertable here.
  return { world: w, ids: loaded.ids, rows: loaded.rows };
}

const guardFixture = (over = {}) => ({
  type: 'Village Guard',
  x: GUARD_POST.x - CREATURE_SIZE / 2, y: GUARD_POST.y - CREATURE_SIZE / 2,
  hp: GUARD_HP, homeX: GUARD_POST.x, homeY: GUARD_POST.y,
  level: 150, damage: 397.5, defense: 84.5, ...over,
});

// The control in every assertion below: a real HOSTILE type loaded through the
// identical path, standing where the guard stands. Without it a green "the
// guard took no damage" could just as easily mean the swing missed -- which is
// exactly how the live probe behind this ticket read as a dead feature.
const hostileFixture = (over = {}) => ({
  type: 'Slime',
  x: GUARD_POST.x - CREATURE_SIZE / 2, y: GUARD_POST.y - CREATURE_SIZE / 2,
  hp: GUARD_HP, homeX: null, homeY: null,
  level: 1, damage: 10, defense: 0, ...over,
});

// Stand the player squarely west of the target's CENTRE, half a reach away,
// and swing due east.
//
// The centre, not the row's x/y: `inArc` tests c.x + CREATURE_SIZE/2. Aiming at
// the top-left corner instead is a 47-degree error at melee range -- it misses
// the 0.6rad arc entirely and produces exactly the "hit:false, no impacts"
// frame this ticket was reported as. Both halves of that trap are asserted at
// the bottom of this file.
function swingAt(w, id) {
  const c = w.creatures.creatures.get(id);
  const p = w.getPlayer('u1');
  const weapon = w.weapons.get(w.defaultWeaponId);
  p.x = c.x + c.width / 2 - weapon.reach / 2 - p.width / 2;
  p.y = c.y + c.height / 2 - p.height / 2;
  return w.attack('u1', 1, 0);
}

test('guard block cue, on a guard the live loader produced', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  await t.test('the live Village Guard row carries a real behaviour PROFILE, which is the branch the hand-built fixture never takes', async () => {
    const { world, ids, rows } = await liveWorldWith(pool, [guardFixture()]);

    // The discriminating fact, asserted on the raw joined row because that is
    // literally resolveInstanceBehavior's branch condition
    // (`if (c.behavior_name != null) return resolveBehavior(c)`).
    // guard_player_immunity.test.js's guardRow() leaves this unset and reaches
    // chaseStyle 'guard' through the OTHER branch, the `faction === 'guard'`
    // fallback for a type with no profile at all. If entity_types.behavior_id
    // for Village Guard is ever cleared, or CREATURE_JOINED_SELECT stops
    // aliasing b.name AS behavior_name, this fails here rather than silently
    // in the running game.
    assert.equal(rows[0].behavior_name, 'Guard',
      'the live Village Guard row reached the sim with no behaviour profile -- either '
      + 'entity_types.behavior_id was cleared or CREATURE_JOINED_SELECT lost its '
      + 'b.name AS behavior_name alias, and the guard rule is now running on the '
      + 'faction fallback instead of the authored profile');
    assert.equal(rows[0].chase_style, 'guard',
      'CREATURE_JOINED_SELECT did not carry chase_style for the live guard row');

    const c = world.creatures.creatures.get(ids[0]);
    assert.equal(c.behavior.chaseStyle, 'guard',
      'the live guard row did not resolve chaseStyle \'guard\' through '
      + 'resolveInstanceBehavior -- immuneToPlayerDamage keys on exactly this, so the '
      + 'immunity AND its cue are both off');
  });

  await t.test('a swing that reaches the live guard is refused AND says so, with a b:true impact on the frame', async () => {
    const { world, ids } = await liveWorldWith(pool, [guardFixture()]);
    const r = swingAt(world, ids[0]);

    assert.equal(r.attacks[0].hit, false, 'the swing still did not land');
    assert.deepEqual(r.kills, []);
    assert.equal(world.creatures.creatures.get(ids[0]).hp, GUARD_HP,
      'the immunity itself must be untouched: a live guard takes nothing from a player');

    assert.equal(r.impacts.length, 1,
      'a swing that reached a LIVE guard emitted no impact -- the refusal is silent again, '
      + 'which is the whole of this ticket');
    const b = r.impacts[0];
    assert.equal(b.t, `c:${ids[0]}`);
    assert.equal(b.b, true, 'the blocked marker the client draws its shield glint from');
    assert.equal(b.v, undefined,
      'no effect NAME: the cue is built into the client so no vfx_effects edit can delete it');
    // Positioned on the GUARD (the weapon's own miss flourish is drawn at the
    // attacker's centre) and facing back down the aim vector, so the shield is
    // drawn on the struck side.
    assert.equal(b.x, GUARD_POST.x);
    assert.equal(b.y, GUARD_POST.y);
    assert.equal(b.nx, -1);
    assert.equal(b.ny, 0);
  });

  await t.test('the same swing at a live HOSTILE row lands, and its impact carries no blocked marker', async () => {
    const { world, ids } = await liveWorldWith(pool, [hostileFixture()]);
    const r = swingAt(world, ids[0]);

    assert.equal(r.attacks[0].hit, true,
      'sanity: a real hostile loaded the same way, standing in the same spot, must be a hit -- '
      + 'a red assertion here means the geometry is wrong and the guard result above proves nothing');
    assert.ok(world.creatures.creatures.get(ids[0]).hp < GUARD_HP, 'and it took damage');
    assert.equal(r.impacts.length, 1);
    assert.equal(r.impacts[0].b, undefined, 'an ordinary impact carries no blocked marker');
  });

  await t.test('one swing reaching a live guard AND a live hostile damages one and blocks the other', async () => {
    // The mixed case a per-swing boolean could not express, on loaded rows:
    // the hostile sits 20px east of the guard's centre, still inside the
    // dagger's reach and on the same aim axis.
    const { world, ids } = await liveWorldWith(pool, [
      guardFixture(),
      hostileFixture({ x: GUARD_POST.x + 20 - CREATURE_SIZE / 2 }),
    ]);
    const [guardId, hostileId] = ids;
    const r = swingAt(world, guardId);

    assert.equal(r.attacks[0].hit, true, 'the hostile in the same arc still makes this a landed swing');
    assert.deepEqual(r.impacts.filter((i) => i.b === true).map((i) => i.t), [`c:${guardId}`]);
    assert.deepEqual(r.impacts.filter((i) => i.b !== true).map((i) => i.t), [`c:${hostileId}`]);
    assert.equal(world.creatures.creatures.get(guardId).hp, GUARD_HP, 'the guard still took nothing');
  });

  await t.test('a player\'s SHOT through the live guard reports one block and no damage', async () => {
    // The other half of the cue (projectiles.js), on the same loaded row.
    // Driven through World.tickProjectiles because that is the boundary
    // server.js consumes: a step() producing blocks nobody forwarded is the
    // inert-field failure this ticket exists to avoid.
    const { world, ids } = await liveWorldWith(pool, [guardFixture()]);
    const c = world.creatures.creatures.get(ids[0]);
    const cy = c.y + c.height / 2;
    world.projectiles.spawn({
      ownerId: 'u1', x: c.x - 200, y: cy, nx: 1, ny: 0,
      weapon: {
        id: -1, name: 'probe bow', category: 'weapon', kind: 'ranged', damage: 40,
        range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1,
        element: null, knockback: 0,
      },
      damage: 40,
    });
    const out = world.tickProjectiles(0.3);

    assert.equal(out.blocks.length, 1,
      'a shot through a LIVE guard produced no block cue');
    assert.equal(out.blocks[0].t, `c:${ids[0]}`);
    assert.equal(out.blocks[0].b, true);
    assert.equal(world.creatures.creatures.get(ids[0]).hp, GUARD_HP,
      'and the shot still did no damage');
  });

  // ---------------------------------------------------------------------
  // The probe trap. A verification that aims at a creature's WIRE x/y sees
  // "hit:false, no impacts" and reads the feature as dead -- which is what
  // happened to this ticket after it merged. Both cases are pinned so the
  // distinction is written down somewhere executable rather than rediscovered.
  // ---------------------------------------------------------------------
  await t.test('aiming at the wire x,y instead of the centre misses the arc entirely (the false-negative that reads as an inert cue)', async () => {
    const { world, ids } = await liveWorldWith(pool, [guardFixture()]);
    const c = world.creatures.creatures.get(ids[0]);
    const p = world.getPlayer('u1');
    const weapon = world.weapons.get(world.defaultWeaponId);
    // Same stance the passing case uses: squarely west of the CENTRE, half a
    // reach away. Only the aim differs.
    p.x = c.x + c.width / 2 - weapon.reach / 2 - p.width / 2;
    p.y = c.y + c.height / 2 - p.height / 2;

    const pcx = p.x + p.width / 2, pcy = p.y + p.height / 2;
    const r = world.attack('u1', c.x - pcx, c.y - pcy); // c.x/c.y = the top-left the wire carries

    assert.equal(r.attacks[0].hit, false);
    assert.deepEqual(r.impacts, [],
      'aiming at the top-left corner is expected to miss -- if this ever produces an impact, '
      + 'the arc or the creature size changed and the note above is stale');
    assert.equal(world.creatures.creatures.get(ids[0]).hp, GUARD_HP);
  });
});
