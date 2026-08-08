// SOMET-253 Task 10: the live-wiring sweep. Every mechanic landed by Tasks
// 1-9 already has unit coverage for its own resolver (resolveBehavior,
// resolveAbility) and its own tick-time consumer (computeAuras, selectAbility,
// applyKnockback) -- but nearly every one of those tests either hand-builds
// `c.behavior` directly (case 1 of resolveInstanceBehavior in creatures.js,
// which bypasses the resolver entirely) or feeds resolveBehavior/resolveAbility
// a snake_case row without ever driving it into a live tick. That seam --
// between "the resolver reads this column" and "the tick actually sees the
// resolved value on the instance" -- is exactly where P2a's creature-behavior
// catalog shipped inert with a fully green suite, and where Task 2 of this
// same branch left the shot -> ProjectileSim.spawn field mapping uncovered
// until self-caught.
//
// Every test below starts from a row shaped EXACTLY like the real per-chunk
// world_creatures SELECT (server.js) or the real item_types SELECT (items.js)
// would return it -- snake_case columns, `abilities` as the JSON array
// ABILITIES_LATERAL's json_agg produces -- and drives it through the REAL
// loader function or the real addCreatures/tickCreatures/attack path. None of
// them construct a `{ behavior: {...} }` object by hand.
const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim, loadCreatureTypes } = require('../src/authority/creatures.js');
const { World } = require('../src/authority/world.js');
const { loadItemTypes } = require('../src/authority/items.js');
const { spawnDrops } = require('../src/authority/loot.js');

function openMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }
const noRedirect = () => 0.5; // > REDIRECT_CHANCE (0.02): no roam-direction noise
// chunkSize 8 -> span 800px (MAP_TILE_SIZE 100 * chunkSize 8); every fixture
// below places creatures/players inside x,y < 800, i.e. chunk (0,0).
const active = new Set(['0,0', '0,1', '1,0', '1,1']);

// A row shaped exactly like server.js's per-chunk world_creatures SELECT
// returns it: every column that SELECT names, snake_case, with `abilities`
// as the LATERAL join's json_agg array (also snake_case per ability). This is
// the ONE fixture shape every test below builds from -- never `c.behavior`.
function loaderCreatureRow(over = {}) {
  const abilities = over.abilities || [
    { slot: 1, name: 'Attack', attack_kind: 'melee', attack_range: 60, attack_cooldown: 1,
      projectile_speed: 0, projectile_radius: 0, element: null, damage_mult: 1, knockback: 0 },
  ];
  return {
    id: over.id, type: over.type || 'T', x: over.x, y: over.y,
    hp: over.hp ?? 100, facing: over.facing || 'S',
    home_x: over.home_x ?? null, home_y: over.home_y ?? null,
    level: over.level ?? 1, damage: over.damage ?? 5, blocks_portal_id: null,
    defense: over.defense ?? 0, color: over.color || '#fff', resistances: over.resistances || {},
    faction: over.faction || 'hostile', attack_element: over.attack_element || 'physical',
    behavior_name: over.behaviorName || 'T',
    aggro_radius: over.aggroRadius ?? 400, leash_radius: over.leashRadius ?? 800,
    chase_style: over.chaseStyle || 'charge', preferred_range: over.preferredRange ?? 0,
    move_speed_mult: over.moveSpeedMult ?? 1, damage_override: over.damageOverride ?? null,
    aura_radius: over.auraRadius ?? 0, aura_damage_mult: over.auraDamageMult ?? 1,
    aura_defense_mult: over.auraDefenseMult ?? 1, aura_speed_mult: over.auraSpeedMult ?? 1,
    behavior_gold_min: over.behaviorGoldMin ?? 0, behavior_gold_max: over.behaviorGoldMax ?? 0,
    abilities,
  };
}

