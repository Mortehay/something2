// Server-side creature roaming — a port of the client CreatureManager roam
// logic (frontend/.../entities/CreatureManager.js), driven by the authority's
// active chunk set. Positions are world-space; active/AOI/prune key on the
// creature's CURRENT chunk (chunkOf), never its spawn chunk.
const { resolveMove, MAP_TILE_SIZE } = require('./collision');
const { chunkOf, CHUNK_KEY } = require('./coords');
const { inArc, hasLineOfSight } = require('./weapons');
const {
  applyDamageWithEffects, NO_MITIGATION, isProvokedBy, provoke, playerKey, creatureKey,
} = require('./damage');
const { resolveEffectName } = require('./vfx.js');
const { applyElementEffect, activeEffectKeys, canAct } = require('./effects');
const { resolveBehavior, DEFAULT_BEHAVIOR, DEFAULT_ABILITY } = require('../services/creatureBehaviors');
const { shoveAwayFrom } = require('./knockback');

const DIRS = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
const DIR_FACING = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
const CREATURE_SIZE = 48;
const CREATURE_SPEED = 40;    // world px/s
const REDIRECT_CHANCE = 0.02;

// SOMET-254: AGGRO_RADIUS/LEASH_RADIUS/CONTACT_RANGE/CREATURE_ATTACK_COOLDOWN
// are no longer read by any tick/behaviour-resolution code in this file --
// the Line profile in creature_behaviors (services/creatureBehaviors.js's
// DEFAULT_BEHAVIOR) is the live source of these values now. Kept exported
// (do not remove) because several tests still import them to derive
// world-space distances/timings without hardcoding the numbers a second
// time; CREATURE_DAMAGE stays live below (GUARD_DEFAULT_BEHAVIOR and the
// no-profile hostile path both still read it directly).
const AGGRO_RADIUS = 400;            // px: acquire nearest player within this
const LEASH_RADIUS = 800;            // px: drop a target beyond this
const CONTACT_RANGE = 60;            // px: creature may hit its target within this
const CREATURE_DAMAGE = 5;
const CREATURE_ATTACK_COOLDOWN = 1.0; // s

const GUARD_AGGRO_RADIUS = 400;   // px: a guard engages a hostile within this
const GUARD_LEASH_RADIUS = 300;   // px from HOME: guards hold the gate, they do not roam
const GUARD_DAMAGE = 25;
const GUARD_HOME_EPSILON = 24;    // px: close enough to the post to stand still

// SOMET-154 — walking home is not a straight line. A guard's post is INSIDE
// the village's wall ring, so a guard displaced outside the ring has its own
// wall between it and home: greedy "steer at the post" steering jams against
// that wall and the guard never returns, leaving the gate permanently
// unguarded (two live rows in Vale Crossing were stranded 1.6k and 3.7k px
// from their posts). These four numbers bound the recovery:
//
//  - STALL_TICKS: consecutive return ticks with no progress toward the current
//    goal before the guard stops steering blindly and asks for a real path.
//    12 ticks is 0.6s at the authority's 50ms tick — long enough that ordinary
//    wall-sliding (which DOES make progress) never triggers it.
//  - WAYPOINT_EPSILON: how close counts as "reached" for a path node. Must
//    comfortably exceed one tick's travel (2px at 50ms) so a guard cannot
//    step over a waypoint and oscillate.
//  - PATH_RANGE / PATH_BUDGET: the search box (in tiles, around the post) and
//    the hard expansion cap. A guard further from home than the box, or walled
//    into a sealed pocket, gets no path — and is put back on its post instead.
const GUARD_RETURN_STALL_TICKS = 12;
const GUARD_RETURN_PROGRESS_EPSILON = 2;  // px of closure that counts as progress
const GUARD_PATH_WAYPOINT_EPSILON = 30;   // px
const GUARD_PATH_RANGE = 64;              // tiles from home the search may reach
const GUARD_PATH_BUDGET = 20000;          // max tiles expanded per search
const GUARD_MAX_REPATHS = 3;              // failed path attempts before snapping home

// SOMET-295 — the same idea applied to the CHASE. Everything above recovers a
// guard that is walking home; none of it runs while a guard holds a target, so
// a guard that acquires a hostile it cannot walk to (across its own wall, on
// one of the three edges with no gate) jams against the inside of that wall and
// stays there. Measured on the live 6x4/gate-E village with the shipped Guard
// profile: 42 of ~90 hostile placements around the two posts left the guard in
// `mode: 'chase'`, out of its own strike range, and immobile for the last 500
// of 4000 ticks.
//
//  - CHASE_STALL_TICKS: consecutive chase ticks whose step was refused by the
//    terrain, with the target out of strike range, before the guard drops it.
//    40 ticks is 2s at the authority's 50ms tick — deliberately longer than the
//    0.6s return stall, because giving up on a chase too eagerly would undo
//    SOMET-291's rescue, and a guard walking on open ground never accumulates a
//    single tick of it.
//  - BLOCKED_FRACTION: how much of the requested step must arrive for the tick
//    to count as walking. resolveMove clamps per axis, so a step into a wall
//    still delivers its tangential part — open ground delivers all of it, a
//    45deg corner ~71%, a near-head-on wall a few percent. A quarter sits well
//    clear of both. Measuring the DELIVERED FRACTION rather than the guard's
//    displacement is what catches a wall-slide: chasing a roaming hostile along
//    the inside of a wall moves the guard every tick while getting it nowhere,
//    and the first version of this fix shipped with exactly that hole.
//  - UNREACHABLE_MS: how long a dropped target stays refused. Without the
//    refusal the guard re-acquires the same hostile on its very next tick and
//    oscillates between the wall and its post forever, which is a worse gate
//    than the jam. Five minutes rather than seconds because the excursion is
//    the expensive part: one round trip costs ~12s of unmanned gate, so a short
//    ban spends more time off station than on it. The ban lifts early only for
//    a hostile that starts fighting a player -- see isUnreachableFor.
const GUARD_CHASE_STALL_TICKS = 40;
const GUARD_CHASE_BLOCKED_FRACTION = 0.25;  // of the requested step that must arrive
const GUARD_UNREACHABLE_MS = 300000;      // ms a dropped target stays refused
const GUARD_UNREACHABLE_MAX = 32;         // per-guard cap on remembered targets

// Fallback behaviour for a guard-faction creature with no assigned profile --
// every hand-built test fixture, and any real world_creatures row whose
// entity_type has behavior_id NULL (server.js's per-chunk spawn loader DOES
// join creature_behaviors as of SOMET-249 fix round 1, but a NULL FK still
// resolves here, same as a row that never went through the join at all).
// Built from the SAME GUARD_AGGRO_RADIUS/GUARD_LEASH_RADIUS/GUARD_DAMAGE
// constants the tick used to read directly, so an unprofiled guard's
// behaviour is byte-identical to today's. This is what lets the guard branch
// below route on `bh.chaseStyle === 'guard'` instead of `c.faction ===
// 'guard'` without silently turning every guard with no assigned profile
// into a hostile (which is what a blind fallback to DEFAULT_BEHAVIOR/Line
// would do, since Line's chaseStyle is 'charge').
const GUARD_DEFAULT_BEHAVIOR = Object.freeze({
  ...DEFAULT_BEHAVIOR,
  name: 'Guard',
  aggroRadius: GUARD_AGGRO_RADIUS,
  leashRadius: GUARD_LEASH_RADIUS,
  chaseStyle: 'guard',
  damageOverride: GUARD_DAMAGE,
});

// Creature mitigation, built the same way a player's is built from equipment:
// from the entity type's defense/resistances. A creature without `mit` falls
// back to NO_MITIGATION inside applyDamage, which makes every resistance
// inert — so this must never return undefined.
function creatureMitigation(row) {
  const d = Number(row.defense ?? 0);
  return {
    defense: Number.isFinite(d) ? d : 0,
    resistances: row.resistances || {},
  };
}

