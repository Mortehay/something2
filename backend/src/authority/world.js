const { resolveMove } = require('./collision');
const { CreatureSim } = require('./creatures');
const { normalizeAim, inArc } = require('./weapons');
const { ProjectileSim } = require('./projectiles');

const PLAYER_W = 64;
const PLAYER_H = 64;
const PLAYER_SPEED = 200; // client: this.speed(100) * speedMultiplier(2)
const PLAYER_MAX_HP = 100;
const MELEE_RANGE = 90;            // px
const PLAYER_DAMAGE = 10;
const PLAYER_ATTACK_COOLDOWN = 0.5; // s
const PLAYER_MAX_MANA = 100;
const PLAYER_MANA_REGEN = 10; // per second

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function sign(v) { return v > 0.3 ? 1 : v < -0.3 ? -1 : 0; }

// 8-way facing string from an input vector; null when idle (keep last facing).
function facingFromInput(dx, dy) {
  if (dx === 0 && dy === 0) return null;
  const v = dy < 0 ? 'n' : dy > 0 ? 's' : '';
  const h = dx < 0 ? 'w' : dx > 0 ? 'e' : '';
  return (v + h) || null;
}

class World {
  constructor(map, weaponsById = new Map(), defaultWeaponId = null) {
    this.map = map;
    this.players = new Map(); // userId -> state
    this.creatures = new CreatureSim(map);
    this.weapons = weaponsById;
    this.defaultWeaponId = defaultWeaponId;
    this.projectiles = new ProjectileSim();
  }

  addPlayer(userId, spawn) {
    this.players.set(userId, {
      userId,
      x: spawn.x,
      y: spawn.y,
      width: PLAYER_W,
      height: PLAYER_H,
      speed: PLAYER_SPEED,
      facing: 's',
      input: { dx: 0, dy: 0 },
      pendingSeq: 0,
      ackSeq: 0,
      hp: PLAYER_MAX_HP,
      maxHp: PLAYER_MAX_HP,
      mana: PLAYER_MAX_MANA,
      maxMana: PLAYER_MAX_MANA,
      weaponId: this.defaultWeaponId,
      spawn: { x: spawn.x, y: spawn.y },
      _attackCd: 0,
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

  tick(dt) {
    for (const p of this.players.values()) {
      if (p._attackCd > 0) p._attackCd = Math.max(0, p._attackCd - dt);
      if (p.mana < p.maxMana) p.mana = Math.min(p.maxMana, p.mana + PLAYER_MANA_REGEN * dt);
      const r = resolveMove(this.map, p, p.input.dx, p.input.dy, dt);
      p.x = r.x;
      p.y = r.y;
      const f = facingFromInput(p.input.dx, p.input.dy);
      if (f) p.facing = f;
      p.ackSeq = p.pendingSeq;
    }
  }

  // Tick creatures with the live players (aggro/chase/contact damage). Death
  // resolution (respawn) now happens once for all damage sources in
  // resolveDeaths(), not here.
  tickCreatures(dt, activeKeys) {
    this.creatures.tick(dt, activeKeys, [...this.players.values()]);
  }

  setWeapon(userId, weaponId) {
    const p = this.players.get(userId);
    if (p && this.weapons.has(weaponId)) p.weaponId = weaponId;
  }

  // Attack in the aim direction with the equipped weapon. Melee resolves an arc
  // hit against creatures + other players; projectile spawns a mana-gated
  // projectile. Returns killed creature ids for the caller to DELETE.
  attack(userId, ax, ay) {
    const p = this.players.get(userId);
    if (!p || p._attackCd > 0) return { killedCreatureIds: [] };
    const w = this.weapons.get(p.weaponId) || this.weapons.get(this.defaultWeaponId);
    if (!w) return { killedCreatureIds: [] };

    const { nx, ny } = normalizeAim(ax, ay, p.facing);
    const f = facingFromInput(sign(nx), sign(ny));
    if (f) p.facing = f;
    const cx = p.x + p.width / 2, cy = p.y + p.height / 2;

    if (w.kind === 'melee') {
      const killed = this.creatures.applyMeleeArc(cx, cy, nx, ny, w.reach, w.arc_width, w.damage);
      for (const other of this.players.values()) {
        if (other.userId === userId) continue;
        const ocx = other.x + other.width / 2, ocy = other.y + other.height / 2;
        if (inArc(cx, cy, nx, ny, ocx, ocy, w.reach, w.arc_width)) other.hp -= w.damage;
      }
      p._attackCd = w.cooldown;
      return { killedCreatureIds: killed };
    }

    // projectile
    if (p.mana < w.mana_cost) return { killedCreatureIds: [] }; // denied, no cooldown
    p.mana -= w.mana_cost;
    this.projectiles.spawn({ ownerId: userId, x: cx, y: cy, nx, ny, weapon: w });
    p._attackCd = w.cooldown;
    return { killedCreatureIds: [] };
  }

  tickProjectiles(dt) {
    return this.projectiles.step(dt, {
      creatures: this.creatures,
      players: [...this.players.values()],
      map: this.map,
    }).killedCreatureIds;
  }

  // Respawn any player at <=0 hp (single place, after all damage sources).
  resolveDeaths() {
    for (const p of this.players.values()) {
      if (p.hp <= 0) {
        p.x = p.spawn.x; p.y = p.spawn.y;
        p.hp = p.maxHp; p.mana = p.maxMana;
      }
    }
  }

  snapshot() {
    return {
      players: [...this.players.values()].map((p) => ({
        id: p.userId, x: p.x, y: p.y, facing: p.facing,
        hp: p.hp, maxHp: p.maxHp, mana: p.mana, maxMana: p.maxMana, weaponId: p.weaponId,
      })),
      projectiles: this.projectiles.snapshot(),
    };
  }
}

module.exports = {
  World, PLAYER_W, PLAYER_H, PLAYER_SPEED,
  PLAYER_MAX_HP, MELEE_RANGE, PLAYER_DAMAGE, PLAYER_ATTACK_COOLDOWN,
  PLAYER_MAX_MANA, PLAYER_MANA_REGEN,
};
