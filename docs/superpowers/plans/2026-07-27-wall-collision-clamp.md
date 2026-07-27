# Wall-Collision Clamping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make per-axis tile/wall collision dt-invariant by clamping a blocked step to the wall face (swept), so client prediction and server/reconciliation agree near walls and the bumping/glue jitter disappears.

**Architecture:** `resolveMove` currently rejects a whole step when the leading edge would enter a wall — a dt-dependent stopping distance that diverges between the client's ~16ms frame prediction and the server/reconcile 50ms tick, and the 20Hz hard-snap makes that divergence visible. Replace rejection with a clamp: move exactly up to the wall face (`WALL_EPS` shy of the tile boundary), and inset the perpendicular corner samples by `WALL_EPS`. Steps are always sub-tile, so the leading face crosses at most one boundary. The change lives in the two byte-for-byte-mirrored copies — `frontend/.../systems/movement.js` (client prediction) and `backend/src/authority/collision.js` (server authority for players and creatures).

**Tech Stack:** Vanilla JS. Frontend tests: Vitest. Backend tests: `node:test`. No new dependencies.

## Global Constraints

- **Byte-for-byte parity:** the `resolveMove` *body* in `frontend/src/games/something2/src/js/systems/movement.js` and `backend/src/authority/collision.js` must be character-identical except the declaration line (`export function` vs `function`). The `const WALL_EPS = 0.01;` declaration and the `MAP_TILE_SIZE` binding live at module scope (outside the body), so they do not affect the body-parity diff. This is the #1 constraint — divergence rubber-bands the client against the server.
- **`WALL_EPS = 0.01`** (world px), identical in both files.
- **`MAP_TILE_SIZE = 100`**: backend `collision.js` already declares `const MAP_TILE_SIZE = 100;`. Frontend `movement.js` must `import { MAP_TILE_SIZE } from "../core/constants.js";` (it currently imports nothing). Both resolve to 100 and match the tile size the maps use for `isWalkable`.
- **Unchanged invariants:** center anchor `(x+w/2, y+h/2)`, `speedAt` sampled at center, per-axis independence, footprint = actor's own `width`/`height`, pure function returning `{x,y,moved}`, no `RenderSystem`/reconcile/world.js changes.
- **Non-goals (do not implement):** full-speed diagonal wall-slide (0.707× stays), reconciliation smoothing, the visual feet offset, the depth-sort inconsistency.

---

## File Structure

- `backend/src/authority/collision.js` — **reference implementation.** Add `WALL_EPS`; replace the `resolveMove` walkability logic with the swept clamp.
- `backend/tests/authority_collision.test.js` — update two vectors whose result changes from "blocked/stay" to "clamped/partway"; add dt-invariance and flush-slide vectors.
- `frontend/src/games/something2/src/js/systems/movement.js` — **mirror.** Add the `MAP_TILE_SIZE` import and `WALL_EPS`; same `resolveMove` body.
- `frontend/src/games/something2/src/js/systems/__tests__/movement.test.js` — update three vectors (two pre-existing "blocked" tests + the footprint "block-front"); add the same dt-invariance and flush-slide vectors.

The exact final `resolveMove` body is in Task 1 Step 3 and reused verbatim in Task 2. Copy it — do not paraphrase.

---

### Task 1: Backend swept-clamp `resolveMove` (reference)

**Files:**
- Modify: `backend/src/authority/collision.js` (add `WALL_EPS` near line 9; replace `resolveMove` at lines 12-34)
- Test: `backend/tests/authority_collision.test.js`

**Interfaces:**
- Consumes: `map.isWalkable(worldX, worldY) -> boolean`, `map.speedAt(worldX, worldY) -> number`; module const `MAP_TILE_SIZE = 100`.
- Produces: `resolveMove(map, actor, dirX, dirY, dt) -> { x, y, moved }`, `actor` = `{x,y,width,height,speed}`. Signature/return shape UNCHANGED. Task 2 copies this exact body.

- [ ] **Step 1: Update the two vectors whose results change, and add the new ones**

In `backend/tests/authority_collision.test.js`:

