# World Scale and Creature Density Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make world size scale with progression depth and double creature density, taking the game from 86 uniform 64×64 worlds holding 3,726 creatures to depth-ramped 96×96–224×224 worlds holding roughly 35,000–50,000.

**Architecture:** World size becomes a third progression-derived property alongside level band and density, computed by a new `deriveSize(hopFraction)` in the same pure module that already derives the other two. The generator's hand-computed 64-derived constants (`PORTAL_TILE_PX`, the entry village box) become functions of a world's own size, and the portal-coordinate pass moves after the BFS that determines size. Density rises by doubling the rates in the existing tier table — the tier keywords and the DB constraint that pins them are untouched.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert`, raw `pg`, `node-pg-migrate`. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-08-13-world-scale-and-density-design.md](../specs/2026-08-13-world-scale-and-density-design.md)

## Global Constraints

- **World sizes must be multiples of 32** (`chunk_size`), so every world divides into whole chunks. The permitted ladder is exactly `[96, 128, 160, 192, 224]`.
- **Density tier keywords do not change.** `dead|sparse|normal|dense|horde|swarm` are pinned by the `worlds_density_check` DB constraint (migration `1714440070000`). Only the `perThousand` rates change, so **no migration is required anywhere in this plan.**
- **Expected counts in tests are written as literals**, never recomputed from `DENSITY_TIERS` or `SIZE_STEPS`. A test that imports the table and recomputes the formula asserts that arithmetic works, not that the table holds the intended numbers. The existing `tests/densityTiers.test.js` header comment states this rule; follow it.
- **Never run destructive DB experiments against the shared dev database.** Re-seeding deletes and re-places non-guard creatures. Task 8 is the only task that touches the database, and it is a deliberate, announced operation.
- **Commit convention:** branch `feat/world-scale-density`, commit subject `type(scope): summary (SOMET-NNN)`, message ends with the `Co-Authored-By` trailer. Replace `SOMET-NNN` with the real ticket id once filed.
- **Definition of done** (`AGENTS.md`): backend `npm test` from `backend/`, frontend `npx vitest run` from `frontend/`, plus browser verification for anything with a UI surface.

---

## Task-to-slice mapping

The spec describes four slices; this plan has seven tasks. Two deliberate deviations:

- **The spec's Slice 3 (density rates) is folded into Task 1**, alongside the ceiling raise. They edit the same file and the same test literals, and the ceiling is raised *because* the rates double — splitting them means rewriting the same expectations twice.
- **The spec's planned bounds-guard test does not exist as a task.** `backend/tests/map_spec_fixtures.test.js` already runs `validateMapSpec` over every checked-in `*.map.json`, which covers villages, pens, road points and spawns against each world's own `width`/`height`. Tasks 5 and 6 run it as their gate instead of duplicating it.

| Spec slice | Tasks |
|---|---|
| 1 — size-agnostic pipeline | 1 (ceiling), 2, 3 |
| 2 — the depth ramp | 4, 5 |
| 3 — density | 1 |
| 4 — re-author and re-seed | 6, 7 |

## File Structure

**Modified:**
- `backend/src/services/densityTiers.js` — the density rate table, the population ceiling, and `resolveDensity`. Gains a `clamped` flag on its return value.
- `backend/src/services/worldPopulation.js` — the sole writer of hostile creature populations. Gains a log line when the ceiling truncates a world.
- `backend/scripts/dungeon/escalation.js` — pure `hopFraction` → progression-property derivation. Gains `deriveSize` beside `deriveLevelBand`/`deriveDensity`.
- `backend/scripts/dungeon/gen-p5-map-content.js` — the p5-descent generator. Its 64-derived constants become size functions, and its portal-coordinate assignment moves after the BFS.
- `backend/seeds/maps/p5-descent.map.json` — regenerated (66 worlds).
- `backend/seeds/maps/hub-vale.map.json`, `spine-descent.map.json`, `loop-catacombs.map.json` — 20 hand-authored worlds resized and their features re-placed.
- `backend/tests/densityTiers.test.js` — literal expectations updated for the new rates and ceiling.

**Created:**
- `backend/tests/p5_derive_size.test.js` — tests for `deriveSize`.

**Read but not modified (context for the implementer):**
- `backend/seeds/mapSpec.js` — the map-spec validator. Already size-relative: it checks every authored feature against that world's `width`/`height`. Nothing here needs changing.
- `backend/tests/map_spec_fixtures.test.js` — already runs `validateMapSpec` over every checked-in `*.map.json`. This is the guard that catches a feature left outside its world's new bounds; no new bounds test is needed.

---

### Task 1: Density rates and the population ceiling

Doubling the rates and raising the ceiling are one task, not two: the ceiling is raised *because* the rates double, and they share a test file whose literal expectations would otherwise have to be rewritten twice.

**Files:**
- Modify: `backend/src/services/densityTiers.js:11-18` (the tier table), `:41` (the ceiling), `:47-68` (`resolveDensity`)
- Test: `backend/tests/densityTiers.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `resolveDensity(tier, width, height)` now returns `{ scatterCount: number, packCount: number, packSizeMin: number, packSizeMax: number, clamped: boolean }`. The `clamped` field is new and is `true` exactly when the ceiling reduced `scatterCount` below the tier's target. `MAX_WORLD_CREATURES` is `4000`. Task 2 consumes `clamped`.

- [ ] **Step 1: Rewrite the failing tests**

Replace the expectation literals in `backend/tests/densityTiers.test.js`. Every count below is the new rate applied to the stated area, hand-evaluated — do not recompute them from the table.