// =============================================================================
// Mechanic 1: aura (creature_behaviors.aura_radius/aura_*_mult)
// =============================================================================
//
// creature_aura_resolve.test.js already proves resolveBehavior maps the aura
// columns; authority_creature_auras.test.js already proves computeAuras'
// non-stacking/non-self/non-mutation rules from a hand-built `c.behavior`.
// Neither proves a REAL loader row's aura_damage_mult ever reaches a live
// creature's dealt damage. This does, end to end: row -> addCreatures ->
// resolveInstanceBehavior -> resolveBehavior -> computeAuras -> tick's dmg
// calc -> the player's hp.
test('aura: a loader-shaped leader row buffs a same-faction follower\'s damage, by the ROW\'s own aura_damage_mult', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([
    loaderCreatureRow({
      id: 'leader', x: 100, y: 100, behaviorName: 'zzChampion', // centre (124,124)
      chaseStyle: 'hold', aggroRadius: 0, // never targets the player itself
      auraRadius: 300, auraDamageMult: 1.4, auraDefenseMult: 1, auraSpeedMult: 1,
    }),
    // 100px from the leader (inside the 300px aura, but NOT co-located with
    // it -- co-located would put the player at distance 0 from the LEADER
    // too, which satisfies even an aggroRadius-0 gate and lets the leader
    // land a second, unbuffed hit that corrupts this test's arithmetic).
    loaderCreatureRow({ id: 'follower', x: 200, y: 100, behaviorName: 'Line', damage: 10 }), // centre (224,124)
  ]);
  // Centre (224,124): distance 0 from the follower (an instant contact hit)
  // and distance 100 from the leader (outside its aggroRadius-0 gate).
  const player = { userId: 'u1', x: 192, y: 92, width: 64, height: 64, hp: 1000, maxHp: 1000 };
  s.tick(0.05, active, [player], 0);
  // 10 (follower's own row.damage) * 1 (ability.damage_mult) * 1.4 (the
  // LEADER row's own aura_damage_mult) -- a literal from the fixture, not
  // read back off any resolved object.
  assert.equal(player.hp, 1000 - 10 * 1.4,
    'the follower\'s hit must be scaled by the leader ROW\'s aura_damage_mult (1.4), proving the column '
    + 'survived resolveBehavior and reached computeAuras/tick from real loader-shaped input');
});

// =============================================================================
// Mechanic 2: multi-ability (creature_abilities via ABILITIES_LATERAL)
// =============================================================================
//
// authority_creatures_integration.test.js already proves the SQL text names
// every ability column AND that a loader-shaped abilities array lands on
// wolf.behavior.abilities with the right slot/range/kind/damageMult -- but it
// never checks `knockback`, never drives a real tick, and never proves the
// SAME instance selects a DIFFERENT ability (different element/cadence) once
// range changes. This does, through World.tickCreatures -> ProjectileSim,
// exactly the seam Task 2's own gap report named ("shot -> spawn field
// mapping").
test('multi-ability: a loader-shaped abilities array fires the melee slot up close and the cast slot at range, from the SAME instance', () => {
  const w = new World(openMap());
  w.addPlayer('u1', { x: 132, y: 92 }); // centre (164,124), 40px east of the creature -- inside slot 1's 60px range
  w.creatures.addCreatures([loaderCreatureRow({
    id: 'apex1', type: 'Apex', x: 100, y: 100, hp: 200, damage: 10, behaviorName: 'Apex',
    chaseStyle: 'hold', aggroRadius: 500, // 'hold': never moves, still attacks in range
    abilities: [
      { slot: 1, name: 'Claw', attack_kind: 'melee', attack_range: 60, attack_cooldown: 1,
        projectile_speed: 0, projectile_radius: 0, element: null, damage_mult: 1, knockback: 0 },
      { slot: 2, name: 'Firebreath', attack_kind: 'cast', attack_range: 300, attack_cooldown: 3,
        projectile_speed: 500, projectile_radius: 10, element: 'fire', damage_mult: 1.5, knockback: 90 },
    ],
  })]);

  w.tickCreatures(0.1, active);
  const p1 = w.getPlayer('u1');
  assert.ok(p1.hp < p1.maxHp, 'slot 1 (melee, range 60) must have landed at 40px');
  assert.equal(w.projectiles.count(), 0, 'a melee ability must never spawn a projectile');

  // Move the player to 150px east: outside slot 1's range, inside slot 2's.
  // Slot 1's cooldown (1s) has barely ticked down (dt 0.1) so it is NOT what
  // rules it out here -- range is.
  p1.x = 242; p1.y = 92; // centre (274,124)
  w.tickCreatures(0.1, active);
  assert.equal(w.projectiles.count(), 1, 'slot 2 (cast, range 300) must fire once slot 1 is out of range');
  const shot = w.projectiles.projectiles[0];
  const speed = Math.hypot(shot.vx, shot.vy);
  assert.ok(Math.abs(speed - 500) < 1e-9, `expected projectile_speed 500 from slot 2's own row, got ${speed}`);
  assert.equal(shot.radius, 10, 'projectile_radius must come from slot 2\'s row, not slot 1\'s (0)');
  assert.equal(shot.remaining, 300, 'range must come from slot 2\'s own attack_range');
  assert.equal(shot.element, 'fire', 'element must come from slot 2\'s own row, not the creature\'s attack_element (physical)');
  assert.equal(shot.knockback, 90, 'knockback must come from slot 2\'s own row, not slot 1\'s (0)');
  assert.equal(shot.damage, 10 * 1.5, 'damage must be row.damage (10) * slot 2\'s own damage_mult (1.5)');
});