// Abilities as one JSON array per creature, rather than a second round-trip
// or a row-multiplying join. ORDER BY a.slot inside the aggregate is
// load-bearing: slot order IS priority order, and json_agg over an unordered
// subquery would make a creature's move priority depend on physical row
// order. COALESCE covers a behaviour with no ability rows (json_agg of an
// empty set is NULL, not '[]').
//
// Written ONCE and used by BOTH creature-loading paths -- loadCreatureTypes
// below (the TYPE catalog) and server.js's per-chunk world_creatures SELECT
// (live INSTANCES). Two inline copies is how SOMET-249 nearly shipped its
// whole catalog inert with a fully green suite: every test builds creatures
// directly, so neither query is exercised by anything but its own guard test.
// Both aliases the fragment depends on -- the behaviour join being `b` -- are
// already true of both queries.
//
// The rationale stays OUT here as a JS comment rather than inside the
// template literal: both guard tests scan the live SQL TEXT for column names,
// and a name appearing only in a SQL comment satisfies the guard by itself.
const ABILITIES_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT COALESCE(json_agg(
             json_build_object(
               'slot', a.slot, 'name', a.name, 'attack_kind', a.attack_kind,
               'attack_range', a.attack_range, 'attack_cooldown', a.attack_cooldown,
               'projectile_speed', a.projectile_speed, 'projectile_radius', a.projectile_radius,
               'element', a.element, 'damage_mult', a.damage_mult, 'knockback', a.knockback
             ) ORDER BY a.slot
           ), '[]'::json) AS abilities
    FROM creature_abilities a WHERE a.behavior_id = b.id
  ) ab ON true`;

// Load the creature entity types. Named + exported (rather than inlined in
// server.js) so a guard test can assert the SELECT names every column the
// mapping consumes: a mapped column missing from the SELECT loads as
// undefined and silently disables the feature it feeds.
async function loadCreatureTypes(pool) {
  // LEFT JOIN, not INNER: entity_types.behavior_id is nullable and a creature
  // without a profile must still load, resolving to the Line fallback. An
  // INNER JOIN would make a creature vanish from the catalog entirely, which
  // fails silently -- it would simply never spawn.
  //
  // `ab.abilities` is the attack half of the profile as of SOMET-253 -- drop
  // it and every creature type resolves to the single default ability, i.e.
  // the whole abilities catalog goes inert with nothing appearing broken.
  // Task 3 dropped the parent row's own attack_kind/attack_range/
  // attack_cooldown/projectile_speed/projectile_radius columns entirely --
  // creature_abilities is the only place the attack lives now.
  //
  // SOMET-253 Task 4: b.gold_min/b.gold_max are aliased AS behavior_gold_min/
  // behavior_gold_max, unlike every other b.* column here, because this row
  // ALSO carries e.gold_min/e.gold_max (the entity type's own range, used by
  // creatureGold below) -- an unaliased pair would collide into a single
  // "gold_min" key with the later column silently winning, corrupting
  // creatureGold with the per-rung fallback instead of the per-creature
  // value. b.aura_* columns have no such collision and stay unaliased, same
  // as aggro_radius/leash_radius/etc above.
  const r = await pool.query(
    `SELECT e.id, e.name, e.color, e.hp, e.defense, e.resistances, e.faction,
            e.gold_min, e.gold_max, e.attack_element, e.behavior_id,
            b.name AS behavior_name,
            b.aggro_radius, b.leash_radius, b.chase_style, b.preferred_range,
            b.move_speed_mult, b.damage_override,
            b.aura_radius, b.aura_damage_mult, b.aura_defense_mult, b.aura_speed_mult,
            b.gold_min AS behavior_gold_min, b.gold_max AS behavior_gold_max,
            ab.abilities
     FROM entity_types e
     LEFT JOIN creature_behaviors b ON b.id = e.behavior_id${ABILITIES_LATERAL}
     WHERE e.is_creature = true ORDER BY e.id ASC`,
  );
  const creatureTypes = r.rows.map((row) => ({
    name: row.name,
    hp: row.hp,
    color: row.color,
    faction: row.faction || 'hostile',
    attackElement: row.attack_element || 'physical',
    // SOMET-254: this resolved `behavior` is not read by any live production
    // path -- the TYPE catalog built here (entry.creatureTypes) is stored on
    // the world entry in server.js but nothing downstream reads it back off
    // that entry; the actual live INSTANCES CreatureSim ticks come from
    // server.js's separate per-chunk world_creatures query, which resolves
    // its own behaviour via resolveInstanceBehavior. Kept (not deleted)
    // because authority_creatures_combat.test.js pins this resolution as a
    // correctness check on resolveBehavior/loadCreatureTypes in isolation.
    behavior: resolveBehavior(row),
    ...creatureMitigation(row),
  }));
  const creatureTypeIds = new Map(r.rows.map((row) => [row.name, row.id]));
  // Per-creature gold drop range, by name. Slice C: a killed creature drops a
  // random amount in [min, max] into the killer's wallet.
  const creatureGold = new Map(r.rows.map((row) => [row.name, {
    min: Number(row.gold_min) || 0,
    max: Number(row.gold_max) || 0,
  }]));
  // Per-rung gold FALLBACK, by creature type name, from the behaviour's own
  // gold_min/gold_max (aliased behavior_gold_min/behavior_gold_max above --
  // see the SELECT's comment for why the alias is load-bearing). loot.js's
  // spawnDrops picks this only when creatureGold's own range has max <= 0
  // (SOMET-253 Task 7) -- a creature with no gold range of its own still
  // pays out at its rung's rate, which is what lets P4 skip per-creature gold
  // authoring for all 288 rows.
  const behaviorGold = new Map(r.rows.map((row) => [row.name, {
    min: Number(row.behavior_gold_min) || 0,
    max: Number(row.behavior_gold_max) || 0,
  }]));
  // Per-rung DROP-TABLE lookup, by creature type name -> behavior_id (NOT the
  // drop rows themselves -- those live in `behavior_drops` and are queried
  // live, at kill time, by loot.js's spawnDrops, the same way creatureTypeIds
  // is used to query creature_drops). A creature with no assigned profile
  // (behavior_id NULL) maps to null here, and spawnDrops skips the rung query
  // entirely for it -- same "unknown/absent -> no drops" posture as an
  // entity_type name missing from creatureTypeIds.
  const behaviorDrops = new Map(r.rows.map((row) => [row.name, row.behavior_id]));
  // creatureTypes/creatureTypeIds stay COMPLETE (guards included): drops and
  // name→id lookups still need to see guards. The wild-spawn exclusion of
  // guard-faction types lives at the one place that still rolls a wild-spawn
  // pool -- worldPopulation.js's own `hostileTypes` filter -- not here; this
  // function no longer has a wild-spawn caller of its own (SOMET-246).
  return {
    creatureTypes, creatureTypeIds, creatureGold, behaviorGold, behaviorDrops,
  };
}

function center(o) { return { x: o.x + o.width / 2, y: o.y + o.height / 2 }; }

// Slice D (SOMET-161): stamp a creature's contact attack in the SAME shape a
// player swing produces (world.js's melee branch), so the client has one
// drawing path for both. Called from the two _attackCd contact sites.
//
// The effect name is resolved SERVER-side here exactly as it is for players --
// the client never holds the creature catalog either. A creature carries its
// bindings on `c.vfx` (entity_types.vfx, added by this slice's migration);
// with none, resolveEffectName falls to the creature kind default, which is
// why a wolf bite is visible even before anyone authors a binding for it.
//
// `reach`/`arc` are the contact geometry, not a weapon's: a creature has no
// item_types row. CONTACT_RANGE is the distance it actually had to close to
// land the hit, so the swing drawn is the swing that happened.
function stampCreatureAttack(attacks, impacts, c, target, from, to) {
  const nx0 = to.x - from.x;
  const ny0 = to.y - from.y;
  const len = Math.hypot(nx0, ny0) || 1;
  attacks.push({
    a: `c:${c.id}`,
    v: resolveEffectName({ kind: 'creature', vfx: c.vfx }, 'attack'),
    x: from.x, y: from.y,
    nx: nx0 / len, ny: ny0 / len,
    reach: CONTACT_RANGE,
    arc: 1.2,
    hit: true,          // a contact attack only stamps once it has landed
  });
  impacts.push({
    t: target.userId != null ? `p:${target.userId}` : `c:${target.id}`,
    x: to.x, y: to.y,
    v: resolveEffectName({ kind: 'creature', vfx: c.vfx }, 'impact'),
    el: 'physical',     // contact damage is always physical (see the sites)
  });
}
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }

// SOMET-314 — the player spawn sanctuary.
//
// WHY THIS IS ON THE ROAM PATH AND NOT IN PLACEMENT. The ticket reported a
// level-2 Slime camping the Old Trailhead spawn and killing level-1 characters
// on sight and again on every respawn, and proposed excluding hostile SPAWNS
// near the spawn point. Measured before writing this: replaying the real
// placement pass (placeMapCreatures + placeCreaturePacks, via the real world
// rows) over 200 seeds for all four worlds that carry an `entry_spawn` put
// ZERO hostiles inside aggro range of it -- the closest any seed ever came was
// 447px on Old Trailhead. Placement was never the mechanism, so a placement
// radius would have shipped as a no-op against the reported symptom.
//
// What IS the mechanism: creatures ROAM, and flushAndPrune persists where they
// roamed to every 3s (authority/server.js's creatureFlushTimer). In the live
// database 47042 of 48122 world_creatures rows still sit exactly on a tile
// centre -- the coordinate placement produces -- but of the three worlds that
// have actually been played, Old Trailhead has 0 of 77 rows on a tile centre,
// Vale Crossing 6 of 103 and Thornbriar Reach 5 of 63. Every creature in a
// played world has walked away from where it was placed. A hostile arrives at
// the spawn point by wandering there, which no placement rule can prevent.
//
// THE RULE: a wild hostile may not ROAM to within its own aggro radius (plus
// one tile) of the world's authored arrival point. So a player standing on the
// spawn is never acquired by something that merely wandered onto the doormat.
//
// The radius is per-creature rather than one flat number because aggro_radius
// is a per-behaviour catalog column spanning 180 (Lurker) to 600 (Apex): a flat
// radius tuned for a Slime world under-protects an Apex one, and one tuned for
// Apex carves a 6-tile dead zone out of every starter map. Each creature keeps
// exactly its own sight line clear and no more.
//
// The one-tile margin is not slack for its own sake. `chooseSpawn` returns the
// player's top-left corner while aggro is measured centre-to-centre, so the
// point this measures from is up to PLAYER_HALF (32px) off the centre the aggro
// check actually uses; and a roam step is only clamped at tick granularity, so
// without a margin a creature could end a tick sitting exactly on the aggro
// boundary. One tile covers both with room to spare.
//
// DELIBERATELY NOT APPLIED TO A CHASE. This is the same line services/
// safeRegion.js draws for placement and for the same reason: a hostile already
// chasing a player must be able to follow them home, or the sanctuary becomes
// an invisible wall and the village guards have nothing to rescue anyone from.
// Safety here is a property of the doormat, not of the player.
const SPAWN_SANCTUARY_MARGIN = MAP_TILE_SIZE;

// The world's authored arrival point in world pixels, or null when the world
// has none (81 of the 85 real worlds). Tolerates a map with no `.world` at all:
// every unit test in this file builds a stub map that is just
// { isWalkable, speedAt, chunkSize }, and those must keep roaming freely.
function spawnSanctuaryPoint(map) {
  const sp = map && map.world && map.world.entry_spawn;
  if (!sp || !Number.isFinite(sp.x) || !Number.isFinite(sp.y)) return null;
  return { x: sp.x, y: sp.y };
}

// MONOTONE, exactly like withinLeashBudget above, and for the same reason. A
// hard "destination must be outside" test would freeze solid every creature
// that is ALREADY inside the sanctuary -- and there are such creatures right
// now, persisted there by the flush this whole rule is about. Refusing only the
// steps that move CLOSER makes the boundary reflecting rather than absorbing:
// a roamer outside can never get in (any step from outside to inside is
// strictly closer than where it started), and one that starts inside random-
// walks its way back out instead of standing on the spawn tile forever.
//
// bh.aggroRadius falls back to the module default rather than being trusted:
// a hand-built behaviour without one gives NaN, every comparison against NaN is
// false, and this would silently refuse nothing at all -- the same failure mode
// leashAnchorOf's comment describes for leashRadius.
function roamsIntoSanctuary(spawn, bh, fromX, fromY, toX, toY) {
  const aggro = Number.isFinite(bh.aggroRadius) ? bh.aggroRadius : AGGRO_RADIUS;
  const radius = aggro + SPAWN_SANCTUARY_MARGIN;
  const to2 = dist2(toX, toY, spawn.x, spawn.y);
  if (to2 >= radius * radius) return false;
  return to2 < dist2(fromX, fromY, spawn.x, spawn.y);
}

// A guard with no home anchor is unconstrained (matches a hostile's
// leash-from-self behavior for creatures that predate the anchor column).
function withinLeash(x, y, home, radius) {
  if (!home) return true;
  return dist2(x, y, home.x, home.y) <= radius * radius;
}

// SOMET-290 — the MONOTONE form of withinLeash, and the one every DISPLACEMENT
// is measured against (a flee step, a shove). May this creature go from
// (fromX,fromY) to (toX,toY)?
//
// Allowed when the destination is no further from home than the larger of
//  (a) the leash radius -- the normal case: anywhere inside its own radius; and
//  (b) where it already was -- what keeps a creature that is ALREADY outside
//      its leash from being pushed further out while it walks back.
//
// (b) is not a nicety. A hard destination-only test refuses EVERY move for a
// creature outside its leash, which reads as a creature frozen solid: the guard
// clamp learned this in SOMET-283 (a stranded guard could never be shoved
// homeward again) and the skittish flee clamp shipped with the same shape --
// a knocked-out-of-its-pen creature stood rooted, and CALM, while a player
// stood inside its flee radius.
//
// A creature with no home is unconstrained, exactly as withinLeash treats one.
function withinLeashBudget(creature, fromX, fromY, toX, toY, radius) {
  const home = creature && creature.home;
  if (!home) return true;
  const budget2 = Math.max(radius * radius, dist2(fromX, fromY, home.x, home.y));
  return dist2(toX, toY, home.x, home.y) <= budget2;
}

// SOMET-283 — the post anchor a creature is held to, or null if it is free to
// be displaced anywhere.
//
// Deliberately keyed on the resolved BEHAVIOUR (`chaseStyle === 'guard'`) and
// not on `faction`, matching the tick's own routing: whether a creature is
// post-bound is catalog data, so a hostile that is given a home column stays
// freely shoveable and a guard-style creature stays anchored regardless of the
// faction string on its row. A guard with no home anchor is unconstrained,
// exactly as withinLeash above already treats one.
// THE definition of "this creature is a guard", used by every rule in this
// file that treats guards differently: the leash anchor (SOMET-283) and the
// player-damage immunity (SOMET-285) below, and the tick's own `bh.chaseStyle
// === 'guard'` routing that both of them mirror.
//
// Keyed on the resolved BEHAVIOUR and not on `faction`, for the reason the
// tick already gives: whether a creature is a guard is catalog data. This is
// deliberately the ONLY notion of guard-ness outside the tick -- a second
// predicate keyed on the faction string would drift from the branch that
// actually decides how a guard behaves, and would sweep in the portal/dungeon
// guards (services/dungeonGuards.js), which are ordinary hostile entity types
// with a home anchor and MUST stay killable or their portal never opens.
//
// Every creature reaching this predicate in production has been through
// addCreatures -> resolveInstanceBehavior, which always stamps a complete
// behaviour object, so `!bh` here means a hand-built object, never a real
// creature.
function isGuardCreature(creature) {
  const bh = creature && creature.behavior;
  return !!bh && bh.chaseStyle === 'guard';
}

// SOMET-285 — a player's damage cannot reach a guard.
//
// The exploit this closes: a guard never targets a player (selectGuardTarget
// takes hostiles only) and so never retaliates, and world_creatures carries no
// respawn path for one. Level 150 alone does not fix that, because
// applyDamage floors every hit at MIN_DAMAGE (1) no matter how far defence
// exceeds the raw damage -- so any amount of hp merely sets the length of a
// completely riskless grind (7005 swings at level 150, ~30 minutes with a
// knife). The only fix that is not a number is to remove the player from the
// guard's damage graph entirely.
//
// Applied at the two places a player's damage enters the creature sim --
// meleeArcTargets below (the whole melee arc: damage, riders, knockback and
// the client's hit/impact feedback all derive from that one list) and
// projectiles.js's projectileHitsCreature (both the swept direct hit and the
// AoE detonation) -- and nowhere else. In particular this is NOT applied
// inside applyDamage/damageCreatureById, which are shared with creature-owned
// damage: a guard must still be damageable BY a hostile, and must still damage
// hostiles itself.
function immuneToPlayerDamage(creature) {
  return isGuardCreature(creature);
}

// SOMET-290: keyed on the HOME ANCHOR alone now, not on guard-ness.
//
// The anchor was always the thing that mattered -- `isGuardCreature` was a
// proxy for "has a post", true of every anchored creature at the time. It
// stopped being one the moment a non-guard could be anchored: a penned skittish
// creature (SOMET-289) and the portal/vault guards (dungeonGuards.js,
// chests.js -- ordinary HOSTILE entity types with home_x/home_y) all belong
// somewhere, and dungeonGuards.js's own comment already claims a displaced one
// "still recovers back to defending the portal". A creature with no anchor is
// still shoved exactly as before, which is every wild spawn in the world.
function leashAnchorOf(creature) {
  const home = creature && creature.home;
  const bh = creature && creature.behavior;
  if (!home || !Number.isFinite(home.x) || !Number.isFinite(home.y)) return null;
  const radius = bh && Number.isFinite(bh.leashRadius) ? bh.leashRadius : GUARD_LEASH_RADIUS;
  return { home, radius };
}

// SOMET-283 — shove a CREATURE away from a point, honouring its post.
//
// knockback.js's shoveAwayFrom is pure geometry: it displaces anything with an
// x/y/width/height away from an origin, wall-aware but with no notion of where
// that thing belongs. That is the right shape for the primitive and it must
// stay that way -- the portal bounce and the player-vs-player shove have no
// leash to respect. The creature-domain rule ("a guard is anchored to its
// post") belongs here, next to withinLeash and the guard constants that define
// what a post IS.
//
// Why it exists: every melee weapon in the catalog carries knockback 30 and
// none of the three shove call sites (world.js's player melee, projectiles.js's
// direct hit and its AoE detonation) faction-filtered or leash-clamped. A
// guard never targets a player and so never retaliates, and its defense (10)
// exceeds the damage of every starter weapon, so applyDamage's MIN_DAMAGE floor
// caps a knife at 1 damage per swing -- 300 free swings against a 300hp guard,
// each one a 30px punt. That is a ~9000px displacement budget against a 300px
// leash, and it is how both of Vale Crossing's guards were persisted 1685px and
// 3755px off their posts (see SOMET-283 / SOMET-154).
//
// The rule is MONOTONE rather than a hard "inside the leash" test: a shove is
// committed only if it leaves the guard no further from its post than the
// larger of (a) its leash radius and (b) where it already was. (a) is the
// normal case -- a guard on station can be jostled anywhere inside its own
// radius, so hitting one still reads as connecting. (b) is what keeps a guard
// that is ALREADY displaced (a legacy row, a bad spawn) from being pushed
// further out while it walks home; without it the clamp would refuse every
// shove for such a guard, which is the same outcome but for the wrong reason
// and would silently stop applying the moment the guard re-entered its radius.
//
// All-or-nothing, like shoveAwayFrom itself: a shove that would break the leash
// is not scaled down to one that fits, it simply does not happen. A guard
// standing exactly on its leash edge therefore absorbs a hit entirely, which is
// the intended reading -- guards hold the gate.
//
// Non-guard creatures are untouched by this: the shove is applied and returned
// exactly as shoveAwayFrom would, so a hostile is still knocked back normally
// (SOMET-253).
function shoveCreature(map, fromX, fromY, creature, distance) {
  const anchor = leashAnchorOf(creature);
  if (!anchor) { shoveAwayFrom(map, fromX, fromY, creature, distance); return; }
  const beforeX = creature.x, beforeY = creature.y;
  const before = center(creature);
  shoveAwayFrom(map, fromX, fromY, creature, distance);
  const after = center(creature);
  // SOMET-290: the monotone rule described above, now the shared helper the
  // flee clamp uses too -- the two were the same rule written twice, and the
  // copy in the tick had lost the "no further than where it already was" half.
  if (!withinLeashBudget(creature, before.x, before.y, after.x, after.y, anchor.radius)) {
    creature.x = beforeX; creature.y = beforeY;
  }
}

