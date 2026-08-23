# Progression Epic — Shared Contract

Binding on every plan in this epic. Spec:
`docs/superpowers/specs/2026-08-23-progression-passive-tree-design.md`

Plans are written in parallel, so anything crossing a plan boundary is fixed
here. **Do not invent a different name, signature, route or migration
timestamp than the one recorded below.** If a plan needs something not listed,
it must add it here in the same commit.

## 1. Migration timestamp allocation

The block `1714440500000`–`1714440530000` is reserved for this epic.

**CORRECTION 2026-08-23.** This contract originally reserved
`1714440400000`–`1714440430000`. That block is **already occupied on main** by
`1714440400000_biome_path_tile.js`, `1714440410000_invite_codes.js` and
`1714440420000_inventory_slots.js` — the original reservation was made from a
directory listing truncated at 100 of 109 files. Any plan still naming a
`14400400xx`–`14400420xx` slot is wrong and must be re-pointed at the table
below. The highest timestamp on main is `1714440420000`.

Migration timestamps have collided across concurrent branches in this repo
before, so each task gets exactly one slot and may not take another.

| Slot | Task | Content |
|---|---|---|
| `1714440500000` | T1 | `game_settings` table + default rows |
| `1714440501000` | T2 | level CHECK 1..150, drop `stat_points`, class-base snapshot backfill |
| `1714440502000` | T3 | `entity_types.main_stat`, four new playable rows, loadouts |
| `1714440503000` | T5 | `world_creatures` charm columns, `character_summons` |
| `1714440504000` | T6 | `passive_nodes`, `passive_edges`, `character_passives` |
| `1714440505000` | T10 | `item_types` `req_level` + six `req_*` + `item_level` + `tier` |
| `1714440506000` | T11 | base gear ladder seed |
| `1714440507000` | T12 | `affix_types`, `player_item_affixes`, `player_items` + `world_items` columns |
| `1714440508000` | T13 | `rarity_weights` default setting row |

T4, T7, T8, T9, T14 and T15 add **no** migration.

Note: main already carries two duplicate-timestamp pairs (`1714440360000` and
`1714440370000` each appear twice). Do not add a third — if `migrate:up`
reports "Not run migration X is preceding Y", use
`backend/scripts/repair-migration-order.js`, never `--no-check-order`.

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

`GET /api/progression` additionally carries `respecDisabled` — the §6.4
predicate T8 needs — plus the `gold` and `respecCost` it is computed from, so
the tree overlay never has to reproduce the affordability rule client-side
(that is the `xpCurve.js`/`RESPEC_BASE` drift the F2 header names).

Two admin routes are added to the §3 table:

| Method | Path | Task | Auth |
|---|---|---|---|
| `GET` | `/api/passive-nodes` | T9 | admin; `?search=&sector=&kind=&limit=&offset=` |
| `PUT` | `/api/passive-nodes/:id` | T9 | admin; `label`, `kind`, `grants` only |

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

## 6. Amendments

Recorded after the five plans were drafted. These override anything above that
contradicts them.

### 6.1 T2 owns the class-base stat snapshot (spec §3.3) — and every base stays 5

Spec §3.3 freezes the six stat columns into a snapshot written once at
character creation. No task owned that writer, which would have left
`composeStats`'s `base` input with no source.

**T2 owns it**, both halves: the migration backfills existing characters, and
`createCharacter` writes the snapshot at creation. T2 also owns the new
`player_progression.passive_points` column (see §6.7).

**CORRECTION — do NOT backfill from `entity_types`.** An earlier revision of
this amendment said to copy the class's `entity_types` stats into
`player_progression`. That is wrong and would silently rebalance every
character in the database. `entity_types` carries stats of 10 (Warrior) and
DEX 12 (Ranger), while `player_progression` bases everything on
`BASE_STAT = 5`, and every formula in `playerStats.js` is an identity at 5 —
`progressionConstants.js` declares that property explicitly non-provisional.
Copying a CON of 10 across makes `maxHp = 100 + 10×(10−5) = 150`, i.e. +50 max
HP for every existing character, with no test noticing.

**Every class therefore bases at 5 on all six stats.** Class identity comes
from the tree start position and the starting loadout, not from different base
stats. This keeps a level-1 character of every class reproducing the game's
pre-epic numbers exactly (100 hp, 100 mana, ×1.0 damage), which is the one
property `progressionConstants.js` forbids changing.

The snapshot column still exists and is still written once — it is what lets a
future revision differentiate class bases without retroactively changing
characters that already exist.

### 6.2 Composed stat totals travel on the wire

The `progression` websocket frame and `GET /api/progression` both carry the
**composed effective totals**, not the raw columns. Once §3.3 lands,
`progression.strength` is a class-base snapshot and is no longer the effective
value, so a client reading it would silently show the wrong number.

T7 adds `effective: {strength, dexterity, constitution, intelligence, wisdom,
charisma}` to both payloads, alongside `sources` and `modifiers`.

Consumers must render `effective`, never re-sum `sources` client-side and never
read the raw columns.

### 6.3 `stats` is not on every `progression` frame

