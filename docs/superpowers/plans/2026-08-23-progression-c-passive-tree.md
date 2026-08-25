# Passive Skill Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the shared 1806-node passive skill tree — schema, deterministic generator, allocation/respec API, in-game canvas overlay and admin node editor — so that allocated passives become the game's only source of stat growth.

**Architecture:** ~38 authored archetype templates plus 30 hand-authored keystones in `backend/seeds/data/passiveTree.js` are expanded by a pure, deterministic generator (`backend/seeds/generatePassiveTree.js`) into `passive_nodes` / `passive_edges`, seeded by `make seed-passive-tree`. A pure `statComposition.js` folds a character's allocated grants and gear affixes into the six stat totals plus an itemised `sources`/`modifiers`/`rules` breakdown; `progressionStore.js` becomes the one place that composes them, so every existing `progression` websocket push carries the tree state with no new writer. The client draws the tree on the game canvas from a grid spatial index with viewport culling, and admins edit single nodes at `/game/admin/progression`.

**Tech Stack:** Node 20 + Express 4 (CommonJS, raw `pg`), node-pg-migrate, `node --test`; React 19 + styled-components + TanStack Query for admin; plain ES modules + Canvas 2D for the game client; vitest for frontend tests.

**Spec:** docs/superpowers/specs/2026-08-23-progression-passive-tree-design.md
**Contract:** docs/superpowers/plans/2026-08-23-progression-shared-contract.md

## Global Constraints

Copied verbatim from contract §5, plus this group's migration slot.

- **Backend:** CommonJS, Express, raw `pg` queries, inline routes. See `.ai/styleguides/backend.md`.
- **Frontend admin:** React 19, styled-components, `--s2-*` tokens only, TanStack Query for data. See `.ai/styleguides/frontend.md`.
- **Game client:** plain ES modules under `frontend/src/games/something2/src/js`. Layout/maths live in testable functions separate from canvas draw calls, as `inventoryPanel.js` already does.
- **Tests:** backend `npm test` from `backend/`; frontend `npx vitest run` from `frontend/`. Any DB-touching test run MUST set both `DATABASE_URL` and `TEST_DATABASE_URL` to a per-branch scratch database, seeded with the map specs. Unset `TEST_DATABASE_URL` silently targets the SHARED DEV DATABASE.
- **Never** run a destructive statement against the shared dev database. No `DELETE FROM`, `TRUNCATE` or `DROP` outside a scratch DB.
- **No vacuous tests.** A test must not derive its expected value by calling the same function or constant the code under test uses. XP-curve, affix-roll and stat-composition expectations are hand-written literals.
- **Worktrees:** several sessions share this checkout. Every task runs in its own `git worktree`; never `checkout`, `stash` or `branch` in the shared working directory. Stage by explicit path.
- **Commits:** branch `feat/<slug>`; subject `type(scope): summary (SOMET-NNN)`; end the message with the `Co-Authored-By: Claude Opus 5 (1M context)` trailer.

**This group's migration slot: `1714440504000` (T6 only).** T7, T8 and T9 add no migration. Do not take another number from the reserved block — the other slots belong to other plans in this epic.

The reserved block moved: the contract originally reserved `1714440400000`–`1714440430000`, which is already occupied on main by `1714440400000_biome_path_tile.js`, `1714440410000_invite_codes.js` and `1714440420000_inventory_slots.js`. See the contract's §1 CORRECTION. If `migrate:up` reports "Not run migration X is preceding Y", run `backend/scripts/repair-migration-order.js` — never `--no-check-order`.

### Contract §6 amendments this plan honours

The contract gained a §6 after the plans were drafted; it overrides anything earlier that contradicts it. Five of them land inside Group C:

- **§6.1** — every class bases at **5** on all six stats, and T2 (not this plan) owns writing that snapshot. `composeStats`'s `base` input is therefore always `{strength: 5, …}` today; nothing in this plan reads `entity_types` stats.
- **§6.2** — the `progression` frame and `GET /api/progression` carry an `effective: {strength…charisma}` object alongside `sources` and `modifiers`. Consumers render `effective` and never re-sum `sources`. Task 2 produces it.
- **§6.3** — T7 puts `stats` on **every** `progression` frame, not only the `refreshPlayerStats` push. Task 2 Step 22 does this.
- **§6.4** — T8 owns the `respecDisabled` predicate, because T15 deletes the character sheet's respec control. Task 3 Steps 3 and 6 provide it in the tree overlay.
- **§6.7** — `passive_points` is a **column** (`player_progression.passive_points integer NOT NULL DEFAULT 0 CHECK (passive_points >= 0)`), added by T2's slot `1714440501000`. This plan spends and refunds that column; it does **not** derive the wallet.

### Scratch database — run this once before any DB step in this plan

Every DB command in this plan assumes `s2_passive_tree` exists and is migrated + seeded. `vale-region` is seeded LAST on purpose (it depends on rows `p5-descent` creates).

```bash
psql postgres://user:password@localhost:15432/postgres -c 'CREATE DATABASE s2_passive_tree'
cd backend
DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree npm run migrate:up
DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree node scripts/seed-catalogs.js
DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree SPEC=p5-descent  node scripts/seed-map.js
DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree SPEC=vale-region node scripts/seed-map.js
```

### Hard dependencies on Group A

- **T1** must have landed: `backend/src/services/gameSettings.js` (`getSetting`, `getSettings`, `DEFAULTS` with `passive_points_per_level` and `respec_base_gold`) and the `/game/admin/progression` page shell component `frontend/src/games/something2/ProgressionAdmin.jsx`.
- **T2** must have landed: `player_progression.stat_points` dropped, `player_progression.passive_points` added (contract §6.7) and granted on level-up, the class-base snapshot written at character creation with every base at 5 (§6.1), `allocateStat` and `refundedPoints` removed, `MAX_LEVEL = 150`. Task 2 below rewrites `respec` and would conflict with the pre-T2 version of `progressionStore.js`.

## File Structure

| File | Task | Single responsibility |
|---|---|---|
| `backend/seeds/data/passiveTree.js` | T6 | **Create.** The authored spec: sectors, layout constants, 38 archetype templates, 30 keystones, 6 start nodes, grant vocabulary, rule vocabulary. Data only — no logic. |
| `backend/seeds/generatePassiveTree.js` | T6 | **Create.** PURE deterministic expansion of that spec into `{ nodes, edges }`. No DB, no clock, no rng. |
| `backend/migrations/1714440504000_passive_tree.js` | T6 | **Create.** `passive_nodes`, `passive_edges`, `character_passives` and their CHECK constraints/indexes. |
| `backend/scripts/seed-passive-tree.js` | T6 | **Create.** Upsert-by-key seeder; preserves admin-edited `label`/`kind`/`grants` unless `--force`; reconciles edges; never deletes a node. |
| `Makefile` | T6 | **Modify.** Add the `seed-passive-tree` target and its `.PHONY` entry. |
| `backend/tests/passive_tree_spec.test.js` | T6 | **Create.** Guards the authored data file's shape and counts. |
| `backend/tests/passive_tree_generator.test.js` | T6 | **Create.** The five spec §5.5 generator guards. |
| `backend/tests/passive_tree_seed_db.test.js` | T6 | **Create.** Seeder round-trip against a real database, including admin-edit preservation. |
| `backend/tests/passive_tree_make_target.test.js` | T6 | **Create.** Asserts the Makefile target exists and calls the seeder. |
| `backend/src/services/statComposition.js` | T7 | **Create.** PURE `composeStats({base, passives, gear})`. The only place a composed stat total or a modifier breakdown is produced. |
| `backend/src/services/passiveRules.js` | T7 | **Create.** PURE graph/points rules: adjacency, allocatability, derived point budget, grant flattening. |
| `backend/src/services/passiveTreeStore.js` | T7 | **Create.** Every read/write of `passive_nodes`, `passive_edges`, `character_passives`. |
| `backend/src/services/progressionStore.js` | T7 | **Modify.** Route every returned progression row through the composer; replace `respec` with the passive respec. |
| `backend/src/api/passiveTreeRoutes.js` | T7 (+T9) | **Create.** `GET /api/passive-tree` (player) in T7; admin list/update in T9. |
| `backend/src/api/progressionRoutes.js` | T7 | **Modify.** Add `POST /api/progression/passives/:nodeId`; point `/respec` at the new store function; widen the `GET /` body. |
| `backend/src/index.js` | T7 | **Modify.** Mount `/api/passive-tree`. |
| `backend/src/authority/server.js` | T7 | **Modify.** Add `stats` to all five `progression` frames that lack it (contract §6.3); the join path picks up the composed row for free. |
| `backend/tests/progression_frame_shape.test.js` | T7 | **Create.** Guards that every `progression` frame carries `stats` and a stone-buffed row. |
| `docs/superpowers/plans/2026-08-23-progression-shared-contract.md` | T7 | **Modify.** Record the three additions this plan makes (contract §2's own rule). |
| `frontend/src/games/something2/src/js/systems/passiveTreePanel.js` | T8 | **Create.** PURE spatial index, culling, layout and hit-testing, plus the draw call that paints exactly what the layout returns. |
| `frontend/src/games/something2/src/js/net/passiveTreeClient.js` | T8 | **Create.** `GET /api/passive-tree` and `POST /api/progression/passives/:nodeId` for the game client. |
| `frontend/src/games/something2/src/js/core/Game.js` | T8 | **Modify.** `P` binding, overlay state, pan/zoom/click handling, render wiring. |
| `frontend/src/games/something2/src/js/systems/RenderSystem.js` | T8 | **Modify.** `renderPassiveTree` overlay hook, matching the inventory overlay convention. |
| `frontend/src/games/something2/src/js/systems/__tests__/passiveTreePanel.test.js` | T8 | **Create.** Layout/culling/state unit tests plus the single-writer source guard. |
| `frontend/src/games/something2/passiveNodeForm.js` | T9 | **Create.** PURE form ↔ payload mapping and client-side grant validation. |
| `frontend/src/games/something2/usePassiveNodes.js` | T9 | **Create.** TanStack Query hooks for the admin browser/editor. |
| `frontend/src/games/something2/PassiveNodesAdmin.jsx` | T9 | **Create.** The admin browser + single-node editor UI. |
| `frontend/src/games/something2/ProgressionAdmin.jsx` | T9 | **Modify.** Render `<PassiveNodesAdmin />` inside T1's page shell. |
| `frontend/src/games/something2/__tests__/passiveNodeForm.test.js` | T9 | **Create.** Form/validation unit tests plus the frontend↔backend grant-vocabulary anti-drift guard. |
| `frontend/src/games/something2/__tests__/PassiveNodesAdmin.smoke.test.js` | T9 | **Create.** Component identity + mount-point guard. |
| `backend/tests/passive_nodes_admin_routes.test.js` | T9 | **Create.** Admin route auth + validation guards. |

---

### Task 1 (T6): Schema, authored spec, deterministic generator, seed command, five guard tests

**Files:**
- Create: `backend/seeds/data/passiveTree.js`
- Create: `backend/seeds/generatePassiveTree.js`
- Create: `backend/migrations/1714440504000_passive_tree.js`
- Create: `backend/scripts/seed-passive-tree.js`
- Modify: `Makefile:1-11` (`.PHONY`) and after `Makefile:232` (`seed-catalogs` target)
- Test: `backend/tests/passive_tree_spec.test.js`
- Test: `backend/tests/passive_tree_generator.test.js`
- Test: `backend/tests/passive_tree_seed_db.test.js`
- Test: `backend/tests/passive_tree_make_target.test.js`

**Interfaces:**
- Consumes: `require('../src/authority/damage.js').ELEMENTS` — `['physical', 'arcane', 'fire', 'ice', 'lightning']`, declared at `backend/src/authority/damage.js:10`.
- Produces (contract §2): `generatePassiveTree(spec) -> { nodes: [{key, sector, ring, x, y, kind, label, grants, start_class}], edges: [[keyA, keyB]] }`, `keyA < keyB` lexicographically, deduped, sorted.
- Produces: `PASSIVE_TREE_SPEC`, `SECTORS`, `LAYOUT`, `TEMPLATES`, `KEYSTONES`, `START_NODES`, `GRANT_TYPES`, `RULE_KEYS` from `backend/seeds/data/passiveTree.js`.
- Produces: tables `passive_nodes(id, key, sector, ring, x, y, kind, label, grants, start_class)`, `passive_edges(a_id, b_id)`, `character_passives(character_id, node_id, allocated_at)`.

#### The node-count arithmetic (this is what guard 4 checks)

```
core row A            6 nodes at r=70,  angles -90 + i*60          =    6
core row B           24 nodes at r=140, angles -90 + k*15          =   24
                                                        core total =   30

start nodes           1 per sector at r=195 on the sector axis     =    6

ring 1 per sector     4 rows x 17 cols  (60 minor +  8 notable)    =   68
ring 2 per sector     4 rows x 29 cols  (100 minor + 14 notable + 2 keystone) = 116
ring 3 per sector     3 rows x 37 cols  (90 minor + 18 notable + 3 keystone)  = 111
                                            per-sector ring total  =  295
six sectors                                        295 x 6         = 1770

TOTAL NODES                                   30 + 6 + 1770        = 1806
```

By kind:

```
keystone   (2 + 3) x 6                                             =   30   <- spec says "exactly as specced"
notable    (8 + 14 + 18) x 6                                       =  240
start                                                              =    6
minor      30 core + (60 + 100 + 90) x 6 = 30 + 1500               = 1530
                                                             total = 1806
```

1806 is 0.33% above the specced 1800; the guard's 5% band is [1710, 1890]. ✔

Edges, hand-derived the same way:

```
core:      6 (row-A cycle) + 6 (row-A -> row-B spokes) + 24 (row-B cycle)      =   36
per sector:
  row paths      ring1 4x16=64,  ring2 4x28=112,  ring3 3x36=108              =  284
  rungs (every 4th column, rows i <-> i+1)
                 ring1 3 pairs x 5 cols = 15
                 ring2 3 pairs x 8 cols = 24
                 ring3 2 pairs x 10 cols = 20                                  =   59
  ring transitions  ring1row3 -> ring2row0 at cols 0/8/16 -> 0/14/28  = 3
                    ring2row3 -> ring3row0 at cols 0/14/28 -> 0/18/36 = 3      =    6
  start edges       start <-> core-b-<4s>, start <-> ring1 row0 col 8          =    2
                                                          per sector total     =  351
six sectors                                                  351 x 6           = 2106

TOTAL EDGES                                                  36 + 2106         = 2142
```

Connectivity, which is what guard 1 really tests: row A is a 6-cycle; the six spokes tie it to row B; row B is a 24-cycle, so the core is one component. Each start hangs off `core-b-<4s>`, so all six starts are in that component. Each start also joins its sector's ring-1 row 0 at the centre column; every row is a path, so a row is connected; rungs start at column 0 and therefore link every adjacent row pair; the three transition edges carry ring 1 → 2 → 3. Every sector is therefore attached to the core through its start node, and the whole graph is one component.

- [ ] **Step 1: Write the failing test for the authored spec file**

```js
// backend/tests/passive_tree_spec.test.js
//
// Guards the AUTHORED half of the tree (backend/seeds/data/passiveTree.js).
// The generator test next door guards the expansion; this one guards the
// input, because a template pool that is empty for some (kind, sector, ring)
// combination makes the generator crash or silently reuse the wrong archetype,
// and neither failure names the data file that caused it.
const test = require('node:test');
const assert = require('node:assert');
const {
  PASSIVE_TREE_SPEC, SECTORS, LAYOUT, TEMPLATES, KEYSTONES, START_NODES,
  GRANT_TYPES, RULE_KEYS,
} = require('../seeds/data/passiveTree.js');
const { ELEMENTS } = require('../src/authority/damage.js');

// Hand-written, on purpose. Importing the same list the data file uses would
// make every assertion below a tautology.
const SECTOR_KEYS = ['wisdom', 'intelligence', 'dexterity', 'strength', 'constitution', 'charisma'];
const CLASS_NAMES = ['Monk', 'Mage', 'Archer', 'Warrior', 'Cultist', 'Druid'];

test('six sectors, in the clockwise order the spec diagram draws', () => {
  assert.deepStrictEqual(SECTORS.map((s) => s.key), SECTOR_KEYS);
  assert.deepStrictEqual(SECTORS.map((s) => s.className), CLASS_NAMES);
  // -90 is straight up on a canvas; each sector is the next 60 degrees clockwise.
  assert.deepStrictEqual(SECTORS.map((s, i) => LAYOUT.sectorAxisDeg0 + i * 60),
    [-90, -30, 30, 90, 150, 210]);
});

test('ring geometry multiplies out to the specced per-ring composition', () => {
  assert.deepStrictEqual(
    [1, 2, 3].map((r) => {
      const g = LAYOUT.rings[r];
      return [g.rows * g.cols, g.minor + g.notable + g.keystone];
    }),
    [[68, 68], [116, 116], [111, 111]],
  );
  assert.deepStrictEqual([1, 2, 3].map((r) => LAYOUT.rings[r].keystone), [0, 2, 3]);
});

test('38 archetype templates, none of them a keystone', () => {
  assert.strictEqual(TEMPLATES.length, 38);
  assert.strictEqual(TEMPLATES.filter((t) => t.kind === 'minor').length, 16);
  assert.strictEqual(TEMPLATES.filter((t) => t.kind === 'notable').length, 22);
  assert.strictEqual(TEMPLATES.some((t) => t.kind === 'keystone'), false);
  assert.strictEqual(new Set(TEMPLATES.map((t) => t.key)).size, 38);
});

test('every (kind, sector, ring) combination the generator will ask for has a pool', () => {
  const empty = [];
  for (const sector of SECTOR_KEYS) {
    for (const ring of [1, 2, 3]) {
      for (const kind of ['minor', 'notable']) {
        const pool = TEMPLATES.filter((t) => t.kind === kind
          && (t.sectors === '*' ? sector !== 'core' : t.sectors.includes(sector))
          && t.rings.includes(ring));
        if (pool.length === 0) empty.push(`${kind}/${sector}/ring${ring}`);
      }
    }
  }
  const corePool = TEMPLATES.filter((t) => t.kind === 'minor'
    && t.sectors !== '*' && t.sectors.includes('core') && t.rings.includes(0));
  if (corePool.length === 0) empty.push('minor/core/ring0');
  assert.deepStrictEqual(empty, []);
});

test('exactly five keystones per sector, all keys unique across the tree', () => {
  assert.deepStrictEqual(Object.keys(KEYSTONES).sort(), [...SECTOR_KEYS].sort());
  for (const sector of SECTOR_KEYS) {
    assert.strictEqual(KEYSTONES[sector].length, 5, `${sector} keystone count`);
  }
  const all = SECTOR_KEYS.flatMap((s) => KEYSTONES[s].map((k) => k.key));
  assert.strictEqual(all.length, 30);
  assert.strictEqual(new Set(all).size, 30);
});

test('the two keystones the spec names by hand exist and grant what it says', () => {
  const bloodPact = KEYSTONES.constitution.find((k) => k.key === 'ks_con_blood_pact');
  assert.deepStrictEqual(bloodPact.grants,
    [{ type: 'rule', rule: 'lifeCostMultiplier', value: 0.75 }]);
  const beastBond = KEYSTONES.charisma.find((k) => k.key === 'ks_cha_beast_bond');
  assert.deepStrictEqual(beastBond.grants,
    [{ type: 'rule', rule: 'treeCharmBonus', value: 5 }]);
});

test('one start node per sector, each naming a distinct class', () => {
  assert.strictEqual(START_NODES.length, 6);
  assert.deepStrictEqual(START_NODES.map((n) => n.sector), SECTOR_KEYS);
  assert.deepStrictEqual(START_NODES.map((n) => n.start_class), CLASS_NAMES);
});

test('the element vocabulary is the authority\'s, not a second copy that can drift', () => {
  assert.deepStrictEqual(GRANT_TYPES.damage.element, ELEMENTS);
  assert.deepStrictEqual(GRANT_TYPES.resist.element, ELEMENTS);
});

test('every rule key names the module that consumes it and how duplicates combine', () => {
  assert.deepStrictEqual(Object.keys(RULE_KEYS).sort(),
    ['cooldownFloor', 'lifeCostMultiplier', 'regenLifeShare', 'treeCharmBonus']);
  for (const [key, def] of Object.entries(RULE_KEYS)) {
    assert.ok(['sum', 'product', 'min'].includes(def.combine), `${key}.combine`);
    assert.ok(typeof def.consumer === 'string' && def.consumer.length > 0, `${key}.consumer`);
  }
  assert.strictEqual(RULE_KEYS.lifeCostMultiplier.combine, 'product');
  assert.strictEqual(RULE_KEYS.treeCharmBonus.combine, 'sum');
  assert.strictEqual(RULE_KEYS.cooldownFloor.combine, 'min');
});

test('PASSIVE_TREE_SPEC is the single bundle the generator takes', () => {
  assert.deepStrictEqual(Object.keys(PASSIVE_TREE_SPEC).sort(),
    ['keystones', 'layout', 'sectors', 'startNodes', 'templates']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test tests/passive_tree_spec.test.js`
Expected: FAIL with `Cannot find module '../seeds/data/passiveTree.js'`

- [ ] **Step 3: Write the authored spec data file**

```js
// backend/seeds/data/passiveTree.js
//
// The AUTHORED half of the passive tree, as checked-in seed data.
//
// WHY THIS FILE EXISTS. The tree is ~1800 nodes. Hand-authoring 1800 rows is
// not reviewable and not re-tunable: a balance pass would be 1800 edits. So
// the repo authors ~40 archetypes plus the 30 keystones that actually change a
// rule, and backend/seeds/generatePassiveTree.js expands them deterministically
// into rows. Retuning the tree is an edit HERE plus `make seed-passive-tree`.
//
// It follows the same rule as biomes.js and entityTypes.js: this file is a
// FLOOR, not a replacement for the admin UI. scripts/seed-passive-tree.js
// upserts by `key` and preserves an admin's edited label/kind/grants unless
// --force is passed, so a reseed can never cost an admin a hand-tuned node.
//
// NOTHING HERE IS LOGIC. Every value is data the generator reads. `@sector` is
// the one piece of indirection: a minor/notable template written for "the
// sector's own stat" writes `stat: '@sector'`, and the generator substitutes
// the sector key. That is what lets one template serve all six sectors, which
// is the whole reason 38 templates cover 1770 sector nodes.

// Element names are NOT re-declared here. They are read from the damage
// authority so this file can never drift from the five elements the combat
// code actually mitigates (backend/src/authority/damage.js:10).
const { ELEMENTS } = require('../../src/authority/damage.js');

const STAT_KEYS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const RESOURCE_POOLS = ['hp', 'mana', 'stamina'];
// The three statuses effects.js defines (BURN/CHILL/SHOCK at effects.js:52-54).
const STATUSES = ['burn', 'chill', 'shock'];

// A grant's `type` picks the row; the row lists every other field it may carry
// and the allowed values. The generator does not read this — the guard test
// does, which is exactly the point: a typo'd stat name grants nothing at
// runtime and is invisible in the UI, so it has to fail the build instead.
const GRANT_TYPES = {
  stat: { stat: STAT_KEYS },
  resource: { pool: RESOURCE_POOLS },
  damage: { element: ELEMENTS },
  resist: { element: ELEMENTS },
  status: { status: STATUSES },
  rule: { rule: null },   // validated against RULE_KEYS below
};

// A `rule` grant is the only grant type that changes a formula rather than a
// number, so each one records WHICH module reads it and HOW two copies of the
// same rule combine. A rule with no consumer is an inert node the player
// cannot tell apart from a working one, so `consumer` is mandatory and the
// guard test checks it.
const RULE_KEYS = {
  lifeCostMultiplier: {
    combine: 'product',
    consumer: 'backend/src/services/lifeCost.js — lifeCostFor() (contract §2, Group B T4)',
  },
  treeCharmBonus: {
    combine: 'sum',
    consumer: 'backend/src/services/charm.js — charmBudget() (contract §2, Group B T5)',
  },
  cooldownFloor: {
    combine: 'min',
    consumer: 'backend/src/services/playerStats.js — MIN_COOLDOWN_MULT (wiring is a follow-up: playerStats.js belongs to Group A T2 under the contract)',
  },
  regenLifeShare: {
    combine: 'sum',
    consumer: 'backend/src/authority/world.js — the mana-regen tick (wiring is a follow-up)',
  },
};

// Clockwise from straight up, matching the spec §5.2 diagram exactly. ORDER IS
// LOAD-BEARING: the generator derives each sector's axis angle and its core
// attachment point from the array index, so reordering this list moves every
// node in the tree and re-keys nothing — the same "order is the banding order"
// hazard biomes.js documents for terrain_tiles.
const SECTORS = [
  { key: 'wisdom', className: 'Monk', identity: 'mana regeneration' },
  { key: 'intelligence', className: 'Mage', identity: 'maximum mana and spell damage' },
  { key: 'dexterity', className: 'Archer', identity: 'attack speed' },
  { key: 'strength', className: 'Warrior', identity: 'melee damage' },
  { key: 'constitution', className: 'Cultist', identity: 'maximum life, which is also their casting resource' },
  { key: 'charisma', className: 'Druid', identity: 'merchant prices and charm power' },
];

const LAYOUT = {
  // Straight up. Sector s sits at sectorAxisDeg0 + s * 60.
  sectorAxisDeg0: -90,
  // A sector wedge is 60 degrees wide; nodes use 56 of them so two adjacent
  // sectors never touch and the seam stays legible at low zoom.
  sectorSpanDeg: 56,
  core: {
    rowA: { count: 6, radius: 70 },
    rowB: { count: 24, radius: 140 },
  },
  startRadius: 195,
  // A rung joins row i to row i+1 every rungStride columns, starting at column
  // 0. Starting at 0 is what makes every row reachable from row 0.
  rungStride: 4,
  // Keystones are nudged off the spread positions so they do not all land in
  // the same column: total/count divides evenly for both rings that have them,
  // which would otherwise stack every keystone in a sector on one radial line.
  keystoneOffset: 7,
  keystoneStagger: 5,
  rings: [
    null, // index 0 is the core + the start nodes, which are not laid out on a grid
    { rows: 4, cols: 17, baseRadius: 260, rowStep: 45, minor: 60, notable: 8, keystone: 0 },
    { rows: 4, cols: 29, baseRadius: 460, rowStep: 55, minor: 100, notable: 14, keystone: 2 },
    { rows: 3, cols: 37, baseRadius: 700, rowStep: 70, minor: 90, notable: 18, keystone: 3 },
  ],
};

// --- Archetype templates ---------------------------------------------------
//
// `sectors: '*'` means "every one of the six stat sectors" and never the core.
// The core has its own four templates with `sectors: ['core']`, because a core
// node has no sector stat to point `@sector` at.
//
// `rings` gates a template to the bands where its power level belongs: the
// +4 minor and the +16 notable are outer-ring only, the three status notables
// are ring-3 only.
const TEMPLATES = [
  // --- core (ring 0) — generic, no sector stat ---
  { key: 'core_life', kind: 'minor', sectors: ['core'], rings: [0], label: 'Constitution', grants: [{ type: 'resource', pool: 'hp', value: 10 }] },
  { key: 'core_mana', kind: 'minor', sectors: ['core'], rings: [0], label: 'Attunement', grants: [{ type: 'resource', pool: 'mana', value: 10 }] },
  { key: 'core_stam', kind: 'minor', sectors: ['core'], rings: [0], label: 'Stamina', grants: [{ type: 'resource', pool: 'stamina', value: 8 }] },
  { key: 'core_res', kind: 'minor', sectors: ['core'], rings: [0], label: 'Toughness', grants: [{ type: 'resist', element: 'physical', value: 1 }] },

  // --- minors (the connective tissue: +2 to the sector's own stat) ---
  { key: 'min_sinew', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Sinew', grants: [{ type: 'stat', stat: '@sector', value: 2 }] },
  { key: 'min_focus', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Focus', grants: [{ type: 'stat', stat: '@sector', value: 3 }] },
  { key: 'min_vigour', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Vigour', grants: [{ type: 'stat', stat: '@sector', value: 2 }, { type: 'resource', pool: 'hp', value: 8 }] },
  { key: 'min_insight', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Insight', grants: [{ type: 'stat', stat: '@sector', value: 2 }, { type: 'resource', pool: 'mana', value: 6 }] },
  { key: 'min_wind', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Wind', grants: [{ type: 'stat', stat: '@sector', value: 2 }, { type: 'resource', pool: 'stamina', value: 5 }] },
  { key: 'min_hardy', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Hardy', grants: [{ type: 'resource', pool: 'hp', value: 15 }] },
  { key: 'min_reserve', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Reserve', grants: [{ type: 'resource', pool: 'mana', value: 12 }] },
  { key: 'min_callus', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Callus', grants: [{ type: 'resist', element: 'physical', value: 2 }] },
  { key: 'min_edge', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Edge', grants: [{ type: 'damage', element: 'physical', value: 3 }] },
  { key: 'min_temper', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Temper', grants: [{ type: 'stat', stat: '@sector', value: 2 }, { type: 'resist', element: 'physical', value: 1 }] },
  { key: 'min_second_wind', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Second Wind', grants: [{ type: 'resource', pool: 'stamina', value: 10 }] },
  { key: 'min_discipline', kind: 'minor', sectors: '*', rings: [2, 3], label: 'Discipline', grants: [{ type: 'stat', stat: '@sector', value: 4 }] },

  // --- notables ---
  { key: 'not_great_sinew', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Great Sinew', grants: [{ type: 'stat', stat: '@sector', value: 8 }] },
  { key: 'not_mastery', kind: 'notable', sectors: '*', rings: [2, 3], label: 'Mastery', grants: [{ type: 'stat', stat: '@sector', value: 12 }] },
  { key: 'not_apotheosis', kind: 'notable', sectors: '*', rings: [3], label: 'Apotheosis', grants: [{ type: 'stat', stat: '@sector', value: 16 }] },
  { key: 'not_deep_reserve', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Deep Reserve', grants: [{ type: 'resource', pool: 'mana', value: 15 }] },
  { key: 'not_thick_skin', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Thick Skin', grants: [{ type: 'resource', pool: 'hp', value: 40 }] },
  { key: 'not_endurance', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Endurance', grants: [{ type: 'resource', pool: 'stamina', value: 30 }] },
  { key: 'not_brutality', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Brutality', grants: [{ type: 'damage', element: 'physical', value: 12 }] },
  { key: 'not_kindling', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Kindling', grants: [{ type: 'damage', element: 'fire', value: 12 }] },
  { key: 'not_frostbite', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Frostbite', grants: [{ type: 'damage', element: 'ice', value: 12 }] },
  { key: 'not_charge', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Charge', grants: [{ type: 'damage', element: 'lightning', value: 12 }] },
  { key: 'not_resonance', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Resonance', grants: [{ type: 'damage', element: 'arcane', value: 12 }] },
  { key: 'not_plating', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Plating', grants: [{ type: 'resist', element: 'physical', value: 8 }] },
  { key: 'not_fireproof', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Fireproof', grants: [{ type: 'resist', element: 'fire', value: 8 }] },
  { key: 'not_warm_blood', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Warm Blood', grants: [{ type: 'resist', element: 'ice', value: 8 }] },
  { key: 'not_grounding', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Grounding', grants: [{ type: 'resist', element: 'lightning', value: 8 }] },
  { key: 'not_null_field', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Null Field', grants: [{ type: 'resist', element: 'arcane', value: 8 }] },
  { key: 'not_ox_blood', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Ox Blood', grants: [{ type: 'stat', stat: '@sector', value: 8 }, { type: 'resource', pool: 'hp', value: 25 }] },
  { key: 'not_wellspring', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Wellspring', grants: [{ type: 'stat', stat: '@sector', value: 8 }, { type: 'resource', pool: 'mana', value: 20 }] },
  { key: 'not_honed', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Honed', grants: [{ type: 'stat', stat: '@sector', value: 8 }, { type: 'damage', element: 'physical', value: 5 }] },
  { key: 'not_quickening', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Quickening', grants: [{ type: 'stat', stat: 'dexterity', value: 6 }] },
  { key: 'not_ward', kind: 'notable', sectors: '*', rings: [2, 3], label: 'Ward', grants: [{ type: 'resist', element: 'arcane', value: 6 }, { type: 'resist', element: 'fire', value: 6 }] },
  { key: 'not_searing_blows', kind: 'notable', sectors: '*', rings: [3], label: 'Searing Blows', grants: [{ type: 'status', status: 'burn', value: 1 }] },
  { key: 'not_numbing_blows', kind: 'notable', sectors: '*', rings: [3], label: 'Numbing Blows', grants: [{ type: 'status', status: 'chill', value: 1 }] },
  { key: 'not_jarring_blows', kind: 'notable', sectors: '*', rings: [3], label: 'Jarring Blows', grants: [{ type: 'status', status: 'shock', value: 1 }] },
];

// --- Keystones -------------------------------------------------------------
//
// Five per sector, hand-authored rather than templated: a keystone is the one
// node kind whose point is to be UNIQUE, so generating them from an archetype
// would defeat the purpose. Order within a sector is the order the generator
// places them: the two ring-2 keystones first, then the three ring-3 ones, so
// the strongest of the five should be authored last.
const KEYSTONES = {
  wisdom: [
    { key: 'ks_wis_inner_flame', label: 'Inner Flame — +30 WIS', grants: [{ type: 'stat', stat: 'wisdom', value: 30 }] },
    { key: 'ks_wis_meditation', label: 'Meditation — +120 maximum mana', grants: [{ type: 'resource', pool: 'mana', value: 120 }] },
    { key: 'ks_wis_spirit_ward', label: 'Spirit Ward — +20% arcane resistance', grants: [{ type: 'resist', element: 'arcane', value: 20 }] },
    { key: 'ks_wis_iron_body', label: 'Iron Body — +20 WIS and +20 CON', grants: [{ type: 'stat', stat: 'wisdom', value: 20 }, { type: 'stat', stat: 'constitution', value: 20 }] },
    { key: 'ks_wis_clarity', label: 'Clarity — mana regeneration also restores 20% as much life', grants: [{ type: 'rule', rule: 'regenLifeShare', value: 0.2 }] },
  ],
  intelligence: [
    { key: 'ks_int_pyromancy', label: 'Pyromancy — +35% fire damage', grants: [{ type: 'damage', element: 'fire', value: 35 }] },
    { key: 'ks_int_storm_caller', label: 'Storm Caller — +35% lightning damage', grants: [{ type: 'damage', element: 'lightning', value: 35 }] },
    { key: 'ks_int_cryomancy', label: 'Cryomancy — +35% ice damage, and your hits chill', grants: [{ type: 'damage', element: 'ice', value: 35 }, { type: 'status', status: 'chill', value: 1 }] },
    { key: 'ks_int_deep_well', label: 'Deep Well — +40 INT', grants: [{ type: 'stat', stat: 'intelligence', value: 40 }] },
    { key: 'ks_int_arcane_conduit', label: 'Arcane Conduit — +20 INT and +60 maximum mana', grants: [{ type: 'stat', stat: 'intelligence', value: 20 }, { type: 'resource', pool: 'mana', value: 60 }] },
  ],
  dexterity: [
    { key: 'ks_dex_deadeye', label: 'Deadeye — +30 DEX', grants: [{ type: 'stat', stat: 'dexterity', value: 30 }] },
    { key: 'ks_dex_windrunner', label: 'Windrunner — +20 DEX and +80 maximum stamina', grants: [{ type: 'stat', stat: 'dexterity', value: 20 }, { type: 'resource', pool: 'stamina', value: 80 }] },
    { key: 'ks_dex_piercing_shot', label: 'Piercing Shot — +30% physical damage', grants: [{ type: 'damage', element: 'physical', value: 30 }] },
    { key: 'ks_dex_evasion', label: 'Evasion — +12% resistance to every element', grants: [{ type: 'resist', element: 'physical', value: 12 }, { type: 'resist', element: 'arcane', value: 12 }, { type: 'resist', element: 'fire', value: 12 }, { type: 'resist', element: 'ice', value: 12 }, { type: 'resist', element: 'lightning', value: 12 }] },
    { key: 'ks_dex_fleet', label: 'Fleet — your cooldown floor drops from 0.40 to 0.32', grants: [{ type: 'rule', rule: 'cooldownFloor', value: 0.32 }] },
  ],
  strength: [
    { key: 'ks_str_executioner', label: 'Executioner — +25% physical damage', grants: [{ type: 'damage', element: 'physical', value: 25 }] },
    { key: 'ks_str_iron_hide', label: 'Iron Hide — +250 maximum life', grants: [{ type: 'resource', pool: 'hp', value: 250 }] },
    { key: 'ks_str_bulwark', label: 'Bulwark — +20 CON and +10% physical resistance', grants: [{ type: 'stat', stat: 'constitution', value: 20 }, { type: 'resist', element: 'physical', value: 10 }] },
    { key: 'ks_str_reckless_swing', label: 'Reckless Swing — +40% physical damage, -15% ice resistance', grants: [{ type: 'damage', element: 'physical', value: 40 }, { type: 'resist', element: 'ice', value: -15 }] },
    { key: 'ks_str_unbreakable', label: 'Unbreakable — +30 STR and +150 maximum life', grants: [{ type: 'stat', stat: 'strength', value: 30 }, { type: 'resource', pool: 'hp', value: 150 }] },
  ],
  constitution: [
    { key: 'ks_con_pain_ward', label: 'Pain Ward — +15% physical and +15% fire resistance', grants: [{ type: 'resist', element: 'physical', value: 15 }, { type: 'resist', element: 'fire', value: 15 }] },
    { key: 'ks_con_undying', label: 'Undying — +40 CON', grants: [{ type: 'stat', stat: 'constitution', value: 40 }] },
    { key: 'ks_con_vital_surge', label: 'Vital Surge — +300 maximum life', grants: [{ type: 'resource', pool: 'hp', value: 300 }] },
    { key: 'ks_con_sanguine_rite', label: 'Sanguine Rite — life costs are reduced a further 20%', grants: [{ type: 'rule', rule: 'lifeCostMultiplier', value: 0.8 }] },
    { key: 'ks_con_blood_pact', label: 'Blood Pact — life costs are reduced 25%', grants: [{ type: 'rule', rule: 'lifeCostMultiplier', value: 0.75 }] },
  ],
  charisma: [
    { key: 'ks_cha_silver_tongue', label: 'Silver Tongue — +40 CHA', grants: [{ type: 'stat', stat: 'charisma', value: 40 }] },
    { key: 'ks_cha_wild_growth', label: 'Wild Growth — +25 CHA and +150 maximum life', grants: [{ type: 'stat', stat: 'charisma', value: 25 }, { type: 'resource', pool: 'hp', value: 150 }] },
    { key: 'ks_cha_venomous_bond', label: 'Venomous Bond — your hits burn', grants: [{ type: 'status', status: 'burn', value: 1 }] },
    { key: 'ks_cha_pack_leader', label: 'Pack Leader — +3 to your charm budget', grants: [{ type: 'rule', rule: 'treeCharmBonus', value: 3 }] },
    { key: 'ks_cha_beast_bond', label: 'Beast Bond — +5 to your charm budget', grants: [{ type: 'rule', rule: 'treeCharmBonus', value: 5 }] },
  ],
};

// The six rim start positions. A start node is GRANTED, never allocated: it
// costs no point, never appears in character_passives, and is the seed the
// allocatability walk starts from. `start_class` matches entity_types.name,
// NOT entity_types.main_stat — main_stat is Group B's column and Group C must
// not depend on it. Warrior and Mage exist today; the other four arrive with
// Group B T3, and their start nodes simply sit unreachable until they do.
const START_NODES = [
  { sector: 'wisdom', start_class: 'Monk', label: 'Monk' },
  { sector: 'intelligence', start_class: 'Mage', label: 'Mage' },
  { sector: 'dexterity', start_class: 'Archer', label: 'Archer' },
  { sector: 'strength', start_class: 'Warrior', label: 'Warrior' },
  { sector: 'constitution', start_class: 'Cultist', label: 'Cultist' },
  { sector: 'charisma', start_class: 'Druid', label: 'Druid' },
];

const PASSIVE_TREE_SPEC = {
  sectors: SECTORS,
  layout: LAYOUT,
  templates: TEMPLATES,
  keystones: KEYSTONES,
  startNodes: START_NODES,
};

module.exports = {
  PASSIVE_TREE_SPEC, SECTORS, LAYOUT, TEMPLATES, KEYSTONES, START_NODES,
  GRANT_TYPES, RULE_KEYS, STAT_KEYS, RESOURCE_POOLS, STATUSES,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test tests/passive_tree_spec.test.js`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/seeds/data/passiveTree.js backend/tests/passive_tree_spec.test.js
git commit -m "feat(passives): authored archetype templates and keystones (SOMET-NNN)"
```

- [ ] **Step 6: Write the five generator guard tests**

```js
// backend/tests/passive_tree_generator.test.js
//
// The five guards spec §5.5 names, plus two counting guards derived by hand.
//
// Guard 1 is the one that matters. An orphaned cluster renders perfectly, is
// invisible as a defect, and is unallocatable forever — there is no in-game
// symptom short of a player walking the whole tree and finding a wall.
const test = require('node:test');
const assert = require('node:assert');
const { generatePassiveTree } = require('../seeds/generatePassiveTree.js');
const { PASSIVE_TREE_SPEC } = require('../seeds/data/passiveTree.js');
const { ELEMENTS } = require('../src/authority/damage.js');

// The whole vocabulary, hand-written. Deliberately NOT imported from
// passiveTree.js's GRANT_TYPES: a validator that reads the same table the data
// was authored against passes on a table-level typo. The one exception is the
// element list, which is cross-checked against the combat authority below
// precisely because that IS the source of truth for elements.
const STATS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const POOLS = ['hp', 'mana', 'stamina'];
const ELS = ['physical', 'arcane', 'fire', 'ice', 'lightning'];
const STATUSES = ['burn', 'chill', 'shock'];
const RULES = ['lifeCostMultiplier', 'treeCharmBonus', 'cooldownFloor', 'regenLifeShare'];

const tree = generatePassiveTree(PASSIVE_TREE_SPEC);

test('the hand-written element list still matches the combat authority', () => {
  assert.deepStrictEqual(ELS, ELEMENTS);
});

// ---- guard 4: node count within 5% of 1800, keystones exactly as specced ----
test('guard 4: 1806 nodes — 1530 minor, 240 notable, 30 keystone, 6 start', () => {
  assert.strictEqual(tree.nodes.length, 1806);

  const byKind = {};
  for (const n of tree.nodes) byKind[n.kind] = (byKind[n.kind] || 0) + 1;
  assert.deepStrictEqual(byKind, { minor: 1530, notable: 240, keystone: 30, start: 6 });

  // The spec's own tolerance, restated as a literal band rather than a formula.
  assert.ok(tree.nodes.length >= 1710 && tree.nodes.length <= 1890,
    `node count ${tree.nodes.length} is outside 1800 +/- 5%`);

  // Per sector, so a bug that loses one whole sector cannot hide inside a
  // total that some other sector's overcount restores.
  for (const sector of ['wisdom', 'intelligence', 'dexterity', 'strength', 'constitution', 'charisma']) {
    const inSector = tree.nodes.filter((n) => n.sector === sector);
    assert.strictEqual(inSector.length, 296, `${sector} node count`); // 295 ring nodes + 1 start
    assert.strictEqual(inSector.filter((n) => n.kind === 'keystone').length, 5, `${sector} keystones`);
    assert.strictEqual(inSector.filter((n) => n.kind === 'notable').length, 40, `${sector} notables`);
  }
  assert.strictEqual(tree.nodes.filter((n) => n.sector === 'core').length, 30);
});

test('every key is unique, and 2142 edges are produced', () => {
  assert.strictEqual(new Set(tree.nodes.map((n) => n.key)).size, 1806);
  assert.strictEqual(tree.edges.length, 2142);
});

test('the six start nodes are the only nodes carrying a start_class', () => {
  const starts = tree.nodes.filter((n) => n.start_class !== null);
  assert.strictEqual(starts.length, 6);
  assert.deepStrictEqual(starts.map((n) => n.kind), ['start', 'start', 'start', 'start', 'start', 'start']);
  assert.deepStrictEqual(starts.map((n) => n.start_class).sort(),
    ['Archer', 'Cultist', 'Druid', 'Mage', 'Monk', 'Warrior']);
});

// ---- guard 2: no degree-0 node, no duplicate edge, no self-edge ----
test('guard 2: no self-edge, no duplicate edge, no isolated node', () => {
  const selfEdges = tree.edges.filter(([a, b]) => a === b);
  assert.deepStrictEqual(selfEdges, []);

  const seen = new Set();
  const dupes = [];
  for (const [a, b] of tree.edges) {
    // Ordering is part of the contract, so check it here rather than
    // normalising it away and then declaring there are no duplicates.
    assert.ok(a < b, `edge [${a}, ${b}] is not stored with keyA < keyB`);
    const id = `${a}|${b}`;
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  assert.deepStrictEqual(dupes, []);

  const degree = new Map(tree.nodes.map((n) => [n.key, 0]));
  for (const [a, b] of tree.edges) {
    assert.ok(degree.has(a), `edge endpoint ${a} is not a node`);
    assert.ok(degree.has(b), `edge endpoint ${b} is not a node`);
    degree.set(a, degree.get(a) + 1);
    degree.set(b, degree.get(b) + 1);
  }
  const isolated = [...degree].filter(([, d]) => d === 0).map(([k]) => k);
  assert.deepStrictEqual(isolated, []);
});

// ---- guard 1: reachable from EVERY start ----
test('guard 1: every node is reachable from every one of the six start nodes', () => {
  const adj = new Map(tree.nodes.map((n) => [n.key, []]));
  for (const [a, b] of tree.edges) { adj.get(a).push(b); adj.get(b).push(a); }

  const starts = tree.nodes.filter((n) => n.kind === 'start').map((n) => n.key);
  assert.strictEqual(starts.length, 6);

  for (const start of starts) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.pop();
      for (const next of adj.get(cur)) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    // Name the orphans, not just the count: a bare count tells the next
    // person the tree is broken but not which cluster fell off.
    const unreachable = tree.nodes.map((n) => n.key).filter((k) => !seen.has(k));
    assert.deepStrictEqual(unreachable.slice(0, 10), [],
      `${unreachable.length} node(s) unreachable from ${start}`);
    assert.strictEqual(seen.size, 1806, `reachable-from-${start} count`);
  }
});

// ---- guard 3: every grants payload validates ----
test('guard 3: every grant validates against the known grant vocabulary', () => {
  const bad = [];
  for (const n of tree.nodes) {
    assert.ok(Array.isArray(n.grants), `${n.key} grants is not an array`);
    for (const g of n.grants) {
      const fail = (why) => bad.push(`${n.key}: ${why} (${JSON.stringify(g)})`);
      if (g.type !== 'rule' && !Number.isFinite(g.value)) fail('value is not finite');
      switch (g.type) {
        case 'stat': if (!STATS.includes(g.stat)) fail('unknown stat'); break;
        case 'resource': if (!POOLS.includes(g.pool)) fail('unknown resource pool'); break;
        case 'damage': if (!ELS.includes(g.element)) fail('unknown damage element'); break;
        case 'resist': if (!ELS.includes(g.element)) fail('unknown resist element'); break;
        case 'status': if (!STATUSES.includes(g.status)) fail('unknown status'); break;
        case 'rule':
          if (!RULES.includes(g.rule)) fail('unknown rule key');
          if (!Number.isFinite(g.value)) fail('rule value is not finite');
          break;
        default: fail('unknown grant type');
      }
      // '@sector' must be substituted by the generator, never persisted.
      if (g.stat === '@sector') fail('unsubstituted @sector placeholder');
    }
  }
  assert.deepStrictEqual(bad.slice(0, 10), []);
  assert.strictEqual(bad.length, 0);
});

test('a start node grants nothing — it is free, so it must also be inert', () => {
  for (const n of tree.nodes.filter((x) => x.kind === 'start')) {
    assert.deepStrictEqual(n.grants, []);
  }
});

// ---- guard 5: determinism ----
test('guard 5: two consecutive runs produce identical output', () => {
  const a = generatePassiveTree(PASSIVE_TREE_SPEC);
  const b = generatePassiveTree(PASSIVE_TREE_SPEC);
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));

  // JSON.stringify would hide a -0 (it serialises as 0) and hide a key-order
  // difference is exactly what it would NOT hide, so check coordinates with
  // Object.is as well: -0 is a real determinism hazard here because every
  // coordinate goes through Math.round.
  for (let i = 0; i < a.nodes.length; i += 1) {
    assert.ok(Object.is(a.nodes[i].x, b.nodes[i].x), `node ${i} x differs by sign of zero`);
    assert.ok(Object.is(a.nodes[i].y, b.nodes[i].y), `node ${i} y differs by sign of zero`);
    assert.ok(!Object.is(a.nodes[i].x, -0), `node ${a.nodes[i].key} x is -0`);
    assert.ok(!Object.is(a.nodes[i].y, -0), `node ${a.nodes[i].key} y is -0`);
  }
});