// SOMET-154 — tile-grid path from a guard's current tile to its post, as
// world-space waypoints (tile centres). Breadth-first over 4-connected
// walkable tiles, so the first path found is a shortest one and no heuristic
// can send it the wrong way around a wall ring.
//
// 4-connected, not 8: a diagonal hop between two tile centres can cut a wall
// corner that resolveMove's per-axis clamp would refuse, which would hand back
// a path the guard cannot actually walk. Orthogonal hops are always walkable
// when both tiles are, because a 48px creature centred in a 100px tile keeps
// both of its leading-face corners inside the destination tile's row/column.
//
// Probing the tile CENTRE (rather than the guard's box) is the same reason:
// every waypoint is a centre, so the box always fits.
//
// Bounded twice over — a box of GUARD_PATH_RANGE tiles around the post AND a
// hard expansion budget — so a guard stranded in an unreachable pocket costs a
// fixed amount of work and then falls through to the caller's snap-home path,
// rather than flood-filling the world every time it stalls.
// One place clears the whole walk-home episode, so the three sites that end an
// episode (post reached, target acquired, guard repositioned) cannot each
// forget a different field — a stale `_homeBestD` alone would silently deny a
// guard its repath budget on its NEXT displacement.
function resetHomeWalk(c) {
  c._homePath = null;
  c._homeStall = 0;
  c._homeRepaths = 0;
  c._homeGoalKey = null;
  c._homeMarkD = Infinity;
  c._homeBestD = Infinity;
}

// SOMET-295 — the chase equivalent of resetHomeWalk. One place clears the whole
// chase-stall window, for the same reason: the three sites that end a chase
// episode must not each forget a different field.
//
//   _chaseTargetId  which target `_chaseStall` is counting FOR. The window
//                   restarts when the target changes, since a step refused on
//                   the way to one hostile says nothing about the next.
//   _chaseStall     consecutive chase ticks whose step the terrain refused
function resetChaseStall(c) {
  c._chaseTargetId = null;
  c._chaseStall = 0;
}

// The longest range at which this creature can act on a target at all. A guard
// standing in contact with a hostile, hitting it, is motionless and must never
// be read as stuck -- and the ability it would use may well be on cooldown at
// the instant we look, so this asks about REACH, not about `selectAbility`
// returning something right now.
function longestReach(bh) {
  let r = 0;
  for (const a of bh.abilities) if (a.attackRange > r) r = a.attackRange;
  return r;
}

// Is `target` currently refused to `guard` as unreachable? Two ways out of the
// ban, and the second is the one that protects the rescue:
//
//  - it ages out after GUARD_UNREACHABLE_MS, so nothing here is permanent even
//    if the geometry that caused it is;
//  - it lifts the instant the hostile starts FIGHTING A PLAYER. That is the
//    only movement a guard should break station for, and asking SOMET-291's own
//    rescue predicate is what keeps the two rules in step.
//
// It deliberately does NOT lift merely because the hostile moved. That was the
// first rule here and the running game killed it inside a minute: a ROAMING
// hostile clears any distance threshold within a second or two, so the guard
// re-acquired it, walked back to the wall, stalled, gave up, and did it again
// forever -- off station about half the time, which is a worse gate than the
// jam this ticket is about. A hostile that wanders somewhere genuinely
// reachable is therefore ignored until the ban ages out; the guard is standing
// on its post the whole time, and anything that actually attacks a player is
// answered immediately by the rescue lift above.
//
// `now` is treated as 0 when a caller does not supply it (selectGuardTarget is
// called directly by tests): that makes the age-out inert rather than
// accidentally clearing every ban, leaving the rescue test in charge.
function isUnreachableFor(guard, target, now, playersById) {
  const bans = guard._unreachable;
  if (!bans) return false;
  const rec = bans.get(target.id);
  if (!rec) return false;
  const t = Number.isFinite(now) ? now : 0;
  if (t >= rec.until) { bans.delete(target.id); return false; }
  if (engagingAPlayer(target, playersById, now)) { bans.delete(target.id); return false; }
  return true;
}

// Records the ban. Expired entries are swept on every write, and the map is
// dropped wholesale if it somehow still exceeds its cap -- a guard that has
// jammed on 32 distinct hostiles is in a situation no ban list is going to fix,
// and an unbounded per-creature Map on a long-lived server is a leak.
function banAsUnreachable(guard, target, now) {
  if (!guard._unreachable) guard._unreachable = new Map();
  const bans = guard._unreachable;
  const t = Number.isFinite(now) ? now : 0;
  for (const [id, rec] of bans) if (t >= rec.until) bans.delete(id);
  if (bans.size >= GUARD_UNREACHABLE_MAX) bans.clear();
  bans.set(target.id, { until: t + GUARD_UNREACHABLE_MS });
}

function tileCenterWalkable(map, col, row) {
  return map.isWalkable(col * MAP_TILE_SIZE + MAP_TILE_SIZE / 2,
    row * MAP_TILE_SIZE + MAP_TILE_SIZE / 2);
}

function findHomePath(map, fromX, fromY, home) {
  if (!home || typeof map.isWalkable !== 'function') return null;
  const startCol = Math.floor(fromX / MAP_TILE_SIZE);
  const startRow = Math.floor(fromY / MAP_TILE_SIZE);
  const goalCol = Math.floor(home.x / MAP_TILE_SIZE);
  const goalRow = Math.floor(home.y / MAP_TILE_SIZE);
  // Already in the post's own tile: there is nothing a path can add that the
  // direct step is not already doing.
  if (startCol === goalCol && startRow === goalRow) return null;

  const key = (col, row) => `${col},${row}`;
  const startKey = key(startCol, startRow);
  const prev = new Map();
  const seen = new Set([startKey]);
  let frontier = [[startCol, startRow]];
  let expanded = 0;
  let found = false;

  while (frontier.length > 0 && expanded < GUARD_PATH_BUDGET && !found) {
    const next = [];
    for (const [col, row] of frontier) {
      if (++expanded > GUARD_PATH_BUDGET) break;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = col + dc, nr = row + dr;
        if (Math.abs(nc - goalCol) > GUARD_PATH_RANGE) continue;
        if (Math.abs(nr - goalRow) > GUARD_PATH_RANGE) continue;
        const k = key(nc, nr);
        if (seen.has(k)) continue;
        seen.add(k);
        if (!tileCenterWalkable(map, nc, nr)) continue;
        prev.set(k, key(col, row));
        if (nc === goalCol && nr === goalRow) { found = true; break; }
        next.push([nc, nr]);
      }
      if (found) break;
    }
    frontier = next;
  }
  if (!found) return null;

  // Walk the parent chain back from the post and reverse it. The guard's OWN
  // tile centre is kept as the first waypoint: re-centring costs at most half a
  // tile and is what stops a guard whose box straddles a corner from clipping
  // the wall on its first step.
  const out = [];
  let k = key(goalCol, goalRow);
  while (k !== undefined) {
    const [col, row] = k.split(',').map(Number);
    out.push({ x: col * MAP_TILE_SIZE + MAP_TILE_SIZE / 2, y: row * MAP_TILE_SIZE + MAP_TILE_SIZE / 2 });
    if (k === startKey) break;
    k = prev.get(k);
  }
  out.reverse();
  return out.length > 0 ? out : null;
}

// SOMET-154's walk home, one step. Extracted verbatim from the guard branch by
// SOMET-290 so that a creature which is not guard-STYLE but does have a post
// (a penned skittish creature, a portal guard, a vault-chest guard -- all
// ordinary hostile entity types with home_x/home_y) recovers by the same rules
// instead of by a second, simpler copy that would re-learn SOMET-154's lessons
// the hard way: greedy steering alone strands a creature whose post is behind
// its own wall ring, and "did it move this tick" is not a usable definition of
// stuck.
//
// `cc` is the caller's PRE-move centre, passed in rather than recomputed for
// the same reason the tick reuses it elsewhere -- one measurement per tick.
//
// Returns 'home' when the creature is already on its post (or was just placed
// back on it) and 'walking' otherwise. The caller owns `c.mode`, because the
// mode names differ per branch: only a guard "guards".
function stepHome(map, c, bh, dt, cc) {
  const dx = c.home.x - cc.x, dy = c.home.y - cc.y;
  if (Math.hypot(dx, dy) <= GUARD_HOME_EPSILON) {
    // Home reached: forget the detour and the attempt budget, so the NEXT
    // displacement gets a full set of attempts of its own.
    resetHomeWalk(c);
    return 'home';
  }
  // SOMET-154. The step is aimed at the next PATH waypoint when the creature is
  // following a detour, and straight at the post otherwise. Reached waypoints
  // are dropped first, so `goal` is always somewhere it has not arrived at yet.
  if (c._homePath) {
    while (c._homePath.length > 0
           && Math.hypot(c._homePath[0].x - cc.x, c._homePath[0].y - cc.y) <= GUARD_PATH_WAYPOINT_EPSILON) {
      c._homePath.shift();
    }
    if (c._homePath.length === 0) c._homePath = null;
  }
  const goal = (c._homePath && c._homePath.length > 0) ? c._homePath[0] : c.home;
  const gx = goal.x - cc.x, gy = goal.y - cc.y;
  const goalD = Math.hypot(gx, gy);
  // The stall window restarts whenever the goal itself changes (a waypoint was
  // reached, or a new path was adopted), since the distance being watched is a
  // different distance from that tick on.
  const goalKey = `${goal.x},${goal.y}`;
  if (c._homeGoalKey !== goalKey) {
    c._homeGoalKey = goalKey;
    c._homeMarkD = goalD;
    c._homeStall = 0;
  }
  const r = movedWith(map, c, gx, gy, dt, bh.moveSpeedMult * c._buff.speedMult);
  // The step is committed only when it actually gets CLOSER to the goal.
  // resolveMove clamps each axis independently, so a blocked step still slides
  // along the wall — that slide is kept when it closes the gap (free
  // corner-rounding) and refused when it does not.
  //
  // Aiming straight at the post was already self-bounding (each axis points AT
  // the post and a 2px step cannot overshoot), so this gate changes nothing
  // without a path. It exists for the path-following case: a detour must still
  // only ever close on its own next waypoint.
  if ((r.x !== c.x || r.y !== c.y)
      && dist2(r.x + c.width / 2, r.y + c.height / 2, goal.x, goal.y) < goalD * goalD) {
    c.x = r.x; c.y = r.y;
    const f = facingFor(gx, gy); if (f) c.facing = f;
    c.dirty = true;
  }
  const nowC = center(c);

  // "Stuck" is MEANINGFUL closure over a window, not "did it move this tick". A
  // guard pinned flat against a wall whose post is a fraction of a pixel off
  // the wall's axis keeps shaving ~1e-9 px off its distance every tick forever:
  // a plain moved/didn't-move test reads that as progress, the recovery below
  // never runs, and the guard is stranded exactly as before. The first version
  // of this fix had that bug, and the W-bearing test caught it.
  const newGoalD = Math.hypot(nowC.x - goal.x, nowC.y - goal.y);
  if (newGoalD <= c._homeMarkD - GUARD_RETURN_PROGRESS_EPSILON) {
    c._homeMarkD = newGoalD;
    c._homeStall = 0;
  } else {
    c._homeStall += 1;
  }
  // The repath budget is earned back by real net closure on the POST (not on a
  // waypoint): a creature genuinely walking the long way round the ring keeps a
  // full budget, while one that is merely thrashing burns through it and gets
  // put back on its post below. Rounding a corner temporarily increases this
  // distance, which simply leaves the best-so-far untouched rather than
  // penalising it.
  const newHomeD = Math.hypot(nowC.x - c.home.x, nowC.y - c.home.y);
  if (newHomeD <= c._homeBestD - GUARD_RETURN_PROGRESS_EPSILON) {
    c._homeBestD = newHomeD;
    c._homeRepaths = 0;
  }

  if (c._homeStall >= GUARD_RETURN_STALL_TICKS) {
    // Steering alone cannot get this creature home. Ask for a real path around
    // whatever is in the way (in a village that is the guard's own wall ring,
    // and the way through is the gate; in a pen it is the fence).
    c._homeStall = 0;
    c._homeRepaths += 1;
    const path = c._homeRepaths <= GUARD_MAX_REPATHS
      ? findHomePath(map, nowC.x, nowC.y, c.home)
      : null;
    if (path) {
      c._homePath = path;
      c._homeGoalKey = null; // force the stall window to restart on the new goal
    } else {
      // No route exists inside the search box, or the creature has burned its
      // attempts and is still stuck. An unmanned gate (or an empty pen) defeats
      // the whole feature, so the post wins over the simulation here and the
      // creature is placed back on it.
      //
      // This can only fire for a creature that has been demonstrably immobile
      // for GUARD_RETURN_STALL_TICKS with no walkable route home — never
      // mid-fight (a creature with a target never reaches this code) and never
      // during ordinary knockback recovery on open ground (which makes progress
      // every tick and so never stalls).
      c.x = c.home.x - c.width / 2;
      c.y = c.home.y - c.height / 2;
      c.dirty = true;
      resetHomeWalk(c);
      return 'home';
    }
  }
  return 'walking';
}