```javascript
test('normal on a 64x64 map scatters 25 with one small pack', () => {
  assert.deepEqual(resolveDensity('normal', 64, 64),
    { scatterCount: 25, packCount: 1, packSizeMin: 3, packSizeMax: 4, clamped: false });
});

test('horde on a 64x64 map is roughly 130 creatures all told', () => {
  assert.deepEqual(resolveDensity('horde', 64, 64),
    { scatterCount: 98, packCount: 4, packSizeMin: 5, packSizeMax: 8, clamped: false });
});

test('swarm on a 64x64 map is roughly 270 creatures all told', () => {
  assert.deepEqual(resolveDensity('swarm', 64, 64),
    { scatterCount: 197, packCount: 6, packSizeMin: 8, packSizeMax: 12, clamped: false });
});

test('dead places nothing at all', () => {
  assert.deepEqual(resolveDensity('dead', 64, 64),
    { scatterCount: 0, packCount: 0, packSizeMin: 0, packSizeMax: 0, clamped: false });
});

test('sparse and dense sit either side of normal', () => {
  assert.equal(resolveDensity('sparse', 64, 64).scatterCount, 12);
  assert.equal(resolveDensity('dense', 64, 64).scatterCount, 49);
});

test('scatter scales with map area, so a 96x96 world is not sparser', () => {
  assert.equal(resolveDensity('normal', 96, 96).scatterCount, 55);
  assert.equal(resolveDensity('horde', 96, 96).scatterCount, 221);
});
```

Then replace the three ceiling tests near the end of the file:

```javascript
test('a map large enough to blow past the cap is clamped, packs included', () => {
  // normal: 1 pack of at most 4 -> 4000 - 4.
  assert.equal(resolveDensity('normal', 4096, 4096).scatterCount, 3996);
  // dense: 2 packs of at most 6 -> 4000 - 12.
  assert.equal(resolveDensity('dense', 4096, 4096).scatterCount, 3988);
  // swarm: 6 packs of at most 12 -> 4000 - 72.
  assert.equal(resolveDensity('swarm', 4096, 4096).scatterCount, 3928);
});

test('the clamped total never exceeds 4000 creatures for any tier', () => {
  assert.equal(MAX_WORLD_CREATURES, 4000);
  for (const tier of DENSITY_NAMES) {
    const d = resolveDensity(tier, 4096, 4096);
    const worstCaseTotal = d.scatterCount + d.packCount * d.packSizeMax;
    assert.ok(worstCaseTotal <= 4000,
      `${tier} on a 4096x4096 map resolves to ${worstCaseTotal} creatures`);
  }
});

// The deepest world on the size ramp is 224x224 at swarm -- 2408 creatures,
// comfortably inside the ceiling. The clamp must stay invisible to every world
// the game actually ships, which is exactly why a regression in it would go
// unnoticed without this.
test('the cap leaves every world on the size ramp untouched', () => {
  assert.equal(resolveDensity('swarm', 224, 224).scatterCount, 2408);
  assert.equal(resolveDensity('swarm', 286, 286).scatterCount, 3926);   // just under the clamp
  assert.equal(resolveDensity('swarm', 287, 287).scatterCount, 3928);   // one tile wider: clamped
});

// The flag is the whole point of SOMET-NNN's ceiling work: before it, a
// truncated world was indistinguishable from a world authored thin.
test('clamped is true only when the ceiling actually cut the target', () => {
  assert.equal(resolveDensity('swarm', 286, 286).clamped, false);
  assert.equal(resolveDensity('swarm', 287, 287).clamped, true);
  assert.equal(resolveDensity('normal', 64, 64).clamped, false);
  assert.equal(resolveDensity('dead', 4096, 4096).clamped, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/densityTiers.test.js`
Expected: FAIL — counts come back at the old rates (12, 49, 98 …), `clamped` is `undefined`, and `MAX_WORLD_CREATURES` is 2000.

- [ ] **Step 3: Double the rates and raise the ceiling**

In `backend/src/services/densityTiers.js`, replace the tier table's rates:

```javascript
const DENSITY_TIERS = {
  dead:   { perThousand: 0,  packCount: 0, packSizeMin: 0, packSizeMax: 0 },
  sparse: { perThousand: 3,  packCount: 0, packSizeMin: 0, packSizeMax: 0 },
  normal: { perThousand: 6,  packCount: 1, packSizeMin: 3, packSizeMax: 4 },
  dense:  { perThousand: 12, packCount: 2, packSizeMin: 4, packSizeMax: 6 },
  horde:  { perThousand: 24, packCount: 4, packSizeMin: 5, packSizeMax: 8 },
  swarm:  { perThousand: 48, packCount: 6, packSizeMin: 8, packSizeMax: 12 },
};
```

Leave the `dead` entry and every pack shape alone — packs are a placement flavour, not a population lever.

Change the ceiling:

```javascript
const MAX_WORLD_CREATURES = 4000;
```

Add to the block comment above `MAX_WORLD_CREATURES`, after the existing text:

```javascript
// Raised from 2000 to 4000 when the tier rates doubled (SOMET-NNN). The
// deepest world on the size ramp -- 224x224 at swarm -- resolves to 2408,
// so no world the game ships is near this; it still guards the case it was
// written for, resolveDensity('normal', 4096, 4096).
```

- [ ] **Step 4: Make the clamp observable**

Replace the body of `resolveDensity` so the truncation is reported rather than silent:

```javascript
function resolveDensity(tier, width, height) {
  const key = tier ?? DEFAULT_DENSITY;
  const t = DENSITY_TIERS[key];
  if (!t) throw new Error(`unknown density tier "${tier}"`);
  const area = (Number(width) || 0) * (Number(height) || 0);
  // Packs are absorbed into the ceiling rather than clamped themselves: the
  // largest tier asks for 6 packs of at most 12, so the pack budget is 72 in
  // the worst case and a tier's pack shape is worth preserving intact. The
  // scatter takes whatever is left, so scatter + packs never exceeds the cap
  // no matter how large the map is.
  const packBudget = t.packCount * t.packSizeMax;
  const ceiling = MAX_WORLD_CREATURES - packBudget;
  const target = Math.round((t.perThousand * area) / 1000);
  // `clamped` exists because truncation used to be invisible: a caller could
  // not tell "this world was authored thin" from "this world was cut to fit".
  // Math.max(0, ...) is defensive only -- MAX_WORLD_CREATURES is far above
  // any tier's pack budget.
  const scatterCount = Math.max(0, Math.min(target, ceiling));
  return {
    scatterCount,
    packCount: t.packCount,
    packSizeMin: t.packSizeMin,
    packSizeMax: t.packSizeMax,
    clamped: target > ceiling,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && node --test tests/densityTiers.test.js`
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/densityTiers.js backend/tests/densityTiers.test.js
git commit -m "feat(worlds): double creature density rates and raise the ceiling (SOMET-NNN)"
```

---

### Task 2: Report a truncated population instead of swallowing it

**Files:**
- Modify: `backend/src/services/worldPopulation.js:128`
- Test: `backend/tests/densityTiers.test.js` (no change; this task is verified by the existing `worldPopulation` tests plus a manual read)

**Interfaces:**
- Consumes: `resolveDensity(...).clamped` from Task 1.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the log**

In `backend/src/services/worldPopulation.js`, immediately after line 128's `const density = resolveDensity(...)`, insert:

```javascript
  // A clamped world is a content problem, not a runtime error: the author
  // asked for more creatures than one population pass may place, and got
  // fewer. Silent truncation is what this replaces -- creature_count would
  // simply come out lower than the tier implies, indistinguishable from a
  // world deliberately authored thin.
  if (density.clamped) {
    console.warn(
      `[worldPopulation] world ${worldRow.id} (${worldRow.width}x${worldRow.height}, `
      + `density "${worldRow.density ?? 'normal'}") was clamped to `
      + `${density.scatterCount} scattered creatures by MAX_WORLD_CREATURES`,
    );
  }
```

- [ ] **Step 2: Verify nothing else broke**

Run: `cd backend && node --test tests/worldPopulation*.test.js tests/densityTiers.test.js`
Expected: PASS. No world in any shipped spec trips the ceiling, so no test should newly emit this warning.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/worldPopulation.js
git commit -m "feat(worlds): log when the creature ceiling truncates a population (SOMET-NNN)"
```

---

### Task 3: Derive the generator's portal and village coordinates from world size

This task is a **behaviour-preserving refactor**. Sizes are still uniformly 64 afterwards, and `generateSpec()` must return exactly what it returned before. Task 5 is what makes sizes vary.

`gen-p5-map-content.js:21` carries `PORTAL_TILE_PX = 3250`, commented as "world-pixel center of a 64x64 world". It is `WORLD_SIZE` hand-evaluated. The entry village box at `:159` is the same thing: `min_row: 28, min_col: 28, spawn_x: 3050, spawn_y: 2950` are all offsets from a 64-world's centre tile 32.

**Files:**
- Modify: `backend/scripts/dungeon/gen-p5-map-content.js:19-21` (constants), `:159` (village box), `:356`, `:359`, `:369` (portal coordinates)
- Test: `backend/tests/p5_gen_map_content.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: two module-level functions used by Task 5 — `portalCenterPx(size: number): number` and `entryVillageBox(size: number): { min_row, min_col, width, height, gate_edge, spawn_x, spawn_y }`. Both must be added to `module.exports` so the tests can reach them.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/p5_gen_map_content.test.js`:

```javascript
const { portalCenterPx, entryVillageBox } = require('../scripts/dungeon/gen-p5-map-content');

// These two functions replace constants that were the same expressions
// hand-evaluated at size 64. At 64 they must still produce exactly the old
// literals, or this refactor silently moved every portal arrival in the spec.
test('portalCenterPx(64) reproduces the old PORTAL_TILE_PX literal', () => {
  assert.equal(portalCenterPx(64), 3250);
});

test('portalCenterPx scales to the centre tile of any world size', () => {
  assert.equal(portalCenterPx(96), 4850);
  assert.equal(portalCenterPx(128), 6450);
  assert.equal(portalCenterPx(224), 11250);
});

test('entryVillageBox(64) reproduces the old hand-written village literal', () => {
  assert.deepEqual(entryVillageBox(64), {
    min_row: 28, min_col: 28, width: 6, height: 4, gate_edge: 'S',
    spawn_x: 3050, spawn_y: 2950,
  });
});

test('entryVillageBox stays centred as the world grows', () => {
  assert.deepEqual(entryVillageBox(128), {
    min_row: 60, min_col: 60, width: 6, height: 4, gate_edge: 'S',
    spawn_x: 6250, spawn_y: 6150,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/p5_gen_map_content.test.js`
Expected: FAIL with "portalCenterPx is not a function".

- [ ] **Step 3: Replace the constants with size functions**

In `backend/scripts/dungeon/gen-p5-map-content.js`, delete the `PORTAL_TILE_PX` constant at line 21 and add, after `CHUNK_SIZE`:

```javascript
// World-pixel centre of a SIZE x SIZE world at 100 px/tile: tile index
// SIZE/2, whose centre is SIZE/2 * 100 + 50. This was the module constant
// PORTAL_TILE_PX = 3250, which is this expression hand-evaluated at
// WORLD_SIZE = 64. Once size varies per world (SOMET-NNN) it has to be
// computed from that world's own size, or a deep world's portal arrival
// lands in its top-left quadrant instead of its middle.
//
// Every size on the ramp is even, so SIZE/2 is always an integer.
function portalCenterPx(size) {
  return (size / 2) * 100 + 50;
}

// The entry village box, centred on a SIZE x SIZE world. 6x4, NOT 6x5:
// SOMET-282 caps width + height at VILLAGE_LIMITS.maxSum (10 tiles), the
// largest village whose on-screen bounding box fits in a quarter of the
// 1280x720 viewport. See services/villages.js for the derivation.
//
// The spawn sits two tiles west and three tiles north of centre -- interior
// for this box, and far enough in that the whole 64px player square lands
// inside the interior. It also avoids the merchant post and both gate-guard
// posts. At size 64 this reproduces the hand-written literal it replaces.
function entryVillageBox(size) {
  const c = size / 2;                       // centre tile index
  return {
    min_row: c - 4, min_col: c - 4, width: 6, height: 4, gate_edge: 'S',
    spawn_x: (c - 2) * 100 + 50,
    spawn_y: (c - 3) * 100 + 50,
  };
}
```

