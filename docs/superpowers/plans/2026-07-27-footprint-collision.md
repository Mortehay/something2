# Footprint Collision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tile/wall collision stop an actor when its *body box* touches a wall, instead of only when the actor's center point does.

**Architecture:** `resolveMove` currently samples walkability at a single point — the actor's box center `(x+w/2, y+h/2)`. Replace that single-point test with a **box footprint** test: for each axis, block the step only if the box's **leading edge** in the step direction would enter an unwalkable tile, sampling the edge's two corners. The identical algorithm lives in two files that must stay byte-for-byte equal — `frontend/.../systems/movement.js` (client prediction) and `backend/src/authority/collision.js` (server authority for players **and** creatures). This plan changes both together and locks them with an identical "golden vector" test battery.

**Tech Stack:** Vanilla JS. Frontend tests: Vitest. Backend tests: `node:test` (`node --test`). No new dependencies.

## Global Constraints

- **Byte-for-byte parity:** the `resolveMove` *body* in `frontend/src/games/something2/src/js/systems/movement.js` and `backend/src/authority/collision.js` must be character-identical except for the function-declaration line (`export function resolveMove` vs `function resolveMove`). A divergence rubber-bands the client against the server. This is the single most important constraint.
- **Anchor unchanged:** collision still anchors at the box center `(x+w/2, y+h/2)`; `speedAt` is still sampled at the center. Only the *walkability* test changes to a footprint. The ~half-tile visual feet offset is an accepted non-goal — do NOT touch `RenderSystem` sprite anchoring.
- **Footprint = the actor's own box.** Half-extents are `hw = actor.width/2`, `hh = actor.height/2`. No new size constants. Players are 64×64, creatures 48×48; both already carry `width`/`height` server- and client-side.
- **Leading-edge only (not whole-box):** test only the edge the actor is moving toward, so an actor already overlapping a wall can still move away from it. Never test the trailing edge.
- **Tile size is 100** (`MAP_TILE_SIZE`); the box (≤64) is always narrower than a tile, so two corners cover every tile the leading edge can touch.
- **Pure function preserved:** `resolveMove` must not mutate `actor` and must return `{ x, y, moved }`.

---

## File Structure

- `backend/src/authority/collision.js` — **reference implementation.** Holds `resolveMove` (authoritative for players via `world.js` and creatures via `creatures.js`). Change the walkability test only.
- `backend/tests/authority_collision.test.js` — backend `resolveMove` tests: add the golden-vector battery; fix the one existing test whose stub blocks the new footprint's Y path.
- `frontend/src/games/something2/src/js/systems/movement.js` — **mirror.** Same `resolveMove` body as the backend, `export`ed.
- `frontend/src/games/something2/src/js/systems/__tests__/movement.test.js` — frontend `resolveMove` tests: add the identical golden-vector battery (same input numbers → same expected numbers).

The exact final `resolveMove` body is written out in full in Task 1 Step 3 and reused verbatim in Task 2. Copy it — do not paraphrase.

---

### Task 1: Backend footprint `resolveMove` (reference implementation)

**Files:**
- Modify: `backend/src/authority/collision.js:12-34`
- Test: `backend/tests/authority_collision.test.js`

**Interfaces:**
- Consumes: `map.isWalkable(worldX, worldY) -> boolean`, `map.speedAt(worldX, worldY) -> number` (unchanged `ServerMap` / stub interface).
- Produces: `resolveMove(map, actor, dirX, dirY, dt) -> { x:number, y:number, moved:boolean }` where `actor` has `{ x, y, width, height, speed }`. Signature and return shape are UNCHANGED — only internal walkability sampling changes. Task 2 copies this exact body.

- [ ] **Step 1: Add the golden-vector tests (they will fail against the current center-point code)**

Add this block to `backend/tests/authority_collision.test.js` (after the existing `require` at the top, before the `ServerMap` tests):