Verified against `server.js`: `stats` rides only the `refreshPlayerStats` push.
The kill-XP push, the death push and the `joined` frame omit it.

T7 puts `stats` on **every** `progression` frame. Until it does, a client must
seed from `GET /api/progression` (which already returns `stats`) and let later
frames overwrite — that is what T15 does.

### 6.4 T8 owns the `respecDisabled` predicate

Respec is a passive-tree action, not a character-sheet one, so T15 deletes the
sheet's respec control and its tests. **T8 must reprovide the predicate** (can
this character afford a respec, and is one in flight) in the tree overlay, or
the affordability gate is silently lost and every unaffordable click 402s.

### 6.5 Values the spec left open, now fixed

| Thing | Value | Chosen by |
|---|---|---|
| Creature charm range | 200px | T5 plan |
| Creature charm duration | 120s | T5 plan |
| `treeCharmBonus` before T6 lands | literal `0` at the call site | T5 plan |
| `lifeCostMultiplier` before T6 lands | literal `1` at the call site | T4 plan |

### 6.6 Known landmines in existing tests

- `hotkeyRegistry.test.js:109` asserts **at least four** keydown-listener files
  and exactly four exist. Deleting the level popup (T15) turns it red. T15
  lowers the bound to 3 with the reason inline and adds a positive assertion
  that `Game.js` is the sole claimant of `c`.
- `ownedCharacter` gains a JOIN in T3. Test doubles that regex-match on
  `/FROM characters/` may break; T3 carries a named remediation step.

### 6.7 `passive_points` needs a column

`GET /api/progression` "gains `passivePoints`" and T2 must grant them, but no
migration slot declared storage for them.

T2's slot `1714440501000` adds
`player_progression.passive_points integer NOT NULL DEFAULT 0 CHECK (passive_points >= 0)`.
It is the only migration in this epic that touches that table.

### 6.8 `applyDeathPenalty` breaks silently under the new curve

`applyDeathPenalty` hardcodes `XP_BASE * level` as "the level's worth" — a
deliberate stand-in for `xpToNext`, which returns `Infinity` at MAX_LEVEL. Under
a non-linear curve that expression is simply wrong.

T2 extracts a private `levelWorth(level)` that both `xpToNext` and the death
penalty call, so the two cannot diverge again.

### 6.9 Corrected XP curve literals

The spec originally carried two wrong values. Verified with `node -e`:

| level | xpToNext |
|---|---|
| 2 | 45 |
| 10 | 385 |
| 50 | 3273 |
| 100 | **8228** (spec first said 8240) |
| 150 | **14108** (spec first said 14123) |

Cumulative to 50: **68,598**. Cumulative to 150: **901,212**.

### 6.10 `POST /api/progression/respec` between T2 and T7

With `stat_points` gone, respec has nothing to refund until the tree lands. T2
keeps the route, strips the refund, and removes the button — a respec that
charges gold to reset six columns nothing can raise is a pure gold sink.
Accepted, stated gap: the endpoint stays callable by hand until T7 replaces its
body.

### 6.11 Class pools are real again (SOMET-486) — decided 2026-08-24

`world.js:175` sets a joining player's pools from `derivePlayerStats`, which is
class-blind, so every class has had **100 hp / 100 mana** since SOMET-242 while
character select advertised 100/85/75. The advertised numbers were a lie.

**Decision: options 1 and 3 together, with a strict division of labour.**

**Option 1 — pools come from the class base.** The formulas become:

```
maxHp   = classBaseHp   + HP_PER_CON   * (constitution - BASE_STAT)
maxMana = classBaseMana + MANA_PER_INT * (intelligence - BASE_STAT)
```

`derivePlayerStats` therefore needs the class's base pools as an input. This is
the ONE place pools are computed; `world.js` keeps reading it.

**The `entity_types` mana values are re-authored, not adopted.** They currently
read 50/50/70 while the live game gives everyone 100 — they have been dead code
since SOMET-242, so adopting them would not be "restoring" a working system, it
would be activating numbers that have never run. Applying them as-is would halve
every existing character's mana. **Warrior stays at 100/100**, and the six
classes are balanced against each other deliberately in B1.

This keeps A2's guard true: no existing character's pools move. All 8 live
characters are Warriors, and Warrior's `entity_types` HP is already 100.

**Option 3 — start nodes carry class identity, as RULES not numbers.** A class's
tree start node grants its mechanical identity (the Cultist's life-cost
affinity, the Druid's charm affinity), never a raw pool bonus. Pools are option
1's job. Keeping the split strict is what stops class identity being counted
twice.

**This reverses a rule already merged in C1.** `passive_tree_generator.test.js`
asserts *"a start node grants nothing — it is free, so it must also be inert"*.
That test and the generator's start-node handling must change together, and the
new test must assert the grants are the intended per-class ones rather than
merely non-empty — otherwise it degrades into "a start node grants something",
which would pass for any typo.

**Sequencing.** SOMET-486 lands FIRST and alone: the formula change plus
re-authored pools for the three existing classes, pinned by tests. B1 then adds
the four new classes' pools and all six start-node grants on top. 486 must also
land AFTER C2, because both touch `derivePlayerStats`' inputs.