(a) Replace the test `footprint blocks when the box FRONT reaches a wall even though the CENTER has not` with:

```js
test('a blocked step CLAMPS the box up to the wall face (not reject)', () => {
  // Box 64 wide at x=0 -> east face 64. Wall column 1 (x>=100). Step east 40
  // would put the face at 104 (into the wall); clamp the face to 100-EPS, so
  // x moves from 0 to 35.99 instead of staying put.
  const actor = { x: 0, y: 0, width: 64, height: 64, speed: 40 };
  const r = resolveMove(wallColumn(1), actor, 1, 0, 1);
  assert.ok(Math.abs(r.x - 35.99) < 1e-6, `x=${r.x}`);
  assert.equal(r.y, 0);
  assert.equal(r.moved, true);
});
```

(b) Replace the test `resolveMove blocks the X axis at a wall but allows Y (footprint)` with:

```js
test('X clamps to the wall face while Y slides free (footprint)', () => {
  // Box 64x64 at (0,0). Wall column 1. Moving NE: east face clamps to 100-EPS
  // (x -> 35.99); Y is free (box stays in column 0 for the Y move).
  const actor = { x: 0, y: 0, width: 64, height: 64, speed: 200 };
  const r = resolveMove(wallColumn(1), actor, 1, 1, 0.5);
  assert.ok(Math.abs(r.x - 35.99) < 1e-6, `x=${r.x}`); // clamped, not 0
  assert.ok(r.y > 0);                                   // y slides free
  assert.equal(r.moved, true);
});
```

(c) Add these two tests (near the other golden vectors):

```js
test('collision is dt-invariant near a wall: one big step == many small steps', () => {
  // The bug: step-rejection made the stop distance depend on dt, so the client
  // (16ms) and server (50ms) disagreed near walls. Clamping makes them equal.
  const run = (dt, n) => {
    const a = { x: 0, y: 0, width: 64, height: 64, speed: 200 };
    for (let i = 0; i < n; i++) { const r = resolveMove(wallColumn(1), a, 1, 0, dt); a.x = r.x; a.y = r.y; }
    return a.x;
  };
  const big = run(0.05, 10);
  const small = run(0.05 / 3, 30);
  assert.ok(Math.abs(big - small) < 1e-9, `dt divergence: big=${big} small=${small}`);
  assert.ok(Math.abs(big - 35.99) < 1e-6, `x=${big}`);
});

test('flush against a wall, a parallel move slides at full speed (EPS corner inset)', () => {
  // East face EXACTLY on the tile line x=100 (x=36, width 64). Moving south
  // along the column-1 wall must advance the full step (10). Without the EPS
  // inset the right corner at x=100 would floor into the wall column and block.
  const r = resolveMove(wallColumn(1), { x: 36, y: 0, width: 64, height: 64, speed: 200 }, 0, 1, 0.05);
  assert.equal(r.y, 10);
  assert.equal(r.x, 36);
  assert.equal(r.moved, true);
});
```

Leave the `escape`, `gate`, and `wallTile` two-corner guard tests unchanged — clamping does not change their results (full move / already-flush).

- [ ] **Step 2: Run the updated tests to verify they fail**

Run: `cd backend && node --test tests/authority_collision.test.js`
Expected: the clamp/dt-invariance/flush tests FAIL against the current reject-logic (e.g. clamp test sees `x=0`, dt-invariance sees `big=30, small=33.33`).

- [ ] **Step 3: Add `WALL_EPS` and replace `resolveMove` with the swept clamp**

In `backend/src/authority/collision.js`, add after the `MAP_TILE_SIZE`/`MAX_CHUNKS` consts (around line 10):

```js
const WALL_EPS = 0.01; // clamp/inset margin so a clamped face stays inside the walkable tile
```

Then replace the entire `resolveMove` function (lines 12-34) with:

