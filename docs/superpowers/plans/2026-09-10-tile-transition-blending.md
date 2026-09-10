# Tile Transition Blending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a boundary between two isometric tile types read as an organic edge with scattered decals instead of a 45-degree staircase of whole diamonds.

**Architecture:** Every overlay is anchored on the LOSING cell: for a cell whose neighbour has a higher `blend_priority`, we draw that neighbour's texture masked by a procedural organic shape *inside the losing cell's own diamond*. The winner's side is already painted by its own base tile, so an overlay never leaves its host cell. Overlay canvases therefore share the existing 132x68 base-diamond footprint, intrusion is capped at one tile by construction, and the existing per-tile cull stays correct. A new render pass A1 runs after all base tiles, sorted by `blend_priority` ascending.

**Tech Stack:** Vanilla JS canvas 2D (frontend game), React 19 + styled-components (admin), Express + `pg` + `node-pg-migrate` (backend), `vitest` (frontend tests), `node:test` + `supertest` (backend tests).

**Spec:** `docs/superpowers/specs/2026-09-10-tile-transition-blending-design.md`

## Global Constraints

- **Cosmetic only.** No change to collision, walkability, movement speed, the chunk protocol, or the authority. Do not edit anything under `backend/src/authority/`.
- **Migration timestamp must be `1714440600000`.** It leaves a wide gap above the current highest (`1714440546000`). This repo has repeatedly hit migration-order collisions between parallel sessions.
- If `Not run migration X is preceding Y` appears, run `node backend/scripts/repair-migration-order.js`. **Never** pass `--no-check-order`.
- **Shared checkout.** Several Claude sessions share `/home/markunn/worker/coding/jsgame/something2`. Never run `git checkout`, `git stash`, or `git branch` in it. Always `git add <explicit path>`, never `git add -A` or `git add .`.
- **Editing `backend/src/**` restarts the API** (nodemon watches `src` only, since `ca4de4b`) and kills any running art batch. Editing `backend/tests/`, `backend/migrations/`, `backend/seeds/`, `backend/scripts/` is safe.
- **Backend DB tests need `TEST_DATABASE_URL`** pointing at a scratch database. Without it they silently skip (or, worse, older tests hit the shared dev DB). Never run a destructive query against the dev database.
- Renderer terminology, fixed for the whole plan: **`shape`** is one of `lobed | fingers | torn | drip`; **`depth`** is one of `deep | shallow`. (The design doc calls both of these "families"; this plan uses the two distinct names and they are what the code must use.)

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/migrations/1714440600000_tile_blend_priority.js` | CREATE. Adds `tile_types.blend_priority` and seeds ranks by name. |
| `backend/seeds/data/tileTypes.js` | MODIFY. `blend_priority` on each row, so a re-seed does not undo the migration. |
| `backend/src/services/tileTypes.js` | MODIFY. Map the new column in `loadTileTypes`'s explicit object literal. |
| `backend/src/index.js` | MODIFY. `blend_priority` in the tile_types `UPDATE`, COALESCE-guarded. |
| `backend/tests/tile_blend_priority_route.test.js` | CREATE. Pins the omitted-field guard, mocked and end-to-end. |
| `frontend/src/games/something2/catalogValidation.js` | MODIFY. Bound `blend_priority` client-side. |
| `frontend/src/games/something2/TileTypesAdmin.jsx` | MODIFY. The number input + form state. |
| `frontend/src/games/something2/tileTypeForm.js` | CREATE. Pure form-state builder, replacing the two inline `useEffect` branches. |
| `frontend/src/games/something2/__tests__/tileTypeForm.test.js` | CREATE. Asserts the field round-trips through BOTH branches. |
| `frontend/.../src/js/systems/tileBlend.js` | CREATE. **Pure, no canvas.** Neighbour selection, priority rule, wall exclusion, non-walkable clamp, deterministic variant/shape hash, scatter quantisation. |
| `frontend/.../src/js/systems/blendMasks.js` | CREATE. Canvas-only. Rasterises the four shapes at two depths into an alpha mask. |
| `frontend/.../src/js/systems/tileTexture.js` | MODIFY. `buildBlendCanvas`; LRU bound on `TileDiamondCache`. |
| `frontend/.../src/js/systems/RenderSystem.js` | MODIFY. Pass A1 + a dev toggle. |

`frontend/.../src/js/` is shorthand for `frontend/src/games/something2/src/js/` throughout.

---

## Task 1: The `blend_priority` column and its ranks

**Files:**
- Create: `backend/migrations/1714440600000_tile_blend_priority.js`
- Modify: `backend/seeds/data/tileTypes.js`
- Modify: `backend/src/services/tileTypes.js:11-31`

**Interfaces:**
- Consumes: nothing.
- Produces: `tile_types.blend_priority integer NOT NULL DEFAULT 0`; `loadTileTypes(db)` returns objects that now carry `blend_priority: number`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/tile_blend_priority_route.test.js` with only this first case for now:

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { loadTileTypes } = require('../src/services/tileTypes.js');

const DB_URL = process.env.TEST_DATABASE_URL;

