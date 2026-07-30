# Map-Link Graph Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new admin tab that draws the world graph as nodes and compass-edge links, and lets an admin create, retarget and remove links on it.

**Architecture:** Links stay the source of truth; node positions are cosmetic and live in two new nullable `worlds` columns written by a dedicated endpoint that cannot reach the terrain-invalidating world PUT. Cytoscape renders a `preset` layout from those positions; every decision worth testing (compass inference, layout seeding, mirror collapsing, lint warnings, the overwrite set, the biome ring SVG) lives in pure helpers, because vitest here runs in a **node** environment with no DOM.

**Tech Stack:** Node 20 CommonJS backend (Express, `pg`, `node-pg-migrate`), `node:test` + `supertest`; React **19.2.5** frontend (Vite 8, TanStack Query, styled-components), `vitest` 3 in a node environment; `cytoscape@3.34.0`, `react-cytoscapejs@2.0.0`, `cytoscape-edgehandles@4.0.1`.

**Spec:** `docs/superpowers/specs/2026-07-30-map-link-graph-tab-design.md` (committed on main as `d28e9de`).

## Global Constraints

- **`frontend/src/games/something2/MapsAdmin.jsx` MUST NOT be modified.** That is an explicit user constraint. Its hooks file `useMapsAdmin.js` MAY be extended (see Task 6) — the ban is on the component.
- **A node drag must never invalidate terrain.** `PUT /api/worlds/:id` deletes `world_chunks`, clears the preview/overview caches and evicts or warns live players. Position saves go through their own route which issues one `UPDATE` and nothing else. Task 1 pins this with a test asserting no `DELETE FROM world_chunks` occurs.
- **Links are bidirectional and edge-unique.** `setLink` writes `(from, edge, to)` AND `(to, oppositeEdge(edge), from)`; `map_links` is unique on `(from_world_id, edge)` with `CHECK edge IN ('N','E','S','W')`.
- **Creating a link silently destroys conflicting ones.** `setLink` upserts, so it overwrites `(from, edge)` and `(to, opposite)` without warning — and leaves the *displaced* links' mirrors dangling. Task 8 must clear conflicts explicitly rather than letting the upsert do it. See Task 8 for the full reasoning.
- **Only bounded worlds can be linked** (`POST /api/worlds/:id/links` rejects others). 4 of the 17 live worlds are bounded.
- **`vitest` runs `environment: "node"`** (`frontend/vitest.config.js`). There is no DOM, no jsdom, no React Testing Library. Cytoscape cannot be mounted in a test. Component tests are export smoke tests only, matching `MapsAdmin.smoke.test.js`. All real assertions go on pure helpers — the `biomeForm.js` / `liveWarning.js` pattern.
- **Migration timestamp: `1714440044000`.** The highest existing is `1714440043000`. Do not reuse or renumber.
- Backend is CommonJS (`require`/`module.exports`); frontend is ESM. Do not mix.
- **Backend tests:** `cd backend && npm test` (`node --test`), baseline **920 passing**. **Frontend:** `cd frontend && npm test` (`vitest run`), baseline **345 passing**. Both green at every commit.
- Known pre-existing flake: `authority_server.test.js` "a token bucket of capacity 1 admits the join frame" fails roughly 1 run in 7. Re-run before assuming a failure is yours.

---

## File Structure

**Backend — created:** `backend/migrations/1714440044000_world_graph_positions.js`.
**Backend — modified:** `backend/src/index.js` (two new routes).

**Frontend — created:**

| File | Responsibility |
|---|---|
| `mapGraphLayout.js` | pure: `compassFromDelta`, `OPPOSITE`, `seedPositions` |
| `mapGraphLint.js` | pure: `collapseLinks`, `lintGraph`, `linksReplacedBy` |
| `biomeRingSvg.js` | pure: biome ring as an SVG data URI |
| `useMapGraph.js` | `useWorldGraph()`, `useSaveGraphPosition()` |
| `MapGraphAdmin.jsx` | the tab: Cytoscape canvas, unbounded tray, editing UI |

**Frontend — modified:** `Something2.jsx` (tab), `useMapsAdmin.js` (invalidate the new query key).

---

### Task 1: Position columns + save endpoint

**Files:**
- Create: `backend/migrations/1714440044000_world_graph_positions.js`
- Modify: `backend/src/index.js` (add the route immediately after `PUT /api/worlds/:id`)
- Create: `backend/tests/worldGraphPosition.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `worlds.graph_x` / `worlds.graph_y` (`double precision`, nullable); `PUT /api/worlds/:id/graph-position` accepting `{ x, y }` and returning `{ id, graph_x, graph_y }`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/worldGraphPosition.test.js`:

```js
// helpers/auth.js MUST be required before ../src/index.js — it sets JWT_SECRET
// before the guards read it.
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { authHeaders, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

const ADMIN = authHeaders();

function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      calls.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const OK = [/UPDATE worlds SET graph_x/i, (p) => ({ rows: [{ id: 'w1', graph_x: p[0], graph_y: p[1] }] })];

test('saves a position and echoes it back', async () => {
  const pool = mockPool([OK]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1/graph-position').set(ADMIN).send({ x: 120.5, y: -40 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: 'w1', graph_x: 120.5, graph_y: -40 });
  assert.deepEqual(pool.calls[0].params, [120.5, -40, 'w1']);
});

// THE point of this route existing separately. PUT /api/worlds/:id deletes
// world_chunks and clears caches when bounds or biomes change; dragging a node
// on a diagram must never be able to reach that path.
test('a position save NEVER invalidates terrain or caches', async () => {
  const pool = mockPool([OK]);
  __setPool(pool);
  await request(app).put('/api/worlds/w1/graph-position').set(ADMIN).send({ x: 1, y: 2 });
  for (const c of pool.calls) {
    assert.ok(!/DELETE FROM world_chunks/i.test(c.sql), `must not wipe chunks: ${c.sql}`);
    assert.ok(!/DELETE FROM world_creatures/i.test(c.sql), `must not touch creatures: ${c.sql}`);
  }
  assert.equal(pool.calls.length, 1, 'exactly one UPDATE, nothing else');
});

test('rejects non-finite coordinates rather than coercing them', async () => {
  for (const body of [{ x: 'left', y: 0 }, { x: 0 }, {}, { x: null, y: 3 }]) {
    __setPool(mockPool([OK]));
    const res = await request(app).put('/api/worlds/w1/graph-position').set(ADMIN).send(body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

test('404s for an unknown world', async () => {
  __setPool(mockPool([[/UPDATE worlds SET graph_x/i, () => ({ rows: [] })]]));
  const res = await request(app).put('/api/worlds/nope/graph-position').set(ADMIN).send({ x: 0, y: 0 });
  assert.equal(res.status, 404);
});

test('requires admin', async () => {
  __setPool(mockPool([OK]));
  const res = await request(app).put('/api/worlds/w1/graph-position').send({ x: 0, y: 0 });
  assert.ok(res.status === 401 || res.status === 403, `expected auth failure, got ${res.status}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test tests/worldGraphPosition.test.js`
Expected: FAIL — the route 404s (no such endpoint).

- [ ] **Step 3: Write the migration**

Create `backend/migrations/1714440044000_world_graph_positions.js`:

```js
exports.shorthands = undefined;

// Canvas coordinates for the World Map admin tab. Purely cosmetic: nothing in
// world generation, collision or the authority reads these. Nullable with no
// default, so every existing world starts unpositioned and the client seeds a
// layout for it — opening the tab never writes to the database.
exports.up = (pgm) => {
  pgm.addColumns('worlds', {
    graph_x: { type: 'double precision', notNull: false },
    graph_y: { type: 'double precision', notNull: false },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('worlds', ['graph_x', 'graph_y']);
};
```

- [ ] **Step 4: Write the route**

In `backend/src/index.js`, immediately after the `PUT /api/worlds/:id` handler ends:

```js
// Node position for the World Map tab. Deliberately its OWN route rather than
// a field on PUT /api/worlds/:id: that route deletes world_chunks, clears the
// preview/overview caches and evicts or warns connected players when bounds or
// biomes change. A cosmetic node drag must not be able to reach any of that, so
// this issues one UPDATE of two columns and nothing else.
app.put('/api/worlds/:id/graph-position', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const { x, y } = req.body;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return res.status(400).json({ error: 'x and y must be finite numbers' });
    }
    const result = await pool.query(
      `UPDATE worlds SET graph_x = $1, graph_y = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 RETURNING id, graph_x, graph_y`,
      [x, y, id],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'world not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save graph position' });
  }
});
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && node --test tests/worldGraphPosition.test.js`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && npm test`
Expected: 925 passing (920 baseline + 5).

- [ ] **Step 7: Commit**

