const { resolveMove } = require('./collision');
const { CreatureSim, CREATURE_SIZE, shoveCreature } = require('./creatures');
const { shoveAwayFrom } = require('./knockback');
const { normalizeAim, inArc, hasLineOfSight } = require('./weapons');
const { resolveEffectName, momentForAttack, blockedImpact } = require('./vfx.js');
const { attackLift, bodyLift } = require('./attackOrigin.js');
const { ProjectileSim } = require('./projectiles');
const { applyDamageWithEffects, drainMana, NO_MITIGATION, playerKey } = require('./damage');
const {
  tickEffects, effectMagnitude, applyElementEffect, applyHitStatuses,
  canAct, clearInterrupt, activeEffectKeys,
  applyCharm, charmerOf,
  BURN, CHILL, SHOCK, SHOCK_MANA_DRAIN,
} = require('./effects');
const { activeWeaponType, mitigation, equip: equipItem, unequip: unequipItem } = require('./items');
const { unequipBlockers } = require('./equipRequirements.js');
const { loadProgression } = require('../services/progressionStore.js');
const { GroundItemSim } = require('./groundItems');
const { derivePlayerStats, DEFAULT_PROGRESSION } = require('../services/playerStats.js');
const { STAMINA_BASE } = require('../services/progressionConstants.js');
const { lifeCostFor, canPayLife } = require('../services/lifeCost.js');

// Bounds concurrent creature-owned projectiles per world. A swarm-density
// world can hold 12-creature packs; twelve Ranged creatures on a 1.8s cooldown
// sustain roughly seven shots per second, and ProjectileSim.step is
// O(projectiles x creatures) per sub-step. Excess shots are DROPPED, not
// queued -- a queued shot arrives after its target has moved and reads worse
// than no shot at all.
const MAX_CREATURE_PROJECTILES = 120;

const PLAYER_W = 64;
const PLAYER_H = 64;
const PLAYER_SPEED = 200; // client: this.speed(100) * speedMultiplier(2)
const PLAYER_MAX_HP = 100;
const PLAYER_MAX_MANA = 100;
const PLAYER_MANA_REGEN = 10; // per second
// An ALIAS for progressionConstants.STAMINA_BASE, not a second copy of 100
// (SOMET-495). derivePlayerStats now computes maxStamina from that constant
// plus the tree's `stamina` grants, and a player joins at `stats.maxStamina`;
// two independent hundreds here would let a tree grant and the join value
// disagree the moment either moved. Still exported under the old name because
// several tests import it.
const PLAYER_MAX_STAMINA = STAMINA_BASE;
const PLAYER_STAMINA_REGEN = 10; // per second

// How fast the charm pushes a pacified player away from their charmer, in world
// px per second. Small on purpose: spec 8.2 calls it a SOFT repel, and this
// runs every tick for four seconds. A quarter of PLAYER_SPEED, so a player
// walking toward the druid still closes -- slowly. It is a nudge, not a leash:
// the player's own input is resolved first and is never overridden.
const CHARM_REPEL_SPEED = 50;

// A level-1 (all-base-stat, NO CLASS) character's derived bundle.
// playerStats.js guarantees this is an identity on the pre-A2 constants above
// -- maxHp 100, maxMana 100, manaRegen 10, x1.0 damage, x1.0 cooldown -- so a
// player who joins with no progression behaves exactly as before A2.
//
// Deliberately class-blind (SOMET-486 passes no classPools here): this is the
// addPlayer default for callers that have no character at all, i.e. tests and
// synthetic players. The real join path always passes a class-derived bundle.
const BASE_STATS = derivePlayerStats(DEFAULT_PROGRESSION);

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function sign(v) { return v > 0.3 ? 1 : v < -0.3 ? -1 : 0; }

// STR scales physical weapons, INT scales every other element. The split is
// the weapon catalog's existing `element` column -- no new field, and it
// gives the element system weight it currently lacks.
//
// Called at all THREE damage sites: melee-vs-creature, melee-vs-player, and
// projectile spawn. The projectile takes its value once, at launch (see
// projectiles.js `spawn`), so a respec mid-flight cannot change a shot
// already in the air.
function weaponDamage(p, w) {
  const mult = (w.element && w.element !== 'physical') ? p.stats.spellMult : p.stats.meleeMult;
  return w.damage * mult * elementDamageMult(p.stats, w.element);
}

// SOMET-495. The passive tree's `damage` grants, as a PER-ELEMENT multiplier.
//
// "+35% fire damage" is a percentage, not a flat number, and composeStats has
// already summed every grant on an element and turned the total into one
// multiplier (x1.40 for +35 and +5) -- so grants stack ADDITIVELY with each
// other and MULTIPLICATIVELY against the weapon, which is what the labels
// promise. Doing the sum here instead would make two grants x1.4175.
//
// A weapon with a null element is physical, matching applyDamage's own default
// -- the two must agree, or a bare weapon would be boosted as one element and
// mitigated as another.
//
// The fallback is 1, never undefined: `w.damage * undefined` is NaN, and NaN
// damage never satisfies hp <= 0, i.e. an unkillable target. Every real bundle
// carries all five keys (playerStats.js's NO_DAMAGE_MULT covers the rest).
function elementDamageMult(stats, element) {
  const table = stats && stats.damageMult;
  const v = table ? table[element || 'physical'] : undefined;
  return Number.isFinite(v) ? v : 1;
}

// The ONLY place the weapon's cooldown field is read. Both attack branches
// (melee and projectile) call this; a test asserts the source contains
// exactly one reference to that field so a third site cannot silently
// reappear.
function applyAttackCooldown(p, w) {
  p._attackCd = w.cooldown * p.stats.cooldownMult;
}

