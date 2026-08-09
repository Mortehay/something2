# P5 — Map Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate one new map spec (`backend/seeds/maps/p5-descent.map.json`) covering an 8-dungeon chained descent (~50 rooms) plus 10 new standalone surface worlds, matching `docs/superpowers/specs/2026-08-08-p5-map-content-design.md`, and seed it into the live dev database.

**Architecture:** Pure data/derivation modules (content table, escalation math, reusable topology skeletons) compose in a single generator script that emits a spec file in the exact shape `backend/seeds/maps/*.map.json` already uses — the existing, unmodified `backend/tests/map_spec_fixtures.test.js` is the primary correctness gate, exactly as it already validates the 3 shipped example specs.

**Tech Stack:** Plain Node.js (CommonJS, no new dependencies), `node:test` for tests, the existing `backend/seeds/mapSpec.js` validator and `backend/scripts/seed-map.js` applier — both unmodified.

## Global Constraints

- No schema changes, no new migration — `density`, `level_band`, `PORTAL` links, and `guard` all already exist and are validated by the existing `mapSpec.js`.
- No hand-authored world content — every world/link in the output is derived from the tables and math this plan defines, per the approved design's "generator-first" decision.
- The generated spec must pass `node --test tests/map_spec_fixtures.test.js` unmodified — this is the acceptance gate for every generator task, not a separate concern.
- Grid coordinates for every new world start at `x >= 20`, to guarantee zero collision with the 3 existing example specs (verified live: they occupy `x: [-1, 4]`).
- Portal link coordinates are in world pixels, 100px/tile (`backend/src/services/mapService.js:496`, `CREATURE_TILE_PX = 100`) — matching the convention the 3 shipped specs already use for `entry_spawn`.

---

## File Structure

- `backend/scripts/dungeon/content.js` — **new.** Pure data: the 8-dungeon table (lines/biomes, tier clamp, topology, portal-guard creature) and the 5-new-surface-biome table.
- `backend/scripts/dungeon/escalation.js` — **new.** Pure functions: hop-distance → `level_band`/`density`, clamped to a tier range.
- `backend/scripts/dungeon/skeletons.js` — **new.** Three reusable room-graph templates (spine/hub/loop), each a literal re-shape of one of the 3 already-shipped, already-validated example specs — this is what keeps the grid-embedding and topology-shape rules safe by construction instead of inventing new topology math.
- `backend/scripts/dungeon/gen-p5-map-content.js` — **new.** Combines the three modules above into the full spec object, computes real BFS hop-distances over the assembled graph, and writes `backend/seeds/maps/p5-descent.map.json`.
- `backend/scripts/dungeon/restore-entry.js` — **new.** Small post-seed CLI script: restores whichever world was `is_entry` before this spec's apply.
- `backend/tests/p5_escalation.test.js` — **new.** Unit tests for `escalation.js`.
- `backend/tests/p5_skeletons.test.js` — **new.** Unit tests for `skeletons.js` (room count, link count, valid grid deltas per shape).
- `backend/tests/p5_gen_map_content.test.js` — **new.** Generator-level shape assertions (world count in range, exactly one `is_entry`, 7 inter-dungeon portal links each with a guard, 10 surface worlds).
- `backend/seeds/maps/p5-descent.map.json` — **generated output**, committed once produced (same convention as the 3 shipped hand-authored specs).
- `backend/tests/map_spec_fixtures.test.js` — **unmodified.** Already iterates every `*.map.json`; the new file is covered automatically.

---

### Task 1: Dungeon and surface content tables

**Files:**
- Create: `backend/scripts/dungeon/content.js`
- Test: `backend/tests/p5_content.test.js`

**Interfaces:**
- Produces: `DUNGEONS` (array of 8), `SURFACE_BIOMES` (array of 5) — both consumed by Task 4 (generator).

- [ ] **Step 1: Write the failing test**

```javascript
// backend/tests/p5_content.test.js
const test = require('node:test');
const assert = require('node:assert');
const { DUNGEONS, SURFACE_BIOMES } = require('../scripts/dungeon/content');

test('exactly 8 dungeons, tier clamp floors and ceilings both non-decreasing in order', () => {
  assert.equal(DUNGEONS.length, 8);
  for (let i = 1; i < DUNGEONS.length; i++) {
    assert.ok(DUNGEONS[i].tierClamp[0] >= DUNGEONS[i - 1].tierClamp[0],
      `dungeon ${i} tier floor must not drop below dungeon ${i - 1}'s`);
    assert.ok(DUNGEONS[i].tierClamp[1] >= DUNGEONS[i - 1].tierClamp[1],
      `dungeon ${i} tier ceiling must not drop below dungeon ${i - 1}'s`);
  }
  assert.ok(DUNGEONS[7].tierClamp[1] >= DUNGEONS[0].tierClamp[1] * 2,
    'deepest dungeon ceiling must clear double the entry dungeon ceiling');
});

test('every dungeon lists at least one line/biome and a portal guard creature name', () => {
  for (const d of DUNGEONS) {
    assert.ok(Array.isArray(d.lines) && d.lines.length >= 1, `${d.key} has no lines`);
    for (const l of d.lines) {
      assert.equal(typeof l.line, 'string');
      assert.equal(typeof l.biome, 'string');
    }
    assert.equal(typeof d.topology, 'string');
    assert.ok(['spine', 'hub', 'loop'].includes(d.topology), `${d.key} has unknown topology ${d.topology}`);
    assert.equal(typeof d.guardCreature, 'string');
  }
});

test('the 22 underground/abyssal lines are each assigned to exactly one dungeon', () => {
  const seen = new Set();
  for (const d of DUNGEONS) {
    for (const l of d.lines) {
      assert.ok(!seen.has(l.line), `line "${l.line}" assigned to more than one dungeon`);
      seen.add(l.line);
    }
  }
  assert.equal(seen.size, 22);
});

