const { resolveMove } = require('./collision');
const { CreatureSim } = require('./creatures');
const { normalizeAim, inArc, hasLineOfSight } = require('./weapons');
const { ProjectileSim } = require('./projectiles');
const { applyDamageWithEffects, drainMana, NO_MITIGATION } = require('./damage');
const {
  tickEffects, effectMagnitude, applyElementEffect, canAct, clearInterrupt, activeEffectKeys,
  BURN, CHILL, SHOCK, SHOCK_MANA_DRAIN,
} = require('./effects');
const { activeWeaponType, mitigation, equip: equipItem, unequip: unequipItem } = require('./items');
const { GroundItemSim } = require('./groundItems');

const PLAYER_W = 64;
const PLAYER_H = 64;
const PLAYER_SPEED = 200; // client: this.speed(100) * speedMultiplier(2)
const PLAYER_MAX_HP = 100;
const PLAYER_MAX_MANA = 100;
const PLAYER_MANA_REGEN = 10; // per second
const PLAYER_MAX_STAMINA = 100;
const PLAYER_STAMINA_REGEN = 10; // per second

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function sign(v) { return v > 0.3 ? 1 : v < -0.3 ? -1 : 0; }

// Burn is fire damage, so a fire resistance mitigates the DOT exactly as it
// mitigates the hit that applied it. Routing it through applyDamage (rather
// than subtracting hp directly) keeps damage.js the single mitigation path.
const BURN_ELEMENT = 'fire';

