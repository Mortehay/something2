// Server-side creature roaming — a port of the client CreatureManager roam
// logic (frontend/.../entities/CreatureManager.js), driven by the authority's
// active chunk set. Positions are world-space; active/AOI/prune key on the
// creature's CURRENT chunk (chunkOf), never its spawn chunk.
const { resolveMove } = require('./collision');
const { chunkOf, CHUNK_KEY } = require('./coords');
const { inArc, hasLineOfSight } = require('./weapons');
const { applyDamageWithEffects, NO_MITIGATION } = require('./damage');
const { applyElementEffect, activeEffectKeys, canAct } = require('./effects');
const { resolveBehavior, DEFAULT_BEHAVIOR } = require('../services/creatureBehaviors');

const DIRS = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
const DIR_FACING = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
const CREATURE_SIZE = 48;
const CREATURE_SPEED = 40;    // world px/s
const REDIRECT_CHANCE = 0.02;

const AGGRO_RADIUS = 400;            // px: acquire nearest player within this
const LEASH_RADIUS = 800;            // px: drop a target beyond this
const CONTACT_RANGE = 60;            // px: creature may hit its target within this
const CREATURE_DAMAGE = 5;
const CREATURE_ATTACK_COOLDOWN = 1.0; // s

const GUARD_AGGRO_RADIUS = 400;   // px: a guard engages a hostile within this
const GUARD_LEASH_RADIUS = 300;   // px from HOME: guards hold the gate, they do not roam
const GUARD_DAMAGE = 25;
const GUARD_HOME_EPSILON = 24;    // px: close enough to the post to stand still

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

