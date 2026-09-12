# World Point Art Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every fixed world point (portal, waypoint, merchant, bank, gem merchant, skill merchant, vault/field chest) can carry an image or sprite from the existing entity-art pipeline, selectable per instance from the map spec, with the kind list open-ended.

**Architecture:** A `world_point_kinds` catalog plus `entity_types.point_kind` marks which entity types are art for which kind; nullable `entity_type_id` FKs on `map_links` / `waypoints` / `world_chests` / `villages` bind one instance to one type, authored in the map spec and converged by `seed-map`. The authority resolves each point to an entity-type **name** (`art`) once per join/frame; the client resolves that name against the entity-type catalog it already holds and draws the type through the existing `drawEntity` fit path inside the depth sort, keeping every overlay (beam, label pill, `[e]` prompts) and degrading to today's placeholder shape when no art exists.

**Tech Stack:** Node 20 / Express / raw `pg` / node-pg-migrate (backend, `node --test`); Vite + React 19 + TanStack Query + styled-components (admin, `vitest`); Canvas 2D iso renderer under `frontend/src/games/something2/src/js` (vitest with stub contexts).

**Spec:** `docs/superpowers/specs/2026-09-12-world-point-art-design.md`

## Global Constraints

- Epic SOMET-576; branch `feat/world-point-art`; commit subject `type(scope): summary (SOMET-5NN)` using each task's own ticket (T1=577 … T9=585). Every task follows `plane-workflow`: set its ticket In Progress with a comment BEFORE the first edit, To Review with evidence when done. End every commit with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Never run a backend DB test without `TEST_DATABASE_URL` AND `DATABASE_URL` both pointed at a scratch database.** Unset, they hit the shared dev DB (memory: db-tests-default-to-the-dev-db). Every task below is unit-only (captured SQL, no DB) except the explicit live-verification task.
- Never `git checkout` / `stash` / `branch` in the shared working dir; use a worktree (`superpowers:using-git-worktrees`). Note a host-side checkout leaves vite serving stale modules — `make dev` after switching.
- Migration numbers: this plan uses `1714440547000` and `1714440548000`. Before creating them run `ls backend/migrations | tail -3`; if either number is taken by a parallel branch, take the next free ones and keep the two in order (kinds table first, bindings second — the bindings FK nothing in the kinds table, but the seed order matters for `make seed-catalogs`).
- `spawn_tiles` is `NOT NULL DEFAULT '[]'` on `entity_types`; a point type must keep `'[]'` so `loadDecorationDefs` never scatters it (it filters `jsonb_array_length(spawn_tiles) > 0`).
- Read exit codes, not the `# fail` line (`AGENTS.md`, "Reading a test run").
- Point x/y on the wire are **tile centres** (e.g. 3250 = centre of tile 32); `MAP_TILE_SIZE` is 100. A body drawn for a point uses top-left `x - 50, y - 50` with `width = height = MAP_TILE_SIZE`, exactly as `collectDecorations` does, so `drawEntity` centres it on the tile.

---

## File map

| File | Responsibility |
|---|---|
| `backend/seeds/data/pointTypes.js` (new) | `POINT_KINDS` list and `POINT_TYPES` placeholder rows; read by migration, seed-catalogs and the spec fixture test |
| `backend/migrations/1714440547000_world_point_kinds.js` (new) | `world_point_kinds` table, `entity_types.point_kind` FK column, kind rows |
| `backend/migrations/1714440548000_world_point_art_bindings.js` (new) | the seven nullable `*entity_type_id` columns |
| `backend/scripts/seed-catalogs.js` | seed point types + fill missing kind defaults |
| `backend/src/services/pointArt.js` (new) | pure resolution (`resolvePointArt`, `chestPointKind`), `loadPointKindDefaults`, `loadPointTypeNames`, `applyPointArt` (seed convergence) |
| `backend/src/index.js` | `GET/PUT /api/world-point-kinds`, `point_kind` on entity-types POST/PUT/map |
| `backend/src/services/mapLinks.js`, `waypoints.js`, `villages.js`, `chests.js` | each fetcher LEFT JOINs its art name |
| `backend/src/services/landmarks.js` | landmarks carry `art` |
| `backend/src/authority/server.js` | loads kind defaults into `entry`, resolves `art` on landmarks / village posts / chests |
| `backend/seeds/mapSpec.js` | `art` fields validated (`pointArtTypes` option) |
| `backend/scripts/seed-map.js` | calls `applyPointArt` after the village/chest/waypoint passes; passes `pointArtTypes` to the validator |
| `frontend/src/games/something2/useWorldPointKinds.js` (new) | TanStack hooks for the kinds catalog |
| `frontend/src/games/something2/pointKindForm.js` (new) | pure helpers: which form fields a point kind hides, default-button state |
| `frontend/src/games/something2/EntityTypesAdmin.jsx` | point-kind select, hidden fields, "Make default" button |
| `frontend/src/games/something2/src/js/systems/pointArt.js` (new) | pure client resolution: `pointArtDef`, `pointBodyRef`, `pointStateTreatment`, `planLandmarkBodies` |
| `frontend/src/games/something2/src/js/systems/spriteAtlas.js` | `stateFrameKey` |
| `frontend/src/games/something2/src/js/systems/RenderSystem.js` | `resolveSprite` stateKey, `drawPointBody`, integration in the five draw paths |
| `frontend/src/games/something2/src/js/systems/landmarkRenderer.js` | `skipBody` option |
| `frontend/src/games/something2/src/js/core/Game.js` | passes `entityDefs` to the renderer |

---

## Slice 1 — Kind catalog and editor

### Task 1: Seed data, migrations, seed-catalogs

**Files:**
- Create: `backend/seeds/data/pointTypes.js`
- Create: `backend/migrations/1714440547000_world_point_kinds.js`
- Create: `backend/migrations/1714440548000_world_point_art_bindings.js`
- Modify: `backend/scripts/seed-catalogs.js` (after the `NEW_DECORATIONS` loop, ~line 500)
- Test: `backend/tests/pointTypes_seed.test.js`

**Interfaces:**
- Produces: `POINT_KINDS: string[]` (8 kinds), `POINT_TYPES: {name, point_kind, color, display_width, display_height, prompt}[]`, `VILLAGE_POST_KINDS = ['merchant','bank','gem_merchant','skill_merchant']`, `villageArtColumn(kind) → 'merchant_entity_type_id' | …` from `pointTypes.js`.
- Produces tables: `world_point_kinds(kind text PK, default_entity_type_id int NULL → entity_types ON DELETE SET NULL, created_at)`, `entity_types.point_kind text NULL → world_point_kinds(kind)`, and the binding columns `map_links.entity_type_id`, `waypoints.entity_type_id`, `world_chests.entity_type_id`, `villages.{merchant,bank,gem_merchant,skill_merchant}_entity_type_id` (all `integer NULL REFERENCES entity_types(id) ON DELETE SET NULL`).

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/pointTypes_seed.test.js
const test = require('node:test');
const assert = require('node:assert');
const {
  POINT_KINDS, POINT_TYPES, VILLAGE_POST_KINDS, villageArtColumn,
} = require('../seeds/data/pointTypes.js');

test('every point kind has exactly one seeded placeholder type', () => {
  assert.deepStrictEqual([...POINT_KINDS].sort(), [
    'bank', 'chest_field', 'chest_vault', 'gem_merchant', 'merchant',
    'portal', 'skill_merchant', 'waypoint',
  ]);
  const byKind = new Map();
  for (const t of POINT_TYPES) {
    assert.ok(POINT_KINDS.includes(t.point_kind), `${t.name} names unknown kind ${t.point_kind}`);
    assert.ok(!byKind.has(t.point_kind), `two seeded types for ${t.point_kind}`);
    byKind.set(t.point_kind, t);
  }
  assert.strictEqual(byKind.size, POINT_KINDS.length);
});

test('seeded point types are never decorations or creatures', () => {
  for (const t of POINT_TYPES) {
    assert.strictEqual(t.is_creature, false, t.name);
    assert.deepStrictEqual(t.spawn_tiles, [], `${t.name} must not be scattered by generateChunkDecorations`);
    assert.strictEqual(t.render_mode, 'rect', `${t.name} ships without art`);
    assert.ok(typeof t.prompt === 'string' && t.prompt.length > 20, `${t.name} needs a prompt the editor can generate from`);
    assert.ok(Number.isInteger(t.display_width) && t.display_width > 0, t.name);
    assert.ok(Number.isInteger(t.display_height) && t.display_height > 0, t.name);
  }
});