```bash
git add backend/migrations/1714440044000_world_graph_positions.js backend/src/index.js backend/tests/worldGraphPosition.test.js
git commit -m "feat(map-graph): node position columns + a save route that cannot invalidate terrain"
```

---

### Task 2: World-graph read endpoint

**Files:**
- Modify: `backend/src/index.js` (add after the route from Task 1)
- Create: `backend/tests/worldGraphRoute.test.js`

**Interfaces:**
- Consumes: `worlds.graph_x`/`graph_y` from Task 1.
- Produces: `GET /api/world-graph` → `{ worlds: [{ id, name, width, height, is_entry, biomes, graph_x, graph_y }], links: [{ from_world_id, edge, to_world_id }] }`. Public, like `/api/worlds` and `/api/worlds/:id/links`, which it composes.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/worldGraphRoute.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      calls.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const WORLDS = [
  { id: 'a', name: 'Arena', width: 30, height: 30, is_entry: true, biomes: ['Meadow'], graph_x: 0, graph_y: 0 },
  { id: 'b', name: 'test2', width: 24, height: 24, is_entry: false, biomes: [], graph_x: null, graph_y: null },
  { id: 'u', name: 'unbounded', width: null, height: null, is_entry: false, biomes: [], graph_x: null, graph_y: null },
];
// Both directions of one logical link.
const LINKS = [
  { from_world_id: 'a', edge: 'E', to_world_id: 'b' },
  { from_world_id: 'b', edge: 'W', to_world_id: 'a' },
];

function poolFor(links = LINKS) {
  return mockPool([
    [/FROM worlds/i, () => ({ rows: WORLDS })],
    [/FROM map_links/i, () => ({ rows: links })],
  ]);
}

test('returns worlds and links in one snapshot', async () => {
  __setPool(poolFor());
  const res = await request(app).get('/api/world-graph');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.worlds, WORLDS);
  assert.deepEqual(res.body.links, LINKS);
});

// The client collapses mirrored pairs itself, because detecting a MISSING
// mirror is a lint check — impossible if the server has already collapsed
// them and thrown the evidence away.
test('returns BOTH directions, uncollapsed', async () => {
  __setPool(poolFor());
  const res = await request(app).get('/api/world-graph');
  assert.equal(res.body.links.length, 2);
  assert.ok(res.body.links.some((l) => l.from_world_id === 'a' && l.edge === 'E'));
  assert.ok(res.body.links.some((l) => l.from_world_id === 'b' && l.edge === 'W'));
});

test('a one-way (unmirrored) row survives to the client', async () => {
  __setPool(poolFor([{ from_world_id: 'a', edge: 'N', to_world_id: 'b' }]));
  const res = await request(app).get('/api/world-graph');
  assert.deepEqual(res.body.links, [{ from_world_id: 'a', edge: 'N', to_world_id: 'b' }]);
});

test('carries the position columns, including nulls', async () => {
  __setPool(poolFor());
  const res = await request(app).get('/api/world-graph');
  const b = res.body.worlds.find((w) => w.id === 'b');
  assert.equal(b.graph_x, null);
  assert.equal(b.graph_y, null);
});

test('includes unbounded worlds — the client decides they are untinkable', async () => {
  __setPool(poolFor());
  const res = await request(app).get('/api/world-graph');
  assert.ok(res.body.worlds.some((w) => w.id === 'u' && w.width === null));
});

test('is two queries, not one per world', async () => {
  const pool = poolFor();
  __setPool(pool);
  await request(app).get('/api/world-graph');
  assert.equal(pool.calls.length, 2);
});