// SOMET-291 — is this creature actually fighting a live player right now?
//
// The rescue predicate. Three ways a `_target` can look like an engagement and
// not be one, all of them refused here:
//
//  - a GUARD-styled creature's `_target` is a CREATURE id (`_targetKind ===
//    'creature'`). Creature ids and player userIds come from different tables
//    and can collide numerically, so the kind must be checked, not the value.
//    Tested for 'creature' rather than for 'player' on purpose: a hostile that
//    has not yet been through the acquisition path may still carry a null kind,
//    and refusing THAT would silently drop rescues.
//  - the target is stale: `_target` is only cleared on the creature's own next
//    tick, so a creature whose player has disconnected still holds their id.
//    Resolving it against the live player map is what makes this a fact rather
//    than a leftover. Without it both village guards abandon the gate to
//    intercept a hostile that is fighting nobody.
//  - the creature is skittish and not provoked BY THIS PLAYER -- a deer holds a
//    player in `_target` only so it knows who to back away from, and a guard
//    that reads that as an attack chases wildlife across the map while the real
//    attacker is ignored. SOMET-290's `isFleeingFrom` is that rule, and asking
//    it here rather than re-deriving it is what keeps the two in step.
//
// `playersById` absent means "nobody is hunting anyone", which is what makes
// every pre-SOMET-291 caller (and every test that omits it) byte-identical to
// the old nearest-first selection.
//
// `now` is the tick's world clock, threaded from tick()'s 4th parameter, and is
// deliberately NOT defaulted here beyond `undefined`: provocation now EXPIRES,
// so a caller that forgets the clock reads every provocation as long gone and a
// provoked skittish creature stops counting as a rescue. That failure direction
// is the safe one (no guard dispatched for wildlife, rather than guards sent
// chasing a deer), but it is still a bug, so every call site passes it.
function engagingAPlayer(creature, playersById, now) {
  if (!playersById || creature._target == null) return false;
  if (creature._targetKind === 'creature') return false;
  if (!playersById.has(creature._target)) return false;
  const bh = creature.behavior || DEFAULT_BEHAVIOR;
  return !isFleeingFrom(creature, bh, playerKey(creature._target), now);
}

// The hostile-faction creature a guard may engage: within aggroRadius of the
// guard AND within leashRadius of the guard's post, so a guard never locks onto
// something it is not allowed to chase.
//
// SOMET-291 — ordered by TWO keys, rescue first and distance second. A hostile
// that is currently fighting a player outranks a nearer one that is not, however
// much nearer: the whole point of a gate guard is that running to it works, and
// a guard that swats the closest wandering slime instead is the version of this
// feature that looks alive and rescues nobody.
//
// Distance still decides among equals, and the `<=` tie-break (a later
// equidistant candidate wins) is kept exactly as it was, so a field with no
// rescues in it resolves to precisely the target it resolved to before.
//
// The aggro cap is a separate constant rather than the running best, which the
// single-key version could fold together: with two keys a further rescue must
// still be admitted after a nearer non-rescue has been seen.
function selectGuardTarget({ guard, creatures, aggroRadius, leashRadius, playersById = null, now = undefined }) {
  const gc = center(guard);
  const aggro2 = aggroRadius * aggroRadius;
  let best = null, bestD2 = Infinity, bestRescue = false;
  for (const o of creatures) {
    // `creatures` may be a pre-loop snapshot: a candidate killed earlier this
    // same tick (by another guard) is still present in the array but its hp
    // was already driven to <=0 in place before removal from the sim, so
    // this guards against handing back a dead target.
    if (o === guard || o.faction !== 'hostile' || o.hp <= 0) continue;
    // SOMET-295: a hostile this guard has already proved it cannot reach is not
    // a candidate. Checked here rather than at the two call sites so that no
    // future third caller can acquire a banned target by forgetting to ask.
    if (isUnreachableFor(guard, o, now, playersById)) continue;
    const oc = center(o);
    if (!withinLeash(oc.x, oc.y, guard.home, leashRadius)) continue;
    const d2 = dist2(gc.x, gc.y, oc.x, oc.y);
    if (d2 > aggro2) continue;
    const rescue = engagingAPlayer(o, playersById, now);
    if (best === null
        || (rescue && !bestRescue)
        || (rescue === bestRescue && d2 <= bestD2)) {
      best = o; bestD2 = d2; bestRescue = rescue;
    }
  }
  return best;
}
// Applied at the call site, not by mutating c.speed: a persisted speed would
// compound every tick.
function movedWith(map, c, vx, vy, dt, mult) {
  if (mult === 1) return resolveMove(map, c, vx, vy, dt);
  return resolveMove(map, { ...c, speed: c.speed * mult }, vx, vy, dt);
}

// Pack-leader auras (SOMET-253 Task 5). Recomputed from scratch every tick and
// never persisted: a leader's death removes its buff on the next tick with no
// cleanup path, so the failure mode where a buff outlives its source cannot
// occur.
//
// NON-STACKING: the strongest single value wins per stat. Two overlapping
// Champions must not compound into a 1.5625x damage pack -- that is the
// difference between a hard fight and an unwinnable one.
//
// A leader does not buff itself.
//
// O(leaders x creatures). Leaders are rare and MAX_WORLD_CREATURES bounds the
// inner term, so this stays cheap without an index.
function computeAuras(creatures) {
  const buffs = new Map();
  const leaders = [];
  for (const c of creatures) {
    const bh = c.behavior || DEFAULT_BEHAVIOR;
    if (bh.auraRadius > 0 && c.hp > 0) leaders.push({ c, bh });
  }
  if (leaders.length === 0) return buffs;
  for (const { c: leader, bh } of leaders) {
    const lc = center(leader);
    const r2 = bh.auraRadius * bh.auraRadius;
    for (const other of creatures) {
      if (other === leader || other.hp <= 0) continue;
      if (other.faction !== leader.faction) continue;
      const oc = center(other);
      if (dist2(lc.x, lc.y, oc.x, oc.y) > r2) continue;
      const cur = buffs.get(other.id);
      if (!cur) {
        buffs.set(other.id, {
          damageMult: bh.auraDamageMult,
          defenseMult: bh.auraDefenseMult,
          speedMult: bh.auraSpeedMult,
        });
      } else {
        // Math.max, never multiplication -- this line IS the non-stacking rule.
        cur.damageMult = Math.max(cur.damageMult, bh.auraDamageMult);
        cur.defenseMult = Math.max(cur.defenseMult, bh.auraDefenseMult);
        cur.speedMult = Math.max(cur.speedMult, bh.auraSpeedMult);
      }
    }
  }
  return buffs;
}

// The neutral buff every creature gets when no leader's aura reaches it.
// Frozen and shared (never cloned per-creature) since it is only ever read,
// never written -- `c._buff = buffs.get(c.id) || NO_BUFF` in tick() below.
const NO_BUFF = Object.freeze({ damageMult: 1, defenseMult: 1, speedMult: 1 });

// Aura-buffed defense at the use site, following movedWith's precedent above:
// never mutate target.mit itself, compute the buffed value where damage is
// applied. A small helper keeps the four damage-taken call sites (the guard
// branch's target, applyAttack, applyMeleeArc, damageCreatureById) from each
// rebuilding `{ defense, resistances }` by hand and drifting apart.
// `target._buff` may be unset (a creature attacked before its first tick())
// -- NO_BUFF covers that the same way `c.mit || NO_MITIGATION` already covers
// a creature with no mitigation at all.
function effectiveMit(target) {
  const mit = target.mit || NO_MITIGATION;
  const mult = (target._buff || NO_BUFF).defenseMult;
  if (mult === 1) return mit;
  return { defense: mit.defense * mult, resistances: mit.resistances };
}

// The single place addCreatures decides an instance's behaviour, so every
// caller -- server.js's real per-chunk spawn loader AND every hand-built test
// fixture -- goes through the same rule instead of each guessing at a
// fallback of its own.
//
// Priority:
//  1. `c.behavior` is already a resolved camelCase object (a test fixture
//     that builds one directly, e.g. the "supplied behaviour overrides the
//     module constants" test; Tasks 7/9 will build these too). Spread onto
//     DEFAULT_BEHAVIOR rather than used verbatim -- services/creatureBehaviors.js's
//     whole reason to exist is that CreatureSim never sees a partial
//     behaviour, and a hand-assembled object is exactly the kind of input
//     that can omit a field. A `.behavior` missing `moveSpeedMult` would give
//     `c.speed * undefined` = NaN in movedWith, so `isWalkable(NaN, ...)` is
//     false and the creature stands still forever with no error; missing
//     `attackRange` makes the contact-range comparison always false, so it
//     never attacks. Both are silent-freeze failures, the exact class this
//     sub-project exists to eliminate.
//  2. `c.behavior_name` is non-null -- the row came from a real LEFT JOIN
//     against creature_behaviors that actually found a profile (server.js's
//     spawn loader, or a test fixture shaped like its query result). Resolved
//     through resolveBehavior, which already guarantees a complete object
//     (never partial), and honored exactly, including a genuinely
//     Line-shaped or 'charge'-style guard, because that is a deliberate
//     catalog assignment, not an absence.
//  3. Nothing usable was supplied -- either the row's behavior_id was NULL
//     (a LEFT JOIN that found no profile) or the caller never selected the
//     behaviour columns at all (every pre-P2a call site, every hand-built
//     test fixture, the golden trace fixture). Falls back BY FACTION rather
//     than blindly to Line: `behavior_name` is the exact alias resolveBehavior
//     reads, so this is the one column whose absence proves "no profile",
//     matching the comment on GUARD_DEFAULT_BEHAVIOR above.
//
// The abilities array gets the same treatment as the movement fields in case
// 1, and for the same reason: a hand-built ability missing `attackCooldown`
// would stamp `undefined` into _abilityCd, `undefined > 0` is false, and the
// creature attacks every single tick forever. Each supplied ability is
// completed from DEFAULT_ABILITY and the array is slot-sorted, mirroring
// resolveAbilities (which cannot be reused here: it reads snake_case DB keys,
// while a `.behavior` object is already camelCase).
function completeAbilities(list) {
  if (!Array.isArray(list) || list.length === 0) return DEFAULT_BEHAVIOR.abilities;
  return list.map((a) => ({ ...DEFAULT_ABILITY, ...a })).sort((x, y) => x.slot - y.slot);
}

function resolveInstanceBehavior(c) {
  if (c.behavior) {
    return {
      ...DEFAULT_BEHAVIOR,
      ...c.behavior,
      abilities: completeAbilities(c.behavior.abilities),
    };
  }
  if (c.behavior_name != null) return resolveBehavior(c);
  // SOMET-254: spread-copy GUARD_DEFAULT_BEHAVIOR here rather than handing
  // out the shared frozen module singleton directly -- matches the hostile
  // branch's `{ ...DEFAULT_BEHAVIOR }` right beside it, so every unprofiled
  // creature (guard or hostile) gets its own per-instance object regardless
  // of faction. Nothing in this file writes through a resolved `bh` today,
  // so this was not an active bug, but the two branches disagreeing on
  // mutability posture was a trap for the next call site that does: a future
  // write to a resolved guard behaviour would have thrown (the module
  // singleton is frozen), while the same write on a resolved hostile
  // behaviour would have silently succeeded and corrupted only that one
  // creature's copy -- two different failure modes for what should be the
  // same operation. `GUARD_DEFAULT_BEHAVIOR` itself stays frozen as the
  // template; only the value handed to each creature is now a fresh copy.
  return (c.faction || 'hostile') === 'guard' ? { ...GUARD_DEFAULT_BEHAVIOR } : { ...DEFAULT_BEHAVIOR };
}

// Deterministic: no rng. Among abilities whose cooldown has elapsed AND whose
// range covers `dist`, the LOWEST slot wins. Returns null when nothing
// qualifies -- the creature then fires nothing rather than falling back to
// slot 1, which would let an out-of-range creature hit from anywhere.
//
// `bh.abilities` is already slot-sorted (by resolveAbilities for a DB row, by
// completeAbilities for a hand-built one), so the first match IS the lowest
// slot.
//
// Cooldowns live on the INSTANCE (c._abilityCd), never on the shared
// behaviour object: one behaviour object is handed to every creature of a
// type, so a cooldown stored there would make one wolf's bite silence the
// whole pack.
function selectAbility(c, bh, dist) {
  for (const a of bh.abilities) {
    if ((c._abilityCd.get(a.slot) || 0) > 0) continue;
    if (dist > a.attackRange) continue;
    return a;
  }
  return null;
}

// The farthest an ability reaches, ignoring cooldowns. Used by `kite` for the
// outer edge of its stand-and-shoot band, which is a property of the
// creature's REPERTOIRE and not of which slot is ready this tick -- gating it
// on readiness would make a kiter walk forward the instant it fires and back
// off again the instant it recovers, the exact oscillation the middle band
// exists to prevent. With one ability this equals that ability's range, which
// is what the golden trace pins.
function maxAbilityRange(bh) {
  let max = 0;
  for (const a of bh.abilities) if (a.attackRange > max) max = a.attackRange;
  return max;
}

// True when ANY ability is off cooldown. `skirmish` retreats while its attack
// is recovering; with one ability this is identical to the old `_attackCd > 0`
// test, which is what keeps the golden trace green.
function anyAbilityReady(c, bh) {
  return bh.abilities.some((a) => (c._abilityCd.get(a.slot) || 0) <= 0);
}

// SOMET-290 — the two states a skittish creature can be in, as ONE predicate.
//
// "Prey right now, with respect to THIS actor." A skittish creature that has
// been hurt fights the actor that hurt it and nobody else: `isProvokedBy`
// (damage.js, which owns the `_provokedBy` record) is what makes the
// distinction, and routing every read through here is what stops the rule from
// being re-derived — the tick needs it three times in one pass (the movement
// band, the leash clamp, the attack gate) and the cornered rule writes
// provocation mid-tick, so three independent reads would have a creature flee,
// discover it is cornered, and bite in the same tick from its pre-flee
// distance.
//
// Every other chase style is never fleeing, whatever it has been hit by.
function isFleeingFrom(creature, bh, actorKey, now) {
  return bh.chaseStyle === 'skittish' && !isProvokedBy(creature, actorKey, now);
}

// Nearest DIRS index for a movement vector's signs → facing.
function facingFor(vx, vy) {
  const sx = Math.sign(vx), sy = Math.sign(vy);
  for (let i = 0; i < DIRS.length; i++) if (DIRS[i][0] === sx && DIRS[i][1] === sy) return DIR_FACING[i];
  return null;
}

class CreatureSim {
  constructor(map, rng = Math.random) {
    this.map = map;
    this.rng = rng;
    this.chunkSize = map.chunkSize;
    this.creatures = new Map(); // id -> creature
  }