function requireTestDb(t, why) {
  if (!DB_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

test('loadTileTypes exposes blend_priority, and grass outranks rocks', async (t) => {
  if (!requireTestDb(t, 'reads tile_types')) return;
  const pool = new Pool({ connectionString: DB_URL });
  t.after(() => pool.end());
  const tiles = await loadTileTypes(pool);

  // The column reaches the game at all. loadTileTypes does SELECT * but then
  // builds an EXPLICIT object literal, so an unmapped column is silently
  // dropped between the database and the renderer.
  assert.equal(typeof tiles.grass.blend_priority, 'number',
    'blend_priority must be mapped in loadTileTypes, not just present in the table');

  // The ladder has the direction the renderer depends on: loose material
  // grows over solid, and a road grows over everything.
  assert.ok(tiles.grass.blend_priority > tiles.rocks.blend_priority,
    'grass must outrank rocks or grass will never grow over stone');
  assert.ok(tiles.road_stone.blend_priority > tiles.grass.blend_priority,
    'roads must outrank every terrain');
  assert.ok(tiles.water.blend_priority < tiles.sand.blend_priority,
    'water must be outranked by sand or the shoreline grows the wrong way');
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /home/markunn/worker/coding/jsgame/something2/backend
createdb -h localhost -p 15432 -U user s2_blend_scratch 2>/dev/null || true
export TEST_DATABASE_URL='postgres://user:password@localhost:15432/s2_blend_scratch'
export DATABASE_URL="$TEST_DATABASE_URL"
npx node-pg-migrate up
node scripts/seed-catalogs.js
node --test tests/tile_blend_priority_route.test.js
```

Do NOT write `export A=..  B="$A"` on one line — the second variable comes out empty in that form and has faked a regression here before. Two separate `export` lines, as above.

Expected: FAIL — `blend_priority must be mapped in loadTileTypes` (the property is `undefined`).

- [ ] **Step 3: Write the migration**

Create `backend/migrations/1714440600000_tile_blend_priority.js`:

```js
exports.shorthands = undefined;

// SOMET tile-transition blending. Which of two adjacent tile types visibly
// grows over the other: the HIGHER blend_priority wins and its texture is
// painted, organically masked, into the loser's diamond.
//
// The ladder is "looseness": loose material drifts over solid material, and a
// road is laid over everything. Ties draw nothing, which is why all five
// road_* tiles share one rank -- road meeting road must be a clean seam, not
// two materials fighting.
//
// Default 0 is deliberately the BOTTOM of the ladder: a tile type added later
// and never ranked simply never grows over anything, which is inert rather
// than wrong.
exports.up = (pgm) => {
  pgm.addColumns('tile_types', {
    blend_priority: { type: 'integer', notNull: true, default: 0 },
  });
  // Idempotent, keyed by name -- the same shape as 1714440038000's wall_height
  // seeding. A name absent from this database is simply not updated.
  const rank = (n, names) => pgm.sql(
    `UPDATE tile_types SET blend_priority = ${n} WHERE name IN (${names.map((s) => `'${s}'`).join(', ')})`
  );
  rank(10, ['water', 'cistern_shallows', 'chasm']);
  rank(20, ['ice', 'rime_floor', 'crystal_floor']);
  rank(30, ['rocks', 'highland_rock', 'cobblestone', 'ruin_stone', 'crypt_floor',
            'bone_floor', 'cave_floor', 'vault_floor', 'foundry_floor', 'titan_floor',
            'sanctum_floor', 'storm_shingle', 'umbral_floor', 'void_floor',
            'dream_floor', 'chaos_floor', 'maw_floor', 'rubble']);
  rank(40, ['earth', 'swamp', 'ember_rock', 'brimstone', 'hive_floor']);
  rank(50, ['dirt', 'blight_floor', 'plague_floor', 'fungal_floor']);
  rank(60, ['sand', 'ash_waste']);
  rank(70, ['grass', 'highgrass', 'leafs', 'jungle_floor']);
  rank(80, ['snow']);
  rank(90, ['road_dirt', 'road_stone', 'road_sand', 'road_snow', 'road_ash']);
};

exports.down = (pgm) => {
  pgm.dropColumns('tile_types', ['blend_priority']);
};
```

- [ ] **Step 4: Map the column in the loader**

In `backend/src/services/tileTypes.js`, inside the `tileTypes[row.name] = { ... }` literal, add after `place_order`:

```js
      place_order: row.place_order ?? 0,
      // Which of two adjacent types grows over the other (higher wins).
      // This literal is EXPLICIT even though the query is SELECT *, so a
      // column added to the table but not added here never reaches the
      // renderer -- the same trap services/biomes.js documents for path_tile.
      blend_priority: row.blend_priority ?? 0
```

- [ ] **Step 5: Add the ranks to the seed file**

The migration alone is not enough: `backend/scripts/seed-catalogs.js` re-seeds from `backend/seeds/data/tileTypes.js`, and a re-seed would undo the migration's ranks. This repo has shipped that exact bug before (a migration repaired a world's spawn and a re-seed undid it).

In `backend/seeds/data/tileTypes.js`, add `blend_priority: <n>` to every row, using the same numbers as the migration. For example:

```js
  { name: 'grass', color: '#00FF00', walkable: true, speed: 1, image: '', blend_priority: 70, valid_neighbors: ['grass', 'highgrass', 'leafs', 'sand', 'earth'], prompt: floor('lush green meadow grass') },
  { name: 'rocks', color: '#808080', walkable: true, speed: 0.8, image: '', blend_priority: 30, valid_neighbors: ['rocks', 'earth', 'snow', 'dirt'], prompt: floor('grey rocky stone ground') },
  { name: 'water', color: '#3b82f6', walkable: false, speed: 0, image: '', blend_priority: 10, valid_neighbors: ['water', 'sand', 'ice', 'swamp'], prompt: floor('clear blue water surface, scattered foam flecks') },
  { name: 'road_stone', color: '#9a958b', walkable: true, speed: 1.2, image: '', blend_priority: 90, valid_neighbors: [], prompt: floor('dressed pale flagstone paving') },
```

Then find the INSERT that consumes these rows (search `seed-catalogs.js` for `tile_types`) and add `blend_priority` to its column list and values. Structural tiles (`map_wall`, `wooden_wall`, `map_doorway`, `village_gate`, `cave_wall`) keep the default `0` — they are excluded from blending anyway by their `wall_height`.

- [ ] **Step 6: Re-run the test to verify it passes**

```bash
cd /home/markunn/worker/coding/jsgame/something2/backend
export TEST_DATABASE_URL='postgres://user:password@localhost:15432/s2_blend_scratch'
export DATABASE_URL="$TEST_DATABASE_URL"
npx node-pg-migrate up
node scripts/seed-catalogs.js --force
node --test tests/tile_blend_priority_route.test.js
```

Expected: PASS, 1 test. Note `--force`: without it the seeder can decide the catalog is already populated and change nothing, leaving you debugging a database that was never written.

- [ ] **Step 7: Commit**

```bash
cd /home/markunn/worker/coding/jsgame/something2
git add backend/migrations/1714440600000_tile_blend_priority.js \
        backend/seeds/data/tileTypes.js \
        backend/src/services/tileTypes.js \
        backend/scripts/seed-catalogs.js \
        backend/tests/tile_blend_priority_route.test.js
git commit -m "feat(tiles): add blend_priority, the tile-transition ladder"
```

---

## Task 2: Guard the admin UPDATE against a form that omits the field

**Files:**
- Modify: `backend/src/index.js:1963-1975`
- Modify: `backend/tests/tile_blend_priority_route.test.js`

**Interfaces:**
- Consumes: `tile_types.blend_priority` from Task 1.
- Produces: `PUT /api/tile-types/:id` accepts an optional `blend_priority`; when absent from the body the stored value is unchanged.

**Why this task exists as its own gate:** the route's `SET` list is explicit, and `wall_height`/`place_order` are bound as `Number(x) || 0` — omit them and they reset to zero. `blend_priority` bound the same way would mean **every unrelated tile save silently un-tunes the whole map**, with both requests answering 200 so nothing looks wrong. That is precisely the bug that reverted an approved tile texture on this route; the comment block at `backend/src/index.js:1950` describes it. The partial fix then was a `NULLIF` guard that covered only one case, and `entity_types` still carries the unguarded version — so a guard alone is not sufficient evidence. It needs a test that omits the field.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/tile_blend_priority_route.test.js`:

```js
const request = require('supertest');
const { adminToken } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

// Mocked half: pin the PARAMETER the route binds. The guard is
// COALESCE($n, tile_types.blend_priority), so "omitted" must arrive as null --
// not 0, which would silently write the bottom rank.
test('PUT binds null for blend_priority when the body omits it', async (t) => {
  const calls = [];
  __setPool({
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT token_version/.test(sql)) return { rows: [{ token_version: 1, role: 'admin' }] };
      if (/SELECT name FROM tile_types/.test(sql)) return { rows: [{ name: 'grass' }] };
      if (/^\s*UPDATE tile_types/.test(sql)) return { rows: [{ id: 1, name: 'grass' }] };
      return { rows: [] };
    },
  });
  t.after(() => __setPool(null));

  await request(app).put('/api/tile-types/1').set(...AUTH).send({
    name: 'grass', color: '#00FF00', walkable: true, speed: 1,
    valid_neighbors: [], prompt: '', wall_height: 0, place_order: 0,
    // blend_priority deliberately absent -- this is what the form sends today
  }).expect(200);

  const update = calls.find((c) => /^\s*UPDATE tile_types/.test(c.sql));
  assert.ok(update, 'the route must have issued an UPDATE');
  assert.match(update.sql, /blend_priority = COALESCE\(/,
    'blend_priority must be COALESCE-guarded, not bound bare');
  assert.ok(update.params.includes(null),
    'an omitted blend_priority must bind null so COALESCE keeps the stored rank');
});

// End-to-end half: a route proven only against a mock proves nothing about
// whether the column it names exists. This is the case that actually catches
// the regression.
test('saving a tile without blend_priority does not reset its rank', async (t) => {
  if (!requireTestDb(t, 'writes tile_types')) return;
  const pool = new Pool({ connectionString: DB_URL });
  t.after(() => pool.end());
  __setPool(pool);
  t.after(() => __setPool(null));

  const { rows } = await pool.query(
    `SELECT id, name, color, walkable, speed, blend_priority
       FROM tile_types WHERE name = 'grass'`);
  const grass = rows[0];
  assert.ok(grass.blend_priority > 0, 'fixture precondition: grass must be ranked');

  await request(app).put(`/api/tile-types/${grass.id}`).set(...AUTH).send({
    name: grass.name, color: grass.color, walkable: grass.walkable,
    speed: grass.speed, valid_neighbors: [], prompt: '',
    wall_height: 0, place_order: 0,
  }).expect(200);

  const after = await pool.query('SELECT blend_priority FROM tile_types WHERE id = $1', [grass.id]);
  assert.equal(after.rows[0].blend_priority, grass.blend_priority,
    'an unrelated save must not change the rank');
});

test('an explicit blend_priority in the body IS written', async (t) => {
  if (!requireTestDb(t, 'writes tile_types')) return;
  const pool = new Pool({ connectionString: DB_URL });
  t.after(() => pool.end());
  __setPool(pool);
  t.after(() => __setPool(null));

  const { rows } = await pool.query(
    `SELECT id, name, color, walkable, speed, blend_priority FROM tile_types WHERE name = 'dirt'`);
  const dirt = rows[0];
  t.after(() => pool.query('UPDATE tile_types SET blend_priority = $1 WHERE id = $2',
    [dirt.blend_priority, dirt.id]));

  await request(app).put(`/api/tile-types/${dirt.id}`).set(...AUTH).send({
    name: dirt.name, color: dirt.color, walkable: dirt.walkable, speed: dirt.speed,
    valid_neighbors: [], prompt: '', wall_height: 0, place_order: 0,
    blend_priority: 55,
  }).expect(200);

  const after = await pool.query('SELECT blend_priority FROM tile_types WHERE id = $1', [dirt.id]);
  assert.equal(after.rows[0].blend_priority, 55);
});
```

If `./helpers/auth.js` does not export `adminToken`, read `backend/tests/affix_routes.test.js` and copy the auth setup it actually uses.

- [ ] **Step 2: Run to verify they fail**

```bash
cd /home/markunn/worker/coding/jsgame/something2/backend
export TEST_DATABASE_URL='postgres://user:password@localhost:15432/s2_blend_scratch'
node --test tests/tile_blend_priority_route.test.js
```

Expected: the three new tests FAIL. The first on `blend_priority must be COALESCE-guarded`; the third because the route never writes the column.

- [ ] **Step 3: Add the guarded column to the UPDATE**

In `backend/src/index.js`, in the tile_types `UPDATE` (~line 1963), add a `SET` clause after `art_biome` and shift the id parameter:

```js
        art_biome = COALESCE($12, tile_types.art_biome),
        -- COALESCE for the same reason art_biome has it, and it matters more
        -- here: the form is a snapshot taken at modal-open, and wall_height /
        -- place_order above are bound `Number(x) || 0`, so an omitted field
        -- silently writes 0. For a RANK, 0 is the bottom of the ladder -- one
        -- unrelated save would stop that material growing over anything, with
        -- a 200 and no error anywhere. Tested by omitting the key entirely in
        -- tests/tile_blend_priority_route.test.js.
        blend_priority = COALESCE($13, tile_types.blend_priority),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $14 RETURNING *`,
      [name, color, walkable, speed, JSON.stringify(valid_neighbors), prompt || '',
        Number(wall_height) || 0, Number(place_order) || 0,
        pinSent, pin.mode, pin.id,
        typeof art_biome === 'string' ? art_biome : null,
        Number.isInteger(blend_priority) ? blend_priority : null, id]
```

`Number.isInteger(...) ? ... : null` is the important half: `Number(undefined) || 0` would produce `0` and defeat the COALESCE. Add `blend_priority` to the handler's `req.body` destructuring at the top of the route.

- [ ] **Step 4: Run to verify they pass**

```bash
cd /home/markunn/worker/coding/jsgame/something2/backend
export TEST_DATABASE_URL='postgres://user:password@localhost:15432/s2_blend_scratch'
node --test tests/tile_blend_priority_route.test.js
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd /home/markunn/worker/coding/jsgame/something2
git add backend/src/index.js backend/tests/tile_blend_priority_route.test.js
git commit -m "fix(tiles): an omitted blend_priority must not reset the rank"
```

---

## Task 3: The admin form field

**Files:**
- Create: `frontend/src/games/something2/tileTypeForm.js`
- Create: `frontend/src/games/something2/__tests__/tileTypeForm.test.js`
- Modify: `frontend/src/games/something2/catalogValidation.js`
- Modify: `frontend/src/games/something2/TileTypesAdmin.jsx:426-475,680-702`

**Interfaces:**
- Consumes: `PUT /api/tile-types/:id` accepting `blend_priority` (Task 2).
- Produces:
  - `tileTypeToForm(row)` -> the form-state object, for both the edit and the add case (`row` null/undefined = add).
  - `validateTileType(f)` rejects a non-integer or out-of-range `blend_priority` with a string message.

**Why the extraction:** the form's state is built inline in a `useEffect` with **two branches** — one for editing an existing tile, one for adding a new one. The failure that matters is adding the field to only the add branch: `blend_priority` would then submit as `undefined` on every edit, Task 2's `COALESCE` would dutifully keep the old value, and **the admin's edit would silently do nothing**. Nothing automated would catch that.

`frontend/src/games/something2/` already has eight `*Form.js` modules (`abilityForm.js`, `biomeForm.js`, `itemTypeForm.js`, ...) that exist for exactly this reason — vitest runs in a `node` environment with no DOM, so the pure form/payload mapping is the part that can actually be tested. `tileTypeForm.js` follows that established convention rather than inventing a render harness.

**Note on file naming:** `frontend/vitest.config.js` has `include: ["src/**/*.test.js"]` — **`.test.jsx` is not matched and would never run**. Every test file in this plan ends in `.test.js`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/__tests__/tileTypeForm.test.js`:

```js
import { describe, it, expect } from "vitest";
import { tileTypeToForm } from "../tileTypeForm.js";
import { validateTileType, MAX_BLEND_PRIORITY } from "../catalogValidation.js";

const ROW = {
  id: 4, name: "grass", color: "#00FF00", walkable: true, speed: 1,
  wall_height: 0, place_order: 0, blend_priority: 70,
  prompt: "lush grass", valid_neighbors: ["grass", "sand"],
  ai_provider_mode: null, ai_provider_id: null, art_biome: "",
};

describe("tileTypeToForm", () => {
  // THE test for this task. Adding the field to only one branch is the
  // failure mode: an edit would then submit blend_priority undefined, the
  // route's COALESCE would keep the stored rank, and the admin's change
  // would silently do nothing with a 200 and no error anywhere.
  it("carries blend_priority through the EDIT branch", () => {
    expect(tileTypeToForm(ROW).blend_priority).toBe(70);
  });

  it("defaults blend_priority to 0 in the ADD branch", () => {
    expect(tileTypeToForm(null).blend_priority).toBe(0);
  });

  it("keeps a stored rank of 0 rather than treating it as missing", () => {
    // `|| 0` and `?? 0` agree here, but a future `|| DEFAULT` would not --
    // 0 is a legitimate stored rank meaning "never grows over anything".
    expect(tileTypeToForm({ ...ROW, blend_priority: 0 }).blend_priority).toBe(0);
  });

  it("still carries every field the form already had", () => {
    const f = tileTypeToForm(ROW);
    expect(f.name).toBe("grass");
    expect(f.speed).toBe(1);
    expect(f.wall_height).toBe(0);
    expect(f.place_order).toBe(0);
    expect(f.valid_neighbors).toEqual(["grass", "sand"]);
  });

  it("never holds `image` -- the texture is owned by Approve, not this form", () => {
    // Re-pins the fix that stopped Save Changes reverting an approved
    // texture. A field re-added here would revive it.
    expect(tileTypeToForm({ ...ROW, image: "tiles/grass-abc.png" }))
      .not.toHaveProperty("image");
  });
});

describe("validateTileType blend_priority", () => {
  const base = { name: "grass", speed: 1, wall_height: 0, place_order: 0 };

  it("accepts an integer rank in range", () => {
    expect(validateTileType({ ...base, blend_priority: 70 })).toBeNull();
  });

  it("accepts the field being absent (it is optional)", () => {
    expect(validateTileType({ ...base })).toBeNull();
  });

  it("rejects a negative rank", () => {
    expect(validateTileType({ ...base, blend_priority: -1 })).toMatch(/blend/i);
  });

  it("rejects a fractional rank", () => {
    expect(validateTileType({ ...base, blend_priority: 12.5 })).toMatch(/blend/i);
  });

  it("rejects a rank above the ceiling", () => {
    expect(validateTileType({ ...base, blend_priority: MAX_BLEND_PRIORITY + 1 }))
      .toMatch(/blend/i);
  });
});
```

`validateTileType` returns `null` when valid and a message string otherwise — confirm that convention at `catalogValidation.js:64` before relying on it.

- [ ] **Step 2: Run to verify it fails**

```bash
cd /home/markunn/worker/coding/jsgame/something2/frontend
npx vitest run src/games/something2/__tests__/tileTypeForm.test.js
```

Expected: FAIL — `Failed to resolve import "../tileTypeForm.js"`.

- [ ] **Step 3: Extract the form-state builder**

Create `frontend/src/games/something2/tileTypeForm.js` by moving **both branches** of the existing `useEffect` in `TileTypesAdmin.jsx` (~lines 437-475) into one pure function. Copy the field list from the current code verbatim — do not retype it from memory:

```js
// Pure form-state builder for one tile_types row, split out the same way
// abilityForm.js and biomeForm.js are: frontend vitest runs in a node
// environment with no DOM, so this is the part that can actually be tested.
//
// It exists as ONE function with a null case rather than as the two inline
// branches it replaces. Those branches had to be kept in step by hand, and a
// field added to only one of them fails silently: the edit case submits
// `undefined`, the route's COALESCE keeps the stored value, and the admin's
// change appears to save (200) while changing nothing.
import { pinToSelectValue } from './providerForm.js';

// `row` null/undefined is the ADD case.
export function tileTypeToForm(row) {
  const adding = !row;
  return {
    name: adding ? '' : row.name,
    // s2-theme-exempt(#00ff00, #000000): tile data defaults, not chrome.
    color: adding ? '#00ff00' : row.color,
    walkable: adding ? true : row.walkable,
    speed: adding ? 1.0 : row.speed,
    wall_height: adding ? 0 : (row.wall_height || 0),
    place_order: adding ? 0 : (row.place_order || 0),
    // `?? 0`, not `|| 0`: 0 is a legitimate stored rank meaning "never grows
    // over anything", and must round-trip rather than being re-defaulted.
    blend_priority: adding ? 0 : (row.blend_priority ?? 0),
    // `image` is deliberately NOT held here. There is no image input in this
    // form -- it was snapshotted at modal-open and sent straight back on save,
    // which reverted any texture approved in between. The texture is owned by
    // Approve (POST /api/tile-types/:id/image) and the PUT no longer writes
    // the column at all.
    prompt: adding ? '' : (row.prompt || ''),
    valid_neighbors: adding ? [] : (row.valid_neighbors || []),
    provider_pin: adding ? '' : pinToSelectValue(row.ai_provider_mode, row.ai_provider_id),
    art_biome: adding ? '' : (row.art_biome || ''),
  };
}
```

Check where `pinToSelectValue` is actually imported from in `TileTypesAdmin.jsx` and import it from the same module; if it is defined locally in that file, move it or import it rather than duplicating it.

- [ ] **Step 4: Add the validation**

In `frontend/src/games/something2/catalogValidation.js`, add near `MAX_CATALOG_NAME_LEN`:

```js
// The ladder migration 1714440600000 seeds runs 10..90. The ceiling is
// generous headroom for hand-tuning, not a claim about the seeded values.
export const MAX_BLEND_PRIORITY = 999;
```

and inside `validateTileType(f)`, before its final `return null`:

```js
  if (f.blend_priority !== undefined && f.blend_priority !== null && f.blend_priority !== '') {
    if (!isNonNegInt(f.blend_priority) || f.blend_priority > MAX_BLEND_PRIORITY) {
      return `Blend priority must be a whole number from 0 to ${MAX_BLEND_PRIORITY}`;
    }
  }
```

- [ ] **Step 5: Run to verify it passes**

```bash
cd /home/markunn/worker/coding/jsgame/something2/frontend
npx vitest run src/games/something2/__tests__/tileTypeForm.test.js
```

Expected: PASS, 10 tests.

- [ ] **Step 6: Use the extracted builder and add the input**

Two edits in `frontend/src/games/something2/TileTypesAdmin.jsx`:

1. Replace the whole two-branch `useEffect` body with the call, and drop the now-dead `useState` initial literal duplication:

```jsx
import { tileTypeToForm } from './tileTypeForm.js';

  const [formData, setFormData] = useState(() => tileTypeToForm(null));

  useEffect(() => {
    setFormData(tileTypeToForm(editingTile));
  }, [editingTile, isModalOpen]);
```

2. The markup (~line 700), a third `FormGroup` in the flex row beside Place Order:

```jsx
                <FormGroup style={{ flex: 1 }}>
                  <label>Blend Priority</label>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    value={formData.blend_priority}
                    onChange={e => setFormData({...formData, blend_priority: parseInt(e.target.value, 10) || 0})}
                  />
                </FormGroup>
```

- [ ] **Step 7: Verify the whole frontend suite still passes**

```bash
cd /home/markunn/worker/coding/jsgame/something2/frontend
npx vitest run
```

Expected: PASS, no new failures. The extraction touched every field the modal edits, so a regression here means a field was dropped in the move — diff `tileTypeToForm` against the original `useEffect` field by field rather than guessing.

- [ ] **Step 8: Commit**

```bash
cd /home/markunn/worker/coding/jsgame/something2
git add frontend/src/games/something2/tileTypeForm.js         frontend/src/games/something2/__tests__/tileTypeForm.test.js         frontend/src/games/something2/catalogValidation.js         frontend/src/games/something2/TileTypesAdmin.jsx
git commit -m "feat(admin): edit a tile's blend priority, via a testable form seam"
```

---

## Task 4: `tileBlend.js` — neighbour selection and the four rules

**Files:**
- Create: `frontend/src/games/something2/src/js/systems/tileBlend.js`
- Create: `frontend/src/games/something2/src/js/systems/__tests__/tileBlend.test.js`

**Interfaces:**
- Consumes: `chunkedMap.getTileAt(worldX, worldY)` (world PIXELS, `MAP_TILE_SIZE` = 100 per tile); tile defs carrying `blend_priority`, `wall_height`, `walkable`.
- Produces:
  - `NEIGHBOR_STEPS: Array<[dr, dc]>` — 8 entries, index = bit position in `dirBits`.
  - `blendOverlaysFor(tileName, worldX, worldY, chunkedMap, defs) -> Array<{overType: string, dirBits: number, depth: 'deep'|'shallow'}>` sorted by the winner's `blend_priority` ascending. Tasks 5 and 9 add `variant`, `shape`, `scatterLevel`, `scatterDir` and `cacheKey` to each element.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/src/js/systems/__tests__/tileBlend.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { blendOverlaysFor, NEIGHBOR_STEPS } from '../tileBlend.js';
import { MAP_TILE_SIZE as T } from '../../core/constants.js';

const DEFS = {
  grass:  { blend_priority: 70, wall_height: 0, walkable: true },
  rocks:  { blend_priority: 30, wall_height: 0, walkable: true },
  dirt:   { blend_priority: 50, wall_height: 0, walkable: true },
  water:  { blend_priority: 10, wall_height: 0, walkable: false },
  sand:   { blend_priority: 60, wall_height: 0, walkable: true },
  wall:   { blend_priority: 95, wall_height: 48, walkable: false },
};

// A minimal stand-in for ChunkedMap: `grid` is keyed "row,col" in TILE units,
// and anything absent answers null the way an unloaded chunk does.
function mapOf(grid) {
  return {
    getTileAt(worldX, worldY) {
      const col = Math.floor(worldX / T), row = Math.floor(worldY / T);
      const v = grid[`${row},${col}`];
      return v === undefined ? null : v;
    },
  };
}

// The cell under test always sits at tile (0,0) => world pixel centre (50,50).
const CX = T / 2, CY = T / 2;
const at = (dr, dc, name) => [`${dr},${dc}`, name];

describe('blendOverlaysFor', () => {
  it('a lower-ranked cell ringed by one higher type yields one overlay with all 8 bits', () => {
    const grid = Object.fromEntries([
      at(0, 0, 'rocks'),
      ...NEIGHBOR_STEPS.map(([dr, dc]) => at(dr, dc, 'grass')),
    ]);
    const out = blendOverlaysFor('rocks', CX, CY, mapOf(grid), DEFS);
    expect(out).toHaveLength(1);
    expect(out[0].overType).toBe('grass');
    expect(out[0].dirBits).toBe(0xff);
  });

  it('sets exactly the bit matching the neighbour direction', () => {
    for (let i = 0; i < NEIGHBOR_STEPS.length; i++) {
      const [dr, dc] = NEIGHBOR_STEPS[i];
      const out = blendOverlaysFor('rocks', CX, CY,
        mapOf(Object.fromEntries([at(0, 0, 'rocks'), at(dr, dc, 'grass')])), DEFS);
      expect(out).toHaveLength(1);
      expect(out[0].dirBits).toBe(1 << i);
    }
  });

  it('groups two different winning types into two overlays, loosest last', () => {
    const out = blendOverlaysFor('rocks', CX, CY, mapOf(Object.fromEntries([
      at(0, 0, 'rocks'), at(-1, 0, 'dirt'), at(1, 0, 'grass'),
    ])), DEFS);
    expect(out.map((o) => o.overType)).toEqual(['dirt', 'grass']);
  });

  it('equal ranks draw nothing', () => {
    const out = blendOverlaysFor('grass', CX, CY, mapOf(Object.fromEntries([
      at(0, 0, 'grass'), at(-1, 0, 'grass'), at(0, 1, 'grass'),
    ])), DEFS);
    expect(out).toEqual([]);
  });

  it('a lower-ranked neighbour draws nothing (the loser never paints the winner)', () => {
    const out = blendOverlaysFor('grass', CX, CY, mapOf(Object.fromEntries([
      at(0, 0, 'grass'), at(-1, 0, 'rocks'),
    ])), DEFS);
    expect(out).toEqual([]);
  });

  it('a null neighbour is not a boundary', () => {
    // Only the cell itself is loaded. Treating null as "a different type"
    // would ring the whole streaming frontier in bogus overlays.
    const out = blendOverlaysFor('rocks', CX, CY, mapOf(Object.fromEntries([
      at(0, 0, 'rocks'),
    ])), DEFS);
    expect(out).toEqual([]);
  });

  it('a wall neighbour never sources an overlay', () => {
    const out = blendOverlaysFor('rocks', CX, CY, mapOf(Object.fromEntries([
      at(0, 0, 'rocks'), at(-1, 0, 'wall'),
    ])), DEFS);
    expect(out).toEqual([]);
  });

  it('a wall host never receives one', () => {
    const out = blendOverlaysFor('wall', CX, CY, mapOf(Object.fromEntries([
      at(0, 0, 'wall'), at(-1, 0, 'grass'),
    ])), DEFS);
    expect(out).toEqual([]);
  });

  it('clamps to shallow when the HOST is non-walkable', () => {
    const out = blendOverlaysFor('water', CX, CY, mapOf(Object.fromEntries([
      at(0, 0, 'water'), at(-1, 0, 'sand'),
    ])), DEFS);
    expect(out[0].depth).toBe('shallow');
  });

  it('clamps to shallow when the WINNER is non-walkable', () => {
    const defs = { ...DEFS, water: { ...DEFS.water, blend_priority: 99 } };
    const out = blendOverlaysFor('sand', CX, CY, mapOf(Object.fromEntries([
      at(0, 0, 'sand'), at(-1, 0, 'water'),
    ])), defs);
    expect(out[0].depth).toBe('shallow');
  });

  it('uses deep when both sides are walkable', () => {
    const out = blendOverlaysFor('rocks', CX, CY, mapOf(Object.fromEntries([
      at(0, 0, 'rocks'), at(-1, 0, 'grass'),
    ])), DEFS);
    expect(out[0].depth).toBe('deep');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /home/markunn/worker/coding/jsgame/something2/frontend
npx vitest run src/games/something2/src/js/systems/__tests__/tileBlend.test.js
```

Expected: FAIL — `Failed to resolve import "../tileBlend.js"`.

- [ ] **Step 3: Write the module**

Create `frontend/src/games/something2/src/js/systems/tileBlend.js`:

```js
import { MAP_TILE_SIZE } from '../core/constants.js';

// Which of two adjacent tile types visibly grows over the other, and what
// shape that growth takes. PURE -- no canvas, no DOM, no imageManager. Every
// rule that decides what a boundary looks like lives here so it can be tested
// in the node env; blendMasks.js only rasterises what this decides.
//
// The overlay is anchored on the LOSING cell: for a cell whose neighbour
// outranks it, we paint the NEIGHBOUR's texture, organically masked, inside
// THIS cell's diamond. The winner's own base tile already covers its side, so
// an overlay never leaves its host cell -- which is what keeps overlay
// canvases the same 132x68 as base diamonds and keeps the existing per-tile
// cull correct with no companion.

// Neighbour steps as [dr, dc] in TILE units. The array index IS the bit
// position in `dirBits`, and `dirBits` is part of the render cache key, so
// REORDERING THIS ARRAY SILENTLY INVALIDATES EVERY CACHED OVERLAY and rotates
// every mask. Append never, reorder never.
//
// In isometric projection the four grid-orthogonal neighbours share a diamond
// EDGE and the four grid-diagonals meet at a diamond VERTEX, so even bits are
// edge roots and odd bits are vertex roots -- blendMasks.js relies on that.
export const NEIGHBOR_STEPS = [
  [-1,  0], // 0  top-right edge
  [-1,  1], // 1  right vertex
  [ 0,  1], // 2  bottom-right edge
  [ 1,  1], // 3  bottom vertex
  [ 1,  0], // 4  bottom-left edge
  [ 1, -1], // 5  left vertex
  [ 0, -1], // 6  top-left edge
  [-1, -1], // 7  top vertex
];

const rank = (def) => (def && def.blend_priority) || 0;
const isWall = (def) => !!def && (def.wall_height || 0) > 0;

export function blendOverlaysFor(tileName, worldX, worldY, chunkedMap, defs) {
  const self = defs && defs[tileName];
  // A wall is deferred to the depth-sorted pass and never drawn as a flat
  // diamond, so it can neither host an overlay nor source one.
  if (!self || isWall(self)) return [];
  const selfRank = rank(self);

  const byType = new Map();
  for (let i = 0; i < NEIGHBOR_STEPS.length; i++) {
    const [dr, dc] = NEIGHBOR_STEPS[i];
    // getTileAt takes WORLD PIXELS, not tile indices.
    const n = chunkedMap.getTileAt(
      worldX + dc * MAP_TILE_SIZE,
      worldY + dr * MAP_TILE_SIZE,
    );
    // null is an UNLOADED chunk at the streaming frontier, not a different
    // material. Treating it as a boundary would ring the entire loaded
    // neighbourhood in overlays that vanish as chunks arrive.
    if (n == null || n === tileName) continue;
    const over = defs[n];
    if (!over || isWall(over)) continue;
    // Strictly greater: a tie draws nothing. All five road_* tiles share one
    // rank, so road meeting road is a clean seam rather than two materials
    // fighting over the same pixels.
    if (rank(over) <= selfRank) continue;
    byType.set(n, (byType.get(n) || 0) | (1 << i));
  }

  const out = [];
  for (const [overType, dirBits] of byType) {
    // Deep intrusion lets the visible material boundary disagree with the
    // collision/speed boundary by up to a full tile. For walkable pairs that
    // is a speed lie and is accepted deliberately. Where either side is
    // impassable it would instead read as a bug -- a player clicks visible
    // grass and is blocked by nothing -- so those clamp to shallow.
    const depth = (self.walkable === false || defs[overType].walkable === false)
      ? 'shallow' : 'deep';
    out.push({ overType, dirBits, depth });
  }
  // Ascending, so where three materials meet the loosest ends up on top.
  out.sort((a, b) => rank(defs[a.overType]) - rank(defs[b.overType]));
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd /home/markunn/worker/coding/jsgame/something2/frontend
npx vitest run src/games/something2/src/js/systems/__tests__/tileBlend.test.js
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
cd /home/markunn/worker/coding/jsgame/something2
git add frontend/src/games/something2/src/js/systems/tileBlend.js \
        frontend/src/games/something2/src/js/systems/__tests__/tileBlend.test.js
git commit -m "feat(render): pure neighbour selection for tile transitions"
```

---

## Task 5: Deterministic shape and variant selection

**Files:**
- Modify: `frontend/.../src/js/systems/tileBlend.js`
- Modify: `frontend/.../src/js/systems/__tests__/tileBlend.test.js`

**Interfaces:**
- Produces: `BLEND_SHAPES: ['lobed','fingers','torn','drip']`, `BLEND_VARIANTS: 6`, and each overlay element gains `shape: string`, `variant: number` (0..5), `cacheKey: string` of the form `` `${overType}|${dirBits}|${variant}|${depth}|${shape}` ``.

- [ ] **Step 1: Write the failing test**

Append to `tileBlend.test.js`:

```js
import { BLEND_SHAPES, BLEND_VARIANTS } from '../tileBlend.js';

describe('blend variant selection', () => {
  const oneNeighbour = (row, col) => {
    const grid = { [`${row},${col}`]: 'rocks', [`${row - 1},${col}`]: 'grass' };
    return blendOverlaysFor('rocks', col * T + T / 2, row * T + T / 2, mapOf(grid), DEFS)[0];
  };

  it('is stable: the same cell yields the same variant and shape every call', () => {
    const a = oneNeighbour(3, 7), b = oneNeighbour(3, 7);
    expect(a.variant).toBe(b.variant);
    expect(a.shape).toBe(b.shape);
    expect(a.cacheKey).toBe(b.cacheKey);
  });

  it('varies across cells -- a constant hash would make every boundary identical', () => {
    // This is the assertion that matters. A hash returning a constant keeps
    // every other test in this file green while the whole map uses one pattern.
    const keys = new Set();
    for (let row = 0; row < 12; row++) {
      for (let col = 0; col < 12; col++) keys.add(oneNeighbour(row, col).cacheKey);
    }
    expect(keys.size).toBeGreaterThan(8);
  });

  it('stays inside the declared shape and variant sets', () => {
    for (let col = 0; col < 40; col++) {
      const o = oneNeighbour(0, col);
      expect(BLEND_SHAPES).toContain(o.shape);
      expect(o.variant).toBeGreaterThanOrEqual(0);
      expect(o.variant).toBeLessThan(BLEND_VARIANTS);
    }
  });

  it('shape and variant are not correlated', () => {
    // Derived from one hash without distinct salts, every `lobed` cell would
    // also be variant 0 and the library would collapse to four patterns.
    const seen = new Set();
    for (let col = 0; col < 60; col++) {
      const o = oneNeighbour(1, col);
      seen.add(`${o.shape}:${o.variant}`);
    }
    expect(seen.size).toBeGreaterThan(6);
  });

  it('a different winning type over the same cell gets a different key', () => {
    const grid = { '0,0': 'rocks', '-1,0': 'grass' };
    const grassKey = blendOverlaysFor('rocks', CX, CY, mapOf(grid), DEFS)[0].cacheKey;
    const grid2 = { '0,0': 'rocks', '-1,0': 'dirt' };
    const dirtKey = blendOverlaysFor('rocks', CX, CY, mapOf(grid2), DEFS)[0].cacheKey;
    expect(grassKey).not.toBe(dirtKey);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /home/markunn/worker/coding/jsgame/something2/frontend
npx vitest run src/games/something2/src/js/systems/__tests__/tileBlend.test.js
```

Expected: FAIL — `BLEND_SHAPES` is not exported and `o.variant` is `undefined`.

- [ ] **Step 3: Implement the hash**

Add to `tileBlend.js`, above `blendOverlaysFor`:

```js
export const BLEND_SHAPES = ['lobed', 'fingers', 'torn', 'drip'];
export const BLEND_VARIANTS = 6;

// Distinct salts, so `shape` and `variant` are independent draws. Deriving
// both from one hash correlates them: every `lobed` cell would also be
// variant 0 and the library would collapse from 24 patterns to 4.
const SALT_SHAPE = 0x9e3779b9;
const SALT_VARIANT = 0x85ebca6b;

// FNV-1a over the type name. Short, stable, and no dependency.
function strHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Integer hash of a tile coordinate pair plus a type, salted. Must stay a pure
// function of position: the same cell has to pick the same pattern on every
// frame, after a chunk unload and reload, and for every player.
function hash3(tx, ty, typeHash, salt) {
  let h = (salt ^ Math.imul(tx | 0, 0x27d4eb2d)) >>> 0;
  h = (h ^ Math.imul(ty | 0, 0x165667b1)) >>> 0;
  h = (h ^ typeHash) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2545f491); h ^= h >>> 13;
  return h >>> 0;
}

export function blendPattern(worldX, worldY, overType) {
  const tx = Math.floor(worldX / MAP_TILE_SIZE);
  const ty = Math.floor(worldY / MAP_TILE_SIZE);
  const th = strHash(overType);
  return {
    shape: BLEND_SHAPES[hash3(tx, ty, th, SALT_SHAPE) % BLEND_SHAPES.length],
    variant: hash3(tx, ty, th, SALT_VARIANT) % BLEND_VARIANTS,
  };
}
```

Then in `blendOverlaysFor`'s output loop, replace the `out.push` with:

```js
    // One shape per (cell, winning type), held across ALL of that cell's roots
    // so the union of lobes reads as one coherent silhouette rather than as
    // four unrelated blobs meeting in the middle.
    const { shape, variant } = blendPattern(worldX, worldY, overType);
    out.push({
      overType, dirBits, depth, shape, variant,
      cacheKey: `${overType}|${dirBits}|${variant}|${depth}|${shape}`,
    });
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd /home/markunn/worker/coding/jsgame/something2/frontend
npx vitest run src/games/something2/src/js/systems/__tests__/tileBlend.test.js
```

Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
cd /home/markunn/worker/coding/jsgame/something2
git add frontend/src/games/something2/src/js/systems/tileBlend.js \
        frontend/src/games/something2/src/js/systems/__tests__/tileBlend.test.js
git commit -m "feat(render): deterministic shape and variant per boundary cell"
```

---

## Task 6: Bound the diamond cache

**Files:**
- Modify: `frontend/.../src/js/systems/tileTexture.js:63-82`
- Modify: `frontend/.../src/js/systems/__tests__/tileTexture.test.js`

**Interfaces:**
- Produces: `new TileDiamondCache(buildFn, { maxEntries })`; `cache.get(cacheKey, ...buildArgs)` (variadic, so a 3-argument build function works); `cache.size`.

**Why:** `TileDiamondCache` is an unbounded `Map`. That is correct for base tiles (~50 keys, one per type) and wrong for overlays (`overType x dirBits x variant x depth x shape`). Overlays get their **own** instance with a bound — sharing one cache would let overlay churn evict base-tile diamonds and force them to rebuild every frame.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/games/something2/src/js/systems/__tests__/tileTexture.test.js`:

```js
import { TileDiamondCache } from '../tileTexture.js';

describe('TileDiamondCache bounding', () => {
  it('is unbounded by default, preserving base-tile behaviour', () => {
    const cache = new TileDiamondCache(() => ({}));
    for (let i = 0; i < 100; i++) cache.get(`k${i}`, null, null);
    expect(cache.size).toBe(100);
  });

  it('evicts the least recently used entry past maxEntries', () => {
    let builds = 0;
    const cache = new TileDiamondCache(() => ({ n: builds++ }), { maxEntries: 3 });
    cache.get('a', null, null);
    cache.get('b', null, null);
    cache.get('c', null, null);
    cache.get('a', null, null);   // 'a' is now the most recent, 'b' the oldest
    cache.get('d', null, null);   // evicts 'b'
    expect(cache.size).toBe(3);
    expect(builds).toBe(4);
    cache.get('a', null, null);
    expect(builds).toBe(4);       // 'a' survived
    cache.get('b', null, null);
    expect(builds).toBe(5);       // 'b' was evicted and had to rebuild
  });

  it('passes every extra argument through to the build function', () => {
    const seen = [];
    const cache = new TileDiamondCache((...args) => { seen.push(args); return {}; },
      { maxEntries: 8 });
    cache.get('k', 'img', 'crop', 'mask');
    expect(seen[0]).toEqual(['img', 'crop', 'mask']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /home/markunn/worker/coding/jsgame/something2/frontend
npx vitest run src/games/something2/src/js/systems/__tests__/tileTexture.test.js
```

Expected: FAIL — `cache.size` is `undefined`.

- [ ] **Step 3: Replace the class**

In `frontend/.../src/js/systems/tileTexture.js`, replace the whole `TileDiamondCache` class with:

```js
// Memoizes one built canvas per cacheKey so the diamond mask is applied ONCE
// per texture/frame, not once per visible cell per frame. `buildFn` defaults to
// buildDiamondCanvas but is injectable for testing.
//
// `maxEntries: 0` (the default) is unbounded, which is right for BASE tiles:
// there is one key per tile type, ~50 in total, and every one of them is
// wanted on every frame. Transition overlays are keyed by
// type x dirBits x variant x depth x shape and need a bound -- but they get
// their OWN instance rather than sharing this one, because overlay churn
// evicting base diamonds would rebuild the entire ground layer every frame.
export class TileDiamondCache {
  constructor(buildFn = buildDiamondCanvas, { maxEntries = 0 } = {}) {
    this._build = buildFn;
    this._max = maxEntries;
    this._cache = new Map();
  }

  get size() { return this._cache.size; }

  get(cacheKey, ...buildArgs) {
    const hit = this._cache.get(cacheKey);
    if (hit !== undefined) {
      // Map iterates in insertion order, so re-inserting moves a hit to the
      // most-recent end and makes the first key the least recently used.
      // Skipped entirely when unbounded -- it would be pure overhead.
      if (this._max > 0) {
        this._cache.delete(cacheKey);
        this._cache.set(cacheKey, hit);
      }
      return hit;
    }
    const canvas = this._build(...buildArgs);
    this._cache.set(cacheKey, canvas);
    if (this._max > 0 && this._cache.size > this._max) {
      this._cache.delete(this._cache.keys().next().value);
    }
    return canvas;
  }
}
```

- [ ] **Step 4: Run to verify it passes, and that nothing else broke**

```bash
cd /home/markunn/worker/coding/jsgame/something2/frontend
npx vitest run
```

Expected: PASS. The existing base-tile call `get(key, img, crop)` still reaches `buildDiamondCanvas(img, crop)` unchanged.

- [ ] **Step 5: Commit**

```bash
cd /home/markunn/worker/coding/jsgame/something2
git add frontend/src/games/something2/src/js/systems/tileTexture.js \
        frontend/src/games/something2/src/js/systems/__tests__/tileTexture.test.js
git commit -m "refactor(render): LRU-bound the diamond cache, variadic build args"
```

---

## Task 7: `blendMasks.js` — rasterise the shapes

**Files:**
- Create: `frontend/.../src/js/systems/blendMasks.js`
- Modify: `frontend/.../src/js/systems/tileTexture.js`

**Interfaces:**
- Consumes: `NEIGHBOR_STEPS` bit order from Task 4, `BLEND_SHAPES`/`BLEND_VARIANTS` from Task 5.
- Produces:
  - `paintBlendMask(cx, W, H, { dirBits, depth, shape, variant })` — paints opaque white lobes onto an already-sized 2D context. No return value.
  - `buildBlendCanvas(img, crop, maskSpec)` in `tileTexture.js` — returns a `W x H` canvas of `img` masked by the union of the lobes intersected with the tile diamond.

**Note:** this task has no unit test of its own. Canvas rasterisation is not meaningfully assertable in the node env, and a test that stubbed the 2D context would only restate the implementation. Its verification is the browser check in Task 8. Everything that *decides* what to draw was already tested in Tasks 4 and 5, which is why those rules live in `tileBlend.js`.

- [ ] **Step 1: Write the mask painter**

Create `frontend/src/games/something2/src/js/systems/blendMasks.js`:

```js
// Rasterises the predefined transition patterns. Canvas-only -- never imported
// by a node test. Everything that DECIDES what to draw lives in tileBlend.js.
//
// A mask is painted in the padded diamond's own space: W x H where the diamond
// has vertices at (W/2, 0), (W, H/2), (W/2, H), (0, H/2). A lobe is rooted at
// the diamond feature facing the winning neighbour and grows toward the centre.
//
// Bit order is NEIGHBOR_STEPS' (tileBlend.js): even bits are EDGE roots, odd
// bits are VERTEX roots, starting at the top-right edge and going clockwise.

// Root point and inward unit direction per bit, as fractions of W and H.
function rootFor(bit, W, H) {
  const cx = W / 2, cy = H / 2;
  const P = [
    [0.75 * W, 0.25 * H], // 0 top-right edge midpoint
    [1.00 * W, 0.50 * H], // 1 right vertex
    [0.75 * W, 0.75 * H], // 2 bottom-right edge midpoint
    [0.50 * W, 1.00 * H], // 3 bottom vertex
    [0.25 * W, 0.75 * H], // 4 bottom-left edge midpoint
    [0.00 * W, 0.50 * H], // 5 left vertex
    [0.25 * W, 0.25 * H], // 6 top-left edge midpoint
    [0.50 * W, 0.00 * H], // 7 top vertex
  ][bit];
  const dx = cx - P[0], dy = cy - P[1];
  const len = Math.hypot(dx, dy) || 1;
  return { x: P[0], y: P[1], ix: dx / len, iy: dy / len, reach: len };
}

// Deterministic per-lobe jitter. Same inputs, same shape, every frame.
function rng(seed) {
  let s = (seed ^ 0x6d2b79f5) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// How far into the host cell a lobe may reach, as a fraction of the root's
// distance to the centre. `deep` is the default; `shallow` is the clamp used
// when either side of the boundary is impassable, so the visible material
// boundary never lies far enough to read as a bug.
const DEPTH_REACH = { deep: 0.9, shallow: 0.33 };

function paintLobe(cx2, bit, W, H, depth, shape, rand) {
  const r = rootFor(bit, W, H);
  const reach = r.reach * DEPTH_REACH[depth];
  // Perpendicular to the inward direction, i.e. along the root edge.
  const px = -r.iy, py = r.ix;
  // Lobes are painted WIDER than their own root so two adjacent roots overlap
  // into the corner between them instead of leaving a notch.
  const halfSpan = (bit % 2 === 0 ? 0.62 : 0.45) * Math.hypot(W / 2, H / 2);

  if (shape === 'fingers') {
    const n = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n + (rand() - 0.5) * 0.2;
      const bx = r.x + px * (t - 0.5) * 2 * halfSpan;
      const by = r.y + py * (t - 0.5) * 2 * halfSpan;
      const len = reach * (0.5 + rand() * 0.5);
      const wide = halfSpan * (0.10 + rand() * 0.12);
      cx2.beginPath();
      cx2.moveTo(bx - px * wide, by - py * wide);
      cx2.lineTo(bx + px * wide, by + py * wide);
      cx2.lineTo(bx + r.ix * len, by + r.iy * len);
      cx2.closePath();
      cx2.fill();
    }
    return;
  }

  if (shape === 'torn') {
    const n = 6;
    cx2.beginPath();
    cx2.moveTo(r.x - px * halfSpan, r.y - py * halfSpan);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const d = reach * (0.35 + rand() * 0.65);
      cx2.lineTo(r.x + px * (t - 0.5) * 2 * halfSpan + r.ix * d,
                 r.y + py * (t - 0.5) * 2 * halfSpan + r.iy * d);
    }
    cx2.lineTo(r.x + px * halfSpan, r.y + py * halfSpan);
    cx2.closePath();
    cx2.fill();
    return;
  }

  if (shape === 'drip') {
    // A heavy mass at the root...
    cx2.beginPath();
    cx2.ellipse(r.x + r.ix * reach * 0.18, r.y + r.iy * reach * 0.18,
      halfSpan, reach * 0.30, Math.atan2(r.iy, r.ix) + Math.PI / 2, 0, Math.PI * 2);
    cx2.fill();
    // ...plus one or two long thin runs.
    const runs = 1 + Math.floor(rand() * 2);
    for (let i = 0; i < runs; i++) {
      const off = (rand() - 0.5) * 1.4 * halfSpan;
      cx2.beginPath();
      cx2.ellipse(r.x + px * off + r.ix * reach * 0.55,
        r.y + py * off + r.iy * reach * 0.55,
        halfSpan * 0.16, reach * (0.45 + rand() * 0.35),
        Math.atan2(r.iy, r.ix) + Math.PI / 2, 0, Math.PI * 2);
      cx2.fill();
    }
    return;
  }

  // 'lobed' -- the default: overlapping ellipses of varied radius along the root.
  const n = 3 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const off = (t - 0.5) * 2 * halfSpan;
    const d = reach * (0.35 + rand() * 0.5);
    cx2.beginPath();
    cx2.ellipse(r.x + px * off + r.ix * d * 0.5, r.y + py * off + r.iy * d * 0.5,
      halfSpan * (0.35 + rand() * 0.3), d * 0.75,
      Math.atan2(r.iy, r.ix) + Math.PI / 2, 0, Math.PI * 2);
    cx2.fill();
  }
}

// Paint the union of this cell's lobes as opaque white. The caller owns
// feathering, diamond intersection and compositing the texture.
export function paintBlendMask(cx2, W, H, { dirBits, depth, shape, variant }) {
  cx2.fillStyle = '#fff';
  for (let bit = 0; bit < 8; bit++) {
    if (!(dirBits & (1 << bit))) continue;
    // Seed per (bit, variant, shape) so the same cell is reproducible but two
    // roots of the same cell do not draw the identical lobe.
    paintLobe(cx2, bit, W, H, depth, shape, rng(variant * 131 + bit * 17 + shape.length));
  }
}
```

- [ ] **Step 2: Add `buildBlendCanvas`**

In `frontend/.../src/js/systems/tileTexture.js`, import the painter and add the builder beside `buildDiamondCanvas`:

```js
import { paintBlendMask } from './blendMasks.js';

// One transition overlay: `img` (optionally the `crop` sub-rect) masked by the
// union of `maskSpec`'s lobes, intersected with the tile diamond.
//
// Three composites, in this order:
//   1. lobes, blurred      -- the organic silhouette, feathered
//   2. destination-in diamond -- clip to the host cell, so an overlay can
//      never spill onto a neighbour it does not belong to
//   3. source-in image     -- the winning material, shaped by the result
// Canvas-only -- never called in the node test env.
export function buildBlendCanvas(img, crop, maskSpec, { pad = TILE_DIAMOND_PAD, feather = EDGE_FEATHER } = {}) {
  const W = ISO_TILE_W + pad * 2;
  const H = ISO_TILE_H + pad * 2;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = false;

  if (feather > 0) cx.filter = `blur(${feather}px)`;
  paintBlendMask(cx, W, H, maskSpec);
  cx.filter = 'none';

  cx.globalCompositeOperation = 'destination-in';
  cx.fillStyle = '#fff';
  cx.beginPath();
  cx.moveTo(W / 2, 0);
  cx.lineTo(W, H / 2);
  cx.lineTo(W / 2, H);
  cx.lineTo(0, H / 2);
  cx.closePath();
  cx.fill();

  cx.globalCompositeOperation = 'source-in';
  if (crop) {
    const [sx, sy, sw, sh] = crop;
    cx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
  } else {
    cx.drawImage(img, 0, 0, W, H);
  }
  cx.globalCompositeOperation = 'source-over';
  return c;
}
```

- [ ] **Step 3: Verify the suite still passes**

```bash
cd /home/markunn/worker/coding/jsgame/something2/frontend
npx vitest run
```

Expected: PASS, no new failures. (`blendMasks.js` is imported by `tileTexture.js`, which node tests already import — so this step also proves the new module at least parses and has no top-level canvas access.)

- [ ] **Step 4: Commit**

```bash
cd /home/markunn/worker/coding/jsgame/something2
git add frontend/src/games/something2/src/js/systems/blendMasks.js \
        frontend/src/games/something2/src/js/systems/tileTexture.js
git commit -m "feat(render): procedural transition mask library"
```

---

## Task 8: Render pass A1 and the dev toggle

**Files:**
- Modify: `frontend/.../src/js/systems/RenderSystem.js:6-8,100-110,140-146,290-330`

**Interfaces:**
- Consumes: `blendOverlaysFor` (Tasks 4-5), `buildBlendCanvas` + bounded `TileDiamondCache` (Tasks 6-7), `resolveTileVisual` (existing).
- Produces: `RenderSystem.toggleTileBlending()` returning the new enabled state; overlays drawn between pass A0 and the landmark pass.

- [ ] **Step 1: Wire the imports and the second cache**

At the top of `RenderSystem.js`, extend the existing import and add the new one:

```js
import { TileDiamondCache, TILE_DIAMOND_PAD, buildBlendCanvas } from "./tileTexture.js";
import { blendOverlaysFor } from "./tileBlend.js";
```

In the constructor, beside the existing `this._tileCache`:

```js
    // Overlays get their OWN cache with a bound. Sharing the base cache would
    // let overlay churn (type x dirBits x variant x depth x shape) evict the
    // ~50 base diamonds and rebuild the whole ground layer every frame.
    // 192 entries x ~36KB is ~7MB.
    this._blendCache = new TileDiamondCache(buildBlendCanvas, { maxEntries: 192 });
    this.tileBlendOff = false;
```

Beside `toggleTileTextures()` (~line 141):

```js
  // Dev toggle: transition overlays on/off (falls back to hard tile edges).
  toggleTileBlending() {
    this.tileBlendOff = !this.tileBlendOff;
    return !this.tileBlendOff;
  }
```

- [ ] **Step 2: Collect overlays during pass A0**

Inside `renderChunked`, beside `const wallDrawables = [];`, add:

```js
    const blendDraws = [];
```

In the flat-floor branch of the cell loop, immediately after the existing `this.ctx.drawImage(cv, ...)` call, add:

```js
        // Collected, not drawn: pass A0 enumerates chunk by chunk and row by
        // row, NOT in draw order, so an overlay blitted here would be
        // overpainted by a base tile drawn later in this same loop. They are
        // sorted and drawn together once every base tile is down.
        // tileBlend indexes `defs` by tile NAME. mapTiles is that shape from
        // loadTileTypes, but the legacy array form still reaches this method
        // (see the `Array.isArray(mapTiles)` fallback in the def lookup above),
        // and indexing an array by name yields undefined for every neighbour --
        // silently no transitions anywhere, with nothing logged.
        if (!this.tileBlendOff && mapTiles && !Array.isArray(mapTiles)) {
          for (const ov of blendOverlaysFor(cell.tile, cell.worldX, cell.worldY, chunkedMap, mapTiles)) {
            const overDef = mapTiles[ov.overType];
            // Pinned to the STATIC frame: resolveTileVisual returns a
            // per-frame key for an animated type, which would rebuild this
            // overlay at 4fps and churn the cache. The cost is that an
            // intruded tongue of an animated material does not ripple.
            const overVisual = resolveTileVisual(ov.overType, overDef, this.imageManager, 0, 'image');
            if (!overVisual) continue;   // no texture yet -> no overlay, never a colour block
            blendDraws.push({
              ov, overVisual, order: overDef.blend_priority || 0,
              x: Math.round(s.x - halfW) - TILE_DIAMOND_PAD,
              y: Math.round(s.y - halfH) - TILE_DIAMOND_PAD,
            });
          }
        }
```

- [ ] **Step 3: Draw pass A1**

Immediately after the cell loop closes and **before** the `drawLandmarks(...)` call, insert:

```js
    // Pass A1: transition overlays. Ascending blend_priority, so where three
    // materials meet the loosest ends up on top.
    blendDraws.sort((a, b) => a.order - b.order);
    for (const d of blendDraws) {
      const cv = this._blendCache.get(d.ov.cacheKey, d.overVisual.img, d.overVisual.crop, d.ov);
      this.ctx.drawImage(cv, d.x, d.y);
    }
```

- [ ] **Step 4: Verify the suite still passes**

```bash
cd /home/markunn/worker/coding/jsgame/something2/frontend
npx vitest run
```

Expected: PASS, no new failures.

- [ ] **Step 5: Verify in the browser — this is the real acceptance test**

A green suite proves nothing about whether this looks better. Every rule was already unit-tested; what is unverified is the rasterisation, and it can only be seen.

```bash
cd /home/markunn/worker/coding/jsgame/something2 && make dev
```

Then, via Chrome DevTools MCP:
1. Navigate to `http://localhost:15173`, log in, enter a character.
2. **Run `document.exitFullscreen()` first.** The game auto-enters fullscreen on Play and hides windowed-layout problems.
3. Walk to a stone/sand/grass junction — the wide diagonal road bands crossing a rocky region are the clearest case.
4. Screenshot. Then call `toggleTileBlending()` on the render system from the console, screenshot again, and compare the pair.

Check, and write down what you see:
- Boundaries read as irregular, not as a 45-degree staircase.
- No hairline gaps or dark seams at tile edges (that would mean the `destination-in` diamond is smaller than the base diamond).
- No overlay spilling outside its host cell onto a tile it does not belong to.
- Corners where two roots meet do not read as a mechanical notch. **If they do, stop and report it before starting Task 9** — the plan's stated visual risk is exactly this, and widening `halfSpan` in `paintLobe` is the first lever.
- Water/grass boundaries are visibly shallower than grass/rock ones (the non-walkable clamp).

- [ ] **Step 6: Record draw-call and cache cost**

Do NOT report fps. rAF frame timing is not trustworthy on this host (1 Hz idle throttle), and `getImageData`-as-a-flush has produced confident wrong answers here before. Report counts:

```js
// In the DevTools console, against the live render system:
//   blendDraws length for one frame, and this._blendCache.size
```

Add a temporary counter if needed, report the numbers, and remove it before committing. Expect roughly 100-150 overlay blits per frame and a cache well under the 192 bound.

- [ ] **Step 7: Commit**

```bash
cd /home/markunn/worker/coding/jsgame/something2
git add frontend/src/games/something2/src/js/systems/RenderSystem.js
git commit -m "feat(render): draw tile transition overlays in a priority-ordered pass"
```

---

## Task 9: Scatter selection and the quantised cache key

**Files:**
- Modify: `frontend/.../src/js/systems/tileBlend.js`
- Modify: `frontend/.../src/js/systems/__tests__/tileBlend.test.js`

**Interfaces:**
- Produces: each overlay element gains `scatterLevel: 0|1|2|3` and `scatterDir: 0..7`; `cacheKey` becomes `` `${overType}|${dirBits}|${variant}|${depth}|${shape}|${scatterLevel}${scatterDir}` ``. `blendOverlaysFor` may now return an overlay with `dirBits === 0` (scatter only).

**Why the key must grow:** Task 8's key describes only the radius-1 ring. Scatter scans radius 2 and bakes into the *same* canvas, so without extending the key two cells with identical adjacent neighbours but different surroundings two tiles out would collide on one cached canvas — a wrong-but-plausible image that no test fails and that is hard to see in a screenshot. Putting all 16 ring bits in the key would multiply the key space by 65536, so it is quantised to a level and a dominant octant: a bounded 32x growth.

- [ ] **Step 1: Write the failing test**

Append to `tileBlend.test.js`:

```js
describe('scatter', () => {
  const ring2 = (dr, dc) => Math.max(Math.abs(dr), Math.abs(dc)) === 2;

  it('a cell with a winner only at distance 2 gets a scatter-only overlay', () => {
    const out = blendOverlaysFor('rocks', CX, CY, mapOf({
      '0,0': 'rocks', '0,2': 'grass',
    }), DEFS);
    expect(out).toHaveLength(1);
    expect(out[0].dirBits).toBe(0);
    expect(out[0].scatterLevel).toBeGreaterThan(0);
  });

  it('a cell with no winner within 2 tiles gets nothing', () => {
    const out = blendOverlaysFor('rocks', CX, CY, mapOf({
      '0,0': 'rocks', '0,3': 'grass',
    }), DEFS);
    expect(out).toEqual([]);
  });

  it('scatterLevel rises with how much of the ring is the winning type', () => {
    const few = blendOverlaysFor('rocks', CX, CY, mapOf({
      '0,0': 'rocks', '0,2': 'grass',
    }), DEFS)[0];
    const ringCells = {};
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) if (ring2(dr, dc)) ringCells[`${dr},${dc}`] = 'grass';
    }
    const many = blendOverlaysFor('rocks', CX, CY, mapOf({ '0,0': 'rocks', ...ringCells }), DEFS)[0];
    expect(many.scatterLevel).toBeGreaterThan(few.scatterLevel);
    expect(many.scatterLevel).toBeLessThanOrEqual(3);
  });

  it('the key is bounded: level 0..3 and dir 0..7 only', () => {
    const keys = new Set();
    for (let dc = -2; dc <= 2; dc++) {
      for (let dr = -2; dr <= 2; dr++) {
        const o = blendOverlaysFor('rocks', CX, CY,
          mapOf({ '0,0': 'rocks', [`${dr},${dc}`]: 'grass' }), DEFS)[0];
        if (!o) continue;
        expect(o.scatterLevel).toBeGreaterThanOrEqual(0);
        expect(o.scatterLevel).toBeLessThanOrEqual(3);
        expect(o.scatterDir).toBeGreaterThanOrEqual(0);
        expect(o.scatterDir).toBeLessThanOrEqual(7);
        keys.add(o.cacheKey);
      }
    }
    expect(keys.size).toBeGreaterThan(1);
  });

  it('two cells with the same adjacent ring but different ring-2 do NOT share a key', () => {
    // The collision this quantisation exists to prevent.
    const a = blendOverlaysFor('rocks', CX, CY, mapOf({
      '0,0': 'rocks', '-1,0': 'grass',
    }), DEFS)[0];
    const b = blendOverlaysFor('rocks', CX, CY, mapOf({
      '0,0': 'rocks', '-1,0': 'grass',
      '-2,0': 'grass', '-2,1': 'grass', '-2,-1': 'grass', '0,2': 'grass',
    }), DEFS)[0];
    expect(a.dirBits).toBe(b.dirBits);
    expect(a.cacheKey).not.toBe(b.cacheKey);
  });

  it('the wall, tie and null rules still hold at radius 2', () => {
    expect(blendOverlaysFor('rocks', CX, CY, mapOf({ '0,0': 'rocks', '0,2': 'wall' }), DEFS)).toEqual([]);
    expect(blendOverlaysFor('grass', CX, CY, mapOf({ '0,0': 'grass', '0,2': 'grass' }), DEFS)).toEqual([]);
    expect(blendOverlaysFor('rocks', CX, CY, mapOf({ '0,0': 'rocks' }), DEFS)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /home/markunn/worker/coding/jsgame/something2/frontend
npx vitest run src/games/something2/src/js/systems/__tests__/tileBlend.test.js
```

Expected: FAIL — the radius-2 cases return `[]` and `scatterLevel` is `undefined`.

- [ ] **Step 3: Implement the radius-2 scan and quantisation**

Add to `tileBlend.js`:

```js
// The 16 cells of the radius-2 ring, as [dr, dc]. Scatter reaches further than
// the edge does -- a cell two tiles from stone should still catch a few
// pebbles -- but the decals are still painted inside the HOST cell's own
// diamond, so none of the geometric guarantees change.
export const RING2_STEPS = (() => {
  const out = [];
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      if (Math.max(Math.abs(dr), Math.abs(dc)) === 2) out.push([dr, dc]);
    }
  }
  return out;
})();

// Which of the 8 octants a ring offset points into, matching NEIGHBOR_STEPS'
// bit order so `scatterDir` and `dirBits` speak the same directions.
function octantOf(dr, dc) {
  let best = 0, bestDot = -Infinity;
  const len = Math.hypot(dr, dc) || 1;
  for (let i = 0; i < NEIGHBOR_STEPS.length; i++) {
    const [sr, sc] = NEIGHBOR_STEPS[i];
    const sl = Math.hypot(sr, sc) || 1;
    const dot = (dr * sr + dc * sc) / (len * sl);
    if (dot > bestDot) { bestDot = dot; best = i; }
  }
  return best;
}

// Count -> level. Quantised on purpose: the raw 16-bit ring in the cache key
// would multiply the key space by 65536, where level x dir multiplies it by 32.
function scatterLevelOf(count) {
  if (count === 0) return 0;
  if (count <= 2) return 1;
  if (count <= 6) return 2;
  return 3;
}
```

Then in `blendOverlaysFor`, after the radius-1 loop and before the output loop, add the ring scan and merge it in:

```js
  // Radius-2 scan. A type found only out here still earns an overlay, with
  // dirBits 0 -- scatter, no edge.
  const ringCount = new Map();
  const ringVec = new Map();
  for (const [dr, dc] of RING2_STEPS) {
    const n = chunkedMap.getTileAt(
      worldX + dc * MAP_TILE_SIZE,
      worldY + dr * MAP_TILE_SIZE,
    );
    if (n == null || n === tileName) continue;
    const over = defs[n];
    if (!over || isWall(over) || rank(over) <= selfRank) continue;
    ringCount.set(n, (ringCount.get(n) || 0) + 1);
    const v = ringVec.get(n) || { r: 0, c: 0 };
    v.r += dr; v.c += dc;
    ringVec.set(n, v);
    if (!byType.has(n)) byType.set(n, 0);
  }
```

and in the output loop, before the `out.push`:

```js
    const count = ringCount.get(overType) || 0;
    const scatterLevel = scatterLevelOf(count);
    const v = ringVec.get(overType);
    const scatterDir = v ? octantOf(v.r, v.c) : 0;
```

extending the pushed object and the key:

```js
    out.push({
      overType, dirBits, depth, shape, variant, scatterLevel, scatterDir,
      cacheKey: `${overType}|${dirBits}|${variant}|${depth}|${shape}|${scatterLevel}${scatterDir}`,
    });
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd /home/markunn/worker/coding/jsgame/something2/frontend
npx vitest run src/games/something2/src/js/systems/__tests__/tileBlend.test.js
```

Expected: PASS, 22 tests. Every Task 4 and Task 5 test must still pass — if `dirBits` assertions broke, the ring scan is wrongly setting radius-1 bits.

- [ ] **Step 5: Commit**

```bash
cd /home/markunn/worker/coding/jsgame/something2
git add frontend/src/games/something2/src/js/systems/tileBlend.js \
        frontend/src/games/something2/src/js/systems/__tests__/tileBlend.test.js
git commit -m "feat(render): radius-2 scatter selection with a quantised cache key"
```

---

## Task 10: Paint the scatter decals

**Files:**
- Modify: `frontend/.../src/js/systems/blendMasks.js`

**Interfaces:**
- Consumes: `scatterLevel`, `scatterDir` from Task 9 (they arrive inside the same `maskSpec` object `paintBlendMask` already receives).
- Produces: no signature change. Scatter is painted into the same alpha buffer as the lobes, so it costs **zero** extra draw calls per frame.

- [ ] **Step 1: Add the scatter painter**

In `frontend/.../src/js/systems/blendMasks.js`, add above `paintBlendMask`:

```js
// How many decals each quantised level paints.
const SCATTER_COUNT = [0, 4, 9, 14];

// Loose bits of the winning material sitting ON the host surface. Density
// falls off away from `dir`, so the pebbles read as having come from that
// side. Deliberately does NOT move the material boundary -- scattered bits
// are obviously on the other surface, which is how this adds apparent depth
// without widening the visual/gameplay disagreement the depth clamp bounds.
function paintScatter(cx2, W, H, { scatterLevel, scatterDir, variant }) {
  const n = SCATTER_COUNT[scatterLevel] || 0;
  if (n === 0) return;
  const rand = rng(variant * 7919 + scatterDir * 331 + 5);
  const src = rootFor(scatterDir, W, H);
  for (let i = 0; i < n; i++) {
    // Bias toward the source side: t near 0 is at the root, near 1 at centre.
    const t = Math.pow(rand(), 1.7);
    const spread = (rand() - 0.5) * 1.5;
    const px = -src.iy, py = src.ix;
    const x = src.x + src.ix * src.reach * (0.15 + t * 1.5)
      + px * spread * (W * 0.22);
    const y = src.y + src.iy * src.reach * (0.15 + t * 1.5)
      + py * spread * (H * 0.22);
    // Small, and smaller the further from the source.
    const r = (1.2 + rand() * 2.6) * (1 - t * 0.45);
    cx2.beginPath();
    cx2.ellipse(x, y, r, r * (0.55 + rand() * 0.35), rand() * Math.PI, 0, Math.PI * 2);
    cx2.fill();
  }
}
```

- [ ] **Step 2: Call it from the mask painter**

Replace the body of `paintBlendMask` with:

```js
export function paintBlendMask(cx2, W, H, spec) {
  const { dirBits, depth, shape, variant } = spec;
  cx2.fillStyle = '#fff';
  for (let bit = 0; bit < 8; bit++) {
    if (!(dirBits & (1 << bit))) continue;
    paintLobe(cx2, bit, W, H, depth, shape, rng(variant * 131 + bit * 17 + shape.length));
  }
  // Same alpha buffer as the lobes, so the single source-in below paints edge
  // and scatter together and scatter costs no extra draw call per frame.
  paintScatter(cx2, W, H, spec);
}
```

- [ ] **Step 3: Verify the suite still passes**

```bash
cd /home/markunn/worker/coding/jsgame/something2/frontend
npx vitest run
```

Expected: PASS, no new failures.

- [ ] **Step 4: Verify in the browser**

Repeat Task 8's browser procedure. Additionally check:
- Scattered bits are visible past the edge, and are recognisably the winning material (a pebble on grass looks like that stone) — not tinted dots.
- Decals thin out with distance from the boundary rather than being uniformly sprinkled.
- A cell two tiles from a boundary carries a few decals and no visible edge.
- Toggling with `toggleTileBlending()` removes edge and scatter together.
- Re-check `this._blendCache.size` against the 192 bound. The key space grew 32x in Task 9; if the cache is now pinned at 192 and thrashing, raise the bound or coarsen `SCATTER_COUNT`, and say which you did.

- [ ] **Step 5: Commit**

```bash
cd /home/markunn/worker/coding/jsgame/something2
git add frontend/src/games/something2/src/js/systems/blendMasks.js
git commit -m "feat(render): scatter decals baked into the transition overlay"
```

---

## Verification checklist

Run before declaring the plan complete:

```bash
cd /home/markunn/worker/coding/jsgame/something2/frontend && npx vitest run
cd /home/markunn/worker/coding/jsgame/something2/backend
export TEST_DATABASE_URL='postgres://user:password@localhost:15432/s2_blend_scratch'
node --test tests/tile_blend_priority_route.test.js
```

Then drop the scratch database:

```bash
dropdb -h localhost -p 15432 -U user s2_blend_scratch
```

Do not run a destructive statement against the shared dev database at any point. A reviewer once ran `DELETE FROM entity_types` there to test a seeder and wiped the catalog.
