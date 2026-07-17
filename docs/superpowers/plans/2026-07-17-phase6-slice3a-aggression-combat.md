# Phase 6 Slice 3a — Aggression + Contact Combat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Creatures chase nearby players and deal contact damage; players have hp and die/respawn; players melee-attack (spacebar) to kill creatures — all server-authoritative.

**Architecture:** Extend the Slice-1/2 authority. `CreatureSim` gains AI (acquire/leash/chase) + contact damage (players threaded into its tick) + `applyAttack` (player melee). `World` gains player hp + spawn + `tickCreatures` (mediates players↔creatures, resolves deaths) + `attack(userId)`. `server.js` reorders the tick to run creatures before the `state` broadcast and handles a new `attack` message (deleting killed creatures). The client sends `attack`, renders hp bars, and respawns via the existing position reconciliation.

**Tech Stack:** Node/CommonJS backend (ws, pg), `node --test`. Frontend ESM (Vite/React), `vitest run`.

## Global Constraints

- Server owns all combat: aggro/leash/contact/melee ranges, cooldowns, damage, death, respawn. Client sends movement input + `attack` intent only; never positions or hp.
- Reuse `resolveMove`/`ServerMap` for chase movement — no new collision math. Reuse the Slice-2 creature lifecycle (activation/AOI/flush/prune); dead creatures are removed (not respawned).
- Tuning constants are single-sourced (exported from `creatures.js` / `world.js`) and shared with tests: `AGGRO_RADIUS=400`, `LEASH_RADIUS=800`, `CONTACT_RANGE=60`, `CREATURE_DAMAGE=5`, `CREATURE_ATTACK_COOLDOWN=1.0` (creatures.js); `PLAYER_MAX_HP=100`, `MELEE_RANGE=90`, `PLAYER_DAMAGE=10`, `PLAYER_ATTACK_COOLDOWN=0.5` (world.js). Creature max hp = its spawned/loaded `hp`.
- All distances are **center-to-center** (`x + width/2`, `y + height/2`).
- The 20 Hz `state` / ~5 Hz `creatures` cadences are unchanged; payloads gain hp fields; new inbound `attack` message.
- Player movement/prediction/reconciliation (Slice 1) unchanged except additive hp fields + respawn-via-position-snap. Roam behavior (Slice 2) unchanged when no player is in aggro range.

---

### Task 1: `CreatureSim` — aggression, chase, contact damage, melee

**Files:**
- Modify: `backend/src/authority/creatures.js`
- Test: `backend/tests/authority_creatures_combat.test.js`

**Interfaces:**
- Consumes: `resolveMove` (`./collision`), `chunkOf`/`CHUNK_KEY` (`./coords`).
- Produces (changed/new on `CreatureSim`):
  - `addCreatures(list)` — each creature also gets `maxHp` (= `hp`), `_target=null`, `mode='roam'`, `_attackCd=0`.
  - `tick(dt, activeChunkKeys, players = [])` — `players` = array of live `{ userId, x, y, width, height, hp }` (player state refs; may be mutated). Active creatures: decrement `_attackCd`; acquire nearest player ≤ `AGGRO_RADIUS` / drop target > `LEASH_RADIUS`; **chase** toward target (via `resolveMove`) + contact-damage the target when within `CONTACT_RANGE` and `_attackCd<=0`; else **roam** (existing).
  - `applyAttack(px, py, range, damage) -> string[]` — reduce hp of creatures within `range` of `(px,py)`; remove + return ids whose `hp<=0`.
  - `snapshotForNeighborhood(keys)` — entries gain `maxHp` and `mode`.
  - New exported constants: `AGGRO_RADIUS`, `LEASH_RADIUS`, `CONTACT_RANGE`, `CREATURE_DAMAGE`, `CREATURE_ATTACK_COOLDOWN`.

- [ ] **Step 1: Write the failing test**

