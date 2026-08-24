// Server-simulated projectiles (arrows, magic bolts, …). Transient in-memory
// only — never persisted, no randomness. Collides with terrain, creatures, and
// players (never the owner). Ranged and magic share this one path; they differ
// only by weapon data.

const { resolveEffectName, blockedImpact } = require('./vfx.js');
const { bodyLift } = require('./attackOrigin.js');
const {
  applyDamageWithEffects, NO_MITIGATION, playerKey, creatureKey,
} = require('./damage');
const { hasLineOfSight } = require('./weapons');
const { applyElementEffect } = require('./effects');
const { shoveAwayFrom } = require('./knockback');
// SOMET-283: the leash-aware creature shove. The clamp is a creature-domain
// rule and lives next to the guard constants that define what a post is, rather
// than being duplicated here. No import cycle: creatures.js does not require
// this module.
// SOMET-285: immuneToPlayerDamage is creatures.js's ONE guard predicate (the
// resolved behaviour's chaseStyle), imported rather than re-expressed here as
// a faction test -- a second definition would drift from the tick's own
// routing and would wrongly sweep in the hostile portal guards.
const { shoveCreature, immuneToPlayerDamage } = require('./creatures');

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
//
// SOMET-285: a PLAYER's shot hits any creature EXCEPT a guard. This one
// predicate is the whole projectile half of the fix -- both the swept
// direct-hit branch and the AoE `_detonate` gate every creature they touch on
// it, so the damage, the element's status rider, the knockback and the stone
// XP all fall away together for a guard rather than one of them being missed.
//
// A HOSTILE's shot still hits a guard (the line below is unchanged, and
// 'hostile' !== 'guard'). That is deliberate: this ticket removes the PLAYER
// from a guard's damage graph, and a hostile that could not scratch a guard
// would make the guard-vs-hostile fight -- the one fight guards exist for --
// one-sided in a way nobody asked for. It is not an exploit route either: at
// level 150 a guard's 84.5 defence puts every hostile in the catalog on the
// MIN_DAMAGE floor, i.e. 7005 landed shots to kill one, while the guard needs
// 4 swings to kill the hostile.
function projectileHitsCreature(p, creature) {
  if (p.ownerKind !== 'creature') {
    // SOMET-473 -- the Druid's player pacify (spec 8.2). The charmer's pets are
    // off this shot's target list, snapshotted at LAUNCH (see world.js's spawn
    // call), so a charm that lapses mid-flight cannot make an arrow already in
    // the air lethal to the charmer's pack.
    if (p.pacifiedFrom != null && creature.charmOwnerUserId === p.pacifiedFrom) return false;
    return !immuneToPlayerDamage(creature);
  }
  if (p.ownerId === creature.id) return false;        // never its own shooter
  const targetFaction = creature.faction || 'hostile';
  return p.ownerFaction !== targetFaction;            // never same faction
}

// SOMET-286: of everything projectileHitsCreature refuses, only ONE case is a
// refusal the shooter deserves to see -- a PLAYER's shot passing through a
// guard. The others (a shot meeting its own shooter, a hostile's shot meeting
// another hostile) are ordinary targeting that no player is aiming at and that
// would produce a shield glint on every creature a stray arrow flew past.
//
// Keyed on the same immuneToPlayerDamage predicate the refusal itself is, so
// the cue and the rule cannot disagree about who is a guard.
function projectileBlockedBy(p, creature) {
  // SOMET-473: a pacified shot passing through the charmer's pet is the same
  // kind of refusal a guard's is -- a rule the shooter is entitled to see --
  // so it earns the same cue. Kept in step with meleeArcScan's `blocked` list,
  // which draws exactly this distinction for the melee half.
  if (p.ownerKind !== 'creature' && p.pacifiedFrom != null
      && creature.charmOwnerUserId === p.pacifiedFrom) return true;
  return p.ownerKind !== 'creature' && immuneToPlayerDamage(creature);
}