test('both queries are deterministically ordered', async () => {
  const pool = poolFor();
  __setPool(pool);
  await request(app).get('/api/world-graph');
  for (const c of pool.calls) assert.match(c.sql, /ORDER BY/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test tests/worldGraphRoute.test.js`
Expected: FAIL — 404, no such route.

- [ ] **Step 3: Write the route**

In `backend/src/index.js`, after the graph-position route:

```js
// One snapshot for the World Map tab. Composes GET /api/worlds and the
// per-world GET /api/worlds/:id/links (both already public) into a single
// request — 17 worlds would otherwise be 1 + N round trips — and a single
// snapshot avoids a torn read where a world is deleted between calls.
//
// `links` deliberately returns BOTH directions of every link, uncollapsed.
// setLink writes a row and its mirror, so the client can pair them itself;
// serving pre-collapsed pairs would destroy the evidence its missing-mirror
// lint check depends on. Both queries are ORDER BY'd so the payload is stable
// between requests.
app.get('/api/world-graph', async (req, res) => {
  try {
    const [worldsRes, linksRes] = await Promise.all([
      pool.query(
        `SELECT id, name, width, height, is_entry, biomes, graph_x, graph_y
           FROM worlds ORDER BY created_at DESC`),
      pool.query(
        `SELECT from_world_id, edge, to_world_id
           FROM map_links ORDER BY from_world_id, edge`),
    ]);
    res.json({ worlds: worldsRes.rows, links: linksRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load world graph' });
  }
});
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && node --test tests/worldGraphRoute.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && npm test`
Expected: 932 passing.

- [ ] **Step 6: Commit**

```bash
git add backend/src/index.js backend/tests/worldGraphRoute.test.js
git commit -m "feat(map-graph): GET /api/world-graph single-snapshot read"
```

---

### Task 3: Layout helpers (pure)

**Files:**
- Create: `frontend/src/games/something2/mapGraphLayout.js`
- Create: `frontend/src/games/something2/__tests__/mapGraphLayout.test.js`

**Interfaces:**
- Consumes: the `GET /api/world-graph` payload shape from Task 2.
- Produces:
  - `OPPOSITE` — `{ N:'S', S:'N', E:'W', W:'E' }`
  - `compassFromDelta(dx, dy) -> 'N'|'E'|'S'|'W'`
  - `seedPositions(worlds, links, { cell }) -> { [worldId]: { x, y } }`, covering **every** world passed in.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/__tests__/mapGraphLayout.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { OPPOSITE, compassFromDelta, seedPositions } from '../mapGraphLayout.js';

describe('compassFromDelta', () => {
  // Screen y grows DOWNWARD, so a node below the source is South.
  it('maps the dominant axis to a compass edge', () => {
    expect(compassFromDelta(100, 10)).toBe('E');
    expect(compassFromDelta(-100, 10)).toBe('W');
    expect(compassFromDelta(10, 100)).toBe('S');
    expect(compassFromDelta(10, -100)).toBe('N');
  });

  it('resolves a perfect diagonal tie to the horizontal axis', () => {
    expect(compassFromDelta(50, 50)).toBe('E');
    expect(compassFromDelta(-50, 50)).toBe('W');
    expect(compassFromDelta(-50, -50)).toBe('W');
  });

  it('treats a zero delta as East rather than crashing', () => {
    expect(compassFromDelta(0, 0)).toBe('E');
  });

  it('is consistent with OPPOSITE', () => {
    expect(OPPOSITE[compassFromDelta(100, 0)]).toBe('W');
    expect(OPPOSITE[compassFromDelta(0, 100)]).toBe('N');
  });
});

const W = (id, extra = {}) => ({ id, name: id, width: 24, height: 24, is_entry: false, biomes: [], graph_x: null, graph_y: null, ...extra });

describe('seedPositions', () => {
  it('preserves stored positions untouched', () => {
    const worlds = [W('a', { graph_x: 17, graph_y: -3 })];
    expect(seedPositions(worlds, [])).toEqual({ a: { x: 17, y: -3 } });
  });

  it('walks links from the entry world, one cell per compass edge', () => {
    const worlds = [W('a', { is_entry: true }), W('b'), W('c')];
    const links = [
      { from_world_id: 'a', edge: 'E', to_world_id: 'b' },
      { from_world_id: 'b', edge: 'S', to_world_id: 'c' },
    ];
    const pos = seedPositions(worlds, links, { cell: 100 });
    expect(pos.a).toEqual({ x: 0, y: 0 });
    expect(pos.b).toEqual({ x: 100, y: 0 });   // East = +x
    expect(pos.c).toEqual({ x: 100, y: 100 }); // South = +y (screen down)
  });

  it('gives every world a position, including unlinked ones', () => {
    const worlds = [W('a', { is_entry: true }), W('lonely')];
    const pos = seedPositions(worlds, [], { cell: 100 });
    expect(Object.keys(pos).sort()).toEqual(['a', 'lonely']);
    expect(Number.isFinite(pos.lonely.x)).toBe(true);
    expect(Number.isFinite(pos.lonely.y)).toBe(true);
  });

  it('never stacks two worlds on the same point', () => {
    // The live topology: every edge of a points at b and vice versa. Only the
    // first edge can be honoured; the rest would collide.
    const worlds = [W('a', { is_entry: true }), W('b')];
    const links = ['N', 'E', 'S', 'W'].map((edge) => ({ from_world_id: 'a', edge, to_world_id: 'b' }));
    const pos = seedPositions(worlds, links, { cell: 100 });
    expect(`${pos.a.x},${pos.a.y}`).not.toBe(`${pos.b.x},${pos.b.y}`);
  });

  it('is deterministic for the same input', () => {
    const worlds = [W('a', { is_entry: true }), W('b'), W('c')];
    const links = [{ from_world_id: 'a', edge: 'E', to_world_id: 'b' }];
    expect(seedPositions(worlds, links)).toEqual(seedPositions(worlds, links));
  });

  it('ignores links that name a world not in the list', () => {
    const worlds = [W('a', { is_entry: true })];
    const links = [{ from_world_id: 'a', edge: 'E', to_world_id: 'ghost' }];
    const pos = seedPositions(worlds, links, { cell: 100 });
    expect(pos).toEqual({ a: { x: 0, y: 0 } });
  });

  it('handles no entry world by starting from the first unpositioned one', () => {
    const worlds = [W('a'), W('b')];
    const links = [{ from_world_id: 'a', edge: 'E', to_world_id: 'b' }];
    const pos = seedPositions(worlds, links, { cell: 100 });
    expect(pos.a).toEqual({ x: 0, y: 0 });
    expect(pos.b).toEqual({ x: 100, y: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/mapGraphLayout.test.js`
Expected: FAIL — cannot resolve `../mapGraphLayout.js`.

- [ ] **Step 3: Write the helpers**

Create `frontend/src/games/something2/mapGraphLayout.js`:

```js
// Pure layout maths for the World Map tab. Kept out of the component because
// vitest here runs with environment: "node" — Cytoscape cannot be mounted in a
// test, so anything worth asserting has to live in a plain function.
// (Same reasoning as biomeForm.js and liveWarning.js.)

export const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };

// Grid step per compass edge, in SCREEN convention: y grows downward, so South
// is +y. Getting this backwards silently mirrors the whole diagram.
const STEP = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };

// The compass edge implied by dragging from one node to another. Dominant axis
// wins; a perfect diagonal resolves horizontally (arbitrary but fixed, so the
// inference is never ambiguous to the user).
export function compassFromDelta(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'E' : 'W';
  return dy >= 0 ? 'S' : 'N';
}

// A position for EVERY world passed in. Worlds with stored coordinates keep
// them; the rest are seeded by walking links breadth-first from the entry
// world, one grid cell per compass edge. A cell that is already occupied is
// skipped rather than overwritten — the live topology is spatially
// contradictory (every edge of one world pointing at the same neighbour), so
// collisions are normal, not exceptional. Whatever the walk cannot place drops
// into a row beneath it.
//
// Callers must NOT persist these. They are a display fallback; graph_x/graph_y
// stay null until an admin actually drags something.
export function seedPositions(worlds, links, { cell = 220 } = {}) {
  const list = Array.isArray(worlds) ? worlds : [];
  const out = {};
  const stored = new Set();
  for (const w of list) {
    if (Number.isFinite(w.graph_x) && Number.isFinite(w.graph_y)) {
      out[w.id] = { x: w.graph_x, y: w.graph_y };
      stored.add(w.id);
    }
  }

  const known = new Set(list.map((w) => w.id));
  const adjacency = new Map();
  for (const l of Array.isArray(links) ? links : []) {
    if (!known.has(l.from_world_id) || !known.has(l.to_world_id)) continue;
    if (!STEP[l.edge]) continue;
    if (!adjacency.has(l.from_world_id)) adjacency.set(l.from_world_id, []);
    adjacency.get(l.from_world_id).push(l);
  }

  const cellOf = new Map();
  const taken = new Set();
  const start = list.find((w) => w.is_entry && !stored.has(w.id))
    || list.find((w) => !stored.has(w.id));
  const queue = [];
  if (start) {
    cellOf.set(start.id, [0, 0]);
    taken.add('0,0');
    queue.push(start.id);
  }
  while (queue.length > 0) {
    const id = queue.shift();
    const [col, row] = cellOf.get(id);
    for (const l of adjacency.get(id) || []) {
      const target = l.to_world_id;
      if (cellOf.has(target) || stored.has(target)) continue;
      const [dc, dr] = STEP[l.edge];
      const key = `${col + dc},${row + dr}`;
      if (taken.has(key)) continue;
      cellOf.set(target, [col + dc, row + dr]);
      taken.add(key);
      queue.push(target);
    }
  }
  for (const [id, [col, row]] of cellOf) out[id] = { x: col * cell, y: row * cell };

  let maxRow = 0;
  for (const [, [, row]] of cellOf) maxRow = Math.max(maxRow, row);
  let spare = 0;
  for (const w of list) {
    if (out[w.id]) continue;
    out[w.id] = { x: spare * cell, y: (maxRow + 2) * cell };
    spare += 1;
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/mapGraphLayout.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Run the full frontend suite**

Run: `cd frontend && npm test`
Expected: 356 passing (345 baseline + 11).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/mapGraphLayout.js frontend/src/games/something2/__tests__/mapGraphLayout.test.js
git commit -m "feat(map-graph): pure layout helpers (compass inference, position seeding)"
```

---

### Task 4: Lint + overwrite helpers (pure)

**Files:**
- Create: `frontend/src/games/something2/mapGraphLint.js`
- Create: `frontend/src/games/something2/__tests__/mapGraphLint.test.js`

**Interfaces:**
- Consumes: `OPPOSITE` and `compassFromDelta` from `mapGraphLayout.js` (Task 3).
- Produces:
  - `collapseLinks(links) -> [{ fromId, edge, toId, toEdge, mirrored }]`
  - `lintGraph({ worlds, links, positions }) -> [{ code, message, worldIds }]`, codes `'direction-mismatch' | 'duplicate-direction' | 'missing-mirror' | 'unpositioned'`
  - `linksReplacedBy({ links, fromId, edge, toId }) -> [{ from_world_id, edge, to_world_id }]`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/__tests__/mapGraphLint.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { collapseLinks, lintGraph, linksReplacedBy } from '../mapGraphLint.js';

const L = (from, edge, to) => ({ from_world_id: from, edge, to_world_id: to });
const W = (id, extra = {}) => ({ id, name: id, graph_x: 0, graph_y: 0, ...extra });

describe('collapseLinks', () => {
  it('folds a mirrored pair into one line', () => {
    const out = collapseLinks([L('a', 'E', 'b'), L('b', 'W', 'a')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ fromId: 'a', edge: 'E', toId: 'b', toEdge: 'W', mirrored: true });
  });

  it('keeps an unmirrored row and flags it', () => {
    const out = collapseLinks([L('a', 'N', 'b')]);
    expect(out).toHaveLength(1);
    expect(out[0].mirrored).toBe(false);
  });

  it('does not fold a pair that only looks mirrored', () => {
    // b's W points at c, not back at a — not a mirror.
    const out = collapseLinks([L('a', 'E', 'b'), L('b', 'W', 'c')]);
    expect(out).toHaveLength(2);
    expect(out.every((l) => l.mirrored === false)).toBe(true);
  });

  it('handles the live 4-way topology as four separate lines', () => {
    const links = ['N', 'E', 'S', 'W'].flatMap((e) => [L('a', e, 'b'), L('b', { N: 'S', S: 'N', E: 'W', W: 'E' }[e], 'a')]);
    expect(collapseLinks(links)).toHaveLength(4);
  });
});

describe('lintGraph', () => {
  const positions = { a: { x: 0, y: 0 }, b: { x: 200, y: 0 } };

  it('is silent on a consistent graph', () => {
    const out = lintGraph({ worlds: [W('a'), W('b')], links: [L('a', 'E', 'b'), L('b', 'W', 'a')], positions });
    expect(out).toEqual([]);
  });

  it('flags a link drawn against its compass edge', () => {
    // a.W points at b, but b is drawn to the RIGHT of a.
    const out = lintGraph({ worlds: [W('a'), W('b')], links: [L('a', 'W', 'b'), L('b', 'E', 'a')], positions });
    expect(out.map((w) => w.code)).toContain('direction-mismatch');
  });

  it('flags two links leaving one world in the same drawn direction', () => {
    const pos = { a: { x: 0, y: 0 }, b: { x: 200, y: 0 }, c: { x: 300, y: 0 } };
    const links = [L('a', 'E', 'b'), L('b', 'W', 'a'), L('a', 'N', 'c'), L('c', 'S', 'a')];
    const out = lintGraph({ worlds: [W('a'), W('b'), W('c')], links, positions: pos });
    expect(out.map((w) => w.code)).toContain('duplicate-direction');
  });

  it('flags a missing mirror', () => {
    const out = lintGraph({ worlds: [W('a'), W('b')], links: [L('a', 'E', 'b')], positions });
    expect(out.map((w) => w.code)).toContain('missing-mirror');
  });

  it('flags an unpositioned world', () => {
    const out = lintGraph({ worlds: [W('a', { graph_x: null, graph_y: null })], links: [], positions: { a: { x: 0, y: 0 } } });
    expect(out.map((w) => w.code)).toContain('unpositioned');
  });

  it('names the worlds involved so the UI can highlight them', () => {
    const out = lintGraph({ worlds: [W('a'), W('b')], links: [L('a', 'W', 'b'), L('b', 'E', 'a')], positions });
    const mismatch = out.find((w) => w.code === 'direction-mismatch');
    expect(mismatch.worldIds).toEqual(expect.arrayContaining(['a', 'b']));
    expect(typeof mismatch.message).toBe('string');
    expect(mismatch.message.length).toBeGreaterThan(0);
  });
});

describe('linksReplacedBy', () => {
  it('finds nothing when both compass slots are free', () => {
    expect(linksReplacedBy({ links: [], fromId: 'a', edge: 'E', toId: 'b' })).toEqual([]);
  });

  it("reports the source's occupied slot", () => {
    const links = [L('a', 'E', 'c'), L('c', 'W', 'a')];
    const out = linksReplacedBy({ links, fromId: 'a', edge: 'E', toId: 'b' });
    expect(out).toContainEqual(L('a', 'E', 'c'));
  });

  it("reports the TARGET's opposing slot too", () => {
    // Linking a.E -> b also writes b.W, clobbering b's existing W link to d.
    const links = [L('b', 'W', 'd'), L('d', 'E', 'b')];
    const out = linksReplacedBy({ links, fromId: 'a', edge: 'E', toId: 'b' });
    expect(out).toContainEqual(L('b', 'W', 'd'));
  });

  it('reports nothing when the identical link already exists', () => {
    const links = [L('a', 'E', 'b'), L('b', 'W', 'a')];
    expect(linksReplacedBy({ links, fromId: 'a', edge: 'E', toId: 'b' })).toEqual([]);
  });

  it('does not report the same row twice', () => {
    const links = [L('a', 'E', 'c'), L('c', 'W', 'a')];
    const out = linksReplacedBy({ links, fromId: 'a', edge: 'E', toId: 'b' });
    const keys = out.map((l) => `${l.from_world_id}|${l.edge}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/mapGraphLint.test.js`
Expected: FAIL — cannot resolve `../mapGraphLint.js`.

- [ ] **Step 3: Write the helpers**

Create `frontend/src/games/something2/mapGraphLint.js`:

```js
// Consistency checks for the World Map tab, plus the "what would this link
// destroy" calculation the confirm dialog depends on. All pure — vitest runs
// without a DOM here, so this is the layer that can actually be tested.
import { OPPOSITE, compassFromDelta } from './mapGraphLayout.js';

const key = (fromId, edge) => `${fromId}|${edge}`;

// setLink() writes a row AND its mirror, so the wire carries two rows per
// logical link. Fold them into one line each, and record whether the mirror
// was actually there — a row without one means one-way travel, which the API
// never creates but the schema permits.
export function collapseLinks(links) {
  const rows = Array.isArray(links) ? links : [];
  const byKey = new Map(rows.map((l) => [key(l.from_world_id, l.edge), l]));
  const done = new Set();
  const out = [];
  for (const l of rows) {
    const k = key(l.from_world_id, l.edge);
    if (done.has(k)) continue;
    const mirrorKey = key(l.to_world_id, OPPOSITE[l.edge]);
    const mirror = byKey.get(mirrorKey);
    const mirrored = Boolean(mirror && mirror.to_world_id === l.from_world_id);
    done.add(k);
    if (mirrored) done.add(mirrorKey);
    out.push({
      fromId: l.from_world_id,
      edge: l.edge,
      toId: l.to_world_id,
      toEdge: OPPOSITE[l.edge],
      mirrored,
    });
  }
  return out;
}

// Warnings, never errors. The live topology is already spatially
// contradictory (one world linked to another on all four edges at once); that
// is legal, reachable from the existing Maps tab, and must stay editable.
export function lintGraph({ worlds, links, positions }) {
  const list = Array.isArray(worlds) ? worlds : [];
  const pos = positions || {};
  const nameOf = new Map(list.map((w) => [w.id, w.name || w.id]));
  const out = [];

  const collapsed = collapseLinks(links);
  const drawnByWorld = new Map();

  for (const link of collapsed) {
    if (!link.mirrored) {
      out.push({
        code: 'missing-mirror',
        message: `${nameOf.get(link.fromId) || link.fromId} links ${link.edge} to `
          + `${nameOf.get(link.toId) || link.toId}, but there is no return link — travel is one-way.`,
        worldIds: [link.fromId, link.toId],
      });
    }
    const a = pos[link.fromId];
    const b = pos[link.toId];
    if (!a || !b) continue;
    const drawn = compassFromDelta(b.x - a.x, b.y - a.y);
    if (drawn !== link.edge) {
      out.push({
        code: 'direction-mismatch',
        message: `${nameOf.get(link.fromId) || link.fromId} links ${link.edge} to `
          + `${nameOf.get(link.toId) || link.toId}, but it is drawn ${drawn}. `
          + `Move a node, or change the link's edge.`,
        worldIds: [link.fromId, link.toId],
      });
    }
    if (!drawnByWorld.has(link.fromId)) drawnByWorld.set(link.fromId, new Map());
    const seen = drawnByWorld.get(link.fromId);
    if (seen.has(drawn)) {
      out.push({
        code: 'duplicate-direction',
        message: `${nameOf.get(link.fromId) || link.fromId} has two links drawn ${drawn}; `
          + `move one of the neighbours apart.`,
        worldIds: [link.fromId, link.toId, seen.get(drawn)],
      });
    } else {
      seen.set(drawn, link.toId);
    }
  }

  for (const w of list) {
    if (!Number.isFinite(w.graph_x) || !Number.isFinite(w.graph_y)) {
      out.push({
        code: 'unpositioned',
        message: `${w.name || w.id} has no saved position — it was placed automatically. `
          + `Drag it to keep this layout.`,
        worldIds: [w.id],
      });
    }
  }
  return out;
}

// Which existing rows creating (fromId, edge, toId) would destroy.
//
// setLink upserts on (from_world_id, edge) TWICE: once for the new link and
// once for its mirror. So it silently displaces whatever occupied the source's
// `edge` slot AND whatever occupied the target's opposite slot — and it leaves
// each displaced link's OWN mirror behind, dangling. The caller is expected to
// clear these explicitly before creating, rather than letting the upsert
// half-do it (see the plan's Task 8).
export function linksReplacedBy({ links, fromId, edge, toId }) {
  const rows = Array.isArray(links) ? links : [];
  const byKey = new Map(rows.map((l) => [key(l.from_world_id, l.edge), l]));
  const out = [];
  const push = (row, wantedTarget) => {
    if (row && row.to_world_id !== wantedTarget) out.push(row);
  };
  push(byKey.get(key(fromId, edge)), toId);
  push(byKey.get(key(toId, OPPOSITE[edge])), fromId);
  const seen = new Set();
  return out.filter((l) => {
    const k = key(l.from_world_id, l.edge);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/mapGraphLint.test.js`
Expected: PASS (15 tests).

- [ ] **Step 5: Run the full frontend suite**

Run: `cd frontend && npm test`
Expected: 371 passing.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/mapGraphLint.js frontend/src/games/something2/__tests__/mapGraphLint.test.js
git commit -m "feat(map-graph): pure lint + overwrite-set helpers"
```

---

### Task 5: Biome ring SVG (pure)

**Files:**
- Create: `frontend/src/games/something2/biomeRingSvg.js`
- Create: `frontend/src/games/something2/__tests__/biomeRingSvg.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `biomeRingSvg(colors, { size, thickness, empty }) -> string` (a `data:image/svg+xml;utf8,...` URI), and `SAFE_COLOR_RE`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/__tests__/biomeRingSvg.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { biomeRingSvg } from '../biomeRingSvg.js';

const decode = (uri) => decodeURIComponent(uri.replace(/^data:image\/svg\+xml;utf8,/, ''));

describe('biomeRingSvg', () => {
  it('returns a data URI', () => {
    expect(biomeRingSvg(['#5aa84f'])).toMatch(/^data:image\/svg\+xml;utf8,/);
  });

  it('draws one arc per biome colour', () => {
    const svg = decode(biomeRingSvg(['#5aa84f', '#c9a227', '#8fb8d6']));
    expect(svg.match(/<circle/g)).toHaveLength(3);
    expect(svg).toContain('#5aa84f');
    expect(svg).toContain('#c9a227');
    expect(svg).toContain('#8fb8d6');
  });

  it('draws a single neutral ring when there are no biomes', () => {
    const svg = decode(biomeRingSvg([]));
    expect(svg.match(/<circle/g)).toHaveLength(1);
    expect(svg).toContain('#555555');
  });

  it('treats null/undefined like an empty list', () => {
    expect(decode(biomeRingSvg(null))).toContain('#555555');
    expect(decode(biomeRingSvg(undefined))).toContain('#555555');
  });

  it('splits the circumference evenly across arcs', () => {
    const svg = decode(biomeRingSvg(['#111111', '#222222', '#333333', '#444444']));
    const dashes = [...svg.matchAll(/stroke-dasharray="([\d.]+) ([\d.]+)"/g)];
    expect(dashes).toHaveLength(4);
    const [seg, gap] = [Number(dashes[0][1]), Number(dashes[0][2])];
    const circumference = seg + gap;
    expect(seg / circumference).toBeCloseTo(0.25, 5);
    for (const d of dashes) expect(Number(d[1])).toBeCloseTo(seg, 5);
  });

  it('offsets each arc so they do not overlap', () => {
    const svg = decode(biomeRingSvg(['#111111', '#222222']));
    const offsets = [...svg.matchAll(/stroke-dashoffset="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
    expect(new Set(offsets).size).toBe(2);
  });

  // biomes.color is admin-editable free text. It lands inside an SVG attribute
  // in a data URI, so anything that isn't a plain hex colour must be dropped
  // rather than interpolated.
  it('rejects a colour that is not a plain hex value', () => {
    const svg = decode(biomeRingSvg(['#5aa84f', '" onload="alert(1)', 'red; }']));
    expect(svg).not.toContain('onload');
    expect(svg).not.toContain('alert');
    expect(svg).toContain('#5aa84f');
  });

  it('substitutes the neutral colour for a rejected entry, keeping arc count', () => {
    const svg = decode(biomeRingSvg(['#5aa84f', 'not-a-colour']));
    expect(svg.match(/<circle/g)).toHaveLength(2);
  });

  it('accepts 3- and 6-digit hex, case-insensitively', () => {
    const svg = decode(biomeRingSvg(['#ABC', '#AbCdEf']));
    expect(svg).toContain('#ABC');
    expect(svg).toContain('#AbCdEf');
  });

  it('honours size and thickness', () => {
    const svg = decode(biomeRingSvg(['#111111'], { size: 100, thickness: 12 }));
    expect(svg).toContain('width="100"');
    expect(svg).toContain('stroke-width="12"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/biomeRingSvg.test.js`
Expected: FAIL — cannot resolve `../biomeRingSvg.js`.

- [ ] **Step 3: Write the helper**

Create `frontend/src/games/something2/biomeRingSvg.js`:

```js
// A world's biomes as a ring of arcs, returned as an SVG data URI for
// Cytoscape's `background-image`.
//
// Cytoscape's built-in `pie` style is deliberately not used: it fills the node
// BODY, which would put colour behind the label instead of around it. A donut
// keeps the centre neutral and the name readable.

// biomes.color is admin-editable free text that ends up inside an SVG
// attribute. Only plain hex is allowed through; anything else is replaced with
// the neutral colour rather than interpolated.
export const SAFE_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const NEUTRAL = '#555555';

export function biomeRingSvg(colors, { size = 64, thickness = 8, empty = NEUTRAL } = {}) {
  const list = (Array.isArray(colors) ? colors : [])
    .map((c) => (typeof c === 'string' && SAFE_COLOR_RE.test(c.trim()) ? c.trim() : empty));
  const arcs = list.length > 0 ? list : [empty];

  const radius = (size - thickness) / 2;
  const centre = size / 2;
  const circumference = 2 * Math.PI * radius;
  const segment = circumference / arcs.length;

  const circles = arcs.map((colour, i) => (
    `<circle cx="${centre}" cy="${centre}" r="${radius}" fill="none" stroke="${colour}" `
    + `stroke-width="${thickness}" stroke-dasharray="${segment} ${circumference - segment}" `
    + `stroke-dashoffset="${-i * segment}" transform="rotate(-90 ${centre} ${centre})"/>`
  )).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" `
    + `viewBox="0 0 ${size} ${size}">${circles}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/biomeRingSvg.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Run the full frontend suite**

Run: `cd frontend && npm test`
Expected: 381 passing.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/biomeRingSvg.js frontend/src/games/something2/__tests__/biomeRingSvg.test.js
git commit -m "feat(map-graph): biome ring as a sanitised SVG data URI"
```

---

### Task 6: Query hooks + shared invalidation

**Files:**
- Create: `frontend/src/games/something2/useMapGraph.js`
- Modify: `frontend/src/games/something2/useMapsAdmin.js` (`useSetLink`, `useClearLink` — add one query key each)
- Create: `frontend/src/games/something2/__tests__/useMapGraph.test.js`

**Interfaces:**
- Consumes: `GET /api/world-graph` and `PUT /api/worlds/:id/graph-position` (Tasks 1-2).
- Produces: `useWorldGraph() -> { worlds, links, isLoadingGraph }`; `useSaveGraphPosition()` — a mutation called with `{ id, x, y }`. Both `useSetLink` and `useClearLink` additionally invalidate the `["worldGraph"]` key.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/__tests__/useMapGraph.test.js`:

```js
import { describe, it, expect } from 'vitest';
import * as graphHooks from '../useMapGraph.js';
import * as adminHooks from '../useMapsAdmin.js';

describe('useMapGraph', () => {
  it('exports the graph query and the position mutation', () => {
    expect(typeof graphHooks.useWorldGraph).toBe('function');
    expect(typeof graphHooks.useSaveGraphPosition).toBe('function');
  });

  it('still exports the link mutations it reuses', () => {
    expect(typeof adminHooks.useSetLink).toBe('function');
    expect(typeof adminHooks.useClearLink).toBe('function');
  });
});
```

Then, because vitest here has no DOM and hook bodies cannot be executed, add a
source-level contract test — the same technique `worldsPickerAdminGating.test.js`
already uses in this repo. Put these imports at the TOP of the file with the others:

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = (name) => readFileSync(
  fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8',
);

// Slice out ONE exported function's body, so a test for useSetLink cannot be
// satisfied by useClearLink happening to contain the string. (A slice spanning
// both would pass with only one of them fixed — the exact shape of vacuous test
// this repo keeps catching.)
function exportedBlock(source, name) {
  const start = source.indexOf(`export function ${name}`);
  if (start === -1) throw new Error(`${name} not found`);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

describe('cross-tab invalidation', () => {
  // Both the Maps tab and the World Map tab edit map_links. If a link mutation
  // does not invalidate the graph query, the diagram silently keeps showing a
  // link that no longer exists.
  it('useSetLink invalidates the worldGraph query key', () => {
    expect(exportedBlock(src('useMapsAdmin.js'), 'useSetLink')).toContain('worldGraph');
  });

  it('useClearLink invalidates the worldGraph query key', () => {
    expect(exportedBlock(src('useMapsAdmin.js'), 'useClearLink')).toContain('worldGraph');
  });

  it('useSetLink still invalidates the keys the Maps tab depends on', () => {
    const block = exportedBlock(src('useMapsAdmin.js'), 'useSetLink');
    expect(block).toContain('worldLinks');
    expect(block).toContain('"worlds"');
  });

  it('the position mutation does NOT invalidate the whole worlds list', () => {
    // Dragging a node is cosmetic; blowing away the shared ["worlds"] cache on
    // every drag would refetch the game's world picker for nothing.
    const block = exportedBlock(src('useMapGraph.js'), 'useSaveGraphPosition');
    expect(block).toContain('worldGraph');
    expect(block).not.toContain('"worlds"');
  });

  it('the graph query targets the aggregate endpoint', () => {
    expect(src('useMapGraph.js')).toContain('/api/world-graph');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/useMapGraph.test.js`
Expected: FAIL — cannot resolve `../useMapGraph.js`.

- [ ] **Step 3: Write the hooks**

Create `frontend/src/games/something2/useMapGraph.js`, following the conventions in `useBiomes.js` and `useMapsAdmin.js` exactly (same `apiFetch`, `authHeaders`, toast handling):

```js
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101";

// One snapshot of every world plus every link row (both directions).
export function useWorldGraph() {
  const { data, isLoading } = useQuery({
    queryKey: ["worldGraph"],
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/world-graph`);
      if (!res.ok) throw new Error("Failed to load the world graph");
      return res.json();
    },
  });
  return {
    worlds: data?.worlds || [],
    links: data?.links || [],
    isLoadingGraph: isLoading,
  };
}

// Node drags. Deliberately invalidates ONLY the graph query: a position is
// cosmetic, and busting the shared ["worlds"] cache on every drag would
// refetch the game's world picker for no reason. Silent on success — a toast
// per drag would be unbearable — but loud on failure, so a drag that did not
// persist never looks like it did.
export function useSaveGraphPosition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, x, y }) => {
      const res = await apiFetch(`${API_URL}/api/worlds/${id}/graph-position`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ x, y }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to save position");
      return res.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worldGraph"] }); },
    onError: (err) => toast.error(err.message),
  });
}
```

- [ ] **Step 4: Extend the shared link mutations**

In `frontend/src/games/something2/useMapsAdmin.js`, add the graph key to both link mutations' `onSuccess`. `useSetLink` becomes:

```js
    onSuccess: (data, v) => {
      qc.invalidateQueries({ queryKey: ["worldLinks", v.id] });
      qc.invalidateQueries({ queryKey: ["worlds"] });
      // The World Map tab reads links through ["worldGraph"]; without this it
      // keeps drawing a link the Maps tab just changed.
      qc.invalidateQueries({ queryKey: ["worldGraph"] });
      const warning = liveWarningFromBody(data);
      if (warning) toast(warning, LIVE_WARNING_TOAST_OPTS);
      else toast.success("Link saved");
    },