// THE ONE ATTACK RESOURCE GATE (SOMET-472; spec 8.3: "the check lives in the
// same place the mana check does today, so there is one cost gate, not two").
//
// Both canAttack -- the pre-check server.js runs BEFORE it spends ammo -- and
// attack itself call this. Two hand-written copies of the rule is exactly how a
// class could end up unable to fire but still losing an arrow.
//
// Returns null when the attack is affordable, or the name of the resource that
// refused it. A refusal costs NOTHING: no resource is touched, no cooldown is
// stamped. That has always been mana's rule here and it now covers life too.
function resourceRefusal(p, w) {
  if (p.stamina < (w.stamina_cost || 0)) return 'stamina';
  const manaCost = w.mana_cost || 0;
  if (manaCost <= 0) return null;
  if (p.usesLifeCost) {
    // p.stats is the bundle derivePlayerStats produced, and it carries the
    // passive tree's lifeCostMultiplier (playerStats.js). Reading it off
    // `stats` rather than off the player is what makes an allocated Blood
    // Pact take effect the instant applyDerivedStats runs.
    return canPayLife(p.hp, lifeCostFor(manaCost, p.stats.lifeCostMultiplier)) ? null : 'life';
  }
  return p.mana < manaCost ? 'mana' : null;
}

// The matching spend. Called ONLY after resourceRefusal returned null, and
// deliberately adjacent to it: a spend that could pick a different pool from
// the check is a way to cast for free.
function spendResources(p, w) {
  const staminaCost = w.stamina_cost || 0;
  if (staminaCost) p.stamina -= staminaCost;
  const manaCost = w.mana_cost || 0;
  if (!manaCost) return;
  if (p.usesLifeCost) p.hp -= lifeCostFor(manaCost, p.stats.lifeCostMultiplier);
  else p.mana -= manaCost;
}

// Burn is fire damage, so a fire resistance mitigates the DOT exactly as it
// mitigates the hit that applied it. Routing it through applyDamage (rather
// than subtracting hp directly) keeps damage.js the single mitigation path.
const BURN_ELEMENT = 'fire';

// The ONE per-entity effect step, shared by players AND creatures. Two
// implementations would drift the way melee and ranged line-of-sight drifted
// before MAX_SUB was unified.
//
// `dealBurn(target, magnitude, sourceId)` is the only thing that differs
// between the two entity kinds, and it returns true when the target died: a
// player's burn damage is applied in place and their death is left to
// resolveDeaths(), while a creature's must go through the creature sim so the
// creature is removed exactly once and its id (plus the effect's sourceId,
// i.e. whoever applied the burn) can be reported to the caller for the death
// commit (loot, and — Task 6 — XP). Burn must not become a fourth way to die
// that skips that path. `sourceId` is threaded straight from the effect
// entry's own `sourceId` (see effects.js's applyEffect/tickEffects) — it is
// NOT the currently-attacking player, which may have walked away or changed
// entirely since the burn was applied.
function stepEffects(target, dtMs, now, dealBurn) {
  let died = false;
  for (const ev of tickEffects(target, dtMs, now)) {
    if (ev.key === SHOCK) {
      // Shock's mana drain. Uses the module constant rather than ev.magnitude
      // because the shock entry's magnitude is already spoken for by the
      // damage-vulnerability fraction — see effects.js's note on the split.
      //
      // Deliberately unconditional across BOTH entity kinds: drainMana no-ops
      // on a target with no mana pool, which is every creature. Guarding here
      // instead would put the "creatures have no mana" rule in two places.
      drainMana(target, SHOCK_MANA_DRAIN);
      continue;
    }
    if (ev.key !== BURN) continue;
    if (dealBurn(target, ev.magnitude, ev.sourceId)) died = true;
  }
  // Chill RECOMPUTES the effective speed from a stored base every tick. It
  // must never multiply on apply and divide on expire: that accumulates float
  // drift and leaves an entity permanently a fraction slower after enough
  // apply/expire cycles. Recomputing also makes a refresh idempotent for free.
  //
  // The base is captured lazily so this one function serves both entity kinds
  // without either constructor having to opt in (and therefore without either
  // being able to forget).
  if (target.baseSpeed === undefined) target.baseSpeed = target.speed;
  const chill = effectMagnitude(target, CHILL, now);
  target.speed = chill ? target.baseSpeed * chill : target.baseSpeed;
  return died;
}

// 8-way facing string from an input vector; null when idle (keep last facing).
function facingFromInput(dx, dy) {
  if (dx === 0 && dy === 0) return null;
  const v = dy < 0 ? 'n' : dy > 0 ? 's' : '';
  const h = dx < 0 ? 'w' : dx > 0 ? 'e' : '';
  return (v + h) || null;
}

class World {
  constructor(map, weaponsById = new Map(), defaultWeaponId = null, chunkSize = 64) {
    this.map = map;
    this.players = new Map(); // userId -> state
    this.creatures = new CreatureSim(map);
    this.weapons = weaponsById;
    this.defaultWeaponId = defaultWeaponId;
    this.projectiles = new ProjectileSim();
    this.groundItems = new GroundItemSim(chunkSize);
    // Monotonic world clock in ms, advanced only by tick(). effects.js is pure
    // and never reads a clock itself, so this is the single source of `now`
    // for every effect apply/expiry in the world.
    this.now = 0;
  }

