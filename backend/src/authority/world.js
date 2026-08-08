const { resolveMove } = require('./collision');
const { CreatureSim } = require('./creatures');
const { shoveAwayFrom } = require('./knockback');
const { normalizeAim, inArc, hasLineOfSight } = require('./weapons');
const { resolveEffectName } = require('./vfx.js');
const { ProjectileSim } = require('./projectiles');
const { applyDamageWithEffects, drainMana, NO_MITIGATION } = require('./damage');
const {
  tickEffects, effectMagnitude, applyElementEffect, canAct, clearInterrupt, activeEffectKeys,
  BURN, CHILL, SHOCK, SHOCK_MANA_DRAIN,
} = require('./effects');
const { activeWeaponType, mitigation, equip: equipItem, unequip: unequipItem } = require('./items');
const { GroundItemSim } = require('./groundItems');
const { derivePlayerStats, DEFAULT_PROGRESSION } = require('../services/playerStats.js');

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
const PLAYER_MAX_STAMINA = 100;
const PLAYER_STAMINA_REGEN = 10; // per second

// A level-1 (all-base-stat) character's derived bundle. playerStats.js
// guarantees this is an identity on the pre-A2 constants above -- maxHp 100,
// maxMana 100, manaRegen 10, x1.0 damage, x1.0 cooldown -- so a player who
// joins with no progression behaves exactly as before A2.
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
  return w.damage * mult;
}

