// Server-simulated projectiles (arrows, magic bolts, …). Transient in-memory
// only — never persisted, no randomness. Collides with terrain, creatures, and
// players (never the owner). Ranged and magic share this one path; they differ
// only by weapon data.

const { resolveEffectName } = require('./vfx.js');
const { applyDamageWithEffects, NO_MITIGATION } = require('./damage');
const { hasLineOfSight } = require('./weapons');
const { applyElementEffect } = require('./effects');
const { shoveAwayFrom } = require('./knockback');

// Sub-step resolution for terrain sampling, shared with the melee
// line-of-sight walk in weapons.js. Defined in subStep.js (see the note there
// on why it cannot live in either consumer) and re-exported here, which is
// where callers have always imported it from.
const { MAX_SUB } = require('./subStep');

function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }

// Who a projectile may damage. These mirror the targeting rules CreatureSim
// already enforces -- guards engage only hostiles, hostiles never target
// guards, and neither targets its own faction -- rather than inventing a
// second rule set that could drift from them.
//
// The owner exclusion is folded in here as the same rule generalised: a
// projectile never damages its own shooter, whoever that is.
function projectileHitsCreature(p, creature) {
  if (p.ownerKind !== 'creature') return true;        // player shots hit any creature
  if (p.ownerId === creature.id) return false;        // never its own shooter
  const targetFaction = creature.faction || 'hostile';
  return p.ownerFaction !== targetFaction;            // never same faction
}

function projectileHitsPlayer(p, player) {
  if (p.ownerKind !== 'creature') return player.userId !== p.ownerId;
  // A guard's arrow must never hit the player it is defending.
  return p.ownerFaction === 'hostile';
}

// The killer credited for a creature kill this projectile scores. A
// creature-owned shot's `ownerId` is the shooter creature's id, not a
// player's -- crediting it straight through would hand loot.js a bogus
// killerUserId (a creature uuid) instead of "no player". commitCreatureDeath
// already treats null as the no-credit path (the one guard kills take) and
// skips the XP branch entirely rather than awarding zero, so creature-owned
// kills must come through as null here, not as p.ownerId.
function killerUserIdFor(p) {
  return p.ownerKind === 'creature' ? null : (p.ownerId ?? null);
}

// Projectile impacts shove a surviving target (player OR creature) away
// from the blast centre / impact point via authority/knockback.js's
// shoveAwayFrom (imported above) -- the same shared wrapper
// authority/creatures.js's melee branches and authority/world.js's weapon
// branches use. Callers below are responsible for only invoking it on a
// survivor (a creature this hit did not kill; a player whose hp is still
// > 0).
class ProjectileSim {
  constructor() {
    this.projectiles = [];
    this._id = 0;
  }

  // `damage` is an explicit snapshot taken by the caller (weaponDamage(p, w)
  // in world.js), not recomputed from `weapon` here. A projectile already in
  // flight must not change damage because its owner respecced mid-flight --
  // falls back to weapon.damage so callers that don't pass one (existing
  // tests, stub weapons) are unaffected.
  spawn({
    ownerId, ownerKind = 'player', ownerFaction = null, x, y, nx, ny, weapon, damage,
  }) {
    const id = String(++this._id);
    this.projectiles.push({
      id,
      ownerId,
      // 'player' by default so every existing call site is byte-identical.
      // A creature-owned shot carries its shooter's faction, which is what
      // the targeting rules below key on.
      ownerKind,
      ownerFaction,
      x, y,
      vx: nx * weapon.projectile_speed,
      vy: ny * weapon.projectile_speed,
      remaining: weapon.range,
      damage: damage ?? weapon.damage,
      radius: weapon.projectile_radius,
      pierceLeft: weapon.pierce,
      // null = today's point-collision projectile, unchanged. Normalized here
      // so a 0/negative/non-finite radius can never reach the falloff division.
      aoeRadius: weapon.aoe_radius > 0 ? weapon.aoe_radius : null,
      element: weapon.element ?? null,
      // Slice D (SOMET-161): the resolved TRAIL effect name, taken once at
      // launch and carried for the shot's whole flight. Resolved server-side
      // like every other effect name -- the client has no weapon catalog --
      // and taken at spawn for the same reason `damage` is: swapping weapons
      // mid-flight must not restyle a shot already in the air.
      // null when the weapon binds no trail, which is the client's signal to
      // fall back to the plain dot rather than draw nothing.
      vfxTrail: resolveEffectName(weapon, 'trail'),
      // 0 for every weapon-shaped source that carries no knockback field
      // (every player weapon today) -- a creature shot's ability.knockback
      // is the only live non-zero source until item_types gains its own.
      knockback: Number.isFinite(weapon.knockback) ? weapon.knockback : 0,
      hitIds: new Set(), // 'c:<id>' / 'p:<id>' already hit by this projectile
      // Magic Stones (SOMET-245) Task 7: the socketed spell stone's own
      // player_items.id, read straight off `weapon` (items.js's
      // activeWeaponType already merged it there when a spell stone is
      // active -- see that function). null for every ordinary
      // weapon-shaped source, including every creature-fired ability
      // (world.js's tickCreatures builds those objects without this field),
      // so a creature's shot never awards a player's stone XP. Snapshotted
      // at spawn, same as `damage` above -- a projectile already in flight
      // must not change which stone it credits because the player
      // unsocketed mid-flight.
      stoneItemId: weapon.stoneItemId ?? null,
    });
    return id;
  }