```js
// --- Footprint collision golden vectors ---------------------------------
// A column-based wall stub: tile column `blockedCol` (world x in
// [blockedCol*100, blockedCol*100+100)) is unwalkable; everything else walks.
function wallColumn(blockedCol) {
  return {
    isWalkable: (wx) => Math.floor(wx / 100) !== blockedCol,
    speedAt: () => 1,
  };
}
// A gate stub: ONLY tile column `openCol` is walkable (walls on both sides).
function gateColumn(openCol) {
  return {
    isWalkable: (wx) => Math.floor(wx / 100) === openCol,
    speedAt: () => 1,
  };
}

test('footprint blocks when the box FRONT reaches a wall even though the CENTER has not', () => {
  // Box 64 wide at x=0 -> center 32, front face 64. Wall in column 1 (x>=100).
  // Step east 40: center reaches 72 (still column 0, walkable) but the front
  // face reaches 104 (column 1) -> footprint blocks. Center-point logic moved.
  const actor = { x: 0, y: 0, width: 64, height: 64, speed: 40 };
  const r = resolveMove(wallColumn(1), actor, 1, 0, 1);
  assert.deepEqual(r, { x: 0, y: 0, moved: false });
});

test('footprint lets an actor already overlapping a wall move AWAY from it', () => {
  // Box sits at x=108 (spans 108..172), embedded in wall column 1. Moving west
  // 40: the west leading edge reaches 68 (column 0, walkable) -> allowed.
  const actor = { x: 108, y: 0, width: 64, height: 64, speed: 40 };
  const r = resolveMove(wallColumn(1), actor, -1, 0, 1);
  assert.deepEqual(r, { x: 68, y: 0, moved: true });
});

test('a 64-wide box threads a 100px-wide gate', () => {
  // Gate = walkable column 1 only. Box centered in it (x=118, spans 118..182,
  // both corners in column 1). Moving south 40 stays in the gate -> passes.
  const actor = { x: 118, y: 150, width: 64, height: 64, speed: 40 };
  const r = resolveMove(gateColumn(1), actor, 0, 1, 1);
  assert.deepEqual(r, { x: 118, y: 190, moved: true });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd backend && node --test tests/authority_collision.test.js`
Expected: the first test FAILS (current center-point code moves the actor to `x:40`); the gate/escape tests may pass by luck but the first proves the gap.

- [ ] **Step 3: Replace the walkability test with the footprint algorithm**

In `backend/src/authority/collision.js`, replace the whole `resolveMove` function (lines 12-34) with:

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

  // Footprint collision: block a step only if the box's LEADING EDGE in the
  // step direction would enter an unwalkable tile. Test the edge's two corners
  // (the box is <= a tile wide, so 2 corners cover every tile it can touch).
  // Testing only the leading edge — not the whole box — lets an actor already
  // overlapping a wall still move away from it.
  if (stepX !== 0) {
    const leadX = cx + stepX + (stepX > 0 ? hw : -hw);
    if (map.isWalkable(leadX, cy - hh) && map.isWalkable(leadX, cy + hh)) {
      x += stepX;
      moved = true;
    }
  }
  if (stepY !== 0) {
    const leadY = cy + stepY + (stepY > 0 ? hh : -hh);
    if (map.isWalkable(cx - hw, leadY) && map.isWalkable(cx + hw, leadY)) {
      y += stepY;
      moved = true;
    }
  }

  return { x, y, moved };
}
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `cd backend && node --test tests/authority_collision.test.js`
Expected: the three golden-vector tests PASS. If the pre-existing test `resolveMove blocks the X axis at an unwalkable tile but allows Y` now FAILS, that is expected — its stub (`isWalkable: wx => wx < blockX`) is a half-plane that blocks the box's right corner during the Y move. Fix it in Step 5.

- [ ] **Step 5: Fix the pre-existing half-plane test to a column wall**

Replace the test `resolveMove blocks the X axis at an unwalkable tile but allows Y` (currently lines ~26-33) with:

```js
test('resolveMove blocks the X axis at a wall but allows Y (footprint)', () => {
  // Box 64 at (0,0) -> center (32,32). Wall column 1 (x>=100). Moving NE:
  // the east leading edge enters column 1 (blocked), but the box's full width
  // (0..64) stays in column 0 for the Y move, so Y is free.
  const actor = { x: 0, y: 0, width: 64, height: 64, speed: 200 };
  const r = resolveMove(wallColumn(1), actor, 1, 1, 0.5);
  assert.equal(r.x, 0);              // x blocked by the wall column
  assert.ok(r.y > 0);               // y slides free
  assert.equal(r.moved, true);
});
```

- [ ] **Step 6: Run the full backend suite and fix any position assertions that shifted**

Run: `cd backend && npm test`
Expected: all pass. Creature/guard suites (`authority_creatures.test.js`, `guardTick.test.js`, `authority_world.test.js`) exercise `resolveMove`; any assertion of an exact post-move position *next to a wall* may shift by the footprint half-extent. For each failure, confirm the new number reflects the box stopping at the wall face (not a logic bug), then update the expected value. Do NOT loosen an assertion to `toBeGreaterThan`-style vagueness to make it pass — keep exact expected numbers.

- [ ] **Step 7: Commit**

```bash
git add backend/src/authority/collision.js backend/tests/authority_collision.test.js
git commit -m "feat(collision): footprint (box) walkability test in server authority"
```

---