```js
function resolveMove(map, actor, dirX, dirY, dt) {
  if (dirX === 0 && dirY === 0) return { x: actor.x, y: actor.y, moved: false };

  const len = Math.hypot(dirX, dirY);
  const nx = dirX / len;
  const ny = dirY / len;

  const hw = actor.width / 2;
  const hh = actor.height / 2;
  const cx = actor.x + hw;
  const cy = actor.y + hh;

  const tileSpeed = map.speedAt(cx, cy);
  const stepX = nx * actor.speed * dt * tileSpeed;
  const stepY = ny * actor.speed * dt * tileSpeed;

  let x = actor.x;
  let y = actor.y;
  let moved = false;

  // Swept clamp per axis. The leading face is the box edge in the travel
  // direction; a sub-tile step crosses at most one boundary. If the
  // destination corners are blocked, clamp the face to WALL_EPS shy of the
  // wall boundary and move only that far (dt-invariant: any timestep lands on
  // the same face). Perpendicular corners are inset by WALL_EPS so an edge
  // exactly on a tile line is not read as inside the next tile.
  if (stepX !== 0) {
    const dir = stepX > 0 ? 1 : -1;
    const face = dir > 0 ? actor.x + actor.width : actor.x;
    const destFace = face + stepX;
    const top = cy - hh + WALL_EPS;
    const bot = cy + hh - WALL_EPS;
    if (map.isWalkable(destFace, top) && map.isWalkable(destFace, bot)) {
      x += stepX;
      moved = true;
    } else {
      const boundary = dir > 0
        ? Math.floor(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE
        : Math.ceil(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE;
      const move = (boundary - dir * WALL_EPS) - face;
      if (move * dir > 0) {
        x += move;
        moved = true;
      }
    }
  }
  if (stepY !== 0) {
    const dir = stepY > 0 ? 1 : -1;
    const face = dir > 0 ? actor.y + actor.height : actor.y;
    const destFace = face + stepY;
    const left = cx - hw + WALL_EPS;
    const right = cx + hw - WALL_EPS;
    if (map.isWalkable(left, destFace) && map.isWalkable(right, destFace)) {
      y += stepY;
      moved = true;
    } else {
      const boundary = dir > 0
        ? Math.floor(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE
        : Math.ceil(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE;
      const move = (boundary - dir * WALL_EPS) - face;
      if (move * dir > 0) {
        y += move;
        moved = true;
      }
    }
  }

  return { x, y, moved };
}
```

- [ ] **Step 4: Run the updated tests to verify they pass**

Run: `cd backend && node --test tests/authority_collision.test.js`
Expected: clamp, dt-invariance, and flush-slide tests PASS; escape/gate/guard still PASS.

- [ ] **Step 5: Run the full backend suite and fix any position assertions that shifted**

Run: `cd backend && npm test`
Expected: all pass. Creature/guard suites (`authority_creatures.test.js`, `guardTick.test.js`, `authority_world.test.js`) run `resolveMove`; any assertion of an exact post-move position *against a wall* now clamps to the face instead of staying put. For each failure, confirm the new number is the box clamped to the wall face (a correct consequence), then update the exact expected value. Do NOT weaken exact assertions to vague ranges. If a failure is NOT explainable as clamping-to-face, stop and report it as a concern.

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/collision.js backend/tests/authority_collision.test.js
git commit -m "feat(collision): swept wall-clamping in server authority (dt-invariant)"
```

---

### Task 2: Frontend mirror + parity lock

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/movement.js` (add import + `WALL_EPS`; replace `resolveMove` at lines 6-36)
- Test: `frontend/src/games/something2/src/js/systems/__tests__/movement.test.js`

**Interfaces:**
- Consumes: the exact `resolveMove` body + `WALL_EPS` from Task 1; `MAP_TILE_SIZE` from `../core/constants.js`.
- Produces: `export function resolveMove(...) -> { x, y, moved }` — unchanged signature; `reconcile.js` and `Player.js` need no change.

- [ ] **Step 1: Update the three shifted vectors and add the new ones**

In `frontend/src/games/something2/src/js/systems/__tests__/movement.test.js`:

(a) In `is blocked by a water tile on that axis`, replace the assertion `expect(r.x).toBe(a.x);` with:

```js
    expect(r.x).toBeCloseTo(79.99, 2); // clamps up to the wall face (was: stayed put)
```