  // Resolve an AoE blast at (bx,by). Damages every creature and every
  // non-owner player within `radius`, scaled linearly from full damage at the
  // centre to zero at the edge.
  //
  // Each candidate needs line of sight FROM THE BLAST POINT: without it AoE
  // reintroduces the melee-through-walls exploit closed in 3b-3a, with a
  // bigger hitbox. Reuses the same helper and the same shared MAX_SUB.
  //
  // The caster is exempt, matching the existing rule that a projectile never
  // collides with its owner — one rule, not two.
  //
  // `kills` accumulates { id, killerUserId } objects, not bare ids — every
  // creature this blast finishes off is credited to `p.ownerId`, the
  // projectile's OWN owner (captured once, at spawn), regardless of who is
  // currently attacking when the shot actually lands.
  // `stoneHits` accumulates one entry per creature/player this blast actually
  // damaged (mirrors `kills`' own per-target accumulation) -- ONLY when this
  // projectile carries a stoneItemId, so an ordinary AoE weapon (no stone
  // socketed) pushes nothing. Task 7: an AoE spell stone's XP is earned per
  // target caught in the blast, matching the direct-hit branches in step()
  // below rather than a single flat award per detonation regardless of how
  // many targets it actually caught.
  _detonate(p, bx, by, { creatureList, creatures, players, map, now }, kills, stoneHits) {
    const r = p.aoeRadius;
    for (const c of creatureList) {
      if (!projectileHitsCreature(p, c)) continue;
      const half = c.width / 2;
      const cx = c.x + half, cy = c.y + c.height / 2;
      const d = Math.hypot(cx - bx, cy - by);
      if (d >= r) continue;
      if (!hasLineOfSight(map, bx, by, cx, cy)) continue;
      // Falloff scales the RAW damage; the creature's own defense and
      // resistances are applied on top, inside damageCreatureById.
      if (creatures.damageCreatureById(c.id, p.damage * (1 - d / r), p.element, now)) {
        kills.push({ id: c.id, killerUserId: killerUserIdFor(p) });
      } else if (p.knockback > 0) {
        // Survivors only -- a creature the line above already deleted must
        // never be shoved. Origin is the blast centre, not the projectile's
        // travel direction: an AoE's shove radiates outward from where it
        // detonated.
        shoveAwayFrom(map, bx, by, c, p.knockback);
      }
      if (p.stoneItemId != null) stoneHits.push({ stoneItemId: p.stoneItemId });
      // The rider is applied at FULL duration: falloff scales damage only. A
      // target clipped by the blast edge still burns for the full time —
      // scaling the duration too would give it a burn too short to ever tick.
      //
      // sourceId is killerUserIdFor(p), NOT p.ownerId: a creature-owned shot's
      // ownerId is a world_creatures uuid, and a later burn tick that finishes
      // the target off (world.js's tick()) reports effects[key].sourceId
      // straight through as killerUserId -- the exact uuid-into-an-integer-
      // column crash killerUserIdFor exists to prevent on the direct-hit path.
      applyElementEffect(c, p.element, now, killerUserIdFor(p));
    }
    for (const pl of players) {
      if (!projectileHitsPlayer(p, pl)) continue;
      const half = pl.width / 2;
      const px = pl.x + half, py = pl.y + pl.height / 2;
      const d = Math.hypot(px - bx, py - by);
      if (d >= r) continue;
      if (!hasLineOfSight(map, bx, by, px, py)) continue;
      // Falloff scales the RAW damage; applyDamage still applies defense and
      // resistances on top. It floors at 1, so an edge hit still registers.
      applyDamageWithEffects(pl, p.damage * (1 - d / r), p.element, pl.mit || NO_MITIGATION, now);
      applyElementEffect(pl, p.element, now, p.ownerId);
      // Survivors only -- a player never gets removed from `players` on
      // death (resolveDeaths respawns them separately), so the check here is
      // the same hp > 0 gate creatures.js uses, not a delete-happened check.
      if (pl.hp > 0 && p.knockback > 0) shoveAwayFrom(map, bx, by, pl, p.knockback);
      if (p.stoneItemId != null) stoneHits.push({ stoneItemId: p.stoneItemId });
    }
    return { x: bx, y: by, radius: r, element: p.element };
  }