// =============================================================================
// Mechanic 3: creature knockback (creature_abilities.knockback -> a shove)
// =============================================================================
//
// authority_knockback_integration.test.js already proves applyKnockback's
// call sites (both melee branches) shove correctly -- from a hand-built
// `c.behavior`. This proves the ability.knockback VALUE a real loader row
// carries (inside the JSON abilities array, not a top-level column) survives
// resolveAbility and actually displaces the target during tick().
test('creature knockback: a loader-shaped ability.knockback (inside the JSON abilities array) shoves the hit player', () => {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([loaderCreatureRow({
    id: 'basher', x: 100, y: 100, damage: 8, behaviorName: 'zzBasher', chaseStyle: 'hold', aggroRadius: 500,
    abilities: [{
      slot: 1, name: 'Slam', attack_kind: 'melee', attack_range: 60, attack_cooldown: 1,
      projectile_speed: 0, projectile_radius: 0, element: null, damage_mult: 1,
      knockback: 55, // the distinctive literal this test chases end to end
    }],
  })]);
  // Creature centre (124,124); player centre (164,124), 40px east -- within
  // the 60px range, and both share y so the push is pure +x (openMap is
  // fully walkable, so knockbackWithFallback always lands the full distance
  // on the first try).
  const player = { userId: 'u1', x: 132, y: 92, width: 64, height: 64, hp: 100, maxHp: 100 };
  s.tick(0.1, active, [player], 0);
  assert.ok(player.hp < 100, 'sanity: the hit must actually have landed');
  assert.strictEqual(player.x, 132 + 55,
    'the player must be shoved exactly 55px east -- the ability row\'s own knockback value, not a default');
  assert.strictEqual(player.y, 92, 'y must be unchanged -- the push is purely along x here');
});

// =============================================================================
// Mechanic 4: weapon knockback (item_types.knockback -> a shove)
// =============================================================================
//
// world_weapon_knockback.test.js already proves World.attack's shove logic --
// from a hand-built weapon Map, bypassing loadItemTypes entirely. items.js's
// own comment on this exact column warns this is precisely how P2a's trap
// shipped ("a column added to the schema but missing from an explicit SELECT
// list"). This drives the REAL loadItemTypes(pool) against a pg-shaped row
// (numeric columns as STRINGS, the way `pg` actually returns them) and then
// through World.attack's real shove.
test('weapon knockback: a pg-shaped item_types row threads loadItemTypes -> World.attack\'s shove', async () => {
  const row = {
    id: 1, name: 'zz-shove-dagger', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'melee',
    damage: '8', cooldown: '0.3', reach: '80', arc_width: '1.2', range: null, projectile_speed: null,
    projectile_radius: null, pierce: null, mana_cost: '0', stamina_cost: '0', element: null,
    defense: null, resistances: null, stackable: false, ammo_type_id: null, aoe_radius: null,
    vfx: null, knockback: '46', // pg returns `real`/`numeric` as strings -- the exact shape Number() must survive
  };
  const pool = { query: async (sql) => { assert.match(sql, /FROM item_types/i); return { rows: [row] }; } };
  const weapons = await loadItemTypes(pool);
  assert.strictEqual(weapons.get(1).knockback, 46, 'loadItemTypes must coerce the pg string into a number');

  const w = new World(openMap(), weapons, 1);
  w.addPlayer('u1', { x: 100, y: 100 }); // centre 132,132
  w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 999, facing: 'S', color: '#f00' }]);
  const startX = w.creatures.get('c1').x;
  const { kills } = w.attack('u1', 1, 0); // aim due east
  assert.deepEqual(kills, [], 'sanity: the high-hp wolf must survive the swing');
  const after = w.creatures.get('c1');
  assert.strictEqual(after.x, startX + 46,
    'the wolf must be shoved exactly 46px east -- the ROW\'s own knockback (a pg string), not a default or a hand-built Map value');
});

// =============================================================================
// Mechanics 5 & 6: rung drops and rung gold (behavior_drops / creature_behaviors.gold_*)
// =============================================================================
//
// loot_behavior_drops_db.test.js already proves the real SQL (a real
// behavior_id JOIN against the real schema) end to end against a live
// database -- that is the leg that needs an actual DB round-trip, and it is
// already covered there (skipped, loudly, without one). What's NOT covered
// anywhere is loadCreatureTypes' row -> Map wiring (behaviorDrops,
// behaviorGold) in isolation from the database, so this file's suite still
// exercises that JS mapping even on a machine with no DB reachable. Built
// from a row shaped exactly like loadCreatureTypes' own
// `entity_types e LEFT JOIN creature_behaviors b ... LEFT JOIN LATERAL` SELECT.
function loaderTypeRow(over = {}) {
  return {
    id: over.id, name: over.name, color: '#000', hp: 20, defense: 0, resistances: {},
    faction: 'hostile', gold_min: over.goldMin ?? 0, gold_max: over.goldMax ?? 0,
    attack_element: 'physical', behavior_id: over.behaviorId,
    behavior_name: over.behaviorName || 'zzRungProfile', aggro_radius: 400, leash_radius: 800,
    chase_style: 'charge', preferred_range: 0, move_speed_mult: 1, damage_override: null,
    aura_radius: 0, aura_damage_mult: 1, aura_defense_mult: 1, aura_speed_mult: 1,
    behavior_gold_min: over.behaviorGoldMin ?? 0, behavior_gold_max: over.behaviorGoldMax ?? 0,
    abilities: [],
  };
}

