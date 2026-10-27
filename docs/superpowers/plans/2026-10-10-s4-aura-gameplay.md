# S4 Aura Gameplay vs Players Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hostile creature that carries an `enemies` aura (S3's `aura_effects` library) now hurts players. Every player inside its radius gets speed, damage and defense multipliers for that tick, and takes a damage-over-time charge every `tick_ms` through the normal damage path (defense, resistances, shock vulnerability, death through `resolveDeaths`). Stacking follows spec §3.2: within one aura name the strongest debuff (the SMALLEST multiplier) wins, different names multiply, and the result is floored at 0.5. The owning client sees debuff icons in the HUD and predicts its own slowed movement. Leaving the radius clears everything on the next tick.

**Architecture:** `creatures.js` gains `applyEnemyAuras(creatures, players)`, a separate pass placed beside the SOMET-617 `applyAuras` and modelled on it: centres go into typed arrays, per-(player, aura) accumulators live in module scratch buffers that only grow, and there is one result object per debuffed player. `applyAuras` is not touched, so `aura_apply_equivalence` and `champion_aura_golden` are unaffected by construction. `CreatureSim.tick` stamps `p._buff` on every player (the same field and the same `NO_BUFF` default creatures use), so the existing `effectiveMit()` becomes the one defense read for players too. `chargeAuraDots` charges the DoT through `applyDamageWithEffects`. `world.js` reads `p._buff` for speed (`playerSpeedMult`, which also folds in chill) and outgoing damage (`weaponDamage`, skill damage). The wire carries creature aura NAMES once, in the `snapshotAOI` intro, and the owner's debuffs plus the effective speed multiplier as top-level fields of that socket's own `state` frame (never on the shared player rows). On the client, `auraDebuffs.js` (pure) feeds the existing `_drawActiveBuffs` HUD panel, the reconcile speed and `Player.update`.

**Tech Stack:** Node 20 CommonJS, `node --test`, `ws`; React 19 + Vite + vitest; Canvas 2D.

**Spec:** `docs/superpowers/specs/2026-10-10-boss-entities-auras-design.md` (S4 = §3.2 stacking/floors, §4.2 enemies side + snapshot, §4.5 HUD debuffs, §7 S4 tests)

**Plane:** SOMET-606 (parent SOMET-602). Perf input: SOMET-613 comment "Perf input from the S3 Task 4 review", which SOMET-617 implemented (`0aff0488`).

## Global Constraints

- One git worktree for this slice: `WT=/home/markunn/worker/coding/jsgame/something2-wt-s4-aura-gameplay`, branch `feat/s4-aura-gameplay`, based on `origin/main` `0aff0488` (S1 + S3 + SOMET-617). Never `checkout`/`stash`/`branch`/`merge` in the shared checkout `/home/markunn/worker/coding/jsgame/something2`. Other sessions use it, and it holds another session's untracked sprite-batch files.
- One scratch DB for this branch:
  ```bash
  S4_DB=postgres://user:password@localhost:15432/game_db_s4
  export TEST_DATABASE_URL=$S4_DB DATABASE_URL=$S4_DB
  ```
  Every DB test run sets BOTH variables. Use the literal `postgres://user:password@localhost:15432/game_db_s4`. Do not use `export A=.. B="$A"` on one line, because that leaves B empty (memory: test-harness-lies-teardown-and-env).
- **Never mutate `game_db`** (the shared dev DB). No INSERT/UPDATE/DELETE/DDL there, from you or from any subagent or reviewer you dispatch, and say so in every subagent prompt. Read-only SELECTs only.
- **Migrations:** this slice needs none. If one turns out to be necessary, use `1714440710000+`. That range was checked free on 2026-10-10 on `origin/main`, in the shared checkout, in `../something2-wt-s2-boss-sounds` (no migrations) and in `../something2-wt-s9-dungeon-bosses` (uses `1714440700000`, `1714440701000`). Re-check before merging: `git -C /home/markunn/worker/coding/jsgame/something2 ls-tree --name-only origin/main backend/migrations/ | grep 17144407`.
- Commit subject `type(scope): summary (SOMET-606)`. The body ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage by explicit path only. Never `git add -A` or `git add .`, because the `node_modules` symlinks are not ignored.
- **Trust exit codes.** Run `...; echo "exit=$?"` and never chain the suite with `;` into a reporting command. Also grep for `^not ok` and `testTimeoutFailure`.
- **Known reds, not yours:** `authority_openchest_integration.test.js` (SOMET-615) is excluded from judging and is listed in the baseline. The `refreshPlayerStats` tests (in `authority_server.test.js`, `progression_frame_shape.test.js`, `authority_socket_stone_integration.test.js`) are a known flake (SOMET-619): re-run the single file once before calling it yours.
- **Must stay green, unmodified:** `backend/tests/aura_apply_equivalence.test.js` and `backend/tests/champion_aura_golden.test.js`. This slice does not edit `applyAuras` or either file. If either goes red, the defect is yours.
- Backend tests run from `$WT/backend` with `node --test <file>`, frontend tests from `$WT/frontend` with `npx vitest run <file>`.
- Fixtures never derive an expected value from the constant under test. Write `0.5`, never `ENEMY_AURA_FLOOR`, in an expectation.
- Every new guard is shown RED against the pre-change code (or a deliberately broken variant) before it is made green. Each Step 2 says what the red looks like.

## Review Focus

These are five failure modes a player would hit that no current test covers. Each one is pinned by a test in the task that owns it.

1. **Overlap compounds past the floor, or `Math.max` is reused.** Two overlapping same-name sources must give one debuff, not a stronger one, and the strongest is the SMALLEST multiplier. If `Math.max` is copied from the allies pass, a weak stale source silently wins. Two different auras at 0.6 speed must give 0.5, not 0.36. Pinned in Task 1 (oracle property test plus literal cases) and Task 4 (a real movement distance under two auras).
2. **The DoT bypasses the damage path or never kills.** A raw `p.hp -= dps` would ignore fire resistance and shock, and a `NaN` dps would make the player immortal (`NaN <= 0` is false). The DoT must be halved by 0.5 fire resistance, must reach `resolveDeaths()` exactly once, and must not be charged to a player already at hp ≤ 0. Pinned in Task 2.
3. **Leaving the aura does not clear it.** A stale `p._buff` after the player walks out, after the source dies, or in a world where every creature is gone, leaves the player slowed forever. A DoT timer that "banks" while outside would burst on re-entry. Pinned in Task 2 (clear-on-exit, source death, empty sim, no banking) and Task 5 (the frame omits `debuffs`/`speedMult` once clear).
4. **The client rubber-bands.** The client predicts at the constant `PLAYER_SPEED_EFFECTIVE` (`Game.js:1528`, `constants.js:18`). A server-side slow then snaps the player back every frame. Prediction and reconcile must use the server's `speedMult`. Pinned in Task 7 (`Player.update`, reconcile dims) and Task 8 (browser: smooth slowed walk, no snap-back).
5. **The wrong creatures debuff players.** A Druid's charmed pet carrying an enemies aura must not debuff its owner or anyone else, and neither may a guard or a dead source. A defense debuff must also reach creature PROJECTILE hits, not only bites: `projectiles.js` reads `pl.mit` directly at three sites. Pinned in Task 1 (source filter) and Task 3 (every player damage-taken site plus a source guard).

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `backend/src/authority/creatures.js` | Modify | `ENEMY_AURA_FLOOR`, enemy scratch buffers, `applyEnemyAuras`, `chargeAuraDots`, `dotTickMs`; `tick()` stamps `p._buff` + charges DoT; hostile melee uses `effectiveMit(tp)`; `snapshotAOI` intro sends `auras` names; exports `applyEnemyAuras`, `effectiveMit`, `NO_BUFF`, `__enemyAuraScratchGrowths` |
| `backend/src/authority/world.js` | Modify | `playerSpeedMult`, `auraDamageMult`, `selfAuraFields`; `tick()` speed line; `weaponDamage` + skill damage multiply; burn + PvP sites use `effectiveMit` |
| `backend/src/authority/projectiles.js` | Modify | the 3 player-hit sites use `effectiveMit(pl)` |
| `backend/src/authority/server.js` | Modify | per-socket `state` frame merges `selfAuraFields(p, now)` (one line, additive) |
| `backend/tests/enemy_auras.test.js` | Create | `applyEnemyAuras` unit, literal cases + seeded oracle property test |
| `backend/tests/enemy_aura_tick.test.js` | Create | the tick stamps/clears `_buff`; DoT cadence, resistances, death, attribution, no banking |
| `backend/tests/enemy_aura_defense.test.js` | Create | defense debuff on bite and on creature projectile hit; source guard on `.mit \|\| NO_MITIGATION` |
| `backend/tests/enemy_aura_player_stats.test.js` | Create | movement distance, weapon damage, skill damage, floors under overlap, chill composition |
| `backend/tests/enemy_aura_wire.test.js` | Create | `snapshotAOI` aura names once; `selfAuraFields`; real socket: own frame carries debuffs, never the shared rows |
| `backend/tests/creature_tick_cost.test.js` | Modify | gated row: 4500 creatures, 6 enemy-aura leaders, 20 players inside |
| `backend/tests/enemy_aura_scratch.test.js` | Create | always-on: scratch buffers are reused across ticks (no per-tick growth) |
| `frontend/src/games/something2/src/js/core/auraDebuffs.js` | Create | `selfSpeedMult(msg)`, `debuffHudEntries(debuffs)`, `prettyAuraName` |
| `frontend/src/games/something2/src/js/core/__tests__/auraDebuffs.test.js` | Create | pure rules |
| `frontend/src/games/something2/src/js/entities/Player.js` | Modify | `update` multiplies by `auraSpeedMult` |
| `frontend/src/games/something2/src/js/entities/Player.auraSpeed.test.js` | Create | predicted step scales |
| `frontend/src/games/something2/src/js/entities/CreatureManager.js` | Modify | merge immutable intro `auras` |
| `frontend/src/games/something2/src/js/entities/__tests__/CreatureManager.auras.test.js` | Create | intro merge |
| `frontend/src/games/something2/src/js/core/Game.js` | Modify | `_onWorldState` reads `debuffs`/`speedMult` every frame; reconcile speed; HUD entries passed to render |
| `frontend/src/games/something2/src/js/core/__tests__/gameAuraWiring.test.js` | Create | source gate: Game.js wires the three consumers (backs up the browser pass) |
| `frontend/src/games/something2/src/js/systems/RenderSystem.js` | Modify | `_drawActiveBuffs` draws `persistent` entries (detail text, full bar, no timer) |

## Setup (before Task 1)

- [ ] **Confirm the worktree and branch, then link the dependencies**

```bash
WT=/home/markunn/worker/coding/jsgame/something2-wt-s4-aura-gameplay
git -C $WT log --oneline -1          # expect 0aff0488 perf(auras): applyAuras computes centres once ...
git -C $WT branch --show-current     # if not feat/s4-aura-gameplay: git -C $WT switch -c feat/s4-aura-gameplay
[ -e $WT/backend/node_modules ]  || ln -s /home/markunn/worker/coding/jsgame/something2/backend/node_modules  $WT/backend/node_modules
[ -e $WT/frontend/node_modules ] || ln -s /home/markunn/worker/coding/jsgame/something2/frontend/node_modules $WT/frontend/node_modules
```

- [ ] **Create and seed the scratch DB** (about 2 minutes; this is the only DB you write to)

```bash
docker exec something2-db-1 psql -U user -d postgres -c 'CREATE DATABASE game_db_s4;'
export TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_s4
export DATABASE_URL=postgres://user:password@localhost:15432/game_db_s4
cd $WT/backend
npx node-pg-migrate up --ignore-pattern '(?!.*\.js$).*'
node scripts/seed-catalogs.js
SPEC=p5-descent node scripts/seed-map.js
SPEC=vale-region node scripts/seed-map.js     # vale-region LAST
FORCE=1 node scripts/seed-passive-tree.js
```

- [ ] **Record a baseline** so that pre-existing reds are not blamed on this slice

```bash
cd $WT/backend && npm test > ../../s4-baseline.log 2>&1; echo "exit=$?"
grep -E '^not ok|testTimeoutFailure' ../../s4-baseline.log
node --test tests/aura_apply_equivalence.test.js tests/champion_aura_golden.test.js; echo "exit=$?"   # must be exit=0 now
cd $WT/frontend && npx vitest run > ../../s4-fe-baseline.log 2>&1; echo "exit=$?"
```

Keep the list of failing files. Every later full run on this DB is a "second run" (state-dependent pairs go green on a second run; see memory `vacuous-test-patterns`).

---

### Task 1: `applyEnemyAuras`, the enemies-side pass (pure)

**Files:**
- Modify: `backend/src/authority/creatures.js`. Insert after `applyAuras` ends (`return buffs; }`, `:1187-1188`) and before `NO_BUFF` (`:1192`). Add the exports at `:2737`.
- Test: `backend/tests/enemy_auras.test.js` (create)