  // Advance every projectile one tick; resolve terrain, creature, and player
  // collisions. Returns the creatures killed this step — as { id,
  // killerUserId } objects, credited to each projectile's OWN `ownerId` (for
  // the caller to DELETE and credit) — and the AoE blasts that went off (for
  // the caller to broadcast).
  //
  // An AoE projectile detonates on its FIRST contact of ANY kind — terrain, a
  // creature, a player, or running out of range — instead of applying the
  // single-target hit. Exactly one detonation per projectile: every path that
  // sets `dead` for an impact detonates, and `dead` ends the walk.
  //
  // Movement is SUB-STEPPED in <=MAX_SUB px increments so a fast projectile
  // cannot tunnel through a target within a single tick: a bow (900 px/s) moves
  // ~45 px per 20 Hz tick, larger than a creature's ~32 px capture radius, so a
  // single end-of-tick position check would miss. `pierceLeft` starts at the
  // weapon's `pierce` (targets it can hit); it despawns once that reaches 0.
  step(dt, { creatures, players, map, now = 0 }) {
    const kills = [];
    const detonations = [];
    const survivors = [];
    // Magic Stones (SOMET-245) Task 7: one entry per landed hit whose
    // projectile carries a stoneItemId (spawn() reads this off the merged
    // weapon -- see the field's own comment there). Threaded through
    // exactly like `kills` is: pushed at every point a hit actually lands
    // (direct or via _detonate), returned from step() for the caller
    // (world.js's tickProjectiles -> server.js) to award XP against.
    const stoneHits = [];
    const creatureList = creatures.all(); // hoisted: creatures don't move during this step
    const ctx = { creatureList, creatures, players, map, now };
    for (const p of this.projectiles) {
      const speed = Math.hypot(p.vx, p.vy);
      let dead = !(speed > 0) || !Number.isFinite(speed) || !Number.isFinite(p.x) || !Number.isFinite(p.y);
      const ux = speed === 0 ? 0 : p.vx / speed;
      const uy = speed === 0 ? 0 : p.vy / speed;
      let moveLeft = speed * dt;

      while (moveLeft > 0 && !dead) {
        const stepDist = Math.min(MAX_SUB, moveLeft);
        p.x += ux * stepDist; p.y += uy * stepDist;
        p.remaining -= stepDist; moveLeft -= stepDist;

        // Terrain: walls stop projectiles.
        if (!map.isWalkable(p.x, p.y)) {
          if (p.aoeRadius) detonations.push(this._detonate(p, p.x, p.y, ctx, kills, stoneHits));
          dead = true; break;
        }

        // Creatures.
        for (const c of creatureList) {
          if (!projectileHitsCreature(p, c)) continue;
          const key = `c:${c.id}`;
          if (p.hitIds.has(key)) continue;
          const half = c.width / 2;
          const cx = c.x + half, cy = c.y + c.height / 2;
          const rr = p.radius + half;
          if (dist2(p.x, p.y, cx, cy) <= rr * rr) {
            if (p.aoeRadius) {
              detonations.push(this._detonate(p, p.x, p.y, ctx, kills, stoneHits));
              dead = true; break;
            }
            p.hitIds.add(key);
            if (creatures.damageCreatureById(c.id, p.damage, p.element, now)) {
              kills.push({ id: c.id, killerUserId: killerUserIdFor(p) });
            } else if (p.knockback > 0) {
              // Survivors only. Origin is the projectile's own current
              // position -- the point of direct contact, not the blast
              // centre (this is the swept/direct-hit path, not an AoE).
              shoveAwayFrom(map, p.x, p.y, c, p.knockback);
            }
            // See the _detonate comment above: killerUserIdFor(p), not
            // p.ownerId -- the same uuid-into-killerUserId bug, reachable
            // here via a later burn tick rather than this hit itself.
            applyElementEffect(c, p.element, now, killerUserIdFor(p));
            if (p.stoneItemId != null) stoneHits.push({ stoneItemId: p.stoneItemId });
            p.pierceLeft -= 1;
            if (p.pierceLeft <= 0) { dead = true; break; }
          }
        }
        if (dead) break;

        // Players (never the owner; never a creature owner's own faction ally).
        for (const pl of players) {
          if (!projectileHitsPlayer(p, pl)) continue;
          const key = `p:${pl.userId}`;
          if (p.hitIds.has(key)) continue;
          const half = pl.width / 2;
          const px = pl.x + half, py = pl.y + pl.height / 2;
          const rr = p.radius + half;
          if (dist2(p.x, p.y, px, py) <= rr * rr) {
            if (p.aoeRadius) {
              detonations.push(this._detonate(p, p.x, p.y, ctx, kills, stoneHits));
              dead = true; break;
            }
            p.hitIds.add(key);
            applyDamageWithEffects(pl, p.damage, p.element, pl.mit || NO_MITIGATION, now);
            applyElementEffect(pl, p.element, now, p.ownerId);
            // Survivors only. Origin is the projectile's own current
            // position, matching the creature branch just above.
            if (pl.hp > 0 && p.knockback > 0) shoveAwayFrom(map, p.x, p.y, pl, p.knockback);
            if (p.stoneItemId != null) stoneHits.push({ stoneItemId: p.stoneItemId });
            p.pierceLeft -= 1;
            if (p.pierceLeft <= 0) { dead = true; break; }
          }
        }
        if (dead) break;

        // Out of range counts as an impact: a fireball that reaches the end of
        // its flight without touching anything still explodes.
        if (p.remaining <= 0) {
          if (p.aoeRadius) detonations.push(this._detonate(p, p.x, p.y, ctx, kills, stoneHits));
          dead = true; break;
        }
      }

      if (!dead) survivors.push(p);
    }
    this.projectiles = survivors;
    return { kills, detonations, stoneHits };
  }