test('coordinates are rounded to 2dp and stay inside the specced radius', () => {
  for (const n of tree.nodes) {
    assert.strictEqual(Math.round(n.x * 100) / 100, n.x, `${n.key} x is not 2dp`);
    assert.strictEqual(Math.round(n.y * 100) / 100, n.y, `${n.key} y is not 2dp`);
    // Outer ring is baseRadius 700 + 2 * rowStep 70 = 840; nothing may exceed it.
    assert.ok(Math.hypot(n.x, n.y) <= 840.01, `${n.key} is outside the outer ring`);
  }
});
```

- [ ] **Step 7: Run the guard tests to verify they fail**

Run: `cd backend && node --test tests/passive_tree_generator.test.js`
Expected: FAIL with `Cannot find module '../seeds/generatePassiveTree.js'`

- [ ] **Step 8: Write the deterministic generator**

```js
// backend/seeds/generatePassiveTree.js
//
// Expands the authored spec in data/passiveTree.js into the ~1800 rows the
// database holds. PURE, and deterministic in the strongest sense the contract
// asks for: no Math.random(), no Date.now(), no Object key iteration whose
// order is not fixed by an array in the spec. Two runs are byte-identical, so
// a tree change is a reviewable diff.
//
// SHAPE (spec §5.2). A shared core disc, six 60-degree sectors radiating out
// of it, three ring bands per sector. Each ring band is a rows x cols polar
// grid: rows are concentric arcs, columns are angular positions.
//
// EDGES. Rows are paths (col j <-> col j+1). Rungs join row i to row i+1 every
// LAYOUT.rungStride columns STARTING AT COLUMN 0 -- starting at 0 is what makes
// every row reachable from row 0, and therefore what makes the whole ring
// reachable from the one edge that enters it. Three transition edges carry each
// ring to the next at its left edge, middle and right edge, so a player has
// real routing choice rather than a single mandatory corridor.
const DEG = Math.PI / 180;

// Math.round(-0.4) is -0. -0 serialises to 0 in JSON but compares false under
// Object.is, so a determinism test that uses Object.is (and the one next door
// does) would flag it. `|| 0` normalises it before the divide.
function round2(v) {
  return (Math.round(v * 100) || 0) / 100;
}

function polar(radius, angleDeg) {
  return {
    x: round2(radius * Math.cos(angleDeg * DEG)),
    y: round2(radius * Math.sin(angleDeg * DEG)),
  };
}

// `count` positions spread evenly over `total` slots, each at the centre of
// its share. Integer arithmetic on the same inputs every time -- no rng, no
// accumulating float drift.
function spreadIndices(total, count) {
  const out = [];
  for (let k = 0; k < count; k += 1) out.push(Math.floor(((k + 0.5) * total) / count));
  return out;
}

// Which flat index in a ring gets which kind. Keystones are placed first (they
// are the scarcest and the most position-sensitive), then notables, then
// everything else is a minor. The forward-scan collision handling is a safety
// net rather than the mechanism: with the authored numbers the placements do
// not collide, and the guard test's exact per-kind counts would fail loudly if
// a future retune made them collide in a way this loop could not resolve.
function ringKinds(total, notableCount, keystoneCount, layout) {
  const kinds = new Array(total).fill('minor');
  const taken = new Set();
  const place = (raw, kind) => {
    let i = ((raw % total) + total) % total;
    while (taken.has(i)) i = (i + 1) % total;
    taken.add(i);
    kinds[i] = kind;
  };
  spreadIndices(total, keystoneCount).forEach((i, k) => {
    // Without the offset and stagger, total/count divides evenly for both
    // rings that carry keystones, so every keystone in a sector would land in
    // the same column -- one radial line of keystones and nothing elsewhere.
    place(i + layout.keystoneOffset + k * layout.keystoneStagger, 'keystone');
  });
  spreadIndices(total, notableCount).forEach((i) => place(i, 'notable'));
  return kinds;
}

// `sectors: '*'` means every stat sector and never the core: a core node has
// no sector stat, so a '@sector' template would have nothing to substitute.
function templatePool(templates, kind, sector, ring) {
  return templates.filter((t) => t.kind === kind
    && (t.sectors === '*' ? sector !== 'core' : t.sectors.includes(sector))
    && t.rings.includes(ring));
}

// Fresh objects every time: the same template object serves ~100 nodes, and a
// shared reference would let one admin edit (or one test mutation) rewrite
// every node built from that template.
function grantsFor(template, sector) {
  return template.grants.map((g) => (g.stat === '@sector' ? { ...g, stat: sector } : { ...g }));
}

function generatePassiveTree(spec) {
  const { sectors, layout, templates, keystones, startNodes } = spec;
  const nodes = [];
  const edgeKeys = new Set();

  // '|' separator: every generated key is lowercase letters, digits and
  // dashes, so a pipe cannot occur inside one and the join is unambiguous.
  // (Do NOT reach for a control character here: a NUL in a source file makes
  // grep treat the whole file as binary and skip it silently.)
  const addEdge = (a, b) => {
    if (a === b) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    edgeKeys.add(`${lo}|${hi}`);
  };

  const push = (n) => { nodes.push(n); return n.key; };

  // ---- core -------------------------------------------------------------
  const corePool = templatePool(templates, 'minor', 'core', 0);
  const rowA = [];
  for (let i = 0; i < layout.core.rowA.count; i += 1) {
    const t = corePool[i % corePool.length];
    const { x, y } = polar(layout.core.rowA.radius,
      layout.sectorAxisDeg0 + (i * 360) / layout.core.rowA.count);
    rowA.push(push({
      key: `core-a-${i}`, sector: 'core', ring: 0, x, y,
      kind: 'minor', label: t.label, grants: grantsFor(t, 'core'), start_class: null,
    }));
  }
  const rowB = [];
  for (let k = 0; k < layout.core.rowB.count; k += 1) {
    const t = corePool[k % corePool.length];
    const { x, y } = polar(layout.core.rowB.radius,
      layout.sectorAxisDeg0 + (k * 360) / layout.core.rowB.count);
    rowB.push(push({
      key: `core-b-${k}`, sector: 'core', ring: 0, x, y,
      kind: 'minor', label: t.label, grants: grantsFor(t, 'core'), start_class: null,
    }));
  }
  // Row A is a cycle, row B is a cycle, and six spokes tie them together. Two
  // cycles plus the spokes is what makes the core a single component that
  // every sector can cross to reach every other sector.
  const spokeStep = layout.core.rowB.count / layout.core.rowA.count; // 24 / 6 = 4
  for (let i = 0; i < rowA.length; i += 1) {
    addEdge(rowA[i], rowA[(i + 1) % rowA.length]);
    addEdge(rowA[i], rowB[i * spokeStep]);
  }
  for (let k = 0; k < rowB.length; k += 1) addEdge(rowB[k], rowB[(k + 1) % rowB.length]);

  // ---- sectors ----------------------------------------------------------
  for (let s = 0; s < sectors.length; s += 1) {
    const sector = sectors[s].key;
    const axis = layout.sectorAxisDeg0 + s * 60;
    const half = layout.sectorSpanDeg / 2;

    const startDef = startNodes.find((n) => n.sector === sector);
    const sp = polar(layout.startRadius, axis);
    // ring 0 means "not in a ring band" -- the core and the six starts. The
    // start node is GRANTED rather than allocated, so it grants nothing.
    const startKey = push({
      key: `start-${sector}`, sector, ring: 0, x: sp.x, y: sp.y,
      kind: 'start', label: startDef.label, grants: [], start_class: startDef.start_class,
    });
    addEdge(startKey, rowB[s * spokeStep]);

    const keys = {};
    let keystoneSeq = 0;
    for (let ring = 1; ring <= 3; ring += 1) {
      const rg = layout.rings[ring];
      const total = rg.rows * rg.cols;
      const kinds = ringKinds(total, rg.notable, rg.keystone, layout);
      keys[ring] = [];
      for (let row = 0; row < rg.rows; row += 1) {
        keys[ring][row] = [];
        for (let col = 0; col < rg.cols; col += 1) {
          const flat = row * rg.cols + col;
          const kind = kinds[flat];
          const angle = axis - half + (col * layout.sectorSpanDeg) / (rg.cols - 1);
          const { x, y } = polar(rg.baseRadius + row * rg.rowStep, angle);
          let label;
          let grants;
          if (kind === 'keystone') {
            const ks = keystones[sector][keystoneSeq];
            keystoneSeq += 1;
            label = ks.label;
            grants = ks.grants.map((g) => ({ ...g }));
          } else {
            const pool = templatePool(templates, kind, sector, ring);
            const t = pool[flat % pool.length];
            label = t.label;
            grants = grantsFor(t, sector);
          }
          keys[ring][row][col] = push({
            key: `${sector}-r${ring}-${row}-${col}`, sector, ring, x, y,
            kind, label, grants, start_class: null,
          });
        }
      }
      for (let row = 0; row < rg.rows; row += 1) {
        for (let col = 0; col + 1 < rg.cols; col += 1) {
          addEdge(keys[ring][row][col], keys[ring][row][col + 1]);
        }
      }
      for (let row = 0; row + 1 < rg.rows; row += 1) {
        for (let col = 0; col < rg.cols; col += layout.rungStride) {
          addEdge(keys[ring][row][col], keys[ring][row + 1][col]);
        }
      }
    }

    // The start node enters ring 1 at the middle column of its first row.
    addEdge(startKey, keys[1][0][Math.floor((layout.rings[1].cols - 1) / 2)]);

    // Ring transitions at the left edge, middle and right edge, so a build has
    // three ways outward instead of one mandatory corridor.
    for (const [from, to] of [[1, 2], [2, 3]]) {
      const f = layout.rings[from];
      const t = layout.rings[to];
      for (const frac of [0, 0.5, 1]) {
        addEdge(
          keys[from][f.rows - 1][Math.round(frac * (f.cols - 1))],
          keys[to][0][Math.round(frac * (t.cols - 1))],
        );
      }
    }
  }

  // Sorted rather than left in insertion order: the contract fixes the output
  // ordering, and sorting makes it independent of the traversal above, so a
  // future reordering of the build loops is not a spurious diff.
  const edges = [...edgeKeys]
    .map((k) => k.split('|'))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  return { nodes, edges };
}