(b) In `is blocked when stepping into an unloaded chunk (streaming frontier)`, replace `expect(r.x).toBe(a.x);` with:

```js
    expect(r.x).toBeCloseTo(379.99, 2); // clamps up to the frontier (was: stayed put)
```

(c) Replace the `footprint blocks when the box FRONT reaches a wall, not just the center` test body with:

```js
  it("a blocked step clamps the box up to the wall face", () => {
    const r = resolveMove(wallColumn(1), { x: 0, y: 0, width: 64, height: 64, speed: 40 }, 1, 0, 1);
    expect(r.x).toBeCloseTo(35.99, 2);
    expect(r.y).toBe(0);
    expect(r.moved).toBe(true);
  });
```

(d) Add inside the `describe("resolveMove", ...)` block (identical inputs/expected to the backend suite):

```js
  it("collision is dt-invariant near a wall (one big step == many small steps)", () => {
    const run = (dt, n) => {
      const a = { x: 0, y: 0, width: 64, height: 64, speed: 200 };
      for (let i = 0; i < n; i++) { const r = resolveMove(wallColumn(1), a, 1, 0, dt); a.x = r.x; a.y = r.y; }
      return a.x;
    };
    const big = run(0.05, 10);
    const small = run(0.05 / 3, 30);
    expect(Math.abs(big - small)).toBeLessThan(1e-9);
    expect(big).toBeCloseTo(35.99, 5);
  });

  it("flush against a wall, a parallel move slides at full speed", () => {
    const r = resolveMove(wallColumn(1), { x: 36, y: 0, width: 64, height: 64, speed: 200 }, 0, 1, 0.05);
    expect(r.y).toBe(10);
    expect(r.x).toBe(36);
    expect(r.moved).toBe(true);
  });
```

- [ ] **Step 2: Run the updated tests to verify they fail**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/movement.test.js`
Expected: clamp/dt-invariance/flush tests FAIL against current reject-logic.

- [ ] **Step 3: Add the import + `WALL_EPS` and replace the `resolveMove` body with the mirror**

At the top of `frontend/src/games/something2/src/js/systems/movement.js`, add above the function (keep the existing top-of-file comment block):

```js
import { MAP_TILE_SIZE } from "../core/constants.js";