```

and `useClearLink` the same, keeping its existing `liveWarningFromHeader` handling intact. **Do not otherwise restructure these hooks** — they are covered by existing tests, and `MapsAdmin.jsx` must keep working unchanged.

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/useMapGraph.test.js src/games/something2/__tests__/useMapsAdmin.test.js src/games/something2/__tests__/useMapsAdminLinks.test.js`
Expected: all PASS.

- [ ] **Step 6: Run the full frontend suite**

Run: `cd frontend && npm test`
Expected: 386 passing.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/games/something2/useMapGraph.js frontend/src/games/something2/useMapsAdmin.js frontend/src/games/something2/__tests__/useMapGraph.test.js
git commit -m "feat(map-graph): graph query + position mutation, cross-tab invalidation"
```

---

### Task 7: Install deps + canvas

**Files:**
- Modify: `frontend/package.json` (three dependencies)
- Create: `frontend/src/games/something2/MapGraphAdmin.jsx`
- Create: `frontend/src/games/something2/__tests__/MapGraphAdmin.smoke.test.js`

**Interfaces:**
- Consumes: `useWorldGraph`, `useSaveGraphPosition` (Task 6); `useBiomes` from `./useBiomes.js`; `seedPositions` (Task 3); `lintGraph`, `collapseLinks` (Task 4); `biomeRingSvg` (Task 5).
- Produces: default-exported `MapGraphAdmin` component. Task 8 extends the same file with editing; Task 9 mounts it.

- [ ] **Step 1: Install the dependencies**

```bash
cd frontend && npm install cytoscape@3.34.0 react-cytoscapejs@2.0.0 cytoscape-edgehandles@4.0.1
```

Expected: installs cleanly with no `ERESOLVE` (verified against React 19.2.5). Commit the `package.json` and lockfile change with the component.

- [ ] **Step 2: Write the smoke test**

Create `frontend/src/games/something2/__tests__/MapGraphAdmin.smoke.test.js`, matching `MapsAdmin.smoke.test.js` — vitest runs without a DOM here, so a mount test is impossible and an export check is the honest limit:

```js
import { describe, it, expect } from 'vitest';
import MapGraphAdmin from '../MapGraphAdmin.jsx';