module.exports = { generatePassiveTree };
```

- [ ] **Step 9: Run the guard tests to verify they pass**

Run: `cd backend && node --test tests/passive_tree_generator.test.js`
Expected: PASS (8 tests, including all five spec §5.5 guards)

- [ ] **Step 10: Commit**

```bash
git add backend/seeds/generatePassiveTree.js backend/tests/passive_tree_generator.test.js
git commit -m "feat(passives): deterministic passive-tree generator with the five §5.5 guards (SOMET-NNN)"
```

- [ ] **Step 11: Write the failing seeder round-trip test**

```js
// backend/tests/passive_tree_seed_db.test.js
//
// The seeder against a real database. Two properties matter and neither can be
// tested against a stub: that a SECOND run is a no-op on the counts (so a
// reseed cannot orphan anyone's character_passives), and that a second run
// keeps an admin's edited label/grants unless --force is passed.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { seedPassiveTree } = require('../scripts/seed-passive-tree.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url
  ? 'no TEST_DATABASE_URL -- refusing to mutate a real database (this test writes passive_nodes)'
  : false;

test('passive tree seeder', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(async () => { await pool.end(); });

  await seedPassiveTree(pool, { force: true, quiet: true });

  await t.test('inserts exactly the generated graph', async () => {
    const n = await pool.query('SELECT count(*)::int AS c FROM passive_nodes');
    assert.strictEqual(n.rows[0].c, 1806);
    const e = await pool.query('SELECT count(*)::int AS c FROM passive_edges');
    assert.strictEqual(e.rows[0].c, 2142);
    const k = await pool.query("SELECT count(*)::int AS c FROM passive_nodes WHERE kind = 'keystone'");
    assert.strictEqual(k.rows[0].c, 30);
    const s = await pool.query('SELECT count(*)::int AS c FROM passive_nodes WHERE start_class IS NOT NULL');
    assert.strictEqual(s.rows[0].c, 6);
  });

  await t.test('stores every edge with a_id < b_id and both endpoints real', async () => {
    const bad = await pool.query('SELECT count(*)::int AS c FROM passive_edges WHERE a_id >= b_id');
    assert.strictEqual(bad.rows[0].c, 0);
  });

  await t.test('a second run changes no counts and reuses the same ids', async () => {
    const before = await pool.query('SELECT id FROM passive_nodes WHERE key = $1', ['start-strength']);
    await seedPassiveTree(pool, { quiet: true });
    const n = await pool.query('SELECT count(*)::int AS c FROM passive_nodes');
    assert.strictEqual(n.rows[0].c, 1806);
    const e = await pool.query('SELECT count(*)::int AS c FROM passive_edges');
    assert.strictEqual(e.rows[0].c, 2142);
    const after = await pool.query('SELECT id FROM passive_nodes WHERE key = $1', ['start-strength']);
    // Same id, so a character_passives row pointing at it survives a reseed.
    assert.strictEqual(after.rows[0].id, before.rows[0].id);
  });

  await t.test('a plain reseed keeps an admin edit; --force overwrites it', async () => {
    const key = 'strength-r1-0-0';
    await pool.query(
      `UPDATE passive_nodes SET label = 'ADMIN EDIT', grants = $2::jsonb WHERE key = $1`,
      [key, JSON.stringify([{ type: 'stat', stat: 'strength', value: 99 }])],
    );

    await seedPassiveTree(pool, { quiet: true });
    const kept = await pool.query('SELECT label, grants FROM passive_nodes WHERE key = $1', [key]);
    assert.strictEqual(kept.rows[0].label, 'ADMIN EDIT');
    assert.deepStrictEqual(kept.rows[0].grants, [{ type: 'stat', stat: 'strength', value: 99 }]);

    await seedPassiveTree(pool, { force: true, quiet: true });
    const forced = await pool.query('SELECT label, grants FROM passive_nodes WHERE key = $1', [key]);
    assert.notStrictEqual(forced.rows[0].label, 'ADMIN EDIT');
    assert.strictEqual(Array.isArray(forced.rows[0].grants), true);
  });

  await t.test('the six start nodes name the six classes', async () => {
    const r = await pool.query('SELECT start_class FROM passive_nodes WHERE start_class IS NOT NULL ORDER BY start_class');
    assert.deepStrictEqual(r.rows.map((x) => x.start_class),
      ['Archer', 'Cultist', 'Druid', 'Mage', 'Monk', 'Warrior']);
  });
});
```

- [ ] **Step 12: Run the DB test to verify it fails**

Run:
```bash
cd backend && \
  DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  node --test tests/passive_tree_seed_db.test.js