const WALL_EPS = 0.01; // clamp/inset margin so a clamped face stays inside the walkable tile
```

Then replace the `resolveMove` function (lines 6-36) with the body below — character-identical to Task 1 Step 3 except the declaration line carries `export`:

```js
export function resolveMove(map, actor, dirX, dirY, dt) {
  if (dirX === 0 && dirY === 0) return { x: actor.x, y: actor.y, moved: false };

  const len = Math.hypot(dirX, dirY);
  const nx = dirX / len;
  const ny = dirY / len;

  const hw = actor.width / 2;
  const hh = actor.height / 2;
  const cx = actor.x + hw;
  const cy = actor.y + hh;

  const tileSpeed = map.speedAt(cx, cy);
  const stepX = nx * actor.speed * dt * tileSpeed;
  const stepY = ny * actor.speed * dt * tileSpeed;

  let x = actor.x;
  let y = actor.y;
  let moved = false;

  // Swept clamp per axis. The leading face is the box edge in the travel
  // direction; a sub-tile step crosses at most one boundary. If the
  // destination corners are blocked, clamp the face to WALL_EPS shy of the
  // wall boundary and move only that far (dt-invariant: any timestep lands on
  // the same face). Perpendicular corners are inset by WALL_EPS so an edge
  // exactly on a tile line is not read as inside the next tile.
  if (stepX !== 0) {
    const dir = stepX > 0 ? 1 : -1;
    const face = dir > 0 ? actor.x + actor.width : actor.x;
    const destFace = face + stepX;
    const top = cy - hh + WALL_EPS;
    const bot = cy + hh - WALL_EPS;
    if (map.isWalkable(destFace, top) && map.isWalkable(destFace, bot)) {
      x += stepX;
      moved = true;
    } else {
      const boundary = dir > 0
        ? Math.floor(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE
        : Math.ceil(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE;
      const move = (boundary - dir * WALL_EPS) - face;
      if (move * dir > 0) {
        x += move;
        moved = true;
      }
    }
  }
  if (stepY !== 0) {
    const dir = stepY > 0 ? 1 : -1;
    const face = dir > 0 ? actor.y + actor.height : actor.y;
    const destFace = face + stepY;
    const left = cx - hw + WALL_EPS;
    const right = cx + hw - WALL_EPS;
    if (map.isWalkable(left, destFace) && map.isWalkable(right, destFace)) {
      y += stepY;
      moved = true;
    } else {
      const boundary = dir > 0
        ? Math.floor(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE
        : Math.ceil(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE;
      const move = (boundary - dir * WALL_EPS) - face;
      if (move * dir > 0) {
        y += move;
        moved = true;
      }
    }
  }

  return { x, y, moved };
}
```

- [ ] **Step 4: Run the updated tests to verify they pass**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/movement.test.js`
Expected: all `resolveMove` tests PASS.

- [ ] **Step 5: Run the full frontend suite and fix any shifted assertions**

Run: `cd frontend && npm test`
Expected: all pass. Likely-affected: `net/reconcile.test.js`, `entities/__tests__/Player.chunked.test.js`, `core/__tests__/boundsCollision.test.js`. For each failure, verify the new position is the box clamped to the wall face and update the exact expected value (keep exact numbers / `toBeCloseTo`).

- [ ] **Step 6: Verify byte-for-byte parity of the two `resolveMove` bodies**

```bash
cd /path/to/repo && diff \
  <(sed -n '/resolveMove(map, actor, dirX, dirY, dt) {/,/^}/p' frontend/src/games/something2/src/js/systems/movement.js | sed '1s/^export //') \
  <(sed -n '/resolveMove(map, actor, dirX, dirY, dt) {/,/^}/p' backend/src/authority/collision.js)
```

Expected: **no output**. If anything other than a whitespace-only difference prints, reconcile `movement.js` to match `collision.js` exactly and re-run until clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/movement.js \
        frontend/src/games/something2/src/js/systems/__tests__/movement.test.js
git commit -m "feat(collision): mirror swept wall-clamping into client prediction"
```

---

## Verification (post-implementation, before merge)

Automated suites (backend + frontend `npm test`) are the gate. Because this changes movement *feel*, browser-check on the live dev stack (see the `dev-run-browser-verify` memory):

1. Merge/checkout the branch into the **main working dir** so vite + nodemon hot-reload it.
2. Walk straight into a `map_wall`/`wooden_wall`: the body should stop **flush and smooth** — no continuous bumping.
3. Hold into a wall, then release and move away: should leave immediately, **no glue**.
4. Slide along a wall (hold into-wall + perpendicular): **smooth**, no stutter.
5. Watch for rubber-banding along walls at speed (a parity-break symptom) — there should be none.

---

## Self-Review

**1. Spec coverage.** Swept clamp with `WALL_EPS` + perpendicular inset → Task 1/2 Step 3 (full code). `WALL_EPS=0.01`, `MAP_TILE_SIZE=100`, module-scope placement → Global Constraints + Step 3. Byte-for-byte parity → Global Constraints + Task 2 Step 6 diff. dt-invariance + flush-slide + clamp behavior → new/updated tests in both suites. Center anchor / speedAt / per-axis / purity unchanged → Step 3 keeps them. Non-goals (0.707 slide, smoothing, feet offset) → Global Constraints. ✅

**2. Placeholder scan.** No TBD/"handle edge cases"/"similar to"; every code step has full code; the exact `resolveMove` body appears in full in both tasks; every shifted test lists its old→new assertion. ✅

**3. Type consistency.** `resolveMove(map, actor, dirX, dirY, dt) -> {x,y,moved}` unchanged and identical across both files; `actor` fields `{x,y,width,height,speed}` match all call sites; `wallColumn`/`gateColumn`/`wallTile` stubs already exist in both suites from the footprint work and are reused; new expected values (`35.99`, `79.99`, `379.99`, `70.71`, dt-invariance `<1e-9`, flush `y=10`) are the numerically-verified results. ✅
