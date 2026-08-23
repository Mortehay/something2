# Progression Epic — Shared Contract

Binding on every plan in this epic. Spec:
`docs/superpowers/specs/2026-08-23-progression-passive-tree-design.md`

Plans are written in parallel, so anything crossing a plan boundary is fixed
here. **Do not invent a different name, signature, route or migration
timestamp than the one recorded below.** If a plan needs something not listed,
it must add it here in the same commit.

## 1. Migration timestamp allocation

The block `1714440400000`–`1714440430000` is reserved for this epic. Migration
timestamps have collided across concurrent branches in this repo before, so
each task gets exactly one slot and may not take another.

| Slot | Task | Content |
|---|---|---|
| `1714440400000` | T1 | `game_settings` table + default rows |
| `1714440401000` | T2 | level CHECK 1..150, drop `stat_points` |
| `1714440402000` | T3 | `entity_types.main_stat`, four new playable rows, loadouts |
| `1714440403000` | T5 | `world_creatures` charm columns, `character_summons` |
| `1714440404000` | T6 | `passive_nodes`, `passive_edges`, `character_passives` |
| `1714440405000` | T10 | `item_types` `req_level` + six `req_*` + `item_level` + `tier` |
| `1714440406000` | T11 | base gear ladder seed |
| `1714440407000` | T12 | `affix_types`, `player_item_affixes`, `player_items` + `world_items` columns |
| `1714440408000` | T13 | `rarity_weights` default setting row |

T4, T7, T8, T9, T14 and T15 add **no** migration.

## 2. Module contracts

All backend modules are CommonJS. Modules marked PURE take no database,
no clock and no `Math.random()` — randomness and time are injected by the
caller, matching `rollDrops`/`rollGold`/`applyDeathPenalty`.

### `backend/src/services/gameSettings.js` — T1

```js
const DEFAULTS = {
  passive_points_per_level: 1,
  ground_item_ttl_seconds: 180,
  respec_base_gold: 50,
  rarity_weights: [
    { item_level: 1,   white: 90, blue: 9,  yellow: 1,  foxy: 0 },
    { item_level: 50,  white: 70, blue: 21, yellow: 8,  foxy: 1 },
    { item_level: 150, white: 45, blue: 30, yellow: 20, foxy: 5 },
  ],
};

async function getSetting(pool, key)             // -> value, or DEFAULTS[key] if absent
async function getSettings(pool, keys)           // -> { key: value } for every key requested
async function setSetting(pool, key, value)      // upsert; throws on unknown key
module.exports = { DEFAULTS, getSetting, getSettings, setSetting };
```

An unknown key is an error, never a silent insert: a typo'd key that inserts
successfully is a setting nothing reads.

### `backend/src/services/playerStats.js` — T2 modifies, does not replace

Exported names are unchanged. Behaviour changes:

```js
MAX_LEVEL   = 150            // in progressionConstants.js
XP_BASE     = 18
XP_EXPONENT = 1.33
xpToNext(level)   // Math.round(XP_BASE * Math.pow(level, XP_EXPONENT)); Infinity at MAX_LEVEL
xpFloor(level)    // cumulative; precomputed 150-entry table at module load
levelForXp(xp)    // binary search over that table
```

`refundedPoints` and `DEFAULT_PROGRESSION.stat_points` are **removed** in T2.

### `backend/src/services/statComposition.js` — T7, PURE

```js
/**
 * base     {strength,dexterity,constitution,intelligence,wisdom,charisma}
 * passives [{ type, stat?, value, label, ... }]   flattened passive_nodes.grants
 * gear     [{ label, effect, value }]             effect is affix_types.effect
 */
function composeStats({ base, passives, gear }) -> {
  strength, dexterity, constitution, intelligence, wisdom, charisma,   // integers
  sources:   { <statKey>: { base: n, tree: n, gear: n } },
  modifiers: [ { label, value, source, kind, detail } ],
}
// source: 'tree' | 'gear'
// kind:   'stat' | 'resource' | 'damage' | 'resist' | 'status'
module.exports = { composeStats, STAT_KEYS };
```

`sources` and `modifiers` exist so the Character tab never recomputes a
breakdown. Recomputing it client-side is the drift that killed `xpCurve.js`.

### `backend/src/authority/rarity.js` — T13, PURE

```js
function interpolateWeights(itemLevel, anchors) -> { white, blue, yellow, foxy }  // normalised to sum 1
function rollRarity(itemLevel, anchors, rng) -> 'white'|'blue'|'yellow'|'foxy'
module.exports = { interpolateWeights, rollRarity, RARITIES };
const RARITIES = ['white', 'blue', 'yellow', 'foxy'];
```

### `backend/src/authority/affixes.js` — T12, PURE