`backend/tests/authority_creatures_combat.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const {
  CreatureSim, AGGRO_RADIUS, LEASH_RADIUS, CONTACT_RANGE,
  CREATURE_DAMAGE, CREATURE_ATTACK_COOLDOWN,
} = require('../src/authority/creatures.js');

function stubMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }
const rng = () => 0.5; // no redirect, deterministic roam dir
function player(userId, x, y) { return { userId, x, y, width: 64, height: 64, hp: 100, maxHp: 100 }; }
function creatureAt(id, x, y, hp = 10) { return { id, type: 'Wolf', x, y, hp, facing: 'S', color: '#c00' }; }

test('a creature acquires and chases the nearest in-aggro player', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100)]);
  const p = player('u1', 100 + AGGRO_RADIUS - 50, 100); // east, within aggro
  s.tick(0.2, new Set(['0,0']), [p]);
  const c = s.all()[0];
  assert.equal(c.mode, 'chase');
  assert.equal(c._target, 'u1');
  assert.ok(c.x > 100, 'moved east toward the player');
});

test('a creature drops its target beyond the leash radius (back to roam)', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100)]);
  const p = player('u1', 200, 100);
  s.tick(0.1, new Set(['0,0']), [p]); // acquire
  assert.equal(s.all()[0].mode, 'chase');
  p.x = 100 + LEASH_RADIUS + 100; // run far away
  s.tick(0.1, new Set(['0,0']), [p]);
  assert.equal(s.all()[0].mode, 'roam');
  assert.equal(s.all()[0]._target, null);
});

test('a chasing creature deals contact damage on cooldown', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100)]);
  // Player centered within CONTACT_RANGE of the creature center.
  const p = player('u1', 110, 100);
  s.tick(0.05, new Set(['0,0']), [p]); // acquire + first hit
  assert.equal(p.hp, 100 - CREATURE_DAMAGE, 'took one hit');
  s.tick(0.05, new Set(['0,0']), [p]); // still on cooldown → no hit
  assert.equal(p.hp, 100 - CREATURE_DAMAGE);
  // Advance past the cooldown.
  s.tick(CREATURE_ATTACK_COOLDOWN, new Set(['0,0']), [p]);
  assert.equal(p.hp, 100 - 2 * CREATURE_DAMAGE, 'hit again after cooldown');
});

test('no player in aggro → creature roams (unchanged), no damage', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100)]);
  const far = player('u1', 100 + AGGRO_RADIUS + 500, 100);
  const before = { ...s.all()[0] };
  s.tick(0.1, new Set(['0,0']), [far]);
  assert.equal(s.all()[0].mode, 'roam');
  assert.equal(far.hp, 100);
  // still moved (roam), i.e. it ticked
  assert.ok(s.all()[0].x !== before.x || s.all()[0].y !== before.y);
});

test('applyAttack damages in-range creatures and removes the dead, returning their ids', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('near', 100, 100, 8), creatureAt('far', 100000, 100000, 8)]);
  const killed = s.applyAttack(120, 120, 90, 10); // near center ~ (124,124), within 90
  assert.deepEqual(killed, ['near']);
  assert.ok(!s.has('near'));
  assert.ok(s.has('far'));
});

test('applyAttack only wounds (not kills) a creature with more hp', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100, 30)]);
  const killed = s.applyAttack(124, 124, 90, 10);
  assert.deepEqual(killed, []);
  assert.equal(s.all()[0].hp, 20);
});

test('snapshotForNeighborhood includes maxHp and mode', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100, 10)]);
  const snap = s.snapshotForNeighborhood(new Set(['0,0']));
  assert.equal(snap[0].maxHp, 10);
  assert.equal(snap[0].mode, 'roam');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/authority_creatures_combat.test.js`
Expected: FAIL — new constants undefined / `tick` ignores players / `applyAttack` undefined.

- [ ] **Step 3: Implement the AI + combat in `creatures.js`**