  // `stats` defaults to BASE_STATS (the level-1 identity bundle) so every
  // existing caller -- tests included -- that doesn't pass one keeps
  // behaving exactly as before A2. p.stats is NEVER optional past this
  // point: every read site can assume it exists rather than falling back to
  // a module constant, which is precisely how a missed call site would stay
  // green.
  // characterId is what every DATABASE write for this player is keyed by
  // (SOMET-257 re-keyed inventory, equipment, progression and position off
  // user_id). The in-memory map stays keyed by userId -- one live session per
  // account -- so both ids live on the player object and are not
  // interchangeable: userId owns gold, characterId owns everything else.
  // `bind` (SOMET-294) is the player_binds row this character actually holds --
  // { worldId, x, y } -- or null for a character that has never entered a
  // village. It is NOT the same fact as `respawn`/`p.spawn`: p.spawn is where
  // resolveDeaths() snaps them WITHIN THIS WORLD and is always a point in this
  // world, while p.bind may name a different one. When they agree, the two are
  // the same coordinates and nothing downstream can tell them apart; when they
  // disagree, server.js's onPlayerDeath is what notices and relocates. Defaulted
  // to null so every existing caller -- and every test that builds a player --
  // keeps behaving exactly as before.
  //
  // `classPools` (SOMET-486) is `{ maxHp, maxMana }` -- this character's
  // CLASS base pools, carried on the player so every later re-derive
  // (level-up, chest XP, socket, respec) starts from the same base the join
  // did. Without it those paths would recompute pools class-blind and quietly
  // snap a Ranger back to 100/100 on its first level-up: the same shape of
  // defect as the buff-stone overwrite SOMET-245 Task 6 fixed. Defaults to
  // null so a test that builds a player unchanged still gets HP_BASE/
  // MANA_BASE via derivePlayerStats' own fallback.
  //
  // `usesLifeCost` (SOMET-472) is the Cultist's resource substitution: every
  // item_types.mana_cost is paid in HP instead. Resolved ONCE at join from the
  // character's class name (server.js) and read ONLY by resourceRefusal /
  // spendResources above, so no other site in the sim branches on class.
  // Defaults false, so every existing caller -- and every test that builds a
  // player -- behaves exactly as before. HOW MUCH it costs is not here: that
  // is stats.lifeCostMultiplier, which the tree owns and applyDerivedStats
  // refreshes.
  addPlayer(userId, spawn, inv = { items: [], equipment: {} }, respawn = spawn, gold = 0, stats = BASE_STATS, characterId = null, bind = null, classPools = null, usesLifeCost = false) {
    this.players.set(userId, {
      userId,
      characterId,
      x: spawn.x,
      y: spawn.y,
      width: PLAYER_W,
      height: PLAYER_H,
      speed: PLAYER_SPEED,
      // Chill scales `speed` down from this base and back up to it; `speed` is
      // derived state from here on, recomputed every tick in stepEffects.
      baseSpeed: PLAYER_SPEED,
      effects: new Map(),
      facing: 's',
      input: { dx: 0, dy: 0 },
      pendingSeq: 0,
      ackSeq: 0,
      hp: stats.maxHp,
      maxHp: stats.maxHp,
      mana: stats.maxMana,
      maxMana: stats.maxMana,
      // SOMET-495: from the derived bundle, like hp and mana, so a tree
      // `+30 stamina` node is live at join rather than only after the next
      // re-derive. `?? PLAYER_MAX_STAMINA` covers a hand-built stats object in
      // a test that predates the field.
      stamina: stats.maxStamina ?? PLAYER_MAX_STAMINA,
      maxStamina: stats.maxStamina ?? PLAYER_MAX_STAMINA,
      inv,
      // SOMET-495: armour resistances AND the tree's, merged on one scale by
      // mitigation() itself. Rebuilt by _rebuildMit at every point either half
      // can change -- equip, unequip, and any re-derive of `stats`.
      mit: mitigation(inv, this.weapons, stats.resists),
      spawn: { x: respawn.x, y: respawn.y },
      // Read only by server.js (the tick loop refreshes it on village entry,
      // onPlayerDeath compares its worldId against the world the death happened
      // in). Nothing on the synchronous death path in this file consults it --
      // resolveDeaths() still knows only about p.spawn.
      bind,
      gold: Number(gold) || 0,
      _attackCd: 0,
      // The creature this player's summons follow them onto (spec 8.2).
      // Written only by attack(), read only by CreatureSim's charmed branch.
      _charmTargetId: null,
      _doorwayCdUntil: 0,
      autoLoot: false,
      // Recently-dropped GROUND ITEM ids -> grace expiry (ms, same clock as
      // the `now` passed to dropItem/dropGraceActive). Lets the auto-loot
      // scan skip an item this player JUST dropped (dropItem spawns it at
      // their exact centre, i.e. distance 0 from the pickup-radius scan) so
      // it isn't instantly re-vacuumed. Manual pickup ignores this entirely.
      // See loot.js `dropGraceActive`.
      dropGrace: new Map(),
      // The derived stat bundle this player is currently living with. Read at
      // every damage, cooldown and regen site -- see weaponDamage,
      // applyAttackCooldown and tick()'s mana-regen line.
      stats,
      // The class base pools `stats` was derived FROM. Read only by
      // server.js's liveStats() when it re-derives; nothing in this file
      // consults it, because every pool number this file needs is already
      // baked into `stats`.
      classPools,
      // Strict boolean: a truthy string off the join path must not silently
      // enrol a Warrior in life casting.
      usesLifeCost: usesLifeCost === true,
    });
  }

  // Applies a NEW derived bundle to a live player. Deliberately distinct from
  // addPlayer, which joins at full: here the current pools move by the DELTA.
  //
  // AC6 -- level-up must not heal to full. Raising max hp by D raises current
  // hp by D. Healing to max would make levelling mid-fight a free full heal,
  // and the optimal play would become hoarding a nearly-dead creature for
  // emergencies.
  applyDerivedStats(userId, stats) {
    const p = this.players.get(userId);
    if (!p) return { hpDelta: 0, manaDelta: 0 };
    const hpDelta = stats.maxHp - p.maxHp;
    const manaDelta = stats.maxMana - p.maxMana;
    // SOMET-495: stamina moves by the same DELTA rule as hp and mana, so
    // allocating a stamina node mid-fight is a bonus, not a refill. Guarded
    // with ?? for the same reason addPlayer is -- a hand-built bundle with no
    // maxStamina must leave the pool alone rather than NaN it.
    const staminaDelta = (stats.maxStamina ?? p.maxStamina) - p.maxStamina;
    p.maxHp = stats.maxHp;
    p.maxMana = stats.maxMana;
    p.maxStamina = stats.maxStamina ?? p.maxStamina;
    // Lower bound 1, not 0: a respec that shrinks CON must not kill the
    // player it is being applied to.
    p.hp = clamp(p.hp + hpDelta, 1, p.maxHp);
    p.mana = clamp(p.mana + manaDelta, 0, p.maxMana);
    p.stamina = clamp(p.stamina + staminaDelta, 0, p.maxStamina);
    p.stats = stats;
    // SOMET-495. THE line that makes a `resist` grant live. Without it an
    // allocated +8 fire resist would sit in `stats` and never reach `p.mit`
    // until the player happened to re-equip something -- displayed on the
    // sheet, inert in play, which is the exact failure this ticket exists to
    // end. Every re-derive path (join, level-up, chest XP, socket, allocate,
    // respec) funnels through here, so this one call covers all of them.
    this._rebuildMit(p);
    return { hpDelta, manaDelta };
  }

  // p.mit = equipped armour + the tree's resist aggregate, on the ONE scale
  // mitigation() owns. Called wherever either half can change; a site that
  // rebuilt only from the inventory would silently drop the tree half.
  _rebuildMit(p) {
    p.mit = mitigation(p.inv, this.weapons, p.stats && p.stats.resists);
  }