  addCreatures(list) {
    for (const c of list) {
      if (this.creatures.has(c.id)) continue;
      const dirIdx = Math.min(DIRS.length - 1, Math.floor(this.rng() * DIRS.length));
      this.creatures.set(c.id, {
        id: c.id, type: c.type, x: c.x, y: c.y,
        width: CREATURE_SIZE, height: CREATURE_SIZE, speed: CREATURE_SPEED,
        facing: c.facing || 'S', hp: c.hp, maxHp: c.hp, color: c.color,
        mit: creatureMitigation(c),
        // Slice D: effect bindings from entity_types.vfx, normalized to null
        // so stampCreatureAttack never sees undefined. A creature with none
        // falls to the `creature` kind default and is still visible.
        vfx: c.vfx || null,
        // Persisted per instance (world_creatures.level/.damage), already
        // scaled at spawn -- the sim never rescales. The fallbacks cover
        // rows written before the level migration and unit-test fixtures.
        level: Number.isInteger(c.level) ? c.level : 1,
        damage: Number.isFinite(c.damage) ? Number(c.damage) : CREATURE_DAMAGE,
        _dir: dirIdx, dirty: false,
        faction: c.faction || 'hostile',
        home: (Number.isFinite(c.home_x) && Number.isFinite(c.home_y))
          ? { x: c.home_x, y: c.home_y }
          : null,
        // Which portal (map_links.id) this creature gates, or null for every
        // ordinary creature. Loaded the same way `home` is above -- a raw DB
        // column carried straight onto the in-memory object at load time,
        // never recomputed.
        blocksPortalId: c.blocks_portal_id || null,
        // Resolved once here -- from an already-resolved object, a raw joined
        // DB row, or a faction-aware fallback -- and carried onto the
        // instance the same way `mit`, `level` and `damage` are: attached
        // once, never recomputed inside the tick. See resolveInstanceBehavior.
        behavior: resolveInstanceBehavior(c),
        // c.attackElement covers an already-shaped instance; c.attack_element
        // is the raw column name server.js's SELECT aliases it as (et.attack_element).
        attackElement: c.attackElement || c.attack_element || 'physical',
        _target: null, _targetKind: null, mode: 'roam',
        // SOMET-154 walk-home state, in the cleared shape resetHomeWalk gives
        // it. Written by stepHome, which SOMET-290 made shared: the guard
        // branch's return step and the hostile path's walk-home block both go
        // through it. A creature with no `home` never reaches either, so an
        // unanchored one does keep these defaults forever.
        //   _homePath   remaining waypoints (tile centres) to the post
        //   _homeStall  return ticks since the last meaningful closure
        //   _homeRepaths path searches since the guard last closed on its post
        //   _homeGoalKey which point _homeMarkD is measured against
        //   _homeMarkD  distance to that goal when the stall window opened
        //   _homeBestD  best distance to the POST reached this episode
        _homePath: null, _homeStall: 0, _homeRepaths: 0,
        _homeGoalKey: null, _homeMarkD: Infinity, _homeBestD: Infinity,
        // SOMET-295 chase-stall state, in the cleared shape resetChaseStall
        // gives it, plus the per-guard list of targets proved unreachable.
        // Only the guard branch writes any of it; the Map is created lazily on
        // the first ban so that the overwhelming majority of creatures (which
        // never jam, and which are not guards at all) do not each carry one.
        _chaseTargetId: null, _chaseStall: 0,
        _unreachable: null,
        // Per-slot cooldown, per INSTANCE. An absent key means "ready" (the
        // same thing the old scalar `_attackCd: 0` meant), so a creature that
        // has never attacked can attack on its first tick.
        _abilityCd: new Map(),
      });
    }
  }

  has(id) { return this.creatures.has(id); }
  count() { return this.creatures.size; }
  all() { return [...this.creatures.values()]; }
  // SOMET-253 Task 9: world.js's melee branch needs the creature instance
  // itself (x/y/width/height) to shove a survivor via shoveAwayFrom below --
  // `all()` would work but forces a full-map copy per swing, and `has()`
  // alone can't hand back the object. Named `get` to match the Map it wraps.
  get(id) { return this.creatures.get(id); }