Add the combat constants near the existing ones:
```js
const AGGRO_RADIUS = 400;            // px: acquire nearest player within this
const LEASH_RADIUS = 800;            // px: drop a target beyond this
const CONTACT_RANGE = 60;            // px: creature may hit its target within this
const CREATURE_DAMAGE = 5;
const CREATURE_ATTACK_COOLDOWN = 1.0; // s
```
Add helpers (module scope, after `DIR_FACING`):
```js
function center(o) { return { x: o.x + o.width / 2, y: o.y + o.height / 2 }; }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
// Nearest DIRS index for a movement vector's signs → facing.
function facingFor(vx, vy) {
  const sx = Math.sign(vx), sy = Math.sign(vy);
  for (let i = 0; i < DIRS.length; i++) if (DIRS[i][0] === sx && DIRS[i][1] === sy) return DIR_FACING[i];
  return null;
}
```
In `addCreatures`, extend the stored object:
```js
      this.creatures.set(c.id, {
        id: c.id, type: c.type, x: c.x, y: c.y,
        width: CREATURE_SIZE, height: CREATURE_SIZE, speed: CREATURE_SPEED,
        facing: c.facing || 'S', hp: c.hp, maxHp: c.hp, color: c.color,
        _dir: dirIdx, dirty: false,
        _target: null, mode: 'roam', _attackCd: 0,
      });
```
Replace `tick(dt, activeChunkKeys)` with the AI+combat version:
```js
  tick(dt, activeChunkKeys, players = []) {
    const active = activeChunkKeys instanceof Set ? activeChunkKeys : new Set(activeChunkKeys);
    const byId = new Map(players.map((p) => [p.userId, p]));
    for (const c of this.creatures.values()) {
      const { cx, cy } = chunkOf(c.x, c.y, this.chunkSize);
      if (!active.has(CHUNK_KEY(cx, cy))) continue; // frozen (out of active set)
      if (c._attackCd > 0) c._attackCd = Math.max(0, c._attackCd - dt);

      const cc = center(c);
      // Target resolution: keep current target unless it left leash; else acquire nearest in aggro.
      if (c._target) {
        const tp = byId.get(c._target);
        if (!tp || dist2(cc.x, cc.y, center(tp).x, center(tp).y) > LEASH_RADIUS * LEASH_RADIUS) c._target = null;
      }
      if (!c._target) {
        let nearest = null, nd2 = AGGRO_RADIUS * AGGRO_RADIUS;
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
        const vx = tc.x - cc.x, vy = tc.y - cc.y;
        const r = resolveMove(this.map, c, vx, vy, dt);
        if (r.x !== c.x || r.y !== c.y) {
          c.x = r.x; c.y = r.y;
          const f = facingFor(vx, vy); if (f) c.facing = f;
          c.dirty = true;
        }
        // Contact damage.
        if (c._attackCd <= 0 && dist2(cc.x, cc.y, tc.x, tc.y) <= CONTACT_RANGE * CONTACT_RANGE) {
          tp.hp -= CREATURE_DAMAGE;
          c._attackCd = CREATURE_ATTACK_COOLDOWN;
        }
        continue;
      }

      // Roam (unchanged behavior).
      if (this.rng() < REDIRECT_CHANCE) {
        c._dir = Math.min(DIRS.length - 1, Math.floor(this.rng() * DIRS.length));
      }
      const [dx, dy] = DIRS[c._dir];
      const r = resolveMove(this.map, c, dx, dy, dt);
      if (r.x !== c.x || r.y !== c.y) {
        c.x = r.x; c.y = r.y;
        c.facing = DIR_FACING[c._dir];
        c.dirty = true;
      } else {
        c._dir = (c._dir + 1) % DIRS.length; // blocked → turn
      }
    }
  }

  // Player melee: damage creatures within `range` of (px,py); remove + return dead ids.
  applyAttack(px, py, range, damage) {
    const killed = [];
    const r2 = range * range;
    for (const [id, c] of this.creatures) {
      const cc = center(c);
      if (dist2(cc.x, cc.y, px, py) > r2) continue;
      c.hp -= damage;
      c.dirty = true;
      if (c.hp <= 0) { this.creatures.delete(id); killed.push(id); }
    }
    return killed;
  }
```
Update `snapshotForNeighborhood` to include `maxHp` and `mode`:
```js
        out.push({ id: c.id, type: c.type, x: c.x, y: c.y, facing: c.facing, hp: c.hp, maxHp: c.maxHp, mode: c.mode, color: c.color });
```
Extend the exports:
```js
module.exports = {
  CreatureSim, CREATURE_SIZE, CREATURE_SPEED, REDIRECT_CHANCE,
  AGGRO_RADIUS, LEASH_RADIUS, CONTACT_RANGE, CREATURE_DAMAGE, CREATURE_ATTACK_COOLDOWN,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/authority_creatures_combat.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the existing creature tests (roam preserved)**

Run: `cd backend && node --test tests/authority_creatures.test.js`
Expected: PASS — `tick(dt, activeKeys)` with no `players` arg defaults to `[]` → roam unchanged.

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/creatures.js backend/tests/authority_creatures_combat.test.js
git commit -m "feat(combat): creature aggression, chase, contact damage, melee"
```