// Load the creature entity types. Named + exported (rather than inlined in
// server.js) so a guard test can assert the SELECT names every column the
// mapping consumes: a mapped column missing from the SELECT loads as
// undefined and silently disables the feature it feeds.
async function loadCreatureTypes(pool) {
  // LEFT JOIN, not INNER: entity_types.behavior_id is nullable and a creature
  // without a profile must still load, resolving to the Line fallback. An
  // INNER JOIN would make a creature vanish from the catalog entirely, which
  // fails silently -- it would simply never spawn.
  const r = await pool.query(
    `SELECT e.id, e.name, e.color, e.hp, e.defense, e.resistances, e.faction,
            e.gold_min, e.gold_max, e.attack_element,
            b.name AS behavior_name, b.attack_kind, b.attack_range,
            b.attack_cooldown, b.projectile_speed, b.projectile_radius,
            b.aggro_radius, b.leash_radius, b.chase_style, b.preferred_range,
            b.move_speed_mult, b.damage_override
     FROM entity_types e
     LEFT JOIN creature_behaviors b ON b.id = e.behavior_id
     WHERE e.is_creature = true ORDER BY e.id ASC`,
  );
  const creatureTypes = r.rows.map((row) => ({
    name: row.name,
    hp: row.hp,
    color: row.color,
    faction: row.faction || 'hostile',
    attackElement: row.attack_element || 'physical',
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
  // creatureTypes/creatureTypeIds stay COMPLETE (guards included): drops and
  // name→id lookups still need to see guards. The wild-spawn exclusion of
  // guard-faction types lives at the one place that still rolls a wild-spawn
  // pool -- worldPopulation.js's own `hostileTypes` filter -- not here; this
  // function no longer has a wild-spawn caller of its own (SOMET-246).
  return { creatureTypes, creatureTypeIds, creatureGold };
}

function center(o) { return { x: o.x + o.width / 2, y: o.y + o.height / 2 }; }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }

// A guard with no home anchor is unconstrained (matches a hostile's
// leash-from-self behavior for creatures that predate the anchor column).
function withinLeash(x, y, home, radius) {
  if (!home) return true;
  return dist2(x, y, home.x, home.y) <= radius * radius;
}

// Nearest hostile-faction creature a guard may engage: within aggroRadius of
// the guard AND within leashRadius of the guard's post, so a guard never locks
// onto something it is not allowed to chase.
function selectGuardTarget({ guard, creatures, aggroRadius, leashRadius }) {
  const gc = center(guard);
  let best = null, bd2 = aggroRadius * aggroRadius;
  for (const o of creatures) {
    // `creatures` may be a pre-loop snapshot: a candidate killed earlier this
    // same tick (by another guard) is still present in the array but its hp
    // was already driven to <=0 in place before removal from the sim, so
    // this guards against handing back a dead target.
    if (o === guard || o.faction !== 'hostile' || o.hp <= 0) continue;
    const oc = center(o);
    if (!withinLeash(oc.x, oc.y, guard.home, leashRadius)) continue;
    const d2 = dist2(gc.x, gc.y, oc.x, oc.y);
    if (d2 <= bd2) { bd2 = d2; best = o; }
  }
  return best;
}
// Applied at the call site, not by mutating c.speed: a persisted speed would
// compound every tick.
function movedWith(map, c, vx, vy, dt, mult) {
  if (mult === 1) return resolveMove(map, c, vx, vy, dt);
  return resolveMove(map, { ...c, speed: c.speed * mult }, vx, vy, dt);
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
function resolveInstanceBehavior(c) {
  if (c.behavior) return { ...DEFAULT_BEHAVIOR, ...c.behavior };
  if (c.behavior_name != null) return resolveBehavior(c);
  return (c.faction || 'hostile') === 'guard' ? GUARD_DEFAULT_BEHAVIOR : { ...DEFAULT_BEHAVIOR };
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
        _target: null, _targetKind: null, mode: 'roam', _attackCd: 0,
      });
    }
  }

  has(id) { return this.creatures.has(id); }
  count() { return this.creatures.size; }
  all() { return [...this.creatures.values()]; }

  // `now` is the world clock, threaded in for the same reason the attack
  // resolvers take it: damage reads the target's live status effects (shock's
  // vulnerability) and this module must never read a clock of its own.
  tick(dt, activeChunkKeys, players = [], now = 0) {
    const active = activeChunkKeys instanceof Set ? activeChunkKeys : new Set(activeChunkKeys);
    const byId = new Map(players.map((p) => [p.userId, p]));
    const killed = [];
    // Empty until creatures can fire (Task 9). The return shape is { killed,
    // shots } from this task forward so callers do not have to change again
    // when shots stops being empty.
    const shots = [];
    const all = [...this.creatures.values()];
    for (const c of this.creatures.values()) {
      const { cx, cy } = chunkOf(c.x, c.y, this.chunkSize);
      if (!active.has(CHUNK_KEY(cx, cy))) continue; // frozen (out of active set)
      const bh = c.behavior || DEFAULT_BEHAVIOR;
      if (c._attackCd > 0) c._attackCd = Math.max(0, c._attackCd - dt);

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
        let tgt = (!displaced && c._target) ? this.creatures.get(c._target) : null;
        if (tgt && (tgt.hp <= 0 || tgt.faction !== 'hostile'
            || !withinLeash(center(tgt).x, center(tgt).y, c.home, bh.leashRadius))) {
          tgt = null;
        }
        if (!displaced && !tgt) {
          // `all` is a pre-loop snapshot; selectGuardTarget skips any
          // candidate already killed earlier this tick (hp <= 0), so a
          // creature removed from this.creatures by an earlier guard in this
          // same loop is never handed back as a live target.
          tgt = selectGuardTarget({
            guard: c, creatures: all,
            aggroRadius: bh.aggroRadius, leashRadius: bh.leashRadius,
          });
        }
        c._target = tgt ? tgt.id : null;
        c._targetKind = tgt ? 'creature' : null;

        if (tgt) {
          c.mode = 'chase';
          const tc = center(tgt);
          const vx = tc.x - cc.x, vy = tc.y - cc.y;
          const r = movedWith(this.map, c, vx, vy, dt, bh.moveSpeedMult);
          // Leash clamp: a step that would leave the post's radius is refused.
          if ((r.x !== c.x || r.y !== c.y)
              && withinLeash(r.x + c.width / 2, r.y + c.height / 2, c.home, bh.leashRadius)) {
            c.x = r.x; c.y = r.y;
            const f = facingFor(vx, vy); if (f) c.facing = f;
            c.dirty = true;
          }
          if (c._attackCd <= 0 && canAct(c, now)
              && dist2(cc.x, cc.y, tc.x, tc.y) <= bh.attackRange * bh.attackRange) {
            applyDamageWithEffects(tgt, bh.damageOverride ?? (c.damage ?? CREATURE_DAMAGE), 'physical', tgt.mit || NO_MITIGATION, now);
            tgt.dirty = true;
            c._attackCd = bh.attackCooldown;
            if (tgt.hp <= 0) { this.creatures.delete(tgt.id); killed.push(tgt.id); }
          }
          continue;
        }

        // No target: walk back to the post, then stand still.
        if (c.home) {
          const dx = c.home.x - cc.x, dy = c.home.y - cc.y;
          if (Math.hypot(dx, dy) > GUARD_HOME_EPSILON) {
            c.mode = 'return';
            const r = movedWith(this.map, c, dx, dy, dt, bh.moveSpeedMult);
            if (r.x !== c.x || r.y !== c.y) {
              c.x = r.x; c.y = r.y;
              const f = facingFor(dx, dy); if (f) c.facing = f;
              c.dirty = true;
            }
          } else {
            c.mode = 'guard';
          }
        } else {
          c.mode = 'guard';
        }
        continue;
      }
      // --- end guard branch; hostile path below is unchanged ---

      // Target resolution: keep current target unless it left leash; else acquire nearest in aggro.
      if (c._target) {
        const tp = byId.get(c._target);
        if (!tp || dist2(cc.x, cc.y, center(tp).x, center(tp).y) > bh.leashRadius * bh.leashRadius) c._target = null;
      }
      if (!c._target) {
        let nearest = null, nd2 = bh.aggroRadius * bh.aggroRadius;
        for (const p of players) {
          const pc = center(p);
          const d2 = dist2(cc.x, cc.y, pc.x, pc.y);
          if (d2 <= nd2) { nd2 = d2; nearest = p; }
        }
        if (nearest) c._target = nearest.userId;
      }
      c.mode = c._target ? 'chase' : 'roam';

      if (c.mode === 'chase') {
        const tp = byId.get(c._target);
        const tc = center(tp);
        const dist = Math.hypot(tc.x - cc.x, tc.y - cc.y);
        let vx = tc.x - cc.x, vy = tc.y - cc.y;
        let move = true;

        if (bh.chaseStyle === 'hold') {
          // Never moves. It still attacks below if the target is in range.
          move = false;
        } else if (bh.chaseStyle === 'kite') {
          // Three bands: too close -> back away; too far -> close; in between
          // -> stand and shoot. Without the middle band a kiter oscillates
          // one step per tick and never fires.
          if (dist < bh.preferredRange) { vx = -vx; vy = -vy; }
          else if (dist <= bh.attackRange) { move = false; }
        } else if (bh.chaseStyle === 'skirmish') {
          // Retreat while the attack is on cooldown, close while it is ready.
          // Reading _attackCd is what makes this hit-and-run rather than a
          // timer that ignores whether the strike actually landed.
          if (c._attackCd > 0 && dist < bh.preferredRange) { vx = -vx; vy = -vy; }
        }
        // 'charge' and 'ambush' fall through with the straight-at-target
        // vector -- an aggroed ambusher IS a charger, it just started asleep.

        if (move) {
          const r = movedWith(this.map, c, vx, vy, dt, bh.moveSpeedMult);
          if (r.x !== c.x || r.y !== c.y) {
            c.x = r.x; c.y = r.y;
            const f = facingFor(vx, vy); if (f) c.facing = f;
            c.dirty = true;
          }
        }
        // Contact damage. Gated by canAct for the same reason the player
        // attack paths are (world.js's canAttack/attack): a shocked creature
        // must miss its bite.
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
        // _attackCd is not stamped, so the creature bites as soon as it recovers
        // rather than also serving a fresh cooldown for the swing it never took.
        // The immunity window in applyShockInterrupt (stamped once, deliberately
        // never refreshed) is what stops this becoming a perma-stun — it applies
        // to creatures for free, because it lives on the target.
        if (c._attackCd <= 0 && canAct(c, now)
            && dist2(cc.x, cc.y, tc.x, tc.y) <= bh.attackRange * bh.attackRange) {
          applyDamageWithEffects(tp, bh.damageOverride ?? (c.damage ?? CREATURE_DAMAGE), 'physical', tp.mit || NO_MITIGATION, now);
          c._attackCd = bh.attackCooldown;
        }
        continue;
      }

      // Roam. `hold` never moves at all, and `ambush` lies dormant until
      // something enters its aggro radius -- for both, "no target" means
      // "stand still", not "wander".
      if (bh.chaseStyle === 'hold' || bh.chaseStyle === 'ambush') continue;

      if (this.rng() < REDIRECT_CHANCE) {
        c._dir = Math.min(DIRS.length - 1, Math.floor(this.rng() * DIRS.length));
      }
      const [dx, dy] = DIRS[c._dir];
      const r = movedWith(this.map, c, dx, dy, dt, bh.moveSpeedMult);
      if (r.x !== c.x || r.y !== c.y) {
        c.x = r.x; c.y = r.y;
        c.facing = DIR_FACING[c._dir];
        c.dirty = true;
      } else {
        c._dir = (c._dir + 1) % DIRS.length; // blocked → turn
      }
    }
    return { killed, shots };
  }

  // Player melee: damage creatures within `range` of (px,py); remove + return dead ids.
  // `now` is the world clock, needed to stamp the element's status rider.
  applyAttack(px, py, range, damage, element, now = 0) {
    const killed = [];
    const r2 = range * range;
    for (const [id, c] of this.creatures) {
      const cc = center(c);
      if (dist2(cc.x, cc.y, px, py) > r2) continue;
      applyDamageWithEffects(c, damage, element, c.mit || NO_MITIGATION, now);
      applyElementEffect(c, element, now);
      c.dirty = true;
      if (c.hp <= 0) { this.creatures.delete(id); killed.push(id); }
    }
    return killed;
  }

  // Ids of every live creature a melee swing would connect with: inside the
  // arc AND with line of sight. Damages nothing.
  //
  // Split out of applyMeleeArc so an attack can report whether it CONNECTED
  // (frame.attacks `hit`) — killed ids alone cannot answer that, since a
  // creature hit for non-lethal damage appears in neither list. applyMeleeArc
  // iterates this, so both share ONE arc rule and cannot drift apart.
  meleeArcTargets(ox, oy, nx, ny, reach, arcWidth) {
    const ids = [];
    for (const [id, c] of this.creatures) {
      const cc = center(c);
      if (!inArc(ox, oy, nx, ny, cc.x, cc.y, reach, arcWidth)) continue;
      // Terrain blocks the swing, exactly as it blocks a projectile.
      if (!hasLineOfSight(this.map, ox, oy, cc.x, cc.y)) continue;
      ids.push(id);
    }
    return ids;
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
      applyDamageWithEffects(c, damage, element, c.mit || NO_MITIGATION, now);
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
  damageCreatureById(id, damage, element, now) {
    const c = this.creatures.get(id);
    if (!c) return false;
    applyDamageWithEffects(c, damage, element, c.mit || NO_MITIGATION, now);
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
}

module.exports = {
  CreatureSim, loadCreatureTypes, creatureMitigation,
  CREATURE_SIZE, CREATURE_SPEED, REDIRECT_CHANCE,
  AGGRO_RADIUS, LEASH_RADIUS, CONTACT_RANGE, CREATURE_DAMAGE, CREATURE_ATTACK_COOLDOWN,
  GUARD_AGGRO_RADIUS, GUARD_LEASH_RADIUS, GUARD_DAMAGE, GUARD_HOME_EPSILON,
  withinLeash, selectGuardTarget,
};