describe('MapGraphAdmin', () => {
  it('is a component export', () => {
    expect(typeof MapGraphAdmin).toBe('function');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/MapGraphAdmin.smoke.test.js`
Expected: FAIL — cannot resolve `../MapGraphAdmin.jsx`.

- [ ] **Step 4: Write the canvas**

Create `frontend/src/games/something2/MapGraphAdmin.jsx`. Copy the styled-component vocabulary from `BiomesAdmin.jsx` (`AdminContainer`, `Header`, `Button`, `Card`, `Row`) the way each admin tab in this codebase defines its own.

```jsx
import { useMemo, useRef, useState, useEffect } from 'react';
import styled from 'styled-components';
import CytoscapeComponent from 'react-cytoscapejs';
import { useWorldGraph, useSaveGraphPosition } from './useMapGraph.js';
import { useBiomes } from './useBiomes.js';
import { seedPositions } from './mapGraphLayout.js';
import { collapseLinks, lintGraph } from './mapGraphLint.js';
import { biomeRingSvg } from './biomeRingSvg.js';

const AdminContainer = styled.div`
  padding: 2rem; color: #eee; max-width: 1400px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: #1a1a2e;
`;
const Header = styled.div`display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;`;
const Layout = styled.div`display: flex; gap: 1rem; align-items: flex-start;`;
const CanvasCard = styled.div`
  flex: 1; height: 600px; background: #12121f;
  border: 1px solid #333; border-radius: 8px; overflow: hidden;
`;
const Side = styled.div`width: 260px; flex-shrink: 0;`;
const Card = styled.div`background: #23233f; border: 1px solid #333; border-radius: 8px; padding: 1rem; margin-bottom: 1rem;`;
const Warn = styled.div`color: #f59e0b; font-size: 0.85em; margin: 0.25rem 0;`;
const Dim = styled.div`color: #888; font-size: 0.9em; margin: 0.2rem 0;`;

const bounded = (w) => !!(w.width && w.height);

function MapGraphAdmin() {
  const { worlds, links, isLoadingGraph } = useWorldGraph();
  const { biomes } = useBiomes();
  const savePosition = useSaveGraphPosition();
  const cyRef = useRef(null);
  // Positions the client seeded for worlds that have none. Kept in state so a
  // drag updates the picture immediately; only dragged nodes are persisted.
  const [localPos, setLocalPos] = useState({});

  const colourOf = useMemo(() => {
    const map = new Map((biomes || []).map((b) => [b.name, b.color]));
    return (names) => (names || []).map((n) => map.get(n)).filter(Boolean);
  }, [biomes]);

  const linkable = useMemo(() => worlds.filter(bounded), [worlds]);
  const unbounded = useMemo(() => worlds.filter((w) => !bounded(w)), [worlds]);

  const positions = useMemo(
    () => ({ ...seedPositions(linkable, links), ...localPos }),
    [linkable, links, localPos],
  );

  const warnings = useMemo(
    () => lintGraph({ worlds: linkable, links, positions }),
    [linkable, links, positions],
  );

  const elements = useMemo(() => {
    const nodes = linkable.map((w) => ({
      data: {
        id: w.id,
        label: w.is_entry ? `★ ${w.name}` : w.name,
        ring: biomeRingSvg(colourOf(w.biomes)),
      },
      position: positions[w.id] || { x: 0, y: 0 },
    }));
    const edges = collapseLinks(links)
      .filter((l) => positions[l.fromId] && positions[l.toId])
      .map((l) => ({
        data: {
          id: `${l.fromId}|${l.edge}`,
          source: l.fromId,
          target: l.toId,
          label: `${l.edge}↔${l.toEdge}`,
          mirrored: String(l.mirrored),
        },
      }));
    return [...nodes, ...edges];
  }, [linkable, links, positions, colourOf]);

  const stylesheet = useMemo(() => ([
    {
      selector: 'node',
      style: {
        'background-color': '#23233f',
        'background-image': 'data(ring)',
        'background-fit': 'cover',
        'border-width': 1,
        'border-color': '#444',
        width: 64, height: 64,
        label: 'data(label)',
        color: '#eee',
        'font-size': 11,
        'text-valign': 'bottom',
        'text-margin-y': 6,
      },
    },
    {
      selector: 'edge',
      style: {
        'curve-style': 'straight',
        'line-color': '#4a9eff',
        width: 2,
        label: 'data(label)',
        color: '#9bb',
        'font-size': 10,
        'text-background-color': '#12121f',
        'text-background-opacity': 0.8,
      },
    },
    { selector: 'edge[mirrored = "false"]', style: { 'line-color': '#f59e0b', 'line-style': 'dashed' } },
    { selector: ':selected', style: { 'border-color': '#facc15', 'border-width': 3, 'line-color': '#facc15' } },
  ]), []);

  // Persist a node's position when the admin finishes dragging it.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return undefined;
    const onFree = (evt) => {
      const node = evt.target;
      const { x, y } = node.position();
      setLocalPos((prev) => ({ ...prev, [node.id()]: { x, y } }));
      savePosition.mutate({ id: node.id(), x, y });
    };
    cy.on('free', 'node', onFree);
    return () => { cy.off('free', 'node', onFree); };
  }, [savePosition]);

  if (isLoadingGraph) return <AdminContainer>Loading world graph…</AdminContainer>;

  return (
    <AdminContainer>
      <Header><h2>World Map</h2></Header>
      <Layout>
        <CanvasCard>
          <CytoscapeComponent
            elements={elements}
            stylesheet={stylesheet}
            layout={{ name: 'preset' }}
            style={{ width: '100%', height: '100%' }}
            cy={(cy) => { cyRef.current = cy; }}
          />
        </CanvasCard>
        <Side>
          <Card>
            <strong style={{ color: '#aaa' }}>Consistency</strong>
            {warnings.length === 0 && <Dim>No problems found.</Dim>}
            {warnings.map((w, i) => <Warn key={`${w.code}-${i}`}>{w.message}</Warn>)}
          </Card>
          <Card>
            <strong style={{ color: '#aaa' }}>Not linkable ({unbounded.length})</strong>
            <Dim>These worlds have no width and height, so they cannot hold links. Set bounds in the Maps tab.</Dim>
            {unbounded.map((w) => <Dim key={w.id}>○ {w.name}</Dim>)}
          </Card>
        </Side>
      </Layout>
    </AdminContainer>
  );
}

export default MapGraphAdmin;
```

**Verify against the installed versions as you go**: confirm `react-cytoscapejs` default-exports the component, that `cy` is the prop name for the instance callback, and that the `free` event fires on drag end. If any differs, fix the component and say so in your report — do not weaken the smoke test to accommodate a broken component.

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npm test`
Expected: 387 passing.

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/games/something2/MapGraphAdmin.jsx frontend/src/games/something2/__tests__/MapGraphAdmin.smoke.test.js
git commit -m "feat(map-graph): cytoscape canvas with biome rings, lint panel and unbounded tray"
```

---

### Task 8: Link editing

**Files:**
- Modify: `frontend/src/games/something2/MapGraphAdmin.jsx`
- Create: `frontend/src/games/something2/mapGraphActions.js`
- Create: `frontend/src/games/something2/__tests__/mapGraphActions.test.js`

**Interfaces:**
- Consumes: `linksReplacedBy` (Task 4); `compassFromDelta`, `OPPOSITE` (Task 3); `useSetLink`, `useClearLink` from `./useMapsAdmin.js`.
- Produces: `planLinkChange({ links, fromId, edge, toId }) -> { clears: [{ fromId, edge }], create: { fromId, edge, toId } }` — the ordered call plan for creating a link.

**Why a plan object rather than calling directly:** `setLink` upserts, so creating `a.E→b` when `a.E→c` exists overwrites the row *and leaves `c.W→a` behind, dangling* — a one-way link the missing-mirror lint then reports. Clearing conflicts first (via `clearLink`, which deletes both sides) avoids manufacturing that garbage. The ordering is the logic worth testing, so it lives in a pure function.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/__tests__/mapGraphActions.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { planLinkChange } from '../mapGraphActions.js';

const L = (from, edge, to) => ({ from_world_id: from, edge, to_world_id: to });

describe('planLinkChange', () => {
  it('creates directly when both slots are free', () => {
    expect(planLinkChange({ links: [], fromId: 'a', edge: 'E', toId: 'b' })).toEqual({
      clears: [],
      create: { fromId: 'a', edge: 'E', toId: 'b' },
    });
  });

  // setLink would overwrite a.E and leave c.W->a dangling, so clear it first.
  it("clears the source's occupied slot before creating", () => {
    const plan = planLinkChange({ links: [L('a', 'E', 'c'), L('c', 'W', 'a')], fromId: 'a', edge: 'E', toId: 'b' });
    expect(plan.clears).toContainEqual({ fromId: 'a', edge: 'E' });
    expect(plan.create).toEqual({ fromId: 'a', edge: 'E', toId: 'b' });
  });

  it("clears the TARGET's opposing slot too", () => {
    const plan = planLinkChange({ links: [L('b', 'W', 'd'), L('d', 'E', 'b')], fromId: 'a', edge: 'E', toId: 'b' });
    expect(plan.clears).toContainEqual({ fromId: 'b', edge: 'W' });
  });

  it('clears both when both are occupied', () => {
    const links = [L('a', 'E', 'c'), L('c', 'W', 'a'), L('b', 'W', 'd'), L('d', 'E', 'b')];
    const plan = planLinkChange({ links, fromId: 'a', edge: 'E', toId: 'b' });
    expect(plan.clears).toHaveLength(2);
  });

  it('is a no-op create when the exact link already exists', () => {
    const plan = planLinkChange({ links: [L('a', 'E', 'b'), L('b', 'W', 'a')], fromId: 'a', edge: 'E', toId: 'b' });
    expect(plan.clears).toEqual([]);
    expect(plan.create).toEqual({ fromId: 'a', edge: 'E', toId: 'b' });
  });

  it('never emits a clear twice for the same slot', () => {
    const links = [L('a', 'E', 'c'), L('c', 'W', 'a')];
    const plan = planLinkChange({ links, fromId: 'a', edge: 'E', toId: 'b' });
    const keys = plan.clears.map((c) => `${c.fromId}|${c.edge}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/mapGraphActions.test.js`
Expected: FAIL — cannot resolve `../mapGraphActions.js`.

- [ ] **Step 3: Write the action planner**

Create `frontend/src/games/something2/mapGraphActions.js`:

```js
// Turning "link these two worlds on this edge" into an ordered list of API
// calls.
//
// The subtlety: setLink() upserts on (from_world_id, edge), twice — once for
// the link and once for its mirror. So creating a.E -> b when a.E -> c already
// exists overwrites a's row but leaves c.W -> a untouched and dangling, which
// is exactly the one-way-travel state the missing-mirror lint reports. Clearing
// the conflicting slots first (clearLink deletes BOTH sides) means the upsert
// never has anything to displace.
import { linksReplacedBy } from './mapGraphLint.js';

export function planLinkChange({ links, fromId, edge, toId }) {
  const clears = linksReplacedBy({ links, fromId, edge, toId })
    .map((row) => ({ fromId: row.from_world_id, edge: row.edge }));
  return { clears, create: { fromId, edge, toId } };
}
```

- [ ] **Step 4: Run the test**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/mapGraphActions.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire editing into the component**

In `MapGraphAdmin.jsx`:

1. Register the extension once at module scope (outside the component, so a re-render cannot re-register it):

```jsx
import cytoscape from 'cytoscape';
import edgehandles from 'cytoscape-edgehandles';
import { planLinkChange } from './mapGraphActions.js';
import { linksReplacedBy } from './mapGraphLint.js';
import { compassFromDelta, OPPOSITE } from './mapGraphLayout.js';
import { useSetLink, useClearLink } from './useMapsAdmin.js';

cytoscape.use(edgehandles);
```

2. Hold the pending proposal in state — **nothing is written on drop**:

```jsx
  const [pending, setPending] = useState(null); // { fromId, toId, edge }
```

3. In the same `useEffect` that binds `free`, start edgehandles and capture completions. Remove the preview edge it adds; this UI confirms first, then writes:

```jsx
    const eh = cy.edgehandles({ snap: true });
    const onComplete = (evt, source, target, addedEdge) => {
      addedEdge.remove();
      const a = source.position();
      const b = target.position();
      setPending({ fromId: source.id(), toId: target.id(), edge: compassFromDelta(b.x - a.x, b.y - a.y) });
    };
    cy.on('ehcomplete', onComplete);
    return () => { cy.off('ehcomplete', onComplete); cy.off('free', 'node', onFree); eh.destroy(); };
```

4. Render the confirmation panel whenever `pending` is set. It must name every link about to be destroyed:

```jsx
  const replaced = pending
    ? linksReplacedBy({ links, fromId: pending.fromId, edge: pending.edge, toId: pending.toId })
    : [];
  const nameOf = (id) => (worlds.find((w) => w.id === id) || {}).name || id;
```

```jsx
  {pending && (
    <Card>
      <strong style={{ color: '#aaa' }}>New link</strong>
      <Row>
        {nameOf(pending.fromId)} edge{' '}
        <select value={pending.edge} onChange={(e) => setPending({ ...pending, edge: e.target.value })}>
          {['N', 'E', 'S', 'W'].map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        {' → '}{nameOf(pending.toId)} gets {OPPOSITE[pending.edge]}
      </Row>
      {replaced.length > 0 && (
        <Warn>
          This replaces {replaced.length} existing link{replaced.length > 1 ? 's' : ''}:{' '}
          {replaced.map((r) => `${nameOf(r.from_world_id)} ${r.edge} → ${nameOf(r.to_world_id)}`).join('; ')}
        </Warn>
      )}
      <Row>
        <Button onClick={commitPending} disabled={busy}>
          {replaced.length > 0 ? 'Replace and link' : 'Create link'}
        </Button>
        <Button $bg="#555" onClick={() => setPending(null)}>Cancel</Button>
      </Row>
    </Card>
  )}
```

5. `commitPending` runs the plan in order and reports a partial failure honestly — a create that fails after the clears succeeded leaves the worlds **unlinked**, and the admin must be told rather than shown a success toast:

```jsx
  const setLink = useSetLink();
  const clearLink = useClearLink();
  const [busy, setBusy] = useState(false);

  const commitPending = async () => {
    if (!pending) return;
    const plan = planLinkChange({ links, ...pending });
    setBusy(true);
    try {
      for (const c of plan.clears) {
        await clearLink.mutateAsync({ id: c.fromId, edge: c.edge });
      }
      await setLink.mutateAsync({ id: plan.create.fromId, edge: plan.create.edge, to_world_id: plan.create.toId });
      setPending(null);
    } catch (err) {
      // The hooks already toast the failure. Say what state we are in: if the
      // clears landed and the create did not, those worlds are now unlinked.
      toast.error('Link change did not complete — the diagram has been refreshed to show the real state.');
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ['worldGraph'] });
    }
  };
```

Import `toast` from `react-hot-toast` and `useQueryClient` from `@tanstack/react-query` for `qc`.

6. Deleting. Track the selected edge and offer a delete button for it. The edge's
   Cytoscape `id` was set in Task 7 to `` `${fromId}|${edge}` ``, so both halves come
   straight back out of it:

```jsx
  const [selectedEdge, setSelectedEdge] = useState(null); // { fromId, edge, toId }
```

   Bind selection in the same `useEffect` that binds `free` and `ehcomplete`:

```jsx
    const onSelect = (evt) => {
      const [fromId, edge] = evt.target.id().split('|');
      setSelectedEdge({ fromId, edge, toId: evt.target.data('target') });
    };
    const onUnselect = () => setSelectedEdge(null);
    cy.on('select', 'edge', onSelect);
    cy.on('unselect', 'edge', onUnselect);
```

   and add both to the same cleanup return as the other handlers
   (`cy.off('select', 'edge', onSelect); cy.off('unselect', 'edge', onUnselect);`).

   Render the panel when an edge is selected:

```jsx
  {selectedEdge && (
    <Card>
      <strong style={{ color: '#aaa' }}>Selected link</strong>
      <Row>
        {nameOf(selectedEdge.fromId)} {selectedEdge.edge} → {nameOf(selectedEdge.toId)}
      </Row>
      <Warn>Removing this clears BOTH directions, and rebuilds terrain for both worlds.</Warn>
      <Row>
        <Button
          $bg="#ef4444"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await clearLink.mutateAsync({ id: selectedEdge.fromId, edge: selectedEdge.edge });
              setSelectedEdge(null);
            } finally {
              setBusy(false);
              qc.invalidateQueries({ queryKey: ['worldGraph'] });
            }
          }}
        >
          Remove link
        </Button>
      </Row>
    </Card>
  )}