// One block cue per (projectile, guard), tracked in the SAME hitIds set a
// landed hit uses -- under a distinct `b:` prefix so a guard can never
// collide with a real hit's `c:` key. Without this a piercing shot, or an
// AoE that both passes through a guard and detonates next to it, would stack
// several glints on one target for one shot.
function recordBlock(p, c, x, y, nx, ny, blocks) {
  const key = `b:${c.id}`;
  if (p.hitIds.has(key)) return;
  p.hitIds.add(key);
  // SOMET-326: anchored on the GUARD that refused the shot, not on the
  // projectile's own launch height -- a block is a fact about the target. The
  // shooter may be long gone, but `c` is in hand right here.
  blocks.push(blockedImpact(c.id, x, y, nx, ny, bodyLift(c.height, 'middle')));
}

// SOMET-343: an augment stone's bonus, applied to a CREATURE as a second
// damage packet in the augment's own element.
//
// ORDERING RULE, and the reason this helper exists at all. Unlike the melee
// path -- where both packets land inside applyMeleeArc's single loop, before
// one hp<=0 check -- every creature site here goes through
// damageCreatureById, which applies damage AND resolves the kill AND deletes
// the creature. So the bonus MUST land BEFORE the weapon's own packet:
//
//   * applied after, and the creature may already be deleted -- the bonus
//     silently vanishes on exactly the hits that mattered most;
//   * applied after and allowed to kill, and one projectile hit produces TWO
//     kill signals, so loot and XP fire twice.
//
// Landing first leaves the main packet's existing kill check as the single
// authority, and every call site below keeps the kill bookkeeping it already
// had. Total damage and kill credit are identical either way; the only
// visible difference is that a rider (chill, burn) is applied before the
// weapon packet is mitigated rather than after.
//
// Returns true if the bonus KILLED the creature -- callers must report that
// kill themselves, because the main packet that follows will find nothing.
function applyCreatureAugment(p, creatures, c, scale, now) {
  if (!p.augment || !(p.augment.bonusDamage > 0)) return false;
  const died = creatures.damageCreatureById(
    c.id, p.augment.bonusDamage * scale, p.augment.element, now, provokerKeyFor(p),
  );
  if (!died) applyElementEffect(c, p.augment.element, now, killerUserIdFor(p));
  return died;
}

// The player-side equivalent. Deliberately much simpler and NOT sharing the
// function above: a player is never removed from `players` on death
// (resolveDeaths respawns them separately), so there is no deletion hazard and
// no kill to report -- the ordering that is load-bearing for creatures is
// merely cosmetic here.
function applyPlayerAugment(p, pl, scale, now) {
  if (!p.augment || !(p.augment.bonusDamage > 0)) return;
  applyDamageWithEffects(pl, p.augment.bonusDamage * scale, p.augment.element,
    pl.mit || NO_MITIGATION, now, provokerKeyFor(p));
  applyElementEffect(pl, p.augment.element, now, p.ownerId);
}