test('village post kinds map to their villages column', () => {
  assert.deepStrictEqual(VILLAGE_POST_KINDS, ['merchant', 'bank', 'gem_merchant', 'skill_merchant']);
  assert.strictEqual(villageArtColumn('merchant'), 'merchant_entity_type_id');
  assert.strictEqual(villageArtColumn('skill_merchant'), 'skill_merchant_entity_type_id');
  assert.throws(() => villageArtColumn('portal'), /not a village post kind/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/pointTypes_seed.test.js; echo EXIT=$?`
Expected: EXIT=1, `Cannot find module '../seeds/data/pointTypes.js'`

- [ ] **Step 3: Write the seed data file**

```js
// backend/seeds/data/pointTypes.js
//
// World point kinds (SOMET-577). A "world point" is a fixed tile the sim
// already knows about -- a portal tile in map_links, a waypoint row, a
// village post, a chest -- and this catalog is what lets one carry an image
// or sprite. Read by THREE consumers that must never disagree:
//   - migrations/1714440547000_world_point_kinds.js seeds POINT_KINDS once
//   - scripts/seed-catalogs.js upserts POINT_TYPES and fills kind defaults
//   - tests/map_spec_fixtures.test.js validates `art:` names in the real
//     specs against POINT_TYPES, the same way it validates creature names
//     against seeds/data/entityTypes.js
//
// One placeholder row per kind, with NO art: render_mode 'rect' so the
// renderer keeps drawing today's shape until an admin approves an image
// (agents cannot generate images -- see memory "sprites epic"). spawn_tiles
// MUST stay [] -- loadDecorationDefs treats any non-empty list as "scatter
// me across the map".
const { styleEntityPrompt } = require('./spritePrompt.js');

const POINT_KINDS = [
  'portal', 'waypoint', 'merchant', 'bank', 'gem_merchant', 'skill_merchant',
  'chest_vault', 'chest_field',
];

// The four posts that hang off ONE villages row (fetchVillages derives the
// last three from merchant_x/merchant_y). Order matters nowhere; the column
// mapping does.
const VILLAGE_POST_KINDS = ['merchant', 'bank', 'gem_merchant', 'skill_merchant'];

function villageArtColumn(kind) {
  if (!VILLAGE_POST_KINDS.includes(kind)) throw new Error(`${kind} is not a village post kind`);
  return `${kind}_entity_type_id`;
}

function pointType(name, point_kind, color, display_width, display_height, subject) {
  return {
    name, point_kind, color, display_width, display_height,
    is_creature: false, walkable: true, render_mode: 'rect', spawn_tiles: [], chance: 0,
    prompt: styleEntityPrompt(subject),
  };
}

const POINT_TYPES = [
  pointType('portal',              'portal',         '#f472b6', 110, 130, 'a glowing swirling magical stone portal archway'),
  pointType('waypoint_stone',      'waypoint',       '#7dd3fc',  70,  90, 'an ancient carved waystone with glowing blue runes'),
  pointType('merchant_post',       'merchant',       '#c084fc',  80, 100, 'a wooden market stall with a striped awning and goods on the counter'),
  pointType('bank_post',           'bank',           '#c084fc',  80, 100, 'a sturdy iron-bound strongbox on a stone pedestal'),
  pointType('gem_merchant_post',   'gem_merchant',   '#c084fc',  80, 100, 'a jeweller\'s stall with a velvet tray of glowing gems'),
  pointType('skill_merchant_post', 'skill_merchant', '#c084fc',  80, 100, 'a scholar\'s lectern stacked with open spellbooks and scrolls'),
  pointType('chest_vault',         'chest_vault',    '#e0b64e',  70,  60, 'an ornate gilded treasure chest with heavy iron bands'),
  pointType('chest_field',         'chest_field',    '#8a8f98',  60,  50, 'a small weathered wooden chest half sunk in grass'),
];

module.exports = { POINT_KINDS, POINT_TYPES, VILLAGE_POST_KINDS, villageArtColumn };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/pointTypes_seed.test.js; echo EXIT=$?`
Expected: EXIT=0, 3 pass

- [ ] **Step 5: Write the kinds migration**

```js
// backend/migrations/1714440547000_world_point_kinds.js
exports.shorthands = undefined;

// Kinds live in seeds/data/pointTypes.js so this migration and
// `make seed-catalogs` read one list (same discipline as decoration_types).
const { POINT_KINDS } = require('../seeds/data/pointTypes.js');

exports.up = (pgm) => {
  pgm.createTable('world_point_kinds', {
    kind: { type: 'text', primaryKey: true },
    // NULL until seed-catalogs (or an admin) picks a default; a NULL default
    // means "draw the placeholder shape", never an error.
    default_entity_type_id: {
      type: 'integer', notNull: false, references: 'entity_types', onDelete: 'SET NULL',
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  for (const kind of POINT_KINDS) {
    pgm.sql(`INSERT INTO world_point_kinds (kind) VALUES ('${kind}') ON CONFLICT (kind) DO NOTHING`);
  }
  // Marks an entity type as art for ONE kind. FK rather than CHECK so a new
  // kind is a row, not a migration.
  pgm.addColumn('entity_types', {
    point_kind: { type: 'text', notNull: false, references: 'world_point_kinds', onDelete: 'SET NULL' },
  });
  pgm.createIndex('entity_types', 'point_kind', { where: 'point_kind IS NOT NULL' });
};

exports.down = (pgm) => {
  pgm.dropColumn('entity_types', 'point_kind');
  pgm.dropTable('world_point_kinds');
};
```

- [ ] **Step 6: Write the bindings migration**

```js
// backend/migrations/1714440548000_world_point_art_bindings.js
exports.shorthands = undefined;

// Per-instance art binding (spec D1). NULL = "use the kind default". SET NULL
// on delete so removing an art type degrades a portal to the default rather
// than deleting the portal.
const REF = { type: 'integer', notNull: false, references: 'entity_types', onDelete: 'SET NULL' };

exports.up = (pgm) => {
  pgm.addColumn('map_links', { entity_type_id: REF });
  pgm.addColumn('waypoints', { entity_type_id: REF });
  pgm.addColumn('world_chests', { entity_type_id: REF });
  pgm.addColumns('villages', {
    merchant_entity_type_id: REF,
    bank_entity_type_id: REF,
    gem_merchant_entity_type_id: REF,
    skill_merchant_entity_type_id: REF,
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('villages', [
    'merchant_entity_type_id', 'bank_entity_type_id',
    'gem_merchant_entity_type_id', 'skill_merchant_entity_type_id',
  ]);
  pgm.dropColumn('world_chests', 'entity_type_id');
  pgm.dropColumn('waypoints', 'entity_type_id');
  pgm.dropColumn('map_links', 'entity_type_id');
};
```

- [ ] **Step 7: Add the seed-catalogs pass**

In `backend/scripts/seed-catalogs.js`, add the require next to the decoration one:

```js
const { POINT_TYPES, POINT_KINDS } = require('../seeds/data/pointTypes.js');
```

and immediately after the `NEW_DECORATIONS` loop (after `decorations += 1; }`):

```js
  // World point placeholder types (SOMET-577). Same "fill only what is empty"
  // posture as decorations: point_kind is re-asserted (it is the catalog's
  // own fact, not an admin edit), prompt only fills an empty one, and every
  // visual column an admin may have set (image, sprite, render_mode, size,
  // colour) is left alone.
  let pointTypes = 0;
  for (const t of POINT_TYPES) {
    await pool.query(
      `INSERT INTO entity_types
        (name, is_creature, walkable, render_mode, spawn_tiles, chance,
         display_width, display_height, color, prompt, point_kind)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (name) DO UPDATE
         SET point_kind = EXCLUDED.point_kind,
             prompt = COALESCE(NULLIF(entity_types.prompt, ''), EXCLUDED.prompt)`,
      [t.name, t.is_creature, t.walkable, t.render_mode, JSON.stringify(t.spawn_tiles),
       t.chance, t.display_width, t.display_height, t.color, t.prompt, t.point_kind],
    );
    pointTypes += 1;
  }
  // A kind with no default yet points at its placeholder. An admin's choice
  // (non-NULL) is never overwritten.
  for (const t of POINT_TYPES) {
    await pool.query(
      `UPDATE world_point_kinds
          SET default_entity_type_id = (SELECT id FROM entity_types WHERE name = $2)
        WHERE kind = $1 AND default_entity_type_id IS NULL`,
      [t.point_kind, t.name],
    );
  }
  console.log(`Seeded ${pointTypes} world point types across ${POINT_KINDS.length} kinds`);
```

- [ ] **Step 8: Apply migrations and seed on the dev stack, verify**

Run: `make migrate-up && make seed-catalogs`
Then: `docker exec -i something2-db-1 psql -U user -d game_db -Atc "SELECT k.kind, e.name FROM world_point_kinds k LEFT JOIN entity_types e ON e.id = k.default_entity_type_id ORDER BY k.kind"`
Expected: 8 rows, each kind paired with its placeholder name (`bank|bank_post` … `waypoint|waypoint_stone`).
Then: `docker exec -i something2-db-1 psql -U user -d game_db -Atc "SELECT count(*) FROM entity_types WHERE point_kind IS NOT NULL AND jsonb_array_length(spawn_tiles) > 0"` → `0`.

- [ ] **Step 9: Commit**

```bash
git add backend/seeds/data/pointTypes.js backend/migrations/1714440547000_world_point_kinds.js backend/migrations/1714440548000_world_point_art_bindings.js backend/scripts/seed-catalogs.js backend/tests/pointTypes_seed.test.js
git commit -m "feat(catalog): world point kinds, point_kind on entity types, art binding columns (SOMET-577)"
```

---

### Task 2: API — kinds catalog routes and `point_kind` on entity types

**Files:**
- Modify: `backend/src/index.js` — `entityTypeFieldError` (~line 726), `getEntityTypesMap` (~443), `POST /api/entity-types` (~762), `PUT /api/entity-types/:id` (~815, UPDATE at ~958), new routes next to `GET /api/creature-behaviors` (~2188)
- Test: `backend/tests/worldPointKinds.test.js`, `backend/tests/entityTypes.test.js` (extend)

**Interfaces:**
- Produces `GET /api/world-point-kinds → [{ kind, default_entity_type_id, default_name }]` (public read, like `/api/entity-types`).
- Produces `PUT /api/world-point-kinds/:kind` (adminGuard) body `{ default_entity_type_id: number|null }` → 200 `{ kind, default_entity_type_id, default_name }`; 404 unknown kind; 400 when the type's `point_kind !== kind`.
- Entity-type rows and the `/api/map/config` map expose `point_kind` / `pointKind`.
- `POST`/`PUT /api/entity-types` accept `point_kind: string|null`; PUT follows the `behavior_id` "present-in-body" rule (`'point_kind' in req.body`): absent → keep, `null` → clear.

- [ ] **Step 1: Write the failing route tests**

Read `backend/tests/entityTypes.test.js` lines 1–120 first for `putMock`, `paramFor`, `AUTH`, `withAuth`, `__setPool` — reuse them verbatim.

```js
// backend/tests/worldPointKinds.test.js
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { adminToken, withAuth } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

test('GET /api/world-point-kinds lists kinds with their default name', async () => {
  __setPool({
    query: withAuth(async (sql) => {
      assert.match(sql, /FROM world_point_kinds/i);
      assert.match(sql, /LEFT JOIN entity_types/i);
      return { rows: [
        { kind: 'portal', default_entity_type_id: 7, default_name: 'portal' },
        { kind: 'waypoint', default_entity_type_id: null, default_name: null },
      ] };
    }),
  });
  const res = await request(app).get('/api/world-point-kinds');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, [
    { kind: 'portal', default_entity_type_id: 7, default_name: 'portal' },
    { kind: 'waypoint', default_entity_type_id: null, default_name: null },
  ]);
});

test('PUT /api/world-point-kinds/:kind rejects a type of another kind', async () => {
  __setPool({
    query: withAuth(async (sql) => {
      if (/SELECT point_kind FROM entity_types WHERE id/i.test(sql)) return { rows: [{ point_kind: 'bank' }] };
      throw new Error(`unexpected query: ${sql}`);
    }),
  });
  const res = await request(app).put('/api/world-point-kinds/portal').set(...AUTH)
    .send({ default_entity_type_id: 9 });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /point_kind "bank".*kind "portal"/);
});

test('PUT /api/world-point-kinds/:kind writes the default and returns the row', async () => {
  const updates = [];
  __setPool({
    query: withAuth(async (sql, params) => {
      if (/SELECT point_kind FROM entity_types WHERE id/i.test(sql)) return { rows: [{ point_kind: 'portal' }] };
      if (/UPDATE world_point_kinds/i.test(sql)) {
        updates.push(params);
        return { rows: [{ kind: 'portal', default_entity_type_id: 9, default_name: 'stone_gate' }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  });
  const res = await request(app).put('/api/world-point-kinds/portal').set(...AUTH)
    .send({ default_entity_type_id: 9 });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(updates, [[9, 'portal']]);
  assert.strictEqual(res.body.default_name, 'stone_gate');
});

test('PUT /api/world-point-kinds/:kind 404s an unknown kind', async () => {
  __setPool({
    query: withAuth(async (sql) => {
      if (/SELECT point_kind FROM entity_types WHERE id/i.test(sql)) return { rows: [{ point_kind: 'portal' }] };
      if (/UPDATE world_point_kinds/i.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    }),
  });
  const res = await request(app).put('/api/world-point-kinds/portal').set(...AUTH)
    .send({ default_entity_type_id: 9 });
  assert.strictEqual(res.status, 404);
});

test('PUT /api/world-point-kinds/:kind with null clears the default without a type lookup', async () => {
  const updates = [];
  __setPool({
    query: withAuth(async (sql, params) => {
      if (/UPDATE world_point_kinds/i.test(sql)) {
        updates.push(params);
        return { rows: [{ kind: 'portal', default_entity_type_id: null, default_name: null }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  });
  const res = await request(app).put('/api/world-point-kinds/portal').set(...AUTH)
    .send({ default_entity_type_id: null });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(updates, [[null, 'portal']]);
});
```

Append to `backend/tests/entityTypes.test.js`:

```js
test('POST /api/entity-types stores point_kind', async () => {
  let captured;
  __setPool({ query: withAuth(async (sql, params) => { captured = { sql, params }; return { rows: [{ id: 1 }] }; }) });
  const res = await request(app).post('/api/entity-types').set(...AUTH)
    .send({ name: 'stone_gate', color: '#fff', point_kind: 'portal' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(paramFor(captured.sql, captured.params, 'point_kind'), 'portal');
});

test('POST /api/entity-types rejects a non-string point_kind', async () => {
  __setPool({ query: withAuth(async () => { throw new Error('must not write'); }) });
  const res = await request(app).post('/api/entity-types').set(...AUTH)
    .send({ name: 'x', color: '#fff', point_kind: 7 });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /point_kind/);
});

test('PUT /api/entity-types/:id leaves point_kind alone when omitted and clears it when null', async () => {
  const seen = [];
  __setPool(putMock('portal', async (sql, params) => {
    if (/UPDATE entity_types/i.test(sql)) {
      // pointKindProvided flag + value are adjacent params; capture both.
      const flagIdx = sql.match(/point_kind = CASE WHEN \$(\d+)::boolean THEN \$(\d+)/);
      seen.push([params[Number(flagIdx[1]) - 1], params[Number(flagIdx[2]) - 1]]);
      return { rows: [{ id: 1 }] };
    }
    return { rows: [] };
  }));
  const base = { name: 'portal', color: '#fff', walkable: true, spawn_tiles: [], chance: 0 };
  let res = await request(app).put('/api/entity-types/1').set(...AUTH).send(base);
  assert.strictEqual(res.status, 200);
  res = await request(app).put('/api/entity-types/1').set(...AUTH).send({ ...base, point_kind: null });
  assert.strictEqual(res.status, 200);
  res = await request(app).put('/api/entity-types/1').set(...AUTH).send({ ...base, point_kind: 'portal' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(seen, [[false, null], [true, null], [true, 'portal']]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/worldPointKinds.test.js tests/entityTypes.test.js; echo EXIT=$?`
Expected: EXIT=1; the new kinds tests fail with 404 (route missing), the POST test fails on `INSERT has no column 'point_kind'`.

- [ ] **Step 3: Implement**

In `entityTypeFieldError` (before `return null;`):

```js
  if (body.point_kind != null && (typeof body.point_kind !== 'string' || body.point_kind === '')) {
    return 'point_kind must be a non-empty string or null';
  }
```

In `getEntityTypesMap`'s object literal add `pointKind: row.point_kind ?? null,` after `isCreature`.

In `POST /api/entity-types`: add `point_kind` to the destructuring; add `point_kind` as the 29th column and `$29` in VALUES; append `point_kind ?? null` after `pin.id` in the params array. Wrap the query so an FK violation (`err.code === '23503'` with `constraint` containing `point_kind`) returns `400 { error: 'unknown point_kind' }` — add this before the generic 500 in the catch:

```js
    if (err.code === '23503' && /point_kind/.test(err.constraint || '')) {
      return res.status(400).json({ error: `unknown point_kind "${req.body.point_kind}"` });
    }
```

In `PUT /api/entity-types/:id`: add `point_kind` to the destructuring; `const pointKindProvided = 'point_kind' in req.body;` next to `behaviorIdProvided`. In the UPDATE add, after the `ai_provider_id` line:

```sql
        point_kind = CASE WHEN $32::boolean THEN $33 ELSE entity_types.point_kind END,
```

and change `WHERE id = $31` to `WHERE id = $34`. In the params array insert `pointKindProvided, point_kind ?? null,` immediately before `id` (id must stay last — `entityTypes.test.js` asserts it). Add the same 23503 → 400 mapping in the PUT's catch.

New routes, placed right after `GET /api/creature-behaviors`:

```js
// World point kinds (SOMET-578): which entity type draws a portal / waypoint
// / village post / chest when the instance itself names none.
const POINT_KIND_ROW = `
  SELECT k.kind, k.default_entity_type_id, e.name AS default_name
    FROM world_point_kinds k
    LEFT JOIN entity_types e ON e.id = k.default_entity_type_id`;

app.get('/api/world-point-kinds', async (req, res) => {
  try {
    const r = await pool.query(`${POINT_KIND_ROW} ORDER BY k.kind ASC`);
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch world point kinds' });
  }
});

app.put('/api/world-point-kinds/:kind', adminGuard, async (req, res) => {
  const { kind } = req.params;
  const { default_entity_type_id: typeId } = req.body;
  if (typeId != null && !Number.isInteger(typeId)) {
    return res.status(400).json({ error: 'default_entity_type_id must be an integer or null' });
  }
  try {
    if (typeId != null) {
      // The default for a kind must be a type OF that kind, or the editor's
      // per-kind filter and the runtime's fallback would disagree.
      const t = await pool.query('SELECT point_kind FROM entity_types WHERE id = $1', [typeId]);
      if (t.rowCount === 0) return res.status(400).json({ error: `unknown entity type ${typeId}` });
      if (t.rows[0].point_kind !== kind) {
        return res.status(400).json({
          error: `entity type ${typeId} has point_kind "${t.rows[0].point_kind}" and cannot be the default for kind "${kind}"`,
        });
      }
    }
    const r = await pool.query(
      `WITH upd AS (
         UPDATE world_point_kinds SET default_entity_type_id = $1 WHERE kind = $2 RETURNING kind, default_entity_type_id
       )
       SELECT upd.kind, upd.default_entity_type_id, e.name AS default_name
         FROM upd LEFT JOIN entity_types e ON e.id = upd.default_entity_type_id`,
      [typeId ?? null, kind],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: `unknown world point kind "${kind}"` });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update world point kind' });
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/worldPointKinds.test.js tests/entityTypes.test.js; echo EXIT=$?`
Expected: EXIT=0

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.js backend/tests/worldPointKinds.test.js backend/tests/entityTypes.test.js
git commit -m "feat(api): world point kinds catalog routes and point_kind on entity types (SOMET-578)"
```

---

### Task 3: Entity editor — point kind select, hidden fields, "Make default"

**Files:**
- Create: `frontend/src/games/something2/useWorldPointKinds.js`
- Create: `frontend/src/games/something2/pointKindForm.js`
- Modify: `frontend/src/games/something2/EntityTypesAdmin.jsx` — form state (~line 938–1040), submit payload (~1084), the checkbox row (~1289–1323), the `formData.is_creature &&` block (~1325)
- Test: `frontend/src/games/something2/__tests__/pointKindForm.test.js`

**Interfaces:**
- Consumes `GET /api/world-point-kinds`, `PUT /api/world-point-kinds/:kind` (Task 2).
- Produces `useWorldPointKinds() → { kinds: [{kind, default_entity_type_id, default_name}], isLoadingKinds }`, `useSetPointKindDefault() → mutation({ kind, default_entity_type_id })`.
- Produces pure helpers in `pointKindForm.js`:
  - `pointKindHidesWorldFields(pointKind) → boolean` (true for any non-null kind)
  - `pointKindPayload(formData) → { point_kind: string|null }` — always present in the PUT body so the server's "present-in-body" rule sees an explicit clear
  - `defaultButtonState({ pointKind, entityId, kinds }) → { visible, disabled, label }`

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/games/something2/__tests__/pointKindForm.test.js
import { describe, it, expect } from 'vitest';
import { pointKindHidesWorldFields, pointKindPayload, defaultButtonState } from '../pointKindForm.js';

describe('pointKindHidesWorldFields', () => {
  it('hides walkable/spawn/creature fields for any point kind', () => {
    expect(pointKindHidesWorldFields('portal')).toBe(true);
    expect(pointKindHidesWorldFields('chest_field')).toBe(true);
  });
  it('shows them when the type is not a point kind', () => {
    expect(pointKindHidesWorldFields(null)).toBe(false);
    expect(pointKindHidesWorldFields('')).toBe(false);
    expect(pointKindHidesWorldFields(undefined)).toBe(false);
  });
});

describe('pointKindPayload', () => {
  it('always names point_kind so an omitted field cannot be mistaken for "keep"', () => {
    expect(pointKindPayload({ point_kind: 'portal' })).toEqual({ point_kind: 'portal' });
    expect(pointKindPayload({ point_kind: '' })).toEqual({ point_kind: null });
    expect(pointKindPayload({})).toEqual({ point_kind: null });
  });
});

describe('defaultButtonState', () => {
  const kinds = [
    { kind: 'portal', default_entity_type_id: 7, default_name: 'portal' },
    { kind: 'waypoint', default_entity_type_id: null, default_name: null },
  ];
  it('is hidden for a type with no point kind or for an unsaved type', () => {
    expect(defaultButtonState({ pointKind: null, entityId: 7, kinds }).visible).toBe(false);
    expect(defaultButtonState({ pointKind: 'portal', entityId: null, kinds }).visible).toBe(false);
  });
  it('is disabled when the type already is the default', () => {
    const s = defaultButtonState({ pointKind: 'portal', entityId: 7, kinds });
    expect(s).toEqual({ visible: true, disabled: true, label: 'Default for portal' });
  });
  it('offers to make a different type the default', () => {
    const s = defaultButtonState({ pointKind: 'portal', entityId: 9, kinds });
    expect(s).toEqual({ visible: true, disabled: false, label: 'Make default for portal (currently: portal)' });
  });
  it('names "none" when the kind has no default yet', () => {
    const s = defaultButtonState({ pointKind: 'waypoint', entityId: 9, kinds });
    expect(s.label).toBe('Make default for waypoint (currently: none)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/pointKindForm.test.js; echo EXIT=$?`
Expected: EXIT=1, module not found

- [ ] **Step 3: Write the pure helpers and the hook**

```js
// frontend/src/games/something2/pointKindForm.js
// Pure rules behind the entity editor's world-point-kind controls, kept out
// of EntityTypesAdmin.jsx so they are reachable from a test (that suite has
// no DOM).

// A point-kind type is never placed by the sim: walkable / spawn tiles /
// spawn chance / is_creature are meaningless for it and the world ignores
// them (loadDecorationDefs only reads rows with spawn_tiles).
export function pointKindHidesWorldFields(pointKind) {
  return typeof pointKind === 'string' && pointKind !== '';
}

// The server's PUT treats an ABSENT point_kind as "leave alone" and an
// explicit null as "clear" (same rule as behavior_id), so the form always
// sends the key.
export function pointKindPayload(formData) {
  const k = formData && formData.point_kind;
  return { point_kind: typeof k === 'string' && k !== '' ? k : null };
}

export function defaultButtonState({ pointKind, entityId, kinds }) {
  if (!pointKindHidesWorldFields(pointKind) || entityId == null) {
    return { visible: false, disabled: true, label: '' };
  }
  const row = (kinds || []).find((k) => k.kind === pointKind);
  const currentId = row ? row.default_entity_type_id : null;
  if (currentId === entityId) {
    return { visible: true, disabled: true, label: `Default for ${pointKind}` };
  }
  const current = row && row.default_name ? row.default_name : 'none';
  return { visible: true, disabled: false, label: `Make default for ${pointKind} (currently: ${current})` };
}
```

```js
// frontend/src/games/something2/useWorldPointKinds.js
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { API_URL } from "../../config.js";

export function useWorldPointKinds() {
  const { data, isLoading } = useQuery({
    queryKey: ["world-point-kinds"],
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/world-point-kinds`);
      if (!res.ok) throw new Error("Failed to fetch world point kinds");
      return res.json();
    },
  });
  return { kinds: data || [], isLoadingKinds: isLoading };
}

// Defaults are read by the authority at loadWorld, so a change reaches a
// running world on its next activation, not live -- same as behaviours.
export function useSetPointKindDefault() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ kind, default_entity_type_id }) => {
      const res = await apiFetch(`${API_URL}/api/world-point-kinds/${encodeURIComponent(kind)}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ default_entity_type_id }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to set default");
      }
      return res.json();
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["world-point-kinds"] });
      toast.success(`${row.default_name || 'none'} is now the default for ${row.kind}`);
    },
    onError: (err) => toast.error(err.message),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/pointKindForm.test.js; echo EXIT=$?`
Expected: EXIT=0

- [ ] **Step 5: Wire the editor**

In `EntityTypesAdmin.jsx`:

1. Imports: `import { useWorldPointKinds, useSetPointKindDefault } from './useWorldPointKinds.js';` and `import { pointKindHidesWorldFields, pointKindPayload, defaultButtonState } from './pointKindForm.js';`
2. In the component body, next to where `behaviors` is obtained: `const { kinds: pointKinds } = useWorldPointKinds(); const setPointKindDefault = useSetPointKindDefault();`
3. Form state: add `point_kind: null` to the initial `useState` object (~line 938), to the edit-population branch as `point_kind: editingEntity.point_kind ?? null` (~line 971), and to the reset branch as `point_kind: null` (~line 1013).
4. Submit payload (~line 1084 where `display_width: optionalPx(...)` is built): spread `...pointKindPayload(formData)` into the payload object.
5. Insert this block immediately BEFORE the `<div style={{ display: 'flex', gap: '2rem' }}>` that holds the Walkable checkbox (~line 1289):

```jsx
              <FormGroup>
                <label>World point kind</label>
                <select
                  value={formData.point_kind ?? ''}
                  onChange={e => setFormData({ ...formData, point_kind: e.target.value === '' ? null : e.target.value })}
                >
                  <option value="">— none (creature or decoration) —</option>
                  {pointKinds.map(k => (
                    <option key={k.kind} value={k.kind}>{k.kind}</option>
                  ))}
                </select>
                {(() => {
                  const s = defaultButtonState({
                    pointKind: formData.point_kind, entityId: editingEntity?.id ?? null, kinds: pointKinds,
                  });
                  if (!s.visible) return null;
                  return (
                    <button
                      type="button"
                      disabled={s.disabled || setPointKindDefault.isPending}
                      onClick={() => setPointKindDefault.mutate({
                        kind: formData.point_kind, default_entity_type_id: editingEntity.id,
                      })}
                      style={{ marginTop: '0.5rem' }}
                    >
                      {s.label}
                    </button>
                  );
                })()}
              </FormGroup>
```

6. Wrap the Walkable/Is-creature/Spawn-chance row AND the existing spawn-tiles picker (find it by `spawn_tiles` in the JSX) in `{!pointKindHidesWorldFields(formData.point_kind) && ( … )}`. Leave the `formData.is_creature &&` creature block as is — it is already hidden for a point type because `is_creature` stays false.
7. In the list card (~line 833 where `render mode:` is printed) add `{entity.point_kind ? ` · point: ${entity.point_kind}` : ''}` so the kind is visible without opening the form.

- [ ] **Step 6: Run the admin smoke suite and the whole frontend suite**

Run: `cd frontend && npx vitest run; echo EXIT=$?`
Expected: EXIT=0

- [ ] **Step 7: Browser check (headless Chrome recipe from memory "art-export-seed")**

Open `/game/admin/entity-types` logged in as admin, edit `portal`: the select shows `portal`, the Walkable/Is-creature/Spawn chance row is absent, the button reads `Default for portal` and is disabled. Edit `bush`: select shows none, world fields present. Take one screenshot of each state into the scratchpad and note the paths in the commit body.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/games/something2/useWorldPointKinds.js frontend/src/games/something2/pointKindForm.js frontend/src/games/something2/EntityTypesAdmin.jsx frontend/src/games/something2/__tests__/pointKindForm.test.js
git commit -m "feat(admin): world point kind select and make-default action in the entity editor (SOMET-579)"
```

---

## Slice 2 — Spec authoring and seed convergence

### Task 4: `validateMapSpec` accepts and checks `art` fields

**Files:**
- Modify: `backend/seeds/mapSpec.js` — signature (~line 137), chest key whitelist (~636), waypoint loop (~575), village handling (find `villagesOf(w)` loop in the per-world section), portal link branch (~788)
- Modify: `backend/tests/map_spec_fixtures.test.js` — pass `pointArtTypes`
- Test: `backend/tests/mapSpec_pointArt.test.js`

**Interfaces:**
- Consumes `POINT_TYPES` (Task 1).
- Produces: `validateMapSpec(spec, { …, pointArtTypes = null })` where `pointArtTypes: Map<name, kind>`; when `null`, only shape is checked (a string, non-empty), mirroring how `creatureTypeNames = null` skips name checks.
- Spec grammar produced:
  - `links[].art` (portal links only) → kind `portal`; applies to both rows of the pair
  - `links[].waypoint_art` (only with `is_waypoint: true`) → kind `waypoint`
  - `worlds[].waypoints[].art` → kind `waypoint`
  - `worlds[].chest.art` → kind `chest_vault`
  - `worlds[].village.art` = object with keys ⊆ `merchant | bank | gem_merchant | skill_merchant`, each → that kind (same for entries of `worlds[].villages[]`)

- [ ] **Step 1: Write the failing tests**

```js
// backend/tests/mapSpec_pointArt.test.js
const test = require('node:test');
const assert = require('node:assert');
const { validateMapSpec } = require('../seeds/mapSpec.js');

// Minimal valid two-world spec with one portal. Copy the smallest fixture
// shape from map_spec_fixtures.test.js if this one fails a rule unrelated to
// art -- the point of these tests is the art rules only.
function base() {
  return {
    name: 't', topology: 'grid',
    worlds: [
      { key: 'a', name: 'A', grid: [0, 0], seed: 1, width: 40, height: 40, chunk_size: 8, biomes: ['meadow'], is_entry: true, entry_spawn: { x: 550, y: 550 },
        waypoints: [{ x: 1050, y: 1050, name: 'Stone A' }],
        village: { key: 'v1', min_row: 20, min_col: 20, width: 8, height: 8, gate_edge: 'S', spawn_x: 2450, spawn_y: 2450 },
        chest: { x: 3050, y: 3050, level: 2, guard_creature_type: 'Wolf' } },
      { key: 'b', name: 'B', seed: 2, width: 40, height: 40, chunk_size: 8, biomes: ['meadow'] },
    ],
    links: [{ kind: 'portal', from: 'a', to: 'b', from_x: 550, from_y: 1550, to_x: 550, to_y: 550 }],
  };
}
const TYPES = new Map([
  ['portal', 'portal'], ['stone_gate', 'portal'], ['waypoint_stone', 'waypoint'],
  ['merchant_post', 'merchant'], ['bank_post', 'bank'], ['chest_vault', 'chest_vault'], ['pine_tree', undefined],
]);
const artErrors = (spec, types = TYPES) =>
  validateMapSpec(spec, { pointArtTypes: types }).filter((e) => /art/.test(e));

test('a spec with no art fields raises no art errors', () => {
  assert.deepStrictEqual(artErrors(base()), []);
});

test('portal, waypoint, chest and village art of the right kind pass', () => {
  const s = base();
  s.links[0].art = 'stone_gate';
  s.worlds[0].waypoints[0].art = 'waypoint_stone';
  s.worlds[0].chest.art = 'chest_vault';
  s.worlds[0].village.art = { merchant: 'merchant_post', bank: 'bank_post' };
  assert.deepStrictEqual(artErrors(s), []);
});

test('a portal art of another kind is rejected naming the link and the kind', () => {
  const s = base();
  s.links[0].art = 'pine_tree';
  const errs = artErrors(s);
  assert.strictEqual(errs.length, 1);
  assert.match(errs[0], /portal link a->b art "pine_tree" is not an entity type of point kind "portal"/);
});

test('an unknown name is rejected', () => {
  const s = base();
  s.worlds[0].chest.art = 'no_such_type';
  assert.match(artErrors(s)[0], /world "a" chest art "no_such_type" is not an entity type of point kind "chest_vault"/);
});

test('village art keys are limited to the four posts and each checks its own kind', () => {
  const s = base();
  s.worlds[0].village.art = { merchant: 'bank_post', tavern: 'merchant_post' };
  const errs = artErrors(s);
  assert.ok(errs.some((e) => /village "v1" art merchant "bank_post" is not an entity type of point kind "merchant"/.test(e)), errs.join('\n'));
  assert.ok(errs.some((e) => /village "v1" art has unknown key "tavern"/.test(e)), errs.join('\n'));
});

test('waypoint_art without is_waypoint is rejected; with it, kind waypoint is required', () => {
  const s = base();
  s.links[0].waypoint_art = 'waypoint_stone';
  assert.match(artErrors(s)[0], /portal link a->b waypoint_art requires is_waypoint: true/);
  s.links[0].is_waypoint = true; s.links[0].waypoint_name = 'Gate A';
  delete s.worlds[0].waypoints; // one waypoint per world
  assert.deepStrictEqual(artErrors(s), []);
  s.links[0].waypoint_art = 'stone_gate';
  assert.match(artErrors(s)[0], /waypoint_art "stone_gate" is not an entity type of point kind "waypoint"/);
});

test('a non-string art is a shape error even with no catalog', () => {
  const s = base();
  s.links[0].art = 7;
  assert.match(artErrors(s, null)[0], /portal link a->b art must be an entity type name/);
});

test('with no catalog, a well-formed name passes (seed-map supplies the catalog)', () => {
  const s = base();
  s.links[0].art = 'anything';
  assert.deepStrictEqual(artErrors(s, null), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/mapSpec_pointArt.test.js; echo EXIT=$?`
Expected: EXIT=1 — the "right kind" test passes vacuously but the rejection tests fail (no errors produced). If `base()` trips unrelated rules (biome unknown etc.), adjust `base()` until the first test is green and the rest red before continuing.

- [ ] **Step 3: Implement**

In `validateMapSpec`, add `pointArtTypes = null` to the options destructuring, then a helper right after `const errors = [];`:

```js
  // Art bindings (SOMET-580). `pointArtTypes` is Map<entity type name, point_kind>
  // from the live catalog (seed-map) or the checked-in POINT_TYPES (fixtures);
  // null skips the name check exactly as creatureTypeNames does.
  const checkArt = (value, kind, label) => {
    if (value === undefined) return;
    if (typeof value !== 'string' || value === '') {
      errors.push(`${label} must be an entity type name (got ${JSON.stringify(value)})`);
      return;
    }
    if (pointArtTypes && pointArtTypes.get(value) !== kind) {
      errors.push(`${label} "${value}" is not an entity type of point kind "${kind}"`);
    }
  };
  const VILLAGE_ART_KEYS = ['merchant', 'bank', 'gem_merchant', 'skill_merchant'];
  const checkVillageArt = (v, worldKey) => {
    if (v.art === undefined) return;
    if (!v.art || typeof v.art !== 'object' || Array.isArray(v.art)) {
      errors.push(`world "${worldKey}" village "${v.key}" art must be an object`);
      return;
    }
    for (const k of Object.keys(v.art)) {
      if (!VILLAGE_ART_KEYS.includes(k)) {
        errors.push(`world "${worldKey}" village "${v.key}" art has unknown key "${k}"`);
        continue;
      }
      checkArt(v.art[k], k, `world "${worldKey}" village "${v.key}" art ${k}`);
    }
  };
```

Then:
- In the per-world loop where `villagesOf(w)` is iterated for geometry checks, add `checkVillageArt(v, w.key)` for each village object.
- In the waypoint loop (`for (const [i, wp] of w.waypoints.entries())`), after `checkWaypoint(...)`: `checkArt(wp.art, 'waypoint', \`world "${w.key}" waypoint ${i} art\`);`
- In the chest block: add `'art'` to the accepted key list `['x', 'y', 'level', 'guard_creature_type']` and after it `checkArt(c.art, 'chest_vault', \`world "${w.key}" chest art\`);`
- In the portal link branch, after the `is_waypoint` type check:

```js
      checkArt(l.art, 'portal', `portal link ${l.from}->${l.to} art`);
      if (l.waypoint_art !== undefined && l.is_waypoint !== true) {
        errors.push(`portal link ${l.from}->${l.to} waypoint_art requires is_waypoint: true`);
      } else {
        checkArt(l.waypoint_art, 'waypoint', `portal link ${l.from}->${l.to} waypoint_art`);
      }
```

In `backend/tests/map_spec_fixtures.test.js` add `const { POINT_TYPES } = require('../seeds/data/pointTypes.js');` and `const POINT_ART_TYPES = new Map(POINT_TYPES.map((t) => [t.name, t.point_kind]));`, then add `pointArtTypes: POINT_ART_TYPES` to every `validateMapSpec(spec, { … })` call in that file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/mapSpec_pointArt.test.js tests/map_spec_fixtures.test.js; echo EXIT=$?`
Expected: EXIT=0

- [ ] **Step 5: Commit**

```bash
git add backend/seeds/mapSpec.js backend/tests/mapSpec_pointArt.test.js backend/tests/map_spec_fixtures.test.js
git commit -m "feat(maps): validate art bindings for portals, waypoints, chests and village posts (SOMET-580)"
```

---

### Task 5: `pointArt` service — resolution, catalog loaders, seed convergence

**Files:**
- Create: `backend/src/services/pointArt.js`
- Modify: `backend/scripts/seed-map.js` — catalogs (~line 160), after the village pass and chest pass (~line 610, before the pens pass)
- Test: `backend/tests/pointArt.test.js`

**Interfaces:**
- Produces:
  - `chestPointKind(chestKind: 'vault'|'field') → 'chest_vault'|'chest_field'`
  - `resolvePointArt(kind, instanceArt, defaults) → string|null` where `defaults: Map<kind, name>`; instance name wins, else the kind default, else `null`
  - `loadPointKindDefaults(db) → Map<kind, name>` (kinds with a NULL default are absent)
  - `loadPointTypeNames(db) → Map<name, kind>` for the validator
  - `applyPointArt(client, spec, idByKey) → { portals, waypoints, villages, chests }` counts of UPDATEs issued; writes `NULL` wherever the spec is silent

- [ ] **Step 1: Write the failing tests**

```js
// backend/tests/pointArt.test.js
const test = require('node:test');
const assert = require('node:assert');
const {
  chestPointKind, resolvePointArt, loadPointKindDefaults, loadPointTypeNames, applyPointArt,
} = require('../src/services/pointArt.js');

test('chestPointKind maps the two chest kinds and rejects others', () => {
  assert.strictEqual(chestPointKind('vault'), 'chest_vault');
  assert.strictEqual(chestPointKind('field'), 'chest_field');
  assert.throws(() => chestPointKind('gold'), /unknown chest kind/);
});

test('resolvePointArt: instance beats default beats nothing', () => {
  const defaults = new Map([['portal', 'portal']]);
  assert.strictEqual(resolvePointArt('portal', 'stone_gate', defaults), 'stone_gate');
  assert.strictEqual(resolvePointArt('portal', null, defaults), 'portal');
  assert.strictEqual(resolvePointArt('portal', undefined, defaults), 'portal');
  assert.strictEqual(resolvePointArt('waypoint', null, defaults), null);
  assert.strictEqual(resolvePointArt('waypoint', null, undefined), null);
});

test('loadPointKindDefaults keeps only kinds that have a default', async () => {
  const db = { query: async (sql) => {
    assert.match(sql, /FROM world_point_kinds/);
    return { rows: [{ kind: 'portal', name: 'portal' }, { kind: 'waypoint', name: null }] };
  } };
  const m = await loadPointKindDefaults(db);
  assert.deepStrictEqual([...m.entries()], [['portal', 'portal']]);
});

test('loadPointTypeNames maps name -> kind for point types only', async () => {
  const db = { query: async (sql) => {
    assert.match(sql, /WHERE point_kind IS NOT NULL/);
    return { rows: [{ name: 'portal', point_kind: 'portal' }, { name: 'bank_post', point_kind: 'bank' }] };
  } };
  const m = await loadPointTypeNames(db);
  assert.deepStrictEqual([...m.entries()], [['portal', 'portal'], ['bank_post', 'bank']]);
});

// Captures every UPDATE so the convergence rule ("spec silent => NULL") is
// asserted on the SQL actually issued, not on a return value.
function capturingClient(typeRows) {
  const writes = [];
  return {
    writes,
    query: async (sql, params) => {
      if (/SELECT id, name, point_kind FROM entity_types/.test(sql)) return { rows: typeRows };
      writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rowCount: 1, rows: [] };
    },
  };
}
const TYPE_ROWS = [
  { id: 1, name: 'stone_gate', point_kind: 'portal' },
  { id: 2, name: 'waypoint_stone', point_kind: 'waypoint' },
  { id: 3, name: 'merchant_post', point_kind: 'merchant' },
  { id: 4, name: 'chest_vault', point_kind: 'chest_vault' },
];
const idByKey = new Map([['a', 'wid-a'], ['b', 'wid-b']]);

test('applyPointArt writes both rows of a portal pair and NULLs an unbound portal', async () => {
  const client = capturingClient(TYPE_ROWS);
  const spec = { worlds: [{ key: 'a' }, { key: 'b' }], links: [
    { kind: 'portal', from: 'a', to: 'b', from_x: 550, from_y: 1550, to_x: 550, to_y: 550, art: 'stone_gate' },
    { kind: 'portal', from: 'a', to: 'b', from_x: 950, from_y: 950, to_x: 1550, to_y: 1550 },
    { kind: 'compass', from: 'a', to: 'b', edge: 'E' },
  ] };
  const n = await applyPointArt(client, spec, idByKey);
  assert.strictEqual(n.portals, 2);
  const portalWrites = client.writes.filter((w) => /UPDATE map_links/.test(w.sql));
  assert.strictEqual(portalWrites.length, 4);
  assert.deepStrictEqual(portalWrites.map((w) => w.params), [
    ['wid-a', 550, 1550, 1], ['wid-b', 550, 550, 1],
    ['wid-a', 950, 950, null], ['wid-b', 1550, 1550, null],
  ]);
  for (const w of portalWrites) assert.match(w.sql, /edge = 'PORTAL'/);
});

test('applyPointArt binds waypoints by name (both authoring routes)', async () => {
  const client = capturingClient(TYPE_ROWS);
  const spec = { worlds: [{ key: 'a', waypoints: [{ x: 1, y: 1, name: 'Stone A', art: 'waypoint_stone' }] }, { key: 'b' }],
    links: [{ kind: 'portal', from: 'a', to: 'b', from_x: 5, from_y: 5, to_x: 6, to_y: 6, is_waypoint: true, waypoint_name: 'Gate A' }] };
  await applyPointArt(client, spec, idByKey);
  const wps = client.writes.filter((w) => /UPDATE waypoints/.test(w.sql)).map((w) => w.params);
  assert.deepStrictEqual(wps, [['Gate A', null], ['Stone A', 2]]);
});

test('applyPointArt writes all four village columns keyed by spec_key, and the vault chest', async () => {
  const client = capturingClient(TYPE_ROWS);
  const spec = { worlds: [
    { key: 'a', village: { key: 'v1', art: { merchant: 'merchant_post' } }, chest: { x: 1, y: 1, art: 'chest_vault' } },
    { key: 'b', villages: [{ key: 'v2' }], chest: { x: 2, y: 2 } },
  ], links: [] };
  const n = await applyPointArt(client, spec, idByKey);
  assert.deepStrictEqual({ villages: n.villages, chests: n.chests }, { villages: 2, chests: 2 });
  const vil = client.writes.filter((w) => /UPDATE villages/.test(w.sql));
  assert.match(vil[0].sql, /merchant_entity_type_id = \$3, bank_entity_type_id = \$4, gem_merchant_entity_type_id = \$5, skill_merchant_entity_type_id = \$6 WHERE world_id = \$1 AND spec_key = \$2/);
  assert.deepStrictEqual(vil.map((w) => w.params), [['wid-a', 'v1', 3, null, null, null], ['wid-b', 'v2', null, null, null, null]]);
  const ch = client.writes.filter((w) => /UPDATE world_chests/.test(w.sql));
  assert.match(ch[0].sql, /WHERE world_id = \$1 AND kind = 'vault'/);
  assert.deepStrictEqual(ch.map((w) => w.params), [['wid-a', 4], ['wid-b', null]]);
});

test('applyPointArt throws on a name of the wrong kind rather than binding it', async () => {
  const client = capturingClient(TYPE_ROWS);
  const spec = { worlds: [{ key: 'a' }, { key: 'b' }],
    links: [{ kind: 'portal', from: 'a', to: 'b', from_x: 1, from_y: 1, to_x: 2, to_y: 2, art: 'merchant_post' }] };
  await assert.rejects(() => applyPointArt(client, spec, idByKey), /"merchant_post" is not a portal type/);
  assert.strictEqual(client.writes.length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/pointArt.test.js; echo EXIT=$?`
Expected: EXIT=1, module not found

- [ ] **Step 3: Implement the service**

```js
// backend/src/services/pointArt.js
//
// World point art (SOMET-581). Which entity type draws a portal, waypoint,
// village post or chest. Three concerns, one file, because they must agree
// on the kind names:
//   - resolution (pure): instance binding -> kind default -> null
//   - catalog loaders for the authority (defaults) and the validator (names)
//   - seed convergence: every instance a spec touches is written, NULL when
//     the spec is silent, so the spec stays the source of truth (memory:
//     spec-beats-migration-on-reseed).
//
// Imports nothing from the authority (the authority requires this).
const { VILLAGE_POST_KINDS, villageArtColumn } = require('../../seeds/data/pointTypes.js');

function chestPointKind(chestKind) {
  if (chestKind === 'vault') return 'chest_vault';
  if (chestKind === 'field') return 'chest_field';
  throw new Error(`unknown chest kind "${chestKind}"`);
}

// `defaults` is Map<kind, entity type name>. Returns a NAME, not an id: the
// client resolves names against the /api/map/config catalog it already holds.
function resolvePointArt(kind, instanceArt, defaults) {
  if (typeof instanceArt === 'string' && instanceArt !== '') return instanceArt;
  const d = defaults && typeof defaults.get === 'function' ? defaults.get(kind) : null;
  return typeof d === 'string' && d !== '' ? d : null;
}

async function loadPointKindDefaults(db) {
  const r = await db.query(
    `SELECT k.kind, e.name
       FROM world_point_kinds k
       LEFT JOIN entity_types e ON e.id = k.default_entity_type_id
      ORDER BY k.kind ASC`,
  );
  return new Map(r.rows.filter((row) => row.name).map((row) => [row.kind, row.name]));
}

async function loadPointTypeNames(db) {
  const r = await db.query(
    'SELECT name, point_kind FROM entity_types WHERE point_kind IS NOT NULL ORDER BY id ASC',
  );
  return new Map(r.rows.map((row) => [row.name, row.point_kind]));
}

function villagesOf(w) {
  const list = [];
  if (w.village) list.push(w.village);
  if (Array.isArray(w.villages)) list.push(...w.villages);
  return list;
}

// Seed convergence. `idByKey` is seed-map's Map<world key, world id>. Runs
// AFTER the portal, waypoint, village and chest passes so every row exists.
// Portal rows are addressed by tile because setPortalLink writes the mirror
// row itself and only returns the forward id.
async function applyPointArt(client, spec, idByKey) {
  const types = new Map(
    (await client.query('SELECT id, name, point_kind FROM entity_types WHERE point_kind IS NOT NULL')).rows
      .map((r) => [r.name, { id: r.id, kind: r.point_kind }]),
  );
  // Validated up front so a bad spec writes nothing (the caller's transaction
  // would roll back anyway; this keeps the error at the first bad name).
  const idFor = (name, kind, label) => {
    if (name === undefined || name === null) return null;
    const t = types.get(name);
    if (!t || t.kind !== kind) throw new Error(`${label}: "${name}" is not a ${kind} type`);
    return t.id;
  };

  const n = { portals: 0, waypoints: 0, villages: 0, chests: 0 };
  const links = Array.isArray(spec.links) ? spec.links : [];
  const worlds = Array.isArray(spec.worlds) ? spec.worlds : [];

  for (const l of links) {
    if (l.kind !== 'portal') continue;
    const typeId = idFor(l.art, 'portal', `portal link ${l.from}->${l.to} art`);
    const sql = `UPDATE map_links SET entity_type_id = $4
                  WHERE from_world_id = $1 AND edge = 'PORTAL' AND from_x = $2 AND from_y = $3`;
    await client.query(sql, [idByKey.get(l.from), l.from_x, l.from_y, typeId]);
    await client.query(sql, [idByKey.get(l.to), l.to_x, l.to_y, typeId]);
    n.portals += 1;
    if (l.is_waypoint === true) {
      const wpId = idFor(l.waypoint_art, 'waypoint', `portal link ${l.from}->${l.to} waypoint_art`);
      await client.query('UPDATE waypoints SET entity_type_id = $2 WHERE name = $1', [l.waypoint_name, wpId]);
      n.waypoints += 1;
    }
  }

  for (const w of worlds) {
    for (const wp of w.waypoints ?? []) {
      const wpId = idFor(wp.art, 'waypoint', `world "${w.key}" waypoint "${wp.name}" art`);
      await client.query('UPDATE waypoints SET entity_type_id = $2 WHERE name = $1', [wp.name, wpId]);
      n.waypoints += 1;
    }
    for (const v of villagesOf(w)) {
      const art = v.art || {};
      const ids = VILLAGE_POST_KINDS.map((k) => idFor(art[k], k, `world "${w.key}" village "${v.key}" art ${k}`));
      const sets = VILLAGE_POST_KINDS.map((k, i) => `${villageArtColumn(k)} = $${i + 3}`).join(', ');
      await client.query(
        `UPDATE villages SET ${sets} WHERE world_id = $1 AND spec_key = $2`,
        [idByKey.get(w.key), v.key, ...ids],
      );
      n.villages += 1;
    }
    if (w.chest) {
      const chestId = idFor(w.chest.art, 'chest_vault', `world "${w.key}" chest art`);
      await client.query(
        `UPDATE world_chests SET entity_type_id = $2 WHERE world_id = $1 AND kind = 'vault'`,
        [idByKey.get(w.key), chestId],
      );
      n.chests += 1;
    }
  }
  return n;
}

module.exports = {
  chestPointKind, resolvePointArt, loadPointKindDefaults, loadPointTypeNames, applyPointArt,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/pointArt.test.js; echo EXIT=$?`
Expected: EXIT=0

- [ ] **Step 5: Wire seed-map**

In `backend/scripts/seed-map.js`:
- `const { applyPointArt, loadPointTypeNames } = require('../src/services/pointArt.js');`
- In `catalogs` (~line 160) add `pointArtTypes: await loadPointTypeNames(pool),`.
- After the vault-chest pass (the loop that calls `insertVaultChest`, ~line 610) and BEFORE the pens pass, add:

```js
    // Art bindings (SOMET-581). Last of the instance passes so every portal
    // row, waypoint row, village row and vault chest this spec authors exists
    // to be updated. Converges to the spec: a binding the spec no longer
    // names is written back to NULL (the kind default), never left behind.
    const artCounts = await applyPointArt(client, spec, idByKey);
```

- Add `artCounts.portals` / `.waypoints` / `.villages` / `.chests` to the summary `console.log` near line 849 as `art: P portals, W waypoints, V villages, C chests`.

- [ ] **Step 6: Re-seed a scratch copy? No — verify on the dev stack with the unchanged spec**

The real specs carry no `art` yet, so `make seed-map SPEC=vale-region` must be a no-op for art. Run it and check:
`docker exec -i something2-db-1 psql -U user -d game_db -Atc "SELECT count(*) FROM map_links WHERE entity_type_id IS NOT NULL"` → `0`, and the summary line prints the counts. If seed-map refuses because the vale-region seed order matters (memory: seed both specs, vale-region LAST), follow that order.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/pointArt.js backend/scripts/seed-map.js backend/tests/pointArt.test.js
git commit -m "feat(maps): pointArt service resolves bindings and seed-map converges art columns to the spec (SOMET-581)"
```

---

## Slice 3 — Wire and renderer

### Task 6: Fetchers join the art name; authority resolves `art` per point

**Files:**
- Modify: `backend/src/services/mapLinks.js` (`fetchLinks`), `waypoints.js` (`fetchWaypoints`), `villages.js` (`fetchVillages`), `chests.js` (`fetchChests`, `mapChestRow`), `landmarks.js` (`buildLandmarks`)
- Modify: `backend/src/authority/server.js` — `portalLinks` map (~line 642), `entry` (~695), `joined` payload (~1773–1803), `broadcastChests` (~1372)
- Test: `backend/tests/landmarks.test.js` (update shapes), `backend/tests/pointArt_wire.test.js`

**Interfaces:**
- `fetchLinks` rows gain `art` (name or null); `portalLinks` map values gain `art`.
- `fetchWaypoints` rows gain `art`.
- `fetchVillages` rows gain `merchantArt`, `bankArt`, `gemMerchantArt`, `skillMerchantArt`.
- `mapChestRow` gains `art` (null when the row has none, e.g. `spawnFieldChest`'s `RETURNING *` — that row has `entity_type_id` but no joined name; treat as null → default).
- `buildLandmarks({ waypoints, portalLinks, activatedIds, artDefaults })` → every landmark carries `art: string|null`.
- `entry.pointArtDefaults: Map<kind, name>`; `joined.merchants[] / banks[] / gemMerchants[] / skillMerchants[]` gain `art`; `chests` frame entries gain `art`.

- [ ] **Step 1: Write the failing tests**

Update `backend/tests/landmarks.test.js`: every expected landmark object gains `art: null` (there are four `deepStrictEqual` sites: waypoint-only, portal-only, both-kinds, and any in `landmarks_joined_live.test.js` line ~147 — add `art: null` there too, since no default is seeded in that harness's DB; if that live test seeds catalogs, expect the placeholder names instead). Then add:

```js
test('landmarks resolve art: instance binding, then kind default, else null', () => {
  const artDefaults = new Map([['portal', 'portal'], ['waypoint', 'waypoint_stone']]);
  const out = buildLandmarks({
    waypoints: new Map([[...wp('a', 3250, 3250, 'Commons')].map((v, i) => (i === 1 ? { ...v, art: null } : v))]),
    portalLinks: new Map([[...portal('p', 3150, 3450, 'Pass')].map((v, i) => (i === 1 ? { ...v, art: 'stone_gate' } : v))]),
    activatedIds: new Set(),
    artDefaults,
  });
  assert.strictEqual(out.find((l) => l.kind === 'waypoint').art, 'waypoint_stone');
  assert.strictEqual(out.find((l) => l.kind === 'portal').art, 'stone_gate');
  const none = buildLandmarks({ waypoints: new Map([wp('a', 1, 1, 'X')]), portalLinks: new Map(), activatedIds: new Set() });
  assert.strictEqual(none[0].art, null);
});
```

```js
// backend/tests/pointArt_wire.test.js
const test = require('node:test');
const assert = require('node:assert');
const { fetchLinks } = require('../src/services/mapLinks.js');
const { fetchWaypoints } = require('../src/services/waypoints.js');
const { fetchVillages } = require('../src/services/villages.js');
const { fetchChests, mapChestRow } = require('../src/services/chests.js');

// Each fetcher must carry its art NAME out of the one query it already
// makes -- a second loader is the SOMET-249 inertness trap.
test('fetchLinks joins the art name onto every row', async () => {
  const pool = { query: async (sql) => {
    assert.match(sql, /LEFT JOIN entity_types \w+ ON \w+\.id = ml\.entity_type_id/);
    assert.match(sql, /AS art/);
    return { rows: [{ id: 1, edge: 'PORTAL', art: 'stone_gate' }] };
  } };
  const rows = await fetchLinks(pool, 'w');
  assert.strictEqual(rows[0].art, 'stone_gate');
});

test('fetchWaypoints maps art', async () => {
  const pool = { query: async (sql) => {
    assert.match(sql, /LEFT JOIN entity_types/);
    return { rows: [{ id: 'a', world_id: 'w', x: '1', y: '2', name: 'S', map_link_id: null, art: null }] };
  } };
  const [w] = await fetchWaypoints(pool, 'w');
  assert.strictEqual(w.art, null);
});

test('fetchVillages maps the four post art names', async () => {
  const pool = { query: async (sql) => {
    for (const c of ['merchant_entity_type_id', 'bank_entity_type_id', 'gem_merchant_entity_type_id', 'skill_merchant_entity_type_id']) {
      assert.match(sql, new RegExp(c));
    }
    return { rows: [{ id: 'v', min_row: 0, min_col: 0, width: 8, height: 8, gate_edge: 'S', spawn_x: 1, spawn_y: 1,
      merchant_x: 450, merchant_y: 450, merchant_art: 'merchant_post', bank_art: null, gem_merchant_art: null, skill_merchant_art: 'lectern' }] };
  } };
  const [v] = await fetchVillages(pool, 'w');
  assert.deepStrictEqual(
    { m: v.merchantArt, b: v.bankArt, g: v.gemMerchantArt, s: v.skillMerchantArt },
    { m: 'merchant_post', b: null, g: null, s: 'lectern' },
  );
});

test('mapChestRow carries art and defaults it to null for a raw RETURNING row', () => {
  assert.strictEqual(mapChestRow({ id: 1, x: 1, y: 1, kind: 'vault', state: 'locked', art: 'chest_vault' }).art, 'chest_vault');
  assert.strictEqual(mapChestRow({ id: 1, x: 1, y: 1, kind: 'field', state: 'locked' }).art, null);
});

test('fetchChests joins the art name', async () => {
  const pool = { query: async (sql) => {
    assert.match(sql, /LEFT JOIN entity_types/);
    return { rows: [{ id: 1, x: 1, y: 1, kind: 'vault', state: 'locked', art: 'chest_vault' }] };
  } };
  const [c] = await fetchChests(pool, 'w');
  assert.strictEqual(c.art, 'chest_vault');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/landmarks.test.js tests/pointArt_wire.test.js; echo EXIT=$?`
Expected: EXIT=1

- [ ] **Step 3: Implement the fetchers**

`mapLinks.js` `fetchLinks`:

```js
    `SELECT ml.id, ml.edge, ml.to_world_id, w.width AS to_width, w.height AS to_height,
            w.name AS to_name,
            ml.from_x, ml.from_y, ml.to_x, ml.to_y,
            pa.name AS art
     FROM map_links ml JOIN worlds w ON w.id = ml.to_world_id
     LEFT JOIN entity_types pa ON pa.id = ml.entity_type_id
     WHERE ml.from_world_id = $1`,
```

`waypoints.js` `fetchWaypoints`:

```js
    `SELECT wp.id, wp.world_id, wp.x, wp.y, wp.name, wp.map_link_id, pa.name AS art
       FROM waypoints wp
       LEFT JOIN entity_types pa ON pa.id = wp.entity_type_id
      WHERE wp.world_id = $1 ORDER BY wp.created_at ASC`,
```
and add `art: w.art ?? null,` to the mapped object.

`villages.js` `fetchVillages`:

```js
    `SELECT v.id, v.min_row, v.min_col, v.width, v.height, v.gate_edge, v.spawn_x, v.spawn_y,
            v.merchant_x, v.merchant_y,
            ma.name AS merchant_art, ba.name AS bank_art,
            ga.name AS gem_merchant_art, sa.name AS skill_merchant_art
       FROM villages v
       LEFT JOIN entity_types ma ON ma.id = v.merchant_entity_type_id
       LEFT JOIN entity_types ba ON ba.id = v.bank_entity_type_id
       LEFT JOIN entity_types ga ON ga.id = v.gem_merchant_entity_type_id
       LEFT JOIN entity_types sa ON sa.id = v.skill_merchant_entity_type_id
      WHERE v.world_id = $1 ORDER BY v.created_at ASC`,
```
and in the returned object add `merchantArt: v.merchant_art ?? null, bankArt: v.bank_art ?? null, gemMerchantArt: v.gem_merchant_art ?? null, skillMerchantArt: v.skill_merchant_art ?? null,`.

`chests.js`: `mapChestRow` adds `art: c.art ?? null,`; `fetchChests`:

```js
    `SELECT c.id, c.x, c.y, c.kind, c.guard_entity_type_id, c.guard_level, c.guard_creature_ids,
            c.state, c.opened_at, c.respawn_at, pa.name AS art
       FROM world_chests c
       LEFT JOIN entity_types pa ON pa.id = c.entity_type_id
      WHERE c.world_id = $1 ORDER BY c.created_at ASC`,
```

`landmarks.js`: `const { resolvePointArt } = require('./pointArt');` (pure, no authority import — same discipline the header describes). `buildLandmarks({ waypoints, portalLinks, activatedIds, artDefaults } = {})`; waypoint entries add `art: resolvePointArt('waypoint', w.art, artDefaults),`; portal entries add `art: resolvePointArt('portal', p.art, artDefaults),`. Update the header comment's shape line to `{ kind, x, y, name, activated, art }`.

- [ ] **Step 4: Wire the authority**

In `server.js`:
- `const { loadPointKindDefaults, resolvePointArt, chestPointKind } = require('../services/pointArt');`
- In the `portalLinks` map value add `art: l.art ?? null,`.
- After `const chests = await fetchChests(pool, canonicalId);` add `const pointArtDefaults = await loadPointKindDefaults(pool);` and put `pointArtDefaults` on `entry`.
- In the `joined` payload: each of the four village-post `.map(...)` gains an `art` field:
  - merchants: `art: resolvePointArt('merchant', v.merchantArt, entry.pointArtDefaults)`
  - banks: `art: resolvePointArt('bank', v.bankArt, entry.pointArtDefaults)`
  - gemMerchants: `art: resolvePointArt('gem_merchant', v.gemMerchantArt, entry.pointArtDefaults)`
  - skillMerchants: `art: resolvePointArt('skill_merchant', v.skillMerchantArt, entry.pointArtDefaults)`
  - `landmarks: buildLandmarks({ waypoints: entry.waypoints, portalLinks: entry.portalLinks, activatedIds: activatedWaypointIds, artDefaults: entry.pointArtDefaults })`
- In `broadcastChests`, the mapped chest gains `art: resolvePointArt(chestPointKind(c.kind), c.art, entry.pointArtDefaults)`.

Add to `backend/tests/pointArt_wire.test.js`:

```js
test('resolvePointArt is what the joined frame and the chests frame call', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/authority/server.js'), 'utf8');
  assert.match(src, /art: resolvePointArt\('merchant', v\.merchantArt, entry\.pointArtDefaults\)/);
  assert.match(src, /art: resolvePointArt\('bank', v\.bankArt, entry\.pointArtDefaults\)/);
  assert.match(src, /art: resolvePointArt\('gem_merchant', v\.gemMerchantArt, entry\.pointArtDefaults\)/);
  assert.match(src, /art: resolvePointArt\('skill_merchant', v\.skillMerchantArt, entry\.pointArtDefaults\)/);
  assert.match(src, /art: resolvePointArt\(chestPointKind\(c\.kind\), c\.art, entry\.pointArtDefaults\)/);
  assert.match(src, /artDefaults: entry\.pointArtDefaults/);
});
```

(A source gate — it proves the call is WRITTEN, not that it runs; the live test below proves it runs.)

- [ ] **Step 5: Extend the live join test (scratch DB only)**

`backend/tests/landmarks_joined_live.test.js` already joins a world and asserts `joined.landmarks`. Add, inside the existing test after the landmarks assertion: insert a `world_point_kinds` default for `portal` pointing at an entity type row the harness creates (`INSERT INTO entity_types (name, color, point_kind) VALUES ('t_portal', '#fff', 'portal') RETURNING id`, then `UPDATE world_point_kinds SET default_entity_type_id = $1 WHERE kind = 'portal'`), re-join (a fresh `loadWorld` — follow how that file forces a reload, or use a second world), and assert `joined.landmarks.find(l => l.kind === 'portal').art === 't_portal'`; clean both rows in the test's cleanup. Run ONLY with:

```bash
export TEST_DATABASE_URL=postgres://user:password@localhost:15432/s2_scratch_pointart
export DATABASE_URL=$TEST_DATABASE_URL
```

(create the scratch DB, run `npm run migrate:up` there and `node scripts/seed-catalogs.js`, then `node --test tests/landmarks_joined_live.test.js; echo EXIT=$?`). Expected EXIT=0. Note in the commit body that it was run on a scratch DB.

- [ ] **Step 6: Run the unit tests**

Run: `cd backend && node --test tests/landmarks.test.js tests/pointArt_wire.test.js tests/pointArt.test.js; echo EXIT=$?`
Expected: EXIT=0

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/mapLinks.js backend/src/services/waypoints.js backend/src/services/villages.js backend/src/services/chests.js backend/src/services/landmarks.js backend/src/authority/server.js backend/tests/landmarks.test.js backend/tests/landmarks_joined_live.test.js backend/tests/pointArt_wire.test.js
git commit -m "feat(authority): resolve world point art and ship it on landmarks, village posts and chests (SOMET-582)"
```

---

### Task 7: Client pure resolution + `stateKey` seam

**Files:**
- Create: `frontend/src/games/something2/src/js/systems/pointArt.js`
- Modify: `frontend/src/games/something2/src/js/systems/spriteAtlas.js` (add `stateFrameKey`)
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js` — `resolveSprite` (~line 2683)
- Test: `frontend/src/games/something2/src/js/systems/__tests__/pointArt.test.js`, `frontend/src/games/something2/src/js/systems/__tests__/spriteAtlas.test.js` (extend if it exists, else create)

**Interfaces:**
- Produces in `pointArt.js`:
  - `pointArtDef(artName, entityDefs) → def|null` — the catalog def (from `Game.entityDefs`, name-keyed, camelCase `displayWidth/displayHeight`, `render_mode`, `image`, `sprite`) only when it has drawable art (`render_mode !== 'rect'` and (`image` or `sprite`)).
  - `pointBodyRef(def, x, y, extra = {}) → { ...def, ...extra, x: x - 50, y: y - 50, width: 100, height: 100 }` — drawEntity-ready.
  - `pointStateTreatment(kind, point) → { alpha, ring, stateKey }`: waypoint unactivated → `{ alpha: 0.45, ring: true, stateKey: 'unlit' }`; waypoint activated → `{ 1, false, 'lit' }`; chest → `{ alpha: state==='opened' ? 0.45 : 1, ring: false, stateKey: state }`; anything else `{ 1, false, null }`.
  - `planLandmarkBodies(landmarks, entityDefs) → { bodies: [{ landmark, def, treatment }], skipBody: Set<landmark> }` — a waypoint on the same tile as a portal that has art gets no body (but stays out of `skipBody` only if it has no art itself).
- Produces `stateFrameKey(manifest, stateKey) → key|null` in `spriteAtlas.js`.
- `RenderSystem.resolveSprite(entity, imageManager, mode, timeMs = 0)` reads `entity.stateKey` and prefers `stateFrameKey(manifest, entity.stateKey)` when present.

- [ ] **Step 1: Write the failing tests**

```js
// frontend/src/games/something2/src/js/systems/__tests__/pointArt.test.js
import { describe, it, expect } from 'vitest';
import { pointArtDef, pointBodyRef, pointStateTreatment, planLandmarkBodies } from '../pointArt.js';

const DEFS = {
  portal: { id: 1, render_mode: 'static', image: 'sprites/portal.png', displayWidth: 110, displayHeight: 130 },
  bare: { id: 2, render_mode: 'rect', image: null, sprite: null },
  rect_with_image: { id: 3, render_mode: 'rect', image: 'x.png' },
  sheet: { id: 4, render_mode: 'animated', sprite: { atlas_key: 'a', manifest: { frames: { '0': [0, 0, 8, 8] } } } },
};

describe('pointArtDef', () => {
  it('returns the def only when it has drawable art', () => {
    expect(pointArtDef('portal', DEFS)).toBe(DEFS.portal);
    expect(pointArtDef('sheet', DEFS)).toBe(DEFS.sheet);
    expect(pointArtDef('bare', DEFS)).toBeNull();
    expect(pointArtDef('rect_with_image', DEFS)).toBeNull();
    expect(pointArtDef('missing', DEFS)).toBeNull();
    expect(pointArtDef(null, DEFS)).toBeNull();
    expect(pointArtDef('portal', null)).toBeNull();
  });
});

describe('pointBodyRef', () => {
  it('anchors the body like a decoration: tile top-left with a full-tile box', () => {
    const r = pointBodyRef(DEFS.portal, 3250, 3450, { stateKey: 'lit' });
    expect(r).toMatchObject({ x: 3200, y: 3400, width: 100, height: 100, displayWidth: 110, displayHeight: 130, stateKey: 'lit' });
  });
});

describe('pointStateTreatment', () => {
  it('dims an unlit waypoint and rings it', () => {
    expect(pointStateTreatment('waypoint', { activated: false })).toEqual({ alpha: 0.45, ring: true, stateKey: 'unlit' });
    expect(pointStateTreatment('waypoint', { activated: true })).toEqual({ alpha: 1, ring: false, stateKey: 'lit' });
  });
  it('dims an opened chest only', () => {
    expect(pointStateTreatment('chest', { state: 'opened' })).toEqual({ alpha: 0.45, ring: false, stateKey: 'opened' });
    expect(pointStateTreatment('chest', { state: 'locked' })).toEqual({ alpha: 1, ring: false, stateKey: 'locked' });
  });
  it('is neutral for everything else', () => {
    expect(pointStateTreatment('merchant', {})).toEqual({ alpha: 1, ring: false, stateKey: null });
  });
});

describe('planLandmarkBodies', () => {
  const portal = { kind: 'portal', x: 3150, y: 3450, name: 'To X', activated: false, art: 'portal' };
  const wpSame = { kind: 'waypoint', x: 3150, y: 3450, name: 'Gate', activated: false, art: 'portal' };
  const wpElse = { kind: 'waypoint', x: 1050, y: 1050, name: 'Stone', activated: true, art: 'portal' };
  const wpNoArt = { kind: 'waypoint', x: 2050, y: 2050, name: 'Plain', activated: true, art: null };
  it('gives every landmark with drawable art a body and skips its diamond', () => {
    const plan = planLandmarkBodies([portal, wpElse, wpNoArt], DEFS);
    expect(plan.bodies.map((b) => b.landmark)).toEqual([portal, wpElse]);
    expect(plan.bodies[1].treatment).toEqual({ alpha: 1, ring: false, stateKey: 'lit' });
    expect(plan.skipBody.has(portal)).toBe(true);
    expect(plan.skipBody.has(wpNoArt)).toBe(false);
  });
  it('a waypoint sharing a portal tile draws no body of its own', () => {
    const plan = planLandmarkBodies([portal, wpSame], DEFS);
    expect(plan.bodies.map((b) => b.landmark)).toEqual([portal]);
    expect(plan.skipBody.has(wpSame)).toBe(true);
  });
  it('tolerates a missing catalog', () => {
    const plan = planLandmarkBodies([portal], null);
    expect(plan.bodies).toEqual([]);
    expect(plan.skipBody.size).toBe(0);
  });
});
```

Append to the spriteAtlas test file (create `__tests__/spriteAtlas.test.js` with the vitest header if absent):

```js
import { stateFrameKey } from '../spriteAtlas.js';
describe('stateFrameKey', () => {
  const manifest = { frames: { 'S/0': [0, 0, 8, 8], opened: [8, 0, 8, 8] } };
  it('returns the named state frame when the manifest has it', () => {
    expect(stateFrameKey(manifest, 'opened')).toBe('opened');
  });
  it('returns null when absent so callers fall through to current behaviour', () => {
    expect(stateFrameKey(manifest, 'locked')).toBeNull();
    expect(stateFrameKey(manifest, null)).toBeNull();
    expect(stateFrameKey(null, 'opened')).toBeNull();
  });
});
```

And in `__tests__/RenderSystem*.test.js` (pick the file that already tests `resolveSprite`; if none, add to `pointArt.test.js`):

```js
import { RenderSystem } from '../RenderSystem.js';
describe('resolveSprite stateKey seam', () => {
  const manifest = { frames: { 'S/0': [0, 0, 8, 8], opened: [8, 0, 8, 8] } };
  const img = { width: 16, height: 8 };
  const imageManager = { get: (k) => (k === 'atlas' ? img : null) };
  const entity = { sprite: { atlas_key: 'atlas', manifest } };
  it('uses the state frame when present', () => {
    expect(RenderSystem.resolveSprite({ ...entity, stateKey: 'opened' }, imageManager, 'static', 0).crop).toEqual([8, 0, 8, 8]);
  });
  it('falls back to the static frame when the state frame is absent', () => {
    expect(RenderSystem.resolveSprite({ ...entity, stateKey: 'locked' }, imageManager, 'static', 0).crop).toEqual([0, 0, 8, 8]);
    expect(RenderSystem.resolveSprite(entity, imageManager, 'static', 0).crop).toEqual([0, 0, 8, 8]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/pointArt.test.js src/games/something2/src/js/systems/__tests__/spriteAtlas.test.js; echo EXIT=$?`
Expected: EXIT=1

- [ ] **Step 3: Implement**

`spriteAtlas.js` (append):

```js
// --- State frames ------------------------------------------------------------
// A world point (chest, waypoint) MAY one day ship a frame per state
// ("opened", "unlit"). Nothing generates such frames yet; this is the seam so
// they can land as a pipeline change with no renderer edit. Null when absent,
// so every caller falls through to the frame it would have picked anyway.
export function stateFrameKey(manifest, stateKey) {
  if (!stateKey || typeof stateKey !== "string") return null;
  return frameRect(manifest, stateKey) ? stateKey : null;
}
```

`RenderSystem.js` `resolveSprite`: import `stateFrameKey` from `./spriteAtlas.js` alongside the others, and change the key selection to:

```js
    const stateKey = stateFrameKey(manifest, entity.stateKey);
    const key = stateKey || (mode === "animated"
      ? (animatedFrameKey(manifest, facingToDir(entity.facing), timeMs)
         || tileFrameKey(manifest, timeMs)
         || staticFrameKey(entity.sprite, manifest))
      : staticFrameKey(entity.sprite, manifest));
```

`pointArt.js`:

```js
// Pure client-side resolution of world point art (SOMET-583). No canvas, no
// DOM: the renderer calls these and draws through drawEntity.
//
// `entityDefs` is Game.entityDefs -- the /api/map/config entityTypes map,
// name-keyed, camelCase sizes (displayWidth/displayHeight), snake_case
// render_mode/sprite (see getEntityTypesMap in backend/src/index.js).
import { MAP_TILE_SIZE } from "../core/constants.js";

// Drawable art only. A 'rect' type or one with neither image nor sprite is
// "no art" -- the caller keeps today's placeholder shape, never a hole.
export function pointArtDef(artName, entityDefs) {
  if (!artName || !entityDefs) return null;
  const def = entityDefs[artName];
  if (!def || def.render_mode === "rect" || !def.render_mode) return null;
  if (!def.image && !def.sprite) return null;
  return def;
}

// A world point's x/y is its tile CENTRE. drawEntity centres on
// (x + width/2, y + height/2), so hand it the tile's top-left and a
// full-tile box -- byte-for-byte what collectDecorations does.
export function pointBodyRef(def, x, y, extra = {}) {
  return {
    ...def, ...extra,
    x: x - MAP_TILE_SIZE / 2, y: y - MAP_TILE_SIZE / 2,
    width: MAP_TILE_SIZE, height: MAP_TILE_SIZE,
  };
}

const DIM = 0.45;

export function pointStateTreatment(kind, point) {
  if (kind === "waypoint") {
    const lit = point && point.activated === true;
    return { alpha: lit ? 1 : DIM, ring: !lit, stateKey: lit ? "lit" : "unlit" };
  }
  if (kind === "chest") {
    const state = (point && point.state) || "locked";
    return { alpha: state === "opened" ? DIM : 1, ring: false, stateKey: state };
  }
  return { alpha: 1, ring: false, stateKey: null };
}

const tileKey = (l) => `${Math.floor(l.y / MAP_TILE_SIZE)},${Math.floor(l.x / MAP_TILE_SIZE)}`;

// Which landmarks get an art body, and which diamonds landmarkRenderer must
// therefore not draw. A flagged staircase (is_waypoint: true) is a portal AND
// a waypoint on ONE tile; two bodies there would be one gate drawn twice, so
// the portal's wins and the waypoint keeps only its beam, label and ring.
export function planLandmarkBodies(landmarks, entityDefs) {
  const bodies = [];
  const skipBody = new Set();
  if (!Array.isArray(landmarks) || !entityDefs) return { bodies, skipBody };
  const portalArtTiles = new Set(
    landmarks.filter((l) => l && l.kind === "portal" && pointArtDef(l.art, entityDefs)).map(tileKey),
  );
  for (const l of landmarks) {
    if (!l) continue;
    const def = pointArtDef(l.art, entityDefs);
    if (!def) continue;
    if (l.kind === "waypoint" && portalArtTiles.has(tileKey(l))) {
      skipBody.add(l);
      continue;
    }
    skipBody.add(l);
    bodies.push({ landmark: l, def, treatment: pointStateTreatment(l.kind, l) });
  }
  return { bodies, skipBody };
}
```

Check `MAP_TILE_SIZE`'s real import path with `grep -rn "export const MAP_TILE_SIZE" frontend/src/games/something2/src/js` and use that.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems; echo EXIT=$?`
Expected: EXIT=0

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/pointArt.js frontend/src/games/something2/src/js/systems/spriteAtlas.js frontend/src/games/something2/src/js/systems/RenderSystem.js frontend/src/games/something2/src/js/systems/__tests__/
git commit -m "feat(render): pure world point art resolution and the sprite stateKey seam (SOMET-583)"
```

---

### Task 8: Renderer integration — bodies in the depth sort, placeholders as fallback

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/landmarkRenderer.js` (`drawLandmarks` gains `skipBody`)
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js` — `renderChunked` params (~line 283), landmark call (~393), drawables assembly (~425–450), draw switch (~457–469), `drawMerchant` (2226), `drawGemMerchant` (2266), `drawSkillMerchant` (2317), `drawBank` (2368), `drawWorldChest` (2428)
- Modify: `frontend/src/games/something2/src/js/core/Game.js` — render call (~line 1392)
- Test: `frontend/src/games/something2/src/js/systems/__tests__/landmarkRenderer.test.js` (extend), `__tests__/pointArtRender.test.js`

**Interfaces:**
- `drawLandmarks(ctx, { landmarks, phase, halfW, halfH, skipBody = null })` — when `skipBody.has(l)`, the diamond fill/stroke is skipped; beam and label still draw.
- `RenderSystem#drawPointBody(def, x, y, treatment)` — saves, sets `globalAlpha = treatment.alpha`, draws a ground ring when `treatment.ring`, calls `this.drawEntity(pointBodyRef(def, x, y, { stateKey: treatment.stateKey }))`, restores.
- `RenderSystem#_drawPointArtAt(artName, x, y, treatment) → boolean` — true when art drew (placeholder must be skipped).
- `renderChunked` accepts `entityDefs` (name-keyed catalog) and pushes `{ kind: "pointart", ref: { def, x, y, treatment }, order: 0, depth: depthKey(x, y) }` drawables for landmark bodies.

- [ ] **Step 1: Write the failing tests**

Extend `landmarkRenderer.test.js`:

```js
it('skipBody suppresses the diamond but keeps the beam and label', () => {
  const ctx = stubCtx();
  ctx.fillText = ctx.calls.push.bind(ctx.calls); ctx.measureText = () => ({ width: 40 });
  drawLandmarks(ctx, { landmarks: [PORTAL], phase: 0, halfW: 50, halfH: 25, skipBody: new Set([PORTAL]) });
  expect(ctx.calls.filter((c) => c.name === 'fill').length).toBe(0);   // no diamond fill
  expect(ctx.calls.filter((c) => c.name === 'fillRect').length).toBeGreaterThanOrEqual(1); // beam
});
it('without skipBody the diamond is still filled', () => {
  const ctx = stubCtx();
  drawLandmarks(ctx, { landmarks: [PORTAL], phase: 0, halfW: 50, halfH: 25 });
  expect(ctx.calls.filter((c) => c.name === 'fill').length).toBe(1);
});
```

```js
// frontend/src/games/something2/src/js/systems/__tests__/pointArtRender.test.js
import { describe, it, expect, vi } from 'vitest';
import { RenderSystem } from '../RenderSystem.js';

// The green-over-dead-feature guard (SOMET-468 x4): a bound name can reach
// the renderer and still never hit drawImage. These tests assert the
// drawImage call itself.
function ctxSpy() {
  const noop = () => {};
  return new Proxy({ drawImage: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), strokeText: vi.fn(),
    measureText: () => ({ width: 10 }), save: noop, restore: noop, beginPath: noop, moveTo: noop,
    lineTo: noop, closePath: noop, fill: noop, stroke: noop, arc: noop, ellipse: noop, globalAlpha: 1,
  }, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
}
const IMG = { width: 64, height: 64 };
const DEFS = { portal: { render_mode: 'static', image: 'portal.png', displayWidth: 110, displayHeight: 130 } };

function rs() {
  const r = Object.create(RenderSystem.prototype);
  r.ctx = ctxSpy();
  r.imageManager = { get: (k) => (k === 'portal.png' ? IMG : null) };
  r.nowMs = 0;
  r._labelCache = { get: () => null };
  r.renderModeOverride = null;
  r.entityDefs = DEFS;
  return r;
}

describe('drawPointBody', () => {
  it('draws the bound image through drawEntity with the treatment alpha', () => {
    const r = rs();
    r.drawPointBody(DEFS.portal, 3250, 3450, { alpha: 0.45, ring: true, stateKey: 'unlit' });
    expect(r.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(r.ctx.drawImage.mock.calls[0][0]).toBe(IMG);
  });
});

describe('_drawPointArtAt', () => {
  it('returns true and draws when the name resolves to art', () => {
    const r = rs();
    expect(r._drawPointArtAt('portal', 3250, 3450, { alpha: 1, ring: false, stateKey: null })).toBe(true);
    expect(r.ctx.drawImage).toHaveBeenCalledTimes(1);
  });
  it('returns false and draws nothing when the name has no art, so the placeholder runs', () => {
    const r = rs();
    expect(r._drawPointArtAt('nothing', 1, 1, { alpha: 1, ring: false, stateKey: null })).toBe(false);
    expect(r._drawPointArtAt(null, 1, 1, { alpha: 1, ring: false, stateKey: null })).toBe(false);
    expect(r.ctx.drawImage).not.toHaveBeenCalled();
  });
});

describe('placeholder fallbacks keep drawing', () => {
  it('drawMerchant with no art still draws its caption', () => {
    const r = rs();
    r.drawMerchant({ x: 450, y: 450, art: null });
    expect(r.ctx.fillText).toHaveBeenCalledWith('Merchant', expect.any(Number), expect.any(Number));
    expect(r.ctx.drawImage).not.toHaveBeenCalled();
  });
  it('drawMerchant with art draws the image and still the caption', () => {
    const r = rs();
    r.drawMerchant({ x: 450, y: 450, art: 'portal' });
    expect(r.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(r.ctx.fillText).toHaveBeenCalledWith('Merchant', expect.any(Number), expect.any(Number));
  });
  it('drawWorldChest with art dims an opened chest and keeps the label', () => {
    const r = rs();
    r.drawWorldChest({ x: 450, y: 450, kind: 'vault', state: 'opened', art: 'portal' }, null);
    expect(r.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(r.ctx.fillText).toHaveBeenCalledWith('Looted', expect.any(Number), expect.any(Number));
  });
});
```

If `Object.create(RenderSystem.prototype)` misses a field `drawEntity` reads (e.g. `_drawEffectRings` needs something), stub it on `r` in `rs()` — keep the test about `drawImage`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/pointArtRender.test.js src/games/something2/src/js/systems/__tests__/landmarkRenderer.test.js; echo EXIT=$?`
Expected: EXIT=1 (`drawPointBody is not a function`, skipBody ignored)

- [ ] **Step 3: Implement `landmarkRenderer.js`**

Signature `drawLandmarks(ctx, { landmarks, phase, halfW, halfH, skipBody = null } = {})`. Wrap the diamond block:

```js
    // An art body (SOMET-584) replaces the diamond, drawn later inside the
    // depth sort by RenderSystem. Beam and label stay: they are the "there
    // is a landmark here" signal, and a gate the player cannot find is not a
    // gate.
    const bodyElsewhere = skipBody && typeof skipBody.has === "function" && skipBody.has(l);
    if (!bodyElsewhere) {
      const filled = l.kind !== "waypoint" || l.activated === true;
      diamondPath(ctx, s.x, s.y, halfW, halfH);
      if (filled) { ctx.fillStyle = color; ctx.fill(); }
      else { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke(); }
    }
```

- [ ] **Step 4: Implement `RenderSystem.js`**

Imports: `import { pointArtDef, pointBodyRef, pointStateTreatment, planLandmarkBodies } from "./pointArt.js";`

Add two methods next to `drawMerchant`:

```js
  // World point art (SOMET-584). One body path for every fixed point: the
  // bound type draws through drawEntity exactly as a decoration does, with
  // the treatment's alpha on top and, for an unlit waypoint, a ground ring
  // so the state is legible on any art.
  drawPointBody(def, x, y, treatment = { alpha: 1, ring: false, stateKey: null }) {
    const s = worldToScreen(x, y);
    this.ctx.save();
    if (treatment.ring) {
      this.ctx.globalAlpha = 0.9;
      this.ctx.strokeStyle = "#7dd3fc";
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.ellipse(s.x, s.y, 28, 14, 0, 0, Math.PI * 2);
      this.ctx.stroke();
    }
    this.ctx.globalAlpha = treatment.alpha;
    this.drawEntity(pointBodyRef(def, x, y, { stateKey: treatment.stateKey }));
    this.ctx.restore();
  }

  // True when art drew, so the caller skips its placeholder shape and keeps
  // only its caption/prompt. False (and nothing drawn) otherwise.
  _drawPointArtAt(artName, x, y, treatment) {
    const def = pointArtDef(artName, this.entityDefs);
    if (!def) return false;
    this.drawPointBody(def, x, y, treatment);
    return true;
  }
```

`renderChunked`: add `entityDefs = null` to the destructured options and `this.entityDefs = entityDefs;` as the first line of the body. Replace the `drawLandmarks(...)` call with:

```js
    const landmarkPlan = planLandmarkBodies(landmarks, this.entityDefs);
    drawLandmarks(this.ctx, { landmarks, phase: this.nowMs, halfW, halfH, skipBody: landmarkPlan.skipBody });
```

In the drawables assembly, after the `worldChests` loop:

```js
    // Landmark art bodies (SOMET-584) join the sort so a player walks behind a
    // gate; the flat pass above kept only their beam and label.
    for (const b of landmarkPlan.bodies) {
      drawables.push({ kind: "pointart", ref: { def: b.def, x: b.landmark.x, y: b.landmark.y, treatment: b.treatment }, order: 0, depth: depthKey(b.landmark.x, b.landmark.y) });
    }
```

In the draw switch add `else if (d.kind === "pointart") this.drawPointBody(d.ref.def, d.ref.x, d.ref.y, d.ref.treatment);` before the final `else`.

`drawMerchant`, `drawGemMerchant`, `drawSkillMerchant`, `drawBank`: at the top of each, after `const dx = s.x, dy = s.y;`, wrap ONLY the shape-drawing statements (from `const r = …` / `this.ctx.beginPath()` through the shape's `this.ctx.stroke()`; keep `this.ctx.save()` before and the caption `fillText` + prompt block after) in:

```js
    const kind = /* 'merchant' | 'gem_merchant' | 'skill_merchant' | 'bank' per function */;
    const drewArt = this._drawPointArtAt(m.art, m.x, m.y, pointStateTreatment(kind, m));
    if (!drewArt) { …existing shape… }
```

Note `this.ctx.save()` is currently before the shape and `restore()` at the end; `drawPointBody` does its own save/restore, so nesting is fine. Keep `this.ctx.fillStyle = "#fff"` etc. after the `if` so the caption still sets its own style.

`drawWorldChest`: same shape — after `const dx = s.x, dy = s.y;` compute `const drewArt = this._drawPointArtAt(c.art, c.x, c.y, pointStateTreatment('chest', c));` and wrap the body+lid+keyhole block (from `const r = 13;` … keyhole `fill()`) in `if (!drewArt) { … }`; keep `r` declared outside the `if` because the label and prompt use `dy - r - 6` / `dy + r + 14`.

`Game.js`: in the `render(...)` options object add `entityDefs: this.entityDefs,` next to `decoTypes: this.decoTypes,`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run; echo EXIT=$?`
Expected: EXIT=0

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/landmarkRenderer.js frontend/src/games/something2/src/js/systems/RenderSystem.js frontend/src/games/something2/src/js/core/Game.js frontend/src/games/something2/src/js/systems/__tests__/
git commit -m "feat(render): draw world point art inside the depth sort, placeholders as fallback (SOMET-584)"
```

---

## Slice 4 — Live verification

### Task 9: Browser verification with real art, full suites, memory note

**Files:**
- No source changes expected; screenshots into the scratchpad; `docs/superpowers/plans/2026-09-12-world-point-art.md` gets a "Verified" footer.

- [ ] **Step 1: Full suites**

```bash
cd backend && npm test; echo EXIT=$?        # unit-only unless TEST_DATABASE_URL is set to a scratch DB
cd frontend && npx vitest run; echo EXIT=$?
```
Both EXIT=0. If backend tests need the DB, use the scratch DB from Task 6 Step 5.

- [ ] **Step 2: Give `portal` an image**

Prefer the editor's generate path (`/game/admin/entity-types` → `portal` → generate → approve). If the 217 image provider is wedged (memory: wedged-image-provider-stays-green — `Test` says green while nothing generates; check free VRAM first), fall back to uploading any RGBA PNG (e.g. render a 128×160 magenta arch with Python `PIL` into the scratchpad) via `POST /api/entity-types/:id/image` (multipart, admin token). Confirm `render_mode` flipped to `static` and `image` is set: `curl -s localhost:13101/api/entity-types | jq '.[] | select(.name=="portal") | {render_mode,image}'`.

- [ ] **Step 3: Join a world with a portal and look**

Headless-Chrome/DevTools recipe from memory `dev-run-browser-verify` (register→login, token key, `exitFullscreen()` first). Join the entry world; walk to its portal pad (`landmarks` in the `joined` frame give the coordinates; `Shift+M` dev minimap helps). Take a screenshot. Expected: the uploaded image drawn at the portal tile, its base on the tile centre, the beam and `🌀 To …` pill above it, **no pink diamond**. Stand "behind" it (higher y) and confirm the player draws in front; stand in front and confirm the player is occluded correctly.

Pixel check (the canvas-marker-shape-drift lesson): in DevTools `evaluate_script`, read `getImageData` at the tile's screen position and assert the sampled colour is from the image, not `#f472b6`.

- [ ] **Step 4: State treatments**

Give `waypoint_stone` an image the same way. Join a world with an unactivated waypoint: dimmed + ring. Step on it (activation) → full alpha, ring gone. Open a vault chest with art (or set `world_chests.state='opened'` for one on the dev DB — a single-row UPDATE, note the id, revert after): dimmed body, `Looted` caption.

- [ ] **Step 5: Spec binding round-trip**

Create a second portal type in the editor (`stone_gate`, kind portal, upload a visibly different PNG). Edit `backend/seeds/maps/vale-region.map.json`: add `"art": "stone_gate"` to one portal link. `make seed-map SPEC=vale-region` (respect seed order). Re-join: that one portal shows `stone_gate`, every other portal still shows `portal`. Remove the field, re-seed, re-join: back to `portal`. Revert the spec file (`git checkout -- backend/seeds/maps/vale-region.map.json` inside the worktree only).

- [ ] **Step 6: Record**

Append to this plan:

```markdown
## Verified (date)
- backend `npm test` EXIT=0 (scratch DB: <name>), frontend `npx vitest run` EXIT=0
- screenshots: <scratchpad paths> (portal art in depth sort; unlit/lit waypoint; opened chest; spec-bound stone_gate)
- pixel sample at portal tile: <rgb>, not #f472b6
```

Commit the plan footer, then propose (via `project-memory-curator`) one memory note: the kind catalog / `art` name-on-the-wire / `skipBody` split, and any trap hit during verification.

---

## Self-review

**Spec coverage.** D1 columns + spec grammar → Tasks 1, 4, 5. D2 catalog, `point_kind`, editor hiding, resolution order, single loader per kind → Tasks 1, 2, 3, 6. D3 body-only replacement, overlays kept, state treatment, `stateKey` seam, placeholder fallback, shared-tile rule → Tasks 7, 8. D4 editor + spec authoring, placeholder rows, no starter art → Tasks 1, 3, 4. Acceptance 1–6 → Task 3 Step 7, Task 9 Steps 3–5, Task 4 tests. Deferred items are listed in the spec and not planned.

**Placeholder scan.** Ticket numbers are real (epic SOMET-576, tasks SOMET-577..585). No TBD/TODO steps remain.

**Type consistency.** `resolvePointArt(kind, instanceArt, defaults)` (Task 5) is what Task 6 calls with `entry.pointArtDefaults`; `buildLandmarks`'s new option is `artDefaults` in both Task 6 code and tests; the wire field is `art` everywhere (landmarks, village posts, chests); client helpers are `pointArtDef / pointBodyRef / pointStateTreatment / planLandmarkBodies` in Tasks 7 and 8; `drawLandmarks` option is `skipBody` in both Task 8 code and test; `stateKey` rides on the entity ref in Task 7's `resolveSprite` and Task 8's `pointBodyRef` call.

## Known risks / unresolved

- `Object.create(RenderSystem.prototype)` in Task 8's test may need more stubbed instance fields than listed; adjust the harness, not the assertions.
- `landmarks_joined_live.test.js` runs on whatever DB the env points at — scratch only.
- A portal link's `art` applies to both rows of the pair; per-side art is a follow-up (`to_art`).
- Field chests can only take the kind default (never authored) — by design.
- Display sizes in `POINT_TYPES` are guesses; the editor is where they get tuned once art exists.

## Verified 2026-09-12

Live verification (Task 9, SOMET-585) against the isolated stack (backend :13201, vite :15273, branch DB `s2_wpa`), real Chrome (headless, DevTools MCP), and real uploaded PNGs approved through the entity-type image route. Full detail, every command and workaround: `.claude/worktrees/world-point-art/.superpowers/sdd/2026-09-12-world-point-art/task-9-report.md`.

**Suites (check 0 — held).** Backend `npm test`: EXIT=1, 24 `not ok`, all classified as pre-existing baseline noise, none touching this feature: 3× `ECONNREFUSED 127.0.0.1:5432` (`inventory_capacity_db.test.js`, unrelated DB), 1× `SEED_ROWS` catalog drift (`authority_items_catalog.test.js`, unrelated item rows), 1× bind-count mismatch (`item_types_reserved_and_reprice.test.js`), and 19× `column "point_kind" does not exist` — every one of them a `*_db.test.js` file whose pool falls back to the shared, un-migrated `game_db` rather than the scratch DB. Frontend `npx vitest run`: EXIT=1, 1 failed test (`SkillTreeAdmin.smoke.test.js`), the documented pre-existing red. No new failures.

**Stack + catalog (check 1 — held).** `GET /api/world-point-kinds` returned exactly the 8 kinds (portal, waypoint, merchant, bank, gem_merchant, skill_merchant, chest_vault, chest_field), each with its seeded default entity type.

**Baseline before art (check 2 — held).** Joined Vale Crossing as a fresh throwaway player (`t9wpaplayer` / character `T9Hero`). `t9-merchant-before.png` — purple diamond + "Merchant" caption at the village post, `[e] Trade` prompt when adjacent. Hooked the WebSocket client-side to read the raw `joined` frame: `merchants[0].art === "merchant_post"` and `chests[0].art === "chest_vault"` (state `locked`) — the `art` name ships on the wire even before any image exists, confirmed by direct inspection, not inference.

**Art given (check 3 — held).** Uploaded 5 distinct RGBA PNGs to MinIO under `wpa/` (portal magenta, merchant_post teal, waypoint_stone gold, chest_vault blue, stone_gate green) and approved each via `POST /api/entity-types/:id/image`. `render_mode` flipped `rect` → `static` on every one; `GET /api/assets/wpa/*.png` → 200 for all.

**Merchant after art (check 4 — held).** `t9-merchant-after.png` — teal rounded-arch PNG at the post, "Merchant" caption, `[e] Trade`, purple diamond gone. Canvas `getImageData` pixel sample at (624,312): exact `rgb(0,200,120)` (the PNG's fill), and a full-canvas scan found zero pixels matching the old placeholder `#c084fc`.

**Portal (check 5 — held for the core claim; occlusion sub-test not cleanly captured).** Reached Blackfen Sinks by editing `world_players` for the throwaway character only (fast travel needs a lit portal/prior visit a fresh character doesn't have — see report for the full join-policy trace). `t9-portal-zoom.png` / `t9-portal.png` — magenta rounded-arch PNG at the portal tile, 🌀 "To Catacomb Threshold" pill, no pink diamond anywhere on screen. Pixel samples: exact `rgb(255,0,200)` on two independent live sessions (canvas (687,220) and (719,204)); zero `#f472b6` pixels found. **Did not hold as originally scoped:** the stand-one-tile-behind / one-tile-in-front depth-sort comparison was not reliably reproduced — Blackfen Sinks seeds hostile guards immediately adjacent to the portal (map author's `guard` block on that link), and repeated combat/knockback near it made controlled positioning non-deterministic (observed: instant, 10s, 45s, 55s and 70s before the fight moved the character; one full-HP-buffered attempt still lost 1050→30 HP to a chest guard elsewhere, confirming the damage is real, not a UI glitch). This is a testing-environment limitation (a populated, hostile branch-DB world), not a defect in Task 8's depth-sort code, which has its own unit coverage. The art-rendering claim itself (check 5's actual subject) is solid on two independent pixel-verified captures.

**Waypoint (check 6 — held).** `waypoint_stone` given gold art. `t9-waypoint-unlit.png` (Thornbriar Reach, character on an adjacent tile, waypoint not yet activated): pixel sample inside the arch (181,177,72) — a blended/dimmed tone, not the pure fill, consistent with the ~45% alpha treatment (no `character_waypoints` row existed at capture time — confirmed via DB). `t9-waypoint-lit.png` (character on the waypoint's own tile, which auto-activated it): pixel sample exact `rgb(255,200,0)`, full opacity, `character_waypoints` row present with an `activated_at` timestamp. Blue ground ring was not independently isolated from the ground texture at this zoom; the alpha contrast between the two states is the primary evidence and it is unambiguous.

**Chest (check 7 — held).** `chest_vault` given blue art. The one vault chest in `s2_wpa` sits inside the entry world itself (Vale Crossing, `world_chests.id=f1f1cc61…`), guarded. `t9-chest-locked.png`: blue rounded-arch PNG, "Treasure (guarded)" caption, `[f] open` prompt; pixel sample exact `rgb(40,90,255)`. Set `state='opened'` directly on that row, rejoined: `t9-chest-opened.png` — "Looted" caption, pixel sample (72,81,102), a blended/dimmed tone versus the locked exact color. Reverted `state` back to `'locked'` immediately after (confirmed via `SELECT`).

**Spec round-trip (check 8 — held, full cycle).** Created `stone_gate` (`point_kind: 'portal'`, green PNG) via `POST /api/entity-types` + image approve. Added `"art": "stone_gate"` to the Blackfen Sinks portal link in `backend/seeds/maps/vale-region.map.json`, ran `seed-map.js` for `p5-descent` then `vale-region` against `s2_wpa`, restarted the branch backend. `map_links` confirmed `entity_type_id` → `stone_gate` on **both** rows of the pair (Blackfen→Catacomb and Catacomb→Blackfen — matches the plan's documented "applies to both rows of the pair, per-side art is a follow-up" note, not a defect). Wire probe: `landmarks[0].art === "stone_gate"`. `t9-spec-bound.png`: green arch at the portal, pixel exact `rgb(40,220,40)`. Removed the `art` field, re-ran `seed-map.js` for `vale-region`, restarted, re-verified: `map_links.entity_type_id` back to `NULL` on both rows, wire probe `art === "portal"`, `t9-spec-reverted.png` shows magenta again. `git checkout -- backend/seeds/maps/vale-region.map.json` (the only permitted checkout) — `git status --short` on that path is clean.

**Make-default carry-over (check 9 — held).** In `/game/entities` (admin), edited `stone_gate`: button read "Make default for portal (currently: portal)", enabled. Clicked it — `t9-make-default.png` shows the now-disabled "Default for portal" state; `GET /api/world-point-kinds` confirmed `portal.default_name === "stone_gate"`. Edited `portal`, clicked "Make default for portal (currently: stone_gate)" to revert — confirmed `default_name` back to `"portal"` (`default_entity_type_id: 327`).

**Negative: validateMapSpec (check 10 — held).** `node -e "...l.art='pine_tree'; console.log(validateMapSpec(...))"` against a `pointArtTypes` map missing `pine_tree` from kind `portal` produced exactly one error: `portal link vale_mire->cata_entry art "pine_tree" is not an entity type of point kind "portal"` — names the link and the kind, matches the ticket's acceptance line.

**Teardown (check 11 — held).** Killed the three isolated-stack listeners by port owner, removed `frontend/vite.verify.config.mjs` and a temporary `backend/probe-join.tmp.js`, reverted the chest state and the make-default change (both confirmed above), left the `wpa/*` MinIO objects, the `s2_wpa` catalog rows (portal/merchant_post/waypoint_stone/chest_vault/stone_gate images and `point_kind`/default assignments) and the extra `stone_gate` entity type in place — branch-DB-only, per instructions. `git status --short` in the worktree shows no unintended changes.

Screenshots and the admin token live in the scratchpad only; none are committed.