  // `now` is the world clock, threaded in for the same reason the attack
  // resolvers take it: damage reads the target's live status effects (shock's
  // vulnerability) and this module must never read a clock of its own.
  tick(dt, activeChunkKeys, players = [], now = 0) {
    const active = activeChunkKeys instanceof Set ? activeChunkKeys : new Set(activeChunkKeys);
    const byId = new Map(players.map((p) => [p.userId, p]));
    const killed = [];
    // Populated below by ranged/cast creatures whose target is in range and
    // in line of sight. Plain data, not a callback -- World spawns these into
    // its own ProjectileSim so CreatureSim never depends on that module.
    const shots = [];
    // Slice D (SOMET-161): creature attack + impact descriptors, drained by
    // World.tick and pushed onto the same frame keys player swings use.
    const attacks = [];
    const impacts = [];
    const all = [...this.creatures.values()];
    // Computed once per tick over the whole set, not per creature: an aura is
    // a property of the field, and recomputing it inside the loop would let a
    // creature that moved earlier this tick buff differently than one that
    // has not moved yet.
    const buffs = computeAuras(all);
    // Every creature gets a fresh `_buff` here, including one whose chunk is
    // outside the active set and will be skipped by the loop below --
    // otherwise it would keep a stale buff from whenever it was last active.
    // The buff lives on the instance (rather than a local var) because it is
    // read from OUTSIDE this loop too: another creature's attack and a
    // projectile collision both need a target's defence buff.
    for (const c of all) c._buff = buffs.get(c.id) || NO_BUFF;
    // SOMET-314. Resolved once per tick rather than per creature: it is a
    // property of the world, it never changes for the life of this manager, and
    // the roam clamp below is on the hot path.
    const sanctuary = spawnSanctuaryPoint(this.map);
    for (const c of this.creatures.values()) {
      const { cx, cy } = chunkOf(c.x, c.y, this.chunkSize);
      if (!active.has(CHUNK_KEY(cx, cy))) continue; // frozen (out of active set)
      // SOMET-254: `c.behavior` (not `|| DEFAULT_BEHAVIOR`) is enough here --
      // every entry in `this.creatures` was populated by addCreatures, which
      // always stamps `behavior: resolveInstanceBehavior(c)`, and every
      // branch of resolveInstanceBehavior returns a real object, never a
      // falsy value. Unlike computeAuras above (an exported function some
      // tests call directly with hand-built fixtures that omit `.behavior`),
      // this loop only ever sees addCreatures-shaped entries, so the
      // fallback here could never fire.
      const bh = c.behavior;
      // Per-slot decrement, arithmetically identical to the old single
      // `_attackCd` decrement -- only the number of timers changed.
      for (const [slot, cd] of c._abilityCd) {
        if (cd > 0) c._abilityCd.set(slot, Math.max(0, cd - dt));
      }

      const cc = center(c);

      // --- Guard-style creatures: defend the post against hostile creatures.
      // Guards never target players and are never targeted by hostiles.
      // Routed on the resolved behaviour, not faction, so a guard's
      // engagement rules are catalog data like everything else here.
      if (bh.chaseStyle === 'guard') {
        // A displaced guard abandons its target and walks home. Without this,
        // a guard holding a target while outside its post radius freezes:
        // every chase step lands outside the leash and is refused by the
        // clamp below, so its position never changes and the identical step
        // is refused forever. A guard outside its own leash must be going
        // home, not chasing — this guarantees recovery from any displacement
        // (knockback, teleport, a bad spawn, terrain shove).
        const displaced = !withinLeash(cc.x, cc.y, c.home, bh.leashRadius);
        // SOMET-295: an unreachable-target ban is earned from this guard's own
        // post, so it is only meaningful while the guard is still anchored to
        // it. A guard that has been knocked or teleported outside its leash is
        // approaching from somewhere new, and a hostile it could not reach
        // before may be in plain reach now -- so the list is dropped rather
        // than carried into a geometry it was never measured in.
        if (displaced && c._unreachable) c._unreachable = null;
        let tgt = (!displaced && c._target) ? this.creatures.get(c._target) : null;
        if (tgt && (tgt.hp <= 0 || tgt.faction !== 'hostile'
            || !withinLeash(center(tgt).x, center(tgt).y, c.home, bh.leashRadius))) {
          tgt = null;
        }
        // SOMET-291 — a rescue outranks whatever the guard is already doing.
        //
        // Without this the priority key inside selectGuardTarget would be
        // half-inert: a held target is kept as long as it is alive and inside
        // the leash, so a guard already busy with a wandering slime would never
        // re-select, and "run to the guards" would work only for a player
        // unlucky enough to arrive while the gate happened to be quiet -- the
        // exact case the ticket is about.
        //
        // MONOTONE, and that is what makes it safe: the switch only ever goes
        // not-a-rescue -> rescue, never the other way and never rescue ->
        // nearer-rescue, so no pair of hostiles can make a guard oscillate
        // between them. It costs one extra candidate scan per guard per tick,
        // and only while the guard holds a non-rescue target; guards are two
        // per village and MAX_WORLD_CREATURES bounds the scan.
        if (tgt && !engagingAPlayer(tgt, byId, now)) {
          const rescue = selectGuardTarget({
            guard: c, creatures: all,
            aggroRadius: bh.aggroRadius, leashRadius: bh.leashRadius,
            playersById: byId, now,
          });
          if (rescue && engagingAPlayer(rescue, byId, now)) tgt = rescue;
        }
        if (!displaced && !tgt) {
          // `all` is a pre-loop snapshot; selectGuardTarget skips any
          // candidate already killed earlier this tick (hp <= 0), so a
          // creature removed from this.creatures by an earlier guard in this
          // same loop is never handed back as a live target.
          tgt = selectGuardTarget({
            guard: c, creatures: all,
            aggroRadius: bh.aggroRadius, leashRadius: bh.leashRadius,
            playersById: byId, now,
          });
        }
        c._target = tgt ? tgt.id : null;
        c._targetKind = tgt ? 'creature' : null;

        // SOMET-295 (was: KNOWN, NOT FIXED by the SOMET-291 review) -- a guard
        // could lock onto a hostile on the far side of its OWN wall and stand
        // there indefinitely, because this branch had no stall detection, no
        // repath and no give-up: all of that machinery lives in the no-target
        // return branch below (_homeStall / findHomePath / the
        // put-back-on-the-post fallback), which a guard holding a target never
        // reaches. The chase step jammed against the inside of the wall, the
        // leash clamp refused the identical step forever, and nothing noticed.
        //
        // The give-up is at the BOTTOM of this block rather than the top,
        // because what it needs to know -- did this tick's step actually move
        // the guard -- is only true after the step has been taken.
        if (tgt) {
          c.mode = 'chase';
          // SOMET-154: a chase invalidates any cached walk-home detour — the
          // guard is about to move off it, so following its stale waypoints
          // afterwards would steer it from wherever the fight ended. The
          // recovery budget resets too: the walk home that follows this fight
          // is a fresh episode, not a continuation of whatever preceded it.
          resetHomeWalk(c);
          const tc = center(tgt);
          const vx = tc.x - cc.x, vy = tc.y - cc.y;
          const r = movedWith(this.map, c, vx, vy, dt, bh.moveSpeedMult * c._buff.speedMult);
          // Leash clamp: a step that would leave the post's radius is refused.
          if ((r.x !== c.x || r.y !== c.y)
              && withinLeash(r.x + c.width / 2, r.y + c.height / 2, c.home, bh.leashRadius)) {
            c.x = r.x; c.y = r.y;
            const f = facingFor(vx, vy); if (f) c.facing = f;
            c.dirty = true;
          }
          // `cc` is the PRE-move centre, deliberately reused here even though
          // the leash-clamped step above may have just moved the guard --
          // recomputing it changes the range gate against the frozen golden
          // trace. Same rule as the hostile block below.
          const ability = selectAbility(c, bh, Math.hypot(tc.x - cc.x, tc.y - cc.y));
          if (ability && canAct(c, now)) {
            // A guard's strike is always physical and always melee-shaped: a
            // guard never emits a shot (the shots array is built in the
            // hostile block only), so attackKind is not read here.
            //
            // SOMET-254: `c.damage` (not `?? CREATURE_DAMAGE`) is enough --
            // addCreatures above always normalizes it to a finite number
            // (falling back to CREATURE_DAMAGE there) before `c` ever enters
            // `this.creatures`, so every `c` reached by this tick loop
            // already has a real number here; the inner `?? CREATURE_DAMAGE`
            // could never fire.
            const dmg = (bh.damageOverride ?? c.damage) * ability.damageMult * c._buff.damageMult;
            // SOMET-290: the guard is named as the provoker. A hostile that
            // reads provocation (a skittish creature caught by a guard) is
            // then angry at the GUARD, which matches no player and so cannot
            // arm it against a bystanding one.
            applyDamageWithEffects(tgt, dmg, 'physical', effectiveMit(tgt), now, creatureKey(c.id));
            // Slice D (SOMET-161): the SAME descriptor shape a player swing
            // emits. This is what makes "every actor is visible" one code
            // path rather than two -- the client draws a wolf bite through
            // exactly the code that draws a halberd, and neither can be fixed
            // without fixing the other.
            stampCreatureAttack(attacks, impacts, c, tgt, cc, tc);
            tgt.dirty = true;
            c._abilityCd.set(ability.slot, ability.attackCooldown);
            if (tgt.hp <= 0) { this.creatures.delete(tgt.id); killed.push(tgt.id); }
            else if (ability.knockback > 0) {
              // Survivors only -- a target the line above already deleted
              // must never be shoved. `cc` (the guard's PRE-move centre, the
              // same point the range gate above used) is the shove origin.
              // SOMET-283: routed through the creature-aware shove like every
              // other creature-targeting knockback site. `tgt` here is always
              // hostile (selectGuardTarget refuses anything else), so the
              // clamp is inert for it today -- it goes through the same door
              // so that a future post-bound target cannot be punted off its
              // post by this path alone.
              shoveCreature(this.map, cc.x, cc.y, tgt, ability.knockback);
              tgt.dirty = true;
            }
          }
          // Refused by canAct: no cooldown stamped, exactly as before -- the
          // guard strikes the moment it recovers rather than also serving a
          // cooldown for the swing it never took.

          // SOMET-295 -- the give-up. "Stuck" is how much of the step the
          // terrain actually DELIVERED, not whether the guard ended up
          // somewhere new and not whether it closed on its target. Both of
          // those were tried and both are wrong:
          //
          //  - closure on the target calls a guard trailing a hostile faster
          //    than itself "stuck", which is precisely SOMET-291's rescue.
          //  - the guard's own displacement calls a WALL-SLIDE progress. This
          //    is the one that shipped and then failed in the running game:
          //    both Windwatch guards spent 15s pinned at y=2500 sliding a few
          //    px/s along the inside of their north wall, following a roaming
          //    slime they could never reach, and were dragged 203px -> 288px
          //    off station while every tick "moved". A roaming hostile keeps
          //    re-aiming the guard, so the tangential component never dies.
          //
          // resolveMove clamps each axis independently, so a step into a wall
          // still delivers its tangential part. Comparing what arrived against
          // what was asked for is therefore the direct question: a guard on
          // open ground delivers all of it, one rounding a corner at 45deg
          // delivers ~71%, and one pushing into a wall nearly head-on delivers
          // a few percent. Below a quarter it is not walking along anything, it
          // is leaning on the wall.
          //
          // The reach test is the other exemption: a guard in contact, hitting
          // a hostile, is motionless on purpose, and its step vector is ~0 so
          // it would otherwise read as fully blocked. Asked as a range question
          // rather than "did selectAbility return something", which goes null
          // for the whole of a cooldown and would read a fighting guard as
          // stuck.
          const pc = center(c);
          const intended = c.speed * (bh.moveSpeedMult * c._buff.speedMult) * dt
            * this.map.speedAt(cc.x, cc.y);
          const delivered = Math.hypot(pc.x - cc.x, pc.y - cc.y);
          const blocked = intended > 0
            && delivered < intended * GUARD_CHASE_BLOCKED_FRACTION
            && Math.hypot(tc.x - pc.x, tc.y - pc.y) > longestReach(bh);
          if (c._chaseTargetId !== tgt.id) {
            c._chaseTargetId = tgt.id;
            c._chaseStall = 0;
          } else if (blocked) {
            c._chaseStall += 1;
          } else {
            c._chaseStall = 0;
          }
          if (c._chaseStall >= GUARD_CHASE_STALL_TICKS) {
            // Demonstrably immobile for 2s and unable to touch it: this guard
            // cannot walk to this hostile from here. Drop it and refuse it, so
            // the next tick walks home through the branch below instead of
            // re-acquiring the same hostile and jamming again. `mode` is left
            // to that branch, which is the one that knows whether the guard is
            // 'return'ing or already home.
            //
            // There is deliberately no ban check on the HELD target above: the
            // ban and the clear are written together here, so a banned hostile
            // can never also be the one this guard is holding, and
            // selectGuardTarget is then the only door back in. A second check
            // up there would be unreachable code that reads like a safeguard.
            banAsUnreachable(c, tgt, now);
            c._target = null;
            c._targetKind = null;
            resetChaseStall(c);
          }
          continue;
        }

        // No target: walk back to the post, then stand still.
        //
        // SOMET-295: no resetChaseStall() here on purpose, though it reads like
        // it belongs. The window is self-clearing -- the mark is compared
        // against the guard's CURRENT position, so the first step of any walk
        // home already clears it -- and the one case that could survive a gap
        // is a guard that lost its target without moving a pixel, which is
        // still standing in the same jam it was counting. Resuming that count
        // is the right answer, and a reset here would be a line no test can
        // tell from its absence.
        //
        // SOMET-290: the walk itself is stepHome() now, shared with the homed
        // non-guard creatures below. Byte-identical steering, stall detection,
        // repath budget and snap-home fallback -- only the mode assignment
        // stays here, because 'guard' means something to a guard and nothing to
        // a deer.
        if (c.home) {
          c.mode = stepHome(this.map, c, bh, dt, cc) === 'home' ? 'guard' : 'return';
        } else {
          c.mode = 'guard';
        }
        continue;
      }
      // --- end guard branch; hostile path below is unchanged ---

      // SOMET-290 follow-up (finding 4) — the post this creature is held to,
      // resolved ONCE for the whole hostile path and read by all three of the
      // flee clamp, the walk-home block and the roam clamp below.
      //
      // Through leashAnchorOf rather than by reading `c.home` and
      // `bh.leashRadius` at each site, because the helper is the only place that
      // defends the radius: a hand-built behaviour with no `leashRadius` (a
      // test fixture, a future caller that does not go through resolveBehavior)
      // gives `Math.max(NaN, d2)` -> NaN, which refuses EVERY roam and flee step
      // AND reads as outside the leash, i.e. a creature permanently in
      // `mode: 'return'` and frozen solid. The DB path always supplies 800, so
      // the raw reads were safe today and silently lethal tomorrow.
      const anchor = leashAnchorOf(c);

      // Target resolution: keep current target unless it left leash; else acquire nearest in aggro.
      if (c._target) {
        const tp = byId.get(c._target);
        if (!tp || dist2(cc.x, cc.y, center(tp).x, center(tp).y) > bh.leashRadius * bh.leashRadius) c._target = null;
      }
      if (!c._target) {
        // SOMET-290 — a SKITTISH creature's PROVOKER is acquirable out to the
        // leash radius and outranks a nearer stranger. Every other chase style,
        // and every non-provoker, acquires the nearest player inside the aggro
        // radius exactly as before.
        //
        // Both halves matter and both are about the same missing fact. Aggro
        // is 300px for a skittish creature and every ranged weapon in the
        // catalog outreaches it (darts 350 … arbalest 850), so a creature that
        // can only ever acquire inside aggro can be shot to death without ever
        // being able to answer — the retaliation rule spec §3 promises would be
        // defeated by a bow. And picking the NEAREST player rather than the one
        // that actually hit it would have a wounded creature turn on a stranger
        // standing closer than its attacker.
        //
        // Bounded by the leash rather than unbounded: the leash is already what
        // ends an engagement (the drop above), so a provoker further away than
        // that is someone this creature was never going to reach. It stays
        // provoked until the memory expires, so walking back into leash range
        // within that window is answered.
        //
        // GATED ON `skittish`, which is the only style spec §3 speaks about,
        // and the gate is the whole point rather than tidiness. Unscoped, this
        // is a game-wide change to how you break contact: ~4,000 live hostile
        // rows are charge/skirmish with aggro 400 against leash 800 (Apex is
        // 600/1200), and a landed creature melee re-stamps provocation on every
        // connect (see the attack branch below), so every enemy that had ever
        // touched you would re-acquire you out to its leash on a rolling 10s
        // timer — backing out of aggro range would stop being a way to
        // disengage, and every ranged weapon in the game would pull aggro from
        // beyond the range the enemy can see you at. Skittish creatures are the
        // ones that need it, because they are the ones whose aggro radius is
        // narrower than the weapons used on them.
        const retaliates = bh.chaseStyle === 'skittish';
        let nearest = null, nd2 = Infinity, haveProvoker = false;
        for (const p of players) {
          const pc = center(p);
          const d2 = dist2(cc.x, cc.y, pc.x, pc.y);
          const provoker = retaliates && isProvokedBy(c, playerKey(p.userId), now);
          const reach = provoker ? Math.max(bh.aggroRadius, bh.leashRadius) : bh.aggroRadius;
          if (d2 > reach * reach) continue;
          if (haveProvoker && !provoker) continue;
          // The first provoker displaces any stranger already picked; after
          // that, provokers compete with each other on distance like anyone
          // else. `<=` (not `<`) keeps the pre-SOMET-290 tie-break, where the
          // LAST player at an equal distance wins.
          if (provoker && !haveProvoker) { haveProvoker = true; nd2 = d2; nearest = p; continue; }
          if (d2 <= nd2) { nd2 = d2; nearest = p; }
        }
        if (nearest) c._target = nearest.userId;
      }
      // `_targetKind` was only ever written by the guard branch, so a hostile
      // holding a player read as `null` — fine while nothing outside the tick
      // asked, but SOMET-291's engagingAPlayer needs to tell a player target
      // from a creature one without re-deriving it from faction. It refuses on
      // 'creature' rather than requiring 'player', so this write is a
      // clarification and not a load-bearing precondition: a hostile that has
      // not yet reached this line still reads correctly.
      c._targetKind = c._target != null ? 'player' : null;
      c.mode = c._target ? 'chase' : 'roam';
      // SOMET-290: there is deliberately NO "clear provocation" step here any
      // more. It used to read `if (!c._target) c._provoked = false;`, and the
      // pair of bugs that produced is the argument for the record that replaced
      // the boolean. Without a clear, one arrow made a deer a charger for the
      // world's uptime; with it, a creature shot from beyond its 300px aggro
      // radius — which is every ranged weapon in the catalog — was calm again on
      // the very next tick and died without a fight. A flag coupled to target
      // state can only be too sticky or too eager.
      //
      // `_provokedBy` carries WHO and UNTIL WHEN instead (damage.js), so
      // forgetting is a clock read rather than a side effect of target
      // resolution: the shooter is remembered while they are out of range, and
      // a bystander who walks up is not blamed for a hit they did not land.

      if (c.mode === 'chase') {
        const tp = byId.get(c._target);
        const tc = center(tp);
        const dist = Math.hypot(tc.x - cc.x, tc.y - cc.y);
        let vx = tc.x - cc.x, vy = tc.y - cc.y;
        let move = true;

        // SOMET-290 — the whole of "this creature is prey right now", derived
        // ONCE per tick and read by all three of the movement band, the leash
        // clamp and the attack gate below. One const rather than three calls,
        // because the cornered rule WRITES provocation mid-tick: three
        // separate reads would have a creature flee, discover it is cornered,
        // and attack in the same tick from the pre-flee distance. A creature
        // that decides to run commits to running for that tick and fights from
        // the next one.
        //
        // Per-TARGET, not per-creature: a deer shot by one player and then
        // approached by another is still prey to the second one.
        //
        // SOMET-291's guard branch above asks the SAME predicate (through
        // engagingAPlayer), so the two cannot disagree about what "fleeing"
        // means -- a creature backing away from a player must not read to a
        // guard as that player being attacked.
        const fleeing = isFleeingFrom(c, bh, playerKey(c._target), now);

        if (bh.chaseStyle === 'hold') {
          // Never moves. It still attacks below if the target is in range.
          move = false;
        } else if (bh.chaseStyle === 'kite') {
          // Three bands: too close -> back away; too far -> close; in between
          // -> stand and shoot. Without the middle band a kiter oscillates
          // one step per tick and never fires.
          if (dist < bh.preferredRange) { vx = -vx; vy = -vy; }
          // The band's outer edge is the REACH of the kiter's longest attack,
          // not one particular slot's: a kiter holding still at 340 because
          // slot 1 reaches that far is the same creature whether or not slot
          // 1 happens to be on cooldown this tick.
          else if (dist <= maxAbilityRange(bh)) { move = false; }
        } else if (bh.chaseStyle === 'skirmish') {
          // Retreat while EVERY attack is recovering, close while any is
          // ready. Reading the live cooldowns is what makes this hit-and-run
          // rather than a timer that ignores whether the strike landed; with
          // a single ability it is identical to the old `_attackCd > 0`.
          if (!anyAbilityReady(c, bh) && dist < bh.preferredRange) { vx = -vx; vy = -vy; }
        } else if (fleeing) {
          // Two bands, and no attack band at all: inside its flee radius it
          // backs away, outside it it stands and watches you. The outer band
          // is `move = false` rather than a slow drift because a creature that
          // keeps retreating from someone 250px away is not skittish, it is
          // simply unreachable -- you could never catch one to hunt it.
          //
          // Note this branch is reached only when NOT provoked. A provoked
          // skittish creature falls through with the straight-at-target vector
          // exactly as 'charge' does, deliberately without a band of its own:
          // "hurt me and I fight you like anything else" is the promise, and a
          // separate provoked band would be a second copy of charge's chase
          // that could drift from it.
          if (dist < bh.preferredRange) { vx = -vx; vy = -vy; }
          else { move = false; }
        }
        // 'charge' and 'ambush' fall through with the straight-at-target
        // vector -- an aggroed ambusher IS a charger, it just started asleep.

        if (move) {
          const r = movedWith(this.map, c, vx, vy, dt, bh.moveSpeedMult * c._buff.speedMult);
          // SOMET-290 — a flee step is additionally clamped to the leash from
          // HOME, which is the difference between a creature you can scare off
          // and a creature you can herd across the map. It exists so a penned
          // creature cannot be walked out of its pen by a player who simply
          // keeps advancing.
          //
          // Reaches only creatures that BOTH have a home anchor and flee, which
          // today is SOMET-289's penned skittish creatures and nothing else:
          // `home_x` is otherwise written only for village guards (guard style,
          // which returned above), the portal packs in dungeonGuards.js and the
          // vault packs in chests.js -- all `charge`, so `fleeing` is false for
          // them and this clamp is skipped. A creature with no anchor at all is
          // unconstrained here, which is every wild spawn.
          //
          // Applied to the FLEE step only, not to a provoked chase: clamping
          // the chase too would freeze a provoked creature against its leash
          // edge with the player one step outside it, re-creating exactly the
          // stuck-guard failure the guard branch above documents at length.
          //
          // MONOTONE, like the guard's shove clamp and for the same reason: a
          // step is allowed if it leaves the creature no further from home than
          // the larger of its leash and where it already was. A destination-only
          // test would root a creature that is ALREADY outside its leash (shoved
          // there, spawned there, or dragged there by a provoked chase) — every
          // flee destination from out there is outside the leash, so all of them
          // are refused, and it would stand still and CALM (a refused step is
          // still `moved`, so it is not cornered either) while a player stood on
          // top of it.
          const inLeash = !fleeing || !anchor
            || withinLeashBudget(c, cc.x, cc.y, r.x + c.width / 2, r.y + c.height / 2, anchor.radius);
          const moved = (r.x !== c.x || r.y !== c.y);
          if (moved && inLeash) {
            c.x = r.x; c.y = r.y;
            const f = facingFor(vx, vy); if (f) c.facing = f;
            c.dirty = true;
          } else if (fleeing && !moved && (vx !== 0 || vy !== 0)) {
            // Cornered by TERRAIN, and only by terrain: the step was refused
            // because the world had nowhere to put it. A creature with nowhere
            // left to go fights -- without this it would jitter silently
            // against the wall while the player killed it for free, which reads
            // as a broken enemy rather than a frightened one.
            //
            // The `vx !== 0 || vy !== 0` guard is what makes "only by terrain"
            // true rather than merely claimed. resolveMove short-circuits a
            // zero vector to `moved: false` before it ever looks at the map
            // (collision.js's first line), and the flee vector IS zero when a
            // player's centre coincides exactly with the creature's -- so a
            // player standing precisely on top of one used to provoke it with
            // no damage and no wall involved. Rare (it needs exact float
            // equality) but it is a non-terrain route into a terrain-only rule.
            //
            // The two refusals are deliberately NOT one case, which is the
            // opposite of how it looks from inside the pen. A fence refusal
            // keeps the creature where it is whatever it decides next. A leash
            // refusal does not: provoking here would clear `fleeing` from the
            // next tick, and the clamp above only applies to a flee step, so
            // the very act of enforcing the leash would drop it -- the creature
            // would convert and then chase the player straight out of the pen,
            // unclamped and with no return-home path. flushAndPrune writes
            // x/y back to world_creatures, so that displacement would outlive
            // the session and drain the pen permanently, one creature per
            // player who wandered in.
            //
            // So a creature pinned against its own leash simply stops
            // retreating. It stands at the edge, still calm, and can be walked
            // up to and killed -- which is the intended "you can hunt one"
            // outcome, not a failure mode.
            //
            // Attributed to the player it is backing away from: this is the one
            // provocation with no attacker to name, and the actor who cornered
            // it is by definition the one it is retreating from. Stamped
            // through damage.js's `provoke` rather than by writing the record
            // here, so the field has one author and one expiry rule.
            provoke(c, playerKey(c._target), now);
          }
        }
        // Attack. Gated by canAct for the same reason the player attack paths
        // are (world.js's canAttack/attack): a shocked creature must miss its
        // strike, whether that strike is a bite, a shot, or a cast.
        //
        // Without this check the interrupt was inert in PvE. applyElementEffect
        // stamps _interruptedUntil and _shockImmuneUntil onto creatures from
        // every lightning hit — the melee arc, the projectile, the AoE — and
        // nothing read either field, so the storm staff paid the game's worst
        // damage-per-mana (0.636) for three riders while delivering two of them
        // against creatures. That is precisely the inert-mechanic failure mode
        // this slice exists to remove.
        //
        // Refused like a cooldown, not eaten: the attack does not happen AND
        // the selected slot's cooldown is not stamped, so the creature attacks
        // as soon as it recovers rather than also serving a fresh cooldown for
        // the swing (or shot) it never took. The immunity window in applyShockInterrupt
        // (stamped once, deliberately never refreshed) is what stops this
        // becoming a perma-stun — it applies to creatures for free, because it
        // lives on the target.
        // `cc` is the PRE-move centre computed above, deliberately not
        // recomputed here even though `move` may have just changed c.x/c.y
        // this same tick: recomputing would change the melee range gate
        // (and, for a shot, the origin) against the frozen golden trace.
        //
        // `dist` is the PRE-move distance computed above from `cc`, so the
        // range gate is the same measurement the movement bands used.
        //
        // SOMET-290: an unprovoked skittish creature selects nothing at all.
        // This is the headline promise of the behaviour -- you can walk past
        // one -- and it is gated here rather than by giving the profile a
        // zero-range ability, so the SAME creature swings with full reach the
        // moment it is provoked. Refused the way canAct and a blocked shot are
        // refused: no ability, therefore no cooldown stamped for the bite it
        // never took, so a creature provoked mid-flee bites immediately
        // instead of first serving 1.2s for a swing that never happened.
        const ability = fleeing ? null : selectAbility(c, bh, dist);
        if (ability && canAct(c, now)) {
          // SOMET-254: see the guard block above -- `c.damage` is always
          // already a finite number by the time a creature reaches the tick
          // loop, so the inner `?? CREATURE_DAMAGE` fallback here was dead.
          const dmg = (bh.damageOverride ?? c.damage) * ability.damageMult * c._buff.damageMult;
          if (ability.attackKind === 'melee') {
            // tp is a PLAYER, not a creature: no aura ever buffs a player's
            // defence, so tp.mit is read as-is here, unlike the three
            // creature-target sites below which read effectiveMit(target).
            applyDamageWithEffects(tp, dmg, 'physical', tp.mit || NO_MITIGATION, now, creatureKey(c.id));
            // SOMET-290 — a landed blow re-arms the creature's OWN memory, so
            // provocation lasts "for that engagement" (spec §3) rather than for
            // a fixed number of seconds from the first hit. Without it a
            // provoked creature that is still in contact with the player it is
            // fighting goes calm mid-fight the moment PROVOKE_MEMORY_MS elapses
            // -- a deer that bites you, then suddenly starts backing away while
            // still in reach. Only a hit that CONNECTED re-arms it: a player
            // who breaks contact and outruns it is forgotten on schedule.
            //
            // Free for every other chase style, which never reads the field:
            // both readers (isFleeingFrom and the acquisition reach above) are
            // gated on `skittish`, so a charger stamping this every time it
            // connects changes nothing about a charger. That gate is what keeps
            // it free — unscoped, this line is what would turn the reach
            // extension into a permanent, self-renewing grudge for every enemy
            // in the game.
            provoke(c, playerKey(c._target), now);
            // Second of the two contact sites -- same stamp, same shape.
            stampCreatureAttack(attacks, impacts, c, tp, center(c), center(tp));
            c._abilityCd.set(ability.slot, ability.attackCooldown);
            // Survivors only -- a dead player is about to be respawned by
            // resolveDeaths(), and shoving them first would move a position
            // that respawn is about to overwrite anyway. `tp.x`/`tp.y` are
            // written directly, the same server-authoritative assignment
            // server.js:1147 already makes for the blocked-portal bounce.
            if (tp.hp > 0 && ability.knockback > 0) {
              shoveAwayFrom(this.map, cc.x, cc.y, tp, ability.knockback);
            }
          } else if (hasLineOfSight(this.map, cc.x, cc.y, tc.x, tc.y)) {
            // Terrain blocks a shot exactly as it blocks the melee arc.
            // Without this a ranged creature burns its cooldowns firing into
            // a wall, which reads as a broken enemy rather than a blocked one.
            const d = Math.hypot(tc.x - cc.x, tc.y - cc.y) || 1;
            // A hold/kite creature can fire without its movement block ever
            // running this tick (or any tick, for `hold`), so this is the
            // only place its facing updates while shooting. Without it a
            // stationary turret keeps a stale facing and visibly fires out of
            // its own back — the client renders directional sprites off
            // c.facing.
            const f = facingFor(tc.x - cc.x, tc.y - cc.y);
            if (f) c.facing = f;
            shots.push({
              ownerId: c.id,
              ownerFaction: c.faction || 'hostile',
              x: cc.x, y: cc.y,
              nx: (tc.x - cc.x) / d, ny: (tc.y - cc.y) / d,
              damage: dmg,
              // A `ranged` ability fires physical; only `cast` carries an
              // element and therefore its status rider. The ability's own
              // element wins when it has one (an Apex's physical slam next to
              // its fire breath); `null` means "inherit the creature type's
              // attack_element", which is what every backfilled slot-1 row
              // carries and what reproduces today's behaviour exactly.
              element: ability.attackKind === 'cast'
                ? (ability.element ?? c.attackElement ?? 'physical')
                : 'physical',
              speed: ability.projectileSpeed,
              radius: ability.projectileRadius,
              range: ability.attackRange,
              knockback: ability.knockback,
            });
            c._abilityCd.set(ability.slot, ability.attackCooldown);
          }
          // No line of sight: the cooldown is NOT stamped, so the creature
          // fires the moment it has a clear shot rather than also serving a
          // cooldown for the shot it never took. Same treatment canAct gets.
        }
        continue;
      }

      // SOMET-290 — a creature with a post comes back to it, and never wanders
      // off it. Guard-STYLE creatures already did (the branch above); this is
      // the same rule for every OTHER creature that has a home anchor: the
      // penned creatures SOMET-289 is about, and the portal/vault guards, which
      // are ordinary hostile entity types with home_x/home_y and whose own
      // module comments already promise the recovery this provides.
      //
      // Two halves, and the pen needs both:
      //  - outside the leash -> walk home. Without it the only return path for a
      //    non-guard was "none": a creature that chased a player out of its pen
      //    (a provoked chase is deliberately unclamped, see the flee clamp
      //    above) simply roamed on from wherever the chase ended, and
      //    flushAndPrune persists x/y, so the pen drained permanently -- one
      //    creature per player who wandered in.
      //  - inside it -> roam, but refuse any step that would leave. A pure
      //    random walk leaks a creature out of its pen on its own, just slower
      //    than a player can herd one.
      //
      // NOT inert on today's data, and deliberately so. Besides the penned
      // creatures this ticket adds, the live world holds the portal packs from
      // dungeonGuards.js (Umbral/Crystal/Void/Ember/Bonelord/Rime/Fungal Line:
      // hostile, `charge`, leash 800, home_x on the portal tile). They used to
      // roam away from their portal and never come back, which contradicted
      // dungeonGuards.js's own promise that a displaced one "still recovers
      // back to defending the portal". From here they pace within their leash
      // of the portal and walk back when displaced. That is the behaviour their
      // module always described, but it IS a change to shipped content, so
      // creature_skittish.test.js pins it rather than leaving it incidental. A
      // creature with no anchor is untouched by all of this, which is every
      // wild spawn -- `home_x` is written only by the guard, portal and vault
      // spawners and by SOMET-289's pens.
      //
      // Reached BEFORE the hold/ambush stand-still check on purpose: "stand
      // still rather than wander" is about roaming, and a creature displaced
      // off its anchor is not roaming, it is lost. No `hold`/`ambush` row has a
      // home today, so that ordering is currently theoretical -- but note the
      // shape it would take if one were ever homed: a homed `hold` sentry with
      // `moveSpeedMult: 0` cannot close ANY distance, so it would burn its 12
      // stall ticks x 3 repaths and then be TELEPORTED to its post by
      // stepHome's snap-home fallback. That is arguably the right answer for a
      // sentry that cannot walk, but it should be a decision, not a surprise.
      if (anchor) {
        if (!withinLeash(cc.x, cc.y, anchor.home, anchor.radius)) {
          c.mode = stepHome(this.map, c, bh, dt, cc) === 'home' ? 'roam' : 'return';
          continue;
        }
        // Back inside: whatever walk-home episode got it here is over, so the
        // next displacement starts with a full stall/repath budget of its own.
        resetHomeWalk(c);
      }

      // Roam. `hold` never moves at all, and `ambush` lies dormant until
      // something enters its aggro radius -- for both, "no target" means
      // "stand still", not "wander".
      if (bh.chaseStyle === 'hold' || bh.chaseStyle === 'ambush') continue;

      if (this.rng() < REDIRECT_CHANCE) {
        c._dir = Math.min(DIRS.length - 1, Math.floor(this.rng() * DIRS.length));
      }
      const [dx, dy] = DIRS[c._dir];
      const r = movedWith(this.map, c, dx, dy, dt, bh.moveSpeedMult * c._buff.speedMult);
      // The leash refuses a roam step exactly as a wall does -- same clamp as
      // the flee step (monotone, so a creature that starts outside is not
      // frozen), and the same "blocked -> turn" answer, so a penned creature
      // paces its pen instead of standing in the corner it first reached.
      const roamInLeash = !anchor || withinLeashBudget(c, cc.x, cc.y,
        r.x + c.width / 2, r.y + c.height / 2, anchor.radius);
      // SOMET-314 — and the spawn sanctuary refuses it the same way, with the
      // same "blocked -> turn" answer, so a creature that reaches the edge
      // paces along it instead of stalling in place.
      //
      // Gated on `!anchor`: an anchored creature is standing where a map author
      // put it, not where it wandered. Village guards never reach this line at
      // all (the guard branch above `continue`s), but the portal packs from
      // dungeonGuards.js and SOMET-289's penned creatures are ordinary hostiles
      // with a home_x, and a portal posted near a spawn point must keep pacing
      // its post rather than being pushed off it by a rule about wanderers.
      const roamOutsideSanctuary = !sanctuary || anchor
        || !roamsIntoSanctuary(sanctuary, bh, cc.x, cc.y,
          r.x + c.width / 2, r.y + c.height / 2);
      if ((r.x !== c.x || r.y !== c.y) && roamInLeash && roamOutsideSanctuary) {
        c.x = r.x; c.y = r.y;
        c.facing = DIR_FACING[c._dir];
        c.dirty = true;
      } else {
        c._dir = (c._dir + 1) % DIRS.length; // blocked → turn
      }
    }
    return { killed, shots, attacks, impacts };
  }