  removePlayer(userId) { this.players.delete(userId); }
  getPlayer(userId) { return this.players.get(userId); }
  isEmpty() { return this.players.size === 0; }

  setInput(userId, seq, dx, dy) {
    const p = this.players.get(userId);
    if (!p) return;
    p.input = { dx: clamp(dx, -1, 1), dy: clamp(dy, -1, 1) };
    p.pendingSeq = seq;
  }

  // Strict boolean: a truthy string from the wire must not enable auto-loot.
  setAutoLoot(userId, on) {
    const p = this.players.get(userId);
    if (!p) return;
    p.autoLoot = on === true;
  }

  // Advances the world clock, ticks status effects for every entity, then
  // resolves movement. Returns the creatures killed by a burn tick, in the
  // same { kills } shape attack() and tickProjectiles() already use, so the
  // caller can route them through the one creature death commit (loot + XP).
  tick(dt) {
    const dtMs = dt * 1000;
    this.now += dtMs;
    const kills = [];

    // Effects resolve BEFORE movement so a chill applied during this tick
    // slows THIS tick's movement rather than lagging a frame behind.
    for (const p of this.players.values()) {
      // A player killed by burn is deliberately left at hp<=0 for
      // resolveDeaths(), the single player-death path. Player deaths never
      // feed `kills` — that array is creature deaths only.
      stepEffects(p, dtMs, this.now, (t, m, sourceId) => {
        // SOMET-290: a burn is still someone's damage. The rider carries the
        // applier's userId for kill attribution already, so naming it here
        // costs nothing and keeps every damage site attributed rather than
        // leaving one that stamps "hit by nobody".
        applyDamageWithEffects(t, m, BURN_ELEMENT, t.mit || NO_MITIGATION, this.now, playerKey(sourceId));
        return false;
      });
    }
    // Snapshot: damageCreatureById deletes from the live map on a kill.
    for (const c of this.creatures.all()) {
      stepEffects(c, dtMs, this.now, (t, m, sourceId) => {
        // SOMET-290: `playerKey(sourceId)` is the provoker, the same actor the
        // kill below is credited to.
        //
        // `playerKey` unconditionally, and that is correct BY CONTRACT rather
        // than by luck: a rider's sourceId is a userId or null, never a
        // creature id — projectiles.js applies every rider with
        // killerUserIdFor(p), which erases a creature shooter to null before it
        // reaches the effect. So a creature-owned burn arrives here as null and
        // provokes nobody (isProvokedBy: an unattributed record matches no
        // actor), which is the intended reading — a creature that set you on
        // fire is not a player you can retaliate against.
        //
        // If a future rider path ever DID carry a creature id, this would build
        // `p:<uuid>` — a tag that matches no actor either, so the failure mode
        // is the same "provokes nobody", not a bystander being blamed. The fix
        // then is at the rider's source (tag it with creatureKey), not here.
        if (!this.creatures.damageCreatureById(t.id, m, BURN_ELEMENT, this.now, playerKey(sourceId))) return false;
        // Normalized at construction: an effect applied with no sourceId
        // (there is none today, but a future riderless path could) must
        // report `null`, never `undefined`, so no consumer needs `?? null`.
        kills.push({ id: t.id, killerUserId: sourceId ?? null });
        return true;
      });
    }

    for (const p of this.players.values()) {
      if (p._attackCd > 0) p._attackCd = Math.max(0, p._attackCd - dt);
      if (p.mana < p.maxMana) p.mana = Math.min(p.maxMana, p.mana + p.stats.manaRegen * dt);
      if (p.stamina < p.maxStamina) p.stamina = Math.min(p.maxStamina, p.stamina + PLAYER_STAMINA_REGEN * dt);
      const r = resolveMove(this.map, p, p.input.dx, p.input.dy, dt);
      p.x = r.x;
      p.y = r.y;
      const f = facingFromInput(p.input.dx, p.input.dy);
      if (f) p.facing = f;
      p.ackSeq = p.pendingSeq;
    }

    // The charm's soft repel (spec 8.2). Applied AFTER each player's own
    // movement step, deliberately: this NUDGES, it does not steer. The target's
    // input has already moved them exactly as it always did, which is what
    // "keeps their own movement input -- no control transfer" means, and is the
    // whole difference between the player pacify and the creature charm.
    //
    // shoveAwayFrom is the same wall-aware primitive knockback and the portal
    // bounce use, so a repel can never push anyone into terrain.
    for (const p of this.players.values()) {
      const charmerId = charmerOf(p, this.now);
      if (charmerId == null) continue;
      const src = this.players.get(charmerId);
      // The charmer left the world (or was never in it). The pacify itself
      // stays -- it is a timed effect, not a tether -- but there is nothing to
      // be repelled from.
      if (!src || src === p) continue;
      shoveAwayFrom(this.map, src.x + src.width / 2, src.y + src.height / 2, p,
        CHARM_REPEL_SPEED * dt);
    }
    return { kills };
  }

  // Tick creatures with the live players (aggro/chase/contact damage). Death
  // resolution (respawn) now happens once for all damage sources in
  // resolveDeaths(), not here.
  tickCreatures(dt, activeKeys) {
    // `this.now` is threaded through so contact damage reads the same clock
    // every other damage site does — a shocked player must take +25% from a
    // creature's bite too, not only from weapons.
    //
    // SOMET-254: CreatureSim.tick always ends `return { killed, shots };` --
    // no early return, nothing else in its body returns -- so the `|| {
    // killed: [], shots: [] }` fallback here could never fire. Removed.
    const {
      killed: killedIds, killCredits, shots,
      attacks: creatureAttacks, impacts: creatureImpacts,
    } = this.creatures.tick(dt, activeKeys, [...this.players.values()], this.now);

    for (const s of shots) {
      if (this.projectiles.countByOwnerKind('creature') >= MAX_CREATURE_PROJECTILES) break;
      this.projectiles.spawn({
        ownerId: s.ownerId,
        ownerKind: 'creature',
        ownerFaction: s.ownerFaction,
        x: s.x, y: s.y, nx: s.nx, ny: s.ny,
        damage: s.damage,
        originLift: s.originLift,
        // ProjectileSim reads its flight parameters off a weapon-shaped
        // object; a creature's profile supplies the same four fields.
        weapon: {
          projectile_speed: s.speed,
          projectile_radius: s.radius,
          range: s.range,
          pierce: 1,
          aoe_radius: 0,
          element: s.element,
          damage: s.damage,
          // SOMET-253 Task 6: the ability's own knockback rides along on the
          // weapon-shaped object ProjectileSim.spawn reads, same as every
          // other flight parameter here.
          knockback: s.knockback,
        },
      });
    }

    // A guard's kill has no player behind it — always null, never omitted.
    // SOMET-473: a Druid's PET is the one creature-owned kill that does have a
    // player behind it, and CreatureSim reports that in `killCredits`. Read
    // through `?? null` so every other path is byte-identical to before and a
    // sim double that predates the field still works.
    // Slice D: creature attacks ride the SAME frame keys player swings do, so
    // server.js pushes them through the same two helpers and the client draws
    // them through the same path. Defaulted to [] because several tests build
    // a CreatureSim-shaped double that predates these fields.
    return {
      kills: killedIds.map((id) => ({ id, killerUserId: (killCredits && killCredits.get(id)) ?? null })),
      attacks: creatureAttacks || [],
      impacts: creatureImpacts || [],
    };
  }