```

   `clearLink` already toasts its own failure and surfaces the live-world warning
   from the `X-Live-World-Pending` header, so no extra handling is needed here.

- [ ] **Step 6: Run the full frontend suite**

Run: `cd frontend && npm test`
Expected: 393 passing.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/games/something2/mapGraphActions.js frontend/src/games/something2/MapGraphAdmin.jsx frontend/src/games/something2/__tests__/mapGraphActions.test.js
git commit -m "feat(map-graph): drag-to-link with overwrite confirmation and honest partial-failure reporting"
```

---

### Task 9: Tab wiring

**Files:**
- Modify: `frontend/src/games/something2/Something2.jsx` (imports line 4 and ~line 17; tab buttons ~line 666; render ~line 852)

**Interfaces:**
- Consumes: default-exported `MapGraphAdmin` (Tasks 7-8).
- Produces: an admin-gated `activeTab === 'worldmap'` tab.

- [ ] **Step 1: Add the imports**

Add `HiOutlineShare` to the existing `react-icons/hi2` import on line 4, and beside the other admin imports:

```jsx
import MapGraphAdmin from "./MapGraphAdmin";
```

- [ ] **Step 2: Add the tab button**

Immediately after the Biomes `TabButton` (~line 666-668):

```jsx
            <TabButton $active={activeTab === 'worldmap'} $adminType="maps" onClick={() => setActiveTab('worldmap')}>
              <HiOutlineShare /> World Map
            </TabButton>
```