---

### Task 2: `World` — player hp, death/respawn, attack mediation

**Files:**
- Modify: `backend/src/authority/world.js`
- Test: `backend/tests/authority_world_combat.test.js`

**Interfaces:**
- Consumes: `CreatureSim` (Task 1).
- Produces (new/changed on `World`):
  - `addPlayer(userId, spawn)` — player state gains `hp=PLAYER_MAX_HP`, `maxHp=PLAYER_MAX_HP`, `spawn={x,y}`, `_attackCd=0`.
  - `tick(dt)` — also decays each player's `_attackCd`.
  - `tickCreatures(dt, activeKeys)` — `this.creatures.tick(dt, activeKeys, [...this.players.values()])`, then respawn any player with `hp<=0` (position→spawn, `hp=maxHp`).
  - `attack(userId) -> string[]` — per-player cooldown-gated melee; returns killed creature ids.
  - `snapshot()` — players include `hp`, `maxHp`.
  - New exported constants: `PLAYER_MAX_HP`, `MELEE_RANGE`, `PLAYER_DAMAGE`, `PLAYER_ATTACK_COOLDOWN`.

- [ ] **Step 1: Write the failing test**

`backend/tests/authority_world_combat.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { World, PLAYER_MAX_HP, MELEE_RANGE, PLAYER_DAMAGE, PLAYER_ATTACK_COOLDOWN } = require('../src/authority/world.js');

function stubMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }

test('addPlayer starts at full hp; snapshot exposes hp/maxHp', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 100, y: 100 });
  const p = w.getPlayer('u1');
  assert.equal(p.hp, PLAYER_MAX_HP);
  assert.equal(p.maxHp, PLAYER_MAX_HP);
  const snap = w.snapshot();
  assert.equal(snap.players[0].hp, PLAYER_MAX_HP);
  assert.equal(snap.players[0].maxHp, PLAYER_MAX_HP);
});

test('a player at <=0 hp respawns at spawn with full hp', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 500, y: 500 });
  const p = w.getPlayer('u1');
  p.x = 900; p.y = 900; p.hp = -3; // simulate lethal damage away from spawn
  w.tickCreatures(0.05, new Set()); // no active chunks → creatures idle, but death resolves
  assert.equal(p.hp, PLAYER_MAX_HP);
  assert.equal(p.x, 500);
  assert.equal(p.y, 500);
});

test('attack is cooldown-gated and kills an adjacent creature', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 100, y: 100 });
  // Load a low-hp creature right next to the player.
  w.creatures.addCreatures([{ id: 'x', type: 'Wolf', x: 110, y: 100, hp: 5, facing: 'S', color: '#c00' }]);
  const killed = w.attack('u1');
  assert.deepEqual(killed, ['x']);
  // Immediate re-attack is on cooldown → no-op.
  w.creatures.addCreatures([{ id: 'y', type: 'Wolf', x: 110, y: 100, hp: 5, facing: 'S', color: '#c00' }]);
  assert.deepEqual(w.attack('u1'), []);
});

test('attack from an unknown player returns []', () => {
  const w = new World(stubMap());
  assert.deepEqual(w.attack('nobody'), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/authority_world_combat.test.js`
Expected: FAIL — constants undefined / `tickCreatures`/`attack` undefined / snapshot lacks hp.

- [ ] **Step 3: Implement in `world.js`**