  activeWeapon(userId) {
    const p = this.players.get(userId);
    if (!p) return null;
    return activeWeaponType(p.inv, this.weapons, this.defaultWeaponId);
  }

  // SOMET-478 (T10). The requirement context is read from the DATABASE here,
  // once per equip action, rather than cached on the player object.
  //
  // Two reasons. (1) The spec's own risk table says requirements are validated
  // on equip only, never per attack -- so one read on a player-initiated
  // action is affordable, and the combat hot path is untouched. (2) A cached
  // copy would have to be invalidated by every level-up, respec, passive
  // allocation and buff-stone socket; the second one of those anybody forgets
  // is a player wearing gear they no longer qualify for, silently.
  //
  // A player with no characterId is not a real session (addPlayer's default,
  // used by pure fixtures -- server.js always passes character.id). It gets
  // the level-1 base-stat context rather than a skipped gate: falling back to
  // "no requirements" would make the gate inert for exactly the callers least
  // likely to be noticed.
  async _requirementContext(pool, characterId) {
    if (characterId == null) {
      return { level: DEFAULT_PROGRESSION.level, base: { ...DEFAULT_PROGRESSION } };
    }
    const progression = await loadProgression(pool, characterId);
    return {
      level: progression.level,
      base: {
        strength: progression.strength,
        dexterity: progression.dexterity,
        constitution: progression.constitution,
        intelligence: progression.intelligence,
        wisdom: progression.wisdom,
        charisma: progression.charisma,
      },
    };
  }

  async setEquipment(pool, userId, itemId, slot) {
    const p = this.players.get(userId);
    if (!p) return { ok: false, reason: 'no player' };
    const req = await this._requirementContext(pool, p.characterId);
    const r = await equipItem(pool, p.characterId, p.inv, this.weapons, itemId, slot, req);
    if (r.ok) this._rebuildMit(p);
    return r;
  }

  async clearEquipment(pool, userId, slot) {
    const p = this.players.get(userId);
    if (!p) return { ok: false, reason: 'no player' };
    // Refused BEFORE unequipItem's in-memory mutation, so the SOMET-77
    // ordering inside it is never entered on a refusal and there is nothing to
    // roll back. Naming B is the whole point: "unequip it first" with no
    // subject is unactionable when eight slots could be the cause.
    const req = await this._requirementContext(pool, p.characterId);
    const blockers = unequipBlockers(p.inv, this.weapons, req.base, req.level, slot);
    if (blockers.length > 0) {
      const names = blockers.map((b) => b.name).join(', ');
      return { ok: false, reason: `${names} would no longer meet its requirements` };
    }
    const r = await unequipItem(pool, p.characterId, p.inv, slot);
    if (r.ok) this._rebuildMit(p);
    return r;
  }

  // The pure, side-effect-free half of `attack`'s gating: cooldown, mana and
  // stamina. Exposed so a caller can check BEFORE spending something
  // irreversible (ammo), since an attack refused for cooldown must not have
  // already destroyed an arrow. `attack` keeps performing these same checks
  // itself — this is additive, and attack() stays correct called directly.
  // SOMET-494 added `reason`. A caller that only asks "may this fire?" reads
  // `ok` exactly as before; the reason exists because holding the mouse to
  // attack has to tell two refusals apart that used to look identical from
  // outside: `cooldown` is the normal rhythm of holding and the hold must
  // continue through it, while `resource` means the player has run out and the
  // hold must stop.
  //
  // `resource` covers mana, life AND stamina as ONE value on purpose. SOMET-472
  // AC2 requires a Cultist's life refusal to be indistinguishable from a mana
  // refusal ("or a client would have to learn a second shape"), and that
  // invariant is pinned by a test that deep-equals the two answers. Splitting
  // them here to make a prettier message would quietly break it, and nothing
  // downstream needs the distinction: every resource refusal stops the hold.
  canAttack(userId) {
    const p = this.players.get(userId);
    if (!p) return { ok: false, weapon: null, reason: 'unknown' };
    if (p._attackCd > 0) return { ok: false, weapon: null, reason: 'cooldown' };
    // Interrupted: refused BEFORE the weapon is even resolved, so the caller
    // never spends ammo on a swing the interrupt is about to eat.
    if (!canAct(p, this.now)) return { ok: false, weapon: null, reason: 'interrupted' };
    const w = activeWeaponType(p.inv, this.weapons, this.defaultWeaponId);
    if (!w) return { ok: false, weapon: null, reason: 'unarmed' };
    if (resourceRefusal(p, w)) return { ok: false, weapon: w, reason: 'resource' };
    return { ok: true, weapon: w, reason: null };
  }