- [ ] **Step 3: Add the render line**

Immediately after the `BiomesAdmin` render line (~line 852):

```jsx
        {isAdmin && activeTab === 'worldmap' && <MapGraphAdmin />}
```

- [ ] **Step 4: Verify `MapsAdmin.jsx` is untouched**

Run: `git diff --stat main -- frontend/src/games/something2/MapsAdmin.jsx`
Expected: **no output**. If this prints anything, a global constraint has been violated — revert that file.

- [ ] **Step 5: Run the full frontend suite**

Run: `cd frontend && npm test`
Expected: 393 passing.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/Something2.jsx
git commit -m "feat(map-graph): mount the World Map tab"
```

---

### Task 10: Browser verification

**Files:** none (verification only; defects are fixed in the file that owns them).

This gate exists because a green suite has repeatedly missed real defects in this project, and here it carries more weight than usual: **vitest runs without a DOM, so not one line of Cytoscape code is exercised by any test.** Everything in Tasks 7-9 is unverified until this runs.

- [ ] **Step 1: Apply the migration**

The stack hot-reloads from this checkout (vite `:15173`, backend `:13101`); containers are already running. Apply the new migration:

```bash
cd backend && npm run migrate:up
```

Expected: `1714440044000_world_graph_positions` applied.

- [ ] **Step 2: Prove you are testing the new code**

```bash
curl -s http://localhost:13101/api/world-graph | head -c 400
```

Expected: JSON with `worlds` and `links`. A 404 means the backend did not reload — fix that before concluding anything.

- [ ] **Step 3: Verify the canvas**

Open `http://localhost:15173`, sign in as admin, open **World Map**. Confirm: the 4 bounded worlds render as nodes; `BoundedArena` and `test2` show their links; biome rings appear on worlds that have biomes (`BoundedArena` has Arid Dunes + Frozen Waste from the earlier verification, unless reverted) and grey rings on those that do not; the entry world is starred; the **Not linkable** tray lists all 13 unbounded worlds.