  snapshot() {
    return this.projectiles.map((p) => ({
      id: p.id, x: p.x, y: p.y, element: p.element,
      // Unit direction of travel. The snapshot carried position ONLY, so a
      // client drawing a trail had nothing to orient it by -- it would have
      // fallen back to the plain dot on every shot, forever, with every test
      // still green. Normalized here rather than shipping raw vx/vy so the
      // client cannot accidentally scale a streak by projectile speed.
      nx: p.vx / (Math.hypot(p.vx, p.vy) || 1),
      ny: p.vy / (Math.hypot(p.vx, p.vy) || 1),
      // Carried on every snapshot rather than sent once at spawn: the client
      // has no projectile-spawn message to hang it off, and a shot that flies
      // into a newly-streamed neighbourhood must still draw its trail.
      v: p.vfxTrail || null,
    }));
  }

  count() { return this.projectiles.length; }

  // Count only creature-owned projectiles -- what MAX_CREATURE_PROJECTILES in
  // world.js actually needs to bound. Kept here rather than having World
  // reach into `this.projectiles` directly, matching count()'s existing
  // encapsulation.
  countByOwnerKind(ownerKind) {
    let n = 0;
    for (const p of this.projectiles) if (p.ownerKind === ownerKind) n++;
    return n;
  }
}

module.exports = { ProjectileSim, MAX_SUB };