**Interfaces:**
- Consumes: the resolved `AuraDef` from `resolveInstanceAuras` (`services/auraEffects.js:76-90`): `{ name, targetSide, radius, damageMult, defenseMult, speedMult, dotDps, dotElement, tickMs }`. Players `{ userId, x, y, width, height, hp }`.
- Produces: `applyEnemyAuras(creatures, players) -> Map<userId, PlayerDebuff>` where
  `PlayerDebuff = { damageMult, defenseMult, speedMult, auras: [{ name, damageMult, defenseMult, speedMult, dotDps, dotElement, tickMs, sourceId }] }`. The totals are floored at 0.5. Each `auras[]` entry holds the per-name value before the floor, and the list is in the order each name first reached that player. Also `ENEMY_AURA_FLOOR = 0.5` and `__enemyAuraScratchGrowths()`.

Rules (each one tested):
- A **source** is a creature with `hp > 0`, `faction === 'hostile'`, `charmOwnerUserId == null`, and an aura with `targetSide === 'enemies'` and `radius > 0`. Guards, wild creatures and charmed pets are never sources (decision D3).
- A **target** is a player with `hp > 0` whose centre is within `radius` of the source centre (squared distance, `<=`). Unlike the allies pass, a NaN position is excluded (`!(d2 <= r2)`).
- Within one name, take the per-stat MINIMUM. Each per-aura value is first clamped to at most 1, so an enemies aura can only hinder (decision D2). NaN counts as 1. The DoT takes the per-name MAXIMUM `dotDps`, and its source is the first source that reached that maximum.
- Across names, multiply in first-reach order. Then floor each total at 0.5.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/enemy_auras.test.js
// SOMET-606 (S4). The enemies-side aura pass over PLAYERS. Spec §3.2: same
// aura -> the STRONGEST debuff, which is the SMALLEST multiplier (the allies
// pass uses Math.max -- copying it here is the defect this file exists for);
// different auras multiply; totals floored at 0.5.
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyEnemyAuras } = require('../src/authority/creatures.js');

const A = (over = {}) => ({ name: 'blight', targetSide: 'enemies', radius: 300,
  damageMult: 1, defenseMult: 1, speedMult: 1, dotDps: 0, dotElement: 'physical', tickMs: 1000, ...over });
const src = (id, x, auras, over = {}) => ({ id, x, y: 0, width: 48, height: 48, hp: 50, faction: 'hostile', auras, ...over });
const pl = (userId, x, over = {}) => ({ userId, x, y: 0, width: 64, height: 64, hp: 100, ...over });

test('a player inside an enemies aura gets its multipliers; outside gets nothing', () => {
  const out = applyEnemyAuras([src('S', 0, [A({ speedMult: 0.6, damageMult: 0.8, defenseMult: 0.7 })])],
    [pl('in', 100), pl('out', 900)]);
  assert.deepEqual([...out.keys()], ['in']);
  const d = out.get('in');
  assert.equal(d.speedMult, 0.6);
  assert.equal(d.damageMult, 0.8);
  assert.equal(d.defenseMult, 0.7);
  assert.deepEqual(d.auras.map((a) => [a.name, a.sourceId]), [['blight', 'S']]);
});

test('same aura from two sources: the SMALLEST multiplier wins, never compounding (not Math.max)', () => {
  const out = applyEnemyAuras([
    src('weak', 0, [A({ speedMult: 0.9 })]),
    src('strong', 10, [A({ speedMult: 0.6 })]),
  ], [pl('u', 50)]);
  assert.equal(out.get('u').speedMult, 0.6);
  assert.equal(out.get('u').auras.length, 1);
});

test('two DIFFERENT auras multiply, and the total is floored at 0.5 on every stat', () => {
  const out = applyEnemyAuras([
    src('a', 0, [A({ name: 'mire', speedMult: 0.6, damageMult: 0.6, defenseMult: 0.6 })]),
    src('b', 0, [A({ name: 'dread', speedMult: 0.6, damageMult: 0.9, defenseMult: 0.6 })]),
  ], [pl('u', 50)]);
  const d = out.get('u');
  assert.equal(d.speedMult, 0.5, '0.6 * 0.6 = 0.36 must floor to 0.5');
  assert.equal(d.defenseMult, 0.5);
  assert.ok(Math.abs(d.damageMult - 0.54) < 1e-12, `0.6*0.9 = 0.54 stays above the floor, got ${d.damageMult}`);
  assert.deepEqual(d.auras.map((a) => a.name), ['mire', 'dread']);
  assert.equal(d.auras[0].speedMult, 0.6, 'per-name entries are pre-floor');
});

test('an enemies aura can only hinder: a multiplier above 1 is treated as 1', () => {
  const out = applyEnemyAuras([src('S', 0, [A({ damageMult: 1.5, speedMult: 0.8 })])], [pl('u', 50)]);
  assert.equal(out.get('u').damageMult, 1);
  assert.equal(out.get('u').speedMult, 0.8);
});

test('DoT: per name the LARGEST dps wins and names its source', () => {
  const out = applyEnemyAuras([
    src('low', 0, [A({ dotDps: 2, dotElement: 'fire' })]),
    src('high', 0, [A({ dotDps: 7, dotElement: 'fire' })]),
  ], [pl('u', 50)]);
  const a = out.get('u').auras[0];
  assert.equal(a.dotDps, 7);
  assert.equal(a.sourceId, 'high');
  assert.equal(a.dotElement, 'fire');
});

for (const [label, over] of [
  ['a charmed pet', { charmOwnerUserId: 'u' }],
  ['a guard', { faction: 'guard' }],
  ['a wild creature', { faction: 'wild' }],
  ['a dead source', { hp: 0 }],
]) {
  test(`${label} never debuffs a player`, () => {
    const out = applyEnemyAuras([src('S', 0, [A({ speedMult: 0.5 })], over)], [pl('u', 50)]);
    assert.equal(out.size, 0);
  });
}

test('allies-side auras, radius 0 and dead/NaN-position players are ignored', () => {
  assert.equal(applyEnemyAuras([src('S', 0, [A({ targetSide: 'allies', speedMult: 0.5 })])], [pl('u', 50)]).size, 0);
  assert.equal(applyEnemyAuras([src('S', 0, [A({ radius: 0, speedMult: 0.5 })])], [pl('u', 50)]).size, 0);
  assert.equal(applyEnemyAuras([src('S', 0, [A({ speedMult: 0.5 })])], [pl('u', 50, { hp: 0 })]).size, 0);
  assert.equal(applyEnemyAuras([src('S', 0, [A({ speedMult: 0.5 })])], [pl('u', NaN)]).size, 0);
});

test('no players or no sources returns an empty Map', () => {
  assert.equal(applyEnemyAuras([src('S', 0, [A()])], []).size, 0);
  assert.equal(applyEnemyAuras([], [pl('u', 0)]).size, 0);
});