// The ONE per-entity effect step, shared by players AND creatures. Two
// implementations would drift the way melee and ranged line-of-sight drifted
// before MAX_SUB was unified.
//
// `dealBurn(target, magnitude)` is the only thing that differs between the two
// entity kinds, and it returns true when the target died: a player's burn
// damage is applied in place and their death is left to resolveDeaths(), while
// a creature's must go through the creature sim so the creature is removed
// exactly once and its id can be reported to the caller for the death commit
// (loot). Burn must not become a fourth way to die that skips that path.
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
    if (dealBurn(target, ev.magnitude)) died = true;
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

  addPlayer(userId, spawn, inv = { items: [], equipment: {} }, respawn = spawn) {
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
      hp: PLAYER_MAX_HP,
      maxHp: PLAYER_MAX_HP,
      mana: PLAYER_MAX_MANA,
      maxMana: PLAYER_MAX_MANA,
      stamina: PLAYER_MAX_STAMINA,
      maxStamina: PLAYER_MAX_STAMINA,
      inv,
      mit: mitigation(inv, this.weapons),
      spawn: { x: respawn.x, y: respawn.y },
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
    });
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
  // resolves movement. Returns the creature ids killed by a burn tick, in the
  // same shape attack() and tickProjectiles() already use, so the caller can
  // route them through the one creature death commit (loot + delete).
  tick(dt) {
    const dtMs = dt * 1000;
    this.now += dtMs;
    const killedCreatureIds = [];

    // Effects resolve BEFORE movement so a chill applied during this tick
    // slows THIS tick's movement rather than lagging a frame behind.
    for (const p of this.players.values()) {
      // A player killed by burn is deliberately left at hp<=0 for
      // resolveDeaths(), the single player-death path.
      stepEffects(p, dtMs, this.now, (t, m) => {
        applyDamageWithEffects(t, m, BURN_ELEMENT, t.mit || NO_MITIGATION, this.now);
        return false;
      });
    }
    // Snapshot: damageCreatureById deletes from the live map on a kill.
    for (const c of this.creatures.all()) {
      stepEffects(c, dtMs, this.now, (t, m) => {
        if (!this.creatures.damageCreatureById(t.id, m, BURN_ELEMENT, this.now)) return false;
        killedCreatureIds.push(t.id);
        return true;
      });
    }

    for (const p of this.players.values()) {
      if (p._attackCd > 0) p._attackCd = Math.max(0, p._attackCd - dt);
      if (p.mana < p.maxMana) p.mana = Math.min(p.maxMana, p.mana + PLAYER_MANA_REGEN * dt);
      if (p.stamina < p.maxStamina) p.stamina = Math.min(p.maxStamina, p.stamina + PLAYER_STAMINA_REGEN * dt);
      const r = resolveMove(this.map, p, p.input.dx, p.input.dy, dt);
      p.x = r.x;
      p.y = r.y;
      const f = facingFromInput(p.input.dx, p.input.dy);
      if (f) p.facing = f;
      p.ackSeq = p.pendingSeq;
    }
    return { killedCreatureIds };
  }

  // Tick creatures with the live players (aggro/chase/contact damage). Death
  // resolution (respawn) now happens once for all damage sources in
  // resolveDeaths(), not here.
  tickCreatures(dt, activeKeys) {
    // `this.now` is threaded through so contact damage reads the same clock
    // every other damage site does — a shocked player must take +25% from a
    // creature's bite too, not only from weapons.
    const killedCreatureIds = this.creatures.tick(dt, activeKeys, [...this.players.values()], this.now);
    return { killedCreatureIds: killedCreatureIds || [] };
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
  // projectile. Returns killed creature ids for the caller to DELETE.
  attack(userId, ax, ay) {
    const p = this.players.get(userId);
    if (!p || p._attackCd > 0) return { killedCreatureIds: [] };
    // Shock's interrupt. Checked alongside the cooldown and BEFORE any resource
    // is deducted or any cooldown is stamped, matching the existing rule that a
    // refused attack costs nothing: an interrupt that silently ate the mana or
    // started the cooldown would punish the player twice for one hit.
    if (!canAct(p, this.now)) return { killedCreatureIds: [] };
    const w = activeWeaponType(p.inv, this.weapons, this.defaultWeaponId);
    if (!w) return { killedCreatureIds: [] };

    const manaCost = w.mana_cost || 0;
    const staminaCost = w.stamina_cost || 0;
    // Both resources are checked BEFORE either is deducted, and a denied
    // attack does NOT consume the cooldown — matching mana's existing rule,
    // now covering the melee branch too (melee weapons can carry a cost).
    if (p.mana < manaCost || p.stamina < staminaCost) return { killedCreatureIds: [] };

    const { nx, ny } = normalizeAim(ax, ay, p.facing);
    const cx = p.x + p.width / 2, cy = p.y + p.height / 2;

    if (w.kind === 'melee') {
      const f = facingFromInput(sign(nx), sign(ny));
      if (f) p.facing = f;
      if (manaCost) p.mana -= manaCost;
      if (staminaCost) p.stamina -= staminaCost;
      const killed = this.creatures.applyMeleeArc(cx, cy, nx, ny, w.reach, w.arc_width, w.damage, w.element, this.now);
      for (const other of this.players.values()) {
        if (other.userId === userId) continue;
        const ocx = other.x + other.width / 2, ocy = other.y + other.height / 2;
        if (inArc(cx, cy, nx, ny, ocx, ocy, w.reach, w.arc_width)
            && hasLineOfSight(this.map, cx, cy, ocx, ocy)) {
          applyDamageWithEffects(other, w.damage, w.element, other.mit || NO_MITIGATION, this.now);
          applyElementEffect(other, w.element, this.now, userId);
        }
      }
      p._attackCd = w.cooldown;
      return { killedCreatureIds: killed };
    }

    // projectile
    const f = facingFromInput(sign(nx), sign(ny));
    if (f) p.facing = f;
    if (manaCost) p.mana -= manaCost;
    if (staminaCost) p.stamina -= staminaCost;
    this.projectiles.spawn({ ownerId: userId, x: cx, y: cy, nx, ny, weapon: w });
    p._attackCd = w.cooldown;
    return { killedCreatureIds: [] };
  }

  // Returns the whole step result — { killedCreatureIds, detonations } — so
  // AoE blasts reach the broadcast. Returning only the killed ids (as this
  // used to) silently drops every detonation.
  tickProjectiles(dt) {
    return this.projectiles.step(dt, {
      creatures: this.creatures,
      players: [...this.players.values()],
      map: this.map,
      now: this.now,
    });
  }

  // Respawn any player at <=0 hp (single place, after all damage sources).
  resolveDeaths() {
    for (const p of this.players.values()) {
      if (p.hp <= 0) {
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
};