### Task 2: Frontend mirror + parity lock

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/movement.js:6-36`
- Test: `frontend/src/games/something2/src/js/systems/__tests__/movement.test.js`

**Interfaces:**
- Consumes: the exact `resolveMove` body from Task 1 Step 3 (copied verbatim, only the declaration line differs).
- Produces: `export function resolveMove(map, actor, dirX, dirY, dt) -> { x, y, moved }` — unchanged signature; `net/reconcile.js` and `entities/Player.js` already import it and need no change.

- [ ] **Step 1: Add the identical golden-vector tests (same numbers as backend)**

Add to `frontend/src/games/something2/src/js/systems/__tests__/movement.test.js`, inside the existing `describe("resolveMove", ...)` block:

```js
  // Footprint golden vectors — identical inputs & expected outputs to the
  // backend suite (backend/tests/authority_collision.test.js). If these two
  // ever disagree, client prediction has diverged from the server authority.
  const wallColumn = (blockedCol) => ({
    isWalkable: (wx) => Math.floor(wx / 100) !== blockedCol,
    speedAt: () => 1,
  });
  const gateColumn = (openCol) => ({
    isWalkable: (wx) => Math.floor(wx / 100) === openCol,
    speedAt: () => 1,
  });

  it("footprint blocks when the box FRONT reaches a wall, not just the center", () => {
    const r = resolveMove(wallColumn(1), { x: 0, y: 0, width: 64, height: 64, speed: 40 }, 1, 0, 1);
    expect(r).toEqual({ x: 0, y: 0, moved: false });
  });

  it("footprint lets an actor overlapping a wall move away from it", () => {
    const r = resolveMove(wallColumn(1), { x: 108, y: 0, width: 64, height: 64, speed: 40 }, -1, 0, 1);
    expect(r).toEqual({ x: 68, y: 0, moved: true });
  });

  it("a 64-wide box threads a 100px gate", () => {
    const r = resolveMove(gateColumn(1), { x: 118, y: 150, width: 64, height: 64, speed: 40 }, 0, 1, 1);
    expect(r).toEqual({ x: 118, y: 190, moved: true });
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/movement.test.js`
Expected: the "box FRONT" test FAILS (current center-point code moves to `x:40`).

- [ ] **Step 3: Replace the frontend `resolveMove` body with the mirror**

In `frontend/src/games/something2/src/js/systems/movement.js`, replace `resolveMove` (lines 6-36) with the body below. It is character-identical to Task 1 Step 3 except for `export` on the declaration line and the leading comment block (keep the existing top-of-file comment lines 1-5 above it):

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

  // Footprint collision: block a step only if the box's LEADING EDGE in the
  // step direction would enter an unwalkable tile. Test the edge's two corners
  // (the box is <= a tile wide, so 2 corners cover every tile it can touch).
  // Testing only the leading edge — not the whole box — lets an actor already
  // overlapping a wall still move away from it.
  if (stepX !== 0) {
    const leadX = cx + stepX + (stepX > 0 ? hw : -hw);
    if (map.isWalkable(leadX, cy - hh) && map.isWalkable(leadX, cy + hh)) {
      x += stepX;
      moved = true;
    }
  }
  if (stepY !== 0) {
    const leadY = cy + stepY + (stepY > 0 ? hh : -hh);
    if (map.isWalkable(cx - hw, leadY) && map.isWalkable(cx + hw, leadY)) {
      y += stepY;
      moved = true;
    }
  }

  return { x, y, moved };
}
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/movement.test.js`
Expected: all `resolveMove` tests PASS.

- [ ] **Step 5: Run the full frontend suite and fix any shifted assertions**

Run: `cd frontend && npm test`
Expected: all pass. Likely-affected files: `net/reconcile.test.js`, `entities/__tests__/Player.chunked.test.js`, `core/__tests__/boundsCollision.test.js`. For each failure, verify the new position reflects the box stopping at the wall face and update the exact expected value (keep exact numbers).

- [ ] **Step 6: Verify byte-for-byte parity of the two implementations**

Run this to diff the two function bodies, normalizing only the declaration line:

```bash
cd /path/to/repo && diff \
  <(sed -n '/resolveMove(map, actor, dirX, dirY, dt) {/,/^}/p' frontend/src/games/something2/src/js/systems/movement.js | sed '1s/^export //') \
  <(sed -n '/resolveMove(map, actor, dirX, dirY, dt) {/,/^}/p' backend/src/authority/collision.js)
```

Expected: **no output** (identical). If the diff shows any line other than a whitespace-only difference, reconcile the two so they match exactly.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/movement.js \
        frontend/src/games/something2/src/js/systems/__tests__/movement.test.js
git commit -m "feat(collision): mirror footprint walkability test into client prediction"
```

---

## Verification (post-implementation, before merge)

Automated suites (backend `npm test`, frontend `npm test`) are the gate and must be green. Because this changes movement *feel*, a live browser check is strongly recommended (dev stack hot-reloads the main checkout — see the `dev-run-browser-verify` memory):

1. Merge/checkout the branch into the **main working dir** so vite + nodemon pick it up.
2. Walk a player straight into a `map_wall`/`wooden_wall`: the sprite body should stop **at the wall face**, not overlap it by half a body.
3. Walk through a `village_gate`/`map_doorway`: the player should **pass** (64-wide box, 100px gate).
4. Slide along a wall (hold into-wall + perpendicular): the actor should **slide**, not stick.
5. Confirm no rubber-banding: move fast along walls and watch for the client snapping back to a server-corrected position (a parity-break symptom).

---

## Self-Review

**1. Spec coverage.** Footprint box = actor size → Task 1/2 use `hw=width/2,hh=height/2`. Players + creatures → both go through `resolveMove` (backend authoritative for both; frontend predicts the player). Byte-for-byte parity → Global Constraints + Task 2 Step 6 diff. Leading-edge/escape → covered by the "move away" golden vector. Gate threading → dedicated golden vector. Anchor/speed unchanged → center still used for `speedAt` and as the box origin; RenderSystem untouched. ✅

**2. Placeholder scan.** No TBD/"handle edge cases"/"similar to"; every code step has full code; the exact `resolveMove` body appears in full in both tasks. ✅

**3. Type consistency.** `resolveMove(map, actor, dirX, dirY, dt) -> {x,y,moved}` identical across both files and unchanged from today; `actor` fields `{x,y,width,height,speed}` match existing call sites (`world.js`, `creatures.js`, `Player.js`, `reconcile.js`); stub helpers `wallColumn`/`gateColumn` share identical semantics in both suites. Golden-vector expected numbers (`{x:0,moved:false}`, `{x:68,moved:true}`, `{x:118,y:190,moved:true}`) are identical across suites. ✅