// The ONLY place the weapon's cooldown field is read. Both attack branches
// (melee and projectile) call this; a test asserts the source contains
// exactly one reference to that field so a third site cannot silently
// reappear.
function applyAttackCooldown(p, w) {
  p._attackCd = w.cooldown * p.stats.cooldownMult;
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
  addPlayer(userId, spawn, inv = { items: [], equipment: {} }, respawn = spawn, gold = 0, stats = BASE_STATS) {
    this.players.set(userId, {
      userId,
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
      stamina: PLAYER_MAX_STAMINA,
      maxStamina: PLAYER_MAX_STAMINA,
      inv,
      mit: mitigation(inv, this.weapons),
      spawn: { x: respawn.x, y: respawn.y },
      gold: Number(gold) || 0,
      _attackCd: 0,
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
    p.maxHp = stats.maxHp;
    p.maxMana = stats.maxMana;
    // Lower bound 1, not 0: a respec that shrinks CON must not kill the
    // player it is being applied to.
    p.hp = clamp(p.hp + hpDelta, 1, p.maxHp);
    p.mana = clamp(p.mana + manaDelta, 0, p.maxMana);
    p.stats = stats;
    return { hpDelta, manaDelta };
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
      stepEffects(p, dtMs, this.now, (t, m) => {
        applyDamageWithEffects(t, m, BURN_ELEMENT, t.mit || NO_MITIGATION, this.now);
        return false;
      });
    }
    // Snapshot: damageCreatureById deletes from the live map on a kill.
    for (const c of this.creatures.all()) {
      stepEffects(c, dtMs, this.now, (t, m, sourceId) => {
        if (!this.creatures.damageCreatureById(t.id, m, BURN_ELEMENT, this.now)) return false;
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
    const { killed: killedIds, shots } = this.creatures.tick(
      dt, activeKeys, [...this.players.values()], this.now);

    for (const s of shots) {
      if (this.projectiles.countByOwnerKind('creature') >= MAX_CREATURE_PROJECTILES) break;
      this.projectiles.spawn({
        ownerId: s.ownerId,
        ownerKind: 'creature',
        ownerFaction: s.ownerFaction,
        x: s.x, y: s.y, nx: s.nx, ny: s.ny,
        damage: s.damage,
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
    return { kills: killedIds.map((id) => ({ id, killerUserId: null })) };
  }

  activeWeapon(userId) {
    const p = this.players.get(userId);
    if (!p) return null;
    return activeWeaponType(p.inv, this.weapons, this.defaultWeaponId);
  }

  async setEquipment(pool, userId, itemId, slot) {
    const p = this.players.get(userId);
    if (!p) return { ok: false, reason: 'no player' };
    const r = await equipItem(pool, userId, p.inv, this.weapons, itemId, slot);
    if (r.ok) p.mit = mitigation(p.inv, this.weapons);
    return r;
  }

  async clearEquipment(pool, userId, slot) {
    const p = this.players.get(userId);
    if (!p) return { ok: false, reason: 'no player' };
    const r = await unequipItem(pool, userId, p.inv, slot);
    if (r.ok) p.mit = mitigation(p.inv, this.weapons);
    return r;
  }

  // The pure, side-effect-free half of `attack`'s gating: cooldown, mana and
  // stamina. Exposed so a caller can check BEFORE spending something
  // irreversible (ammo), since an attack refused for cooldown must not have
  // already destroyed an arrow. `attack` keeps performing these same checks
  // itself — this is additive, and attack() stays correct called directly.
  canAttack(userId) {
    const p = this.players.get(userId);
    if (!p || p._attackCd > 0) return { ok: false, weapon: null };
    // Interrupted: refused BEFORE the weapon is even resolved, so the caller
    // never spends ammo on a swing the interrupt is about to eat.
    if (!canAct(p, this.now)) return { ok: false, weapon: null };
    const w = activeWeaponType(p.inv, this.weapons, this.defaultWeaponId);
    if (!w) return { ok: false, weapon: null };
    if (p.mana < (w.mana_cost || 0) || p.stamina < (w.stamina_cost || 0)) {
      return { ok: false, weapon: w };
    }
    return { ok: true, weapon: w };
  }

  // Attack in the aim direction with the equipped weapon. Melee resolves an arc
  // hit against creatures + other players; projectile spawns a mana-gated
  // projectile. Returns the killed creatures (id + killer) for the caller to
  // DELETE and credit.
  attack(userId, ax, ay) {
    const p = this.players.get(userId);
    if (!p || p._attackCd > 0) return { kills: [], attacks: [] };
    // Shock's interrupt. Checked alongside the cooldown and BEFORE any resource
    // is deducted or any cooldown is stamped, matching the existing rule that a
    // refused attack costs nothing: an interrupt that silently ate the mana or
    // started the cooldown would punish the player twice for one hit.
    if (!canAct(p, this.now)) return { kills: [], attacks: [] };
    const w = activeWeaponType(p.inv, this.weapons, this.defaultWeaponId);
    if (!w) return { kills: [], attacks: [] };

    const manaCost = w.mana_cost || 0;
    const staminaCost = w.stamina_cost || 0;
    // Both resources are checked BEFORE either is deducted, and a denied
    // attack does NOT consume the cooldown — matching mana's existing rule,
    // now covering the melee branch too (melee weapons can carry a cost).
    if (p.mana < manaCost || p.stamina < staminaCost) return { kills: [], attacks: [] };

    const { nx, ny } = normalizeAim(ax, ay, p.facing);
    const cx = p.x + p.width / 2, cy = p.y + p.height / 2;

    if (w.kind === 'melee') {
      const f = facingFromInput(sign(nx), sign(ny));
      if (f) p.facing = f;
      if (manaCost) p.mana -= manaCost;
      if (staminaCost) p.stamina -= staminaCost;
      // Queried BEFORE applyMeleeArc, which deletes whatever it kills: after
      // the fact a one-shot kill would look like a miss.
      const creatureTargets = this.creatures.meleeArcTargets(cx, cy, nx, ny, w.reach, w.arc_width);
      const killed = this.creatures.applyMeleeArc(
        cx, cy, nx, ny, w.reach, w.arc_width, weaponDamage(p, w), w.element, this.now, userId,
      );
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
          shoveAwayFrom(this.map, cx, cy, c, w.knockback);
          c.dirty = true;
        }
      }
      let playerHits = 0;
      for (const other of this.players.values()) {
        if (other.userId === userId) continue;
        const ocx = other.x + other.width / 2, ocy = other.y + other.height / 2;
        if (inArc(cx, cy, nx, ny, ocx, ocy, w.reach, w.arc_width)
            && hasLineOfSight(this.map, cx, cy, ocx, ocy)) {
          applyDamageWithEffects(other, weaponDamage(p, w), w.element, other.mit || NO_MITIGATION, this.now);
          applyElementEffect(other, w.element, this.now, userId);
          playerHits++;
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
          v: resolveEffectName(w, 'attack'),
          x: cx, y: cy,
          nx, ny,
          reach: w.reach, arc: w.arc_width,
          hit: creatureTargets.length > 0 || playerHits > 0,
        }],
      };
    }

    // projectile
    const f = facingFromInput(sign(nx), sign(ny));
    if (f) p.facing = f;
    if (manaCost) p.mana -= manaCost;
    if (staminaCost) p.stamina -= staminaCost;
    this.projectiles.spawn({
      ownerId: userId, x: cx, y: cy, nx, ny, weapon: w, damage: weaponDamage(p, w),
    });
    applyAttackCooldown(p, w);
    // Projectiles already render as a moving dot; their trail effects are
    // slice D, so slice A emits no descriptor for them. A projectile never
    // kills on the SAME tick it is fired — any kill it eventually scores is
    // reported later, by tickProjectiles, credited to `p.ownerId` (this
    // userId) rather than whoever is attacking when it lands.
    return { kills: [], attacks: [] };
  }

  // Returns the whole step result — { kills, detonations } — so AoE blasts
  // reach the broadcast. Returning only the kills (as this used to for ids)
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
