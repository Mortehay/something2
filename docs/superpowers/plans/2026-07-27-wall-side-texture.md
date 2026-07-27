# Wall Side-Face Texture Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make wall vertical (side) faces render the wall's stone texture like the top face, instead of the flat dark-blue that appears now.

**Architecture:** `drawTexturedFace` in `wallRenderer.js` maps the wall image onto each side parallelogram, but it uses `ctx.setTransform(...)`, which *replaces* the whole matrix and discards the camera pan installed by `Camera.apply` (`ctx.translate(GAME_WIDTH/2 − screenX, …)`). The texture is drawn ~a thousand px off its clipped face, so the face shows the `#0f3460` canvas background. Fix: compose the affine onto the current transform with `ctx.transform(...)` (inside a nested `save`/`restore`) so the texture lands in the same space as the clip, and draw the depth-shade under the camera transform too. Also lighten the depth-shade so the stone reads clearly.

**Tech Stack:** Vanilla JS, Canvas 2D. Tests: Vitest. No new dependencies. Frontend-only (no backend, no parity concern).

## Global Constraints

- **Frontend-only**, confined to `frontend/src/games/something2/src/js/systems/wallRenderer.js` and its test. No backend, no other renderer files.
- The texture-mapping approach (affine onto the side parallelogram, clipped) stays; only the *transform composition* is corrected. Do NOT call `ctx.setTransform` anywhere in `wallRenderer.js` after this change — `setTransform` replaces the camera transform and is the bug. Use `ctx.transform` (compose) inside `save`/`restore`.
- Side faces show the SAME texture as the top with a **subtle** depth darkening (lighter than the current `0.28`/`0.45`), keeping the left face slightly lighter than the right for a lit 3-D read. Starting values: left `rgba(0,0,0,0.12)`, right `rgba(0,0,0,0.22)`; the color-only (no-image) branch uses the matching `shadeColor(color, -0.12)` / `shadeColor(color, -0.22)`.
- The real verification is on-screen (canvas rendering); the unit test only pins that the camera transform is no longer clobbered.

---

## File Structure

- `frontend/src/games/something2/src/js/systems/wallRenderer.js` — fix `drawTexturedFace` transform composition; lighten the four shade values (two in the textured branch, two in the color-only branch of `drawWall`).
- `frontend/src/games/something2/src/js/systems/__tests__/wallRenderer.test.js` — add a mock-`ctx` regression test asserting `drawWall`'s textured branch composes (`ctx.transform`) and never clobbers (`ctx.setTransform`).

---