Add constants near the top:
```js
const PLAYER_MAX_HP = 100;
const MELEE_RANGE = 90;            // px
const PLAYER_DAMAGE = 10;
const PLAYER_ATTACK_COOLDOWN = 0.5; // s
```
In `addPlayer`, extend the state object:
```js
    this.players.set(userId, {
      userId,
      x: spawn.x, y: spawn.y,
      width: PLAYER_W, height: PLAYER_H, speed: PLAYER_SPEED,
      facing: 's',
      input: { dx: 0, dy: 0 },
      pendingSeq: 0, ackSeq: 0,
      hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP,
      spawn: { x: spawn.x, y: spawn.y },
      _attackCd: 0,
    });
```
In `tick(dt)`, decay the attack cooldown (inside the players loop):
```js
    for (const p of this.players.values()) {
      if (p._attackCd > 0) p._attackCd = Math.max(0, p._attackCd - dt);
      const r = resolveMove(this.map, p, p.input.dx, p.input.dy, dt);
      p.x = r.x;
      p.y = r.y;
      const f = facingFromInput(p.input.dx, p.input.dy);
      if (f) p.facing = f;
      p.ackSeq = p.pendingSeq;
    }
```
Add `tickCreatures` and `attack` methods (after `tick`):
```js
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
```
Update `snapshot()` players to include hp:
```js
      players: [...this.players.values()].map((p) => ({
        id: p.userId, x: p.x, y: p.y, facing: p.facing, hp: p.hp, maxHp: p.maxHp,
      })),
```
Extend the exports:
```js
module.exports = {
  World, PLAYER_W, PLAYER_H, PLAYER_SPEED,
  PLAYER_MAX_HP, MELEE_RANGE, PLAYER_DAMAGE, PLAYER_ATTACK_COOLDOWN,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/authority_world_combat.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the existing world test (player sim preserved)**

Run: `cd backend && node --test tests/authority_world.test.js`
Expected: PASS — movement/clamp/ack/snapshot behavior unchanged (snapshot gains additive hp fields).

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/world.js backend/tests/authority_world_combat.test.js
git commit -m "feat(combat): player hp, death/respawn, melee attack mediation"
```

---

### Task 3: `server.js` — tick order, attack handler, creature deletion

**Files:**
- Modify: `backend/src/authority/server.js`
- Test: `backend/tests/authority_combat_integration.test.js`

**Interfaces:**
- Consumes: `World.tickCreatures`/`attack` (Task 2), the pg pool.
- Produces: creatures tick before the `state` broadcast; new `attack` message → `world.attack` → `DELETE FROM world_creatures` for killed ids.

**Note:** read the current tick `setInterval` and the connection `message` handler before editing (Slice-2 code). The changes are: (a) call `entry.world.tickCreatures(dt, entry.activeChunks)` in place of `entry.world.creatures.tick(dt, entry.activeChunks)`, positioned BEFORE the `state` send; (b) add an `attack` case.

- [ ] **Step 1: Write the failing integration test**

`backend/tests/authority_combat_integration.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

const SECRET = 'test-secret';

// World w1 (chunk_size 8 → chunk (0,0) center 400,400). One wolf near the
// player's spawn so it aggros. chunk insert rowCount 0 (already materialized).
function fakePool() {
  const deletes = [];
  return {
    deletes,
    query: async (sql, params) => {
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      if (/FROM entity_types WHERE is_creature/i.test(sql)) return { rows: [{ name: 'Wolf', color: '#c00', hp: 5 }] };
      if (/INSERT INTO world_chunks/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM world_players WHERE/i.test(sql)) return { rows: [] }; // spawn = center 400,400
      if (/FROM world_creatures/i.test(sql)) {
        // bbox load for chunk (0,0): a wolf ~10px from the player center.
        if (params[1] === 0) return { rows: [{ id: 'wolf1', type: 'Wolf', x: 410, y: 400, hp: 5, facing: 'S', color: '#c00' }] };
        return { rows: [] };
      }
      if (/DELETE FROM world_creatures/i.test(sql)) { deletes.push(params[0]); return { rows: [] }; }
      if (/UPDATE world_creatures/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}
function token(u) { return jwt.sign({ user_id: u }, SECRET, { algorithm: 'HS256' }); }
function bootWith(pool) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, { jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 10000 });
    server.listen(0, () => resolve({ url: `ws://127.0.0.1:${server.address().port}/authority`, handle, server }));
  });
}
function connect(url, uid) { return new WebSocket(`${url}?token=${encodeURIComponent(token(uid))}`); }
function nextMsg(ws, type) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout ${type}`)), 3000);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (!type || m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

test('an adjacent aggro creature damages the player (state.hp drops)', async () => {
  const { url, handle, server } = await bootWith(fakePool());
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  const joined = await nextMsg(ws, 'joined');
  let hurt = false;
  for (let i = 0; i < 60 && !hurt; i++) {
    const s = await nextMsg(ws, 'state');
    const me = s.players.find((p) => p.id === '1');
    if (me && me.hp < me.maxHp) hurt = true;
  }
  assert.ok(hurt, 'player took contact damage');
  ws.close(); handle.close(); server.close();
});

test('attack kills an adjacent creature (DELETE issued, gone from creatures)', async () => {
  const pool = fakePool();
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  await nextMsg(ws, 'creatures'); // ensure the wolf loaded
  // Two attacks (5 hp wolf, 10 dmg) — one is enough; cooldown-safe with a gap.
  ws.send(JSON.stringify({ type: 'attack' }));
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    const m = await nextMsg(ws, 'creatures');
    if (!m.creatures.some((c) => c.id === 'wolf1')) gone = true;
  }
  assert.ok(gone, 'wolf removed after attack');
  assert.ok(pool.deletes.includes('wolf1'), 'DELETE issued for the killed creature');
  ws.close(); handle.close(); server.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/authority_combat_integration.test.js`