// -- Oracle. Written independently of the implementation (Maps, no scratch),
// so a typed-array slip (wrong stride, stale scratch from a previous call)
// shows up as a mismatch on some seed.
function oracle(creatures, players) {
  const out = new Map();
  for (const p of players) {
    if (!(p.hp > 0)) continue;
    const pcx = p.x + p.width / 2, pcy = p.y + p.height / 2;
    const byName = new Map();
    for (const c of creatures) {
      if (!(c.hp > 0) || c.faction !== 'hostile' || c.charmOwnerUserId != null || !Array.isArray(c.auras)) continue;
      for (const a of c.auras) {
        if (a.targetSide !== 'enemies' || !(a.radius > 0)) continue;
        const dx = c.x + c.width / 2 - pcx, dy = c.y + c.height / 2 - pcy;
        if (!(dx * dx + dy * dy <= a.radius * a.radius)) continue;
        const h = (v) => (v < 1 ? v : 1);
        const cur = byName.get(a.name);
        if (!cur) byName.set(a.name, { d: h(a.damageMult), f: h(a.defenseMult), s: h(a.speedMult), dps: a.dotDps > 0 ? a.dotDps : 0, src: c.id });
        else {
          cur.d = Math.min(cur.d, h(a.damageMult)); cur.f = Math.min(cur.f, h(a.defenseMult)); cur.s = Math.min(cur.s, h(a.speedMult));
          if (a.dotDps > cur.dps) { cur.dps = a.dotDps; cur.src = c.id; }
        }
      }
    }
    if (byName.size === 0) continue;
    let d = 1, f = 1, s = 1;
    for (const v of byName.values()) { d *= v.d; f *= v.f; s *= v.s; }
    out.set(p.userId, { d: Math.max(0.5, d), f: Math.max(0.5, f), s: Math.max(0.5, s),
      names: [...byName.keys()], dps: [...byName.values()].map((v) => v.dps), srcs: [...byName.values()].map((v) => v.src) });
  }
  return out;
}
function rngFrom(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('matches the oracle over 1000 seeded layouts, called twice each (scratch reuse)', () => {
  const rnd = rngFrom(0x606);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  let debuffed = 0, multiName = 0, floored = 0;
  for (let i = 0; i < 1000; i++) {
    const creatures = []; const players = [];
    const span = 200 + rnd() * 600;
    for (let k = 0, n = Math.floor(rnd() * 30); k < n; k++) {
      const auras = [];
      for (let j = 0, m = Math.floor(rnd() * 3); j < m; j++) {
        auras.push(A({ name: pick(['mire', 'dread', 'blight']), targetSide: rnd() < 0.8 ? 'enemies' : 'allies',
          radius: rnd() < 0.1 ? 0 : rnd() * 400, damageMult: 0.3 + rnd(), defenseMult: 0.3 + rnd(),
          speedMult: 0.3 + rnd(), dotDps: rnd() < 0.5 ? 0 : rnd() * 10 }));
      }
      creatures.push({ id: `c${k}`, x: rnd() * span, y: rnd() * span, width: 48, height: 48,
        hp: rnd() < 0.1 ? 0 : 10, faction: pick(['hostile', 'hostile', 'guard']),
        charmOwnerUserId: rnd() < 0.05 ? 'u0' : null, auras });
    }
    for (let k = 0, n = 1 + Math.floor(rnd() * 8); k < n; k++) {
      players.push({ userId: `u${k}`, x: rnd() * span, y: rnd() * span, width: 64, height: 64, hp: rnd() < 0.1 ? 0 : 100 });
    }
    const exp = oracle(creatures, players);
    for (const pass of [1, 2]) {
      const got = applyEnemyAuras(creatures, players);
      assert.deepEqual([...got.keys()].sort(), [...exp.keys()].sort(), `layout ${i} pass ${pass}: ids`);
      for (const [id, e] of exp) {
        const g = got.get(id);
        for (const [k, ek] of [['damageMult', 'd'], ['defenseMult', 'f'], ['speedMult', 's']]) {
          assert.ok(Math.abs(g[k] - e[ek]) < 1e-12, `layout ${i} ${id}.${k} ${g[k]} vs ${e[ek]}`);
        }
        assert.deepEqual(g.auras.map((a) => a.name), e.names, `layout ${i} ${id} order`);
        assert.deepEqual(g.auras.map((a) => a.dotDps), e.dps);
        assert.deepEqual(g.auras.map((a) => a.sourceId), e.srcs);
      }
    }
    debuffed += exp.size;
    for (const e of exp.values()) { if (e.names.length >= 2) multiName++; if (e.s === 0.5) floored++; }
  }
  // Anti-vacuity: the generator must actually reach overlap and the floor.
  assert.ok(debuffed > 1500, `only ${debuffed} debuffed players`);
  assert.ok(multiName > 300, `only ${multiName} multi-name targets`);
  assert.ok(floored > 50, `only ${floored} floored targets`);
});
```

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `cd $WT/backend && node --test tests/enemy_auras.test.js; echo "exit=$?"`
Expected: every test fails with `TypeError: applyEnemyAuras is not a function`, and `exit=1`. Also prove that the min rule is load-bearing. After Step 3, temporarily change the `Math.min` on speed to `Math.max`, confirm that both "SMALLEST multiplier wins" and the oracle test go red, then revert.

- [ ] **Step 3: Implement.** Insert after `applyAuras` (after `creatures.js:1188`):

```js
// SOMET-606 (S4). ENEMY-side auras: hostile creatures debuff PLAYERS in radius.
//
// A SEPARATE pass from applyAuras, deliberately (SOMET-617 review): player and
// creature ids do not share a namespace, the candidates are the world's few
// players rather than its thousands of creatures, and applyAuras is pinned
// bit-for-bit by aura_apply_equivalence -- touching it would re-open that.
//
// STACKING (spec §3.2), the mirror image of the allies pass:
//   - same aura name from several sources -> the STRONGEST debuff, i.e. the
//     SMALLEST multiplier (Math.min). Math.max here would let a weak, stale
//     source win; that is the defect enemy_auras.test.js pins.
//   - different names -> multiply, in first-reach order;
//   - each TOTAL floored at ENEMY_AURA_FLOOR (0.5).
//   - DoT: per name, the LARGEST dps, attributed to the first source holding it.
// Only an uncharmed live HOSTILE is a source (a Druid's pet never debuffs its
// owner; a guard's enemies are creatures, not players). Each per-aura value is
// clamped to <= 1: an enemies aura only ever hinders.
//
// Cost: O(enemy sources x players). No cap -- players per world are tens, not
// thousands; creature_tick_cost's enemy row is the measurement (Task 6).
// The inner loop allocates nothing; one result object (+ one entry per aura
// name) per DEBUFFED player.
const ENEMY_AURA_FLOOR = 0.5;
let enemyAcc = new Float64Array(0);   // [slot*G + g]*4 + {0 dmg, 1 def, 2 spd, 3 dps}
let enemySeen = new Uint8Array(0);    // [slot*G + g] -> 1 once that name reached that player
let enemyOrder = new Int32Array(0);   // [slot*G + k] -> k-th name group to reach that player
let enemyDotSrc = new Int32Array(0);  // [slot*G + g] -> source index holding the max dps
let enemyCount = new Int32Array(0);   // [slot] -> number of groups in enemyOrder
let enemyPx = new Float64Array(0);    // [slot] -> player centre x
let enemyPy = new Float64Array(0);
let enemyScratchGrowths = 0;          // test hook: must stay flat across ticks of one size
function enemyScratch(cells, slots) {
  if (enemySeen.length < cells) {
    const size = Math.max(cells, enemySeen.length * 2);
    enemyAcc = new Float64Array(size * 4);
    enemySeen = new Uint8Array(size);
    enemyOrder = new Int32Array(size);
    enemyDotSrc = new Int32Array(size);
    enemyScratchGrowths++;
  }
  if (enemyCount.length < slots) {
    const size = Math.max(slots, enemyCount.length * 2);
    enemyCount = new Int32Array(size);
    enemyPx = new Float64Array(size);
    enemyPy = new Float64Array(size);
    enemyScratchGrowths++;
  }
}
// `v < 1 ? v : 1`: NaN compares false, so a NaN multiplier is neutral (1).
function hinder(v) { return v < 1 ? v : 1; }

function applyEnemyAuras(creatures, players) {
  const out = new Map();
  const plist = Array.isArray(players) ? players : [...players];
  const P = plist.length;
  if (P === 0) return out;
  const list = Array.isArray(creatures) ? creatures : [...creatures];

  const srcIdx = [];
  const srcAura = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const auras = c.auras;
    if (!Array.isArray(auras) || auras.length === 0) continue; // most creatures
    if (!(c.hp > 0) || c.faction !== 'hostile' || c.charmOwnerUserId != null) continue;
    for (let k = 0; k < auras.length; k++) {
      const a = auras[k];
      if (a.targetSide === 'enemies' && a.radius > 0) { srcIdx.push(i); srcAura.push(a); }
    }
  }
  const S = srcIdx.length;
  if (S === 0) return out;

  const groupOf = new Map();
  const srcGroup = new Int32Array(S);
  for (let s = 0; s < S; s++) {
    const name = srcAura[s].name;
    let g = groupOf.get(name);
    if (g === undefined) { g = groupOf.size; groupOf.set(name, g); }
    srcGroup[s] = g;
  }
  const G = groupOf.size;

  // Slots ARE player indices: players are distinct objects keyed by userId in
  // World.players, so no id-merge step is needed (unlike the creature pass).
  enemyScratch(P * G, P);
  enemySeen.fill(0, 0, P * G);
  for (let j = 0; j < P; j++) {
    const p = plist[j];
    enemyCount[j] = 0;
    enemyPx[j] = p.x + p.width / 2;
    enemyPy[j] = p.y + p.height / 2;
  }

  for (let s = 0; s < S; s++) {
    const src = list[srcIdx[s]];
    const a = srcAura[s];
    const g = srcGroup[s];
    const dm = hinder(a.damageMult); const fm = hinder(a.defenseMult); const sm = hinder(a.speedMult);
    const dps = a.dotDps > 0 ? a.dotDps : 0;
    const r2 = a.radius * a.radius;
    const sx = src.x + src.width / 2;
    const sy = src.y + src.height / 2;
    for (let j = 0; j < P; j++) {
      if (!(plist[j].hp > 0)) continue;
      const dx = sx - enemyPx[j]; const dy = sy - enemyPy[j];
      if (!(dx * dx + dy * dy <= r2)) continue; // NaN position -> excluded
      const cell = j * G + g;
      const p4 = cell * 4;
      if (enemySeen[cell] === 0) {
        enemySeen[cell] = 1;
        enemyOrder[j * G + enemyCount[j]++] = g;
        enemyAcc[p4] = dm; enemyAcc[p4 + 1] = fm; enemyAcc[p4 + 2] = sm; enemyAcc[p4 + 3] = dps;
        enemyDotSrc[cell] = s;
      } else {
        // Math.MIN within one aura name -- this line IS the enemies-side rule.
        if (dm < enemyAcc[p4]) enemyAcc[p4] = dm;
        if (fm < enemyAcc[p4 + 1]) enemyAcc[p4 + 1] = fm;
        if (sm < enemyAcc[p4 + 2]) enemyAcc[p4 + 2] = sm;
        if (dps > enemyAcc[p4 + 3]) { enemyAcc[p4 + 3] = dps; enemyDotSrc[cell] = s; }
      }
    }
  }

  for (let j = 0; j < P; j++) {
    const k = enemyCount[j];
    if (k === 0) continue;
    let d = 1; let f = 1; let sp = 1;
    const auras = new Array(k);
    for (let q = 0; q < k; q++) {
      const g = enemyOrder[j * G + q];
      const cell = j * G + g;
      const p4 = cell * 4;
      d *= enemyAcc[p4]; f *= enemyAcc[p4 + 1]; sp *= enemyAcc[p4 + 2];
      const ds = enemyDotSrc[cell];
      const a = srcAura[ds];
      auras[q] = {
        name: a.name,
        damageMult: enemyAcc[p4], defenseMult: enemyAcc[p4 + 1], speedMult: enemyAcc[p4 + 2],
        dotDps: enemyAcc[p4 + 3],
        dotElement: typeof a.dotElement === 'string' ? a.dotElement : 'physical',
        tickMs: a.tickMs,
        sourceId: list[srcIdx[ds]].id,
      };
    }
    out.set(plist[j].userId, {
      damageMult: d > ENEMY_AURA_FLOOR ? d : ENEMY_AURA_FLOOR,
      defenseMult: f > ENEMY_AURA_FLOOR ? f : ENEMY_AURA_FLOOR,
      speedMult: sp > ENEMY_AURA_FLOOR ? sp : ENEMY_AURA_FLOOR,
      auras,
    });
  }
  return out;
}
function __enemyAuraScratchGrowths() { return enemyScratchGrowths; }
```

Add these to `module.exports` (`creatures.js:2737`), next to `applyAuras`:

```js
  // SOMET-606 (S4): the enemies-side pass and the shared defense read, exported
  // so world.js/projectiles.js use the SAME effectiveMit and tests pin the pass.
  applyEnemyAuras, ENEMY_AURA_FLOOR, effectiveMit, NO_BUFF, __enemyAuraScratchGrowths,
```

- [ ] **Step 4: Run it and confirm it PASSES, along with the S3/617 guards**

```bash
cd $WT/backend && node --test tests/enemy_auras.test.js tests/aura_apply_equivalence.test.js tests/champion_aura_golden.test.js tests/authority_creature_auras.test.js; echo "exit=$?"
```
Expected: `exit=0`. Do the `Math.max` sabotage check from Step 2 and revert it.

- [ ] **Step 5: Commit**

```bash
git -C $WT add backend/src/authority/creatures.js backend/tests/enemy_auras.test.js
git -C $WT commit -m "feat(auras): enemies-side aura pass over players with min-stacking and 0.5 floors (SOMET-606)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The tick stamps player debuffs and charges the DoT through the damage path

**Files:**
- Modify: `backend/src/authority/creatures.js`. `tick()` gets lines after `:1558` (`for (const c of all) c._buff = ...`). The new `dotTickMs` and `chargeAuraDots` go directly after `applyEnemyAuras`.
- Test: `backend/tests/enemy_aura_tick.test.js` (create)

**Interfaces:**
- Consumes: `applyEnemyAuras` (Task 1); `applyDamageWithEffects`, `creatureKey` (`damage.js:56-57,169`, already imported at `creatures.js:9`); `effectiveMit` (`creatures.js:1202`).
- Produces: after every `CreatureSim.tick`, every player in `players` has `p._buff`, which is either the `PlayerDebuff` or the shared frozen `NO_BUFF`. `p._auraDotAt: Map<auraName, nextChargeMs>` is created lazily on the first DoT.

DoT timing (decision D5): a name charges when `now >= nextAt` (absent counts as due), then sets `nextAt = now + tickMs`. The first charge lands on entry. Nothing accumulates while outside, so there is no banking. Stepping out and back in within `tickMs` does not re-charge. The raw amount per charge is `dotDps * tickMs / 1000`. `tickMs` outside `[100, 5000]` (or NaN) falls back to 1000, the same bounds as `AURA_LIMITS` (`auraEffects.js:11-13`). The charge goes through `applyDamageWithEffects(p, raw, dotElement, effectiveMit(p), now, creatureKey(sourceId))`, so defense, the defense debuff, resistances (`damage.js:120-131`), shock vulnerability and the provocation stamp all apply. A player killed by it is left at hp ≤ 0 for `World.resolveDeaths()` (`world.js:1612-1636`), the single player-death path. No extra death code is added.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/enemy_aura_tick.test.js
// SOMET-606 (S4). The live tick: debuffs land on players, clear when they
// leave, and the DoT goes THROUGH applyDamageWithEffects -- resistances,
// defense, death via resolveDeaths -- never a raw hp subtraction.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CreatureSim } = require('../src/authority/creatures.js');
const { World } = require('../src/authority/world.js');

const stubMap = () => ({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 });
const FROZEN = new Set(); // no active chunk: creatures neither move nor bite, auras still apply
const blight = (over = {}) => ({ name: 'blight', targetSide: 'enemies', radius: 300, damageMult: 1,
  defenseMult: 1, speedMult: 0.6, dotDps: 10, dotElement: 'fire', tickMs: 500, ...over });
function sim(auras, over = {}) {
  const s = new CreatureSim(stubMap(), () => 0.5);
  s.addCreatures([{ id: 'S', type: 'T', x: 0, y: 0, hp: 100, faction: 'hostile', auras, ...over }]);
  return s;
}
const player = (x = 50, over = {}) => ({ userId: 'u1', x, y: 0, width: 64, height: 64, hp: 100, maxHp: 100, mit: null, ...over });

test('inside: _buff carries the debuff; outside: the shared neutral buff', () => {
  const s = sim([blight()]);
  const p = player();
  s.tick(0.05, FROZEN, [p], 0);
  assert.equal(p._buff.speedMult, 0.6);
  p.x = 5000;
  s.tick(0.05, FROZEN, [p], 50);
  assert.equal(p._buff.speedMult, 1);
  assert.equal(p._buff.auras, undefined, 'NO_BUFF, not a stale debuff');
});

test('the debuff clears the tick after the source dies, and in an empty sim', () => {
  const s = sim([blight()]);
  const p = player();
  s.tick(0.05, FROZEN, [p], 0);
  s.get('S').hp = 0;
  s.tick(0.05, FROZEN, [p], 50);
  assert.equal(p._buff.speedMult, 1);
  const empty = new CreatureSim(stubMap(), () => 0.5);
  p._buff = { speedMult: 0.5 }; // stale from another world
  empty.tick(0.05, FROZEN, [p], 0);
  assert.equal(p._buff.speedMult, 1);
});

test('DoT cadence: first charge on entry, then one per tick_ms -- 10 dps @ 500ms over 2s = 5 charges of 5', () => {
  const s = sim([blight()]);
  const p = player();
  for (let now = 0; now <= 2000; now += 50) s.tick(0.05, FROZEN, [p], now);
  // charges at 0, 500, 1000, 1500, 2000
  assert.equal(p.hp, 100 - 5 * 5);
});

test('DoT respects resistance: 50% fire resist halves every charge', () => {
  const s = sim([blight({ tickMs: 1000 })]);
  const p = player(50, { mit: { defense: 0, resistances: { fire: 0.5 } } });
  s.tick(0.05, FROZEN, [p], 0);
  assert.equal(p.hp, 100 - 10 * 0.5);
});

test('DoT respects defense AND the aura\'s own defense debuff', () => {
  const s = sim([blight({ tickMs: 1000, defenseMult: 0.5 })]);
  const p = player(50, { mit: { defense: 4, resistances: {} } });
  s.tick(0.05, FROZEN, [p], 0);
  assert.equal(p.hp, 100 - (10 - 4 * 0.5));
});

test('DoT is attributed to the source creature (provocation stamp), not left anonymous', () => {
  const s = sim([blight({ tickMs: 1000 })]);
  const p = player();
  s.tick(0.05, FROZEN, [p], 0);
  assert.equal(p._provokedBy.by, 'c:S');
});