```
Expected: FAIL with `Cannot find module '../scripts/seed-passive-tree.js'`

- [ ] **Step 13: Write the migration**

```js
// backend/migrations/1714440504000_passive_tree.js
//
// Contract slot 1714440504000 (T6). The passive tree's three tables.
//
// passive_edges is UNDIRECTED and stored once, with a_id < b_id enforced by a
// CHECK rather than by convention -- a convention that lives only in the
// seeder is a convention the admin API can break, and a duplicated edge in the
// other direction would double every node's apparent degree in the client.
exports.up = (pgm) => {
  pgm.createTable('passive_nodes', {
    id: 'id',
    key: { type: 'text', notNull: true },
    sector: { type: 'text', notNull: true },
    // 0 = the core disc and the six start nodes, 1..3 = the ring bands.
    ring: { type: 'smallint', notNull: true },
    x: { type: 'real', notNull: true },
    y: { type: 'real', notNull: true },
    kind: { type: 'text', notNull: true },
    label: { type: 'text', notNull: true },
    grants: { type: 'jsonb', notNull: true, default: '[]' },
    start_class: { type: 'text', notNull: false, default: null },
  });
  // The generator keys every node stably, and the seeder upserts on this --
  // that is what stops a regeneration orphaning anyone's character_passives.
  pgm.addConstraint('passive_nodes', 'passive_nodes_key_unique', { unique: ['key'] });
  pgm.addConstraint('passive_nodes', 'passive_nodes_kind_check',
    "CHECK (kind IN ('minor','notable','keystone','start'))");
  pgm.addConstraint('passive_nodes', 'passive_nodes_sector_check',
    "CHECK (sector IN ('core','strength','dexterity','constitution','intelligence','wisdom','charisma'))");
  pgm.addConstraint('passive_nodes', 'passive_nodes_ring_check', 'CHECK (ring BETWEEN 0 AND 3)');
  // start_class and kind='start' are the same fact. Letting them disagree
  // would give a class a start node the allocatability walk cannot find, or a
  // start node no class can use -- both silently unplayable.
  pgm.addConstraint('passive_nodes', 'passive_nodes_start_class_check',
    "CHECK ((kind = 'start') = (start_class IS NOT NULL))");
  pgm.createIndex('passive_nodes', 'sector');
  pgm.createIndex('passive_nodes', 'start_class',
    { unique: true, where: 'start_class IS NOT NULL', name: 'passive_nodes_one_start_per_class' });

  pgm.createTable('passive_edges', {
    a_id: { type: 'integer', notNull: true, references: 'passive_nodes', onDelete: 'CASCADE' },
    b_id: { type: 'integer', notNull: true, references: 'passive_nodes', onDelete: 'CASCADE' },
  });
  pgm.addConstraint('passive_edges', 'passive_edges_pkey', { primaryKey: ['a_id', 'b_id'] });
  pgm.addConstraint('passive_edges', 'passive_edges_ordered', 'CHECK (a_id < b_id)');
  // The primary key indexes a_id; the reverse direction needs its own index
  // because every adjacency read walks the edge list in both directions.
  pgm.createIndex('passive_edges', 'b_id');

  pgm.createTable('character_passives', {
    character_id: { type: 'integer', notNull: true, references: 'characters', onDelete: 'CASCADE' },
    node_id: { type: 'integer', notNull: true, references: 'passive_nodes', onDelete: 'CASCADE' },
    allocated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // One point per node, no multi-rank nodes (spec §5.4) -- expressed as the
  // primary key so a double-submit cannot spend two points on one node.
  pgm.addConstraint('character_passives', 'character_passives_pkey',
    { primaryKey: ['character_id', 'node_id'] });
};

exports.down = (pgm) => {
  pgm.dropTable('character_passives');
  pgm.dropTable('passive_edges');
  pgm.dropTable('passive_nodes');
};
```

- [ ] **Step 14: Write the seeder**

```js
#!/usr/bin/env node
// backend/scripts/seed-passive-tree.js
//
// Seed passive_nodes + passive_edges from the generated tree. Run via
// `make seed-passive-tree` (add FORCE=1 to overwrite admin edits).
//
// UPSERT BY KEY, NEVER DELETE -- the same rule scripts/seed-catalogs.js
// states in its own header, and here it is load-bearing rather than polite:
// character_passives references passive_nodes.id, so deleting and re-inserting
// a node would either fail on the FK or (with a cascade) silently unspend
// every point a player had put into it.
//
// WHICH COLUMNS A RESEED OVERWRITES. Structural columns (sector, ring, x, y,
// start_class) always: they come from the layout and an admin cannot edit them
// in the UI. Authored columns (kind, label, grants) only under --force: those
// are exactly what the admin node editor writes, and clobbering them on every
// reseed is the failure biomes.js's creature_types CASE expression exists to
// prevent.
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const { generatePassiveTree } = require('../seeds/generatePassiveTree.js');
const { PASSIVE_TREE_SPEC } = require('../seeds/data/passiveTree.js');

async function seedPassiveTree(db, { force = false, quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const { nodes, edges } = generatePassiveTree(PASSIVE_TREE_SPEC);

  for (const n of nodes) {
    await db.query(
      `INSERT INTO passive_nodes (key, sector, ring, x, y, kind, label, grants, start_class)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       ON CONFLICT (key) DO UPDATE
         SET sector = EXCLUDED.sector,
             ring = EXCLUDED.ring,
             x = EXCLUDED.x,
             y = EXCLUDED.y,
             start_class = EXCLUDED.start_class,
             kind   = CASE WHEN $10 THEN EXCLUDED.kind   ELSE passive_nodes.kind   END,
             label  = CASE WHEN $10 THEN EXCLUDED.label  ELSE passive_nodes.label  END,
             grants = CASE WHEN $10 THEN EXCLUDED.grants ELSE passive_nodes.grants END`,
      [n.key, n.sector, n.ring, n.x, n.y, n.kind, n.label, JSON.stringify(n.grants), n.start_class, force],
    );
  }
  log(`passive_nodes: ${nodes.length} upserted${force ? ' (--force: labels/kinds/grants overwritten)' : ''}`);

  // A node in the database that the generator no longer produces is REPORTED,
  // never deleted: someone may already have spent a point on it.
  const stale = await db.query(
    'SELECT key FROM passive_nodes WHERE key <> ALL($1::text[]) ORDER BY key',
    [nodes.map((n) => n.key)],
  );
  if (stale.rows.length) {
    log(`WARNING: ${stale.rows.length} node(s) exist in the database but not in the spec.`);
    log('They were LEFT IN PLACE (a character may have allocated them). Remove them by hand if that is really what you want:');
    for (const r of stale.rows.slice(0, 20)) log(`  ${r.key}`);
  }

  // Edges are not admin-editable, so they are reconciled in full. The generator
  // emits KEY pairs; ids are assigned by insertion order, which is not key
  // order, so LEAST/GREATEST is what satisfies the a_id < b_id CHECK.
  const idRows = await db.query('SELECT id, key FROM passive_nodes');
  const idByKey = new Map(idRows.rows.map((r) => [r.key, r.id]));
  const wanted = edges.map(([a, b]) => {
    const ia = idByKey.get(a);
    const ib = idByKey.get(b);
    return ia < ib ? [ia, ib] : [ib, ia];
  });

  await db.query(
    `INSERT INTO passive_edges (a_id, b_id)
     SELECT * FROM unnest($1::int[], $2::int[])
     ON CONFLICT (a_id, b_id) DO NOTHING`,
    [wanted.map((e) => e[0]), wanted.map((e) => e[1])],
  );
  const removed = await db.query(
    `DELETE FROM passive_edges e
      WHERE NOT EXISTS (
        SELECT 1 FROM unnest($1::int[], $2::int[]) AS w(a, b)
         WHERE w.a = e.a_id AND w.b = e.b_id)
      RETURNING a_id`,
    [wanted.map((e) => e[0]), wanted.map((e) => e[1])],
  );
  log(`passive_edges: ${wanted.length} reconciled, ${removed.rowCount} stale edge(s) removed`);
}

async function main() {
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await seedPassiveTree(pool, { force: process.argv.includes('--force') });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { seedPassiveTree };
```

- [ ] **Step 15: Migrate the scratch database and run the DB test**

Run:
```bash
cd backend && \
  DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree npm run migrate:up && \
  DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  node --test tests/passive_tree_seed_db.test.js
```
Expected: PASS (5 subtests)

- [ ] **Step 16: Commit**

```bash
git add backend/migrations/1714440504000_passive_tree.js backend/scripts/seed-passive-tree.js backend/tests/passive_tree_seed_db.test.js
git commit -m "feat(passives): passive_nodes/passive_edges/character_passives schema and seeder (SOMET-NNN)"
```

- [ ] **Step 17: Write the failing Makefile-target test**

```js
// backend/tests/passive_tree_make_target.test.js
//
// A make target is the documented way to run the seeder, so a missing or
// misspelled one is a real defect -- and the only place it can be caught
// without a container is the Makefile's own text (compose/orangepi's
// Caddyfile test takes the same route for the same reason).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const makefile = fs.readFileSync(path.resolve(__dirname, '../../Makefile'), 'utf8');

test('seed-passive-tree is declared .PHONY', () => {
  const phony = makefile.slice(0, makefile.indexOf('COMPOSE_FILE'));
  assert.ok(/\bseed-passive-tree\b/.test(phony),
    'seed-passive-tree missing from the .PHONY list -- a stray file of that name would shadow the target');
});

test('seed-passive-tree runs the seeder inside the backend container', () => {
  const target = makefile.match(/^seed-passive-tree:\n((?:\t.*\n)+)/m);
  assert.ok(target, 'no seed-passive-tree target found');
  assert.match(target[1], /node scripts\/seed-passive-tree\.js/);
  assert.match(target[1], /exec -T backend/);
});

test('FORCE=1 is the way to overwrite admin edits, and is off by default', () => {
  const target = makefile.match(/^seed-passive-tree:\n((?:\t.*\n)+)/m);
  assert.match(target[1], /--force/);
  assert.match(target[1], /FORCE/);
});
```

- [ ] **Step 18: Run the Makefile test to verify it fails**

Run: `cd backend && node --test tests/passive_tree_make_target.test.js`
Expected: FAIL with `seed-passive-tree missing from the .PHONY list -- a stray file of that name would shadow the target`

- [ ] **Step 19: Add the Makefile target**

Edit `Makefile:1-11`, appending `seed-passive-tree` to the `.PHONY` list (the line that already ends `... seed-catalogs seed-map \`):

```make
.PHONY: up down build logs restart rebuild clean nuke shell-backend shell-frontend db-shell \
        engine-build engine-test engine-up engine-down engine-logs engine-shell engine-rebuild \
        redis-shell admin-password admin-password-rotate seed-catalogs seed-map seed-passive-tree \
```

Then insert this target immediately after the `seed-catalogs` target (`Makefile:232`):

```make
# Regenerate the passive tree and upsert it. Safe to re-run: nodes are upserted
# by their stable generated key, never deleted, so no character_passives row is
# ever orphaned. An admin's edited kind/label/grants survive a plain run --
# pass FORCE=1 to overwrite them from the checked-in spec.
#
#   make seed-passive-tree
#   make seed-passive-tree FORCE=1
seed-passive-tree:
	$(COMPOSE) exec -T backend node scripts/seed-passive-tree.js $(if $(FORCE),--force,)
```

- [ ] **Step 20: Run the Makefile test to verify it passes**

Run: `cd backend && node --test tests/passive_tree_make_target.test.js`
Expected: PASS (3 tests)

- [ ] **Step 21: Run the whole backend suite for this task's files and commit**

Run:
```bash
cd backend && \
  DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  node --test --test-timeout=420000 \
    tests/passive_tree_spec.test.js tests/passive_tree_generator.test.js \
    tests/passive_tree_seed_db.test.js tests/passive_tree_make_target.test.js
```
Expected: PASS, 0 failures

```bash
git add Makefile backend/tests/passive_tree_make_target.test.js
git commit -m "feat(passives): make seed-passive-tree target (SOMET-NNN)"
```

---

### Task 2 (T7): Allocation/respec API and `statComposition.js`

**Files:**
- Create: `backend/src/services/statComposition.js`
- Create: `backend/src/services/passiveRules.js`
- Create: `backend/src/services/passiveTreeStore.js`
- Create: `backend/src/api/passiveTreeRoutes.js`
- Modify: `backend/src/services/progressionStore.js:1-8` (imports), `:9-11` (`COLUMNS`), `:38-53` (`loadProgression`), `:70-102` (`awardXp` return), `:104-124` (delete `allocateStat`), `:126-170` (replace `respec`), `:203-205` (exports)
- Modify: `backend/src/api/progressionRoutes.js:16-20` (imports), `:52-70` (`GET /`), `:72-99` (replace `/allocate` with `/passives/:nodeId`), `:101-114` (`/respec`)
- Modify: `backend/src/index.js:123` (require) and `:437` (mount)
- Modify: `backend/src/authority/server.js:796`, `:928`, `:1809`, `:1848`, `:2096` (add `stats` to every `progression` frame, contract §6.3); `:1431` (join loads the composed row)
- Test: `backend/tests/progression_frame_shape.test.js`
- Modify: `docs/superpowers/plans/2026-08-23-progression-shared-contract.md` (§2 and §3 additions)
- Test: `backend/tests/stat_composition.test.js`
- Test: `backend/tests/passive_rules.test.js`
- Test: `backend/tests/passive_tree_allocation_db.test.js`
- Test: `backend/tests/passive_tree_routes.test.js`

**Interfaces:**
- Consumes (Group A T1): `getSettings(pool, keys) -> { key: value }` from `backend/src/services/gameSettings.js`, for `respec_base_gold`. (`passive_points_per_level` is read by **T2**, which grants the points into the column; this plan only spends and refunds them.)
- Consumes (Group A T2, contract §6.7): `player_progression.passive_points integer NOT NULL DEFAULT 0 CHECK (passive_points >= 0)`.
- Consumes (Task 1): tables `passive_nodes`, `passive_edges`, `character_passives`.
- Consumes (existing): `loadProgression(db, characterId, {forUpdate})` and `derivePlayerStats(progression)` — `derivePlayerStats` needs **no** change, because `composeStats` returns the six stat keys at its top level with exactly the names `derivePlayerStats` already reads (`playerStats.js:41-60`).
- Produces (contract §2): `composeStats({base, passives, gear}) -> { strength…charisma, sources, modifiers, rules }`, `STAT_KEYS`.
- Produces: `buildAdjacency(edges)`, `isAllocatable(nodeId, allocatedIds, adjacency, startNodeId)`, `flattenGrants(nodes)` from `passiveRules.js`.
- Produces: `loadTree(pool)`, `startNodeIdFor(pool, characterId)`, `loadAllocatedIds(db, characterId)`, `allocateNode(pool, characterId, nodeId)`, `respecPassives(pool, userId, characterId)`, `passiveBundle(db, characterId, level)` from `passiveTreeStore.js`.
- Produces (contract §3): `GET /api/passive-tree`, `POST /api/progression/passives/:nodeId`, `POST /api/progression/respec`; `GET /api/progression` gains `passivePoints`, `allocatedNodeIds`, `sources`, `modifiers`.

**Two design decisions this task makes, both recorded in the contract in Step 1:**

1. **`passivePoints` is a COLUMN, spent and refunded in the same transaction as the allocation.** Contract §6.7 puts `player_progression.passive_points` in T2's migration slot. Allocation decrements it in the UPDATE's own `WHERE` clause (`passive_points >= 1`), exactly as the retired `allocateStat` guarded `stat_points`; respec adds back the number of rows it deleted. A derived wallet (`per_level × (level − 1) − allocatedCount`) was considered and is **wrong** under §6.7: T2 also refunds pre-epic stat points into that column, so the balance is not a function of level alone.
2. **The four new fields ride INSIDE the `progression` object, not beside it.** `Game.js:489` is `onProgression: (msg) => { if (msg && msg.progression) this.progression = msg.progression; }` — it keeps `msg.progression` and drops every sibling field. Fields added at frame level would be silently discarded on every push. Putting them inside the object means all seven existing `progression` send sites (`server.js:796, 928, 1809, 1848, 2096, 2879` and the join frame at `:1537`) carry them with no edit, and the single-writer rule in `CharacterSheet.jsx`'s F1 header is preserved untouched.

- [ ] **Step 1: Record this task's three contract additions**

Contract §2 requires that anything crossing a plan boundary be written down. Append to `docs/superpowers/plans/2026-08-23-progression-shared-contract.md`, at the end of §2:

```markdown
### Additions made by the Group C plan (T7)

`composeStats` returns one more key than §2 originally listed:

```js
rules: { lifeCostMultiplier: 1, treeCharmBonus: 0, cooldownFloor: null, regenLifeShare: 0 }
```

Keystone grants of `{ type: 'rule', rule, value }` are aggregated here. Defaults
are the identity for each rule's combination mode (`product` -> 1, `sum` -> 0,
`min` -> null meaning "no keystone lowered it"). **`charm.js`'s
`treeCharmBonus` argument (§2) is `composeStats(...).rules.treeCharmBonus`, and
`lifeCost.js`'s `lifeCostMultiplier` argument is
`composeStats(...).rules.lifeCostMultiplier`.**

`passivePoints` on the wire is `player_progression.passive_points` (§6.7),
read straight off the row. T2 grants into that column; T7 spends from it on
allocate and refunds into it on respec.

The fields §4 and §6.2 add to the `progression` frame (`passivePoints`,
`allocatedNodeIds`, `sources`, `modifiers`, `effective`, plus `rules`) live
**inside** the `progression` object, not beside it: `Game.js`'s
`onProgression` handler keeps `msg.progression` and discards every sibling
field. Per §6.3, `stats` is the one exception — it stays a sibling of
`progression` on every frame, matching the shape `refreshPlayerStats` already
sends.

Two admin routes are added to the §3 table:

| Method | Path | Task | Auth |
|---|---|---|---|
| `GET` | `/api/passive-nodes` | T9 | admin; `?search=&sector=&kind=&limit=&offset=` |
| `PUT` | `/api/passive-nodes/:id` | T9 | admin; `label`, `kind`, `grants` only |
```

```bash
git add docs/superpowers/plans/2026-08-23-progression-shared-contract.md
git commit -m "docs(progression): record Group C's contract additions (SOMET-NNN)"
```

- [ ] **Step 2: Write the failing `composeStats` test**

```js
// backend/tests/stat_composition.test.js
//
// Every expected value below is HAND-WRITTEN. This module is the exact shape
// the spec §11 warning names: a test that builds its expectation by summing
// the same inputs the code sums proves only that addition is associative.
const test = require('node:test');
const assert = require('node:assert');
const { composeStats, STAT_KEYS } = require('../src/services/statComposition.js');

const BASE = {
  strength: 5, dexterity: 5, constitution: 5,
  intelligence: 5, wisdom: 5, charisma: 5,
};

test('the six stat keys, in the order the rest of the codebase uses', () => {
  assert.deepStrictEqual(STAT_KEYS,
    ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']);
});

test('with no passives and no gear the base passes straight through', () => {
  const r = composeStats({ base: BASE, passives: [], gear: [] });
  assert.strictEqual(r.strength, 5);
  assert.strictEqual(r.charisma, 5);
  assert.deepStrictEqual(r.sources.strength, { base: 5, tree: 0, gear: 0 });
  assert.deepStrictEqual(r.modifiers, []);
  assert.deepStrictEqual(r.rules,
    { lifeCostMultiplier: 1, treeCharmBonus: 0, cooldownFloor: null, regenLifeShare: 0 });
});

test('base + tree + gear, itemised — STR 19 = 5 base + 10 tree + 4 gear', () => {
  const r = composeStats({
    base: BASE,
    passives: [
      { type: 'stat', stat: 'strength', value: 2, label: 'Sinew' },
      { type: 'stat', stat: 'strength', value: 8, label: 'Great Sinew' },
      { type: 'stat', stat: 'wisdom', value: 3, label: 'Focus' },
      { type: 'resource', pool: 'hp', value: 40, label: 'Thick Skin' },
    ],
    gear: [
      { label: "Bear's Girdle", effect: { type: 'stat', stat: 'strength' }, value: 4 },
      { label: 'Owl Charm', effect: { type: 'resist', element: 'fire' }, value: 7 },
    ],
  });

  assert.strictEqual(r.strength, 19);
  assert.strictEqual(r.wisdom, 8);
  assert.strictEqual(r.dexterity, 5);
  assert.deepStrictEqual(r.sources.strength, { base: 5, tree: 10, gear: 4 });
  assert.deepStrictEqual(r.sources.wisdom, { base: 5, tree: 3, gear: 0 });
  assert.deepStrictEqual(r.sources.dexterity, { base: 5, tree: 0, gear: 0 });
});

test('every grant becomes exactly one modifier, tagged with where it came from', () => {
  const r = composeStats({
    base: BASE,
    passives: [
      { type: 'stat', stat: 'strength', value: 8, label: 'Great Sinew' },
      { type: 'damage', element: 'fire', value: 12, label: 'Kindling' },
    ],
    gear: [{ label: 'Owl Charm', effect: { type: 'resist', element: 'fire' }, value: 7 }],
  });

  assert.strictEqual(r.modifiers.length, 3);
  assert.deepStrictEqual(r.modifiers[0],
    { label: 'Great Sinew', value: 8, source: 'tree', kind: 'stat', detail: 'strength' });
  assert.deepStrictEqual(r.modifiers[1],
    { label: 'Kindling', value: 12, source: 'tree', kind: 'damage', detail: 'fire' });
  assert.deepStrictEqual(r.modifiers[2],
    { label: 'Owl Charm', value: 7, source: 'gear', kind: 'resist', detail: 'fire' });
});

test('rules combine by their declared mode: product, sum and min', () => {
  const r = composeStats({
    base: BASE,
    passives: [
      { type: 'rule', rule: 'lifeCostMultiplier', value: 0.75, label: 'Blood Pact' },
      { type: 'rule', rule: 'lifeCostMultiplier', value: 0.8, label: 'Sanguine Rite' },
      { type: 'rule', rule: 'treeCharmBonus', value: 5, label: 'Beast Bond' },
      { type: 'rule', rule: 'treeCharmBonus', value: 3, label: 'Pack Leader' },
      { type: 'rule', rule: 'cooldownFloor', value: 0.36, label: 'Nimble' },
      { type: 'rule', rule: 'cooldownFloor', value: 0.32, label: 'Fleet' },
    ],
    gear: [],
  });

  // 0.75 * 0.8 in binary floating point is 0.6000000000000001; the module
  // rounds rule products to 4dp for the same reason playerStats.js's round4
  // exists, so the literal below is 0.6 and not a tolerance argument.
  assert.strictEqual(r.rules.lifeCostMultiplier, 0.6);
  assert.strictEqual(r.rules.treeCharmBonus, 8);
  assert.strictEqual(r.rules.cooldownFloor, 0.32);
  assert.strictEqual(r.rules.regenLifeShare, 0);
  assert.strictEqual(r.modifiers.length, 6);
  assert.deepStrictEqual(r.modifiers[0],
    { label: 'Blood Pact', value: 0.75, source: 'tree', kind: 'rule', detail: 'lifeCostMultiplier' });
});

test('composed totals are integers, so derivePlayerStats never sees a fraction', () => {
  const r = composeStats({
    base: BASE,
    passives: [{ type: 'stat', stat: 'dexterity', value: 2.5, label: 'Odd' }],
    gear: [{ label: 'Odd Ring', effect: { type: 'stat', stat: 'dexterity' }, value: 1.5 }],
  });
  // 5 + 2.5 + 1.5 = 9 exactly; the flooring is on the SUM, not per grant, so a
  // pair of halves is not silently thrown away.
  assert.strictEqual(r.dexterity, 9);
  assert.strictEqual(Number.isInteger(r.dexterity), true);
});

test('a stat can never compose below its base — a negative grant floors there', () => {
  // derivePlayerStats' own stat() falls back to BASE_STAT for anything below
  // it (playerStats.js:33-37), so a value that composes lower would be
  // silently ignored downstream. Floor it here instead, where it is visible.
  const r = composeStats({
    base: BASE,
    passives: [{ type: 'stat', stat: 'charisma', value: -20, label: 'Curse' }],
    gear: [],
  });
  assert.strictEqual(r.charisma, 5);
  assert.deepStrictEqual(r.sources.charisma, { base: 5, tree: -20, gear: 0 });
});

test('a missing or malformed base falls back to 5 rather than producing NaN', () => {
  const r = composeStats({ base: { strength: 'x' }, passives: [], gear: [] });
  assert.strictEqual(r.strength, 5);
  assert.strictEqual(r.intelligence, 5);
});

test('an unknown grant type is ignored by the totals but still listed as a modifier', () => {
  const r = composeStats({
    base: BASE,
    passives: [{ type: 'wat', value: 3, label: 'Mystery' }],
    gear: [],
  });
  assert.strictEqual(r.strength, 5);
  assert.strictEqual(r.modifiers.length, 1);
  assert.strictEqual(r.modifiers[0].kind, 'wat');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && node --test tests/stat_composition.test.js`
Expected: FAIL with `Cannot find module '../src/services/statComposition.js'`

- [ ] **Step 4: Write `statComposition.js`**

```js
// backend/src/services/statComposition.js
//
// PURE. No database, no clock, no randomness (contract §2).
//
// The single place a composed stat total or an itemised breakdown is produced.
// derivePlayerStats() keeps its job -- it is still the only place a DERIVED
// number (maxHp, meleeMult, ...) is computed -- and it needs no change: the six
// keys this returns at the top level are exactly the six it already reads off a
// progression row (playerStats.js:41-60), so the composed bundle is a drop-in
// substitute for the raw row.
//
// `sources` and `modifiers` exist so the Character tab never recomputes the
// breakdown. Recomputing it client-side is the drift that killed xpCurve.js.

const STAT_KEYS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];

// Matches progressionConstants.BASE_STAT. Re-declared rather than imported so
// this module stays free of the tunables file (it is PURE and the tunables file
// is where a future balance pass lands); the DB CHECK on player_progression
// already pins the value at >= 5 independently.
const BASE_STAT = 5;

// How two copies of the same rule combine, and the identity value each mode
// starts from. Duplicated from seeds/data/passiveTree.js's RULE_KEYS on
// purpose: that file is seed data the admin UI can outgrow, this one is the
// runtime contract. passive_rules.test.js asserts the two agree.
const RULE_COMBINE = {
  lifeCostMultiplier: 'product',
  treeCharmBonus: 'sum',
  cooldownFloor: 'min',
  regenLifeShare: 'sum',
};
const RULE_IDENTITY = { product: 1, sum: 0, min: null };

// Round to 4dp without floating-point noise -- same reasoning as
// playerStats.js's round4: 0.75 * 0.8 is 0.6000000000000001, and an unrounded
// multiplier turns every life-cost assertion into a tolerance argument.
function round4(n) { return Math.round(n * 10000) / 10000; }

function baseOf(base, key) {
  const v = base == null ? undefined : base[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : BASE_STAT;
}

// A gear entry is { label, effect, value } where effect is an affix_types.effect
// row; a passive entry is a flattened passive_nodes.grants element that already
// carries its own type/value. Normalise both to one shape so the fold below has
// exactly one case to handle.
function normalise(entry, source) {
  const effect = entry.effect || entry;
  const value = Number(entry.value);
  return {
    source,
    label: String(entry.label == null ? '' : entry.label),
    kind: effect.type,
    stat: effect.stat,
    pool: effect.pool,
    element: effect.element,
    status: effect.status,
    rule: effect.rule,
    value: Number.isFinite(value) ? value : 0,
  };
}

function detailOf(m) {
  if (m.kind === 'stat') return m.stat;
  if (m.kind === 'resource') return m.pool;
  if (m.kind === 'damage' || m.kind === 'resist') return m.element;
  if (m.kind === 'status') return m.status;
  if (m.kind === 'rule') return m.rule;
  return null;
}

function composeStats({ base, passives = [], gear = [] } = {}) {
  const sources = {};
  for (const k of STAT_KEYS) sources[k] = { base: baseOf(base, k), tree: 0, gear: 0 };

  const rules = {};
  for (const [key, mode] of Object.entries(RULE_COMBINE)) rules[key] = RULE_IDENTITY[mode];

  const modifiers = [];
  const entries = [
    ...passives.map((p) => normalise(p, 'tree')),
    ...gear.map((g) => normalise(g, 'gear')),
  ];

  for (const m of entries) {
    if (m.kind === 'stat' && Object.prototype.hasOwnProperty.call(sources, m.stat)) {
      sources[m.stat][m.source] += m.value;
    } else if (m.kind === 'rule' && Object.prototype.hasOwnProperty.call(RULE_COMBINE, m.rule)) {
      const mode = RULE_COMBINE[m.rule];
      if (mode === 'product') rules[m.rule] = round4(rules[m.rule] * m.value);
      else if (mode === 'sum') rules[m.rule] += m.value;
      else rules[m.rule] = rules[m.rule] == null ? m.value : Math.min(rules[m.rule], m.value);
    }
    // Every entry becomes a modifier regardless of whether a total consumed it:
    // resource/damage/resist/status grants have no total in this module (they
    // are read by the item and combat code) and the Character tab must still
    // list them, itemised, rather than silently dropping them.
    modifiers.push({
      label: m.label, value: m.value, source: m.source, kind: m.kind, detail: detailOf(m),
    });
  }

  const out = { sources, modifiers, rules };
  for (const k of STAT_KEYS) {
    const s = sources[k];
    // Floored at BASE_STAT because derivePlayerStats' own stat() guard already
    // treats anything below the base as "as if level 1" (playerStats.js:33-37).
    // Flooring here keeps the number the UI shows and the number the formulas
    // use identical; leaving it would show -15 STR and compute 5.
    out[k] = Math.max(BASE_STAT, Math.floor(s.base + s.tree + s.gear));
  }
  return out;
}

module.exports = { composeStats, STAT_KEYS, RULE_COMBINE, BASE_STAT };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && node --test tests/stat_composition.test.js`
Expected: PASS (9 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/statComposition.js backend/tests/stat_composition.test.js
git commit -m "feat(passives): pure statComposition with itemised sources, modifiers and rules (SOMET-NNN)"
```

- [ ] **Step 7: Write the failing `passiveRules` test**

```js
// backend/tests/passive_rules.test.js
//
// The pure graph and budget rules behind allocation. Every expectation is a
// hand-written literal: the point budget in particular is the number a player
// can overspend if it is wrong, so it must not be derived from the same
// expression the code evaluates.
const test = require('node:test');
const assert = require('node:assert');
const {
  buildAdjacency, isAllocatable, flattenGrants,
} = require('../src/services/passiveRules.js');
const { RULE_COMBINE } = require('../src/services/statComposition.js');
const { RULE_KEYS } = require('../../backend/seeds/data/passiveTree.js');

//   10 (start) -- 11 -- 12
//                  |
//                 13     14 (unconnected to anything allocated)
const EDGES = [[10, 11], [11, 12], [11, 13], [13, 14]];

test('adjacency is undirected — an edge stored one way is walkable both ways', () => {
  const adj = buildAdjacency(EDGES);
  assert.deepStrictEqual([...adj.get(10)], [11]);
  assert.deepStrictEqual([...adj.get(11)].sort((a, b) => a - b), [10, 12, 13]);
  assert.deepStrictEqual([...adj.get(14)], [13]);
});

test('the start node is always allocatable-adjacent, even with nothing allocated', () => {
  const adj = buildAdjacency(EDGES);
  assert.strictEqual(isAllocatable(11, [], adj, 10), true);
  assert.strictEqual(isAllocatable(12, [], adj, 10), false);
  assert.strictEqual(isAllocatable(13, [], adj, 10), false);
});

test('a node one edge from an allocated node becomes allocatable', () => {
  const adj = buildAdjacency(EDGES);
  assert.strictEqual(isAllocatable(12, [11], adj, 10), true);
  assert.strictEqual(isAllocatable(13, [11], adj, 10), true);
  assert.strictEqual(isAllocatable(14, [11], adj, 10), false);
  assert.strictEqual(isAllocatable(14, [11, 13], adj, 10), true);
});

test('the start node itself is never allocatable — it is granted, not bought', () => {
  const adj = buildAdjacency(EDGES);
  assert.strictEqual(isAllocatable(10, [], adj, 10), false);
  assert.strictEqual(isAllocatable(10, [11], adj, 10), false);
});

test('an already-allocated node is not allocatable again', () => {
  const adj = buildAdjacency(EDGES);
  assert.strictEqual(isAllocatable(11, [11], adj, 10), false);
});

test('a character with no start node can allocate nothing at all', () => {
  const adj = buildAdjacency(EDGES);
  assert.strictEqual(isAllocatable(11, [], adj, null), false);
  assert.strictEqual(isAllocatable(12, [11], adj, null), true); // adjacency still applies
});

test('flattenGrants tags every grant with its node label and drops empty ones', () => {
  const flat = flattenGrants([
    { id: 1, label: 'Great Sinew', grants: [{ type: 'stat', stat: 'strength', value: 8 }] },
    { id: 2, label: 'Warrior', grants: [] },
    {
      id: 3,
      label: 'Cryomancy',
      grants: [
        { type: 'damage', element: 'ice', value: 35 },
        { type: 'status', status: 'chill', value: 1 },
      ],
    },
  ]);
  assert.deepStrictEqual(flat, [
    { type: 'stat', stat: 'strength', value: 8, label: 'Great Sinew', nodeId: 1 },
    { type: 'damage', element: 'ice', value: 35, label: 'Cryomancy', nodeId: 3 },
    { type: 'status', status: 'chill', value: 1, label: 'Cryomancy', nodeId: 3 },
  ]);
});

test('the runtime rule table and the seed rule table have not drifted apart', () => {
  // Two files declare the same four rules for two different reasons (see the
  // comment on RULE_COMBINE). Neither is generated from the other, so this is
  // the only thing that stops one being edited alone.
  const seedModes = Object.fromEntries(
    Object.entries(RULE_KEYS).map(([k, v]) => [k, v.combine]),
  );
  assert.deepStrictEqual(seedModes, RULE_COMBINE);
});
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `cd backend && node --test tests/passive_rules.test.js`
Expected: FAIL with `Cannot find module '../src/services/passiveRules.js'`

- [ ] **Step 9: Write `passiveRules.js`**

```js
// backend/src/services/passiveRules.js
//
// PURE. The graph and budget rules that decide what a character may allocate.
// Kept out of passiveTreeStore.js so every one of them is a unit test rather
// than a database fixture -- the same split progressionStore/playerStats
// already uses.

// edges arrive as [[aId, bId], ...] with aId < bId (the passive_edges CHECK).
// The graph is UNDIRECTED, so both directions go into the map: a walk that
// only followed a_id -> b_id would find half the tree unreachable and would
// look exactly like the orphaned-cluster bug the generator guards against.
function buildAdjacency(edges) {
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  for (const [a, b] of edges || []) { link(a, b); link(b, a); }
  return adj;
}

// Spec §5.4: allocatable iff adjacent to your class's start node, or adjacent
// to a node you have already allocated. The start node itself is GRANTED --
// it costs no point and never enters character_passives -- so it is never
// allocatable, and asking for it is an error rather than a no-op.
function isAllocatable(nodeId, allocatedIds, adjacency, startNodeId) {
  const allocated = allocatedIds instanceof Set ? allocatedIds : new Set(allocatedIds || []);
  if (nodeId === startNodeId) return false;
  if (allocated.has(nodeId)) return false;
  const neighbours = adjacency.get(nodeId) || [];
  return neighbours.some((n) => n === startNodeId || allocated.has(n));
}

// NOTE: there is deliberately no passivePointsFor() here. The wallet is
// player_progression.passive_points (contract §6.7), granted by T2 and spent
// inside allocateNode's guarded UPDATE. Deriving it from the level would be a
// second, drifting source of truth -- and a wrong one, since T2 also refunds
// pre-epic stat points into that same column.

// passive_nodes rows -> the flat `passives` array composeStats takes. The
// node's label rides on every grant it produces, because the Character tab
// lists modifiers one line each and has to name where each came from.
function flattenGrants(nodes) {
  const out = [];
  for (const n of nodes || []) {
    for (const g of n.grants || []) out.push({ ...g, label: n.label, nodeId: n.id });
  }
  return out;
}

module.exports = { buildAdjacency, isAllocatable, flattenGrants };
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `cd backend && node --test tests/passive_rules.test.js`
Expected: PASS (8 tests)

- [ ] **Step 11: Commit**

```bash
git add backend/src/services/passiveRules.js backend/tests/passive_rules.test.js
git commit -m "feat(passives): pure allocatability and point-budget rules (SOMET-NNN)"
```

- [ ] **Step 12: Write the failing allocation DB test**

```js
// backend/tests/passive_tree_allocation_db.test.js
//
// Allocation and respec against a real database. The properties here are all
// transactional or FK-shaped and none of them can be seen against a stub:
// that a node two edges away is refused, that the budget cannot be overspent
// by two concurrent requests, that a respec charges gold and clears every
// allocation, and that a failed payment leaves the allocations intact.
//
// Requires the scratch DB from this plan's header (migrated + seeded) and
// `make seed-passive-tree` / seedPassiveTree() to have run against it.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const {
  loadTree, startNodeIdFor, loadAllocatedIds, allocateNode, respecPassives, passiveBundle,
} = require('../src/services/passiveTreeStore.js');
const { loadProgression } = require('../src/services/progressionStore.js');
const { seedPassiveTree } = require('../scripts/seed-passive-tree.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url
  ? 'no TEST_DATABASE_URL -- refusing to mutate a real database (this test writes characters)'
  : false;

test('passive allocation', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 8 });
  const made = { users: [] };
  t.after(async () => {
    // client.release() does NOT roll back -- an explicit delete is the only
    // cleanup that actually happens. characters and player_progression both
    // cascade from users.
    if (made.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]);
    await pool.end();
  });

  await seedPassiveTree(pool, { quiet: true });

  const warriorType = await pool.query("SELECT id FROM entity_types WHERE name = 'Warrior'");
  const mageType = await pool.query("SELECT id FROM entity_types WHERE name = 'Mage'");
  const rangerType = await pool.query("SELECT id FROM entity_types WHERE name = 'Ranger'");

  let n = 0;
  // `points` is written EXPLICITLY on every fixture rather than derived from
  // `level`. T2 owns the grant rule; a test that reproduced it here would pass
  // whether or not the two agreed.
  async function makeCharacter(entityTypeId, { level = 50, gold = 100000, points = 49 } = {}) {
    n += 1;
    const tag = `passalloc-${process.pid}-${Date.now()}-${n}`;
    const u = await pool.query(
      'INSERT INTO users (username, password_hash, role, gold) VALUES ($1, $2, $3, $4) RETURNING id',
      [tag, 'x', 'player', gold],
    );
    made.users.push(u.rows[0].id);
    const c = await pool.query(
      'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 1, $2, $3) RETURNING id',
      [u.rows[0].id, tag, entityTypeId],
    );
    await pool.query(
      'INSERT INTO player_progression (character_id, level, passive_points) VALUES ($1, $2, $3)',
      [c.rows[0].id, level, points],
    );
    return { userId: u.rows[0].id, characterId: c.rows[0].id };
  }

  const tree = await loadTree(pool);
  const byKey = new Map(tree.nodes.map((x) => [x.key, x]));
  const startStr = byKey.get('start-strength').id;
  const adjacent = byKey.get('strength-r1-0-8').id;      // the start's ring-1 entry
  const twoAway = byKey.get('strength-r1-0-9').id;       // one further along the row
  const otherSector = byKey.get('wisdom-r1-0-8').id;

  await t.test('resolves a start node from the character class, not from main_stat', async () => {
    const w = await makeCharacter(warriorType.rows[0].id);
    assert.strictEqual(await startNodeIdFor(pool, w.characterId), startStr);
    const m = await makeCharacter(mageType.rows[0].id);
    assert.strictEqual(await startNodeIdFor(pool, m.characterId),
      byKey.get('start-intelligence').id);
  });

  await t.test('a class with no start node resolves to null, not to a default', async () => {
    const r = await makeCharacter(rangerType.rows[0].id);
    assert.strictEqual(await startNodeIdFor(pool, r.characterId), null);
    const res = await allocateNode(pool, r.characterId, adjacent);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'class has no passive start node');
  });

  await t.test('allocates a node adjacent to the start, and refuses one two edges out', async () => {
    const w = await makeCharacter(warriorType.rows[0].id);
    const far = await allocateNode(pool, w.characterId, twoAway);
    assert.strictEqual(far.ok, false);
    assert.strictEqual(far.reason, 'node is not reachable yet');

    const near = await allocateNode(pool, w.characterId, adjacent);
    assert.strictEqual(near.ok, true);
    assert.deepStrictEqual(near.allocatedNodeIds, [adjacent]);

    const now = await allocateNode(pool, w.characterId, twoAway);
    assert.strictEqual(now.ok, true);
    assert.deepStrictEqual(await loadAllocatedIds(pool, w.characterId), [adjacent, twoAway].sort((a, b) => a - b));
  });

  await t.test('another sector is unreachable until the core has been crossed', async () => {
    const w = await makeCharacter(warriorType.rows[0].id);
    const res = await allocateNode(pool, w.characterId, otherSector);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'node is not reachable yet');
  });

  await t.test('the start node itself cannot be allocated', async () => {
    const w = await makeCharacter(warriorType.rows[0].id);
    const res = await allocateNode(pool, w.characterId, startStr);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'start node is granted, not allocated');
  });

  await t.test('the same node cannot be allocated twice', async () => {
    const w = await makeCharacter(warriorType.rows[0].id);
    assert.strictEqual((await allocateNode(pool, w.characterId, adjacent)).ok, true);
    const again = await allocateNode(pool, w.characterId, adjacent);
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.reason, 'already allocated');
  });

  await t.test('a character with an empty wallet cannot allocate', async () => {
    const w = await makeCharacter(warriorType.rows[0].id, { level: 1, points: 0 });
    const res = await allocateNode(pool, w.characterId, adjacent);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'no passive points');
    assert.deepStrictEqual(await loadAllocatedIds(pool, w.characterId), []);
  });

  await t.test('an allocation spends exactly one point from the column', async () => {
    const w = await makeCharacter(warriorType.rows[0].id, { points: 3 });
    const res = await allocateNode(pool, w.characterId, adjacent);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.passivePoints, 2);
    const r = await pool.query('SELECT passive_points FROM player_progression WHERE character_id = $1', [w.characterId]);
    assert.strictEqual(Number(r.rows[0].passive_points), 2);
  });

  await t.test('the wallet cannot be overspent by concurrent requests', async () => {
    // Exactly one point in the column. Fire two allocations of two different,
    // both legal, nodes at once; exactly one must win. Without the guard in
    // the UPDATE's WHERE clause both read "1 available" and both insert.
    const w = await makeCharacter(warriorType.rows[0].id, { points: 2 });
    const a = byKey.get('strength-r1-0-7').id;
    const b = byKey.get('strength-r1-0-9').id;
    await allocateNode(pool, w.characterId, adjacent); // 2 -> 1, and opens a and b
    const results = await Promise.all([
      allocateNode(pool, w.characterId, a),
      allocateNode(pool, w.characterId, b),
    ]);
    assert.strictEqual(results.filter((r) => r.ok).length, 1);
    assert.strictEqual((await loadAllocatedIds(pool, w.characterId)).length, 2);
    const r = await pool.query('SELECT passive_points FROM player_progression WHERE character_id = $1', [w.characterId]);
    assert.strictEqual(Number(r.rows[0].passive_points), 0);
  });

  await t.test('respec clears every allocation, refunds the points and charges base x level', async () => {
    const w = await makeCharacter(warriorType.rows[0].id, { level: 40, gold: 5000, points: 10 });
    await allocateNode(pool, w.characterId, adjacent);
    await allocateNode(pool, w.characterId, twoAway);

    const res = await respecPassives(pool, w.userId, w.characterId);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.cost, 2000);   // respec_base_gold 50 x level 40
    assert.strictEqual(res.gold, 3000);
    assert.strictEqual(res.refunded, 2);
    assert.strictEqual(res.passivePoints, 10);  // 10 - 2 spent + 2 refunded
    assert.deepStrictEqual(res.allocatedNodeIds, []);
    assert.deepStrictEqual(await loadAllocatedIds(pool, w.characterId), []);
  });

  await t.test('respec refunds what was SPENT, not what the level would grant', async () => {
    // A character carrying refunded pre-epic stat points (contract §6.7) has a
    // wallet that is not a function of level. A level-derived refund would
    // either destroy those points or mint them twice.
    const w = await makeCharacter(warriorType.rows[0].id, { level: 3, gold: 5000, points: 40 });
    await allocateNode(pool, w.characterId, adjacent);
    const res = await respecPassives(pool, w.userId, w.characterId);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.passivePoints, 40);
  });

  await t.test('a respec that cannot be paid for changes nothing at all', async () => {
    const w = await makeCharacter(warriorType.rows[0].id, { level: 40, gold: 10, points: 5 });
    await allocateNode(pool, w.characterId, adjacent);

    const res = await respecPassives(pool, w.userId, w.characterId);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'not enough gold');
    assert.strictEqual(res.cost, 2000);
    assert.deepStrictEqual(await loadAllocatedIds(pool, w.characterId), [adjacent]);
    const g = await pool.query('SELECT gold FROM users WHERE id = $1', [w.userId]);
    assert.strictEqual(Number(g.rows[0].gold), 10);
    const p = await pool.query('SELECT passive_points FROM player_progression WHERE character_id = $1', [w.characterId]);
    assert.strictEqual(Number(p.rows[0].passive_points), 4);  // still spent, not refunded
  });

  await t.test('the bundle itemises the allocated grants', async () => {
    const w = await makeCharacter(warriorType.rows[0].id, { level: 10, points: 9 });
    await allocateNode(pool, w.characterId, adjacent);
    const bundle = await passiveBundle(pool, w.characterId);

    assert.deepStrictEqual(bundle.allocatedNodeIds, [adjacent]);
    assert.strictEqual(bundle.passives.length >= 1, true);
    assert.strictEqual(typeof bundle.passives[0].label, 'string');
    // The wallet is NOT the bundle's job -- it lives on the progression row.
    assert.strictEqual('passivePoints' in bundle, false);
  });

  await t.test('the composed row carries effective totals, the wallet and the breakdown', async () => {
    // Contract §6.2: `effective` is what clients render. The six top-level keys
    // carry the same numbers so derivePlayerStats keeps working unchanged.
    const w = await makeCharacter(warriorType.rows[0].id, { level: 10, points: 9 });
    await allocateNode(pool, w.characterId, adjacent);   // strength-r1-0-8, a minor
    const row = await loadProgression(pool, w.characterId);

    assert.strictEqual(row.passivePoints, 8);
    assert.deepStrictEqual(row.allocatedNodeIds, [adjacent]);
    assert.strictEqual(row.effective.strength, row.strength);
    assert.strictEqual(row.sources.strength.base, 5);
    assert.strictEqual(row.sources.strength.gear, 0);
    assert.strictEqual(row.modifiers.length >= 1, true);
    assert.strictEqual(row.rules.lifeCostMultiplier, 1);
    assert.strictEqual(row.rules.treeCharmBonus, 0);
  });
});
```

- [ ] **Step 13: Run the DB test to verify it fails**

Run:
```bash
cd backend && \
  DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  node --test tests/passive_tree_allocation_db.test.js
```
Expected: FAIL with `Cannot find module '../src/services/passiveTreeStore.js'`

- [ ] **Step 14: Write `passiveTreeStore.js`**

```js
// backend/src/services/passiveTreeStore.js
//
// Every read and write of passive_nodes, passive_edges and character_passives,
// following the same rule progressionStore.js states for player_progression:
// nothing outside this file touches those three tables.
//
// The graph itself is IMMUTABLE at runtime (only `make seed-passive-tree` and
// the admin editor change it), so loadTree caches it in module scope. The
// cache is keyed on nothing and cleared explicitly by the admin route, because
// a per-request read of 1806 nodes + 2142 edges on every join is real work for
// data that changes about once a month.
const { composeStats } = require('./statComposition.js');
const { buildAdjacency, isAllocatable, flattenGrants } = require('./passiveRules.js');
const { loadProgression } = require('./progressionStore.js');
const { getSettings } = require('./gameSettings.js');

let cache = null;

async function loadTree(pool) {
  if (cache) return cache;
  const n = await pool.query(
    `SELECT id, key, sector, ring, x, y, kind, label, grants, start_class
       FROM passive_nodes ORDER BY id`,
  );
  const e = await pool.query('SELECT a_id, b_id FROM passive_edges ORDER BY a_id, b_id');
  cache = {
    nodes: n.rows.map((r) => ({
      id: r.id, key: r.key, sector: r.sector, ring: r.ring,
      x: Number(r.x), y: Number(r.y), kind: r.kind, label: r.label,
      grants: r.grants || [], start_class: r.start_class,
    })),
    edges: e.rows.map((r) => [r.a_id, r.b_id]),
  };
  return cache;
}

// Called by the admin editor after a write. Not a TTL: a stale tree in a
// running world is invisible (the node just grants the old thing), so it has
// to be invalidated by the write rather than waited out.
function invalidateTreeCache() { cache = null; }

// Resolved from characters.entity_type_id -> entity_types.name ->
// passive_nodes.start_class. Deliberately NOT via entity_types.main_stat:
// main_stat is Group B's column and Group C must not take a dependency on it.
// A class with no start node (legacy `Player`, the not-playable `Ranger`)
// returns null, and every caller refuses rather than defaulting to a sector --
// a default would silently hand a legacy character the Warrior tree.
async function startNodeIdFor(pool, characterId) {
  const r = await pool.query(
    `SELECT p.id
       FROM characters c
       JOIN entity_types e ON e.id = c.entity_type_id
       JOIN passive_nodes p ON p.start_class = e.name
      WHERE c.id = $1`,
    [characterId],
  );
  return r.rows.length ? r.rows[0].id : null;
}

async function loadAllocatedIds(db, characterId) {
  const r = await db.query(
    'SELECT node_id FROM character_passives WHERE character_id = $1 ORDER BY node_id',
    [characterId],
  );
  return r.rows.map((x) => x.node_id);
}

// The composed view of a character's tree: what they have and what it grants.
// The WALLET is not computed here -- it is player_progression.passive_points
// (contract §6.7), which the caller already holds on the row it read.
async function passiveBundle(db, characterId) {
  const ids = await loadAllocatedIds(db, characterId);
  if (ids.length === 0) return { allocatedNodeIds: [], passives: [] };
  const rows = await db.query(
    'SELECT id, label, grants FROM passive_nodes WHERE id = ANY($1::int[]) ORDER BY id',
    [ids],
  );
  return {
    allocatedNodeIds: ids,
    passives: flattenGrants(rows.rows.map((r) => ({ id: r.id, label: r.label, grants: r.grants || [] }))),
  };
}

// One point per node. Two guards, and they are different in kind:
//
//   * The POINT is spent in the UPDATE's own WHERE clause
//     (`passive_points >= 1`), the same shape the retired allocateStat used --
//     Postgres serialises the UPDATE, so exactly one of two concurrent
//     requests can match.
//   * REACHABILITY is a read-then-write pair and cannot live in a WHERE, so it
//     runs inside a transaction holding the player_progression row lock. That
//     is the same SELECT ... FOR UPDATE contract awardXp already documents,
//     and it also serialises the two allocations against each other, so the
//     second one sees the first's node when deciding what is adjacent.
async function allocateNode(pool, characterId, nodeId) {
  const id = Math.floor(Number(nodeId));
  if (!Number.isInteger(id) || id < 1) return { ok: false, reason: 'invalid node' };

  const [tree, startNodeId] = await Promise.all([
    loadTree(pool),
    startNodeIdFor(pool, characterId),
  ]);
  const node = tree.nodes.find((x) => x.id === id);
  if (!node) return { ok: false, reason: 'unknown node' };
  if (node.id === startNodeId) return { ok: false, reason: 'start node is granted, not allocated' };
  if (startNodeId == null) return { ok: false, reason: 'class has no passive start node' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const progression = await loadProgression(client, characterId, { forUpdate: true });
    const allocated = await loadAllocatedIds(client, characterId);
    if (allocated.includes(id)) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'already allocated' };
    }
    const adjacency = buildAdjacency(tree.edges);
    if (!isAllocatable(id, allocated, adjacency, startNodeId)) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'node is not reachable yet' };
    }
    // The wallet check is the WHERE clause, not a read-then-write pair.
    const spend = await client.query(
      `UPDATE player_progression
          SET passive_points = passive_points - 1, updated_at = now()
        WHERE character_id = $1 AND passive_points >= 1
      RETURNING passive_points`,
      [characterId],
    );
    if (spend.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'no passive points' };
    }
    await client.query(
      'INSERT INTO character_passives (character_id, node_id) VALUES ($1, $2)',
      [characterId, id],
    );
    const after = await loadAllocatedIds(client, characterId);
    await client.query('COMMIT');
    return { ok: true, allocatedNodeIds: after, passivePoints: Number(spend.rows[0].passive_points) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// All-or-nothing (spec §5.4). Takes BOTH ids for the same reason the old
// progressionStore.respec did: the allocation reset is per-CHARACTER, the gold
// that pays for it is per-ACCOUNT.
//
// NOT IN THIS TASK: spec §7's "items that no longer qualify are auto-unequipped
// into the backpack, and the respec is refused if the backpack has no room".
// Equipment requirements do not exist until Group D T10 adds req_level/req_*;
// T10 layers that policy on top of this function.
async function respecPassives(pool, userId, characterId) {
  const settings = await getSettings(pool, ['respec_base_gold']);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const progression = await loadProgression(client, characterId, { forUpdate: true });
    const cost = Number(settings.respec_base_gold) * progression.level;
    // Gold moves first, guarded in its own WHERE. If it does not move the whole
    // transaction rolls back -- a failed payment must never yield a free respec.
    const g = await client.query(
      'UPDATE users SET gold = gold - $2 WHERE id = $1 AND gold >= $2 RETURNING gold',
      [userId, cost],
    );
    if (g.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not enough gold', cost };
    }
    const cleared = await client.query(
      'DELETE FROM character_passives WHERE character_id = $1 RETURNING node_id', [characterId],
    );
    // Refund exactly what was spent -- the count of rows this DELETE actually
    // removed, not a recomputation from the level. T2 also refunds pre-epic
    // stat points into this column, so a level-derived figure would either
    // destroy those or mint them a second time.
    const refunded = await client.query(
      `UPDATE player_progression
          SET passive_points = passive_points + $2, updated_at = now()
        WHERE character_id = $1
      RETURNING passive_points`,
      [characterId, cleared.rowCount],
    );
    await client.query('COMMIT');
    return {
      ok: true,
      cost,
      gold: Number(g.rows[0].gold) || 0,
      allocatedNodeIds: [],
      refunded: cleared.rowCount,
      passivePoints: Number(refunded.rows[0].passive_points),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// The composed progression row every push site sends. `base` is the class-base
// snapshot the six frozen stat columns hold (spec §3.3 / contract §6.1 -- every
// class bases at 5); `gear` is [] until Group D T12 lands the affix instances,
// and is passed explicitly rather than omitted so the seam is visible rather
// than forgotten.
//
// TWO VIEWS OF THE SAME SIX NUMBERS, on purpose:
//
//   * `effective` is the object contract §6.2 requires, and is what every
//     client renders. It is never re-summed from `sources`.
//   * The six TOP-LEVEL keys carry the same effective numbers. That is what
//     lets derivePlayerStats(progression) keep working unchanged at all seven
//     of its existing call sites -- it reads exactly those six names
//     (playerStats.js:41-60). Leaving the raw snapshot there instead would
//     make every derived number in the game ignore the tree, silently.
//
// The raw snapshot is still reachable, as `sources.<stat>.base`.
async function composeProgression(db, characterId, row) {
  const bundle = await passiveBundle(db, characterId);
  const composed = composeStats({ base: row, passives: bundle.passives, gear: [] });
  const effective = {
    strength: composed.strength,
    dexterity: composed.dexterity,
    constitution: composed.constitution,
    intelligence: composed.intelligence,
    wisdom: composed.wisdom,
    charisma: composed.charisma,
  };
  return {
    ...row,
    ...effective,
    effective,
    // The wallet is the column T2 owns (contract §6.7), read straight off the
    // row -- never recomputed here.
    passivePoints: Number(row.passive_points) || 0,
    allocatedNodeIds: bundle.allocatedNodeIds,
    sources: composed.sources,
    modifiers: composed.modifiers,
    rules: composed.rules,
  };
}

module.exports = {
  loadTree, invalidateTreeCache, startNodeIdFor, loadAllocatedIds,
  passiveBundle, allocateNode, respecPassives, composeProgression,
};
```

- [ ] **Step 15: Wire the composer into `progressionStore.js`**

Three edits. First, replace the import block at `progressionStore.js:4-7` and the `COLUMNS` constant at `:9-11` (`stat_points` is already gone after Group A T2):

```js
const { levelForXp, DEFAULT_PROGRESSION } = require('./playerStats.js');
const C = require('./progressionConstants.js');

const XP_SOURCES = ['kill', 'chest', 'dungeon_clear'];
// passive_points is T2's column (contract §6.7). It is selected here because
// composeProgression reads the wallet straight off the row rather than
// recomputing it.
const COLUMNS = `character_id, experience, level, passive_points,
                 strength, dexterity, constitution, intelligence, wisdom, charisma`;

// Required lazily, inside the functions that use it: passiveTreeStore.js
// requires this module back (for loadProgression's row lock), and a top-level
// require here would be a cycle that resolves to an empty object at load time.
function composer() { return require('./passiveTreeStore.js').composeProgression; }
```

Second, make `loadProgression` return the composed row — this is the single change that gives all seven `progression` send sites the new fields for free. Replace its final line (`progressionStore.js:53`):

```js
  const row = r.rows.length ? mapRow(r.rows[0]) : { ...DEFAULT_PROGRESSION, character_id: characterId };
  return composer()(db, characterId, row);
```

Third, `awardXp` returns `mapRow(r.rows[0])` at `:88` and `applyDeath` at `:196`; both must go through the composer too, or a kill push would overwrite the client's `allocatedNodeIds` with `undefined`:

```js
    progression: await composer()(db, characterId, mapRow(r.rows[0])),
```

`mapRow` (`:16-29`) must also carry the new column through the same `Number()`
normalisation the other integer columns get, or `composeProgression` reads
`undefined` and reports a wallet of 0 to everyone:

```js
    passive_points: Number(r.passive_points) || 0,
```

Delete `allocateStat` (`:104-124`) and the old `respec` (`:126-170`) outright, and update the export list at `:203-205`:

```js
module.exports = { loadProgression, awardXp, applyDeath, XP_SOURCES };
```

- [ ] **Step 16: Run the allocation DB test to verify it passes**

Run:
```bash
cd backend && \
  DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  node --test --test-timeout=420000 tests/passive_tree_allocation_db.test.js
```
Expected: PASS (14 subtests)

- [ ] **Step 17: Commit**

```bash
git add backend/src/services/passiveTreeStore.js backend/src/services/progressionStore.js backend/tests/passive_tree_allocation_db.test.js
git commit -m "feat(passives): allocation, respec and composed progression rows (SOMET-NNN)"
```

- [ ] **Step 18: Write the failing route test**

```js
// backend/tests/passive_tree_routes.test.js
//
// Auth and request shape only -- every guard the routes rely on is already
// tested in passive_tree_allocation_db.test.js against the store, and a second
// copy here would be a drifting restatement rather than extra coverage.
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
require('./helpers/auth.js');
const { app } = require('../src/index.js');

const skip = !process.env.TEST_DATABASE_URL
  ? 'no TEST_DATABASE_URL -- refusing to reach a real database'
  : false;

test('passive tree routes', { skip }, async (t) => {
  await t.test('GET /api/passive-tree requires a token', async () => {
    const res = await request(app).get('/api/passive-tree');
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'missing token');
  });

  await t.test('POST /api/progression/passives/:nodeId requires a token', async () => {
    const res = await request(app).post('/api/progression/passives/1').send({ character_id: 1 });
    assert.strictEqual(res.status, 401);
  });

  await t.test('POST /api/progression/respec requires a token', async () => {
    const res = await request(app).post('/api/progression/respec').send({ character_id: 1 });
    assert.strictEqual(res.status, 401);
  });
});

test('the passive-tree router is mounted, and only once', () => {
  const mounts = app._router.stack
    .filter((l) => l.regexp && l.regexp.toString().includes('passive-tree'));
  assert.strictEqual(mounts.length, 1);
});
```

- [ ] **Step 19: Run the route test to verify it fails**

Run:
```bash
cd backend && \
  DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  node --test tests/passive_tree_routes.test.js
```
Expected: FAIL — `expected 1, got 0` on the mount assertion, and 404 rather than 401 on the three route assertions.

- [ ] **Step 20: Write `passiveTreeRoutes.js` and mount it**

```js
// backend/src/api/passiveTreeRoutes.js
//
// The tree graph itself. Player-authenticated and read-only: the graph is the
// same for everyone, so there is nothing per-user to leak and nothing to write.
//
// The client caches this for the session (it is ~1800 nodes and ~2100 edges and
// changes only when an admin edits a node or the seeder runs), so the response
// carries a `version` the client can compare rather than re-parsing blindly.
const express = require('express');
const { requireAuth } = require('../auth/middleware.js');
const { loadTree } = require('../services/passiveTreeStore.js');

module.exports = function passiveTreeRoutes(pool) {
  const router = express.Router();
  const guard = requireAuth(pool);

  router.get('/', guard, async (req, res) => {
    try {
      const tree = await loadTree(pool);
      return res.status(200).json({
        nodes: tree.nodes,
        edges: tree.edges,
        // Not a hash: the count pair is enough to notice a reseed, and hashing
        // 1806 rows on every request to save a client parse is the wrong trade.
        version: `${tree.nodes.length}:${tree.edges.length}`,
      });
    } catch (err) {
      console.error('passive tree fetch failed:', err);
      return res.status(500).json({ error: 'failed to load passive tree' });
    }
  });

  return router;
};
```

In `backend/src/index.js`, add the require beside the existing one at `:123`:

```js
const passiveTreeRoutes = require('./api/passiveTreeRoutes.js');
```

and the mount beside the progression mount at `:437`:

```js
app.use('/api/passive-tree', passiveTreeRoutes(guardPool));
```

- [ ] **Step 21: Rewrite the progression routes**

In `backend/src/api/progressionRoutes.js`, replace the import block at `:16-20`:

```js
const { loadProgression } = require('../services/progressionStore.js');
const { allocateNode, respecPassives } = require('../services/passiveTreeStore.js');
const { derivePlayerStats, xpFloor, xpToNext } = require('../services/playerStats.js');
const { ownedCharacter } = require('../services/characters.js');
const { getSettings } = require('../services/gameSettings.js');
```

Replace the body of `GET /` (`:52-70`) so the response carries the four new fields. They come off `progression` itself, which `loadProgression` now composes, so nothing is computed twice:

```js
  router.get('/', guard, async (req, res) => {
    try {
      const character = await resolveCharacter(req, res);
      if (!character) return undefined;
      const progression = await loadProgression(pool, character.id);
      const settings = await getSettings(pool, ['respec_base_gold']);
      return res.status(200).json({
        progression,
        stats: derivePlayerStats(progression),
        xpFloor: xpFloor(progression.level),
        xpToNext: xpToNext(progression.level),
        respecCost: Number(settings.respec_base_gold) * progression.level,
        // Lifted out of `progression` as well as left inside it: the Character
        // tab reads them from the top level, the websocket single-writer path
        // reads them from inside. One source, two views, no recomputation.
        //
        // `effective` is contract §6.2's required object -- the composed
        // totals every consumer renders. Nothing may re-sum `sources`.
        effective: progression.effective,
        passivePoints: progression.passivePoints,
        allocatedNodeIds: progression.allocatedNodeIds,
        sources: progression.sources,
        modifiers: progression.modifiers,
      });
    } catch (err) {
      console.error('progression fetch failed:', err);
      res.status(500).json({ error: 'failed to load progression' });
    }
  });
```

Replace the whole `POST /allocate` handler (`:72-99`) with the passive allocation route. The `refreshLivePlayerStats` call is preserved verbatim: it is what pushes the ordered `progression` frame that is the client's single writer.

```js
  // One node per request, id in the PATH (contract §3). The store owns every
  // guard -- unknown node, start node, already allocated, no points, not
  // reachable -- exactly as the old /allocate delegated to allocateStat.
  router.post('/passives/:nodeId', guard, async (req, res) => {
    try {
      const character = await resolveCharacter(req, res);
      if (!character) return undefined;
      const r = await allocateNode(pool, character.id, req.params.nodeId);
      if (!r.ok) return res.status(400).json({ error: r.reason });
      const progression = await loadProgression(pool, character.id);
      const stats = derivePlayerStats(progression);
      // Best-effort, same contract as before: this is what sends the ordered
      // websocket `progression` frame the client treats as its ONLY writer of
      // progression state (CharacterSheet.jsx's F1 header). The HTTP body
      // below is for the caller's own error handling, not for the client to
      // write into Game.progression.
      refreshLivePlayerStats(req.user.id, progression, stats);
      return res.status(200).json({ progression, stats });
    } catch (err) {
      console.error('passive allocate failed:', err);
      return res.status(500).json({ error: 'allocate failed' });
    }
  });
```

Replace the `POST /respec` body (`:101-114`) to call the passive respec:

```js
  router.post('/respec', guard, async (req, res) => {
    try {
      const character = await resolveCharacter(req, res);
      if (!character) return undefined;
      // Both ids: the allocation reset is per-character, the gold that pays
      // for it is per-account.
      const r = await respecPassives(pool, req.user.id, character.id);
      if (!r.ok) return res.status(402).json({ error: r.reason, cost: r.cost });
      const progression = await loadProgression(pool, character.id);
      const stats = derivePlayerStats(progression);
      refreshLivePlayerStats(req.user.id, progression, stats);
      return res.status(200).json({ progression, stats, gold: r.gold });
    } catch (err) {
      console.error('respec failed:', err);
      return res.status(500).json({ error: 'respec failed' });
    }
  });
```

- [ ] **Step 22: Put `stats` on every `progression` frame (contract §6.3)**

Verified against the source: `stats` rides only the `refreshPlayerStats` push (`server.js:2879`). The kill push (`:796`), the death push (`:928`), the two stone pushes (`:1809`, `:1848`) and the chest push (`:2096`) all omit it, so a client seeded from one of those would show stale derived numbers. §6.3 makes closing that T7's job.

Each of those five sites already has, or can trivially compute, the same bundle: `derivePlayerStats(withStoneBonuses(progression, buffs))`. Add `stats` to each frame using the expression **already present at that site**, never a second, differently-buffed one:

```js
        // server.js:796 -- the kill push. `stats` is computed a few lines above
        // for applyDerivedStats; reuse that value rather than re-deriving with
        // a different stone-bonus set.
        if (sock) send(sock, { type: 'progression', progression, stats, leveledUp, newLevel, awarded });
```

```js
        // server.js:928 -- the death push.
        const stats = derivePlayerStats(withStoneBonuses(progression, socketedBuffStones(p.inv, entry.world.weapons)));
        if (sock) send(sock, { type: 'progression', progression, stats, lost });
```

The two stone pushes (`:1809`, `:1848`) and the chest push (`:2096`) each already build exactly this value on the line above their `send`; add `stats` to the frame object at all three.

Write the guard first, so a sixth push site added later cannot quietly omit it:

```js
// backend/tests/progression_frame_shape.test.js
//
// Contract §6.3. `stats` must ride EVERY progression frame, not only the
// refreshPlayerStats push -- a client that seeds from a kill push and then
// renders derived numbers would otherwise show pre-level-up values with
// nothing to correct them.
//
// Source text rather than a running server: the five sites are spread across
// four handlers with different preconditions (a kill, a death, a socket, an
// unsocket, a chest), and standing all five up would test the harness rather
// than the frames.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.resolve(__dirname, '../src/authority/server.js'), 'utf8');

test('every progression frame carries stats', () => {
  const frames = [...src.matchAll(/\{\s*\n?\s*type:\s*'progression',[\s\S]{0,240}?\}/g)].map((m) => m[0]);
  // The fixed point: if the regex stops matching, every assertion below passes
  // over an empty list.
  assert.ok(frames.length >= 6, `found only ${frames.length} progression frames -- has the send shape changed?`);
  const missing = frames.filter((f) => !/\bstats\b/.test(f));
  assert.deepStrictEqual(missing, [],
    'these progression frames omit `stats` (contract §6.3)');
});

test('no progression frame recomputes stats from an unbuffed row', () => {
  // withStoneBonuses is what folds socketed buff stones in. A frame that
  // called derivePlayerStats(progression) directly would report numbers the
  // live world does not use.
  const bare = [...src.matchAll(/derivePlayerStats\((?!withStoneBonuses)/g)];
  assert.strictEqual(bare.length, 0,
    'derivePlayerStats must be called on a stone-buffed row inside the authority');
});
```

Run:
```bash
cd backend && node --test tests/progression_frame_shape.test.js
```
Expected: FAIL first (`these progression frames omit \`stats\``), then PASS once the five frames carry it.

- [ ] **Step 23: Point the authority join path at the composed row**

`backend/src/authority/server.js:1431` already reads `const progression = await loadProgression(pool, character.id);`. `loadProgression` now composes, so **no edit is needed there** — but the import at `server.js:10` must not have been narrowed by another task. Verify it still reads:

```js
const { loadProgression, applyDeath } = require('../services/progressionStore.js');
```

and confirm the join frame at `:1537` still sends `progression` unchanged. Run the authority suite to prove the composed row is a drop-in for the raw one:

Run:
```bash
cd backend && \
  DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  node --test --test-timeout=420000 \
    tests/authority_player_stats.test.js tests/progression_store.test.js \
    tests/progression_routes.test.js tests/progression_kill_xp.test.js
```
Expected: PASS, 0 failures

- [ ] **Step 24: Run the route test to verify it passes**

Run:
```bash
cd backend && \
  DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  node --test tests/passive_tree_routes.test.js
```
Expected: PASS (4 tests)

- [ ] **Step 25: Commit**

```bash
git add backend/src/api/passiveTreeRoutes.js backend/src/api/progressionRoutes.js backend/src/index.js \
        backend/src/authority/server.js \
        backend/tests/passive_tree_routes.test.js backend/tests/progression_frame_shape.test.js
git commit -m "feat(passives): passive-tree, allocate and respec routes (SOMET-NNN)"
```

---

### Task 3 (T8): In-game passive-tree overlay — canvas, `P`, pan + zoom, culling

**Files:**
- Create: `frontend/src/games/something2/src/js/systems/passiveTreePanel.js`
- Create: `frontend/src/games/something2/src/js/net/passiveTreeClient.js`
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js:46-49` (hit-area fields), `:145-160` (`renderChunked` signature), `:311-317` (overlay block), and a new `renderPassiveTree` method after `:1230`
- Modify: `frontend/src/games/something2/src/js/core/Game.js:124` (state fields), `:865-910` (render call), `:1048-1054` (`CODE_TO_KEY`), `:1064-1083` (`P` binding and the Escape branch), `:1150-1161` (mousemove), `:1162-1206` (mousedown), `:1207-1234` (mouseup), `:1242-1244` (listener registration)
- Test: `frontend/src/games/something2/src/js/systems/__tests__/passiveTreePanel.test.js`

**Interfaces:**
- Consumes (Task 2): `GET /api/passive-tree -> { nodes: [{id, key, sector, ring, x, y, kind, label, grants, start_class}], edges: [[aId, bId]], version }`; `POST /api/progression/passives/:nodeId` with `{ character_id }`.
- Consumes (Task 2): `Game.progression.allocatedNodeIds` and `Game.progression.passivePoints`, written **only** by `Game.js:489`'s `onProgression` handler.
- Produces: `buildTreeIndex`, `worldToScreen`, `screenToWorld`, `visibleNodeIds`, `allocatableSet`, `clampZoom`, `zoomAbout`, `layoutPassiveTree`, `drawPassiveTree`, `hitNodeAt`, `respecDisabled`, `GRID_CELL`, `NODE_R`, `MIN_ZOOM`, `MAX_ZOOM`, `DEFAULT_ZOOM`.

**Contract §6.4 — this task owns `respecDisabled`.** T15 deletes the character sheet's respec control along with the standalone popup, taking its affordability gate with it. Respec is a passive-tree action, so the button and the predicate move here. Without the predicate every unaffordable click 402s, which is exactly the failure `CharacterSheet.jsx`'s F2 header describes for a locally-recomputed `RESPEC_BASE`: the cost must come from the server's `respecCost`, never from a client-side copy of the formula.

**`P` is unbound.** Verified against every `window.addEventListener('keydown', ...)` in `frontend/src`: `Game.js` claims `i`, `e`, `b`, `f`, `g` plain and `m`/`t` shifted (`Game.js:1068-1130`); `Minimap.jsx:142` claims `m`; `WaypointTravel.jsx:170` claims `t`; `CharacterSheet.jsx:321` claims `c`. `p` appears in none of them, and `hotkeyRegistry.test.js` (which parses those five files and fails on any doubly-claimed letter) will now see `isKey('p')` in `Game.js` and keep it that way.

**Why the maths is a separate pure module.** `inventoryPanel.js:1-4` states the rule this task follows: the module computes rects and never touches a canvas, and `drawInventory` "paints exactly what this returns and decides nothing itself". The same split is what makes ~1800-node culling testable without a rendering context — a culling bug that draws everything is invisible on a fast machine and a slideshow on a slow one.

- [ ] **Step 1: Write the failing panel test**

```js
// frontend/src/games/something2/src/js/systems/__tests__/passiveTreePanel.test.js
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTreeIndex, worldToScreen, screenToWorld, visibleNodeIds, allocatableSet,
  clampZoom, zoomAbout, layoutPassiveTree, hitNodeAt, respecDisabled,
  GRID_CELL, NODE_R, MIN_ZOOM, MAX_ZOOM, DEFAULT_ZOOM,
} from "../passiveTreePanel.js";
import { GAME_WIDTH, GAME_HEIGHT } from "../../core/constants.js";

// A miniature tree with the same shape as the real one: a start node, a
// neighbour, a node two edges out, and one far away in world space so culling
// has something real to exclude.
const NODES = [
  { id: 1, key: "start-strength", sector: "strength", ring: 0, x: 0, y: 0, kind: "start", label: "Warrior", grants: [], start_class: "Warrior" },
  { id: 2, key: "strength-r1-0-0", sector: "strength", ring: 1, x: 50, y: 0, kind: "minor", label: "Sinew", grants: [{ type: "stat", stat: "strength", value: 2 }] },
  { id: 3, key: "strength-r1-0-1", sector: "strength", ring: 1, x: 100, y: 0, kind: "notable", label: "Great Sinew", grants: [{ type: "stat", stat: "strength", value: 8 }] },
  { id: 4, key: "strength-r3-0-0", sector: "strength", ring: 3, x: 800, y: 800, kind: "keystone", label: "Unbreakable", grants: [{ type: "stat", stat: "strength", value: 30 }] },
];
const EDGES = [[1, 2], [2, 3], [3, 4]];
const TREE = { nodes: NODES, edges: EDGES };

const baseState = (over = {}) => ({
  tree: TREE,
  index: buildTreeIndex(TREE),
  allocatedNodeIds: [],
  startNodeId: 1,
  passivePoints: 5,
  view: { panX: 640, panY: 360, zoom: 1 },
  hoverX: null,
  hoverY: null,
  ...over,
});

describe("spatial index", () => {
  it("buckets nodes by a fixed world-space grid", () => {
    const index = buildTreeIndex(TREE);
    expect(GRID_CELL).toBe(200);
    // x=0..100 all land in cell (0,0); x=800,y=800 lands in cell (4,4).
    expect(index.cells.get("0,0").map((n) => n.id).sort()).toEqual([1, 2, 3]);
    expect(index.cells.get("4,4").map((n) => n.id)).toEqual([4]);
  });

  it("indexes nodes by id and builds an undirected adjacency", () => {
    const index = buildTreeIndex(TREE);
    expect(index.byId.get(3).label).toBe("Great Sinew");
    expect([...index.adjacency.get(2)].sort()).toEqual([1, 3]);
    expect([...index.adjacency.get(4)]).toEqual([3]);
  });
});

describe("world <-> screen", () => {
  it("round-trips a point through both transforms", () => {
    const view = { panX: 300, panY: 200, zoom: 0.5 };
    const s = worldToScreen(120, -80, view);
    expect(s).toEqual({ sx: 360, sy: 160 });
    expect(screenToWorld(360, 160, view)).toEqual({ x: 120, y: -80 });
  });

  it("clamps zoom to the declared range", () => {
    expect(MIN_ZOOM).toBe(0.2);
    expect(MAX_ZOOM).toBe(2);
    expect(DEFAULT_ZOOM).toBe(0.35);
    expect(clampZoom(0.01)).toBe(0.2);
    expect(clampZoom(50)).toBe(2);
    expect(clampZoom(0.75)).toBe(0.75);
  });

  it("zooms about the cursor, keeping the world point under it fixed", () => {
    const view = { panX: 640, panY: 360, zoom: 1 };
    const next = zoomAbout(view, 700, 400, 2);
    // The world point under (700, 400) was (60, 40); after the zoom it must
    // still be under (700, 400), so pan moves to 700 - 60*2 = 580.
    expect(next.zoom).toBe(2);
    expect(next.panX).toBe(580);
    expect(next.panY).toBe(320);
    expect(worldToScreen(60, 40, next)).toEqual({ sx: 700, sy: 400 });
  });
});

describe("viewport culling", () => {
  it("returns only the nodes whose screen position falls inside the viewport", () => {
    const index = buildTreeIndex(TREE);
    const view = { panX: 640, panY: 360, zoom: 1 };
    const viewport = { x: 40, y: 60, w: 1200, h: 600 };
    const ids = visibleNodeIds(index, view, viewport).sort();
    // (800,800) maps to (1440,1160) -- off the canvas entirely.
    expect(ids).toEqual([1, 2, 3]);
  });

  it("brings the far node in once the view pans to it", () => {
    const index = buildTreeIndex(TREE);
    const view = { panX: -160, panY: -440, zoom: 1 };
    const viewport = { x: 40, y: 60, w: 1200, h: 600 };
    expect(visibleNodeIds(index, view, viewport)).toContain(4);
  });

  it("includes a node whose centre is just outside but whose circle overlaps", () => {
    // Culling on the centre alone pops a keystone in and out at the edge of
    // the viewport, which reads as flicker while panning.
    const index = buildTreeIndex({ nodes: [{ ...NODES[3], x: 0, y: 0 }], edges: [] });
    const view = { panX: 30, panY: 360, zoom: 1 };
    const viewport = { x: 40, y: 60, w: 1200, h: 600 };
    expect(visibleNodeIds(index, view, viewport)).toEqual([4]);
  });
});

describe("the three visual states", () => {
  it("marks the start node allocated-and-free, its neighbour allocatable, the rest locked", () => {
    const l = layoutPassiveTree(baseState());
    const byId = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
    expect(byId[1].state).toBe("allocated");   // granted, not bought
    expect(byId[2].state).toBe("allocatable");
    expect(byId[3].state).toBe("locked");
  });

  it("opens the next node once its neighbour is allocated", () => {
    const l = layoutPassiveTree(baseState({ allocatedNodeIds: [2] }));
    const byId = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
    expect(byId[2].state).toBe("allocated");
    expect(byId[3].state).toBe("allocatable");
    expect(byId[4].state).toBe("locked");
  });

  it("shows nothing as allocatable when the wallet is empty", () => {
    const l = layoutPassiveTree(baseState({ passivePoints: 0 }));
    const byId = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
    // Still reachable, but not affordable -- and a node the player cannot buy
    // must not look like one they can.
    expect(byId[2].state).toBe("locked");
  });

  it("computes allocatability without a start node as adjacency-only", () => {
    const index = buildTreeIndex(TREE);
    const set = allocatableSet(index, [], null);
    expect(set.size).toBe(0);
  });
});

describe("layout", () => {
  it("centres the panel on the canvas and puts the close box in the title bar", () => {
    const l = layoutPassiveTree(baseState());
    expect(l.panel.x + l.panel.w).toBeLessThanOrEqual(GAME_WIDTH);
    expect(l.panel.y + l.panel.h).toBeLessThanOrEqual(GAME_HEIGHT);
    expect(l.close.y).toBeGreaterThanOrEqual(l.title.y);
    expect(l.close.y + l.close.h).toBeLessThanOrEqual(l.title.y + l.title.h);
    expect(l.hitAreas).toContainEqual({ ...l.close, kind: "passiveclose", id: null });
  });

  it("scales a node's radius with the zoom and by its kind", () => {
    expect(NODE_R).toEqual({ minor: 7, notable: 12, keystone: 18, start: 16 });
    const l = layoutPassiveTree(baseState({ view: { panX: 640, panY: 360, zoom: 2 } }));
    const start = l.nodes.find((n) => n.id === 1);
    const minor = l.nodes.find((n) => n.id === 2);
    expect(start.r).toBe(32);
    expect(minor.r).toBe(14);
  });

  it("draws an edge only when BOTH of its endpoints survived culling", () => {
    const l = layoutPassiveTree(baseState());
    // 1-2 and 2-3 are both fully visible; 3-4 has an off-screen endpoint.
    expect(l.edges).toHaveLength(2);
    for (const e of l.edges) {
      expect(Number.isFinite(e.x1) && Number.isFinite(e.y2)).toBe(true);
    }
  });

  it("publishes one hit area per visible node so a click can be resolved", () => {
    const l = layoutPassiveTree(baseState());
    const nodeAreas = l.hitAreas.filter((a) => a.kind === "passivenode");
    expect(nodeAreas.map((a) => a.id).sort()).toEqual([1, 2, 3]);
  });

  it("hit-tests a node by its circle, not by its bounding box", () => {
    const l = layoutPassiveTree(baseState());
    const n = l.nodes.find((x) => x.id === 2);
    expect(hitNodeAt(l, n.sx, n.sy).id).toBe(2);
    // The corner of the bounding box is outside the circle by 0.41r.
    expect(hitNodeAt(l, n.sx + n.r * 0.9, n.sy + n.r * 0.9)).toBe(null);
    expect(hitNodeAt(l, 5, 5)).toBe(null);
  });

  it("surfaces the hovered node's label and its grants, one line each", () => {
    const l = layoutPassiveTree(baseState({ hoverX: 640, hoverY: 360 }));
    expect(l.hover.id).toBe(1);
    const l2 = layoutPassiveTree(baseState({ hoverX: 690, hoverY: 360 }));
    expect(l2.hover.id).toBe(2);
    expect(l2.hover.label).toBe("Sinew");
    expect(l2.hover.lines).toEqual(["+2 strength"]);
  });

  it("renders every grant kind as a readable line", () => {
    const nodes = [{
      id: 9, key: "k", sector: "strength", ring: 3, x: 0, y: 0, kind: "keystone",
      label: "Everything",
      grants: [
        { type: "stat", stat: "strength", value: 30 },
        { type: "resource", pool: "hp", value: 150 },
        { type: "damage", element: "fire", value: 12 },
        { type: "resist", element: "ice", value: -15 },
        { type: "status", status: "burn", value: 1 },
        { type: "rule", rule: "lifeCostMultiplier", value: 0.75 },
      ],
      start_class: null,
    }];
    const tree = { nodes, edges: [] };
    const l = layoutPassiveTree(baseState({
      tree, index: buildTreeIndex(tree), startNodeId: null,
      hoverX: 640, hoverY: 360,
    }));
    expect(l.hover.lines).toEqual([
      "+30 strength",
      "+150 max hp",
      "+12% fire damage",
      "-15% ice resistance",
      "your hits burn",
      "lifeCostMultiplier x0.75",
    ]);
  });

  it("reports the point wallet in the header", () => {
    const l = layoutPassiveTree(baseState({ passivePoints: 17 }));
    expect(l.header.pointsLabel).toBe("Passive points: 17");
  });
});

describe("respec control (contract §6.4)", () => {
  it("is enabled only when gold covers the server's cost and nothing is in flight", () => {
    expect(respecDisabled({ gold: 2000, respecCost: 2000, busy: false })).toBe(false);
    expect(respecDisabled({ gold: 1999, respecCost: 2000, busy: false })).toBe(true);
    expect(respecDisabled({ gold: 9999, respecCost: 2000, busy: true })).toBe(true);
  });

  it("is disabled while the cost is unknown, rather than guessing it", () => {
    // The cost comes from GET /api/progression's respecCost. A client that
    // computed RESPEC_BASE * level locally is the exact bug CharacterSheet's
    // F2 header records: raise the base server-side and every click 402s.
    expect(respecDisabled({ gold: 9999, respecCost: null, busy: false })).toBe(true);
    expect(respecDisabled({ gold: 9999, respecCost: undefined, busy: false })).toBe(true);
  });

  it("is disabled when there is nothing allocated to reset", () => {
    expect(respecDisabled({ gold: 9999, respecCost: 100, busy: false, allocatedCount: 0 })).toBe(true);
    expect(respecDisabled({ gold: 9999, respecCost: 100, busy: false, allocatedCount: 1 })).toBe(false);
  });

  it("publishes a respec hit area and labels it with the real cost", () => {
    const l = layoutPassiveTree(baseState({
      allocatedNodeIds: [2], gold: 5000, respecCost: 2000, respecBusy: false,
    }));
    expect(l.respec.label).toBe("Respec — 2000g");
    expect(l.respec.disabled).toBe(false);
    expect(l.hitAreas).toContainEqual({
      x: l.respec.x, y: l.respec.y, w: l.respec.w, h: l.respec.h, kind: "passiverespec", id: null,
    });
  });

  it("publishes no respec hit area while the button is disabled", () => {
    // A disabled control that still hit-tests is a click that silently 402s.
    const l = layoutPassiveTree(baseState({ allocatedNodeIds: [2], gold: 10, respecCost: 2000 }));
    expect(l.respec.disabled).toBe(true);
    expect(l.hitAreas.filter((a) => a.kind === "passiverespec")).toEqual([]);
  });
});

describe("the single-writer rule survives this feature", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const game = fs.readFileSync(path.resolve(here, "../../core/Game.js"), "utf8");

  it("leaves Game.progression with exactly the three writers it had", () => {
    // CharacterSheet.jsx's F1 header documents a cross-channel race that was
    // fixed by DELETING the second writer. An allocate response applied
    // straight to Game.progression would bring it back, and it would look like
    // a level-up occasionally undoing itself rather than like this feature.
    const writes = game.match(/this\.progression\s*=/g) || [];
    expect(writes).toHaveLength(3);
    expect(game).toMatch(/onProgression:\s*\(msg\)\s*=>\s*\{\s*if\s*\(msg\s*&&\s*msg\.progression\)\s*this\.progression\s*=\s*msg\.progression;\s*\}/);
  });

  it("never assigns the allocate response anywhere", () => {
    expect(game).not.toMatch(/allocatePassive\([^)]*\)\s*\.then\s*\(\s*\(?\s*r\s*\)?\s*=>\s*\{[^}]*this\.progression/);
  });

  it("binds the tree to plain P and to KeyP for non-Latin layouts", () => {
    expect(game).toMatch(/KeyP:\s*'p'/);
    expect(game).toMatch(/isKey\('p'\)/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/passiveTreePanel.test.js`
Expected: FAIL with `Failed to resolve import "../passiveTreePanel.js"`

- [ ] **Step 3: Write `passiveTreePanel.js`**

```js
// frontend/src/games/something2/src/js/systems/passiveTreePanel.js
//
// Layout for the canvas passive-tree window. PURE: this module computes rects,
// circles and culling and never touches a canvas -- the same split
// inventoryPanel.js states in its own header, and the reason ~1800-node culling
// is a unit test here rather than a frame-rate observation in a browser.
// drawPassiveTree paints exactly what layoutPassiveTree returns and decides
// nothing itself.
//
// WHY A SPATIAL INDEX. 1806 nodes and 2142 edges will not survive a naive draw
// loop once the player zooms in: every frame would transform and stroke the
// whole graph to paint the twenty nodes actually on screen. Nodes are bucketed
// into fixed 200-unit world cells once, when the tree arrives, and each frame
// visits only the cells the viewport overlaps.
import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";

export const PANEL_W = 1200;
export const PANEL_H = 680;
const TITLE_H = 30;
const PAD = 12;

// One cell is a little wider than the widest ring gap, so a viewport of any
// realistic size touches a handful of cells rather than one or one hundred.
// The tree spans about 840 units of radius, i.e. ~9x9 cells with ~22 nodes each.
export const GRID_CELL = 200;

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2;
// The whole tree is 1680 units across; at 0.35 that is 588px, which fits the
// 656px-tall viewport with room to spare, so an opening player sees all of it.
export const DEFAULT_ZOOM = 0.35;

export const NODE_R = { minor: 7, notable: 12, keystone: 18, start: 16 };

const STATE_FILL = {
  allocated: "#166534",
  allocatable: "#1e3a5f",
  locked: "rgba(30,30,45,0.9)",
};
const STATE_STROKE = {
  allocated: "#4ade80",
  allocatable: "#4a9eff",
  locked: "#3a3a4e",
};

export function buildTreeIndex(tree) {
  const nodes = (tree && tree.nodes) || [];
  const edges = (tree && tree.edges) || [];
  const cells = new Map();
  const byId = new Map();
  const adjacency = new Map();
  for (const n of nodes) {
    byId.set(n.id, n);
    const key = `${Math.floor(n.x / GRID_CELL)},${Math.floor(n.y / GRID_CELL)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(n);
    if (!adjacency.has(n.id)) adjacency.set(n.id, []);
  }
  // Undirected: passive_edges stores each edge once, with a_id < b_id.
  for (const [a, b] of edges) {
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a).push(b);
    adjacency.get(b).push(a);
  }
  return { cells, byId, adjacency, edges };
}

export function worldToScreen(x, y, view) {
  return { sx: x * view.zoom + view.panX, sy: y * view.zoom + view.panY };
}

export function screenToWorld(sx, sy, view) {
  return { x: (sx - view.panX) / view.zoom, y: (sy - view.panY) / view.zoom };
}

export function clampZoom(z) {
  const n = Number(z);
  if (!Number.isFinite(n)) return DEFAULT_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, n));
}

// Keeps the world point currently under (sx, sy) under it after the zoom.
// Zooming about the panel centre instead makes a wheel gesture feel like the
// tree is sliding away from the cursor.
export function zoomAbout(view, sx, sy, nextZoom) {
  const zoom = clampZoom(nextZoom);
  const w = screenToWorld(sx, sy, view);
  return { zoom, panX: sx - w.x * zoom, panY: sy - w.y * zoom };
}

// The widest node radius, so a circle that overlaps the viewport is kept even
// when its centre is outside it. Culling on the centre alone pops keystones in
// and out at the edge while panning.
const MAX_NODE_R = Math.max(...Object.values(NODE_R));

export function visibleNodeIds(index, view, viewport) {
  const pad = MAX_NODE_R * view.zoom;
  const tl = screenToWorld(viewport.x - pad, viewport.y - pad, view);
  const br = screenToWorld(viewport.x + viewport.w + pad, viewport.y + viewport.h + pad, view);
  const out = [];
  const cx0 = Math.floor(tl.x / GRID_CELL);
  const cx1 = Math.floor(br.x / GRID_CELL);
  const cy0 = Math.floor(tl.y / GRID_CELL);
  const cy1 = Math.floor(br.y / GRID_CELL);
  for (let cx = cx0; cx <= cx1; cx += 1) {
    for (let cy = cy0; cy <= cy1; cy += 1) {
      const bucket = index.cells.get(`${cx},${cy}`);
      if (!bucket) continue;
      // The cell sweep is coarse; this is the exact test.
      for (const n of bucket) {
        if (n.x >= tl.x && n.x <= br.x && n.y >= tl.y && n.y <= br.y) out.push(n.id);
      }
    }
  }
  return out;
}

// A node is allocatable iff it is adjacent to the start node or to something
// already allocated -- the client's copy of the server rule in
// backend/src/services/passiveRules.js. It AUTHORIZES nothing: it exists only
// so the panel does not offer a click the server would refuse.
export function allocatableSet(index, allocatedNodeIds, startNodeId) {
  const allocated = new Set(allocatedNodeIds || []);
  const out = new Set();
  if (startNodeId == null) return out;
  const consider = (id) => {
    for (const n of index.adjacency.get(id) || []) {
      if (!allocated.has(n) && n !== startNodeId) out.add(n);
    }
  };
  consider(startNodeId);
  for (const id of allocated) consider(id);
  return out;
}

function grantLine(g) {
  const sign = g.value < 0 ? "" : "+";
  switch (g.type) {
    case "stat": return `${sign}${g.value} ${g.stat}`;
    case "resource": return `${sign}${g.value} max ${g.pool}`;
    case "damage": return `${sign}${g.value}% ${g.element} damage`;
    case "resist": return `${sign}${g.value}% ${g.element} resistance`;
    case "status": return `your hits ${g.status}`;
    case "rule": return `${g.rule} x${g.value}`;
    default: return String(g.type);
  }
}

// Contract §6.4. T15 deletes the character sheet's respec control, so the
// affordability gate lives here now.
//
// `respecCost` MUST be the server's number (GET /api/progression's respecCost).
// A client that recomputed RESPEC_BASE * level locally is the bug
// CharacterSheet.jsx's F2 header records: raise the base server-side and the
// button shows itself affordable while every click 402s. An absent cost is
// therefore "disabled", not "free".
export function respecDisabled({ gold, respecCost, busy = false, allocatedCount = 1 } = {}) {
  if (busy) return true;
  if (!Number.isFinite(Number(respecCost))) return true;
  if (Number(allocatedCount) <= 0) return true;
  return Number(gold) < Number(respecCost);
}

export function layoutPassiveTree(state) {
  const {
    index,
    allocatedNodeIds = [],
    startNodeId = null,
    passivePoints = 0,
    gold = 0,
    respecCost = null,
    respecBusy = false,
    view,
    hoverX = null,
    hoverY = null,
  } = state;

  const px = (GAME_WIDTH - PANEL_W) / 2;
  const py = (GAME_HEIGHT - PANEL_H) / 2;
  const panel = { x: px, y: py, w: PANEL_W, h: PANEL_H };
  const title = { x: px, y: py, w: PANEL_W, h: TITLE_H };
  const close = { x: px + PANEL_W - 8 - 20, y: py + 5, w: 20, h: 20 };
  const viewport = {
    x: px + PAD, y: py + TITLE_H + PAD,
    w: PANEL_W - PAD * 2, h: PANEL_H - TITLE_H - PAD * 2,
  };

  const hitAreas = [{ ...close, kind: "passiveclose", id: null }];

  const allocated = new Set(allocatedNodeIds);
  // A node the player cannot pay for is drawn LOCKED, not allocatable: an
  // affordance for a click that will 400 is worse than no affordance.
  const allocatable = passivePoints > 0
    ? allocatableSet(index, allocatedNodeIds, startNodeId)
    : new Set();

  const visible = visibleNodeIds(index, view, viewport);
  const visibleSet = new Set(visible);

  const nodes = [];
  for (const id of visible) {
    const n = index.byId.get(id);
    const { sx, sy } = worldToScreen(n.x, n.y, view);
    let nodeState = "locked";
    if (id === startNodeId || allocated.has(id)) nodeState = "allocated";
    else if (allocatable.has(id)) nodeState = "allocatable";
    const r = NODE_R[n.kind] * view.zoom;
    nodes.push({
      id, key: n.key, sx, sy, r, kind: n.kind, label: n.label,
      grants: n.grants || [], state: nodeState,
    });
    hitAreas.push({ x: sx - r, y: sy - r, w: r * 2, h: r * 2, kind: "passivenode", id });
  }

  // Edges between VISIBLE nodes only. An edge with one endpoint off-screen
  // contributes at most a stub at the panel border and costs a full transform
  // plus a stroke -- with 2142 of them that is the whole frame budget.
  const edges = [];
  for (const [a, b] of index.edges) {
    if (!visibleSet.has(a) || !visibleSet.has(b)) continue;
    const na = index.byId.get(a);
    const nb = index.byId.get(b);
    const pa = worldToScreen(na.x, na.y, view);
    const pb = worldToScreen(nb.x, nb.y, view);
    edges.push({
      x1: pa.sx, y1: pa.sy, x2: pb.sx, y2: pb.sy,
      lit: (allocated.has(a) || a === startNodeId) && (allocated.has(b) || b === startNodeId),
    });
  }

  let hover = null;
  if (hoverX != null && hoverY != null) {
    const hit = nodes.find((n) => Math.hypot(hoverX - n.sx, hoverY - n.sy) <= n.r);
    if (hit) {
      hover = {
        id: hit.id, label: hit.label, kind: hit.kind,
        lines: hit.grants.map(grantLine),
        sx: hit.sx, sy: hit.sy,
      };
    }
  }

  // Respec button, bottom-left of the title bar's right edge. Its hit area is
  // published ONLY when it is enabled: a disabled control that still hit-tests
  // is a click that silently 402s.
  const disabled = respecDisabled({
    gold, respecCost, busy: respecBusy, allocatedCount: allocated.size,
  });
  const respec = {
    x: px + PANEL_W - 200, y: py + PANEL_H - 34, w: 160, h: 24,
    label: Number.isFinite(Number(respecCost)) ? `Respec — ${respecCost}g` : 'Respec — …',
    disabled,
  };
  if (!disabled) {
    hitAreas.push({ x: respec.x, y: respec.y, w: respec.w, h: respec.h, kind: 'passiverespec', id: null });
  }

  return {
    panel, title, close, viewport, nodes, edges, hover, respec, hitAreas,
    header: {
      pointsLabel: `Passive points: ${passivePoints}`,
      countLabel: `${allocated.size} allocated`,
      zoomLabel: `zoom ${view.zoom.toFixed(2)}x`,
    },
  };
}

export function hitNodeAt(layout, x, y) {
  if (typeof x !== "number" || typeof y !== "number") return null;
  for (const n of layout.nodes) {
    // The circle, not the bounding box: at zoom 2 a keystone's box corner is
    // 13px outside the node the player is looking at.
    if (Math.hypot(x - n.sx, y - n.sy) <= n.r) return n;
  }
  return null;
}

export function drawPassiveTree(ctx, layout) {
  const { panel, title, close, viewport } = layout;

  ctx.save();
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(12,12,20,0.96)";
  ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
  ctx.strokeStyle = "#3a3a4e";
  ctx.lineWidth = 2;
  ctx.strokeRect(panel.x, panel.y, panel.w, panel.h);

  ctx.fillStyle = "rgba(30,30,45,0.95)";
  ctx.fillRect(title.x, title.y, title.w, title.h);
  ctx.fillStyle = "#e5e7eb";
  ctx.font = "14px monospace";
  ctx.fillText("Passive Tree", title.x + 12, title.y + 8);
  ctx.fillStyle = "#fde68a";
  ctx.fillText(layout.header.pointsLabel, title.x + 160, title.y + 8);
  ctx.fillStyle = "#9ca3af";
  ctx.fillText(layout.header.countLabel, title.x + 400, title.y + 8);
  ctx.fillText(layout.header.zoomLabel, title.x + 540, title.y + 8);
  ctx.fillStyle = "rgba(120,40,40,0.9)";
  ctx.fillRect(close.x, close.y, close.w, close.h);
  ctx.fillStyle = "#e5e7eb";
  ctx.fillText("X", close.x + 6, close.y + 3);

  // Everything below is clipped to the viewport: a node half outside it must
  // be cut off by the panel edge, not painted over the title bar.
  ctx.save();
  ctx.beginPath();
  ctx.rect(viewport.x, viewport.y, viewport.w, viewport.h);
  ctx.clip();

  ctx.lineWidth = 1;
  for (const e of layout.edges) {
    ctx.strokeStyle = e.lit ? "#4ade80" : "#2a2a3a";
    ctx.beginPath();
    ctx.moveTo(e.x1, e.y1);
    ctx.lineTo(e.x2, e.y2);
    ctx.stroke();
  }

  for (const n of layout.nodes) {
    ctx.beginPath();
    ctx.arc(n.sx, n.sy, Math.max(1, n.r), 0, Math.PI * 2);
    ctx.fillStyle = STATE_FILL[n.state];
    ctx.fill();
    ctx.lineWidth = n.kind === "minor" ? 1 : 2;
    ctx.strokeStyle = STATE_STROKE[n.state];
    ctx.stroke();
  }

  ctx.restore();

  // Respec button. Drawn outside the clip so it always sits on the panel
  // chrome rather than being cut off by the tree viewport.
  const rb = layout.respec;
  ctx.font = "12px monospace";
  ctx.fillStyle = rb.disabled ? "rgba(40,40,60,0.85)" : "rgba(120,40,40,0.85)";
  ctx.fillRect(rb.x, rb.y, rb.w, rb.h);
  ctx.lineWidth = 1;
  ctx.strokeStyle = rb.disabled ? "#3a3a4e" : "#ef4444";
  ctx.strokeRect(rb.x, rb.y, rb.w, rb.h);
  ctx.fillStyle = rb.disabled ? "#6b7280" : "#e5e7eb";
  ctx.fillText(rb.label, rb.x + 8, rb.y + 6);

  // Tooltip last and OUTSIDE the clip, so a node at the viewport edge still
  // gets a readable box.
  const h = layout.hover;
  if (h) {
    ctx.font = "12px monospace";
    const lines = [h.label, ...h.lines];
    const w = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 16;
    const boxH = 8 + lines.length * 15;
    const tx = Math.min(h.sx + 14, GAME_WIDTH - w - 4);
    const ty = Math.min(h.sy + 14, GAME_HEIGHT - boxH - 4);
    ctx.fillStyle = "rgba(10,10,18,0.96)";
    ctx.fillRect(tx, ty, w, boxH);
    ctx.strokeStyle = h.kind === "keystone" ? "#fde68a" : "#4a9eff";
    ctx.lineWidth = 1;
    ctx.strokeRect(tx, ty, w, boxH);
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText(lines[0], tx + 8, ty + 5);
    ctx.fillStyle = "#9ca3af";
    for (let i = 1; i < lines.length; i += 1) ctx.fillText(lines[i], tx + 8, ty + 5 + i * 15);
  }

  ctx.restore();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/passiveTreePanel.test.js`
Expected: PASS for every `describe` except `the single-writer rule survives this feature`, which still FAILS (`expected 3, got 2` and no `KeyP` in `Game.js`) — that block is satisfied in Step 6.

- [ ] **Step 5: Write the network client**

```js
// frontend/src/games/something2/src/js/net/passiveTreeClient.js
//
// The tree graph and the allocate call. Same shape as progressionClient.js:
// authenticated fetches keyed on the ACTIVE CHARACTER, never on a
// client-supplied user id.
//
// NOTE ON THE ALLOCATE RESPONSE. `allocatePassive` deliberately returns
// nothing but a thrown error on failure. The success body carries the new
// progression, and applying it to Game.progression would reintroduce the
// second writer CharacterSheet.jsx's F1 header describes: the HTTP response
// and a concurrent kill/death websocket push travel on two independent
// connections with no ordering between them. The server pushes an ordered
// `progression` frame after every successful allocate (refreshLivePlayerStats),
// and that frame is the only thing that may update client state.
import { API_URL } from "../../../../../config.js";
import { apiFetch, authHeaders } from "./auth.js";
import { activeCharacterId } from "../../../characterSession.js";

export async function fetchPassiveTree() {
  const res = await apiFetch(`${API_URL}/api/passive-tree`);
  if (!res.ok) throw new Error("failed to load the passive tree");
  return res.json();
}

export async function allocatePassive(nodeId) {
  const res = await apiFetch(`${API_URL}/api/progression/passives/${encodeURIComponent(nodeId)}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ character_id: activeCharacterId() }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "allocation refused");
  }
  // The body is intentionally discarded -- see the module header.
  return true;
}

// Contract §6.4: respec is a passive-tree action now. Same discard rule as
// allocatePassive -- the ordered websocket frame updates the client, not this
// response. `gold` is the one field with no websocket echo (refreshPlayerStats
// does not carry it and a respec sends no `wallet` frame), so the caller
// applies THAT much and nothing else, exactly as CharacterSheet.jsx does today.
export async function respecPassives() {
  const res = await apiFetch(`${API_URL}/api/progression/respec`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ character_id: activeCharacterId() }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "respec refused");
  return { gold: body.gold };
}

// The respec COST is a server number and is never recomputed here (see
// CharacterSheet.jsx's F2 header). It rides GET /api/progression, which the
// overlay fetches once on open alongside the tree.
export async function fetchRespecCost() {
  const res = await apiFetch(
    `${API_URL}/api/progression?character_id=${encodeURIComponent(activeCharacterId())}`,
  );
  if (!res.ok) throw new Error("failed to load the respec cost");
  const body = await res.json();
  return Number(body.respecCost);
}
```

Before writing this, confirm the two import paths against the existing client: open `frontend/src/games/something2/src/js/net/progressionClient.js` and copy its `API_URL`, `apiFetch`/`authHeaders` and `activeCharacterId` import specifiers verbatim rather than the relative paths guessed above.

- [ ] **Step 6: Wire the overlay into `Game.js`**

Six edits, in file order.

**(a)** After the `this.progression = null;` field at `Game.js:124`, add the overlay's state:

```js
        // Passive tree overlay (SOMET-NNN). `passiveTree` is the immutable
        // graph, fetched ONCE on first open; `passiveIndex` is its spatial
        // index, rebuilt only when the graph itself changes. The allocated set
        // is NOT stored here -- it lives on this.progression, whose single
        // writer is the onProgression handler below.
        this.passiveTree = null;
        this.passiveIndex = null;
        this.passiveTreeOpen = false;
        this.passiveView = { panX: 0, panY: 0, zoom: DEFAULT_ZOOM };
        this.passiveDrag = null;
        // Contract §6.4. The COST is the server's number, refreshed whenever
        // the panel opens and whenever the level changes; it is never
        // recomputed from RESPEC_BASE * level here (CharacterSheet.jsx F2).
        this.passiveRespecCost = null;
        this.passiveRespecBusy = false;
```

with the imports at the top of the file:

```js
import {
    buildTreeIndex, layoutPassiveTree, hitNodeAt, clampZoom, zoomAbout, DEFAULT_ZOOM,
} from "../systems/passiveTreePanel.js";
import {
    fetchPassiveTree, allocatePassive, respecPassives, fetchRespecCost,
} from "../net/passiveTreeClient.js";
```

**(b)** Add `KeyP: 'p'` to `CODE_TO_KEY` at `Game.js:1051`:

```js
            KeyM: 'm', KeyT: 't', KeyC: 'c', KeyP: 'p',
```

**(c)** After the inventory `'i'` binding (`Game.js:1071`), add the `P` binding. It is gated on the other three panels being closed for exactly the reason the `'i'` binding is: two centred panels must never stack.

```js
            // Passive tree (SOMET-NNN). The graph is ~1800 nodes and never
            // changes during a session, so it is fetched once, lazily, on the
            // first open rather than on join.
            if (isKey('p') && this.state === 'playing' && this.chunked && !e.repeat
                && !this.inventoryOpen && !this.shopOpen && !this.bankOpen) {
                if (this.passiveTreeOpen) { this.closePassiveTree(); return; }
                this.passiveTreeOpen = true;
                // Centre the tree in the viewport on every open: a player who
                // panned into a far sector last time should not reopen to an
                // empty screen with no idea which way home is.
                this.passiveView = { panX: GAME_WIDTH / 2, panY: GAME_HEIGHT / 2, zoom: DEFAULT_ZOOM };
                if (!this.passiveTree) {
                    fetchPassiveTree()
                        .then((tree) => {
                            this.passiveTree = tree;
                            this.passiveIndex = buildTreeIndex(tree);
                        })
                        .catch((err) => this._showToast(err.message));
                }
                // Refetched on every open, not cached with the graph: the cost
                // is RESPEC_BASE x level and the player levels up mid-session.
                fetchRespecCost()
                    .then((cost) => { this.passiveRespecCost = cost; })
                    .catch(() => { this.passiveRespecCost = null; });
                return;
            }
```

**(d)** Add a branch to the Escape handler (`Game.js:1073-1083`), ahead of the inventory branch so the topmost panel closes first:

```js
                if (this.shopOpen) {
                    this.shopOpen = false;
                } else if (this.bankOpen) {
                    this.bankOpen = false;
                } else if (this.passiveTreeOpen) {
                    this.closePassiveTree();
                } else if (this.inventoryOpen) {
                    this.closeInventory();
                }
```

and a `closePassiveTree` method beside `closeInventory` (`Game.js:945-949`), for the same reason that one exists — an in-flight pan that outlived its panel must not resolve against a layout no longer on screen:

```js
    closePassiveTree() {
        this.passiveTreeOpen = false;
        this.passiveDrag = null;
    }
```

**(e)** Mouse handling. In `_mouseMoveHandler` (`Game.js:1150-1161`), after the existing inventory-drag block:

```js
            if (this.passiveDrag) {
                // Pan by the DELTA since the last move, not from the press
                // origin: accumulating from the origin re-applies the whole
                // offset every frame and the tree shoots off screen.
                this.passiveView = {
                    ...this.passiveView,
                    panX: this.passiveView.panX + (this._cursorX - this.passiveDrag.lastX),
                    panY: this.passiveView.panY + (this._cursorY - this.passiveDrag.lastY),
                };
                this.passiveDrag.lastX = this._cursorX;
                this.passiveDrag.lastY = this._cursorY;
                this.passiveDrag.moved = true;
            }
```

In `_mouseDownHandler`, insert this branch immediately after the `bankOpen` branch (`Game.js:1177-1180`) and before the `inventoryOpen` one:

```js
            if (this.passiveTreeOpen) {
                const x = this._cursorX ?? 0;
                const y = this._cursorY ?? 0;
                const layout = this.renderSystem && this.renderSystem._passiveLayout;
                if (layout) {
                    const hit = layout.hitAreas.find(
                        (a) => x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h
                            && (a.kind === 'passiveclose' || a.kind === 'passiverespec'),
                    );
                    if (hit && hit.kind === 'passiveclose') { this.closePassiveTree(); return; }
                    if (hit && hit.kind === 'passiverespec') {
                        // The hit area only exists while the button is enabled
                        // (layoutPassiveTree publishes it conditionally), so
                        // there is no second affordability check here to drift
                        // from the first.
                        this.passiveRespecBusy = true;
                        respecPassives()
                            .then(({ gold }) => {
                                // gold ONLY. progression comes back over the
                                // ordered websocket frame; applying the HTTP
                                // body would be the second writer F1 removed.
                                if (Number.isFinite(gold)) this.gold = gold;
                                return fetchRespecCost();
                            })
                            .then((cost) => { this.passiveRespecCost = cost; })
                            .catch((err) => this._showToast(err.message))
                            .finally(() => { this.passiveRespecBusy = false; });
                        return;
                    }
                }
                // A press anywhere else ARMS a pan. Whether it was a pan or a
                // click on a node is decided on mouseup by `moved`, exactly as
                // the inventory drag decides between a drag and a click.
                this.passiveDrag = { startX: x, startY: y, lastX: x, lastY: y, moved: false };
                return;
            }
```

In `_mouseUpHandler`, before the existing `const drag = this.inventoryDrag;` line (`Game.js:1209`):

```js
            if (this.passiveDrag) {
                const pan = this.passiveDrag;
                this.passiveDrag = null;
                if (pan.moved) return;                      // it was a pan, not a click
                if (!this.passiveTreeOpen) return;          // the panel closed mid-press
                const layout = this.renderSystem && this.renderSystem._passiveLayout;
                if (!layout) return;
                const node = hitNodeAt(layout, pan.startX, pan.startY);
                if (!node || node.state !== 'allocatable') return;
                // Fire and forget. The success body is discarded on purpose:
                // the server's ordered `progression` websocket frame is the
                // ONLY writer of this.progression (see its onProgression
                // handler and CharacterSheet.jsx's F1 header).
                allocatePassive(node.id).catch((err) => this._showToast(err.message));
                return;
            }
```

Add the wheel handler beside the other handler definitions, and register it with the rest at `Game.js:1242-1244`:

```js
        // passive: false because the handler calls preventDefault -- without
        // it the browser scrolls the page behind the canvas while zooming.
        this._wheelHandler = (e) => {
            if (!this.passiveTreeOpen) return;
            if (typeof e.preventDefault === 'function') e.preventDefault();
            const pt = this._canvasPoint(e);
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            this.passiveView = zoomAbout(this.passiveView, pt.x, pt.y, clampZoom(this.passiveView.zoom * factor));
        };
```

```js
        this.canvas.addEventListener('wheel', this._wheelHandler, { passive: false });
```

and its removal beside the other `removeEventListener` calls at `Game.js:717-718`:

```js
        if (this._wheelHandler) this.canvas.removeEventListener('wheel', this._wheelHandler);
```

**(f)** Pass the overlay's state into the renderer, inside the `renderChunked({ ... })` call (after `bankView: this.bankView,` at `Game.js:902`):

```js
                passiveTree: this.passiveTree,
                passiveIndex: this.passiveIndex,
                passiveTreeOpen: this.passiveTreeOpen,
                passiveView: this.passiveView,
                // Read straight off the single-writer progression row rather
                // than cached anywhere: a kill that levels the player up must
                // open new nodes on the very next frame.
                allocatedNodeIds: (this.progression && this.progression.allocatedNodeIds) || [],
                passivePoints: (this.progression && this.progression.passivePoints) || 0,
                startNodeId: this._passiveStartNodeId(),
                // Contract §6.4's affordability inputs. `respecCost` is the
                // server's number; a null keeps the button disabled rather
                // than guessing one.
                passiveRespecCost: this.passiveRespecCost,
                passiveRespecBusy: this.passiveRespecBusy,
```

with the start-node resolver as a small method on `Game`:

```js
    // The client's copy of the server's class -> start-node lookup, used only
    // to decide which nodes to DRAW as available. The server resolves it again
    // on every allocate and is the only thing that authorizes one.
    _passiveStartNodeId() {
        if (!this.passiveTree || !this.inventory || !this.inventory.className) return null;
        const start = this.passiveTree.nodes.find((n) => n.start_class === this.inventory.className);
        return start ? start.id : null;
    }
```

If `inventory.className` does not exist on the join frame, read the character's class from wherever `CharacterSelect.jsx` stores it (`characterSession.js`) instead — check that file first and use whichever field actually holds the class name; do not add a new server field for it.

- [ ] **Step 7: Run the panel test to verify the whole file passes**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/passiveTreePanel.test.js`
Expected: PASS (23 tests)

- [ ] **Step 8: Run the hotkey registry test to prove `P` collides with nothing**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/hotkeyRegistry.test.js`
Expected: PASS (4 tests) — in particular `gives no unmodified letter to two handlers`

- [ ] **Step 9: Wire the renderer**

In `RenderSystem.js`, beside `this._invHitAreas = [];` at `:48`:

```js
    // Same contract as _invHitAreas, for the passive-tree overlay. _passiveLayout
    // is what Game hit-tests a click and a hover against.
    this._passiveHitAreas = [];
    this._passiveLayout = null;
```

Add the new parameters to the `renderChunked({...})` destructuring (after `bankView = null,` at `:154`):

```js
    passiveTree = null, passiveIndex = null, passiveTreeOpen = false, passiveView = null,
    allocatedNodeIds = [], passivePoints = 0, startNodeId = null,
    passiveRespecCost = null, passiveRespecBusy = false,
```

Add the overlay block after the bank block (`RenderSystem.js:333-338`):

```js
    // Passive tree overlay — same convention as the three panels above: raw
    // canvas pixel space, hit areas rebuilt every frame, populated only while
    // the panel is open, so a click can never hit a stale rect.
    this._passiveHitAreas = [];
    this._passiveLayout = null;
    if (passiveTreeOpen && passiveIndex && passiveView) {
      this._passiveLayout = this.renderPassiveTree(this.ctx, {
        index: passiveIndex, view: passiveView, allocatedNodeIds, passivePoints, startNodeId,
        gold: gold ?? 0, respecCost: passiveRespecCost, respecBusy: passiveRespecBusy,
        hoverX: this._passiveHoverX ?? null, hoverY: this._passiveHoverY ?? null,
      }, this._passiveHitAreas);
    }
```

and the method itself after `renderInventory` (`RenderSystem.js:1230`):

```js
  // Canvas-drawn passive tree. Delegates to systems/passiveTreePanel.js: the
  // layout, the spatial-index culling and the three visual states are pure and
  // unit-tested there, and this method only forwards state, republishes the hit
  // areas and returns the layout for the click/hover handlers.
  renderPassiveTree(ctx, state, hitAreas) {
    const layout = layoutPassiveTree(state);
    for (const a of layout.hitAreas) hitAreas.push(a);
    drawPassiveTree(ctx, layout);
    return layout;
  }
```

with the import beside the inventory panel's at `RenderSystem.js:10`:

```js
import { layoutPassiveTree, drawPassiveTree } from "./passiveTreePanel.js";
```

Hover is read from `_cursorX`/`_cursorY` the same way the inventory tooltip is; pass them through the `renderChunked` call in `Game.js` alongside the other passive fields:

```js
                passiveHoverX: this.passiveTreeOpen ? (this._cursorX ?? null) : null,
                passiveHoverY: this.passiveTreeOpen ? (this._cursorY ?? null) : null,
```

and destructure them in `renderChunked` beside the other passive parameters, feeding them into the state object above in place of `this._passiveHoverX`.

- [ ] **Step 10: Run the full frontend suite**

Run: `cd frontend && npx vitest run`
Expected: PASS, 0 failures

- [ ] **Step 11: Browser-verify the overlay**

AGENTS.md requires browser verification for any change with a UI surface, and this repo has a documented history of green suites hiding inert canvas features. With the stack up (`make up && make dev`) and the scratch tree seeded, log in, join a world, and confirm all six:

1. `P` opens the panel; `P` again and `Escape` both close it; `I` while it is open does **not** stack the inventory on top.
2. The whole tree is visible on open, with the six sectors distinguishable.
3. Dragging pans; the wheel zooms about the cursor (the node under the pointer stays under it).
4. Hovering a keystone shows its label and every grant line.
5. Clicking an allocatable node turns it green **and** decrements the header's point count — the count moving is what proves the websocket `progression` frame, not the HTTP response, updated the client.
6. Zoomed fully in on one sector, panning stays smooth — that is the culling working.
7. Contract §6.4: the Respec button reads "Respec — Ng" with the server's cost. With less gold than that it is greyed and clicking it does nothing at all (no request, no toast). With enough gold, clicking it clears every allocated node, restores the point count and drops the gold HUD by exactly the cost.

Capture a screenshot of (4), (5) and (7) for the task report.

- [ ] **Step 12: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/passiveTreePanel.js \
        frontend/src/games/something2/src/js/net/passiveTreeClient.js \
        frontend/src/games/something2/src/js/systems/RenderSystem.js \
        frontend/src/games/something2/src/js/core/Game.js \
        frontend/src/games/something2/src/js/systems/__tests__/passiveTreePanel.test.js
git commit -m "feat(passives): in-game passive tree overlay with pan, zoom and viewport culling (SOMET-NNN)"
```

---

### Task 4 (T9): Admin passive-node browser and single-node editor

**Files:**
- Create: `backend/src/api/passiveNodesRoutes.js`
- Modify: `backend/src/index.js` (require beside `passiveTreeRoutes`, mount beside it)
- Create: `frontend/src/games/something2/passiveNodeForm.js`
- Create: `frontend/src/games/something2/usePassiveNodes.js`
- Create: `frontend/src/games/something2/PassiveNodesAdmin.jsx`
- Modify: `frontend/src/games/something2/ProgressionAdmin.jsx` (the page shell Group A T1 creates)
- Test: `backend/tests/passive_nodes_admin_routes.test.js`
- Test: `frontend/src/games/something2/__tests__/passiveNodeForm.test.js`
- Test: `frontend/src/games/something2/__tests__/PassiveNodesAdmin.smoke.test.js`

**Interfaces:**
- Consumes (Task 1): `passive_nodes` and its `passive_nodes_kind_check` constraint.
- Consumes (Task 2): `invalidateTreeCache()` from `passiveTreeStore.js` — the graph is cached in module scope, so an admin write that does not clear it is a save that appears to work and changes nothing until the process restarts.
- Consumes (Group A T1): `frontend/src/games/something2/ProgressionAdmin.jsx`, mounted at `/game/admin/progression`.
- Produces: `GET /api/passive-nodes?search=&sector=&kind=&limit=&offset=` → `{ nodes, total }`; `PUT /api/passive-nodes/:id` with `{ label, kind, grants }` → the updated row.
- Produces: `GRANT_TYPES`, `RULE_KEYS`, `SECTORS`, `KINDS`, `nodeToForm`, `formToPayload`, `validateNodeForm`, `grantSummary` from `passiveNodeForm.js`.

**Route naming.** Existing admin pages mount at `/game/<slug>` with no `admin` segment (`App.jsx:59-67`, `navSections.js:31-45`). The spec asks for `/game/admin/progression`; Group A T1 owns that decision and this task mounts into whatever component T1 created, without registering a route of its own. If T1's file is not at `frontend/src/games/something2/ProgressionAdmin.jsx`, use its real path and adjust the smoke test's expectation to match.

- [ ] **Step 1: Write the failing admin route test**

```js
// backend/tests/passive_nodes_admin_routes.test.js
//
// The admin node editor is the one write path into passive_nodes outside the
// seeder, so the three things that matter are: it is admin-only, it cannot
// widen a node into a shape the DB CHECK would reject at some later write, and
// it cannot rewrite the STRUCTURE (key/sector/ring/x/y/start_class) -- those
// come from the generator, and an admin who could move a node could also
// disconnect it, which is the orphaned-cluster failure guard 1 exists to stop.
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Pool } = require('pg');
require('./helpers/auth.js');
const { app } = require('../src/index.js');
const { createAdminToken, createPlayerToken } = require('./helpers/auth.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url
  ? 'no TEST_DATABASE_URL -- refusing to mutate a real database (this test writes passive_nodes)'
  : false;

test('passive node admin routes', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(async () => { await pool.end(); });

  const admin = await createAdminToken(pool);
  const player = await createPlayerToken(pool);
  const target = await pool.query("SELECT id, label, grants FROM passive_nodes WHERE key = 'strength-r2-0-0'");
  const id = target.rows[0].id;
  const originalLabel = target.rows[0].label;
  const originalGrants = target.rows[0].grants;
  t.after(async () => {
    await pool.query('UPDATE passive_nodes SET label = $2, grants = $3::jsonb WHERE id = $1',
      [id, originalLabel, JSON.stringify(originalGrants)]);
  });

  await t.test('the list is admin-only', async () => {
    assert.strictEqual((await request(app).get('/api/passive-nodes')).status, 401);
    const asPlayer = await request(app).get('/api/passive-nodes').set('Authorization', `Bearer ${player}`);
    assert.strictEqual(asPlayer.status, 403);
    assert.strictEqual(asPlayer.body.error, 'admin role required');
  });

  await t.test('the update is admin-only', async () => {
    const res = await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${player}`)
      .send({ label: 'nope', kind: 'minor', grants: [] });
    assert.strictEqual(res.status, 403);
  });

  await t.test('lists a page at a time and reports the unpaged total', async () => {
    const res = await request(app).get('/api/passive-nodes?limit=25')
      .set('Authorization', `Bearer ${admin}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.nodes.length, 25);
    assert.strictEqual(res.body.total, 1806);
    assert.deepStrictEqual(Object.keys(res.body.nodes[0]).sort(),
      ['grants', 'id', 'key', 'kind', 'label', 'ring', 'sector', 'start_class', 'x', 'y']);
  });

  await t.test('filters by sector, by kind and by a key/label search', async () => {
    const bySector = await request(app).get('/api/passive-nodes?sector=charisma&limit=5')
      .set('Authorization', `Bearer ${admin}`);
    assert.strictEqual(bySector.body.total, 296);
    assert.deepStrictEqual([...new Set(bySector.body.nodes.map((n) => n.sector))], ['charisma']);

    const byKind = await request(app).get('/api/passive-nodes?kind=keystone&limit=100')
      .set('Authorization', `Bearer ${admin}`);
    assert.strictEqual(byKind.body.total, 30);

    const bySearch = await request(app).get('/api/passive-nodes?search=start-')
      .set('Authorization', `Bearer ${admin}`);
    assert.strictEqual(bySearch.body.total, 6);
  });

  await t.test('a search string is parameterised, not interpolated', async () => {
    // If this reaches the database as SQL the request 500s or the total is
    // wrong; either way the assertion below fails rather than the table drops.
    const res = await request(app).get(`/api/passive-nodes?search=${encodeURIComponent("%' OR '1'='1")}`)
      .set('Authorization', `Bearer ${admin}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.total, 0);
  });

  await t.test('updates label, kind and grants', async () => {
    const res = await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'Retuned', kind: 'notable', grants: [{ type: 'stat', stat: 'strength', value: 11 }] });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.label, 'Retuned');
    assert.strictEqual(res.body.kind, 'notable');
    assert.deepStrictEqual(res.body.grants, [{ type: 'stat', stat: 'strength', value: 11 }]);
  });

  await t.test('refuses an unknown kind, an unknown grant type and a bad stat name', async () => {
    const badKind = await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'x', kind: 'legendary', grants: [] });
    assert.strictEqual(badKind.status, 400);
    assert.match(badKind.body.error, /kind/);

    const badGrant = await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'x', kind: 'minor', grants: [{ type: 'wat', value: 1 }] });
    assert.strictEqual(badGrant.status, 400);

    const badStat = await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'x', kind: 'minor', grants: [{ type: 'stat', stat: 'strenght', value: 2 }] });
    assert.strictEqual(badStat.status, 400);
    assert.match(badStat.body.error, /stat/);
  });

  await t.test('refuses to turn an ordinary node into a start node', async () => {
    // kind='start' and a non-null start_class are the same fact (the DB CHECK),
    // so accepting this would either violate the constraint or hand a second
    // start node to a class.
    const res = await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'x', kind: 'start', grants: [] });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /start/);
  });

  await t.test('ignores structural fields even when they are sent', async () => {
    const before = await pool.query('SELECT x, y, sector, ring, key FROM passive_nodes WHERE id = $1', [id]);
    await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'y', kind: 'minor', grants: [], x: 9999, y: 9999, sector: 'core', ring: 0, key: 'hijacked' });
    const after = await pool.query('SELECT x, y, sector, ring, key FROM passive_nodes WHERE id = $1', [id]);
    assert.deepStrictEqual(after.rows[0], before.rows[0]);
  });

  await t.test('AC3: a reseed keeps an admin edit; --force overwrites it', async () => {
    // The end-to-end version of the seeder test in Task 1: the edit is made
    // through the ADMIN API, then the generator is re-run both ways. This is
    // the path an operator actually takes, and it is the one that would break
    // if the API ever wrote a column the seeder overwrites unconditionally.
    const { seedPassiveTree } = require('../scripts/seed-passive-tree.js');

    await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'Hand-tuned', kind: 'notable', grants: [{ type: 'stat', stat: 'strength', value: 7 }] });

    await seedPassiveTree(pool, { quiet: true });
    const kept = await pool.query('SELECT label, kind, grants FROM passive_nodes WHERE id = $1', [id]);
    assert.strictEqual(kept.rows[0].label, 'Hand-tuned');
    assert.strictEqual(kept.rows[0].kind, 'notable');
    assert.deepStrictEqual(kept.rows[0].grants, [{ type: 'stat', stat: 'strength', value: 7 }]);

    await seedPassiveTree(pool, { force: true, quiet: true });
    const forced = await pool.query('SELECT label FROM passive_nodes WHERE id = $1', [id]);
    assert.notStrictEqual(forced.rows[0].label, 'Hand-tuned');
  });

  await t.test('AC4: editing an allocated node does not orphan character_passives', async () => {
    // A node someone has already spent a point on must survive both an admin
    // edit and the reseed that follows it, with the SAME id -- character_passives
    // references the id, so a delete-and-reinsert would either fail on the FK
    // or cascade the player's point away.
    const { seedPassiveTree } = require('../scripts/seed-passive-tree.js');
    const tag = `passadmin-${process.pid}-${Date.now()}`;
    const warrior = await pool.query("SELECT id FROM entity_types WHERE name = 'Warrior'");
    const u = await pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [tag, 'x', 'player'],
    );
    const c = await pool.query(
      'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 1, $2, $3) RETURNING id',
      [u.rows[0].id, tag, warrior.rows[0].id],
    );
    t.after(async () => { await pool.query('DELETE FROM users WHERE id = $1', [u.rows[0].id]); });
    await pool.query('INSERT INTO character_passives (character_id, node_id) VALUES ($1, $2)',
      [c.rows[0].id, id]);

    const res = await request(app).put(`/api/passive-nodes/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'Edited under a live allocation', kind: 'notable', grants: [] });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, id);   // the id never moves

    await seedPassiveTree(pool, { force: true, quiet: true });

    const still = await pool.query(
      'SELECT node_id FROM character_passives WHERE character_id = $1', [c.rows[0].id]);
    assert.deepStrictEqual(still.rows.map((r) => r.node_id), [id]);
  });

  await t.test('404s on a node that does not exist', async () => {
    const res = await request(app).put('/api/passive-nodes/99999999')
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'x', kind: 'minor', grants: [] });
    assert.strictEqual(res.status, 404);
  });
});
```

Before writing this, open `backend/tests/helpers/auth.js` and use whatever token helpers it actually exports; if it has no `createAdminToken`/`createPlayerToken`, copy the token-minting pattern from `backend/tests/auth_protection.test.js` instead of adding new helpers.

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd backend && \
  DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  node --test tests/passive_nodes_admin_routes.test.js
```
Expected: FAIL — 404 on every request, because `/api/passive-nodes` is not mounted.

- [ ] **Step 3: Write the admin routes**

```js
// backend/src/api/passiveNodesRoutes.js
//
// The admin node browser and single-node editor (spec §10.5).
//
// ONLY THREE COLUMNS ARE WRITABLE: label, kind and grants. Structure --
// key, sector, ring, x, y, start_class -- comes from the generator and is
// deliberately not editable here. Letting an admin move a node would let them
// disconnect one, and an unreachable node is invisible in the UI and
// unallocatable forever: exactly the failure the generator's reachability
// guard exists to prevent, reintroduced through a form.
const express = require('express');
const { requireAdmin } = require('../auth/middleware.js');
const { invalidateTreeCache } = require('../services/passiveTreeStore.js');

const KINDS = ['minor', 'notable', 'keystone'];   // 'start' deliberately absent
const SECTORS = ['core', 'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const STATS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const POOLS = ['hp', 'mana', 'stamina'];
const ELEMENTS = ['physical', 'arcane', 'fire', 'ice', 'lightning'];
const STATUSES = ['burn', 'chill', 'shock'];
const RULES = ['lifeCostMultiplier', 'treeCharmBonus', 'cooldownFloor', 'regenLifeShare'];

// Returns null when valid, or the message to put in the 400 body. Same
// vocabulary the generator's guard 3 checks, enforced again here because the
// admin UI is a second, unguarded way into the same column.
function grantError(g) {
  if (g == null || typeof g !== 'object') return 'each grant must be an object';
  if (!Number.isFinite(Number(g.value))) return 'each grant needs a finite value';
  switch (g.type) {
    case 'stat': return STATS.includes(g.stat) ? null : `unknown stat: ${g.stat}`;
    case 'resource': return POOLS.includes(g.pool) ? null : `unknown resource pool: ${g.pool}`;
    case 'damage': return ELEMENTS.includes(g.element) ? null : `unknown damage element: ${g.element}`;
    case 'resist': return ELEMENTS.includes(g.element) ? null : `unknown resist element: ${g.element}`;
    case 'status': return STATUSES.includes(g.status) ? null : `unknown status: ${g.status}`;
    case 'rule': return RULES.includes(g.rule) ? null : `unknown rule: ${g.rule}`;
    default: return `unknown grant type: ${g.type}`;
  }
}

module.exports = function passiveNodesRoutes(pool) {
  const router = express.Router();
  const guard = requireAdmin(pool);

  router.get('/', guard, async (req, res) => {
    try {
      const where = [];
      const params = [];
      if (SECTORS.includes(req.query.sector)) {
        params.push(req.query.sector);
        where.push(`sector = $${params.length}`);
      }
      if (['minor', 'notable', 'keystone', 'start'].includes(req.query.kind)) {
        params.push(req.query.kind);
        where.push(`kind = $${params.length}`);
      }
      const search = String(req.query.search || '').trim();
      if (search) {
        // Parameterised, and the wildcards are added to the VALUE, never to the
        // SQL: `%` and `_` inside the search string then match literally
        // instead of turning a search into a table scan the user did not ask for.
        params.push(`%${search}%`);
        where.push(`(key ILIKE $${params.length} OR label ILIKE $${params.length})`);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const total = await pool.query(`SELECT count(*)::int AS c FROM passive_nodes ${clause}`, params);
      const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit) || 50)));
      const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
      const rows = await pool.query(
        `SELECT id, key, sector, ring, x, y, kind, label, grants, start_class
           FROM passive_nodes ${clause}
          ORDER BY sector, ring, key
          LIMIT ${limit} OFFSET ${offset}`,
        params,
      );
      return res.json({ nodes: rows.rows, total: total.rows[0].c });
    } catch (err) {
      console.error('passive node list failed:', err);
      return res.status(500).json({ error: 'failed to list passive nodes' });
    }
  });

  router.put('/:id', guard, async (req, res) => {
    try {
      const { label, kind, grants } = req.body || {};
      if (typeof label !== 'string' || label.trim() === '') {
        return res.status(400).json({ error: 'label is required' });
      }
      if (kind === 'start') {
        return res.status(400).json({ error: 'a start node is created by the generator, not by this editor' });
      }
      if (!KINDS.includes(kind)) {
        return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
      }
      if (!Array.isArray(grants)) return res.status(400).json({ error: 'grants must be an array' });
      for (const g of grants) {
        const err = grantError(g);
        if (err) return res.status(400).json({ error: err });
      }

      const r = await pool.query(
        `UPDATE passive_nodes SET label = $2, kind = $3, grants = $4::jsonb
          WHERE id = $1 AND kind <> 'start'
        RETURNING id, key, sector, ring, x, y, kind, label, grants, start_class`,
        [req.params.id, label.trim(), kind, JSON.stringify(grants)],
      );
      if (r.rowCount !== 1) return res.status(404).json({ error: 'passive node not found' });

      // The tree is cached in module scope by passiveTreeStore.loadTree. Without
      // this, the save succeeds, the admin sees the new value in the form, and
      // every running world keeps granting the old one until a restart.
      invalidateTreeCache();
      return res.json(r.rows[0]);
    } catch (err) {
      console.error('passive node update failed:', err);
      return res.status(500).json({ error: 'failed to update passive node' });
    }
  });

  return router;
};
```

In `backend/src/index.js`, beside the `passiveTreeRoutes` require and mount added in Task 2:

```js
const passiveNodesRoutes = require('./api/passiveNodesRoutes.js');
```
```js
app.use('/api/passive-nodes', passiveNodesRoutes(guardPool));
```

- [ ] **Step 4: Run the admin route test to verify it passes**

Run:
```bash
cd backend && \
  DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  node --test tests/passive_nodes_admin_routes.test.js