  // Attack in the aim direction with the equipped weapon. Melee resolves an arc
  // hit against creatures + other players; projectile spawns a mana-gated
  // projectile. Returns the killed creatures (id + killer) for the caller to
  // DELETE and credit.
  attack(userId, ax, ay) {
    const p = this.players.get(userId);
    if (!p || p._attackCd > 0) return { kills: [], attacks: [], impacts: [], stoneHit: null };
    // Shock's interrupt. Checked alongside the cooldown and BEFORE any resource
    // is deducted or any cooldown is stamped, matching the existing rule that a
    // refused attack costs nothing: an interrupt that silently ate the mana or
    // started the cooldown would punish the player twice for one hit.
    if (!canAct(p, this.now)) return { kills: [], attacks: [], impacts: [], stoneHit: null };
    const w = activeWeaponType(p.inv, this.weapons, this.defaultWeaponId);
    if (!w) return { kills: [], attacks: [], impacts: [], stoneHit: null };

    // Both resources are checked BEFORE either is deducted, and a denied
    // attack does NOT consume the cooldown — matching mana's existing rule,
    // now covering the melee branch too (melee weapons can carry a cost).
    // resourceRefusal is the same call canAttack makes, so the pre-check that
    // guards ammo and the real check cannot disagree.
    if (resourceRefusal(p, w)) return { kills: [], attacks: [], impacts: [], stoneHit: null };

    const { nx, ny } = normalizeAim(ax, ay, p.facing);
    const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
    // SOMET-326: how far up THIS attacker's body this weapon launches from,
    // in screen pixels, resolved here and carried on the wire so the client
    // never needs the weapon catalog. Computed from the attacker's own height
    // rather than a tile constant -- that substitution is the whole fix.
    // Render-only: nothing below reads it for reach, arc or line-of-sight.
    const originLift = attackLift(w, p.height);
    // The charm pacify (spec 8.2). Resolved ONCE per attack, exactly like
    // originLift above, so the melee arc, the player sweep and the spawned
    // projectile all consult one value rather than three copies of the lookup.
    // null for everyone who is not currently charmed, i.e. every attack in the
    // game today.
    const pacifiedFrom = charmerOf(p, this.now);

    // SOMET-495: this attacker's tree-granted on-hit riders ("your hits burn"),
    // resolved ONCE for the whole attack and threaded to every site the swing
    // or the shot can land — exactly like `pacifiedFrom` above, and for the
    // same reason: a shot snapshots what was true when it was fired.
    const hitStatuses = p.stats.hitStatuses || null;
    // SOMET-495: an augment stone's bonus is damage in the augment's OWN
    // element, so the tree's multiplier for THAT element applies to it. Scaled
    // once, here, rather than at each of the three sites that consume the
    // packet — the melee arc, the melee-vs-player branch and the projectile
    // snapshot — because three copies of the same multiply is how one of them
    // ends up missing it.
    const augment = w.augment
      ? {
        ...w.augment,
        bonusDamage: w.augment.bonusDamage * elementDamageMult(p.stats, w.augment.element),
      }
      : null;

    if (w.kind === 'melee') {
      const f = facingFromInput(sign(nx), sign(ny));
      if (f) p.facing = f;
      spendResources(p, w);
      // Queried BEFORE applyMeleeArc, which deletes whatever it kills: after
      // the fact a one-shot kill would look like a miss.
      // SOMET-286: one scan, two lists -- what the swing may damage, and what
      // it physically reached but a rule refused (guards). `blocked` feeds the
      // client's block cue ONLY; it deliberately touches neither the damage,
      // the riders, the knockback nor `hit`, so the immunity itself is exactly
      // as it was.
      const {
        hit: creatureTargets, blocked: blockedTargets,
      } = this.creatures.meleeArcScan(cx, cy, nx, ny, w.reach, w.arc_width, pacifiedFrom);
      // Slice C (SOMET-160): where each impact happened. Captured HERE, before
      // applyMeleeArc, for exactly the reason creatureTargets is -- a
      // one-shot kill removes the creature, and reading its position
      // afterwards would give nothing for precisely the hits that matter
      // most. The list is built from the targets already computed; this
      // exposes a fact, it does not recompute one.
      const impactAt = [];
      for (const id of creatureTargets) {
        const c = this.creatures.get(id);
        // SOMET-326: an impact is a point ON A TARGET, so its anchor is the
        // TARGET's mid-body -- deliberately not the attacker's weapon origin.
        // Where a blow lands is a fact about who was hit, not about what swung:
        // a head-origin thrown dart still connects with a creature's middle.
        // This is also the case the old tile constant got most visibly wrong --
        // 32px on a 48px creature is 67% of its height, i.e. a hit spark
        // floating at its neck.
        if (c) {
          impactAt.push({
            t: `c:${id}`, x: c.x + CREATURE_SIZE / 2, y: c.y + CREATURE_SIZE / 2,
            o: bodyLift(CREATURE_SIZE, 'middle'),
          });
        }
      }
      // SOMET-286: the refusal cue, one per guard the swing actually reached.
      // Positioned on the GUARD, not the attacker, which is what separates it
      // on screen from the weapon's `miss` flourish (drawn at the attacker's
      // own centre, below) -- a swing at empty ground can never produce one of
      // these, and that is precisely the distinction the player was missing.
      // The aim vector rides along so the glint can face the attacker.
      const blockedAt = [];
      for (const id of blockedTargets) {
        const c = this.creatures.get(id);
        if (c) {
          blockedAt.push(blockedImpact(
            id, c.x + CREATURE_SIZE / 2, c.y + CREATURE_SIZE / 2, -nx, -ny,
            bodyLift(CREATURE_SIZE, 'middle'),
          ));
        }
      }
      const killed = this.creatures.applyMeleeArc(
        cx, cy, nx, ny, w.reach, w.arc_width, weaponDamage(p, w), w.element, this.now, userId,
        // SOMET-332: the augment stone's bonus packet, or null. Passed rather
        // than folded into weaponDamage above so the bonus is mitigated by the
        // AUGMENT's element, not the weapon's.
        augment,
        pacifiedFrom,
        // SOMET-495: the tree's on-hit riders, applied to every creature the
        // arc reaches, beside the element's own rider.
        hitStatuses,
      );
      // What this player's summons will attack (spec 8.2: "attacks the druid's
      // target"). The FIRST creature this swing reached, kept even if the swing
      // killed it -- CreatureSim re-validates it every tick and drops a dead
      // one, so a stale id costs one tick of nothing rather than needing a
      // second write site here.
      if (creatureTargets.length > 0) p._charmTargetId = creatureTargets[0];
      // SOMET-253 Task 9: survivors = targets minus killed. `creatureTargets`
      // was captured BEFORE applyMeleeArc ran, and applyMeleeArc deletes
      // whatever it kills -- iterating creatureTargets directly here would
      // try to shove ids no longer in the sim. Same distinction Task 6's
      // guard/hostile melee branches already draw (creatures.js: tgt.hp<=0
      // check before shoveAwayFrom), just computed as a set difference
      // instead of a single target's hp check.
      if (w.knockback > 0 && creatureTargets.length > 0) {
        const killedSet = new Set(killed);
        for (const id of creatureTargets) {
          if (killedSet.has(id)) continue;
          const c = this.creatures.get(id);
          if (!c) continue;
          // SOMET-283: shoveCreature, not the raw shoveAwayFrom -- this is the
          // site that punted both of Vale Crossing's guards off their posts.
          // A guard never targets a player and so never fights back, and
          // MIN_DAMAGE caps a starter weapon at 1 damage against its defense,
          // so this loop was a free 30px-per-swing conveyor with no leash and
          // no faction filter. A hostile is still shoved exactly as before.
          shoveCreature(this.map, cx, cy, c, w.knockback);
          c.dirty = true;
        }
      }
      let playerHits = 0;
      for (const other of this.players.values()) {
        if (other.userId === userId) continue;
        // Pacified: this swing cannot reach the player who charmed them.
        // `continue`, not a zero-damage hit, so the impact list, the knockback
        // and the client's hit cue all fall away together -- a swing that
        // sparks off a target it did no damage to reads as a bug.
        if (pacifiedFrom != null && other.userId === pacifiedFrom) continue;
        const ocx = other.x + other.width / 2, ocy = other.y + other.height / 2;
        if (inArc(cx, cy, nx, ny, ocx, ocy, w.reach, w.arc_width)
            && hasLineOfSight(this.map, cx, cy, ocx, ocy)) {
          applyDamageWithEffects(other, weaponDamage(p, w), w.element, other.mit || NO_MITIGATION,
            this.now, playerKey(userId));
          applyElementEffect(other, w.element, this.now, userId);
          // SOMET-495: the tree's riders, applied ONCE per target per swing --
          // deliberately here, next to the weapon's own element rider, and NOT
          // repeated inside the augment branch below. Two stamps on the same
          // target in the same swing are indistinguishable from one (refresh
          // semantics, and the shock window swallows the second), so a second
          // call would be noise that reads like a second effect.
          applyHitStatuses(other, hitStatuses, this.now, userId);
          // SOMET-332: the augment's bonus as a SECOND packet, mirroring the
          // creature path in applyMeleeArc. A player and a creature must take
          // the same swing identically -- an augment that only worked against
          // creatures would be a PvP balance bug nothing else would catch.
          if (augment && augment.bonusDamage > 0) {
            applyDamageWithEffects(other, augment.bonusDamage, augment.element,
              other.mit || NO_MITIGATION, this.now, playerKey(userId));
            applyElementEffect(other, augment.element, this.now, userId);
          }
          playerHits++;
          // Same list as the creature impacts above -- a player hit and a
          // creature hit are one event kind, distinguished only by the id
          // prefix, so the client draws them through one path.
          // Same target-anchored rule as the creature impacts above, read off
          // this player's own box rather than a shared constant.
          impactAt.push({ t: `p:${other.userId}`, x: ocx, y: ocy, o: bodyLift(other.height, 'middle') });
          // Survivors only -- a player at <=0 hp is picked up by
          // resolveDeaths() and respawned elsewhere; shoving first would move
          // a position respawn is about to overwrite anyway. Written straight
          // onto other.x/other.y via shoveAwayFrom, the same
          // server-authoritative assignment the portal bounce and Task 6's
          // creature-side knockback already use -- never resolveMove.
          if (other.hp > 0 && w.knockback > 0) {
            shoveAwayFrom(this.map, cx, cy, other, w.knockback);
          }
        }
      }
      applyAttackCooldown(p, w);
      const landed = creatureTargets.length > 0 || playerHits > 0;
      // Magic Stones (SOMET-245) Task 7: a socketed SPELL stone gains XP the
      // instant its swing actually connects with something -- landed is the
      // exact same fact the descriptor's own `hit` field below already
      // computes, just also gating the award. `w.stoneItemId` is set only
      // when activeWeaponType (items.js) actually merged a spell stone's
      // fields onto this weapon (never for a bare weapon, never for a buff
      // stone, whose element is null and never reaches that merge branch) --
      // see items.js's activeWeaponType for where this field comes from.
      // One award per landed swing, not one per target it happened to hit:
      // the brief calls this "on a landed spell-stone hit," and a swing is
      // the unit of "a hit" from the player's perspective (matches the
      // descriptor's own single boolean `hit`, not a per-target count).
      const stoneHit = (w.stoneItemId != null && landed) ? { stoneItemId: w.stoneItemId } : null;
      // The descriptor exposes facts this method already computed — the aim
      // vector, the attacker's centre, the catalog's reach/arc. Nothing here
      // is derived, and the effect NAME is resolved on this side so the
      // client never needs the weapon catalog to draw the swing.
      return {
        // The attacker credited for every kill this swing made — attack()
        // is the one channel where the killer is simply the method's own
        // argument, no effect-sourceId or projectile-ownerId lookup needed.
        kills: killed.map((id) => ({ id, killerUserId: userId })),
        attacks: [{
          a: `p:${userId}`,
          // Slice B: the moment depends on whether the swing connected. The
          // server already knows (`landed`), so it resolves one name and the
          // client never decides -- a whiff plays the weapon's `miss` effect
          // instead of its `attack` one, which is what stops an empty swing
          // reading as a dropped input.
          v: resolveEffectName(w, momentForAttack(landed)),
          x: cx, y: cy,
          nx, ny,
          // SOMET-326: the vertical render anchor, in screen pixels up from
          // this attacker's feet. See attackOrigin.js for why a resolved
          // number travels rather than the authored origin NAME.
          o: originLift,
          reach: w.reach, arc: w.arc_width,
          hit: landed,
        }],
        // Slice C: exactly the targets this swing damaged, each with the
        // resolved impact effect and the weapon's element for tinting. An
        // empty swing carries an EMPTY list, and server.js omits the key from
        // the frame entirely -- the same treatment detonations already get,
        // so a quiet tick costs no bytes.
        // SOMET-286: blocks are appended to the SAME list rather than given
        // their own frame key -- see vfx.js's blockedImpact. They carry no
        // `v`/`el`: the client draws them from a built-in def, so a missing or
        // renamed vfx_effects row cannot silently take the cue away again.
        impacts: [
          ...impactAt.map((i) => ({
            ...i,
            v: resolveEffectName(w, 'impact'),
            el: w.element || null,
          })),
          ...blockedAt,
        ],
        stoneHit,
      };
    }

    // projectile
    const f = facingFromInput(sign(nx), sign(ny));
    if (f) p.facing = f;
    spendResources(p, w);
    this.projectiles.spawn({
      ownerId: userId, x: cx, y: cy, nx, ny,
      // SOMET-495: the weapon with its augment packet already scaled by the
      // tree's per-element multiplier (see `augment` above). Spread rather than
      // mutated -- `w` is the shared in-memory catalog row, and writing to it
      // would leak one player's tree onto every other player's weapon.
      weapon: augment === null ? w : { ...w, augment },
      damage: weaponDamage(p, w),
      // SOMET-495: the tree's on-hit riders, snapshotted at LAUNCH for the same
      // reason `damage` and `pacifiedFrom` are -- a respec mid-flight must not
      // change a shot already in the air.
      hitStatuses,
      // Snapshotted at launch for the same reason `damage` is, and for one
      // more: the shooter can be dead or out of view before this lands, so
      // there would be no body left to measure against later.
      originLift,
      // SOMET-343: the ammunition this shot consumed. server.js has already
      // spent it by the time attack() runs; this is the catalog row, so an
      // explosive arrow can make an ordinary bow detonate. null when the
      // weapon needs no ammo (staves, darts) or the row is missing from the
      // in-memory catalog.
      ammo: w.ammo_type_id != null ? (this.weapons.get(w.ammo_type_id) || null) : null,
      // The pacify travels WITH the shot rather than being re-read on impact:
      // the charm can lapse mid-flight, and an arrow loosed while pacified must
      // not become lethal to the charmer because it took 300ms to arrive.
      pacifiedFrom,
    });
    applyAttackCooldown(p, w);
    // Projectiles already render as a moving dot; their trail effects are
    // slice D, so slice A emits no descriptor for them. A projectile never
    // kills on the SAME tick it is fired — any kill it eventually scores is
    // reported later, by tickProjectiles, credited to `p.ownerId` (this
    // userId) rather than whoever is attacking when it lands. Stone XP for a
    // spawned spell projectile follows the identical rule: `stoneHit` here
    // is always null (nothing has landed yet) -- if `w.stoneItemId` is set,
    // ProjectileSim.spawn (below) reads it straight off `w` and carries it
    // on the projectile so tickProjectiles' own step() can award XP at the
    // actual moment of impact, not at the moment of firing.
    return { kills: [], attacks: [], impacts: [], stoneHit: null };
  }