test('no banking: time spent outside does not burst on re-entry; in-out-in inside tick_ms does not re-charge', () => {
  const s = sim([blight({ tickMs: 1000 })]);
  const p = player();
  s.tick(0.05, FROZEN, [p], 0);            // charge 1
  p.x = 5000;
  for (let now = 50; now < 400; now += 50) s.tick(0.05, FROZEN, [p], now);
  p.x = 50;
  s.tick(0.05, FROZEN, [p], 400);          // back in before 1000: no charge
  assert.equal(p.hp, 90);
  p.x = 5000;
  for (let now = 450; now < 5000; now += 50) s.tick(0.05, FROZEN, [p], now);
  p.x = 50;
  s.tick(0.05, FROZEN, [p], 5000);          // one charge, not five
  assert.equal(p.hp, 80);
});

test('a player already at hp <= 0 is not charged', () => {
  const s = sim([blight({ tickMs: 1000 })]);
  const p = player(50, { hp: 0 });
  s.tick(0.05, FROZEN, [p], 0);
  assert.equal(p.hp, 0);
});

test('NaN dps / NaN tick_ms never make the player immortal or charge NaN', () => {
  const s = sim([blight({ dotDps: NaN }), blight({ name: 'other', tickMs: NaN, dotDps: 10 })]);
  const p = player();
  s.tick(0.05, FROZEN, [p], 0);
  assert.ok(Number.isFinite(p.hp), `hp ${p.hp}`);
  assert.equal(p.hp, 90, 'NaN tick_ms falls back to 1000: 10 dps -> 10');
});

test('a DoT kill reaches resolveDeaths exactly once (the one player-death path)', () => {
  const map = { ...stubMap(), getChunk: () => [] };
  const w = new World(map, new Map(), null);
  w.addPlayer('u1', { x: 50, y: 0 });
  w.creatures.addCreatures([{ id: 'S', type: 'T', x: 0, y: 0, hp: 100, faction: 'hostile',
    auras: [blight({ dotDps: 100000, tickMs: 1000 })] }]);
  w.tickCreatures(0.05, FROZEN);
  assert.deepEqual(w.resolveDeaths(), ['u1']);
  assert.deepEqual(w.resolveDeaths(), [], 'respawned at full, not re-reported');
});
```

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `cd $WT/backend && node --test tests/enemy_aura_tick.test.js; echo "exit=$?"`
Expected: `exit=1`. The `_buff` tests fail with `Cannot read properties of undefined (reading 'speedMult')`, and every DoT test fails on `hp` still being 100.

- [ ] **Step 3: Implement.** Directly after `__enemyAuraScratchGrowths` (Task 1):

```js
// A DoT cadence the aura_effects CHECK would accept, else 1000 -- a NaN or 0
// tick_ms must not charge every tick (or never).
function dotTickMs(t) {
  return t >= 100 && t <= 5000 ? t : 1000;
}

// SOMET-606. Charges each enemy-aura DoT on its own per-name clock. Called
// from tick() right after applyEnemyAuras stamped p._buff.
//
// THROUGH THE DAMAGE PATH (spec §4.2): applyDamageWithEffects with
// effectiveMit(p), so defense (and the aura's own defense debuff),
// resistances, shock vulnerability and the provocation stamp all apply exactly
// as for a bite. A kill is left at hp <= 0 for World.resolveDeaths(), the ONE
// player-death path -- this function never respawns or reports anyone.
//
// NO BANKING: `_auraDotAt` stores the next DUE time per name. A name is due
// when now >= nextAt, so the first charge lands on entry, time spent outside
// accumulates nothing, and stepping out and back inside tick_ms re-charges
// nothing.
function chargeAuraDots(players, now) {
  for (const p of players) {
    const b = p._buff;
    if (b === NO_BUFF || !b || !Array.isArray(b.auras) || !(p.hp > 0)) continue;
    for (let k = 0; k < b.auras.length; k++) {
      const a = b.auras[k];
      if (!(a.dotDps > 0)) continue;
      const at = p._auraDotAt;
      const due = at ? at.get(a.name) : undefined;
      if (due !== undefined && now < due) continue;
      const tickMs = dotTickMs(a.tickMs);
      (at || (p._auraDotAt = new Map())).set(a.name, now + tickMs);
      applyDamageWithEffects(p, a.dotDps * tickMs / 1000, a.dotElement, effectiveMit(p), now, creatureKey(a.sourceId));
      if (!(p.hp > 0)) break;
    }
  }
}
```

In `tick()`, directly after `for (const c of all) c._buff = buffs.get(c.id) || NO_BUFF;` (`creatures.js:1558`):

```js
    // SOMET-606 (S4): enemy-side auras over PLAYERS, same once-per-tick rule.
    // EVERY player gets a fresh _buff (NO_BUFF when nothing reaches them) so a
    // debuff can never outlive its source or the player's exit. p._buff is
    // read by effectiveMit (every damage-taken site), world.js's speed and
    // outgoing-damage reads, and the self frame.
    const debuffs = applyEnemyAuras(all, players);
    for (const p of players) p._buff = debuffs.get(p.userId) || NO_BUFF;
    if (debuffs.size > 0) chargeAuraDots(players, now);
```

- [ ] **Step 4: Run it and confirm it PASSES, along with the guards**

```bash
cd $WT/backend && node --test tests/enemy_aura_tick.test.js tests/enemy_auras.test.js tests/champion_aura_golden.test.js tests/aura_apply_equivalence.test.js tests/authority_creature_auras.test.js; echo "exit=$?"
```
Expected: `exit=0`. The golden stays identical because its player has `mit: null` and no enemies aura is in play, so `_buff` is `NO_BUFF` and nothing is charged.

- [ ] **Step 5: Commit**

```bash
git -C $WT add backend/src/authority/creatures.js backend/tests/enemy_aura_tick.test.js
git -C $WT commit -m "feat(auras): tick stamps player debuffs and charges aura DoT through the damage path (SOMET-606)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Every player damage-taken site reads `effectiveMit`

**Files:**
- Modify: `backend/src/authority/creatures.js:2179-2182` (hostile melee on a player). The comment there, "no aura ever buffs a player's defence", is now false.
- Modify: `backend/src/authority/projectiles.js:22` (import), `:142-143` (`applyPlayerAugment`), `:426` (AoE on player), `:598` (direct hit on player)
- Modify: `backend/src/authority/world.js:2` (import), `:537` (burn on a player), `:1123` and `:1138-1139` (PvP)
- Test: `backend/tests/enemy_aura_defense.test.js` (create)

**Interfaces:** consumes `effectiveMit` (exported in Task 1). `effectiveMit(p)` with `p._buff` unset or `NO_BUFF` returns `p.mit || NO_MITIGATION` unchanged (`creatures.js:1202-1207`), so every existing fixture is byte-identical.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/enemy_aura_defense.test.js
// SOMET-606. A defense debuff must reach EVERY way a player takes damage --
// a creature bite AND a creature projectile (projectiles.js read pl.mit
// directly at three sites). The source guard stops a new site reading p.mit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CreatureSim } = require('../src/authority/creatures.js');
const { ProjectileSim } = require('../src/authority/projectiles.js');

const stubMap = () => ({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 });
const ACTIVE = new Set(['0,0', '0,1', '1,0', '1,1']);
function hold() {
  return { name: 'T', aggroRadius: 0, leashRadius: 800, chaseStyle: 'hold', preferredRange: 0,
    moveSpeedMult: 1, damageOverride: null, goldMin: 0, goldMax: 0,
    abilities: [{ slot: 1, name: 'Attack', attackKind: 'melee', attackRange: 60, attackCooldown: 1,
      projectileSpeed: 0, projectileRadius: 0, element: null, damageMult: 1, knockback: 0 }] };
}
const dread = { name: 'dread', targetSide: 'enemies', radius: 400, damageMult: 1, defenseMult: 0.5,
  speedMult: 1, dotDps: 0, dotElement: 'physical', tickMs: 1000 };

test('a bite on a defense-debuffed player uses the debuffed defense (5 - 4*0.5 = 3)', () => {
  for (const [auras, expected] of [[[dread], 97], [[], 99]]) {
    const s = new CreatureSim(stubMap(), () => 0.5);
    s.addCreatures([
      { id: 'L', type: 'T', x: 100, y: 100, hp: 100, faction: 'hostile', behavior: hold(), auras },
      { id: 'F', type: 'T', x: 100, y: 100, hp: 100, faction: 'hostile', damage: 5 },
    ]);
    const p = { userId: 'u1', x: 120, y: 100, width: 64, height: 64, hp: 100, maxHp: 100,
      mit: { defense: 4, resistances: {} } };
    s.tick(0.05, ACTIVE, [p], 0);
    assert.equal(p.hp, expected, `auras=${auras.length}`);
  }
});

test('a creature projectile on a defense-debuffed player uses the debuffed defense', () => {
  const ps = new ProjectileSim();
  ps.spawn({ ownerId: 'c1', ownerKind: 'creature', ownerFaction: 'hostile', ownerType: 'T',
    x: 0, y: 32, nx: 1, ny: 0, damage: 10,
    weapon: { projectile_speed: 1000, projectile_radius: 8, range: 500, pierce: 1, aoe_radius: 0, element: null, damage: 10 } });
  const p = { userId: 'u1', x: 40, y: 0, width: 64, height: 64, hp: 100, maxHp: 100,
    mit: { defense: 4, resistances: {} }, _buff: { damageMult: 1, defenseMult: 0.5, speedMult: 1, auras: [] } };
  for (let i = 0; i < 10 && p.hp === 100; i++) {
    ps.step(0.05, { map: stubMap(), creatures: new CreatureSim(stubMap(), () => 0.5), players: [p], now: 0 });
  }
  assert.equal(p.hp, 100 - (10 - 4 * 0.5));
});

test('source guard: no player damage site reads `.mit || NO_MITIGATION` directly', () => {
  const dir = path.join(__dirname, '..', 'src', 'authority');
  const offenders = [];
  for (const f of ['creatures.js', 'projectiles.js', 'world.js']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/\b(tp|pl|t|other|p)\.mit\s*\|\|\s*NO_MITIGATION/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'route through effectiveMit()');
});
```

`ProjectileSim.step(dt, { creatures, players, map, now })` (`projectiles.js:460`) takes the same context `World.tickProjectiles` builds (`world.js:1594-1600`). If the spawn fields above are short of what `spawn` needs for a creature-owned shot (compare `World.tickCreatures`, `world.js:722-748`), add fields. Do not change the assertion.

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `cd $WT/backend && node --test tests/enemy_aura_defense.test.js; echo "exit=$?"`
Expected: the bite test fails with `99 !== 97` (`creatures.js:2182` reads `tp.mit`). The projectile test fails with `94 !== 92`. The source guard lists 7 offenders (`creatures.js:2182`, `projectiles.js:143,426,598`, `world.js:537,1123,1139`).

- [ ] **Step 3: Implement**

`creatures.js:2179-2182` becomes:

```js
            // SOMET-606: tp is a PLAYER, and an enemy aura CAN lower a player's
            // defence now -- effectiveMit reads tp._buff exactly as it does a
            // creature's, so this is the same one defence read as the three
            // creature-target sites.
            applyDamageWithEffects(tp, dmg, 'physical', effectiveMit(tp), now, creatureKey(c.id));
