const { resolveMove } = require('./collision');

const PLAYER_W = 64;
const PLAYER_H = 64;
const PLAYER_SPEED = 200; // client: this.speed(100) * speedMultiplier(2)

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
      const r = resolveMove(this.map, p, p.input.dx, p.input.dy, dt);
      p.x = r.x;
      p.y = r.y;
      const f = facingFromInput(p.input.dx, p.input.dy);
      if (f) p.facing = f;
      p.ackSeq = p.pendingSeq;
    }
  }

  snapshot() {
    return {
      players: [...this.players.values()].map((p) => ({
        id: p.userId, x: p.x, y: p.y, facing: p.facing,
      })),
    };
  }
}

module.exports = { World, PLAYER_W, PLAYER_H, PLAYER_SPEED };