Expected: FAIL — no contact damage / no `attack` handling yet.

- [ ] **Step 3: Reorder the tick loop + add the attack handler**

In the tick `setInterval` body, change the per-world block so creatures tick (with players) BEFORE the state broadcast. Replace:
```js
      entry.world.tick(dt);
      const snap = entry.world.snapshot();
      for (const [userId, ws] of entry.sockets) {
        const p = entry.world.getPlayer(userId);
        send(ws, { type: 'state', tick, ackSeq: p ? p.ackSeq : 0, players: snap.players });
      }
      entry.world.creatures.tick(dt, entry.activeChunks);
      if (tick % creatureBroadcastEvery === 0) {
        recomputeActive(entry);
        broadcastCreatures(entry);
      }
```
with:
```js
      entry.world.tick(dt);
      entry.world.tickCreatures(dt, entry.activeChunks); // aggro/chase/contact damage + respawns (before state)
      const snap = entry.world.snapshot();
      for (const [userId, ws] of entry.sockets) {
        const p = entry.world.getPlayer(userId);
        send(ws, { type: 'state', tick, ackSeq: p ? p.ackSeq : 0, players: snap.players });
      }
      if (tick % creatureBroadcastEvery === 0) {
        recomputeActive(entry);
        broadcastCreatures(entry);
      }
```
In the connection `message` handler, add an `attack` case (after the `input` case):
```js
      if (msg.type === 'attack') {
        const entry = worlds.get(ws.worldId);
        if (entry) {
          const killed = entry.world.attack(ws.userId);
          for (const id of killed) {
            pool.query('DELETE FROM world_creatures WHERE id = $1', [id]).catch(() => {});
          }
        }
        return;
      }
```

- [ ] **Step 4: Run the integration test**

Run: `cd backend && node --test tests/authority_combat_integration.test.js`
Expected: PASS (2 tests), clean exit.

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && npm test`
Expected: all pass, clean exit. Note: the Slice-2 `authority_creatures_integration.test.js` places its wolf at (380,380) with the player at spawn (400,400) — now within aggro, so the wolf chases instead of roaming. Its assertions only check that the wolf's position CHANGES (chase moves it) + AOI + flush, so they still hold. If any Slice-2 assertion now fails because it assumed random roam, adjust that test to assert movement generically (position changed) rather than a roam-specific property — do NOT weaken an AOI/flush assertion.

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/server.js backend/tests/authority_combat_integration.test.js
git commit -m "feat(combat): tick creatures before state; attack handler deletes killed creatures"
```

---

### Task 4: Client data — `sendAttack` + creature hp in `applySnapshot`

**Files:**
- Modify: `frontend/src/games/something2/src/js/net/WorldAuthorityClient.js`
- Modify: `frontend/src/games/something2/src/js/net/WorldAuthorityClient.test.js`
- Modify: `frontend/src/games/something2/src/js/entities/CreatureManager.js`
- Modify: `frontend/src/games/something2/src/js/entities/CreatureManager.test.js`

**Interfaces:**
- Produces: `WorldAuthorityClient.sendAttack()` sends `{type:'attack'}`; `CreatureManager` creatures carry `maxHp` (and `mode`) from `applySnapshot`.

- [ ] **Step 1: Write the failing tests**