- [ ] **Step 4: Route the call sites through them**

At line 159, replace the hand-written village literal:

```javascript
      world.village = entryVillageBox(WORLD_SIZE);
```

At line 356, replace the fallback arrival:

```javascript
        : { x: portalCenterPx(WORLD_SIZE), y: portalCenterPx(WORLD_SIZE) };
```

At line 359, replace the departure point:

```javascript
        from: prevExit, from_x: portalCenterPx(WORLD_SIZE), from_y: portalCenterPx(WORLD_SIZE),
```

At line 369, replace the entry spawn:

```javascript
      entryWorld.entry_spawn = { x: portalCenterPx(WORLD_SIZE), y: portalCenterPx(WORLD_SIZE) };
```

Export both functions:

```javascript
module.exports = { generateSpec, portalCenterPx, entryVillageBox };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && node --test tests/p5_gen_map_content.test.js tests/p5_navigability.test.js tests/map_spec_fixtures.test.js`
Expected: PASS.

- [ ] **Step 6: Prove the refactor changed nothing**

The strongest check is that the generator's output is byte-identical to before the refactor.

Run:
```bash
cd backend && git stash && node -e "
  require('fs').writeFileSync('/tmp/before.json',
    JSON.stringify(require('./scripts/dungeon/gen-p5-map-content').generateSpec(), null, 2));
" && git stash pop && node -e "
  require('fs').writeFileSync('/tmp/after.json',
    JSON.stringify(require('./scripts/dungeon/gen-p5-map-content').generateSpec(), null, 2));
" && diff /tmp/before.json /tmp/after.json && echo REFACTOR-CLEAN
```
Expected: `REFACTOR-CLEAN` with no diff output. Any diff means a coordinate moved and the task is not done.

- [ ] **Step 7: Commit**

```bash
git add backend/scripts/dungeon/gen-p5-map-content.js backend/tests/p5_gen_map_content.test.js
git commit -m "refactor(mapgen): derive portal and village coords from world size (SOMET-NNN)"
```

---

### Task 4: `deriveSize` — the progression size ramp

**Files:**
- Modify: `backend/scripts/dungeon/escalation.js` (add beside `deriveDensity`)
- Create: `backend/tests/p5_derive_size.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `deriveSize(hopFraction: number): number` and `SIZE_STEPS: number[]`, both exported from `backend/scripts/dungeon/escalation.js`. Task 5 consumes `deriveSize`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/p5_derive_size.test.js`:

```javascript
// backend/tests/p5_derive_size.test.js
const test = require('node:test');
const assert = require('node:assert');
const { deriveSize, SIZE_STEPS } = require('../scripts/dungeon/escalation');

// Expected sizes are literals, not recomputed from SIZE_STEPS -- recomputing
// the bucket arithmetic from the table would assert that Math.floor works.
test('deriveSize steps through the ramp from shallow to deep', () => {
  assert.equal(deriveSize(0), 96);
  assert.equal(deriveSize(0.1), 96);
  assert.equal(deriveSize(0.25), 128);
  assert.equal(deriveSize(0.5), 160);
  assert.equal(deriveSize(0.7), 192);
  assert.equal(deriveSize(0.9), 224);
  assert.equal(deriveSize(1), 224);
});

test('deriveSize never shrinks as hopFraction rises', () => {
  let prev = 0;
  for (let i = 0; i <= 20; i++) {
    const size = deriveSize(i / 20);
    assert.ok(size >= prev, `size dropped at hopFraction ${i / 20}`);
    prev = size;
  }
});

// A world that does not divide into whole 32-tile chunks would leave a
// partial chunk at its edge, which no part of the chunk loader expects.
test('every size on the ramp is a whole number of 32-tile chunks', () => {
  for (const size of SIZE_STEPS) {
    assert.equal(size % 32, 0, `${size} is not a multiple of the chunk size`);
  }
});

test('the ramp is exactly the five sizes the design settled on', () => {
  assert.deepEqual(SIZE_STEPS, [96, 128, 160, 192, 224]);
});

// hopFraction is clamped to [0,1] by the generator before it gets here, but
// deriveSize must not index off the end of the table if that ever changes.
test('deriveSize tolerates a hopFraction at or past the top of the range', () => {
  assert.equal(deriveSize(1.5), 224);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/p5_derive_size.test.js`
Expected: FAIL with "deriveSize is not a function".

- [ ] **Step 3: Implement `deriveSize`**

In `backend/scripts/dungeon/escalation.js`, add after `deriveDensity` and before `module.exports`:

```javascript
// Progression-scaled world size in tiles (worlds are square). Same input and
// same bucket shape as deriveDensity, so all three progression properties --
// level band, density, size -- come from one hopFraction in one module.
//
// Every step is a multiple of the 32-tile chunk size, so a world always
// divides into whole chunks. The steps are chosen against a viewport that
// shows ~225 tiles at once (1280x720 with a translate-only camera and an
// isometric area scale of K^2 = 0.4096): 96x96 is ~41 screens and 224x224 is
// ~223. The old uniform 64x64 was ~18. See the design doc for the derivation.
const SIZE_STEPS = [96, 128, 160, 192, 224];
function deriveSize(hopFraction) {
  const idx = Math.min(SIZE_STEPS.length - 1, Math.floor(hopFraction * SIZE_STEPS.length));
  return SIZE_STEPS[idx];
}
```

Update the export line:

```javascript
module.exports = { deriveLevelBand, deriveDensity, deriveSize, DENSITY_ORDER, SIZE_STEPS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/p5_derive_size.test.js tests/p5_escalation.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/dungeon/escalation.js backend/tests/p5_derive_size.test.js
git commit -m "feat(mapgen): add deriveSize, the progression world-size ramp (SOMET-NNN)"
```

---

### Task 5: Wire the ramp into the generator and regenerate p5-descent

This task has an ordering problem to solve. Portal coordinates depend on world size; world size depends on `hopFraction`; `hopFraction` comes from a BFS over a graph that **includes the portal links**. The resolution is to split a portal link's *structure* (`from`/`to`/`guard`, needed by the BFS) from its *coordinates* (`from_x`/`from_y`/`to_x`/`to_y`, which need sizes), and fill the coordinates in a pass after sizes are known.

**Files:**
- Modify: `backend/scripts/dungeon/gen-p5-map-content.js:138`, `:155-159`, `:317`, `:352-370`, `:415-428`
- Modify: `backend/seeds/maps/p5-descent.map.json` (regenerated)
- Test: `backend/tests/p5_gen_map_content.test.js`

**Interfaces:**
- Consumes: `deriveSize` from Task 4; `portalCenterPx`, `entryVillageBox` from Task 3.
- Produces: a regenerated `p5-descent.map.json` where world `width`/`height` vary by depth. Task 8 seeds it.

**Known pre-existing drift — read before regenerating.** The checked-in `p5-descent.map.json` does **not** match its generator's current output. There are exactly 13 differences, all of them hand-patches that a blind regeneration would silently revert:

1. Ten surface worlds (`surface_highlands_0/1`, `surface_verdant_jungle_0/1`, `surface_storm_coast_0/1`, `surface_sunken_ruins_0/1`, `surface_ashfields_0/1`) carry `"allows_fast_travel": true`, which the generator never emits.
2. Three portal links (`d1_end→d2_hub`, `d4_end→d5_hub`, `d7_end→d8_hub`) have `"to_y": 3250` in the file but `3150` from the generator.

Both must be resolved deliberately in this task — see Steps 3 and 6.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/p5_gen_map_content.test.js`:

```javascript
test('world size varies with depth instead of being uniformly 64', () => {
  const spec = generateSpec();
  const sizes = new Set(spec.worlds.map((w) => w.width));
  assert.ok(sizes.size > 1, 'every world still has the same width');
  for (const w of spec.worlds) {
    assert.equal(w.width, w.height, `world "${w.key}" is not square`);
    assert.equal(w.width % 32, 0, `world "${w.key}" is not a whole number of chunks`);
    assert.ok(w.width >= 96 && w.width <= 224,
      `world "${w.key}" has width ${w.width}, outside the ramp`);
  }
});

test('the deepest dungeon room is larger than the entry room', () => {
  const spec = generateSpec();
  const entry = spec.worlds.find((w) => w.is_entry === true);
  const deepest = spec.worlds.reduce((a, b) => (b.width > a.width ? b : a));
  assert.ok(deepest.width > entry.width,
    `entry is ${entry.width} and the largest world is ${deepest.width}`);
});

test('every portal coordinate sits inside the world it belongs to', () => {
  const spec = generateSpec();
  const byKey = new Map(spec.worlds.map((w) => [w.key, w]));
  for (const l of spec.links.filter((x) => x.kind === 'portal')) {
    const from = byKey.get(l.from);
    const to = byKey.get(l.to);
    assert.ok(l.from_x < from.width * 100 && l.from_y < from.height * 100,
      `portal departure (${l.from_x},${l.from_y}) is outside ${l.from} (${from.width} tiles)`);
    assert.ok(l.to_x < to.width * 100 && l.to_y < to.height * 100,
      `portal arrival (${l.to_x},${l.to_y}) is outside ${l.to} (${to.width} tiles)`);
  }
});

test('the entry spawn sits at the centre of the entry world, whatever its size', () => {
  const spec = generateSpec();
  const entry = spec.worlds.find((w) => w.is_entry === true);
  assert.deepEqual(entry.entry_spawn,
    { x: portalCenterPx(entry.width), y: portalCenterPx(entry.width) });
});