```js
function rarityAffixCount(rarity, rng) -> 0 | 1 | 3..6 | 3..9
function eligibleAffixes(affixPool, { itemLevel, rarity, slot }) -> affixType[]
function rollItemInstance({ itemType, itemLevel, rarity, affixPool }, rng) -> {
  rarity, itemLevel, affixes: [ { affixTypeId, key, value } ],
}
module.exports = { rarityAffixCount, eligibleAffixes, rollItemInstance, FOXY_VALUE_MULT };
const FOXY_VALUE_MULT = 1.25;
```

Sampling is **without replacement** by affix key. Debuff affixes are eligible
only when `rarity === 'foxy'`.

### `backend/src/services/charm.js` — T5, PURE

```js
function charmBudget(effectiveCharisma, treeCharmBonus) -> Math.floor(cha / 2) + bonus
function canSummon(activeSummonLevels, candidateLevel, budget) -> { ok, reason }
const PLAYER_CHARM_MS = 4000;
const PLAYER_CHARM_IMMUNITY_MS = 8000;
module.exports = { charmBudget, canSummon, PLAYER_CHARM_MS, PLAYER_CHARM_IMMUNITY_MS };
```

### `backend/src/services/lifeCost.js` — T4, PURE

```js
const LIFE_COST_RATIO = 0.6;
function lifeCostFor(manaCost, lifeCostMultiplier = 1) -> Math.ceil(manaCost * LIFE_COST_RATIO * mult)
function canPayLife(currentHp, cost) -> currentHp - cost >= 1
module.exports = { LIFE_COST_RATIO, lifeCostFor, canPayLife };
```

### `backend/seeds/generatePassiveTree.js` — T6, PURE

```js
function generatePassiveTree(spec) -> {
  nodes: [ { key, sector, ring, x, y, kind, label, grants, start_class } ],
  edges: [ [keyA, keyB] ],     // keyA < keyB lexicographically, deduped
}
module.exports = { generatePassiveTree };
```

Deterministic: same `spec` in, byte-identical output. No `Math.random()`, no
`Date.now()`.

## 3. HTTP routes

| Method | Path | Task | Auth |
|---|---|---|---|
| `GET` | `/api/settings` | T1 | admin |
| `PUT` | `/api/settings/:key` | T1 | admin |
| `GET` | `/api/passive-tree` | T7 | player; whole graph, immutable, cacheable |
| `POST` | `/api/progression/passives/:nodeId` | T7 | player; allocate one node |
| `POST` | `/api/progression/respec` | T7 | player; replaces the existing respec |
| `GET` | `/api/affix-types` | T12 | admin |
| `POST`/`PUT`/`DELETE` | `/api/affix-types[/:id]` | T12 | admin |

`GET /api/progression` (exists) gains `passivePoints`, `allocatedNodeIds`,
`sources`, `modifiers`. Its existing `xpFloor`/`xpToNext`/`respecCost` fields
keep their names.

## 4. Websocket protocol

The existing `progression` frame is the **single writer** of client-side
progression state. That is not an accident: `CharacterSheet.jsx`'s F1 header
documents a cross-channel race that was fixed by removing the second writer.
Do not reintroduce one.

The frame gains: `passivePoints`, `allocatedNodeIds`, `sources`, `modifiers`.

New outbound frame, T14:

```js
{ type: 'vfx', name: 'item_despawn', x, y }
```

Presentation only. No damage, no knockback, no collision.

## 5. Global constraints

- **Backend:** CommonJS, Express, raw `pg` queries, inline routes. See
  `.ai/styleguides/backend.md`.
- **Frontend admin:** React 19, styled-components, `--s2-*` tokens only,
  TanStack Query for data. See `.ai/styleguides/frontend.md`.
- **Game client:** plain ES modules under
  `frontend/src/games/something2/src/js`. Layout/maths live in testable
  functions separate from canvas draw calls, as `inventoryPanel.js` already
  does.
- **Tests:** backend `npm test` from `backend/`; frontend `npx vitest run`
  from `frontend/`. Any DB-touching test run MUST set both `DATABASE_URL` and
  `TEST_DATABASE_URL` to a per-branch scratch database, seeded with the map
  specs. Unset `TEST_DATABASE_URL` silently targets the SHARED DEV DATABASE.
- **Never** run a destructive statement against the shared dev database. No
  `DELETE FROM`, `TRUNCATE` or `DROP` outside a scratch DB.
- **No vacuous tests.** A test must not derive its expected value by calling
  the same function or constant the code under test uses. XP-curve, affix-roll
  and stat-composition expectations are hand-written literals.
- **Worktrees:** several sessions share this checkout. Every task runs in its
  own `git worktree`; never `checkout`, `stash` or `branch` in the shared
  working directory. Stage by explicit path.
- **Commits:** branch `feat/<slug>`; subject `type(scope): summary (SOMET-NNN)`;
  end the message with the `Co-Authored-By: Claude Opus 5 (1M context)` trailer.