Append to `WorldAuthorityClient.test.js` (inside the existing `describe`):
```js
  it('sendAttack sends an attack message', () => {
    const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't' });
    c.connect('w1');
    FakeWS.last.emit('open');
    FakeWS.last.sent.length = 0;
    c.sendAttack();
    expect(FakeWS.last.sent).toContainEqual({ type: 'attack' });
  });
```
Append to `CreatureManager.test.js` (inside the existing `describe`):
```js
  it('applySnapshot stores maxHp and mode for hp bars', () => {
    const m = new CreatureManager();
    m.applySnapshot([{ id: 'a', type: 'Wolf', x: 0, y: 0, facing: 'S', hp: 7, maxHp: 10, mode: 'chase', color: '#c00' }]);
    const a = m.all()[0];
    expect(a.hp).toBe(7);
    expect(a.maxHp).toBe(10);
    expect(a.mode).toBe('chase');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/games/something2/src/js/net/WorldAuthorityClient.test.js src/games/something2/src/js/entities/CreatureManager.test.js`
Expected: FAIL — `sendAttack` undefined; `maxHp`/`mode` undefined on the creature.

- [ ] **Step 3: Implement `sendAttack`**

In `WorldAuthorityClient.js`, add after `ping()`:
```js
  sendAttack() { this._send({ type: 'attack' }); }
```

- [ ] **Step 4: Store hp/maxHp/mode in `applySnapshot`**

In `CreatureManager.js` `applySnapshot`, in both the update and create branches, carry `maxHp` and `mode`:
```js
      if (ex) {
        ex.tx = c.x; ex.ty = c.y;
        ex.facing = c.facing; ex.hp = c.hp; ex.maxHp = c.maxHp; ex.mode = c.mode;
        if (c.color) ex.color = c.color;
      } else {
        this.creatures.set(c.id, {
          id: c.id, type: c.type,
          x: c.x, y: c.y, tx: c.x, ty: c.y,
          width: CREATURE_SIZE, height: CREATURE_SIZE,
          facing: c.facing || 'S', hp: c.hp, maxHp: c.maxHp, mode: c.mode, color: c.color,
        });
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/games/something2/src/js/net/WorldAuthorityClient.test.js src/games/something2/src/js/entities/CreatureManager.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/src/js/net/WorldAuthorityClient.js frontend/src/games/something2/src/js/net/WorldAuthorityClient.test.js frontend/src/games/something2/src/js/entities/CreatureManager.js frontend/src/games/something2/src/js/entities/CreatureManager.test.js
git commit -m "feat(combat): client sendAttack + creature hp/maxHp/mode in snapshot"
```

---

### Task 5: Client integration — attack input, player hp, HP-bar rendering

**Files:**
- Modify: `frontend/src/games/something2/src/js/core/Game.js` (attack keydown, player hp in `_onWorldState`)
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js` (player + creature HP bars)

**Interfaces:**
- Consumes: `WorldAuthorityClient.sendAttack` (Task 4), the hp fields in `state`/`creatures`.
- Produces: spacebar attacks; player + creature HP render; respawn via reconcile.

**Note:** read the current `Game.js` keydown handler + `_onWorldState`, and `RenderSystem.drawCreature`/`renderHud`, before editing.

- [ ] **Step 1: Wire the attack key in `Game.js`**

In the `_keydownHandler`, after `this.keys[key] = true;`, add an edge-triggered attack for chunked mode:
```js
            if (key === ' ' && this.chunked && this.authorityClient && !e.repeat) {
                e.preventDefault();
                this.authorityClient.sendAttack();
            }
```
(`e.repeat` guards the browser's key-repeat while held; the server also rate-limits.)

- [ ] **Step 2: Read player hp in `_onWorldState`**

In `_onWorldState`, include hp on remote players and set the local player's hp:
```js
        for (const p of (msg.players || [])) {
            if (p.id === this.localUserId) { mine = p; continue; }
            next.set(p.id, { x: p.x, y: p.y, facing: p.facing, hp: p.hp, maxHp: p.maxHp });
        }
        this.remotePlayers = next;
        if (mine) {
            this.player.hp = mine.hp;
            this.player.maxHp = mine.maxHp;
            const out = reconcile(
                { x: mine.x, y: mine.y },
                msg.ackSeq || 0,
                this._inputBuffer,
                this.chunkedMap,
                { width: this.player.width, height: this.player.height, speed: PLAYER_SPEED_EFFECTIVE }
            );
            this.player.x = out.x;
            this.player.y = out.y;
            this._inputBuffer = out.buffer;
        }