### Task 1: Fix side-face texture rendering + subtle shade + regression test

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/wallRenderer.js:45-60` (drawTexturedFace) and `:81-91` (shade values in drawWall)
- Test: `frontend/src/games/something2/src/js/systems/__tests__/wallRenderer.test.js`

**Interfaces:**
- Consumes: a Canvas2D-like `ctx` with `save/restore/beginPath/moveTo/lineTo/closePath/clip/transform/drawImage/fill` and `fillStyle`/`globalAlpha` setters; `visual = { img, crop, cacheKey }`; `tileCache.get(cacheKey, img, crop) -> canvas`.
- Produces: no signature changes. `drawTexturedFace` and `drawWall` keep their exact parameter lists.

- [ ] **Step 1: Write the failing regression test**

Add to `frontend/src/games/something2/src/js/systems/__tests__/wallRenderer.test.js`. First extend the import on line 2 to include `drawWall`:

```js
import { wallFaces, compareDrawables, wallRevealed, shadeColor, drawWall } from '../wallRenderer.js';
```

Then add this block:

```js
describe('drawWall textured side faces', () => {
  // A recording 2D-context stub: captures the ordered method calls so we can
  // assert HOW the side texture is drawn (composed vs. matrix-replaced).
  function recordingCtx() {
    const calls = [];
    const rec = (name) => (...args) => calls.push({ name, args });
    return {
      calls,
      save: rec('save'), restore: rec('restore'),
      beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
      closePath: rec('closePath'), clip: rec('clip'),
      transform: rec('transform'), setTransform: rec('setTransform'),
      drawImage: rec('drawImage'), fill: rec('fill'),
      set fillStyle(v) { calls.push({ name: 'fillStyle', args: [v] }); },
      set globalAlpha(v) { calls.push({ name: 'globalAlpha', args: [v] }); },
    };
  }

  const visual = { img: { width: 32, height: 32 }, crop: null, cacheKey: 'k' };
  const tileCache = { get: () => ({ fake: 'canvas' }) };
  const args = () => ({
    s: { x: 500, y: 400 }, def: { color: '#abcabc' }, visual,
    H: 48, alpha: 1, halfW: 64, halfH: 32, tileCache,
  });

  it('composes the affine onto the camera transform (never replaces it) for side faces', () => {
    const ctx = recordingCtx();
    drawWall(ctx, args());
    const names = ctx.calls.map((c) => c.name);
    // The two side faces must compose via transform()...
    expect(names.filter((n) => n === 'transform').length).toBe(2);
    // ...and MUST NOT call setTransform, which would drop the camera pan (the bug).
    expect(names).not.toContain('setTransform');
  });

  it('draws the side texture image (not just a solid fill)', () => {
    const ctx = recordingCtx();
    drawWall(ctx, args());
    // 2 side-face images + 1 top = 3 drawImage calls.
    expect(ctx.calls.filter((c) => c.name === 'drawImage').length).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/wallRenderer.test.js`
Expected: the first new test FAILS — current code calls `setTransform` (twice per face) and `transform` zero times.

- [ ] **Step 3: Fix `drawTexturedFace` to compose the transform**

Replace the `drawTexturedFace` function (lines 45-60) with:

```js
// Map an image (or crop) onto a parallelogram face defined by 3 corners:
// p0 (origin), p1 (image +x edge end), p3 (image +y edge end). Clips to the
// face, draws the texture skewed, then a translucent shade for a depth cue.
function drawTexturedFace(ctx, img, crop, p0, p1, p3, p2, shade) {
  const [sx, sy, sw, sh] = crop || [0, 0, img.width, img.height];
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.closePath();
  ctx.clip();
  // Affine: image (sw×sh) -> parallelogram p0->p1 (x), p0->p3 (y). COMPOSE onto
  // the current (camera) transform via transform() — setTransform() would REPLACE
  // it and drop the camera pan, drawing the texture far off its clipped face
  // (the bug that left the sides showing the flat canvas background).
  const ux = (p1.x - p0.x) / sw, uy = (p1.y - p0.y) / sw;
  const vx = (p3.x - p0.x) / sh, vy = (p3.y - p0.y) / sh;
  ctx.save();
  ctx.transform(ux, uy, vx, vy, p0.x, p0.y);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  ctx.restore(); // back to the camera transform; the clip path is still current
  ctx.fillStyle = shade;
  ctx.fill(); // shade the same clipped parallelogram, in camera space
  ctx.restore();
}
```

- [ ] **Step 4: Lighten the depth-shade values in `drawWall`**

In `drawWall`, change the two textured-face shade args (lines 81 and 83):

```js
      // left face p0=liftedLeft, p1=liftedBottom, p3=groundLeft, p2=groundBottom
      drawTexturedFace(ctx, visual.img, crop, f.left[0], f.left[1], f.left[3], f.left[2], 'rgba(0,0,0,0.12)');
      // right face p0=liftedBottom, p1=liftedRight, p3=groundBottom, p2=groundRight
      drawTexturedFace(ctx, visual.img, crop, f.right[0], f.right[1], f.right[3], f.right[2], 'rgba(0,0,0,0.22)');
```

And the two color-only (no-image) branch shades (lines 90-91):

```js
      fillQuad(ctx, f.left, shadeColor(color, -0.12));
      fillQuad(ctx, f.right, shadeColor(color, -0.22));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/wallRenderer.test.js`
Expected: both new tests PASS; the existing `wallFaces`/`compareDrawables`/`wallRevealed`/`shadeColor` tests still PASS.

- [ ] **Step 6: Run the full frontend suite**

Run: `cd frontend && npm test`
Expected: all pass (no other file touched).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/wallRenderer.js \
        frontend/src/games/something2/src/js/systems/__tests__/wallRenderer.test.js
git commit -m "fix(render): texture wall side faces (compose camera transform, not replace)"
```

---

## Verification (post-implementation — REQUIRED, this is the real gate)

Unit tests only prove the transform is no longer clobbered. The visual result MUST be checked on the live dev stack (see the `dev-run-browser-verify` memory):

1. Checkout/merge the branch into the **main working dir** so vite hot-reloads it.
2. Move the player next to a `map_wall`/`wooden_wall` block.
3. Confirm the vertical side faces now show the **same stone texture as the top**, subtly darker (not flat dark-blue).
4. Confirm the block still reads as 3-D (top vs sides distinguishable) and the left face is slightly lighter than the right.
5. Move the camera around (walk) — the side texture must stay correctly mapped at all camera positions (the bug was camera-pan-dependent, so this is the key check).
6. If the texture looks stretched/misaligned on the tall (48px) face, note it — a `crop`/scale tune in `drawTexturedFace` may follow, but first confirm the transform fix lands the texture in the right place.

---

## Self-Review

**1. Spec coverage.** Camera-transform-clobber root cause → Task 1 Step 3 (`transform` compose + nested save/restore, shade fill in camera space). Subtle shade → Step 4 (0.12/0.22 textured + matching color-only). Frontend-only, `drawTexturedFace`-scoped → Global Constraints + File Structure. No-`setTransform` guarantee → Step 3 removes both; regression test asserts it. Browser gate → Verification section. ✅

**2. Placeholder scan.** No TBD/"handle edge cases"/"similar to"; full code for the fixed function, the exact four shade edits, and the complete test. ✅

**3. Type consistency.** `drawTexturedFace(ctx, img, crop, p0, p1, p3, p2, shade)` and `drawWall(ctx, {...})` signatures unchanged; `visual = {img, crop, cacheKey}` matches `resolveTileVisual`'s return; the mock `ctx`/`tileCache`/`visual` in the test match what `drawWall` calls. The regression test's `transform`-count (2) and `drawImage`-count (3 = 2 sides + 1 top) match the code paths in Step 3/4. ✅