```

`projectiles.js:22`: `const { shoveCreature, immuneToPlayerDamage, effectiveMit } = require('./creatures');`. Then at `:143`, `:426` and `:598` replace `pl.mit || NO_MITIGATION` with `effectiveMit(pl)`. If `NO_MITIGATION` is then unused in the file, drop it from the `damage` import at `:9-10`.

`world.js:2`: `const { CreatureSim, CREATURE_SIZE, shoveCreature, effectiveMit, NO_BUFF } = require('./creatures');`. At `:537` replace `t.mit || NO_MITIGATION` with `effectiveMit(t)`, at `:1123` `other.mit || NO_MITIGATION` with `effectiveMit(other)`, and at `:1139` `other.mit || NO_MITIGATION` with `effectiveMit(other)`.

- [ ] **Step 4: Run it and confirm it PASSES, along with the combat suites**

```bash
cd $WT/backend && node --test tests/enemy_aura_defense.test.js tests/authority_world_combat.test.js tests/authority_creature_auras.test.js tests/champion_aura_golden.test.js tests/authority_sfx_frame.test.js $(ls tests/*projectile*.test.js); echo "exit=$?"
```
Expected: `exit=0`.

- [ ] **Step 5: Commit**

```bash
git -C $WT add backend/src/authority/creatures.js backend/src/authority/projectiles.js backend/src/authority/world.js backend/tests/enemy_aura_defense.test.js
git -C $WT commit -m "feat(auras): every player damage-taken site reads effectiveMit so defense debuffs land (SOMET-606)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Player speed and outgoing damage read the debuff

**Files:**
- Modify: `backend/src/authority/world.js`. Add `playerSpeedMult` and `auraDamageMult` near `weaponDamage` (`:88`). `weaponDamage` returns at `:101`. Skill damage is at `:1403`. Add a line after `stepEffects(p, ...)` in `tick()` (`:532-539`). Add exports at the end of the file.
- Test: `backend/tests/enemy_aura_player_stats.test.js` (create)

**Interfaces:**
- Produces: `playerSpeedMult(p, now) = (chill magnitude || 1) * (p._buff || NO_BUFF).speedMult`. This is the ONE definition, read by `tick()` (movement) and by `selfAuraFields` (Task 5, wire), so the client is told exactly the factor the server moves with. `auraDamageMult(p) = (p._buff || NO_BUFF).damageMult`.
- Timing: `CreatureSim.tick` runs after `World.tick` in the server loop (`server.js:3068` then `:3262`), so a debuff stamped in tick N slows movement from tick N+1. That is one tick (50 ms) of lag, which is accepted (decision D6).

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/enemy_aura_player_stats.test.js
// SOMET-606. A debuffed player walks slower and hits softer, and two
// overlapping auras respect the 0.5 floor in a REAL movement distance.
const test = require('node:test');
const assert = require('node:assert/strict');
const { World, weaponDamage } = require('../src/authority/world.js');

const map = () => ({ chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] });
const FROZEN = new Set();
const A = (name, over) => ({ name, targetSide: 'enemies', radius: 2000, damageMult: 1, defenseMult: 1,
  speedMult: 1, dotDps: 0, dotElement: 'physical', tickMs: 1000, ...over });

// Walk east for 1 s at 20 Hz; return the x distance covered.
function walk(auras) {
  const w = new World(map(), new Map(), null);
  w.addPlayer('u1', { x: 0, y: 0 });
  if (auras.length) w.creatures.addCreatures([{ id: 'S', type: 'T', x: 400, y: 400, hp: 100, faction: 'hostile', auras }]);
  w.tickCreatures(0.05, FROZEN);                 // stamp the debuff first
  const p = w.getPlayer('u1');
  const x0 = p.x;
  for (let i = 0; i < 20; i++) {
    w.setInput('u1', i + 1, 1, 0);
    w.tick(0.05);
    w.tickCreatures(0.05, FROZEN);
  }
  return p.x - x0;
}

test('no aura: 200 px/s (PLAYER_SPEED baseline, literal)', () => {
  assert.ok(Math.abs(walk([]) - 200) < 1e-6);
});

test('speed 0.6 aura: 120 px/s', () => {
  assert.ok(Math.abs(walk([A('mire', { speedMult: 0.6 })]) - 120) < 1e-6);
});

test('two different 0.6 auras: floored at 0.5 -> 100 px/s, not 72', () => {
  assert.ok(Math.abs(walk([A('mire', { speedMult: 0.6 }), A('dread', { speedMult: 0.6 })]) - 100) < 1e-6);
});

test('leaving the aura restores full speed on the next tick', () => {
  const w = new World(map(), new Map(), null);
  w.addPlayer('u1', { x: 0, y: 0 });
  w.creatures.addCreatures([{ id: 'S', type: 'T', x: 0, y: 0, hp: 100, faction: 'hostile', auras: [A('mire', { radius: 300, speedMult: 0.5 })] }]);
  w.tickCreatures(0.05, FROZEN);
  const p = w.getPlayer('u1');
  p.x = 5000;
  w.tickCreatures(0.05, FROZEN);                 // out of range now
  const x0 = p.x;
  w.setInput('u1', 1, 1, 0); w.tick(0.05);
  assert.ok(Math.abs(p.x - x0 - 10) < 1e-6, `moved ${p.x - x0}, expected 10 (200 * 0.05)`);
});

test('weaponDamage scales by the damage debuff', () => {
  const p = { stats: { meleeMult: 1, spellMult: 1, damageMult: null, rules: {} }, _buff: { damageMult: 0.7, defenseMult: 1, speedMult: 1, auras: [] } };
  const w = { kind: 'melee', damage: 10, element: null };
  assert.ok(Math.abs(weaponDamage(p, w) - 7) < 1e-9);
  delete p._buff;
  assert.equal(weaponDamage(p, w), 10, 'no _buff -> unchanged');
});

test('chill and an aura compose multiplicatively in the same speed read', () => {
  const { playerSpeedMult } = require('../src/authority/world.js');
  const { applyElementEffect } = require('../src/authority/effects.js');
  const p = { effects: new Map(), _buff: { damageMult: 1, defenseMult: 1, speedMult: 0.8, auras: [] } };
  assert.equal(playerSpeedMult(p, 0), 0.8);
  applyElementEffect(p, 'ice', 0, null);
  const chilled = playerSpeedMult(p, 1);
  assert.ok(chilled < 0.8 && chilled > 0, `chill must slow further: ${chilled}`);
});
```

Also add a skill-damage case. Before writing it, read `castSkill` (`world.js:1325-1420`) for the smallest skill id that deals radial damage to a creature next to the player (`authority_world.test.js` / `authority_world_combat.test.js` already cast skills; reuse that fixture). Then assert that the creature's hp loss with `_buff.damageMult = 0.5` equals `Math.max(2, Math.round(D * 0.5))`, where `D` is the hp loss measured in the same test without the buff. Measure first, then assert. Do not hardcode `D`.

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `cd $WT/backend && node --test tests/enemy_aura_player_stats.test.js; echo "exit=$?"`
Expected: `exit=1`. The 0.6 walk returns 200 (`AssertionError ... false`), `weaponDamage` returns 10, not 7, and `playerSpeedMult` is not exported (`TypeError`).

- [ ] **Step 3: Implement.** In `world.js`, directly above `weaponDamage` (`:80`):

```js
// SOMET-606 (S4). The enemy-aura debuff a player is living with this tick,
// stamped by CreatureSim.tick (p._buff, the same field and the same NO_BUFF
// default creatures use). Two readers, ONE definition each:
//  - playerSpeedMult: chill x aura. tick() moves with it and selfAuraFields
//    sends it to the owning client, which predicts with it -- two copies is
//    how prediction and authority drift into a rubber-band.
//  - auraDamageMult: every outgoing player damage number (weaponDamage, skills).
function playerSpeedMult(p, now) {
  const chill = effectMagnitude(p, CHILL, now);
  return (chill || 1) * (p._buff || NO_BUFF).speedMult;
}
function auraDamageMult(p) {
  return (p._buff || NO_BUFF).damageMult;
}
```

`weaponDamage` (`:101`) becomes:

```js
  return w.damage * mult * elementDamageMult(p.stats, w.element) * shape * auraDamageMult(p);
```

Skill damage (`:1403`):

```js
    const damage = Math.max(2, Math.round(baseDamage * baseMult * elemMult * auraDamageMult(p)));
```

In `tick()`, inside the players' effects loop, directly after the `stepEffects(p, ...)` call closes (`:539`):

```js
      // SOMET-606: stepEffects set speed = base x chill; fold in the enemy-aura
      // slow from the SAME function the client is told about. Recomputed from
      // baseSpeed every tick, so it can never compound.
      p.speed = p.baseSpeed * playerSpeedMult(p, this.now);
```

Exports: add `playerSpeedMult, auraDamageMult` to `module.exports`.

- [ ] **Step 4: Run it and confirm it PASSES, plus the player-stat suites**

```bash
cd $WT/backend && node --test tests/enemy_aura_player_stats.test.js tests/authority_player_stats.test.js tests/authority_world.test.js tests/authority_world_combat.test.js tests/player_stats.test.js; echo "exit=$?"
```
Expected: `exit=0`. If a chill test in `authority_world*.test.js` asserts `p.speed`, it must stay green, because with `_buff` unset the new line reproduces `base * chill` exactly.

- [ ] **Step 5: Commit**

```bash
git -C $WT add backend/src/authority/world.js backend/tests/enemy_aura_player_stats.test.js
git -C $WT commit -m "feat(auras): enemy-aura debuff slows player movement and scales outgoing damage (SOMET-606)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The wire: creature aura names once, own debuffs and speed to the owner only

**Files:**
- Modify: `backend/src/authority/creatures.js:2670-2678` (`snapshotAOI` intro)
- Modify: `backend/src/authority/world.js` (new `selfAuraFields`, exported)
- Modify: `backend/src/authority/server.js:3397` (inside the per-socket loop, after `const frame = {...}`)
- Test: `backend/tests/enemy_aura_wire.test.js` (create)

**Interfaces (wire contract, consumed by Task 7):**
- Creature intro record (only when the creature has auras): `auras: string[]`, the aura NAMES, both sides. They are immutable for the instance's life (resolved at load, spec §3.2), so they follow the `bossTier` "once" rule (`creatures.js:2673-2677`). The consumer is S5 (aura rings/sound). S4 only delivers and merges them.
- `state` frame, own socket only:
  - `debuffs: [{ n, d, f, s, dps?, el? }]`: per aura name, the pre-floor `damageMult`/`defenseMult`/`speedMult`. `dps`/`el` are present only for a DoT. The field is omitted when there are none.
  - `speedMult: number`: `playerSpeedMult(p, now)`, omitted when exactly 1.
  - Not on `players[]` rows. Those rows are shared by reference with every nearby recipient (`server.js:3355-3362`, `playersNear`). Another player's debuffs have no consumer (S5 draws the aura ring from the creature, and remote players are position-interpolated, so their slowdown already shows). Sending them would put per-player bytes into every recipient's frame (decision D7).

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/enemy_aura_wire.test.js
// SOMET-606. What reaches the client: creature aura names ONCE (intro), and
// the owner's debuffs + effective speed on its OWN frame only. The socket test
// is the anti-"field lost on a named list" guard (server.js builds the frame
// from a named field list, SOMET-528).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { CreatureSim } = require('../src/authority/creatures.js');
const { selfAuraFields } = require('../src/authority/world.js');
const { attachAuthority } = require('../src/authority/server.js');

const stubMap = () => ({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 });
const mire = { name: 'mire', targetSide: 'enemies', radius: 300, damageMult: 0.8, defenseMult: 1,
  speedMult: 0.6, dotDps: 4, dotElement: 'fire', tickMs: 1000 };

test('snapshotAOI: aura names in the intro only, never on an ordinary creature', () => {
  const s = new CreatureSim(stubMap(), () => 0.5);
  s.addCreatures([
    { id: 'A', type: 'T', x: 0, y: 0, hp: 9, faction: 'hostile', auras: [mire] },
    { id: 'W', type: 'Wolf', x: 0, y: 0, hp: 9, faction: 'hostile' },
  ]);
  const known = new Set();
  const keys = [...new Set(s.all().map(() => '0,0'))];
  const first = s.snapshotAOI(keys, 0, 0, 0, 2000, known);
  assert.deepEqual(first.find((r) => r.id === 'A').auras, ['mire']);
  assert.equal('auras' in first.find((r) => r.id === 'W'), false);
  const second = s.snapshotAOI(keys, 0, 0, 0, 2000, known);
  assert.equal('auras' in second.find((r) => r.id === 'A'), false, 'immutable: sent once');
});

test('selfAuraFields: debuffs + speedMult when debuffed, {} when clear', () => {
  const p = { effects: new Map(), _buff: { damageMult: 0.8, defenseMult: 1, speedMult: 0.6,
    auras: [{ name: 'mire', damageMult: 0.8, defenseMult: 1, speedMult: 0.6, dotDps: 4, dotElement: 'fire', tickMs: 1000, sourceId: 'A' }] } };
  assert.deepEqual(selfAuraFields(p, 0), {
    debuffs: [{ n: 'mire', d: 0.8, f: 1, s: 0.6, dps: 4, el: 'fire' }], speedMult: 0.6 });
  assert.deepEqual(selfAuraFields({ effects: new Map() }, 0), {});
});

// -- Real socket. Fake pool copied from authority_sfx_frame.test.js; the
// creature row carries the loader's aura_names/aura_defs shape.
const SECRET = 'test-secret';
function fakePool() {
  const pool = { query: async (sql, params) => {
    if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]), entity_type_id: 1 }] };
    if (/FROM worlds w WHERE w\.id/i.test(sql)) return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
    if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
    if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
    if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
    if (/FROM item_types/i.test(sql)) return { rows: [] };
    if (/FROM world_creatures/i.test(sql) && !/DELETE/i.test(sql)) {
      if (params[1] === 0) return { rows: [{ id: 'blighter', type: 'Wolf', x: 410, y: 400, hp: 50, facing: 'S', color: '#c00',
        faction: 'hostile', aura_names: ['mire'],
        aura_defs: [{ name: 'mire', target_side: 'enemies', radius: 2000, damage_mult: 0.8, defense_mult: 1,
          speed_mult: 0.6, dot_dps: 0, dot_element: 'physical', tick_ms: 1000 }] }] };
      return { rows: [] };
    }
    return { rows: [] };
  } };
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  return pool;
}
const token = (u) => jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' });
function boot() {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, fakePool(), { jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 10000 });
    server.listen(0, () => resolve({ url: `ws://127.0.0.1:${server.address().port}/authority`, handle, server }));
  });
}
function nextMsg(ws, type) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout ${type}`)), 3000);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (!type || m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

test('wire: the owner\'s own state frame carries debuffs + speedMult; the shared player row does not', async () => {
  const { url, handle, server } = await boot();
  const ws = new WebSocket(`${url}?token=${encodeURIComponent(token(1))}`);
  try {
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
    await nextMsg(ws, 'joined');
    let intro = null;
    for (let i = 0; i < 20 && !intro; i++) {
      const m = await nextMsg(ws, 'creatures');
      intro = m.creatures.find((c) => c.id === 'blighter' && c.auras) || null;
    }
    assert.ok(intro, 'precondition: the aura creature loaded and was introduced');
    assert.deepEqual(intro.auras, ['mire']);
    let s = null;
    for (let i = 0; i < 40 && !(s && s.debuffs); i++) s = await nextMsg(ws, 'state');
    assert.ok(s.debuffs, 'debuffs reached the frame');
    assert.deepEqual(s.debuffs.map((d) => d.n), ['mire']);
    assert.equal(s.debuffs[0].s, 0.6);
    assert.equal(s.speedMult, 0.6);
    const row = s.players.find((p) => String(p.id) === '1');
    assert.ok(row, 'own row present');
    assert.equal('debuffs' in row, false, 'never on the shared row');
  } finally {
    ws.close(); handle.close(); server.close();
  }
});
```

If the hydration in `server.js` needs more columns from the creature row (compare `CREATURE_JOINED_SELECT` and `toSimCreature`), add them to the fake row until the "precondition" assertion passes. Never weaken the precondition (memory: geometry-constants-disarm-tests).

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `cd $WT/backend && node --test tests/enemy_aura_wire.test.js; echo "exit=$?"`
Expected: `exit=1`. The intro has no `auras` (`undefined` vs `['mire']`), `selfAuraFields` is not a function, and the wire test fails at "the aura creature loaded and was introduced" or at "debuffs reached the frame".

- [ ] **Step 3: Implement**

`creatures.js` `snapshotAOI`, inside `if (!known.has(c.id)) {`, after the `c.width` line (`:2677`):

```js
        // SOMET-606: aura NAMES, immutable for this instance (resolved at load).
        // Sent once like bossTier; absent on a creature with none, so an
        // ordinary intro stays byte-identical.
        if (Array.isArray(c.auras) && c.auras.length > 0) row.auras = c.auras.map((a) => a.name);
```

`world.js`, after `auraDamageMult` (Task 4):

```js
// SOMET-606. The OWNER's aura state for its own `state` frame (server.js adds
// it per socket). Never on the shared players[] rows: those go to every nearby
// recipient by reference, and nobody but the owner has a use for them.
// {} when clear, so a quiet frame costs no bytes and the client clears.
function selfAuraFields(p, now) {
  const out = {};
  const b = p._buff;
  if (b && Array.isArray(b.auras) && b.auras.length > 0) {
    out.debuffs = b.auras.map((a) => (a.dotDps > 0
      ? { n: a.name, d: a.damageMult, f: a.defenseMult, s: a.speedMult, dps: a.dotDps, el: a.dotElement }
      : { n: a.name, d: a.damageMult, f: a.defenseMult, s: a.speedMult }));
  }
  const sm = playerSpeedMult(p, now);
  if (sm !== 1) out.speedMult = sm;
  return out;
}
```

Export `selfAuraFields`. In `server.js`, import it next to the other `world.js` imports. Directly after `const frame = { type: 'state', tick, ackSeq: ..., players, projectiles: snap.projectiles };` (`:3397`):

```js
        // SOMET-606: the owner's debuffs + effective speed. Per socket, never on
        // the shared rows; {} for a clear player, so nothing is added.
        if (p) Object.assign(frame, selfAuraFields(p, entry.world.now));
```

- [ ] **Step 4: Run it and confirm it PASSES, plus the wire suites**

```bash
cd $WT/backend && node --test tests/enemy_aura_wire.test.js tests/authority_boss_snapshot.test.js tests/authority_sfx_frame.test.js tests/authority_server.test.js; echo "exit=$?"
```
Expected: `exit=0` (if `authority_server` shows only a `refreshPlayerStats` failure, re-run that file once, per SOMET-619).

- [ ] **Step 5: Commit**

```bash
git -C $WT add backend/src/authority/creatures.js backend/src/authority/world.js backend/src/authority/server.js backend/tests/enemy_aura_wire.test.js
git -C $WT commit -m "feat(auras): send creature aura names once and the owner's debuffs and speed on its own frame (SOMET-606)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Perf: scratch reuse (always on) and the enemy row in creature_tick_cost (gated)

**Files:**
- Test: `backend/tests/enemy_aura_scratch.test.js` (create)
- Modify: `backend/tests/creature_tick_cost.test.js` (new `RUN` block at the end)

**Interfaces:** consumes `__enemyAuraScratchGrowths` (Task 1).

**Cap decision (spec §4.2 "S4 decides"): no cap.** The pass costs O(enemy sources × players in the world). Players per world are tens, while the allies pass is O(sources × creatures) with creatures in the thousands. The added full scan over creatures for enemy sources is one `auras.length` check per creature, the same cheap early-out the allies pass already pays. The gated row below is the number SOMET-613 tunes against.

- [ ] **Step 1: Write the tests**

```js
// backend/tests/enemy_aura_scratch.test.js
// SOMET-606 / SOMET-617 rule: the enemies pass reuses its scratch buffers --
// steady-state ticks of the same size allocate no new typed arrays. A version
// that builds `new Float64Array` per call fails the second assertion.
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyEnemyAuras, __enemyAuraScratchGrowths } = require('../src/authority/creatures.js');

test('steady-state calls never regrow the scratch buffers', () => {
  const creatures = [];
  for (let i = 0; i < 50; i++) {
    creatures.push({ id: `c${i}`, x: i * 20, y: 0, width: 48, height: 48, hp: 10, faction: 'hostile',
      auras: [{ name: i % 2 ? 'mire' : 'dread', targetSide: 'enemies', radius: 400, damageMult: 0.9,
        defenseMult: 0.9, speedMult: 0.9, dotDps: 1, dotElement: 'fire', tickMs: 1000 }] });
  }
  const players = Array.from({ length: 20 }, (_, k) => ({ userId: `u${k}`, x: k * 30, y: 0, width: 64, height: 64, hp: 100 }));
  applyEnemyAuras(creatures, players);           // sizes the scratch
  const before = __enemyAuraScratchGrowths();
  for (let t = 0; t < 500; t++) applyEnemyAuras(creatures, players);
  assert.equal(__enemyAuraScratchGrowths(), before);
  assert.ok(applyEnemyAuras(creatures, players).size === 20, 'anti-vacuity: every player debuffed');
});
```

Append to `creature_tick_cost.test.js`:

```js
// SOMET-606 (S4): the enemies-side pass. 6 hostile sources carrying a 400px
// enemies aura WITH a DoT, 20 players standing inside them (a raid on a boss),
// on top of the 4500/6 population that gates MAX_WORLD_CREATURES. Asserted
// against the same 8ms half-budget as the leaders<=6 rows above -- the
// enemy pass is O(sources x players), so it must not move this row.
RUN('tick cost with 20 players inside enemy auras', () => {
  const active = activeKeys();
  const sim = buildSim(4500, 6);
  let tagged = 0;
  for (const c of sim.creatures.values()) {
    if (tagged >= 6) break;
    if (c.auras && c.auras.length) continue;      // not one of the ally leaders
    c.auras = [{ name: 'blight', targetSide: 'enemies', radius: 400, damageMult: 0.8, defenseMult: 0.8,
      speedMult: 0.7, dotDps: 0.001, dotElement: 'fire', tickMs: 1000 }];
    tagged++;
  }
  const first = [...sim.creatures.values()].filter((c) => c.auras && c.auras.some((a) => a.targetSide === 'enemies'));
  if (first.length !== 6) throw new Error(`fixture built ${first.length} enemy sources, expected 6`);
  const players = [];
  for (let k = 0; k < 20; k++) {
    const s = first[k % 6];
    players.push({ userId: `u${k}`, x: s.x + 20 + k, y: s.y, width: 64, height: 64, hp: 1e9, maxHp: 1e9, mit: null });
  }
  for (let i = 0; i < 20; i++) sim.tick(1 / 60, active, players, i * 16);
  if (!players.every((p) => p._buff && p._buff.auras)) throw new Error('fixture: players are not inside the enemy auras');
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 120; i++) sim.tick(1 / 60, active, players, (20 + i) * 16);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 120;
  console.log(`[tick] 4500 creatures / 6 leaders / 6 enemy sources / 20 players inside: ${ms.toFixed(3)} ms/tick`);
  assert.ok(ms < 8, `${ms.toFixed(3)} ms/tick, over the 8ms half-budget`);
});
```

- [ ] **Step 2: Show the scratch guard can fail.** Temporarily change `enemyScratch` so the first `if` reads `if (true)`, run `node --test tests/enemy_aura_scratch.test.js`, expect `AssertionError` on the growth count, then revert.

- [ ] **Step 3: Run it**

```bash
cd $WT/backend && node --test tests/enemy_aura_scratch.test.js; echo "exit=$?"
MEASURE_TICK=1 node --test tests/creature_tick_cost.test.js; echo "exit=$?"
```
Expected: `exit=0` for both. Record the printed ms/tick for the 4500/6 baseline row and the new row in the Plane evidence comment. If the new row is more than 1 ms above the 4500/6 row, profile `applyEnemyAuras` before continuing. The likely culprit is an allocation that crept into the inner loop.

- [ ] **Step 4: Commit**

```bash
git -C $WT add backend/tests/enemy_aura_scratch.test.js backend/tests/creature_tick_cost.test.js
git -C $WT commit -m "test(auras): pin enemy-aura scratch reuse and measure the enemies pass in creature_tick_cost (SOMET-606)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Client: HUD debuff icons, slowed prediction, creature aura names

**Files:**
- Create: `frontend/src/games/something2/src/js/core/auraDebuffs.js`
- Create: `frontend/src/games/something2/src/js/core/__tests__/auraDebuffs.test.js`
- Modify: `frontend/src/games/something2/src/js/entities/Player.js:83`
- Create: `frontend/src/games/something2/src/js/entities/Player.auraSpeed.test.js`
- Modify: `frontend/src/games/something2/src/js/entities/CreatureManager.js:86-100`
- Create: `frontend/src/games/something2/src/js/entities/__tests__/CreatureManager.auras.test.js`
- Modify: `frontend/src/games/something2/src/js/core/Game.js`: import (near `:17`), `_onWorldState` (after `:1507`), reconcile dims (`:1528`), render args (`:1728`)
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js:4310-4392` (`_drawActiveBuffs`)
- Create: `frontend/src/games/something2/src/js/core/__tests__/gameAuraWiring.test.js`

**Interfaces:**
- Consumes the Task 5 wire: `msg.debuffs`, `msg.speedMult`, and the creature intro `auras`.
- Produces: `selfSpeedMult(msg): number` (1 unless a finite positive `speedMult`). `debuffHudEntries(debuffs): HudEntry[]`, where `HudEntry = { id: 'aura:<name>', nameEn, icon, iconColor, persistent: true, detail }`. This is the same shape `_drawActiveBuffs` already reads (`id, nameEn, icon, iconColor`; Game.js `:2525-2534`), plus `persistent` and `detail`.
- HUD reuse: the existing buff panel is `RenderSystem._drawActiveBuffs` (`:4310`), fed by `Game.activeBuffs` (`:1728`), which holds the client-side skill buffs (`:2522-2534`). Victor's Boon has a catalog entry (`statusEffects.js:39`) but no consumer on the client, and the server's `out.buffs` (`world.js:1678-1688`) is never read by `Game.js`. So the reusable surface is `_drawActiveBuffs`, and debuffs are appended to its list as persistent rows.

- [ ] **Step 1: Write the failing tests**

```js
// frontend/src/games/something2/src/js/core/__tests__/auraDebuffs.test.js
import { describe, it, expect } from "vitest";
import { selfSpeedMult, debuffHudEntries, prettyAuraName } from "../auraDebuffs.js";

describe("selfSpeedMult (SOMET-606)", () => {
  it("reads a finite positive speedMult, else 1", () => {
    expect(selfSpeedMult({ speedMult: 0.6 })).toBe(0.6);
    expect(selfSpeedMult({})).toBe(1);
    expect(selfSpeedMult({ speedMult: 0 })).toBe(1);
    expect(selfSpeedMult({ speedMult: NaN })).toBe(1);
    expect(selfSpeedMult(null)).toBe(1);
  });
});

describe("debuffHudEntries (SOMET-606)", () => {
  it("one persistent HUD row per aura, with what it does", () => {
    const rows = debuffHudEntries([
      { n: "blight_field", d: 0.8, f: 1, s: 0.6, dps: 4, el: "fire" },
      { n: "dread", d: 1, f: 0.7, s: 1 },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["aura:blight_field", "aura:dread"]);
    expect(rows[0].nameEn).toBe("Blight Field");
    expect(rows[0].persistent).toBe(true);
    expect(rows[0].detail).toBe("-40% spd -20% dmg 4 fire/s");
    expect(rows[1].detail).toBe("-30% def");
    expect(rows[0].icon).toBe("🔥");
    expect(rows[1].icon).toBe("☠️");
  });
  it("empty / missing -> []", () => {
    expect(debuffHudEntries(undefined)).toEqual([]);
    expect(debuffHudEntries([])).toEqual([]);
  });
  it("prettyAuraName title-cases snake case", () => {
    expect(prettyAuraName("pack_leader")).toBe("Pack Leader");
  });
});
```

```js
// frontend/src/games/something2/src/js/entities/Player.auraSpeed.test.js
import { describe, it, expect } from "vitest";
import { Player } from "./Player.js";

// SOMET-606: local prediction must move at the server's slowed rate, or the
// reconcile snaps the player back every frame.
const openMap = { isWalkable: () => true, speedAt: () => 1 };
describe("Player.update with an aura slow", () => {
  it("a 0.6 auraSpeedMult moves 0.6x as far as none", () => {
    const a = new Player(); a.x = 0; a.y = 0;
    a.update(0.05, { d: true }, openMap, false);
    const b = new Player(); b.x = 0; b.y = 0; b.auraSpeedMult = 0.6;
    b.update(0.05, { d: true }, openMap, false);
    expect(a.x).toBeGreaterThan(0);
    expect(b.x).toBeCloseTo(a.x * 0.6, 6);
  });
});
```

```js
// frontend/src/games/something2/src/js/entities/__tests__/CreatureManager.auras.test.js
import { describe, it, expect } from "vitest";
import { CreatureManager } from "../CreatureManager.js";

describe("CreatureManager aura names (SOMET-606)", () => {
  it("keeps intro aura names across frames that omit them", () => {
    const cm = new CreatureManager(null);
    cm.applySnapshot([{ id: "a", type: "T", x: 0, y: 0, hp: 9, maxHp: 9, auras: ["mire"] }]);
    cm.applySnapshot([{ id: "a", x: 1, y: 1, hp: 8, facing: "S", mode: "idle" }]);
    expect(cm.all()[0].auras).toEqual(["mire"]);
  });
  it("an ordinary creature has auras null", () => {
    const cm = new CreatureManager(null);
    cm.applySnapshot([{ id: "w", type: "Wolf", x: 0, y: 0, hp: 5, maxHp: 5 }]);
    expect(cm.all()[0].auras).toBe(null);
  });
});
```

```js
// frontend/src/games/something2/src/js/core/__tests__/gameAuraWiring.test.js
// Source gate (vitest is node-env, Game.js needs a canvas). It cannot prove the
// path RUNS -- Task 8's browser pass does -- but it fails if a consumer is
// dropped. Each regex names the exact consumer, not just the import.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.join(__dirname, "..", "Game.js"), "utf8");
describe("Game.js aura wiring (SOMET-606)", () => {
  it("reconcile predicts with the server speed multiplier", () => {
    expect(src).toMatch(/speed:\s*PLAYER_SPEED_EFFECTIVE\s*\*\s*this\.selfSpeedMult/);
  });
  it("the local player predicts with it too, assigned every frame", () => {
    expect(src).toMatch(/this\.player\.auraSpeedMult\s*=\s*this\.selfSpeedMult/);
    expect(src).toMatch(/this\.selfSpeedMult\s*=\s*selfSpeedMult\(msg\)/);
  });
  it("HUD rows are rebuilt every frame and passed to the renderer", () => {
    expect(src).toMatch(/this\.auraDebuffRows\s*=\s*debuffHudEntries\(msg\.debuffs\)/);
    expect(src).toMatch(/activeBuffs:\s*\[[^\]]*\.\.\.this\.auraDebuffRows/);
  });
});
```

- [ ] **Step 2: Run them and confirm they FAIL**

```bash
cd $WT/frontend && npx vitest run src/games/something2/src/js/core/__tests__/auraDebuffs.test.js src/games/something2/src/js/entities/Player.auraSpeed.test.js src/games/something2/src/js/entities/__tests__/CreatureManager.auras.test.js src/games/something2/src/js/core/__tests__/gameAuraWiring.test.js; echo "exit=$?"
```
Expected: `exit=1`. `auraDebuffs.js` fails to resolve, the speed test gives `b.x ≈ a.x` (not 0.6×), `auras` is `undefined` rather than `['mire']`/`null`, and all three wiring regexes miss.

- [ ] **Step 3: Implement**

```js
// frontend/src/games/something2/src/js/core/auraDebuffs.js
// SOMET-606 (S4). Client reading of the OWN state frame's aura fields
// (backend world.js selfAuraFields). Pure and canvas-free so vitest can pin it;
// Game.js assigns the results every frame (the server omits both fields when
// clear, so a guarded assignment would leave a stale slow / stale icon).
import { elementColor } from "./blasts.js";

const DOT_ICON = { fire: "🔥", ice: "❄️", lightning: "⚡", arcane: "🔮", physical: "🩸" };

export function selfSpeedMult(msg) {
  const v = msg && msg.speedMult;
  return Number.isFinite(v) && v > 0 ? v : 1;
}

export function prettyAuraName(name) {
  return String(name || "")
    .split(/[_\s]+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

const pct = (m) => Math.round((1 - m) * 100);

export function debuffHudEntries(debuffs) {
  if (!Array.isArray(debuffs) || debuffs.length === 0) return [];
  return debuffs.map((d) => {
    const parts = [];
    if (d.s < 1) parts.push(`-${pct(d.s)}% spd`);
    if (d.d < 1) parts.push(`-${pct(d.d)}% dmg`);
    if (d.f < 1) parts.push(`-${pct(d.f)}% def`);
    if (d.dps > 0) parts.push(`${Math.round(d.dps * 10) / 10} ${d.el || "physical"}/s`);
    return {
      id: `aura:${d.n}`,
      nameEn: prettyAuraName(d.n),
      icon: d.dps > 0 ? (DOT_ICON[d.el] || "🩸") : "☠️",
      iconColor: d.dps > 0 ? elementColor(d.el || "physical") : "#a855f7",
      persistent: true,
      detail: parts.join(" "),
    };
  });
}
```

`Player.js:83`:

```js
        // SOMET-606: the server's enemy-aura (x chill) multiplier, from the own
        // state frame -- predicting at full speed while the server slows us is
        // a snap-back every frame.
        const speed = this.speed * (this.speedMultiplier || 1) * (this.auraSpeedMult || 1);
```

`CreatureManager.js`: in the merge branch after `if (c.name !== undefined) ex.name = c.name;` (`:88`) add `if (c.auras !== undefined) ex.auras = c.auras;`. In the new-creature object after `element: c.element ?? null,` (`:100`) add `auras: c.auras ?? null,`.

`Game.js`: add the import `import { selfSpeedMult, debuffHudEntries } from "./auraDebuffs.js";` near `:17`. In `_onWorldState`, directly after `this.player.effects = mine.effects || null;` (`:1507`):

```js
            // SOMET-606. Both assigned EVERY frame (the server omits them when
            // clear -- same reason as `effects` above).
            this.selfSpeedMult = selfSpeedMult(msg);
            this.player.auraSpeedMult = this.selfSpeedMult;
            this.auraDebuffRows = debuffHudEntries(msg.debuffs);
```

In the reconcile dims (`:1528`): `{ width: this.player.width, height: this.player.height, speed: PLAYER_SPEED_EFFECTIVE * this.selfSpeedMult },`.

In the constructor, next to the other per-session fields, add `this.selfSpeedMult = 1; this.auraDebuffRows = [];`.

In the render args (`:1728`): `activeBuffs: [...(this.activeBuffs ? Array.from(this.activeBuffs.values()) : []), ...this.auraDebuffRows],`.

`RenderSystem._drawActiveBuffs`: replace the timer math and the art lookup so that persistent rows have no countdown:

```js
      const persistent = b.persistent === true;
      const dur = Number(b.durationMs) || 20000;
      const remainingMs = persistent ? dur : Math.max(0, (b.expiresAt || (b.startedAt + dur)) - nowMs);
      const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
      const frac = persistent ? 1 : Math.max(0, Math.min(1, remainingMs / dur));
```

```js
      const buffImg = persistent ? null : artIcon(this.gameArt, "skill", b.id);
```

```js
      // Timer readout -- or, for an aura debuff (SOMET-606), what it does.
      ctx.font = "10px monospace";
      if (persistent) {
        ctx.fillStyle = "#fca5a5";
        const d = b.detail || "";
        ctx.fillText(d.length > 17 ? d.slice(0, 16) + "…" : d, bx + 36, by + 18);
      } else {
        ctx.fillStyle = remainingSec <= 3 ? "#f87171" : "#fde047";
        ctx.fillText(`${remainingSec}s`, bx + 36, by + 18);
      }
```

- [ ] **Step 4: Run them and confirm they PASS, then the whole frontend suite and the build**

```bash
cd $WT/frontend && npx vitest run src/games/something2/src/js/core/__tests__/auraDebuffs.test.js src/games/something2/src/js/entities/Player.auraSpeed.test.js src/games/something2/src/js/entities/__tests__/CreatureManager.auras.test.js src/games/something2/src/js/core/__tests__/gameAuraWiring.test.js src/games/something2/src/js/net/reconcile.test.js src/games/something2/src/js/entities/Player.attackFacing.test.js; echo "exit=$?"
npx vitest run; echo "exit=$?"
npx vite build > /dev/null; echo "build exit=$?"
```
Expected: `exit=0` three times.

- [ ] **Step 5: Commit**

```bash
git -C $WT add frontend/src/games/something2/src/js/core/auraDebuffs.js \
  frontend/src/games/something2/src/js/core/__tests__/auraDebuffs.test.js \
  frontend/src/games/something2/src/js/entities/Player.js \
  frontend/src/games/something2/src/js/entities/Player.auraSpeed.test.js \
  frontend/src/games/something2/src/js/entities/CreatureManager.js \
  frontend/src/games/something2/src/js/entities/__tests__/CreatureManager.auras.test.js \
  frontend/src/games/something2/src/js/core/Game.js \
  frontend/src/games/something2/src/js/core/__tests__/gameAuraWiring.test.js \
  frontend/src/games/something2/src/js/systems/RenderSystem.js
git -C $WT commit -m "feat(auras): HUD debuff rows, slowed client prediction, creature aura names merged (SOMET-606)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Full suites and browser verification on an isolated backend (:13106)

**Files:**
- Create (NOT committed, delete afterwards): `frontend/vite.verify.config.mjs`
- No source changes. A defect found here goes back to its owning task as a RED test first.

**Interfaces:** consumes everything above.

- [ ] **Step 1: Full backend suite on the scratch DB.** Compare it against `s4-baseline.log`.

```bash
cd $WT/backend
export TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_s4
export DATABASE_URL=postgres://user:password@localhost:15432/game_db_s4
npm test > ../../s4-final.log 2>&1; echo "exit=$?"
grep -E '^not ok|testTimeoutFailure' ../../s4-final.log
```
Expected: no `not ok` line that is not also in the baseline, ignoring `authority_openchest_integration` (SOMET-615). A `refreshPlayerStats` failure (SOMET-619) is re-run once on its own file. `aura_apply_equivalence` and `champion_aura_golden` must be green.

- [ ] **Step 2: Full frontend suite**

```bash
cd $WT/frontend && npx vitest run; echo "exit=$?"
```
Expected: `exit=0`.

- [ ] **Step 3: Author two enemy auras on the scratch DB and bind them.** No enemies aura exists in any seed (`seeds/data/auraEffects.js:5-8`; S9 adds only allies auras), so verification makes its own, through the real admin API, on `game_db_s4` only.

Start the isolated backend first (Step 4), log in as the admin, then in the **Aura Effects** tab (`/game/auras`) create:
- `s4_mire`: Target `enemies`, radius 300, speed 0.6, damage 0.7, defense 0.8, DoT 6 dps `fire`, tick 1000 ms.
- `s4_dread`: Target `enemies`, radius 300, speed 0.6, damage 1, defense 1, DoT 0.

In the **Entities** tab, bind `s4_mire` to `Wolf`. Bind `s4_mire` and `s4_dread` to `Slime` (or any second hostile type present in Vale Crossing). Auras resolve at chunk load, so restart the isolated backend after binding (Step 7 teardown, then Step 4 again).

- [ ] **Step 4: Start the isolated backend** (its own port and the scratch DB; kill it by PID file only)

```bash
cd $WT/backend
set -a; . /home/markunn/worker/coding/jsgame/something2/.env; set +a
export PORT=13106 DATABASE_URL=postgres://user:password@localhost:15432/game_db_s4
export REDIS_URL=$(echo "$REDIS_URL" | sed 's/redis:6379/localhost:16379/')
nohup node src/index.js > ../../s4-backend.log 2>&1 & echo $! > ../../s4-backend.pid
sleep 5; curl -s localhost:13106/api/health
```

Admin account on the scratch DB only (never `admin-password-rotate`):

```bash
cd /home/markunn/worker/coding/jsgame/something2/backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db_s4 node scripts/set-admin-password.js
node -e "console.log(require('dotenv').parse(require('fs').readFileSync('/home/markunn/worker/coding/jsgame/something2/.env')).ADMIN_PASSWORD)"
```

- [ ] **Step 5: Start the isolated frontend.** `$WT/frontend/vite.verify.config.mjs` (do not commit):

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  cacheDir: '/tmp/s4-auras-vite-cache',
  server: {
    port: 15306, strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:13106', changeOrigin: true },
      '/authority': { target: 'http://localhost:13106', ws: true, changeOrigin: true },
    },
  },
});
```

```bash
cd $WT/frontend && nohup node node_modules/.bin/vite --config vite.verify.config.mjs > ../../s4-vite.log 2>&1 & echo $! > ../../s4-vite.pid
curl -s http://localhost:15306/src/games/something2/src/js/core/auraDebuffs.js | grep -c debuffHudEntries   # expect >= 1 (fresh bundle)
curl -s http://localhost:15306/src/games/something2/src/js/core/Game.js | grep -c 'selfSpeedMult'           # expect >= 1
```

- [ ] **Step 6: Drive it in Chrome DevTools MCP** (`isolatedContext`, `http://127.0.0.1:15306/game-something2`). Log in as the admin and pick Vale Crossing. Never idle-wait near creatures without tagging what you are measuring (memory: idle-death-confounds-position-tests).
  1. Click Play, then `evaluate_script` `await document.exitFullscreen().catch(() => {})`.
  2. **Baseline outside any aura:** hold `d` for 2 s using `press_key` down/up, or a scripted keydown/keyup, and record the displacement magnitude `Math.hypot(dx, dy)` of `player.x/y` from the game instance (`d` is an iso diagonal in world space, `Player.js:34`). Expect about 400 px (200 px/s; if inputs are not normalised, record the baseline as measured and compare ratios only).
  3. **Enter a Wolf's `s4_mire`:** walk to within 300 px of a Wolf. Screenshot the HUD: a top-left row reading **S4 Mire**, the 🔥 icon and `-40% spd -30% dmg 6 fire/s` (the detail rounds: damage 0.7 shows as -30%, defense 0.8 as -20%; the detail field is cut at 17 chars, so read `auraDebuffRows` with `evaluate_script` for the full text).
  4. **HP loss over time:** read `player.hp` every second for 5 s while standing inside and out of the wolf's bite reach (if the wolf chases, retreat inside the radius or use a wolf blocked by terrain). Expect a drop of about 6 per second, minus defense, on top of regen. Record the sequence.
  5. **Slower movement:** repeat the 2 s walk inside the radius. Expect about 0.6 × the baseline. Check there is no rubber-banding: take three screenshots 200 ms apart mid-walk, and check that the displacement sampled each frame along the walk direction never goes backwards.
  6. **Lower damage:** swing at a training target (any creature) once outside and once inside the aura, and compare the hp delta from `creatures` (expect inside ≈ 0.7 × outside).
  7. **Leave:** walk more than 300 px away. Within one frame the HUD row disappears, `game.selfSpeedMult === 1`, hp stops falling, and a 2 s walk is back to about 400 px.
  8. **Overlap floors:** stand where both `s4_mire` and `s4_dread` reach (a Slime carrying both, or a Wolf plus a Slime). The HUD shows two rows, and `evaluate_script` reads `game.selfSpeedMult === 0.5` (0.6 × 0.6 = 0.36 floored). A 2 s walk gives about 200 px.
  9. **Death through the normal path:** temporarily raise `s4_mire` to 500 dps in the Aura Effects tab, restart the backend (Step 7 kill plus Step 4), stand inside, and confirm the death or respawn flow is the usual one: respawn at full hp, no console error. Set it back afterwards.
  10. `list_console_messages`: no `ReferenceError`/`TypeError`.

- [ ] **Step 7: Tear down** (by PID file; never `pkill -f "node src/index.js"`)

```bash
kill $(cat ../../s4-backend.pid) $(cat ../../s4-vite.pid); rm -f $WT/frontend/vite.verify.config.mjs
cd $WT && git status --short   # no stray files; node_modules symlinks never staged
```

- [ ] **Step 8: Record the evidence.** Put the following in the SOMET-606 Plane comment (To Review): the backend and frontend exit codes, the baseline diff, the `MEASURE_TICK` numbers from Task 6, the screenshots, and the Step 6 numbers (displacements, the hp series, damage deltas, the floor reading). Re-check migrations: `git -C /home/markunn/worker/coding/jsgame/something2 ls-tree --name-only origin/main backend/migrations/ | grep 17144407` must list nothing from this slice.

---

## Self-Review

**Spec coverage (S4):**

| Spec item | Where |
|---|---|
| §3.2 same aura → strongest, which for an enemy debuff is the SMALLEST multiplier (no `Math.max`) | Task 1 (`Math.min` line + sabotage check + oracle) |
| §3.2 different auras multiply | Task 1 (literal + oracle order), Task 4 (real movement) |
| §3.2 enemy floors ≥ 0.5 on speed, damage, defense | Task 1 (totals), Task 4 (100 px/s under two 0.6 auras), Task 8 step 8 |
| §3.2 DoT enemies-only | Task 1 (allies auras never reach a player; the DB CHECK `aura_effects_dot_side_check` already forbids an allies DoT, `1714440680000_aura_effects.js:44`) |
| §4.2 players in radius get the multipliers for the tick; distance squared | Task 1, Task 2 (`_buff` per tick), Task 3 (defense), Task 4 (speed, damage) |
| §4.2 DoT every `tick_ms` through the normal damage path (resistances, death) | Task 2 (resist, defense, shock path, `resolveDeaths` once, attribution) |
| §4.2 "S4 decides whether enemy auras need a cap" | Task 6: no cap, measured |
| §4.2 snapshot: creature active aura names | Task 5 (intro, once), Task 7 (client merge) |
| §4.2 snapshot: player's active debuffs | Task 5 (own frame only, D7), Task 7 |
| §4.5 HUD debuff icons for active enemy auras | Task 7 (`_drawActiveBuffs` persistent rows), Task 8 |
| §7 S4: DoT respects resistances and fires death; floors hold under overlap | Task 2, Task 1, Task 4 |
| §7 browser: debuff + HP loss inside an enemy aura | Task 8 |
| Perf (SOMET-613 comment / SOMET-617): separate pass, no inner-loop allocation, typed arrays | Task 1 design, Task 6 tests; `applyAuras`, equivalence and golden untouched |

**Decisions the spec did not make (flag for the spec owner):**

- **D1 No migration.** S3's `AURAS_LATERAL` already carries `dot_dps`, `dot_element` and `tick_ms` (`services/auraEffects.js:125-137`), so S4 adds no loader and no column.
- **D2 An enemies aura only hinders.** `auraEffectError` accepts any multiplier > 0 on either side (`services/auraEffects.js:33-35`). The spec's "strongest = smallest" is meaningless for a value above 1. S4 clamps each enemies-side value to at most 1. The alternative is a validator rule (`target_side='enemies'` ⇒ mult ≤ 1) that also stops admins from authoring it.
- **D3 Only an uncharmed live hostile is an enemies-aura source.** The spec says "players in radius" but not whose aura. A charmed pet (`creatures.js:1607-1660`) would otherwise debuff its own Druid, and a guard's enemies are creatures.
- **D4 DoT across different names is additive, with one clock per name.** The spec defines multiply-across-names for multipliers only.
- **D5 DoT timing.** It charges on entry, then once per `tick_ms`, with no banking and no re-charge on a quick out-and-in. The spec only says "every `tick_ms`".
- **D6 One-tick lag on speed.** The creature tick (where auras are computed) runs after the player movement tick (`server.js:3068` then `:3262`), so the slow applies from the next 50 ms tick. Defense, the DoT and creature hits apply in the same tick.
- **D7 Debuffs go to the owner only**, as top-level frame fields rather than on the shared `players[]` rows (`server.js:3355-3398`).
- **D8 The client needs the speed multiplier on the wire.** The spec lists "player's active debuffs" but not a speed field. Without one, prediction (`Game.js:1528`, `constants.js:18`, `Player.js:83`) rubber-bands. `speedMult` also carries chill (`world.js:275`), which fixes the same latent snap-back for chilled players (creature ice projectiles already chill players, `projectiles.js:428,599`).

**Spec gaps to raise (file:line):**

1. **No enemies aura content exists anywhere.** `backend/seeds/data/auraEffects.js:5-8` seeds only `pack_leader` (allies). S9's plan adds three allies auras. S4 ships with no in-game effect until S7/S8 (or an admin) authors one. Task 8 creates its own on the scratch DB.
2. **No player protection rules exist for the DoT to "respect".** There is no invulnerability, safe zone or respawn grace in the authority. A grep for `invuln|safeZone|spawnGrace|respawnGrace` over `backend/src/authority` matches nothing. The spawn sanctuary (`creatures.js:406-449`) only stops creatures ROAMING in, and a chase is allowed. So an enemies aura near a respawn point keeps charging, and a boss aura over a village is not suppressed. Decide whether S4/S9 needs a "no aura in villages/at entry_spawn" rule.
3. **Flat defense per DoT charge.** `applyDamage` subtracts the full `defense` from every charge and floors at `MIN_DAMAGE = 1` (`damage.js:8,122,131`). A short `tick_ms` with low dps therefore either loses most of its damage to defense or is lifted to 1 per charge (3 dps @ 100 ms = 0.3 raw → 1 → 10 dps). That is the same as burn (`world.js:537`), but the spec should say whether that is intended. It belongs in SOMET-613 tuning.
4. **Player deaths carry no killer.** `onPlayerDeath(entry, userId)` (`server.js:1036`) has no attacker parameter. "Kill attribution" for a DoT death is only the `_provokedBy` stamp (`damage.js:96-105`), which nothing reads for players.
5. **Victor's Boon is not shown in the HUD.** `worldBoss.js:690-699` stores it in `playerBuffs`. `STATUS_EFFECT_CATALOG.victors_boon` (`statusEffects.js:39`) and the server's `out.buffs` (`world.js:1678-1688`) have no client consumer. The only buff panel is client-local skill buffs (`Game.js:2522-2534` → `RenderSystem.js:4310`). S4 reuses that panel, and the Boon display is a separate gap.
6. **Aura edits do not reach live creatures.** Definitions resolve at load (`creatures.js:1436-1438`, spec §3.2). Tuning an enemies aura in the tab needs a chunk reload or a restart to take effect, which Task 8 has to do.
7. **Spec §4.2 citation is stale.** It names `creatures.js:2195` as the player leech-aura cap. The leech target cap now lives in `world.js:640-643` (`countHostilesWithin(..., AURA_MAX_TARGETS, ...)`). That feature is untouched here (`auraRadiusOf`, `world.js:133-137`).

**Parallel-slice conflict risks (S2 `../something2-wt-s2-boss-sounds`, S9 `../something2-wt-s9-dungeon-bosses`).** Both branches are based on pre-617 main: their diffs against `origin/main` show `aura_apply_equivalence.test.js` deleted and about 166 lines of `creatures.js` reverted. They must rebase onto `0aff0488`, and they must not resolve those hunks by taking their side.
- `creatures.js`: S2 changes `addCreatures` (spawn sfx, `quietSpawn`). S4 touches `tick()` after `:1558`, a new block after `:1188`, `:2182`, the `snapshotAOI` intro `:2677` and exports. These are different hunks, but the intro sits next to S1's boss lines, which S2 does not touch. Risk: low.
- `server.js`: S2 changes `debugWorldBoss`, and S9 makes additive changes (`loadWorld`, `onCreatureDeath`, the sweep, the charm guard). S4 adds one line in the `state` frame loop (`:3397`). Risk: low.
- `Game.js`: S2 changes `update` near `tickNearby` (`:1408-1420`). S4 changes `:1430`'s neighbour `_onWorldState` (`:1507`), reconcile `:1528` and render args `:1728`. Risk: adjacent at worst.
- `RenderSystem.js`: S9 changes `bossPalette`, S4 changes `_drawActiveBuffs` (`:4310`). Risk: none.
- `seeds/data/auraEffects.js`: S9 edits it, S4 does not (deliberately, to avoid the clash).
- `world.js`, `projectiles.js`: neither S2 nor S9 touches them.
- S9's three allies auras are inert for S4 (allies side), and its dungeon bosses become enemies-aura sources only if content later binds one.

**Placeholder scan:** no TBD or TODO. Two steps deliberately say "read X, then adapt the fixture": the `ProjectileSim.tick` context shape in Task 3 and the skill id in Task 4. Each names the file and the existing test to copy, and forbids changing the assertion. **Type consistency:** `PlayerDebuff.auras[]` (Task 1) is read by `chargeAuraDots` (Task 2) and `selfAuraFields` (Task 5). The wire `{ n, d, f, s, dps?, el? }` (Task 5) is read by `debuffHudEntries` (Task 7). `playerSpeedMult` (Task 4) is the single source for both movement and `speedMult`. `NO_BUFF` and `effectiveMit` are exported in Task 1 and consumed in Tasks 3-4.