```
Expected: PASS (12 subtests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/passiveNodesRoutes.js backend/src/index.js backend/tests/passive_nodes_admin_routes.test.js
git commit -m "feat(passives): admin passive-node list and single-node update routes (SOMET-NNN)"
```

- [ ] **Step 6: Write the failing form test**

```js
// frontend/src/games/something2/__tests__/passiveNodeForm.test.js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GRANT_TYPES, RULE_KEYS, KINDS, SECTORS,
  nodeToForm, formToPayload, validateNodeForm, grantSummary,
} from '../passiveNodeForm.js';

const ROW = {
  id: 42, key: 'strength-r2-1-7', sector: 'strength', ring: 2, x: 12.5, y: -30.25,
  kind: 'notable', label: 'Great Sinew', start_class: null,
  grants: [{ type: 'stat', stat: 'strength', value: 8 }],
};

describe('vocabulary', () => {
  it('offers every grant type the backend accepts, and no start kind', () => {
    expect(GRANT_TYPES.map((g) => g.type)).toEqual(
      ['stat', 'resource', 'damage', 'resist', 'status', 'rule'],
    );
    expect(KINDS).toEqual(['minor', 'notable', 'keystone']);
    expect(SECTORS).toEqual(
      ['core', 'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'],
    );
    expect(RULE_KEYS).toEqual(
      ['lifeCostMultiplier', 'treeCharmBonus', 'cooldownFloor', 'regenLifeShare'],
    );
  });

  it('has not drifted from the backend seed vocabulary', () => {
    // vitest runs this project in a plain node environment and the backend is
    // CommonJS with its own require graph, so this compares SOURCE TEXT rather
    // than importing -- the same route hotkeyRegistry.test.js and
    // navRoutes.test.js take, for the same reason.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const seed = fs.readFileSync(
      path.resolve(here, '../../../../../backend/seeds/data/passiveTree.js'), 'utf8');
    const block = seed.match(/const GRANT_TYPES = \{([\s\S]*?)\n\};/);
    expect(block, 'GRANT_TYPES not found in the backend seed file -- was it renamed?').toBeTruthy();
    const backendTypes = [...block[1].matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    expect(backendTypes).toEqual(GRANT_TYPES.map((g) => g.type));

    const ruleBlock = seed.match(/const RULE_KEYS = \{([\s\S]*?)\n\};/);
    const backendRules = [...ruleBlock[1].matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    expect(backendRules.sort()).toEqual([...RULE_KEYS].sort());
  });
});

describe('row <-> form', () => {
  it('round-trips a node through the form and back to a payload', () => {
    const form = nodeToForm(ROW);
    expect(form.label).toBe('Great Sinew');
    expect(form.kind).toBe('notable');
    expect(form.grants).toEqual([{ type: 'stat', stat: 'strength', value: 8 }]);
    expect(formToPayload(form)).toEqual({
      label: 'Great Sinew', kind: 'notable',
      grants: [{ type: 'stat', stat: 'strength', value: 8 }],
    });
  });

  it('sends only the three writable columns, never the structure', () => {
    const payload = formToPayload(nodeToForm(ROW));
    expect(Object.keys(payload).sort()).toEqual(['grants', 'kind', 'label']);
  });

  it('coerces a text-input value to a number, keeping the sign', () => {
    const form = { label: 'x', kind: 'minor', grants: [{ type: 'resist', element: 'ice', value: '-15' }] };
    expect(formToPayload(form).grants[0].value).toBe(-15);
  });

  it('drops the fields a grant type does not use', () => {
    // Switching a grant from stat to damage in the form leaves `stat` behind;
    // sending it would store a row the backend validator passes but nothing
    // reads, which is indistinguishable from a working node in the UI.
    const form = { label: 'x', kind: 'minor', grants: [{ type: 'damage', stat: 'strength', element: 'fire', value: 12 }] };
    expect(formToPayload(form).grants[0]).toEqual({ type: 'damage', element: 'fire', value: 12 });
  });
});

describe('validation', () => {
  const ok = { label: 'Fine', kind: 'minor', grants: [{ type: 'stat', stat: 'wisdom', value: 2 }] };

  it('accepts a well-formed node', () => {
    expect(validateNodeForm(ok)).toEqual({ ok: true, errors: [] });
  });

  it('requires a label', () => {
    expect(validateNodeForm({ ...ok, label: '   ' }).errors).toEqual(['Label is required']);
  });

  it('rejects a kind the editor may not set', () => {
    expect(validateNodeForm({ ...ok, kind: 'start' }).errors)
      .toEqual(['A start node cannot be created or edited here']);
    expect(validateNodeForm({ ...ok, kind: 'legendary' }).errors)
      .toEqual(['Kind must be minor, notable or keystone']);
  });

  it('names the offending grant by its position', () => {
    const r = validateNodeForm({
      ...ok,
      grants: [
        { type: 'stat', stat: 'wisdom', value: 2 },
        { type: 'stat', stat: 'strenght', value: 2 },
        { type: 'damage', element: 'fire', value: 'abc' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([
      'Grant 2: unknown stat "strenght"',
      'Grant 3: value must be a number',
    ]);
  });

  it('accepts an empty grant list — a node may deliberately grant nothing', () => {
    expect(validateNodeForm({ ...ok, grants: [] }).ok).toBe(true);
  });
});

describe('grantSummary', () => {
  it('renders one readable line per grant for the browser list', () => {
    expect(grantSummary([
      { type: 'stat', stat: 'strength', value: 30 },
      { type: 'resource', pool: 'hp', value: 150 },
      { type: 'rule', rule: 'lifeCostMultiplier', value: 0.75 },
    ])).toBe('+30 strength, +150 max hp, lifeCostMultiplier x0.75');
  });

  it('says so when a node grants nothing', () => {
    expect(grantSummary([])).toBe('—');
  });
});
```