function fakeLootPool({ typeRows, behaviorDropRows = [], creatureDropRows = [] }) {
  let n = 0;
  return {
    query: async (sql, params) => {
      if (/FROM entity_types e/i.test(sql)) return { rows: typeRows };
      if (/FROM creature_drops WHERE entity_type_id/i.test(sql)) return { rows: creatureDropRows };
      if (/FROM behavior_drops WHERE behavior_id/i.test(sql)) return { rows: behaviorDropRows };
      // spawnDrops' own world_items INSERT ... RETURNING, for both item drops
      // and the gold pile -- echo back what a real INSERT would RETURN so
      // entry.world.groundItems.add() (and this test's own assertions) see
      // the row rather than silently adding nothing.
      if (/INSERT INTO world_items/i.test(sql)) {
        const [, itemTypeId, x, y, , quantity] = params;
        return { rows: [{ id: `zz-${++n}`, item_type_id: itemTypeId, x, y, expires_at: null, quantity }] };
      }
      return { rows: [] };
    },
  };
}

test('rung drops: a loader-shaped row wires behaviorDrops (type name -> behavior_id) through loadCreatureTypes into spawnDrops', async () => {
  const pool = fakeLootPool({
    typeRows: [loaderTypeRow({ id: 501, name: 'zzRungBoar', behaviorId: 9001 })],
    behaviorDropRows: [{ item_type_id: 42, chance: 1, min_qty: 1, max_qty: 1 }],
  });
  const {
    creatureTypeIds, creatureGold, behaviorGold, behaviorDrops,
  } = await loadCreatureTypes(pool);
  assert.equal(behaviorDrops.get('zzRungBoar'), 9001,
    'behaviorDrops must map the creature type NAME to its behavior_id, straight off the loader row');

  const added = [];
  const entry = {
    worldId: 'w-test', goldItemTypeId: null, creatureTypeIds, creatureGold, behaviorGold, behaviorDrops,
    world: { groundItems: { add: (rows) => added.push(...rows) } },
  };
  // rng forced to 0: chance 1 always rolls, min_qty === max_qty === 1 makes
  // quantity irrelevant -- this is purely about whether the rung row is
  // queried and rolled at all, given no creature_drops rows of its own.
  await spawnDrops(pool, entry, { type: 'zzRungBoar', x: 0, y: 0 }, { rng: () => 0 });
  assert.deepEqual(added.map((r) => r.item_type_id), [42],
    'a creature with zero drops of its own must still roll its rung fallback, sourced from the loader row\'s behavior_id');
});

test('rung gold: a loader-shaped row wires behaviorGold through loadCreatureTypes into spawnDrops, as the fallback when the type has none', async () => {
  const pool = fakeLootPool({
    typeRows: [loaderTypeRow({
      id: 502, name: 'zzRungWolf', behaviorId: 9002,
      goldMin: 0, goldMax: 0, // no gold range of its OWN
      behaviorGoldMin: 4, behaviorGoldMax: 4, // the rung's fallback range
    })],
  });
  const {
    creatureTypeIds, creatureGold, behaviorGold, behaviorDrops,
  } = await loadCreatureTypes(pool);
  assert.deepEqual(behaviorGold.get('zzRungWolf'), { min: 4, max: 4 },
    'behaviorGold must carry the loader row\'s own behavior_gold_min/behavior_gold_max, aliased apart from '
    + 'the type\'s own (zeroed) gold_min/gold_max');

  const added = [];
  const entry = {
    worldId: 'w-test', goldItemTypeId: 777, creatureTypeIds, creatureGold, behaviorGold, behaviorDrops,
    world: { groundItems: { add: (rows) => added.push(...rows) } },
  };
  await spawnDrops(pool, entry, { type: 'zzRungWolf', x: 10, y: 10 }, { rng: () => 0.5 });
  const goldRows = added.filter((r) => r.item_type_id === 777);
  assert.equal(goldRows.length, 1, 'exactly one gold world_item, from the rung fallback since the type range is empty');
  assert.equal(goldRows[0].quantity, 4, 'the rolled amount must come from the loader row\'s behavior_gold range (4), not 0/NaN');
});