test('a stamped entry village stays inside its world and carries no marker field', () => {
  const spec = generateSpec();
  for (const w of spec.worlds.filter((x) => x.village)) {
    assert.ok(w.village.min_row + w.village.height <= w.height,
      `village in "${w.key}" overruns the world`);
    assert.ok(w.village.min_col + w.village.width <= w.width,
      `village in "${w.key}" overruns the world`);
    assert.equal(w._needsVillage, undefined, `"${w.key}" leaked its marker field`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/p5_gen_map_content.test.js`
Expected: FAIL on "every world still has the same width".

- [ ] **Step 3: Defer the village stamp to a marker**

In `buildDungeon`, replace the village stamp at line 159 (the `if (skeleton.needsVillageAtEntry && room.role === 'entry')` block body) with a marker, because the world's size is not known yet:

```javascript
      // The village box is centred on the world, so it cannot be stamped
      // until deriveSize has run. Mark the room and let generateSpec's
      // finalisation pass stamp it; the marker is deleted there so it never
      // reaches the JSON.
      world._needsVillage = true;
```

- [ ] **Step 4: Build portal links without coordinates**

In `generateSpec`, replace the `portalLinks.push({...})` call (lines ~357-363) with the structure-only form, and delete the `destEntryWorld`/`arrival` lines above it that computed coordinates:

```javascript
      // Structure only. The BFS below needs from/to to compute hop distance,
      // and hop distance is what decides each world's size -- so coordinates,
      // which depend on size, cannot be filled until after that. The
      // finalisation pass at the end of this function fills them.
      portalLinks.push({
        kind: 'portal',
        from: prevExit,
        to: built.entryKey,
        guard: { creature_type: dungeon.guardCreature, count: 1 },
      });
```

In the `else` branch, delete the `entryWorld.entry_spawn = ...` assignment entirely (the finalisation pass sets it). Keep `entryWorld.is_entry = true;` and `d1EntryKey = built.entryKey;`.

- [ ] **Step 5: Assign sizes in the hopFraction pass**

In the `for (const w of allWorlds)` loop (around line 415), add the size assignment beside the existing two:

```javascript
    w.level_band = deriveLevelBand(hopFraction, dungeon.tierClamp);
    w.density = deriveDensity(hopFraction);
    // Third progression-scaled property from the same hopFraction. Assigned
    // here rather than in buildDungeon because hop distance is only known
    // once the whole graph is assembled.
    w.width = deriveSize(hopFraction);
    w.height = w.width;
```

`buildDungeon` still sets `width: WORLD_SIZE, height: WORLD_SIZE` at line 138, before any size is known. Replace those with explicit nulls rather than deleting the keys — assigning `w.width` later would otherwise move both keys to the end of every world object and churn 56 worlds' key order in the regenerated JSON for no reason:

```javascript
      width: null, height: null, chunk_size: CHUNK_SIZE,   // set by the size pass in generateSpec
```

Surface worlds are not in `allWorlds` and keep their hand-set `level_band`/`density`. Give them the ramp's shallowest step, since they graft onto D1/D2. In `buildSurfaceWorlds`, replace `width: WORLD_SIZE, height: WORLD_SIZE` (line ~317) with:

```javascript
      // Surface worlds graft onto D1/D2, the two shallowest dungeons, and
      // carry hand-set shallow bands -- so they take the ramp's first step
      // rather than going through deriveSize.
      width: SURFACE_SIZE, height: SURFACE_SIZE, chunk_size: CHUNK_SIZE,
```

and add, beside `CHUNK_SIZE`:

```javascript
const SURFACE_SIZE = 96;    // the size ramp's shallowest step
```

Finally, delete the now-unused `WORLD_SIZE` constant at line 19 and its remaining references from Task 3's call sites (they move into the finalisation pass below).

- [ ] **Step 6: Add the finalisation pass**

In `generateSpec`, immediately after the `for (const w of allWorlds)` loop that assigns sizes and before the `SEED_OVERRIDES` assertion block, insert:

```javascript
  // Everything below depends on a world's final size, so it runs after the
  // size assignment above and nowhere earlier.
  const sizedByKey = new Map([...allWorlds, ...surfaceWorlds].map((w) => [w.key, w]));

  // Stamp the deferred entry villages now that sizes are known.
  for (const w of allWorlds) {
    if (!w._needsVillage) continue;
    delete w._needsVillage;
    w.village = entryVillageBox(w.width);
  }

  // The sole is_entry world spawns new characters at its centre.
  const entryWorld = sizedByKey.get(d1EntryKey);
  entryWorld.entry_spawn = {
    x: portalCenterPx(entryWorld.width),
    y: portalCenterPx(entryWorld.width),
  };

  // Portal coordinates. Hub-topology destinations have a village stamped at
  // their entry room -- arrive at the village's gate cell, not the fixed
  // world-centre tile, or the arrival lands on the village's south wall
  // (SOMET-251). Spine/loop destinations have no village at their entry room,
  // so they keep the centre-tile convention.
  for (const l of portalLinks) {
    const from = sizedByKey.get(l.from);
    const to = sizedByKey.get(l.to);
    l.from_x = portalCenterPx(from.width);
    l.from_y = portalCenterPx(from.width);
    const arrival = to.village
      ? villageGateArrival(to.village)
      : { x: portalCenterPx(to.width), y: portalCenterPx(to.width) };
    l.to_x = arrival.x;
    l.to_y = arrival.y;
  }
```

Note this makes `villageGateArrival` the single source of the three arrivals that the checked-in file has hand-patched to `to_y: 3250`. **Those three arrivals will now come out at the gate cell** (`3150` at size 64, and the size-scaled equivalent otherwise). That is the intended behaviour: the hand-patched `3250` was the correct value for the *old 6×5* village box and is one tile outside the current 6×4 box. The generator becomes authoritative here.

Key-ordering note: assigning `l.from_x` after construction puts those keys after `guard` in the emitted JSON, changing key order in the file. That is cosmetic, but to keep the diff readable, construct the object in Step 4 with the coordinate keys present and set to `null`, in their original positions:

```javascript
      portalLinks.push({
        kind: 'portal',
        from: prevExit, from_x: null, from_y: null,
        to: built.entryKey, to_x: null, to_y: null,
        guard: { creature_type: dungeon.guardCreature, count: 1 },
      });
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd backend && node --test tests/p5_gen_map_content.test.js tests/p5_derive_size.test.js tests/p5_navigability.test.js`
Expected: PASS.

- [ ] **Step 8: Regenerate the spec, preserving the fast-travel hand-patch**

The generator does not emit `allows_fast_travel`, and 10 surface worlds in the checked-in file carry it. Teach the generator to emit it rather than re-patching by hand — in `buildSurfaceWorlds`, add to the pushed world object:

```javascript
      // The 10 surface worlds are fast-travel destinations. This was a hand
      // patch on the checked-in spec that the generator did not know about,
      // so any regeneration silently dropped it (SOMET-NNN).
      allows_fast_travel: true,
```

Then regenerate:

```bash
cd backend && node scripts/dungeon/gen-p5-map-content.js
```
Expected output: `Wrote 66 worlds, 67 links to .../p5-descent.map.json`

- [ ] **Step 9: Confirm the diff contains only intended changes**

Run: `git diff --stat backend/seeds/maps/p5-descent.map.json`

Then confirm no `allows_fast_travel` was lost:
```bash
grep -c '"allows_fast_travel": true' backend/seeds/maps/p5-descent.map.json
```
Expected: `10`.

Confirm the spec still validates:
```bash
cd backend && node --test tests/map_spec_fixtures.test.js
```
Expected: PASS. This is the gate that catches any feature now sitting outside its world's bounds.

- [ ] **Step 10: Commit**

```bash
git add backend/scripts/dungeon/gen-p5-map-content.js backend/tests/p5_gen_map_content.test.js backend/seeds/maps/p5-descent.map.json
git commit -m "feat(mapgen): scale world size with progression depth (SOMET-NNN)"
```

---

### Task 6: Resize the hand-authored worlds

`deriveSize` does not reach the three hand-authored specs — a world whose spec still says 64 stays 64. These 20 worlds get explicit sizes and their features re-placed.

Only **five** worlds carry authored features. The other 15 need nothing but a `width`/`height` change.

**The re-placement rule.** Features are laid out around the centre tile of a 64-tile world (tile 32). For a world growing from `old` to `new`, the translation delta is `new/2 - old/2` tiles, or `delta * 100` world pixels. Apply it to every tile coordinate (`min_row`, `min_col`, road points) and every pixel coordinate (`spawn_x`, `spawn_y`, waypoint `x`/`y`, `entry_spawn`). **Exception:** a road endpoint that ran to a map edge (`1` or `62`) must be re-anchored to the new edge — `1` stays `1`, and `62` becomes `new - 2` — or the road dead-ends mid-map.

**Files:**
- Modify: `backend/seeds/maps/hub-vale.map.json`, `backend/seeds/maps/spine-descent.map.json`, `backend/seeds/maps/loop-catacombs.map.json`
- Test: `backend/tests/map_spec_fixtures.test.js` (existing; no change)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: three resized spec files. Task 8 seeds them.

- [ ] **Step 1: Set the new sizes**

Set `width` and `height` on every world to the value below, sized by depth within its own spec.

| spec | world key | old | new |
|---|---|---|---|
| hub-vale | `hub` | 96 | 128 |
| hub-vale | `forest`, `dunes`, `frozen`, `mire` | 64 | 96 |
| spine-descent | `entry` | 64 | 96 |
| spine-descent | `pass`, `cache` | 64 | 128 |
| spine-descent | `elite`, `gorge` | 64 | 160 |
| spine-descent | `shrine`, `deep` | 64 | 192 |
| spine-descent | `end` | 64 | 224 |
| loop-catacombs | `entry`, `crypt` | 64 | 128 |
| loop-catacombs | `eastwing`, `southwing` | 64 | 160 |
| loop-catacombs | `farhall`, `deepvault` | 64 | 192 |
| loop-catacombs | `heart` | 64 | 224 |

Leave `chunk_size: 32` unchanged everywhere.

- [ ] **Step 2: Re-place the features in `hub-vale.map.json`**

`hub` (96 → 128, delta +16 tiles / +1600 px):

```json
      "village": { "min_row": 44, "min_col": 44, "width": 6, "height": 4, "gate_edge": "E", "spawn_x": 4650, "spawn_y": 4550 },
      "entry_spawn": { "x": 6450, "y": 6450 }
```

`forest` (64 → 96, delta +16 tiles / +1600 px; road edge `62` → `94`):

```json
      "village": { "min_row": 41, "min_col": 44, "width": 6, "height": 4, "gate_edge": "S", "spawn_x": 4550, "spawn_y": 4250 },
      "roads": [[[48, 1], [48, 94]], [[45, 47], [48, 47]]],
      "pens": [{ "min_row": 52, "min_col": 30, "width": 6, "height": 5, "creature_type": "Woodland Swarm", "count": 5, "level": 1 }],
      "waypoints": [{ "x": 4650, "y": 4250, "name": "Thornbriar Green" }]
```

- [ ] **Step 3: Re-place the features in `spine-descent.map.json`**

`entry` (64 → 96, delta +16 tiles / +1600 px; road edge `62` → `94`):

```json
      "village": { "min_row": 47, "min_col": 46, "width": 6, "height": 4, "gate_edge": "S", "spawn_x": 4750, "spawn_y": 4850 },
      "roads": [[[48, 1], [48, 43], [53, 43], [53, 55], [48, 55], [48, 94]], [[51, 49], [53, 49]]],
      "pens": [
        { "min_row": 28, "min_col": 49, "width": 6, "height": 5, "creature_type": "Beast Swarm", "count": 5, "level": 1 },
        { "min_row": 52, "min_col": 31, "width": 6, "height": 5, "creature_type": "Woodland Swarm", "count": 5, "level": 1 }
      ],
      "waypoints": [{ "x": 4850, "y": 4850, "name": "Old Trailhead Commons" }],
      "entry_spawn": { "x": 4750, "y": 4850 }
```

`pass` (64 → 128, delta +32 tiles / +3200 px; road edges `62` → `126`):

```json
      "village": { "min_row": 56, "min_col": 70, "width": 6, "height": 4, "gate_edge": "S", "spawn_x": 7150, "spawn_y": 5750 },
      "roads": [[[64, 1], [64, 126]], [[1, 64], [126, 64]], [[60, 73], [64, 73]]],
      "pens": [{ "min_row": 42, "min_col": 68, "width": 6, "height": 5, "creature_type": "Beast Swarm", "count": 5, "level": 2 }],
      "waypoints": [{ "x": 7250, "y": 5750, "name": "Windwatch Waystone" }]
```

- [ ] **Step 4: Re-place the features in `loop-catacombs.map.json`**

`entry` (64 → 128, delta +32 tiles / +3200 px):

```json
      "entry_spawn": { "x": 6450, "y": 6450 }
```

No other world in this spec has authored features.

- [ ] **Step 5: Validate every spec**

Run: `cd backend && node --test tests/map_spec_fixtures.test.js tests/authored_roads.test.js`
Expected: PASS. This checks each village, pen, road point and spawn against its world's new `width`/`height`; a feature left un-translated fails here with the bounds in the message.

- [ ] **Step 6: Run the whole backend suite**

Run: `cd backend && npm test`
Expected: PASS. Note that database-backed tests are skipped unless `TEST_DATABASE_URL` is set; run them explicitly if the suite reports skips.

- [ ] **Step 7: Commit**

```bash
git add backend/seeds/maps/hub-vale.map.json backend/seeds/maps/spine-descent.map.json backend/seeds/maps/loop-catacombs.map.json
git commit -m "feat(maps): resize the hand-authored worlds onto the size ramp (SOMET-NNN)"
```

---

### Task 7: Re-seed and verify in a browser

A green suite cannot tell you that a resized world actually generates terrain to its new edges, that a translated road still connects its village, or that a portal arrival is standable. This project has repeatedly shipped inert changes past a green suite. This task is not optional.

**Files:**
- No source changes. Database and browser only.

**Interfaces:**
- Consumes: the four spec files from Tasks 5 and 6.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Confirm the stack is running**

Run: `docker ps --format '{{.Names}}\t{{.Status}}' | grep something2`
Expected: `something2-frontend-1`, `something2-backend-1`, `something2-db-1` all up.

- [ ] **Step 2: Record the before state**

Run:
```bash
docker exec something2-db-1 psql -U user -d game_db -c \
  "SELECT count(*) AS worlds, count(DISTINCT width) AS distinct_widths FROM worlds;" -c \
  "SELECT count(*) AS creatures FROM world_creatures;"
```
Expected before seeding: 86 worlds, 1 distinct width (or 2, counting Vale Crossing's 96), 3,726 creatures.

- [ ] **Step 3: Seed each spec**

Re-seeding deletes and re-places non-guard creatures and drops each world's cached terrain. Do not run this while anyone is mid-session.

`seed-map.js` takes its spec from the `SPEC` environment variable, not a path argument, and the name omits the `.map.json` suffix:

```bash
make seed-map SPEC=hub-vale
make seed-map SPEC=loop-catacombs
make seed-map SPEC=spine-descent
make seed-map SPEC=p5-descent
```

Each run prints a summary line (`applied <name>: N worlds, N links, …`). Read it: a run reporting 0 creatures means the populate pass did not place anything.

- [ ] **Step 3b: Restart the backend — mandatory**

`seed-map.js` ends every run by printing `NOTE: if the backend is running, RESTART IT.` It cannot clear the backend's world-preview cache, its minimap overview cache, or its in-memory copy of a live world, so all three keep serving the **old 64×64 terrain** until the process restarts.

Skipping this makes Step 6's browser check verify the pre-change world and report a false pass.

```bash
docker restart something2-backend-1
```

- [ ] **Step 4: Confirm the after state**

Run:
```bash
docker exec something2-db-1 psql -U user -d game_db -c \
  "SELECT width, count(*) FROM worlds GROUP BY width ORDER BY width;" -c \
  "SELECT count(*) AS creatures FROM world_creatures;" -c \
  "SELECT w.name, w.width, w.density, count(c.id) AS creatures
     FROM worlds w LEFT JOIN world_creatures c ON c.world_id = w.id
    GROUP BY w.name, w.width, w.density ORDER BY creatures DESC LIMIT 5;"
```
Expected: widths spread across 96/128/160/192/224; total creatures in the 35,000–50,000 range. A total still near 3,726 means seeding did not run.

- [ ] **Step 5: Check the backend log for clamp warnings**

Run: `docker logs something2-backend-1 --since 10m | grep worldPopulation`
Expected: no output. Any `was clamped` line means a world resolved past the ceiling and came out thinner than authored — investigate before proceeding.

- [ ] **Step 6: Browser verification**

Open the client, log in, and confirm each of the following. Take a screenshot of each.

1. **Terrain reaches the new edges.** Walk the entry world (`Old Trailhead`, now 96×96) from its centre to a map edge in one direction. The wall ring must appear at the edge, with generated terrain the whole way — not a seam or void partway out where the old 64 boundary was.
2. **The village is intact and centred.** Its gate, merchant post and guards are all present, and the player spawns inside the village interior rather than on a wall.
3. **The road connects.** The translated road in `Old Trailhead` runs from the map edge to the village without dead-ending mid-map.
4. **A portal arrival is standable.** Cross one inter-dungeon portal and confirm you arrive on walkable ground, not inside a wall or outside the village.
5. **Creature density reads as intended.** A deep swarm world should be visibly crowded; the shallow entry world should not.
6. **The minimap is correct.** Open it (`M`) in a resized world and confirm the player marker's position matches the world's actual extent rather than being pinned to a quadrant.

- [ ] **Step 7: Run the full suite one last time**

Run: `cd backend && npm test` and `cd frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit any fixes and open the PR**

```bash
git add -A
git commit -m "chore(maps): re-seed all worlds onto the size ramp (SOMET-NNN)"
```

---

## Follow-up ticket to file before this epic closes

**Creature respawn.** Killed creatures are deleted permanently (`backend/src/authority/loot.js:75`) and `populateWorld` is only ever called by `seed-map.js` and the admin re-roll route. There is no timer, cron, or on-join repopulation anywhere. This plan raises the starting pool roughly tenfold but does not change its shape: the pool still only drains, and a world emptied by a group stays empty until an operator re-rolls it. File this as its own ticket — the spec's "Out of scope" section has the detail.

## Known risks carried into implementation

- **Traversal time.** A 224×224 world is 12× today's area and the game allows one waypoint per world (migration `1714440270000_one_waypoint_per_world`). If the deep end reads as tedious in Task 7's browser pass, lower `SIZE_STEPS`' top entries — nothing else in this plan depends on those specific numbers.
- **The three changed portal arrivals.** Task 5 makes `villageGateArrival` authoritative for the `d1_end→d2_hub`, `d4_end→d5_hub` and `d7_end→d8_hub` arrivals, overriding a hand patch. Task 7's browser check #4 is what confirms that was right.
- **Surface worlds bypass `deriveSize`.** They take a fixed `SURFACE_SIZE = 96` because their bands and densities are hand-set rather than derived. If they should ramp too, that is a follow-up, not a silent change here.