  // Returns the whole step result — { kills, detonations, stoneHits, blocks }
  // — so AoE blasts (and SOMET-286's guard block cues) reach the broadcast.
  // Returning only the kills (as this used to for ids)
  // would silently drop every detonation. ProjectileSim.step() already
  // builds `kills` as { id, killerUserId } objects, crediting each one to
  // the projectile's OWN `ownerId` (captured at spawn, in `world.js`'s
  // `attack()`) — never to whichever player happens to be attacking when the
  // shot lands.
  tickProjectiles(dt) {
    return this.projectiles.step(dt, {
      creatures: this.creatures,
      players: [...this.players.values()],
      map: this.map,
      now: this.now,
    });
  }

  // Respawn any player at <=0 hp (single place, after all damage sources).
  // Returns the userIds resolved THIS call, so a caller with pool access
  // (server.js) can apply the death XP penalty without this method itself
  // becoming async — it runs on the synchronous tick path and must not await
  // anything. Because every id returned here is healed to full hp in the
  // SAME pass, a player can never appear in this list on two consecutive
  // calls for the same death: the next call sees p.hp > 0 and skips them.
  // That is also the only thing guarding against a double-fire — see
  // server.js's onPlayerDeath comment for why that guarantee is sufficient.
  resolveDeaths() {
    const died = [];
    for (const p of this.players.values()) {
      if (p.hp <= 0) {
        died.push(p.userId);
        // WHERE THE DEATH HAPPENED, kept because the snap on the next line
        // destroys it (SOMET-443). server.js's onPlayerDeath needs it to pick
        // the nearest village, and "nearest" has to be measured from the place
        // that killed them -- measuring from p.spawn, which they are about to
        // be moved to, would pick the village nearest their JOIN point and
        // quietly answer a different question.
        p.deathAt = { x: p.x, y: p.y };
        p.x = p.spawn.x; p.y = p.spawn.y;
        // Every resource is restored together. Leaving stamina out would
        // respawn a player fully healed but unable to swing a heavy weapon.
        p.hp = p.maxHp; p.mana = p.maxMana; p.stamina = p.maxStamina;
        // Control is a resource too: a player must not get up still staggered.
        // clearInterrupt deliberately leaves the immunity window intact — see
        // effects.js — so dying cannot be used to shed it.
        clearInterrupt(p);
        p.effects.clear();
      }
    }
    return died;
  }

  snapshot() {
    return {
      players: [...this.players.values()].map((p) => {
        const out = {
          id: p.userId, x: p.x, y: p.y, facing: p.facing,
          hp: p.hp, maxHp: p.maxHp, mana: p.mana, maxMana: p.maxMana,
          stamina: p.stamina, maxStamina: p.maxStamina, equipment: p.inv ? p.inv.equipment : {},
          autoLoot: p.autoLoot,
        };
        // Effect KEYS only, and omitted entirely when nothing is active — see
        // activeEffectKeys. Read on the client as `p.effects || []`.
        const fx = activeEffectKeys(p, this.now);
        if (fx) out.effects = fx;
        return out;
      }),
      projectiles: this.projectiles.snapshot(),
    };
  }
}

module.exports = {
  World, PLAYER_W, PLAYER_H, PLAYER_SPEED,
  PLAYER_MAX_HP,
  PLAYER_MAX_MANA, PLAYER_MANA_REGEN,
  PLAYER_MAX_STAMINA, PLAYER_STAMINA_REGEN,
  weaponDamage, applyAttackCooldown, BASE_STATS,
  MAX_CREATURE_PROJECTILES,
};