  // Player melee: damage creatures within `range` of (px,py); remove + return dead ids.
  // `now` is the world clock, needed to stamp the element's status rider.
  //
  // No production caller today (world.js's melee branch uses the arc pair
  // below); kept because several combat tests drive it directly. SOMET-285's
  // guard exclusion is applied here anyway rather than only on the live path:
  // this is by declaration a PLAYER melee primitive, and leaving one
  // unfiltered player-damage door open would be re-opened by the first caller
  // that ever reaches for it.
  applyAttack(px, py, range, damage, element, now = 0, sourceUserId = null) {
    const killed = [];
    const r2 = range * range;
    for (const [id, c] of this.creatures) {
      if (immuneToPlayerDamage(c)) continue;
      const cc = center(c);
      if (dist2(cc.x, cc.y, px, py) > r2) continue;
      // SOMET-290: `sourceUserId` names the swinger, like applyMeleeArc's
      // `sourceId` does. Optional, since this primitive has no production
      // caller, but a hit that provokes nobody in particular is the one shape
      // that would let a creature charge a bystander.
      applyDamageWithEffects(c, damage, element, effectiveMit(c), now, playerKey(sourceUserId));
      applyElementEffect(c, element, now);
      c.dirty = true;
      if (c.hp <= 0) { this.creatures.delete(id); killed.push(id); }
    }
    return killed;
  }