- [ ] **Step 4: Verify the lint panel**

The live topology (all four of `BoundedArena`'s edges pointing at `test2`) must produce `duplicate-direction` and/or `direction-mismatch` warnings rather than a clean panel — three of those four links cannot possibly be drawn correctly. If the panel is empty, the lint is not running.

- [ ] **Step 5: Verify position persistence**

Drag a node, reload the page, confirm it stays put. Then check the drag did **not** invalidate terrain:

```bash
docker exec something2-db-1 psql -U user -d game_db -At -c \
  "SELECT count(*) FROM world_chunks;"
```

Run it before and after a drag — **the count must not change**. This is the single most important check in this task.

- [ ] **Step 6: Verify link creation and the overwrite warning**

Drag from one world to another. Confirm the inferred compass edge matches the drag direction, that the panel names any links about to be replaced, and that cancelling writes nothing. Then confirm creating a link that displaces an existing one leaves **no dangling one-way link** — the missing-mirror warning must not appear afterwards.

- [ ] **Step 7: Verify deletion and cross-tab agreement**

Delete a link from the graph, switch to the **Maps** tab, and confirm its dropdowns agree. Then change a link in the Maps tab, return to World Map, and confirm the diagram updates.

- [ ] **Step 8: Verify the live-world warning**

With a player connected to a world, change one of its links and confirm the warning toast appears (link routes invalidate **both** worlds).

- [ ] **Step 9: Run both suites**

```bash
cd backend && npm test
cd ../frontend && npm test
```
Expected: both green (backend 932, frontend 393).

- [ ] **Step 10: Record the result**

Write what you observed for every step into the task report, **including anything that did not work**. A step you could not perform must be reported as NOT PERFORMED, never as passed.

---

## Notes for the executor

- **`MapsAdmin.jsx` must not appear in any diff.** `useMapsAdmin.js` may (Task 6). Check with `git diff --stat main -- frontend/src/games/something2/MapsAdmin.jsx`.
- **No test exercises Cytoscape.** vitest is `environment: "node"` here. Do not add jsdom to make component tests possible — that is a bigger decision than this plan, and the browser gate is the agreed substitute.
- **If the installed Cytoscape API differs from Task 7/8's code** (prop names, event names, `edgehandles` options), fix the component and say so plainly in your report. Do not weaken a test to match broken code.
- **Watch for a re-render fight over positions.** `elements` is recomputed by `useMemo`, and `react-cytoscapejs` diffs it against the live graph — a new element array carrying `position` can snap a node back mid-drag or reset the viewport. If you see nodes jumping, the fix is to stop feeding positions through `elements` after first mount and let Cytoscape own them (seed once, then only read positions out on `free`), **not** to remove the `useMemo` dependencies until the symptom stops. Report what you did either way; this is the most likely place Tasks 7-8 need to diverge from the plan's code.
- **Nothing here is exercised by a test.** vitest has no DOM, so Tasks 7-9 are entirely unverified until Task 10. Budget accordingly — do not treat a green suite as evidence the tab works.
- The known flake is `authority_server.test.js` "a token bucket of capacity 1 admits the join frame" — re-run before assuming a failure is yours.