function projectileHitsPlayer(p, player) {
  if (p.ownerKind !== 'creature') {
    // Same rule, other target kind: a pacified shooter cannot hit their charmer.
    if (p.pacifiedFrom != null && player.userId === p.pacifiedFrom) return false;
    return player.userId !== p.ownerId;
  }
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

// SOMET-290 — who this shot's target should hold responsible.
//
// Deliberately NOT killerUserIdFor: that function exists to erase a creature
// shooter (a uuid where loot.js needs a userId or null), and erasing it here
// would tell a skittish creature it was hit by "nobody in particular", i.e.
// that it may charge whichever player happens to be nearby. Provocation is
// about identity, not about credit, so a creature-owned shot is tagged as the
// creature it came from and simply matches no player.
function provokerKeyFor(p) {
  return p.ownerKind === 'creature' ? creatureKey(p.ownerId) : playerKey(p.ownerId);
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
  // SOMET-343: `ammo` is the item_types row of the ammunition this shot
  // consumed, or null. Before this slice ProjectileSim read ONLY `weapon.*`,
  // so an ammo row was spent and then contributed nothing to the shot it
  // became -- "explosive arrows" could not be authored at all.
  spawn({
    ownerId, ownerKind = 'player', ownerFaction = null, x, y, nx, ny, weapon, damage,
    originLift, ammo = null, pacifiedFrom = null,
  }) {
    const id = String(++this._id);
    // Ammo wins over the weapon where it speaks, so an explosive arrow makes
    // an ordinary bow detonate. A silent ammo row (no aoe of its own) leaves
    // the weapon's own value alone, which is every arrow in the game today.
    const mergedAoe = ammo && ammo.aoe_radius > 0 ? ammo.aoe_radius : weapon.aoe_radius;
    // THE MERGED-STATE GUARD. item_types_aoe_pierce_check ("a detonating
    // projectile may not also pierce") is a ROW-level CHECK: it validates the
    // arbalest row and the explosive-bolt row separately, and both pass on
    // their own -- pierce 2 with no aoe, aoe with no pierce. The forbidden
    // combination only ever exists HERE, in memory, after the merge, where no
    // constraint can see it.
    //
    // Resolved by clamping pierce, not by dropping the aoe, because that is
    // the direction the constraint's own comment argues: "A detonating
    // projectile has nothing left to pierce with". A shot that detonates is
    // over.
    // SOMET-343 part 3. WHERE a detonating shot goes off. Ammo wins over the
    // weapon, as with the radius. Anything other than an explicit 'max_range'
    // is 'contact' -- which is what every weapon authored before this slice
    // resolves to, so none of them change.
    const mergedDetonateAt = (ammo && ammo.detonate_at) || weapon.detonate_at;
    const detonateAt = mergedDetonateAt === 'max_range' ? 'max_range' : 'contact';

    const rawPierce = weapon.pierce;
    // The pierce clamp applies ONLY to a contact detonator. A max_range shot
    // is defined by flying THROUGH what it meets, so clamping it to one target
    // would stop it at the first creature and it would never reach the range
    // it is supposed to explode at -- the feature would be inert.
    const mergedPierce = detonateAt === 'contact' && mergedAoe > 0 && rawPierce > 1 ? 1 : rawPierce;
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
      pierceLeft: mergedPierce,
      // null = today's point-collision projectile, unchanged. Normalized here
      // so a 0/negative/non-finite radius can never reach the falloff division.
      aoeRadius: mergedAoe > 0 ? mergedAoe : null,
      detonateAt,
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
      // SOMET-326: the vertical render anchor, in screen pixels up from the
      // SHOOTER's feet, resolved at launch and carried for the whole flight
      // (and inherited by this shot's detonation). Snapshotted for the same
      // reason `damage` and `vfxTrail` above are, plus one specific to this
      // field: by the time the shot lands the shooter can be dead or out of
      // view, so there would be no body left to measure. A non-finite value
      // stays null, which the client reads as "use the legacy tile lift" --
      // today's appearance, never an invisible or ground-level shot.
      originLift: Number.isFinite(originLift) ? originLift : null,
      // SOMET-473: who this shot may not hit, snapshotted at launch for the
      // same reason `damage` is -- the charm can lapse mid-flight, and a shot
      // loosed while pacified must not become lethal to the charmer because it
      // took 300ms to arrive. null for every shot in the game today.
      pacifiedFrom,
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
      // SOMET-343: the augment stone's bonus packet, snapshotted at launch for
      // the same reason `damage` and `stoneItemId` above are -- a shot already
      // in flight must not change because the player unsocketed mid-flight.
      // null for every unaugmented weapon and every creature ability.
      augment: weapon.augment || null,
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
  _detonate(p, bx, by, { creatureList, creatures, players, map, now }, kills, stoneHits, blocks) {
    const r = p.aoeRadius;
    for (const c of creatureList) {
      const hits = projectileHitsCreature(p, c);
      // SOMET-286: a guard runs the SAME falloff-radius and line-of-sight
      // tests a damageable target does, so the block cue appears exactly where
      // the blast would have hurt it -- one geometry, two outcomes. A guard
      // outside the radius, or behind a wall from the blast point, produces
      // nothing, same as it takes nothing.
      if (!hits && !projectileBlockedBy(p, c)) continue;
      const half = c.width / 2;
      const cx = c.x + half, cy = c.y + c.height / 2;
      const d = Math.hypot(cx - bx, cy - by);
      if (d >= r) continue;
      if (!hasLineOfSight(map, bx, by, cx, cy)) continue;
      if (!hits) {
        // Facing the blast, the way the shove already radiates from it.
        const len = d || 1;
        recordBlock(p, c, cx, cy, (bx - cx) / len, (by - cy) / len, blocks);
        continue;
      }
      // SOMET-343: the augment bonus lands FIRST and takes the SAME falloff --
      // a bonus that ignored distance would make an augmented blast hit harder
      // at the rim than the weapon it is attached to. If it kills, this blast
      // owns that kill and the weapon packet below finds nothing.
      const fall = 1 - d / r;
      if (applyCreatureAugment(p, creatures, c, fall, now)) {
        kills.push({ id: c.id, killerUserId: killerUserIdFor(p) });
        if (p.stoneItemId != null) stoneHits.push({ stoneItemId: p.stoneItemId });
        continue;
      }
      // Falloff scales the RAW damage; the creature's own defense and
      // resistances are applied on top, inside damageCreatureById.
      if (creatures.damageCreatureById(c.id, p.damage * fall, p.element, now, provokerKeyFor(p))) {
        kills.push({ id: c.id, killerUserId: killerUserIdFor(p) });
      } else if (p.knockback > 0) {
        // Survivors only -- a creature the line above already deleted must
        // never be shoved. Origin is the blast centre, not the projectile's
        // travel direction: an AoE's shove radiates outward from where it
        // detonated.
        //
        // SOMET-283: shoveCreature, not the raw shoveAwayFrom -- a blast is a
        // creature-targeting displacement like any other, so a guard caught in
        // one is held to its post. Inert for a hostile.
        shoveCreature(map, bx, by, c, p.knockback);
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
      // SOMET-343: same falloff as the weapon packet (see the creature branch).
      applyPlayerAugment(p, pl, 1 - d / r, now);
      applyDamageWithEffects(pl, p.damage * (1 - d / r), p.element, pl.mit || NO_MITIGATION,
        now, provokerKeyFor(p));
      applyElementEffect(pl, p.element, now, p.ownerId);
      // Survivors only -- a player never gets removed from `players` on
      // death (resolveDeaths respawns them separately), so the check here is
      // the same hp > 0 gate creatures.js uses, not a delete-happened check.
      if (pl.hp > 0 && p.knockback > 0) shoveAwayFrom(map, bx, by, pl, p.knockback);
      if (p.stoneItemId != null) stoneHits.push({ stoneItemId: p.stoneItemId });
    }
    // SOMET-326: the blast INHERITS its projectile's launch anchor, so a
    // detonation goes off where the shot was actually flying rather than on
    // the ground under it.
    return { x: bx, y: by, radius: r, element: p.element, o: p.originLift };
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
    // SOMET-286: one entry per (player's shot, guard it passed through) --
    // impact-shaped descriptors the caller pushes onto the same frame stash
    // player-melee blocks use. Accumulated here, next to `kills`, because this
    // is the only place that knows a shot actually reached a guard: the shot
    // is NOT stopped by one (a guard that body-blocked arrows aimed at the
    // hostile behind it would be a new gameplay rule, not a legibility fix),
    // so nothing downstream could reconstruct the moment.
    const blocks = [];
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
          if (p.aoeRadius) detonations.push(this._detonate(p, p.x, p.y, ctx, kills, stoneHits, blocks));
          dead = true; break;
        }

        // Creatures.
        for (const c of creatureList) {
          if (!projectileHitsCreature(p, c)) {
            // SOMET-286: a guard the shot flew THROUGH. Tested with the same
            // swept capture radius a real hit uses, on the same sub-step, so
            // the cue fires exactly when the arrow would have connected --
            // and never for a guard the shot merely passed near.
            if (projectileBlockedBy(p, c)) {
              const bhalf = c.width / 2;
              const brr = p.radius + bhalf;
              const bcx = c.x + bhalf, bcy = c.y + c.height / 2;
              if (dist2(p.x, p.y, bcx, bcy) <= brr * brr) {
                recordBlock(p, c, bcx, bcy, -ux, -uy, blocks);
              }
            }
            continue;
          }
          const key = `c:${c.id}`;
          if (p.hitIds.has(key)) continue;
          const half = c.width / 2;
          const cx = c.x + half, cy = c.y + c.height / 2;
          const rr = p.radius + half;
          if (dist2(p.x, p.y, cx, cy) <= rr * rr) {
            // SOMET-343: only a CONTACT detonator goes off on touching
            // something. A 'max_range' shot flies through, taking the ordinary
            // direct-hit path below, and detonates when its distance runs out
            // (see the p.remaining <= 0 branch). Terrain and range expiry
            // detonate for BOTH modes -- a wall ends the flight, which is the
            // end of its distance either way.
            if (p.aoeRadius && p.detonateAt === 'contact') {
              detonations.push(this._detonate(p, p.x, p.y, ctx, kills, stoneHits, blocks));
              dead = true; break;
            }
            p.hitIds.add(key);
            // SOMET-343: bonus first, at full strength (a direct hit has no
            // falloff). A kill here is this shot's kill; the weapon packet
            // below would find a deleted creature, so we report and stop.
            if (applyCreatureAugment(p, creatures, c, 1, now)) {
              kills.push({ id: c.id, killerUserId: killerUserIdFor(p) });
              if (p.stoneItemId != null) stoneHits.push({ stoneItemId: p.stoneItemId });
              p.pierceLeft -= 1;
              if (p.pierceLeft <= 0) { dead = true; break; }
              continue;
            }
            if (creatures.damageCreatureById(c.id, p.damage, p.element, now, provokerKeyFor(p))) {
              kills.push({ id: c.id, killerUserId: killerUserIdFor(p) });
            } else if (p.knockback > 0) {
              // Survivors only. Origin is the projectile's own current
              // position -- the point of direct contact, not the blast
              // centre (this is the swept/direct-hit path, not an AoE).
              //
              // SOMET-283: leash-aware, same reason as the AoE branch above.
              // No player weapon carries projectile knockback today, but a
              // creature-fired shot does (`shots[].knockback`) and
              // projectileHitsCreature lets a hostile's shot hit a guard.
              shoveCreature(map, p.x, p.y, c, p.knockback);
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
            // SOMET-343: only a CONTACT detonator goes off on touching
            // something. A 'max_range' shot flies through, taking the ordinary
            // direct-hit path below, and detonates when its distance runs out
            // (see the p.remaining <= 0 branch). Terrain and range expiry
            // detonate for BOTH modes -- a wall ends the flight, which is the
            // end of its distance either way.
            if (p.aoeRadius && p.detonateAt === 'contact') {
              detonations.push(this._detonate(p, p.x, p.y, ctx, kills, stoneHits, blocks));
              dead = true; break;
            }
            p.hitIds.add(key);
            // SOMET-343: full-strength bonus on a direct hit, no falloff.
            applyPlayerAugment(p, pl, 1, now);
            applyDamageWithEffects(pl, p.damage, p.element, pl.mit || NO_MITIGATION,
              now, provokerKeyFor(p));
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
          if (p.aoeRadius) detonations.push(this._detonate(p, p.x, p.y, ctx, kills, stoneHits, blocks));
          dead = true; break;
        }
      }

      if (!dead) survivors.push(p);
    }
    this.projectiles = survivors;
    return { kills, detonations, stoneHits, blocks };
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
      // SOMET-326. On every snapshot for exactly the reason `v` above is: a
      // shot that flies into a newly-streamed neighbourhood has no spawn
      // message to have learned its anchor from, and would otherwise draw at
      // the client's legacy fallback height for the rest of its flight.
      o: p.originLift,
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