  // Ids of every live creature a PLAYER's melee swing would connect with:
  // inside the arc AND with line of sight. Damages nothing.
  //
  // Split out of applyMeleeArc so an attack can report whether it CONNECTED
  // (frame.attacks `hit`) — killed ids alone cannot answer that, since a
  // creature hit for non-lethal damage appears in neither list. applyMeleeArc
  // iterates this, so both share ONE arc rule and cannot drift apart.
  //
  // SOMET-285: this is the SINGLE list world.js's player-melee branch derives
  // everything from — the damage (applyMeleeArc iterates it), the element's
  // status rider (applied inside that loop), the knockback loop, the impact
  // descriptors and the swing's own `hit` flag. Excluding guards HERE is
  // therefore the whole of the melee half of the fix, and it is why a player
  // can no longer shove a guard either (see the module note on
  // immuneToPlayerDamage). The one creature-owned caller of this file's melee
  // code — the tick's guard branch — does not go through this method, so a
  // guard's own strike on a hostile is untouched.
  meleeArcTargets(ox, oy, nx, ny, reach, arcWidth) {
    return this.meleeArcScan(ox, oy, nx, ny, reach, arcWidth).hit;
  }

  // SOMET-286: the same arc, split by whether the swing was allowed to land.
  // `hit` is meleeArcTargets' list unchanged; `blocked` is what the swing
  // physically reached but a rule refused it — today exactly the guards.
  //
  // ONE traversal and ONE geometry test produces both lists, so a swing can
  // never report a block at a creature the arc did not actually reach, nor
  // miss a block for one it did. A separate "which guards are in the arc"
  // method would be a second copy of inArc + hasLineOfSight, free to drift
  // from the copy that decides the damage.
  //
  // The immunity test moved AFTER the geometry (it used to short-circuit
  // before it) purely so a blocked target is known to be in range; `hit` is
  // unchanged either way, since both filters are conjunctive.
  meleeArcScan(ox, oy, nx, ny, reach, arcWidth) {
    const hit = [], blocked = [];
    for (const [id, c] of this.creatures) {
      const cc = center(c);
      if (!inArc(ox, oy, nx, ny, cc.x, cc.y, reach, arcWidth)) continue;
      // Terrain blocks the swing, exactly as it blocks a projectile.
      if (!hasLineOfSight(this.map, ox, oy, cc.x, cc.y)) continue;
      (immuneToPlayerDamage(c) ? blocked : hit).push(id);
    }
    return { hit, blocked };
  }

  // Melee arc: damage every creature whose center is within reach AND inside the
  // aim cone; remove + return the dead ids. (nx,ny) must be normalized.
  //
  // `sourceId` (the attacking player's userId) is threaded into the element
  // rider so a burn this swing applies later ticks with the RIGHT killer —
  // see effects.js's `sourceId` field and world.js's `stepEffects`. Before
  // Task 5 this call site passed no sourceId at all, so a creature that died
  // to a melee-applied burn (rather than the swing itself) could never be
  // attributed to anyone; this is that gap closed, not a new feature.
  applyMeleeArc(ox, oy, nx, ny, reach, arcWidth, damage, element, now = 0, sourceId = null) {
    const killed = [];
    for (const id of this.meleeArcTargets(ox, oy, nx, ny, reach, arcWidth)) {
      const c = this.creatures.get(id);
      if (!c) continue;
      // SOMET-290: `sourceId` is the swinging player, already threaded here for
      // the element rider's kill attribution -- provocation names the same
      // actor, so a creature retaliates against whoever actually swung.
      applyDamageWithEffects(c, damage, element, effectiveMit(c), now, playerKey(sourceId));
      // The element's status rider is applied wherever the element already
      // deals damage — one call adjacent to each applyDamage, never a second
      // rider table.
      applyElementEffect(c, element, now, sourceId);
      c.dirty = true;
      if (c.hp <= 0) { this.creatures.delete(id); killed.push(id); }
    }
    return killed;
  }

  // Point damage to one creature (used by projectile collision). Returns true
  // if it died (and was removed).
  //
  // Deliberately does NOT apply the element's status rider, unlike the melee
  // arc above: this is the generic creature-damage primitive, and burn's own
  // damage tick routes through it with element 'fire'. A rider here would let
  // burn refresh itself from its own tick and never expire. The projectile
  // paths that DO carry a rider apply it at their call sites in projectiles.js,
  // next to their own hit detection — a rider belongs to a HIT, not to damage.
  // `source` (SOMET-290) is the attacker's tag from damage.js's playerKey/
  // creatureKey, threaded by the projectile paths and the burn tick. Optional
  // and defaulting to null -- an unattributed hit stamps a provocation that
  // matches NO actor, so the creature answers nobody for it. Every one of
  // today's callers names its source; the default exists so that the one that
  // eventually forgets ships an enemy that ignores a damage source (visible,
  // dull) rather than one that acquires and chases a bystander who never
  // touched it. See isProvokedBy in damage.js.
  damageCreatureById(id, damage, element, now, source = null) {
    const c = this.creatures.get(id);
    if (!c) return false;
    applyDamageWithEffects(c, damage, element, effectiveMit(c), now, source);
    c.dirty = true;
    if (c.hp <= 0) { this.creatures.delete(id); return true; }
    return false;
  }

  getDirty() {
    const out = [];
    for (const c of this.creatures.values()) {
      if (c.dirty) out.push({ id: c.id, x: c.x, y: c.y, facing: c.facing });
    }
    return out;
  }

  clearDirty(ids) {
    for (const id of ids) {
      const c = this.creatures.get(id);
      if (c) c.dirty = false;
    }
  }

  // Drop non-dirty creatures whose current chunk left the active set. Dirty
  // creatures are kept until a flush clears them (confirm-before-drop), so no
  // unpersisted position is lost. Returns the number dropped.
  pruneInactive(activeChunkKeys) {
    const active = activeChunkKeys instanceof Set ? activeChunkKeys : new Set(activeChunkKeys);
    let dropped = 0;
    for (const [id, c] of this.creatures) {
      const { cx, cy } = chunkOf(c.x, c.y, this.chunkSize);
      if (active.has(CHUNK_KEY(cx, cy))) continue;
      if (c.dirty) continue;
      this.creatures.delete(id);
      dropped++;
    }
    return dropped;
  }

  // `now` is the world clock, threaded in for the same reason tick() takes it:
  // deciding which status effects are still LIVE is a clock read, and this
  // module must never read one of its own. A caller that omits it gets no
  // effect keys rather than stale ones (every `until > 0` entry would look
  // expired at now=0... which is why the default is deliberately 0 and the
  // one real caller, broadcastCreatures, passes world.now).
  snapshotForNeighborhood(keys, now = 0) {
    const set = keys instanceof Set ? keys : new Set(keys);
    const out = [];
    for (const c of this.creatures.values()) {
      const { cx, cy } = chunkOf(c.x, c.y, this.chunkSize);
      if (set.has(CHUNK_KEY(cx, cy))) {
        const row = { id: c.id, type: c.type, x: c.x, y: c.y, facing: c.facing, hp: c.hp, maxHp: c.maxHp, mode: c.mode, color: c.color, level: c.level };
        // Effect KEYS only, omitted when empty — same contract as the player
        // snapshot in world.js. Read on the client as `c.effects || []`.
        const fx = activeEffectKeys(c, now);
        if (fx) row.effects = fx;
        out.push(row);
      }
    }
    return out;
  }

  // SOMET-354. The broadcast snapshot, per socket. snapshotForNeighborhood
  // above is the FULL, un-narrowed form and is kept as the reference shape
  // (and for tests that want every field for every creature); this is what
  // actually goes on the wire.
  //
  // Measured problem: broadcastCreatures sent the whole radius-1 chunk
  // neighbourhood -- 9 chunks, 9,216 tiles -- to every socket at 5Hz, while a
  // client viewport is roughly 225 tiles. About 97% of every frame was
  // off-screen. In the densest world that was 549-571 creatures, 104-108 KB
  // per frame, ~510 KiB/s (~4.2 Mbit/s) PER SOCKET, and the array was rebuilt
  // separately for each one.
  //
  // Two independent savings, both applied here:
  //
  // 1. TWO ZONES, not one radius. Simulation must stay wider than vision or
  //    creatures visibly freeze at the edge of what you can see, so the
  //    activation neighbourhood is unchanged and the NARROWING happens only on
  //    the wire. Inside `nearPx` a creature gets the fields needed to render
  //    and fight it; beyond it, only position -- because the only consumer of
  //    a far creature is the minimap, which reads x/y/color and nothing else
  //    (Game.getMinimapSnapshot). Sending one array rather than two is
  //    deliberate: the client's existing merge already skips fields a record
  //    omits, so a far record needs no new client concept and the minimap
  //    keeps working unchanged.
  //
  // 2. IMMUTABLE FIELDS ONCE. type/color/maxHp/level never change after a
  //    creature is first seen, and cost ~62 B of a ~184 B record. `known` is
  //    the per-socket set of ids that have already been told; the CALLER owns
  //    it and this method rewrites it in place to exactly the ids in this
  //    frame, so a creature that leaves the neighbourhood and comes back is
  //    re-introduced in full rather than arriving as a position with no type.
  //
  // x/y are rounded to whole world pixels (~11% off the remainder). They feed
  // an interpolator on the client, and MAP_TILE_SIZE is 100 -- a sub-pixel
  // creature position is noise, not signal.
  //
  // `f: 1` marks a far record. It is what tells the client "these fields are
  // ABSENT, not cleared" -- without it a far creature's effects would be wiped
  // on every frame, because the client assigns effects unconditionally so that
  // an expired effect actually disappears.
  snapshotAOI(keys, now, playerX, playerY, nearPx, known) {
    const set = keys instanceof Set ? keys : new Set(keys);
    const out = [];
    const stillHere = new Set();
    for (const c of this.creatures.values()) {
      const { cx, cy } = chunkOf(c.x, c.y, this.chunkSize);
      if (!set.has(CHUNK_KEY(cx, cy))) continue;
      stillHere.add(c.id);

      const row = { id: c.id, x: Math.round(c.x), y: Math.round(c.y) };
      // Chebyshev, not Euclidean: the viewport is a rectangle, so a circle
      // would either clip its corners or overshoot its edges.
      const near = Math.abs(c.x - playerX) <= nearPx && Math.abs(c.y - playerY) <= nearPx;
      if (near) {
        row.facing = c.facing;
        row.hp = Math.round(c.hp);
        row.mode = c.mode;
        const fx = activeEffectKeys(c, now);
        if (fx) row.effects = fx;
      } else {
        row.f = 1;
      }
      if (!known.has(c.id)) {
        row.type = c.type; row.color = c.color;
        row.maxHp = c.maxHp; row.level = c.level;
      }
      out.push(row);
    }
    // Rewrite in place: `known` must end up equal to what this frame sent, so
    // the next frame's "already told" test is exact.
    known.clear();
    for (const id of stillHere) known.add(id);
    return out;
  }
}

module.exports = {
  CreatureSim, loadCreatureTypes, creatureMitigation,
  CREATURE_SIZE, CREATURE_SPEED, REDIRECT_CHANCE,
  AGGRO_RADIUS, LEASH_RADIUS, CONTACT_RANGE, CREATURE_DAMAGE, CREATURE_ATTACK_COOLDOWN,
  GUARD_AGGRO_RADIUS, GUARD_LEASH_RADIUS, GUARD_DAMAGE, GUARD_HOME_EPSILON,
  // SOMET-295 — the chase give-up's three numbers, exported so the tests that
  // pin the behaviour measure against the shipped values rather than restating
  // them (a test carrying its own copy of 40 keeps passing when the real one
  // is tuned to 4000).
  GUARD_CHASE_STALL_TICKS, GUARD_CHASE_BLOCKED_FRACTION, GUARD_UNREACHABLE_MS,
  withinLeash, selectGuardTarget,
  // SOMET-290 / SOMET-291: the two predicates that own "is this creature prey
  // or a fighter". isFleeingFrom is the tick's own rule, per-target and
  // clock-aware; engagingAPlayer is the question the guard branch asks on top
  // of it -- a skittish creature holds a player in `_target` even while running
  // away from it, so a raw `_target` read cannot tell a rescue-worthy attack
  // from wildlife fleeing the same player. Exported so both can be pinned
  // directly rather than only through a full tick.
  isFleeingFrom, engagingAPlayer,
  // SOMET-290: the monotone leash budget, shared by the flee clamp and
  // shoveCreature and exported so it can be pinned without a full tick.
  withinLeashBudget,
  // SOMET-314: the spawn sanctuary. SPAWN_SANCTUARY_MARGIN is exported for the
  // same reason GUARD_CHASE_STALL_TICKS is -- a test carrying its own copy of
  // the margin keeps passing after the real one is tuned to nothing.
  roamsIntoSanctuary, spawnSanctuaryPoint, SPAWN_SANCTUARY_MARGIN,
  // SOMET-283: the leash-aware shove every creature-targeting knockback site
  // goes through (world.js's melee, projectiles.js's direct hit and AoE, and
  // the guard branch's own strike below), exported so its clamp can be pinned
  // directly instead of only through a full tick.
  shoveCreature, leashAnchorOf,
  // SOMET-285: the one guard predicate, exported so projectiles.js filters
  // player shots on exactly the notion of "guard" this file's tick and leash
  // rules use, and so tests can pin it directly.
  isGuardCreature, immuneToPlayerDamage,
  // SOMET-154: exported so the wall-ring tests can pin the path search itself
  // (and its bounds) without having to infer it from 1500 ticks of movement.
  findHomePath, GUARD_RETURN_STALL_TICKS, GUARD_MAX_REPATHS, GUARD_PATH_RANGE,
  // Exported so server.js's per-chunk world_creatures SELECT uses the SAME
  // join text as loadCreatureTypes above, rather than a second copy that can
  // drift.
  ABILITIES_LATERAL,
  // SOMET-253 Task 5: exported so authority_creature_auras.test.js can pin
  // the non-mutation/non-stacking rules directly against the buff map,
  // without needing a full tick() to observe them.
  computeAuras,
};