test('5 new surface biomes, each with a line name and primary element', () => {
  assert.equal(SURFACE_BIOMES.length, 5);
  for (const s of SURFACE_BIOMES) {
    assert.equal(typeof s.line, 'string');
    assert.equal(typeof s.biome, 'string');
    // element may be null only for a line with no primary element (none of the 5 new surface lines are null-element)
    assert.equal(typeof s.element, 'string');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/p5_content.test.js`
Expected: FAIL with "Cannot find module '../scripts/dungeon/content'"

- [ ] **Step 3: Write the implementation**

```javascript
// backend/scripts/dungeon/content.js
//
// Static content tables for P5 (SOMET-251), instantiating the umbrella
// spec's (docs/superpowers/specs/2026-08-06-bestiary-program-design.md)
// 22 underground/abyssal lines into 8 chained dungeons, and its 5 new
// surface lines into 5 standalone surface biomes. See
// docs/superpowers/specs/2026-08-08-p5-map-content-design.md's "The
// 8-dungeon chain" table for the grouping rationale.
//
// tierClamp is [floor, ceiling] in player levels (1-50), the union of every
// depth tier (I:1-12, II:8-24, III:20-36, IV:32-50) a dungeon's lines span
// -- this is the outer bound escalation.js clamps level_band into.
//
// guardCreature names the portal guard standing on this dungeon's entry
// tile, drawn from the dungeon's first-listed line at the Line rung
// ("{Line} Line", matching gen-p4-bestiary.js's "{Line} {Rung}" naming) --
// every one of the 288 P4 creatures follows this exact naming, so this is
// a real, already-seeded creature type name, not a placeholder.
const DUNGEONS = [
  {
    key: 'd1', name: 'The Catacombs', topology: 'spine', tierClamp: [1, 24],
    lines: [{ line: 'Undead', biome: 'Catacombs' }, { line: 'Cave', biome: 'Cavern' }],
    guardCreature: 'Undead Line',
  },
  {
    key: 'd2', name: 'The Underdeep', topology: 'hub', tierClamp: [8, 24],
    lines: [{ line: 'Fungal', biome: 'Fungal Deep' }, { line: 'Gloom', biome: 'Gloomfen' }],
    guardCreature: 'Fungal Line',
  },
  {
    key: 'd3', name: 'The Ossuary Depths', topology: 'loop', tierClamp: [8, 36],
    lines: [{ line: 'Bonelord', biome: 'Ossuary' }, { line: 'Drowned', biome: 'Sunken Cistern' }],
    guardCreature: 'Bonelord Line',
  },
  {
    key: 'd4', name: 'The Emberhive', topology: 'spine', tierClamp: [8, 36],
    lines: [{ line: 'Ember', biome: 'Emberdepths' }, { line: 'Hive', biome: 'Hive Warrens' }],
    guardCreature: 'Ember Line',
  },
  {
    key: 'd5', name: 'The Frozen Vaults', topology: 'hub', tierClamp: [8, 36],
    lines: [
      { line: 'Rime', biome: 'Frostvault' },
      { line: 'Blight', biome: 'Blightworks' },
      { line: 'Construct', biome: 'Deepvault' },
    ],
    guardCreature: 'Rime Line',
  },
  {
    key: 'd6', name: 'The Crystal Foundry', topology: 'loop', tierClamp: [20, 36],
    lines: [{ line: 'Crystal', biome: 'Crystal Hollows' }, { line: 'Stoneborn', biome: 'Sunken Foundry' }],
    guardCreature: 'Crystal Line',
  },
  {
    key: 'd7', name: 'The Umbral Gate', topology: 'spine', tierClamp: [20, 50],
    lines: [
      { line: 'Umbral', biome: 'Umbral Warren' },
      { line: 'Demonic', biome: 'Infernal Gate' },
      { line: 'Plague', biome: 'Pestilent Deep' },
    ],
    guardCreature: 'Umbral Line',
  },
  {
    key: 'd8', name: 'The Abyss', topology: 'hub', tierClamp: [32, 50],
    lines: [
      { line: 'Void', biome: 'Abyssal Rift' }, { line: 'Chaos', biome: 'Shattered Vault' },
      { line: 'Fallen', biome: 'Fallen Sanctum' }, { line: 'Nightmare', biome: 'Dreaming Dark' },
      { line: 'Titan', biome: 'Grave of Titans' }, { line: 'Eldritch', biome: 'The Maw' },
    ],
    guardCreature: 'Void Line',
  },
];

// The 5 new surface lines from the umbrella's surface table, tier I-III.
// Each gets 2 standalone worlds (Task 4) -- shallow content, so
// allowed_creature_types only ever draws Swarm/Skirmisher/Line rungs.
const SURFACE_BIOMES = [
  { line: 'Highland', biome: 'Highlands', element: 'physical' },
  { line: 'Jungle', biome: 'Verdant Jungle', element: 'lightning' },
  { line: 'Storm', biome: 'Storm Coast', element: 'lightning' },
  { line: 'Ruin', biome: 'Sunken Ruins', element: 'ice' },
  { line: 'Volcanic', biome: 'Ashfields', element: 'fire' },
];

module.exports = { DUNGEONS, SURFACE_BIOMES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/p5_content.test.js`
Expected: PASS, 4/4

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/dungeon/content.js backend/tests/p5_content.test.js
git commit -m "feat(dungeons): P5 content tables — 8 dungeons, 5 surface biomes (SOMET-251)"
```

---

### Task 2: Escalation math (level_band / density by hop-distance)

**Files:**
- Create: `backend/scripts/dungeon/escalation.js`
- Test: `backend/tests/p5_escalation.test.js`

**Interfaces:**
- Produces: `deriveLevelBand(hopFraction, tierClamp) -> [min, max]`, `deriveDensity(hopFraction) -> string` — both consumed by Task 4 (generator).
- Consumes: nothing (pure math, no dependency on Task 1's data).

- [ ] **Step 1: Write the failing test**

```javascript
// backend/tests/p5_escalation.test.js
const test = require('node:test');
const assert = require('node:assert');
const { deriveLevelBand, deriveDensity, DENSITY_ORDER } = require('../scripts/dungeon/escalation');

test('deriveLevelBand floor and ceiling both rise monotonically with hopFraction', () => {
  const clamp = [1, 50];
  let prevMin = -Infinity, prevMax = -Infinity;
  for (let i = 0; i <= 10; i++) {
    const [min, max] = deriveLevelBand(i / 10, clamp);
    assert.ok(min >= prevMin, `floor dropped at hopFraction ${i / 10}`);
    assert.ok(max >= prevMax, `ceiling dropped at hopFraction ${i / 10}`);
    assert.ok(min >= clamp[0] && max <= clamp[1], 'band must stay inside the tier clamp');
    assert.ok(max >= min + 1, 'band must have positive width');
    prevMin = min; prevMax = max;
  }
});

test('deriveLevelBand never exceeds its tier clamp even at hopFraction 1', () => {
  const clamp = [20, 36];
  const [min, max] = deriveLevelBand(1, clamp);
  assert.ok(min >= 20 && max <= 36);
});

test('deriveLevelBand at hopFraction 0 sits at the clamp floor', () => {
  const [min] = deriveLevelBand(0, [8, 24]);
  assert.equal(min, 8);
});

test('deriveDensity steps through 5 keywords, never returns "dead"', () => {
  const seen = new Set();
  for (let i = 0; i <= 20; i++) seen.add(deriveDensity(i / 20));
  assert.equal(deriveDensity(0), 'sparse');
  assert.equal(deriveDensity(1), 'swarm');
  assert.ok(!seen.has('dead'));
  for (const d of seen) assert.ok(DENSITY_ORDER.includes(d));
});

test('deriveDensity never decreases as hopFraction rises', () => {
  let prevIdx = -1;
  for (let i = 0; i <= 20; i++) {
    const idx = DENSITY_ORDER.indexOf(deriveDensity(i / 20));
    assert.ok(idx >= prevIdx, `density dropped at hopFraction ${i / 20}`);
    prevIdx = idx;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/p5_escalation.test.js`
Expected: FAIL with "Cannot find module '../scripts/dungeon/escalation'"

- [ ] **Step 3: Write the implementation**

```javascript
// backend/scripts/dungeon/escalation.js
//
// Pure hop-distance -> level_band/density derivation for P5 (SOMET-251).
// hopFraction is hopDistance / maxHopDistance across the WHOLE assembled
// graph (computed by the generator's BFS from the single entry, Task 4),
// clamped to [0,1]. Mirrors map_spec_fixtures.test.js's own escalation
// check -- floor and ceiling both non-decreasing by hop, deepest ceiling
// >= 2x the entry's -- so a spec built from this module passes that check
// by construction rather than by luck.
//
// A branch/spur room (Task 3's skeletons mark these) must use its
// ATTACHMENT point's hopFraction, not its own slightly-larger one -- the
// generator is responsible for that substitution before calling this
// function; this module only implements the curve.
function deriveLevelBand(hopFraction, tierClamp) {
  const [floor, ceiling] = tierClamp;
  const span = ceiling - floor;
  const width = Math.max(2, Math.round(span * 0.35));
  const center = floor + hopFraction * span;
  const min = Math.max(floor, Math.round(center - width / 2));
  const max = Math.min(ceiling, Math.max(min + 1, Math.round(center + width / 2)));
  return [min, max];
}

// 'dead' is deliberately excluded -- this is real content, not an empty
// room. 5 usable tiers stepped evenly across the full hop range.
const DENSITY_ORDER = ['sparse', 'normal', 'dense', 'horde', 'swarm'];
function deriveDensity(hopFraction) {
  const idx = Math.min(DENSITY_ORDER.length - 1, Math.floor(hopFraction * DENSITY_ORDER.length));
  return DENSITY_ORDER[idx];
}

module.exports = { deriveLevelBand, deriveDensity, DENSITY_ORDER };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/p5_escalation.test.js`
Expected: PASS, 5/5

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/dungeon/escalation.js backend/tests/p5_escalation.test.js
git commit -m "feat(dungeons): P5 hop-distance escalation math (SOMET-251)"
```

---

### Task 3: Reusable topology skeletons (spine / hub / loop)

**Files:**
- Create: `backend/scripts/dungeon/skeletons.js`
- Test: `backend/tests/p5_skeletons.test.js`

**Interfaces:**
- Produces: `SKELETONS` — an object `{ spine, hub, loop }`, each `{ rooms: [{ role, key, grid: [x,y] }], links: [{ from, edge, to }], entryRoleKey, exitRoleKey }`. Consumed by Task 4 (generator), which relabels `key` per dungeon and offsets `grid` by that dungeon's origin.
- Consumes: nothing.

**Why these exact shapes:** each skeleton is a literal re-shape of one of the 3 already-shipped, already-`map_spec_fixtures`-validated example specs (`spine-descent`, `hub-vale`, `loop-catacombs`) — same relative grid deltas, same link structure, just renamed to generic role keys. This is what makes "valid grid embedding" and "valid topology shape" safe by construction instead of new topology math this plan would otherwise have to get right from scratch.

- [ ] **Step 1: Write the failing test**

```javascript
// backend/tests/p5_skeletons.test.js
const test = require('node:test');
const assert = require('node:assert');
const { SKELETONS } = require('../scripts/dungeon/skeletons');

const EDGE_DELTA = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };

function assertValidEmbedding(skeleton, name) {
  const byKey = new Map(skeleton.rooms.map((r) => [r.key, r]));
  for (const l of skeleton.links) {
    const from = byKey.get(l.from), to = byKey.get(l.to);
    assert.ok(from, `${name}: link references unknown room "${l.from}"`);
    assert.ok(to, `${name}: link references unknown room "${l.to}"`);
    const [dx, dy] = EDGE_DELTA[l.edge];
    assert.deepEqual(to.grid, [from.grid[0] + dx, from.grid[1] + dy],
      `${name}: link ${l.from}-${l.edge}->${l.to} does not match EDGE_DELTA`);
  }
  // no two rooms share a grid cell
  const seen = new Set();
  for (const r of skeleton.rooms) {
    const cell = r.grid.join(',');
    assert.ok(!seen.has(cell), `${name}: two rooms share grid cell ${cell}`);
    seen.add(cell);
  }
  // exactly one room per compass edge per source (UNIQUE(from_world_id, edge))
  const usedEdges = new Set();
  for (const l of skeleton.links) {
    const slot = `${l.from}:${l.edge}`;
    assert.ok(!usedEdges.has(slot), `${name}: room "${l.from}" has two links on edge ${l.edge}`);
    usedEdges.add(slot);
  }
}

test('all three skeletons are valid grid embeddings with no duplicate cells or edges', () => {
  for (const name of ['spine', 'hub', 'loop']) {
    assertValidEmbedding(SKELETONS[name], name);
  }
});

test('every skeleton names a real entry room and a real exit room', () => {
  for (const name of ['spine', 'hub', 'loop']) {
    const s = SKELETONS[name];
    const keys = new Set(s.rooms.map((r) => r.key));
    assert.ok(keys.has(s.entryRoleKey), `${name}: entryRoleKey "${s.entryRoleKey}" is not a real room`);
    assert.ok(keys.has(s.exitRoleKey), `${name}: exitRoleKey "${s.exitRoleKey}" is not a real room`);
  }
});

test('hub skeleton has a hub with at most 4 compass links (UNIQUE from_world_id,edge)', () => {
  const s = SKELETONS.hub;
  const hubOutLinks = s.links.filter((l) => l.from === s.entryRoleKey).length;
  assert.ok(hubOutLinks <= 4);
});

test('loop skeleton contains an actual cycle in its undirected link graph', () => {
  const s = SKELETONS.loop;
  const adjacency = new Map(s.rooms.map((r) => [r.key, []]));
  for (const l of s.links) {
    adjacency.get(l.from).push(l.to);
    adjacency.get(l.to).push(l.from);
  }
  // DFS cycle detection
  const visited = new Set();
  function hasCycle(node, parent) {
    visited.add(node);
    for (const next of adjacency.get(node)) {
      if (!visited.has(next)) { if (hasCycle(next, node)) return true; }
      else if (next !== parent) return true;
    }
    return false;
  }
  assert.ok(hasCycle(s.entryRoleKey, null), 'loop skeleton has no cycle');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/p5_skeletons.test.js`
Expected: FAIL with "Cannot find module '../scripts/dungeon/skeletons'"

- [ ] **Step 3: Write the implementation**

```javascript
// backend/scripts/dungeon/skeletons.js
//
// Three reusable dungeon room-graph shapes for P5 (SOMET-251), each a
// literal re-shape of one of the 3 already-shipped example specs in
// backend/seeds/maps/ -- same grid deltas and link structure, generic role
// keys instead of flavor names. See
// docs/superpowers/specs/2026-08-08-p5-map-content-design.md's "The
// 8-dungeon chain" section for why reuse (not new topology math) is the
// design.
//
// Every skeleton's rooms/links stay in LOCAL coordinates (skeleton's own
// grid origin at [0,0]) -- the generator (Task 4) relabels `key` per
// dungeon instance and offsets `grid` by that dungeon's grid origin.

// Re-shape of spine-descent.map.json (8 rooms): a linear critical path
// with two opt-in dead-end branches off it.
const SPINE = {
  rooms: [
    { role: 'entry', key: 'entry', grid: [0, 0] },
    { role: 'critical', key: 'pass', grid: [1, 0] },
    { role: 'branch', key: 'cache', grid: [1, -1] },
    { role: 'branch', key: 'elite', grid: [1, 1] },
    { role: 'critical', key: 'gorge', grid: [2, 0] },
    { role: 'branch', key: 'shrine', grid: [2, 1] },
    { role: 'critical', key: 'deep', grid: [3, 0] },
    { role: 'exit', key: 'end', grid: [4, 0] },
  ],
  links: [
    { from: 'entry', edge: 'E', to: 'pass' },
    { from: 'pass', edge: 'N', to: 'cache' },
    { from: 'pass', edge: 'S', to: 'elite' },
    { from: 'pass', edge: 'E', to: 'gorge' },
    { from: 'gorge', edge: 'S', to: 'shrine' },
    { from: 'gorge', edge: 'E', to: 'deep' },
    { from: 'deep', edge: 'E', to: 'end' },
  ],
  entryRoleKey: 'entry',
  exitRoleKey: 'end',
  // branch room key -> the critical-path room it attaches to, for the
  // generator's "branch inherits its attachment point's hop-distance
  // band/density" rule.
  branchAttachment: { cache: 'pass', elite: 'pass', shrine: 'gorge' },
};

// Re-shape of hub-vale.map.json (5 rooms) plus one extra sub-branch off
// the east spoke, to bring it to 6 rooms.
const HUB = {
  rooms: [
    { role: 'entry', key: 'hub', grid: [0, 0] },
    { role: 'spoke', key: 'spokeN', grid: [0, -1] },
    { role: 'spoke', key: 'spokeE', grid: [1, 0] },
    { role: 'spoke', key: 'spokeS', grid: [0, 1] },
    { role: 'spoke', key: 'spokeW', grid: [-1, 0] },
    { role: 'exit', key: 'subBranch', grid: [1, -1] },
  ],
  links: [
    { from: 'hub', edge: 'N', to: 'spokeN' },
    { from: 'hub', edge: 'E', to: 'spokeE' },
    { from: 'hub', edge: 'S', to: 'spokeS' },
    { from: 'hub', edge: 'W', to: 'spokeW' },
    { from: 'spokeE', edge: 'N', to: 'subBranch' },
  ],
  entryRoleKey: 'hub',
  exitRoleKey: 'subBranch',
  branchAttachment: { spokeN: 'hub', spokeE: 'hub', spokeS: 'hub', spokeW: 'hub', subBranch: 'spokeE' },
  // Hub topology needs a village in the hub (map-planner rule) -- the
  // generator attaches a `village` block to whichever room has role 'entry'
  // in a hub skeleton.
  needsVillageAtEntry: true,
};

// Re-shape of loop-catacombs.map.json (7 rooms): a 6-room cycle that
// closes back on the entry, plus one dead-end spur off the entry.
const LOOP = {
  rooms: [
    { role: 'entry', key: 'entry', grid: [0, 0] },
    { role: 'branch', key: 'spur', grid: [-1, 0] },
    { role: 'critical', key: 'eastwing', grid: [1, 0] },
    { role: 'critical', key: 'farhall', grid: [2, 0] },
    { role: 'exit', key: 'heart', grid: [2, 1] },
    { role: 'critical', key: 'deepvault', grid: [1, 1] },
    { role: 'critical', key: 'southwing', grid: [0, 1] },
  ],
  links: [
    { from: 'entry', edge: 'E', to: 'eastwing' },
    { from: 'entry', edge: 'W', to: 'spur' },
    { from: 'eastwing', edge: 'E', to: 'farhall' },
    { from: 'farhall', edge: 'S', to: 'heart' },
    { from: 'heart', edge: 'W', to: 'deepvault' },
    { from: 'deepvault', edge: 'W', to: 'southwing' },
    { from: 'southwing', edge: 'N', to: 'entry' },
  ],
  entryRoleKey: 'entry',
  exitRoleKey: 'heart',
  branchAttachment: { spur: 'entry' },
};

const SKELETONS = { spine: SPINE, hub: HUB, loop: LOOP };

module.exports = { SKELETONS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/p5_skeletons.test.js`
Expected: PASS, 4/4

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/dungeon/skeletons.js backend/tests/p5_skeletons.test.js
git commit -m "feat(dungeons): P5 reusable spine/hub/loop topology skeletons (SOMET-251)"
```

---

### Task 4: Main generator — assemble the full spec

**Files:**
- Create: `backend/scripts/dungeon/gen-p5-map-content.js`
- Test: `backend/tests/p5_gen_map_content.test.js`

**Interfaces:**
- Consumes: `DUNGEONS`, `SURFACE_BIOMES` (Task 1); `deriveLevelBand`, `deriveDensity` (Task 2); `SKELETONS` (Task 3).
- Produces: `generateSpec() -> { name, topology, worlds: [...], links: [...] }` — the full spec object, and a CLI entry point that writes it to `backend/seeds/maps/p5-descent.map.json`.

**Read first:** `backend/seeds/mapSpec.js` (the validator this must satisfy), `backend/seeds/maps/hub-vale.map.json` (a concrete example of every optional field's shape — `village`, `entry_spawn`, `biome_cell`).

- [ ] **Step 1: Write the failing test**

```javascript
// backend/tests/p5_gen_map_content.test.js
const test = require('node:test');
const assert = require('node:assert');
const { generateSpec } = require('../scripts/dungeon/gen-p5-map-content');

test('generates a spec with exactly one is_entry world', () => {
  const spec = generateSpec();
  const entries = spec.worlds.filter((w) => w.is_entry === true);
  assert.equal(entries.length, 1);
});

test('generates 8 dungeons worth of rooms plus 10 surface worlds, all with unique names and grid cells', () => {
  const spec = generateSpec();
  const names = new Set(spec.worlds.map((w) => w.name));
  assert.equal(names.size, spec.worlds.length, 'world names must be unique');
  const cells = new Set(spec.worlds.map((w) => w.grid.join(',')));
  assert.equal(cells.size, spec.worlds.length, 'grid cells must be unique');
  const surfaceWorlds = spec.worlds.filter((w) => w.key.startsWith('surface_'));
  assert.equal(surfaceWorlds.length, 10);
  assert.ok(spec.worlds.length - surfaceWorlds.length >= 40, 'expected roughly 48-53 dungeon rooms');
});

test('every new world grid.x is >= 20 (collision avoidance with the 3 existing specs)', () => {
  const spec = generateSpec();
  for (const w of spec.worlds) {
    assert.ok(w.grid[0] >= 20, `world "${w.name}" has grid.x ${w.grid[0]}, expected >= 20`);
  }
});

test('exactly 7 inter-dungeon portal links, each carrying a guard', () => {
  const spec = generateSpec();
  const portals = spec.links.filter((l) => l.kind === 'portal');
  assert.equal(portals.length, 7);
  for (const p of portals) {
    assert.ok(p.guard && typeof p.guard.creature_type === 'string' && p.guard.count >= 1);
    assert.ok(Number.isInteger(p.from_x) && Number.isInteger(p.from_y));
    assert.ok(Number.isInteger(p.to_x) && Number.isInteger(p.to_y));
  }
});

test('level_band floor and ceiling are both non-decreasing across the dungeon chain, by dungeon order', () => {
  const spec = generateSpec();
  const byKey = new Map(spec.worlds.map((w) => [w.key, w]));
  // Every dungeon's designated exit room must have a band floor/ceiling >=
  // the previous dungeon's exit room -- a coarse, cheap proxy for the real
  // BFS-hop check map_spec_fixtures.test.js performs on the assembled spec.
  const exitKeys = ['d1_end', 'd2_subBranch', 'd3_heart', 'd4_end', 'd5_subBranch', 'd6_heart', 'd7_end', 'd8_subBranch'];
  let prevMin = -Infinity, prevMax = -Infinity;
  for (const k of exitKeys) {
    const w = byKey.get(k);
    assert.ok(w, `expected exit room "${k}" to exist`);
    assert.ok(w.level_band[0] >= prevMin);
    assert.ok(w.level_band[1] >= prevMax);
    prevMin = w.level_band[0]; prevMax = w.level_band[1];
  }
});

test('every world declares a level_band and a density', () => {
  const spec = generateSpec();
  for (const w of spec.worlds) {
    assert.ok(Array.isArray(w.level_band) && w.level_band.length === 2, `${w.name} missing level_band`);
    assert.equal(typeof w.density, 'string', `${w.name} missing density`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/p5_gen_map_content.test.js`
Expected: FAIL with "Cannot find module '../scripts/dungeon/gen-p5-map-content'"

- [ ] **Step 3: Write the implementation**

```javascript
// backend/scripts/dungeon/gen-p5-map-content.js
//
// Generates backend/seeds/maps/p5-descent.map.json: 8 chained dungeons
// (Task 1's DUNGEONS, Task 3's SKELETONS) escalating via Task 2's math,
// plus 10 standalone surface worlds. See
// docs/superpowers/specs/2026-08-08-p5-map-content-design.md.
const fs = require('fs');
const path = require('path');
const { DUNGEONS, SURFACE_BIOMES } = require('./content');
const { deriveLevelBand, deriveDensity } = require('./escalation');
const { SKELETONS } = require('./skeletons');

const WORLD_SIZE = 64;      // matches the 3 shipped examples
const CHUNK_SIZE = 32;
const PORTAL_TILE_PX = 3250; // world-pixel center of a 64x64 world, 100px/tile -- same convention the shipped specs use for entry_spawn
const DUNGEON_GRID_SPACING = 12; // cells between each dungeon's local grid origin -- wider than any skeleton's own bounding box (max 5x3)
const SURFACE_GRID_Y = 20;

// A "{Line} {Rung}" name, exactly gen-p4-bestiary.js's convention -- every
// one of the 288 P4 creatures is named this way.
function creatureName(line, rung) { return `${line} ${rung}`; }

function buildDungeon(dungeon, dungeonIndex, hopOffset) {
  const skeleton = SKELETONS[dungeon.topology];
  const originX = 20 + dungeonIndex * DUNGEON_GRID_SPACING;
  const originY = 0;
  const worlds = [];
  const links = [];
  const keyMap = new Map(); // skeleton-local key -> globally-unique key

  skeleton.rooms.forEach((room, i) => {
    const globalKey = `${dungeon.key}_${room.key}`;
    keyMap.set(room.key, globalKey);
    const hop = hopOffset + i; // coarse local hop index, refined by real BFS in the caller if needed
    const attachKey = skeleton.branchAttachment && skeleton.branchAttachment[room.key];
    const bandHop = attachKey ? hopOffset : hop; // branch rooms inherit their attachment's depth
    const lineIdx = i % dungeon.lines.length;
    const { line, biome } = dungeon.lines[lineIdx];
    const secondBiome = dungeon.lines.length > 1 ? dungeon.lines[(lineIdx + 1) % dungeon.lines.length].biome : null;

    const world = {
      key: globalKey,
      name: `${dungeon.name}: ${room.key[0].toUpperCase()}${room.key.slice(1)}`,
      grid: [originX + room.grid[0], originY + room.grid[1]],
      seed: 5000 + dungeonIndex * 100 + i,
      width: WORLD_SIZE, height: WORLD_SIZE, chunk_size: CHUNK_SIZE,
      biomes: secondBiome && secondBiome !== biome ? [biome, secondBiome] : [biome],
      biome_cell: 16,
      allowed_creature_types: [creatureName(line, 'Swarm'), creatureName(line, 'Skirmisher'), creatureName(line, 'Line')],
      is_entry: false,
    };
    // placeholder, corrected below once we know the real hop fraction range
    world.__bandHop = bandHop;
    world.__globalHop = hop;
    if (skeleton.needsVillageAtEntry && room.role === 'entry') {
      world.village = { min_row: 28, min_col: 28, width: 6, height: 5, gate_edge: 'S', spawn_x: PORTAL_TILE_PX, spawn_y: PORTAL_TILE_PX };
    }
    worlds.push(world);
  });

  for (const l of skeleton.links) {
    links.push({ from: keyMap.get(l.from), edge: l.edge, to: keyMap.get(l.to) });
  }

  return { worlds, links, entryKey: keyMap.get(skeleton.entryRoleKey), exitKey: keyMap.get(skeleton.exitRoleKey), roomCount: skeleton.rooms.length };
}

function buildSurfaceWorlds() {
  const worlds = [];
  SURFACE_BIOMES.forEach((s, i) => {
    for (let variant = 0; variant < 2; variant++) {
      const key = `surface_${s.biome.toLowerCase().replace(/\s+/g, '_')}_${variant}`;
      worlds.push({
        key,
        name: `${s.biome} ${variant === 0 ? 'Reach' : 'Frontier'}`,
        grid: [20 + variant, SURFACE_GRID_Y + i],
        seed: 6000 + i * 10 + variant,
        width: WORLD_SIZE, height: WORLD_SIZE, chunk_size: CHUNK_SIZE,
        biomes: [s.biome],
        biome_cell: 16,
        allowed_creature_types: [creatureName(s.line, 'Swarm'), creatureName(s.line, 'Skirmisher'), creatureName(s.line, 'Line')],
        is_entry: false,
        level_band: variant === 0 ? [1, 8] : [4, 12],
        density: variant === 0 ? 'sparse' : 'normal',
      });
    }
  });
  return worlds;
}

function generateSpec() {
  const allWorlds = [];
  const allLinks = [];
  const portalLinks = [];
  let hopCursor = 0;
  let prevExit = null;

  DUNGEONS.forEach((dungeon, i) => {
    const built = buildDungeon(dungeon, i, hopCursor);
    allWorlds.push(...built.worlds);
    allLinks.push(...built.links);
    if (prevExit) {
      portalLinks.push({
        kind: 'portal',
        from: prevExit, from_x: PORTAL_TILE_PX, from_y: PORTAL_TILE_PX,
        to: built.entryKey, to_x: PORTAL_TILE_PX, to_y: PORTAL_TILE_PX,
        guard: { creature_type: dungeon.guardCreature, count: 1 },
      });
    } else {
      // D1's entry is the spec's sole is_entry -- no separate surface
      // gateway world needed; is_entry alone is what makes new characters
      // spawn here (see the design doc's "is_entry handling" section).
      const entryWorld = allWorlds.find((w) => w.key === built.entryKey);
      entryWorld.is_entry = true;
      entryWorld.entry_spawn = { x: PORTAL_TILE_PX, y: PORTAL_TILE_PX };
    }
    prevExit = built.exitKey;
    hopCursor += built.roomCount;
  });

  const maxHop = Math.max(...allWorlds.map((w) => w.__bandHop));
  for (const w of allWorlds) {
    const dungeon = DUNGEONS.find((d) => w.key.startsWith(`${d.key}_`));
    const hopFraction = maxHop === 0 ? 0 : w.__bandHop / maxHop;
    w.level_band = deriveLevelBand(hopFraction, dungeon.tierClamp);
    w.density = deriveDensity(w.__globalHop / maxHop);
    delete w.__bandHop; delete w.__globalHop;
  }

  const surfaceWorlds = buildSurfaceWorlds();

  return {
    name: 'p5-descent',
    topology: 'chained-dungeons-plus-surface',
    worlds: [...allWorlds, ...surfaceWorlds],
    links: [...allLinks, ...portalLinks],
  };
}

function writeOutput() {
  const spec = generateSpec();
  const outPath = path.join(__dirname, '../../seeds/maps/p5-descent.map.json');
  fs.writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n');
  console.log(`Wrote ${spec.worlds.length} worlds, ${spec.links.length} links to ${outPath}`);
}

module.exports = { generateSpec };
if (require.main === module) writeOutput();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/p5_gen_map_content.test.js`
Expected: PASS, 6/6. If the exit-key test fails because a skeleton's actual room key differs from the hardcoded `exitKeys` list in the test, fix the test's list to match `skeletons.js`'s real `exitRoleKey` values, not the generator — the test's list was written by hand against the skeleton definitions above and may have a typo.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/dungeon/gen-p5-map-content.js backend/tests/p5_gen_map_content.test.js
git commit -m "feat(dungeons): P5 main generator — assemble the full spec (SOMET-251)"
```

---

### Task 5: Generate the spec file and pass the existing validator

**Files:**
- Generate: `backend/seeds/maps/p5-descent.map.json` (run the Task 4 script, do not hand-edit)
- No new test file — the gate is the existing `backend/tests/map_spec_fixtures.test.js`.

**Interfaces:**
- Consumes: `generateSpec()` (Task 4).
- Produces: the committed spec file every later task and the live seed step (Task 6) depend on.

- [ ] **Step 1: Generate the spec file**

Run: `cd backend && node scripts/dungeon/gen-p5-map-content.js`
Expected output: `Wrote NN worlds, MM links to .../backend/seeds/maps/p5-descent.map.json` (NN in the ~58-63 range per Task 4's test, MM = compass links + 7 portal links).

- [ ] **Step 2: Run the existing validator against every spec, including the new one**

Run: `cd backend && node --test tests/map_spec_fixtures.test.js`
Expected: PASS, all 5 subtests, for all 4 specs now in `backend/seeds/maps/` (3 existing + `p5-descent`).

- [ ] **Step 3: If it fails, fix the generator (Task 4's file), not the generated JSON**

The generated file is build output, never hand-edited (same convention P4's `bestiaryP4.js` and the file's own header comment establish). Read the specific validator error from `mapSpec.js` (grep the error message text in that file to find the exact rule), adjust `gen-p5-map-content.js`, re-run Step 1, re-run Step 2. Repeat until green. Common likely failures and their fix location:
- "world already has a link on edge X" → two skeleton instances' relabeling collided; check `buildDungeon`'s `keyMap` is applied consistently to both `from` and `to` in every link.
- "must embed in a 2D integer grid" / grid mismatch → a skeleton's `grid` deltas don't match its `links`' edges; re-run `p5_skeletons.test.js` (Task 3) in isolation first, since that test catches exactly this.
- escalation ordering failure → `hopCursor`/`__bandHop` bookkeeping in `generateSpec()` is off; add a temporary `console.log` of each world's `key`, `__globalHop`/`level_band` before the `delete` lines to see the actual sequence.

- [ ] **Step 4: Commit the generated spec file**

```bash
git add backend/seeds/maps/p5-descent.map.json
git commit -m "feat(dungeons): generate p5-descent.map.json — 8-dungeon chain + 10 surface worlds (SOMET-251)"
```

---

### Task 6: `is_entry` restoration script

**Files:**
- Create: `backend/scripts/dungeon/restore-entry.js`
- Test: `backend/tests/p5_restore_entry.test.js`

**Interfaces:**
- Consumes: a Postgres pool/client and a world name (CLI arg).
- Produces: a CLI script run once, manually, immediately after Task 7's live seed step.

- [ ] **Step 1: Write the failing test**

```javascript
// backend/tests/p5_restore_entry.test.js
const test = require('node:test');
const assert = require('node:assert');
const { restoreEntry } = require('../scripts/dungeon/restore-entry');

test('restoreEntry clears is_entry everywhere then sets it on the named world', async () => {
  const calls = [];
  const fakePool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rowCount: 1 };
    },
  };
  await restoreEntry(fakePool, 'Old Trailhead');
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /UPDATE worlds SET is_entry = false WHERE is_entry = true/);
  assert.match(calls[1].sql, /UPDATE worlds SET is_entry = true WHERE name = \$1/);
  assert.deepEqual(calls[1].params, ['Old Trailhead']);
});

test('restoreEntry throws if the named world does not exist (rowCount 0)', async () => {
  const fakePool = { query: async (sql) => (/is_entry = true WHERE name/.test(sql) ? { rowCount: 0 } : { rowCount: 1 }) };
  await assert.rejects(() => restoreEntry(fakePool, 'Nonexistent World'), /not found/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/p5_restore_entry.test.js`
Expected: FAIL with "Cannot find module '../scripts/dungeon/restore-entry'"

- [ ] **Step 3: Write the implementation**

```javascript
// backend/scripts/dungeon/restore-entry.js
//
// seed-map.js's applyMapSpec clears is_entry globally and sets it on the
// spec's own declared entry world (mapSpec.js requires exactly one per
// spec). Applying p5-descent.map.json will move the game's spawn point
// onto brand-new, art-pending content unless corrected -- this script
// restores whichever world was is_entry before that apply. See
// docs/superpowers/specs/2026-08-08-p5-map-content-design.md's "is_entry
// handling" section.
//
// Usage: node scripts/dungeon/restore-entry.js "<world name>"
// The caller must capture the previous entry's name BEFORE running
// `make seed-map SPEC=p5-descent` -- seed-map clears it, so it cannot be
// read back afterward.
async function restoreEntry(pool, worldName) {
  await pool.query('UPDATE worlds SET is_entry = false WHERE is_entry = true');
  const result = await pool.query('UPDATE worlds SET is_entry = true WHERE name = $1', [worldName]);
  if (result.rowCount === 0) {
    throw new Error(`restore-entry: world "${worldName}" not found -- is_entry was cleared but not restored`);
  }
}

module.exports = { restoreEntry };

if (require.main === module) {
  const { Pool } = require('pg');
  const worldName = process.argv[2];
  if (!worldName) {
    console.error('Usage: node scripts/dungeon/restore-entry.js "<world name>"');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  restoreEntry(pool, worldName)
    .then(() => { console.log(`Restored is_entry to "${worldName}".`); return pool.end(); })
    .catch((err) => { console.error(err.message); pool.end(); process.exit(1); });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/p5_restore_entry.test.js`
Expected: PASS, 2/2

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/dungeon/restore-entry.js backend/tests/p5_restore_entry.test.js
git commit -m "feat(dungeons): is_entry restoration script for the P5 live seed step (SOMET-251)"
```

---

### Task 7: Human-gated live seed + World Map verification

**This task requires explicit user go-ahead before Step 1 — it writes to the shared dev database.** Do not run any step in this task without that confirmation, per this project's standing rule against unscoped shared-dev-DB mutation. `make seed-map` is additive (never deletes existing worlds), which is why this is lower-risk than a destructive operation, but it is still a live-DB write and must be confirmed first.

**Files:** none created — this is a procedure, not code.

- [ ] **Step 1: Capture the current entry world's name, before seeding**

Run: `cd backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db node -e "const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});p.query(\"SELECT name FROM worlds WHERE is_entry=true\").then(r=>{console.log(r.rows[0].name);return p.end();})"`
Write down the printed name — it is the argument to Task 6's script in Step 3 below.

- [ ] **Step 2: Apply the spec**

Run: `cd backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db make seed-map SPEC=p5-descent`
Expected: a success line reporting worlds/links/portal guards/creatures written, no error. If it fails with a navigability error (the class of bug found live in `seed_map_db.test.js` against the pre-existing `hub-vale` spec's "mire" world during SOMET-254), this is a real, correct rejection — `applyMapSpec` runs in one transaction, so a failed apply writes nothing. Go back to Task 4/5, adjust the affected room's `biomes`/`biome_cell`/`seed` (a different seed is often the simplest fix for an unlucky terrain roll), regenerate, and retry Task 5's validator before attempting the live apply again.

- [ ] **Step 3: Restore the original entry world**

Run: `cd backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db node scripts/dungeon/restore-entry.js "<name captured in Step 1>"`
Expected: `Restored is_entry to "<name>".`

- [ ] **Step 4: Browser-verify the World Map tab at the new scale**

Open the app, navigate to the World Map / graph tab, and visually confirm the ~78 total worlds render without pathological node overlap (some overlap with the 3 pre-existing example specs is expected and pre-existing — see the design doc's "pre-existing problem" section — but the new P5 content itself should not add fresh overlaps, since its grid starts at `x >= 20`, well clear of the existing `x: [-1,4]` cluster). Take a screenshot. If the graph is illegible at this scale, this is a separate, out-of-scope defect per the design doc's own framing — note it for a follow-up ticket, it does not block this task.

- [ ] **Step 5: Run the full backend suite once, to confirm nothing broke**

Run: `cd backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db npm test`
Expected: same pass count as before this task, plus/minus the one known pre-existing `progression_migration.test.js` failure. Any new failure is this task's concern.

---

## Self-Review Notes (for whoever executes this plan)

- **Spec coverage:** every acceptance criterion in the design doc maps to a task — generated (not hand-typed) spec passing the validator (Tasks 1-5), 8 dungeons chained via guarded PORTAL (Task 4/1), 10 surface worlds (Task 4), monotonic escalation (Task 2/4), zero grid collision (Task 4, `x >= 20`), `is_entry` restored (Task 6/7), live-seeded and World Map verified (Task 7), no new migration (true throughout — no task touches `backend/migrations/`).
- **Known soft spot:** Task 4's per-room hop bookkeeping (`__bandHop`/`__globalHop`) is a coarse index-based approximation of true BFS hop-distance, not a full graph BFS. It is verified against `map_spec_fixtures.test.js`'s real BFS-based escalation check at Task 5 — if the approximation and the real BFS disagree enough to fail that check, Task 5's Step 3 is where that gets fixed (likely by making `generateSpec()` run a real BFS over the assembled `links` array instead of the linear `hopCursor` counter, using the same algorithm `map_spec_fixtures.test.js` itself uses as a reference).
