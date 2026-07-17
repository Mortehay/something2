const { resolveMove } = require('./collision');
const { CreatureSim } = require('./creatures');

const PLAYER_W = 64;
const PLAYER_H = 64;
const PLAYER_SPEED = 200; // client: this.speed(100) * speedMultiplier(2)
const PLAYER_MAX_HP = 100;
const MELEE_RANGE = 90;            // px
const PLAYER_DAMAGE = 10;
const PLAYER_ATTACK_COOLDOWN = 0.5; // s

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// 8-way facing string from an input vector; null when idle (keep last facing).
function facingFromInput(dx, dy) {
  if (dx === 0 && dy === 0) return null;
  const v = dy < 0 ? 'n' : dy > 0 ? 's' : '';
  const h = dx < 0 ? 'w' : dx > 0 ? 'e' : '';
  return (v + h) || null;
}

class World {
  constructor(map) {
    this.map = map;
    this.players = new Map(); // userId -> state
    this.creatures = new CreatureSim(map);
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
      const r = resolveMove(this.map, p, p.input.dx, p.input.dy, dt);
      p.x = r.x;
      p.y = r.y;
      const f = facingFromInput(p.input.dx, p.input.dy);
      if (f) p.facing = f;
      p.ackSeq = p.pendingSeq;
    }
  }

  // Tick creatures with the live players (aggro/chase/contact damage), then
  // respawn any player killed this tick.
  tickCreatures(dt, activeKeys) {
    const players = [...this.players.values()];
    this.creatures.tick(dt, activeKeys, players);
    for (const p of players) {
      if (p.hp <= 0) { p.x = p.spawn.x; p.y = p.spawn.y; p.hp = p.maxHp; }
    }
  }

  // Player melee attack (cooldown-gated). Returns killed creature ids.
  attack(userId) {
    const p = this.players.get(userId);
    if (!p || p._attackCd > 0) return [];
    p._attackCd = PLAYER_ATTACK_COOLDOWN;
    const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
    return this.creatures.applyAttack(cx, cy, MELEE_RANGE, PLAYER_DAMAGE);
  }

  snapshot() {
    return {
      players: [...this.players.values()].map((p) => ({
        id: p.userId, x: p.x, y: p.y, facing: p.facing, hp: p.hp, maxHp: p.maxHp,
      })),
    };
  }
}

module.exports = {
  World, PLAYER_W, PLAYER_H, PLAYER_SPEED,
  PLAYER_MAX_HP, MELEE_RANGE, PLAYER_DAMAGE, PLAYER_ATTACK_COOLDOWN,
};