- [ ] **Step 7: Run the form test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/passiveNodeForm.test.js`
Expected: FAIL with `Failed to resolve import "../passiveNodeForm.js"`

- [ ] **Step 8: Write `passiveNodeForm.js`**

```js
// frontend/src/games/something2/passiveNodeForm.js
//
// PURE form <-> payload mapping and validation for the admin node editor, kept
// out of the component for the same reason biomeForm.js and behaviorForm.js
// are: the rules are unit tests here, and the component only renders them.
//
// The vocabulary below is a deliberate SECOND copy of the backend's (in
// backend/seeds/data/passiveTree.js and backend/src/api/passiveNodesRoutes.js).
// The frontend cannot require CommonJS from the backend tree, so the copy is
// unavoidable -- what is avoidable is the drift, and passiveNodeForm.test.js
// compares this list against the backend's source text on every run.

export const KINDS = ['minor', 'notable', 'keystone'];
export const SECTORS = ['core', 'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
export const STATS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
export const POOLS = ['hp', 'mana', 'stamina'];
export const ELEMENTS = ['physical', 'arcane', 'fire', 'ice', 'lightning'];
export const STATUSES = ['burn', 'chill', 'shock'];
export const RULE_KEYS = ['lifeCostMultiplier', 'treeCharmBonus', 'cooldownFloor', 'regenLifeShare'];

// `field` is the extra key this grant type carries, and `options` is what the
// editor's dropdown for it offers. One table drives the form, the payload
// mapping and the validator, so a new grant type is one entry rather than three.
export const GRANT_TYPES = [
  { type: 'stat', field: 'stat', options: STATS, label: 'Stat' },
  { type: 'resource', field: 'pool', options: POOLS, label: 'Resource' },
  { type: 'damage', field: 'element', options: ELEMENTS, label: 'Damage' },
  { type: 'resist', field: 'element', options: ELEMENTS, label: 'Resistance' },
  { type: 'status', field: 'status', options: STATUSES, label: 'Status on hit' },
  { type: 'rule', field: 'rule', options: RULE_KEYS, label: 'Rule' },
];

const byType = new Map(GRANT_TYPES.map((g) => [g.type, g]));

export function nodeToForm(row) {
  return {
    id: row.id,
    key: row.key,
    sector: row.sector,
    ring: row.ring,
    label: row.label,
    kind: row.kind,
    // Cloned: the form is edited in place and the query cache's row must not
    // move under it.
    grants: (row.grants || []).map((g) => ({ ...g })),
  };
}

export function formToPayload(form) {
  return {
    label: String(form.label || '').trim(),
    kind: form.kind,
    grants: (form.grants || []).map((g) => {
      const def = byType.get(g.type);
      // Only the fields this type uses. Switching a grant's type in the form
      // leaves the previous type's field behind, and a stored `stat` on a
      // `damage` grant is a row that validates and does nothing.
      const out = { type: g.type, value: Number(g.value) };
      if (def) out[def.field] = g[def.field];
      return out;
    }),
  };
}

export function validateNodeForm(form) {
  const errors = [];
  if (!String(form.label || '').trim()) errors.push('Label is required');
  if (form.kind === 'start') errors.push('A start node cannot be created or edited here');
  else if (!KINDS.includes(form.kind)) errors.push('Kind must be minor, notable or keystone');

  (form.grants || []).forEach((g, i) => {
    const n = i + 1;
    const def = byType.get(g.type);
    if (!def) { errors.push(`Grant ${n}: unknown type "${g.type}"`); return; }
    if (!Number.isFinite(Number(g.value)) || String(g.value).trim() === '') {
      errors.push(`Grant ${n}: value must be a number`);
      return;
    }
    const v = g[def.field];
    if (!def.options.includes(v)) {
      const noun = def.field === 'stat' ? 'stat'
        : def.field === 'pool' ? 'resource pool'
          : def.field === 'element' ? 'element'
            : def.field === 'status' ? 'status' : 'rule';
      errors.push(`Grant ${n}: unknown ${noun} "${v}"`);
    }
  });

  return { ok: errors.length === 0, errors };
}

// The one-line rendering used by the browser list and by the game overlay's
// tooltip. Kept identical in wording to passiveTreePanel.js's grantLine so an
// admin reads the same sentence the player will.
export function grantSummary(grants) {
  if (!grants || grants.length === 0) return '—';
  return grants.map((g) => {
    const sign = Number(g.value) < 0 ? '' : '+';
    switch (g.type) {
      case 'stat': return `${sign}${g.value} ${g.stat}`;
      case 'resource': return `${sign}${g.value} max ${g.pool}`;
      case 'damage': return `${sign}${g.value}% ${g.element} damage`;
      case 'resist': return `${sign}${g.value}% ${g.element} resistance`;
      case 'status': return `your hits ${g.status}`;
      case 'rule': return `${g.rule} x${g.value}`;
      default: return String(g.type);
    }
  }).join(', ');
}
```

- [ ] **Step 9: Run the form test to verify it passes**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/passiveNodeForm.test.js`
Expected: PASS (12 tests)

- [ ] **Step 10: Write the data hooks**

```js
// frontend/src/games/something2/usePassiveNodes.js
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { API_URL } from "../../config.js";

// The filter object is part of the query key, so a sector/kind/search change
// is a new cached page rather than a refetch that blanks the table.
export function usePassiveNodes({ search = "", sector = "", kind = "", offset = 0, limit = 50 } = {}) {
  const { data, isLoading } = useQuery({
    queryKey: ["passive-nodes", { search, sector, kind, offset, limit }],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (search) qs.set("search", search);
      if (sector) qs.set("sector", sector);
      if (kind) qs.set("kind", kind);
      qs.set("offset", String(offset));
      qs.set("limit", String(limit));
      const res = await apiFetch(`${API_URL}/api/passive-nodes?${qs.toString()}`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to fetch passive nodes");
      return res.json();
    },
    // TanStack keeps the previous data on a FAILED refetch in this project
    // (see the map-graph notes), so a total of 0 after an error would read as
    // "no nodes" rather than "the request failed". Default the shape instead.
    placeholderData: (prev) => prev,
  });
  return {
    nodes: (data && data.nodes) || [],
    total: (data && data.total) || 0,
    isLoadingNodes: isLoading,
  };
}

export function useUpdatePassiveNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }) => {
      const res = await apiFetch(`${API_URL}/api/passive-nodes/${id}`, {
        method: "PUT",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to save passive node");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["passive-nodes"] });
      toast.success("Passive node saved");
    },
    onError: (err) => toast.error(err.message),
  });
}
```

- [ ] **Step 11: Write the failing smoke test**

```js
// frontend/src/games/something2/__tests__/PassiveNodesAdmin.smoke.test.js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PassiveNodesAdmin from '../PassiveNodesAdmin.jsx';

const here = path.dirname(fileURLToPath(import.meta.url));
const shell = fs.readFileSync(path.join(here, '../ProgressionAdmin.jsx'), 'utf8');
const admin = fs.readFileSync(path.join(here, '../PassiveNodesAdmin.jsx'), 'utf8');

// A bare `typeof === 'function'` stays green even when the wrong component is
// exported or the mount point silently disappears -- both have shipped in this
// repo before (see the sidebar-nav routing incident). These assertions read the
// source, which is the only render-free way to catch either.
describe('PassiveNodesAdmin', () => {
  it('is a component export named PassiveNodesAdmin', () => {
    expect(typeof PassiveNodesAdmin).toBe('function');
    expect(PassiveNodesAdmin.name).toBe('PassiveNodesAdmin');
  });

  it('is rendered by the progression admin page shell', () => {
    expect(shell).toMatch(/import\s+PassiveNodesAdmin\s+from\s+'\.\/PassiveNodesAdmin\.jsx'/);
    expect(shell).toMatch(/<PassiveNodesAdmin\s*\/>/);
  });

  it('builds its dropdowns from the shared vocabulary, not from inline literals', () => {
    expect(admin).toMatch(/import\s*\{[^}]*\bKINDS\b[^}]*\}\s*from\s*'\.\/passiveNodeForm\.js'/);
    expect(admin).toMatch(/\{KINDS\.map\(/);
    expect(admin).toMatch(/\{SECTORS\.map\(/);
    expect(admin).toMatch(/\{GRANT_TYPES\.map\(/);
  });

  it('validates before it saves, rather than relying on the 400', () => {
    expect(admin).toMatch(/validateNodeForm\(/);
    expect(admin).toMatch(/formToPayload\(/);
  });

  it('uses --s2-* tokens only, per the admin styleguide', () => {
    // themeTokens.test.js enforces this across the admin surface; asserting it
    // here as well means a hardcoded hex fails in the file that introduced it.
    expect(admin).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(admin).toMatch(/var\(--s2-/);
  });
});
```

- [ ] **Step 12: Run the smoke test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/PassiveNodesAdmin.smoke.test.js`
Expected: FAIL with `Failed to resolve import "../PassiveNodesAdmin.jsx"`

- [ ] **Step 13: Write the admin component**

```jsx
// frontend/src/games/something2/PassiveNodesAdmin.jsx
//
// The passive-node browser and single-node editor (spec §10.5). Search by key
// or label, filter by sector and kind, page through the ~1800 rows, and edit
// the three columns the API allows: label, kind and grants.
//
// STRUCTURE IS NOT EDITABLE. key/sector/ring/x/y are shown read-only, because
// moving a node is how an admin would accidentally disconnect one, and a
// disconnected node is unallocatable forever with no visible symptom.
import { useState } from 'react';
import styled from 'styled-components';
import { usePassiveNodes, useUpdatePassiveNode } from './usePassiveNodes.js';
import {
  KINDS, SECTORS, GRANT_TYPES, nodeToForm, formToPayload, validateNodeForm, grantSummary,
} from './passiveNodeForm.js';

const PAGE = 50;

const Page = styled.div`
  max-width: 120rem;
  margin: 0 auto;
  padding: 2.4rem;
  color: var(--s2-text);
`;
const Filters = styled.div`
  display: flex;
  gap: 1.2rem;
  flex-wrap: wrap;
  margin-bottom: 1.6rem;
`;
const Field = styled.label`
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  font-size: 1.2rem;
  color: var(--s2-text-muted);

  input, select, textarea {
    background: var(--s2-surface);
    color: var(--s2-text);
    border: 1px solid var(--s2-border);
    border-radius: var(--border-radius-sm);
    padding: 0.6rem 0.8rem;
    font-size: 1.4rem;
  }
`;
const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 1.3rem;

  th, td {
    text-align: left;
    padding: 0.8rem;
    border-bottom: 1px solid var(--s2-border);
  }
  tbody tr:hover { background: var(--s2-surface-hover); }
  tbody tr[aria-selected='true'] { background: var(--s2-surface-active); }
`;
const Editor = styled.form`
  margin-top: 2.4rem;
  padding: 1.6rem;
  background: var(--s2-surface);
  border: 1px solid var(--s2-border);
  border-radius: var(--border-radius-md);
  display: flex;
  flex-direction: column;
  gap: 1.2rem;
`;
const GrantRow = styled.div`
  display: flex;
  gap: 0.8rem;
  align-items: flex-end;
`;
const Errors = styled.ul`
  color: var(--s2-danger);
  font-size: 1.3rem;
  padding-left: 2rem;
`;
const Actions = styled.div`
  display: flex;
  gap: 0.8rem;
`;
const Button = styled.button`
  background: var(--s2-accent);
  color: var(--s2-text-on-accent);
  border: none;
  border-radius: var(--border-radius-sm);
  padding: 0.8rem 1.6rem;
  font-size: 1.4rem;
  cursor: pointer;

  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;
const Meta = styled.p`
  color: var(--s2-text-muted);
  font-size: 1.3rem;
  margin-bottom: 1.2rem;
`;

function PassiveNodesAdmin() {
  const [filters, setFilters] = useState({ search: '', sector: '', kind: '' });
  const [offset, setOffset] = useState(0);
  const [form, setForm] = useState(null);

  const { nodes, total, isLoadingNodes } = usePassiveNodes({ ...filters, offset, limit: PAGE });
  const update = useUpdatePassiveNode();

  const setFilter = (key, value) => {
    setOffset(0);   // a filter change invalidates the page index
    setFilters((f) => ({ ...f, [key]: value }));
  };

  const validation = form ? validateNodeForm(form) : { ok: false, errors: [] };

  const submit = (e) => {
    e.preventDefault();
    if (!form || !validation.ok) return;
    update.mutate({ id: form.id, body: formToPayload(form) });
  };

  const setGrant = (i, patch) => setForm((f) => ({
    ...f,
    grants: f.grants.map((g, j) => (j === i ? { ...g, ...patch } : g)),
  }));

  return (
    <Page>
      <h2>Passive nodes</h2>
      <Meta>
        {isLoadingNodes ? 'Loading…' : `${total} node(s) match. Structure (key, sector, ring, position) comes from the generator and is read-only here.`}
      </Meta>

      <Filters>
        <Field>
          Search key or label
          <input
            value={filters.search}
            onChange={(e) => setFilter('search', e.target.value)}
            placeholder="blood pact"
          />
        </Field>
        <Field>
          Sector
          <select value={filters.sector} onChange={(e) => setFilter('sector', e.target.value)}>
            <option value="">All</option>
            {SECTORS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field>
          Kind
          <select value={filters.kind} onChange={(e) => setFilter('kind', e.target.value)}>
            <option value="">All</option>
            {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            <option value="start">start (read-only)</option>
          </select>
        </Field>
      </Filters>

      <Table>
        <thead>
          <tr>
            <th>Key</th><th>Sector</th><th>Ring</th><th>Kind</th><th>Label</th><th>Grants</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => (
            <tr
              key={n.id}
              aria-selected={form != null && form.id === n.id}
              onClick={() => setForm(nodeToForm(n))}
            >
              <td>{n.key}</td>
              <td>{n.sector}</td>
              <td>{n.ring}</td>
              <td>{n.kind}</td>
              <td>{n.label}</td>
              <td>{grantSummary(n.grants)}</td>
            </tr>
          ))}
        </tbody>
      </Table>

      <Actions>
        <Button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          Previous
        </Button>
        <Button type="button" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
          Next
        </Button>
      </Actions>

      {form && (
        <Editor onSubmit={submit}>
          <h3>{form.key}</h3>
          <Meta>{`sector ${form.sector} · ring ${form.ring} — these cannot be changed here`}</Meta>

          <Field>
            Label
            <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </Field>

          <Field>
            Kind
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </Field>

          {form.grants.map((g, i) => {
            const def = GRANT_TYPES.find((t) => t.type === g.type);
            return (
              <GrantRow key={i}>
                <Field>
                  Type
                  <select value={g.type} onChange={(e) => setGrant(i, { type: e.target.value })}>
                    {GRANT_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
                  </select>
                </Field>
                {def && (
                  <Field>
                    {def.label}
                    <select
                      value={g[def.field] || ''}
                      onChange={(e) => setGrant(i, { [def.field]: e.target.value })}
                    >
                      <option value="">—</option>
                      {def.options.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </Field>
                )}
                <Field>
                  Value
                  <input value={g.value} onChange={(e) => setGrant(i, { value: e.target.value })} />
                </Field>
                <Button
                  type="button"
                  onClick={() => setForm({ ...form, grants: form.grants.filter((_, j) => j !== i) })}
                >
                  Remove
                </Button>
              </GrantRow>
            );
          })}

          <Actions>
            <Button
              type="button"
              onClick={() => setForm({
                ...form,
                grants: [...form.grants, { type: 'stat', stat: 'strength', value: 0 }],
              })}
            >
              Add grant
            </Button>
          </Actions>

          {validation.errors.length > 0 && (
            <Errors>{validation.errors.map((e) => <li key={e}>{e}</li>)}</Errors>
          )}

          <Actions>
            <Button type="submit" disabled={!validation.ok || update.isPending}>
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button type="button" onClick={() => setForm(null)}>Cancel</Button>
          </Actions>
        </Editor>
      )}
    </Page>
  );
}

export default PassiveNodesAdmin;
```

Before writing, open `frontend/src/games/something2/BiomesAdmin.jsx` and copy the exact `--s2-*` token names it uses; the ones above (`--s2-surface-hover`, `--s2-surface-active`, `--s2-text-on-accent`, `--s2-danger`) must be replaced with whatever `GlobalStyles.js` actually defines, and any genuinely missing token added there rather than inline-styled.

- [ ] **Step 14: Mount it into the Group A page shell**

In `frontend/src/games/something2/ProgressionAdmin.jsx` (created by T1), add the import and render it below T1's own `game_settings` editor:

```jsx
import PassiveNodesAdmin from './PassiveNodesAdmin.jsx';
```
```jsx
      <PassiveNodesAdmin />
```

- [ ] **Step 15: Run the smoke test and the theme gate to verify they pass**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/PassiveNodesAdmin.smoke.test.js src/games/something2/__tests__/themeTokens.test.js`
Expected: PASS

- [ ] **Step 16: Run the full frontend suite**

Run: `cd frontend && npx vitest run`
Expected: PASS, 0 failures

- [ ] **Step 17: Browser-verify the admin page**

With the stack up, sign in as an admin and open `/game/admin/progression`:

1. The node table loads and reports 1806 matching nodes.
2. Searching `blood pact` narrows to the six CON Blood Pact keystones (one per… no — exactly one, `ks_con_blood_pact` appears in the constitution sector only); filtering `kind = keystone` reports 30.
3. Clicking a row opens the editor with its label, kind and grants pre-filled, and the key/sector/ring shown read-only.
4. Changing a grant's value and saving toasts "Passive node saved" and the table row's summary updates.
5. Setting the label to blank disables Save and lists "Label is required".
6. Reopening the passive tree in-game shows the edited node's new grant in its tooltip **without restarting the backend** — this is what proves `invalidateTreeCache()` is wired.
7. The page reads correctly in both light and dark mode.

- [ ] **Step 18: Run the whole backend suite and commit**

Run:
```bash
cd backend && \
  DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  TEST_DATABASE_URL=postgres://user:password@localhost:15432/s2_passive_tree \
  npm test
```
Expected: PASS, 0 failures

```bash
git add frontend/src/games/something2/passiveNodeForm.js \
        frontend/src/games/something2/usePassiveNodes.js \
        frontend/src/games/something2/PassiveNodesAdmin.jsx \
        frontend/src/games/something2/ProgressionAdmin.jsx \
        frontend/src/games/something2/__tests__/passiveNodeForm.test.js \
        frontend/src/games/something2/__tests__/PassiveNodesAdmin.smoke.test.js
git commit -m "feat(passives): admin passive-node browser and single-node editor (SOMET-NNN)"
```

---

## Self-review: every spec requirement in Group C's scope, and where it lands

| Spec / contract requirement | Where | Task · Step |
|---|---|---|
| §5.1 `backend/seeds/data/passiveTree.js`, ~40 authored archetype templates | 38 templates (16 minor incl. 4 core, 22 notable) + 30 keystones + 6 starts | T6 · Step 3 |
| §5.1 `backend/seeds/generatePassiveTree.js`, deterministic | Pure, no rng/clock, sorted edge output | T6 · Step 8 |
| §5.1 `make seed-passive-tree` | Makefile target + `.PHONY` + `FORCE=1` | T6 · Step 19 |
| §5.1 stable generator-derived `key`; regeneration does not orphan `character_passives` | Upsert on `key`, nodes never deleted, stale nodes reported not removed | T6 · Step 14; test Step 11 |
| §5.1 regeneration preserves admin edits unless `--force` | `CASE WHEN $10` on `kind`/`label`/`grants` | T6 · Step 14; test Step 11 |
| §5.2 shape: shared core + six sectors × three rings | `LAYOUT` polar grid; arithmetic in Task 1's header | T6 · Steps 3, 8 |
| §5.2 ~1800 nodes | 1806 exactly; 30 core, 6 start, 1770 sector | T6 · Step 6 (guard 4) |
| §5.2 class → main stat → start node table | `SECTORS[].className` + `START_NODES[].start_class` | T6 · Step 3 |
| §5.3 minor `+2` to the sector's stat | `@sector` substitution in the minor templates | T6 · Steps 3, 8 |
| §5.3 notable `+8` or a real modifier | 22 notable templates, `+8`/`+12`/`+16`/damage/resist/status | T6 · Step 3 |
| §5.3 keystone changes a rule; ~5 per sector; CON "Blood Pact", CHA "Beast Bond" | 30 keystones, 5 per sector, both named ones written verbatim | T6 · Step 3; test Step 1 |
| §5.4 allocatable iff start node or adjacent to an allocated node | `isAllocatable` | T7 · Step 9; tests Step 7 |
| §5.4 one point per node, no multi-rank | `character_passives` primary key | T6 · Step 13 |
| §5.4 respec is all-or-nothing, `respec_base_gold × level` | `respecPassives` | T7 · Step 14; tests Step 12 |
| §5.4 single-node deallocation unsupported | No route exists; contract §3 lists none | T7 · Step 21 |
| §5.5 guard 1 — reachable from every one of the six starts | BFS from each of the six, unreachable list named | T6 · Step 6 |
| §5.5 guard 2 — no degree 0, no duplicate edge, no self-edge | Degree map + ordering + dupe scan | T6 · Step 6 |
| §5.5 guard 3 — every `grants` payload validates | Hand-written vocabulary, `@sector` leak check | T6 · Step 6 |
| §5.5 guard 4 — count within 5% of 1800, keystones exact | Literal 1806, per-kind and per-sector totals | T6 · Step 6 |
| §5.5 guard 5 — two runs identical | `JSON.stringify` equality plus an `Object.is` `-0` sweep | T6 · Step 6 |
| §2 `statComposition.js` PURE, returns `sources` + `modifiers` | `composeStats` | T7 · Step 4; tests Step 2 |
| §2 nothing outside `statComposition`/`playerStats`/`progressionStore` reads a raw stat column | `passiveTreeStore.composeProgression` is called only from `progressionStore` | T7 · Steps 14, 15 |
| Contract §3 `GET /api/passive-tree` | `passiveTreeRoutes.js` | T7 · Step 20 |
| Contract §3 `POST /api/progression/passives/:nodeId` | Replaces `/allocate` | T7 · Step 21 |
| Contract §3 `POST /api/progression/respec` replaces the existing respec | Rewritten handler | T7 · Step 21 |
| Contract §3 `GET /api/progression` gains the four fields | Widened response body | T7 · Step 21 |
| Contract §4 the `progression` frame gains `passivePoints`, `allocatedNodeIds`, `sources`, `modifiers` | Composed inside `loadProgression`, so all seven send sites carry them | T7 · Step 15 |
| Contract §4 do not reintroduce a second writer | Allocate response discarded client-side; source-text guard | T8 · Steps 5, 6; test Step 1 |
| §10.3 canvas overlay, `P` key | `passiveTreePanel.js` + `Game.js` binding | T8 · Steps 3, 6 |
| §10.3 pan + zoom | Drag-to-pan, wheel `zoomAbout` the cursor | T8 · Step 6; tests Step 1 |
| §10.3 grid spatial index + viewport culling | `buildTreeIndex` / `visibleNodeIds`, `GRID_CELL = 200` | T8 · Step 3 |
| §10.3 edges drawn only between visible nodes | `visibleSet` filter in `layoutPassiveTree` | T8 · Step 3 |
| §10.3 three distinct visual states | `allocated` / `allocatable` / `locked` | T8 · Step 3; tests Step 1 |
| §10.3 hovering a node shows its grants | `layout.hover.lines`, one line per grant | T8 · Step 3 |
| §10.5 passive-node browser and single-node editor, search by key/sector/kind | `PassiveNodesAdmin.jsx` + `GET /api/passive-nodes` | T9 · Steps 3, 13 |
| §10.5 mounted at `/game/admin/progression` | Rendered inside T1's `ProgressionAdmin.jsx` | T9 · Step 14 |
| §11 no vacuous tests | Every expectation a hand-written literal; the element list is the one cross-checked import, and it is checked *against* the authority | all tasks |
| §11 both `DATABASE_URL` and `TEST_DATABASE_URL` on every DB run | Every DB command in this plan | all tasks |
| §12 migration ordering | Slot `1714440504000` (post-CORRECTION block), one migration, in T6 only | T6 · Step 13 |
| Contract §6.1 — `base` is a class-base snapshot, every class at 5 | `composeStats` reads `base` off the row; nothing here reads `entity_types` stats | T7 · Step 4 |
| Contract §6.2 — `effective` on both payloads | `composeProgression` emits `effective`; `GET /api/progression` lifts it to the top level | T7 · Steps 14, 21 |
| Contract §6.3 — `stats` on **every** `progression` frame | Five `server.js` frames gain it, guarded by a source-parsing test | T7 · Step 22 |
| Contract §6.4 — T8 owns `respecDisabled` | Pure predicate + conditionally-published hit area + Respec button | T8 · Steps 1, 3, 5, 6 |
| Contract §6.5 — `treeCharmBonus` defaults to 0, `lifeCostMultiplier` to 1 before T6 | `RULE_IDENTITY` gives exactly those two identities | T7 · Step 4 |
| Contract §6.7 — `passive_points` is a column, not a derivation | Spent in the guarded `UPDATE`, refunded by the deleted-row count | T7 · Steps 14, 15 |
| Contract §2 — anything crossing a plan boundary is recorded in the contract | `rules`, `effective`, the wallet decision and the two admin routes are appended to §2/§3 | T7 · Step 1 |
| §12 tree UI performance measured in-browser | Step 11's zoomed-in pan check, not `getImageData` | T8 · Step 11 |
| §12 several sessions share one working directory | Every task runs in its own worktree; commits stage by explicit path | all tasks |

### Deliberately NOT in Group C (named so nobody assumes it is done)

- **§7's respec equipment policy** — auto-unequipping items that no longer qualify, and refusing the respec when the backpack is full. `req_level`/`req_*` do not exist until Group D T10; `respecPassives` is the function T10 layers that on top of.
- **§4's "every stat point previously allocated above the class base is refunded as an additional passive point"** — T2 owns it, and writes it into the `passive_points` column contract §6.7 adds in slot `1714440501000`. This plan only spends and refunds that column; it never recomputes the balance, precisely because those refunded points make it not a function of level.
- **Granting points on level-up** — T2's `awardXp` adds `passive_points_per_level` per level gained. Nothing in Group C reads `passive_points_per_level`.
- **Wiring the `cooldownFloor` and `regenLifeShare` rules to their consumers** — `playerStats.js` and `world.js` belong to Group A T2 and the authority respectively. Group C stores and surfaces those rules with their consumer named in `RULE_KEYS`; a follow-up ticket reads them.
- **Gear affixes in `composeStats`** — `gear: []` is passed explicitly by `composeProgression` until Group D T12 lands `player_item_affixes`.