```

- [ ] **Step 3: Draw HP bars in `RenderSystem.js`**

Add a small helper and call it. In `drawCreature(obj, imageKey, alpha, tag)`, after the existing body draw, add an hp bar when the object is damaged:
```js
    // HP bar for damaged actors (creatures + players carry hp/maxHp).
    if (obj.maxHp && obj.hp != null && obj.hp < obj.maxHp) {
      const bx = drawX, by = drawY - 8, bw = w, bh = 4;
      const frac = Math.max(0, Math.min(1, obj.hp / obj.maxHp));
      this.ctx.fillStyle = 'rgba(0,0,0,0.6)';
      this.ctx.fillRect(bx, by, bw, bh);
      this.ctx.fillStyle = frac > 0.5 ? '#4ade80' : frac > 0.25 ? '#facc15' : '#ef4444';
      this.ctx.fillRect(bx, by, bw * frac, bh);
    }
```
(`drawX`/`drawY`/`w`/`h` are the screen rect already computed in `drawCreature` — verify the exact local variable names when editing and reuse them; if they differ, adapt.)

For the local player HUD hp, in `renderHud(player, remotePlayers, localUserId)`, add a line/bar showing `player.hp`/`player.maxHp` (e.g. append `HP: ${player.hp ?? '-'} / ${player.maxHp ?? '-'}` to the existing HUD text lines, or draw a bar). Keep it consistent with the existing HUD style.

- [ ] **Step 4: Run the full frontend suite**

Run: `cd frontend && npm test`
Expected: all pass (no new unit tests here; render/input are integration).

- [ ] **Step 5: Production build**

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 6: Live browser verification**

With the backend restarted (authority running the combat sim) and a world with a creature type:
1. Enter the chunked world; walk near a creature. Confirm it **chases** you (moves toward you, not random) and your **HP drops** (HUD) on contact; a creature HP bar appears when it's damaged.
2. Press **spacebar** next to a creature repeatedly; confirm it takes damage (bar drops) and **dies/disappears** after enough hits.
3. Let a creature kill you; confirm you **respawn** at the world-center spawn with full HP.
4. Two tabs: both see the same creature chasing/being damaged; a creature killed in one tab disappears in the other.
5. Console clean (no errors; `attack` frames only on spacebar).
Record observations in the task report. If two-tab/browser runtime isn't available, note it and rely on the suites + build + single-client check.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/games/something2/src/js/core/Game.js frontend/src/games/something2/src/js/systems/RenderSystem.js
git commit -m "feat(combat): spacebar attack, player hp, HP-bar rendering"
```

---

## Self-Review

**1. Spec coverage:**
- Aggro/chase/leash → Task 1 `tick`. ✓
- Creature contact damage → Task 1 `tick` (folded); player hp/death/respawn → Task 2 `tickCreatures`. ✓
- Player melee (`applyAttack`) + `attack(userId)` cooldown → Tasks 1 + 2. ✓
- `attack` message + creature `DELETE` + tick reorder → Task 3. ✓
- hp fields in `state`/`creatures` → Task 2 snapshot + Task 1 snapshot. ✓
- `sendAttack`, creature hp/maxHp/mode client-side → Task 4. ✓
- Attack input, player hp read, respawn-via-reconcile, HP-bar render → Task 5. ✓
- Single-sourced constants → Tasks 1/2 exports (+ Global Constraints). ✓
- No migration; dead creatures deleted, not respawned → Task 3. ✓

**2. Placeholder scan:** No TBD/TODO; every code step has full code. Task 5 Step 3 flags that `drawX/drawY/w/h` names must be verified against the real `drawCreature` (an existing-code edit, not new code) — acceptable (names the check).

**3. Type consistency:**
- `tick(dt, activeKeys, players=[])` — Slice-2 callers pass 2 args (default `[]`, roam preserved); Task 2 `tickCreatures` passes 3. ✓
- `applyAttack(px,py,range,damage) -> string[]` consistent between Task 1 def and Task 2 `attack`. ✓
- `world.attack(userId) -> string[]` consistent between Task 2 def and Task 3 handler. ✓
- `tickCreatures(dt, activeKeys)` consistent between Task 2 def and Task 3 tick loop. ✓
- Constants imported by tests from `creatures.js`/`world.js` match their definitions. ✓
- `state.players[].hp/maxHp` (Task 2) consumed in Task 5 `_onWorldState`; `creatures[].hp/maxHp/mode` (Task 1) consumed in Task 4 `applySnapshot` + rendered in Task 5. ✓

---
