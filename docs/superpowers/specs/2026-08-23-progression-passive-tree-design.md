# Progression, Passive Tree, and Item Rarity — Design

Date: 2026-08-23
Status: approved for planning
Supersedes nothing; extends the A1/A2 progression slices
(`1714440050000_creature_levels`, `1714440052000_player_progression`).

## 1. What this is

A Path-of-Exile-shaped rework of character progression, plus the item economy
that has to exist for it to mean anything:

1. Level cap 50 → 150 on a cheaper curve.
2. Six playable classes, each keyed to one of the six existing stats.
3. A single shared passive skill tree of ~1800 nodes with six class start
   positions. The tree becomes the **only** source of stat growth.
4. Level + stat requirements on equipment.
5. Per-instance item rarity (white / blue / yellow / foxy) with rolled affixes.
6. Drop tables weighted so rarity improves with item level.
7. Ground loot lives 180 seconds, then vanishes with a harmless puff.
8. The standalone level popup is deleted; a Character tab in the inventory
   panel replaces it with a full, itemised breakdown.

### Decisions taken during brainstorming

| Question | Decision |
|---|---|
| Tree topology | ONE shared tree, six rim start positions (PoE-style) |
| Old +STR/+DEX stat points | Removed entirely. The tree is the only stat source |
| Level cap / curve | 150, `xpToNext(L) = 18 * L^1.33`; existing characters re-levelled from their raw XP |
| Base gear catalog | Full ladder: 8 slots × 10 level tiers, generated from an authored tier spec |
| Druid charm on **players** | Short pacify, no control transfer. Creatures get full control transfer + summoning |
| Cultist resource | HP instead of mana at 0.6×; a lethal cast is refused, not fatal |

### Explicitly out of scope

- Active skill gems / skill slots. Weapons remain the source of attacks.
- Full PvP control transfer of a charmed player (see §8.2 — deliberately
  reduced to a pacify).
- Rebalancing existing creature damage/HP against the new stat ceilings.
  Creatures already span levels 1–150; tuning is a follow-up epic.
- Sprites for the ~150 new base items. They render as placeholder colour
  boxes until generated, exactly as new decoration types do today.

## 2. Core architecture

The one invariant that keeps this from becoming three stat systems:

> `derivePlayerStats()` in `backend/src/services/playerStats.js` remains the
> **only** place a derived number is computed.

It currently reads six raw columns. After this epic it reads a *composed*
bundle produced by a new pure module:

```
backend/src/services/statComposition.js          (new, pure, no DB/clock/rng)

  composeStats({ base, passives, gear }) -> {
    strength, dexterity, constitution, intelligence, wisdom, charisma,
    sources: { strength: {base: 5, tree: 33, gear: 4}, ... },   // for the UI
    modifiers: [ {label, value, source, kind}, ... ]            // flat list
  }
```

Flow:

```
characters.entity_type_id ──> class base stats (snapshotted at creation)
character_passives ────────> tree grants
player_equipment ──────────> gear affix grants
                              │
                              ▼
                     composeStats()  ──► derivePlayerStats() ──► maxHp,
                              │                                  meleeMult,
                              │                                  cooldownMult…
                              └──────► character sheet (uses .sources/.modifiers)
                              └──────► canEquip() requirement check
```

`composeStats` returns the itemised `sources`/`modifiers` alongside the totals
because the Character tab has to show *"STR 42 = 5 base + 33 tree + 4 gear"*.
Deriving that breakdown a second time in the UI is exactly the drift this repo
has been bitten by before (`xpCurve.js`, deleted in the F2 fix).

**Rule:** nothing outside `statComposition.js`, `playerStats.js` and
`progressionStore.js` reads a raw stat column.

## 3. Data model

### 3.1 New tables

```sql
game_settings
  key            text primary key
  value          jsonb not null
  updated_at     timestamptz not null default now()

passive_nodes
  id             serial primary key
  key            text unique not null        -- stable, generator-derived
  sector         text not null               -- 'strength'|'dexterity'|...|'core'
  ring           smallint not null           -- 0=core, 1=inner, 2=middle, 3=outer
  x, y           real not null               -- layout coordinates
  kind           text not null               -- 'minor'|'notable'|'keystone'|'start'
  label          text not null
  grants         jsonb not null              -- [{type:'stat', stat:'strength', value:2}, ...]
  start_class    text                        -- non-null only on the six start nodes

passive_edges
  a_id, b_id     integer not null references passive_nodes
  primary key (a_id, b_id)                   -- stored with a_id < b_id, undirected

character_passives
  character_id   integer not null references characters on delete cascade
  node_id        integer not null references passive_nodes
  primary key (character_id, node_id)

affix_types
  id             serial primary key
  key            text unique not null
  label          text not null
  kind           text not null               -- 'buff' | 'debuff'
  effect         jsonb not null              -- {type:'stat',stat:'strength'} |
                                             -- {type:'resource',pool:'hp'} |
                                             -- {type:'damage',element:'fire'} |
                                             -- {type:'resist',element:'ice'} |
                                             -- {type:'status',status:'chill'}
  min_value      real not null
  max_value      real not null
  min_item_level integer not null default 1
  max_item_level integer                     -- null = no ceiling
  allowed_slots  text[] not null              -- '{}' = any slot
  min_rarity     text not null default 'blue'
  weight         integer not null default 100

player_item_affixes
  player_item_id uuid not null references player_items on delete cascade
  idx            smallint not null            -- 0..8, roll order
  affix_type_id  integer not null references affix_types
  value          real not null
  primary key (player_item_id, idx)

character_summons                             -- the druid's charmed roster
  id             serial primary key
  character_id   integer not null references characters on delete cascade
  creature_type  text not null
  level          integer not null
  charmed_at     timestamptz not null default now()
```

### 3.2 Altered tables

| Table | Change |
|---|---|
| `player_progression` | `level` CHECK becomes `1..150`; `stat_points` column dropped; the six stat columns are **frozen** (see §3.3) |
| `item_types` | `+req_level int not null default 1`, `+req_strength … +req_charisma int not null default 0`, `+item_level int not null default 1`, `+tier smallint not null default 1` |
| `player_items` | `+rarity text not null default 'white'` (CHECK in white/blue/yellow/foxy), `+item_level int not null default 1` |
| `world_items` | `+rarity text not null default 'white'`, `+item_level int not null default 1`, `+affixes jsonb not null default '[]'`, `+soulbound boolean not null default false` (see §3.4) |
| `entity_types` | `+main_stat text` (null for non-playable); four new playable rows: Monk, Cultist, Archer, Druid |
| `world_creatures` | `+charmed_by_character_id int references characters on delete set null`, `+charm_expires_at timestamptz` |

### 3.3 The six stat columns become a class-base snapshot

They are no longer allocatable. They are written **once**, at character
creation, from the class's `entity_types` row, and never mutated again.

They are kept rather than dropped for one reason: a later rebalance of a
class's base stats must not retroactively change characters that already
exist. Reading the base live from `entity_types` would do exactly that. The
existing `CHECK (… >= 5)` stays valid, since every class base is ≥ 5.

### 3.4 Ground items must carry their rolled identity

**This is a real constraint the current code imposes, not a preference.**

`dropItem` (`backend/src/authority/loot.js:433`) DELETEs the `player_items`
row and INSERTs a `world_items` row carrying only `item_type_id`. Under this
epic that silently converts a rolled foxy item into a plain white one on any
drop-and-repick. The stone system hit the same wall and resolved it by
*refusing to drop stones at all* — not an option for ordinary gear.

Resolution: `world_items` carries `rarity`, `item_level`, and a denormalised
`affixes` jsonb snapshot; `claimItem` reconstructs the instance
(`player_items` + `player_item_affixes`) from that snapshot. A denormalised
copy is acceptable here precisely because the row's maximum lifetime is 180
seconds and nothing else joins to it.

Soulbound (`player_items.soulbound`) is carried through the same way, so a
granted starter item cannot be laundered into a sellable one by dropping it.

**This requires a `world_items.soulbound` column, which an earlier revision of
this section omitted.** Without it the flag has nowhere to live for the 180
seconds the item is on the ground, and soulbound cannot round-trip at all.
Adding it also retires `dropItem`'s current *refusal* to drop a soulbound item
(`loot.js:505-511`) — that guard's own comment says it exists only because
there was nowhere to carry the flag.

### 3.5 `game_settings` keys

| Key | Default | Meaning |
|---|---|---|
| `passive_points_per_level` | `1` | Points granted per level-up |
| `ground_item_ttl_seconds` | `180` | Ground loot lifetime |
| `rarity_weights` | see §6 | Interpolation table by item level |
| `respec_base_gold` | `50` | Cost multiplier, `base × level` |

**The XP curve is deliberately NOT in `game_settings`.** Changing it re-levels
every character in the database on the next read — an admin toggling a number
in a form must not be able to do that. The curve stays in
`progressionConstants.js` where changing it is a code change with a migration
attached.

## 4. Level curve

```js
MAX_LEVEL = 150
XP_BASE = 18
XP_EXPONENT = 1.33
xpToNext(L) = Math.round(XP_BASE * Math.pow(L, XP_EXPONENT))
```

| Level | Cost of that level (old) | Cost (new) |
|---|---|---|
| 2 | 100 | 45 |
| 10 | 1,000 | 385 |
| 50 | 5,000 | 3,273 |
| 100 | — | 8,228 |
| 150 | — | 14,108 |

Cumulative XP to level 50 falls from 122,500 to 68,598 (about 1.79× cheaper
overall; early levels are ~2.5× cheaper, which is where the "levelling should
be cheaper" ask actually bites). Cumulative to 150 is 901,212.

All six figures above are computed values, not estimates — verify any change
with `node -e` before editing them, and never let a test derive them by calling
`xpToNext`.

`xpFloor` has no closed form with a fractional exponent, so a 150-entry
cumulative table is precomputed at module load and `levelForXp` binary-searches
it. This preserves the existing "never invert with a float sqrt" reasoning in
`playerStats.js` — an exact XP total must land on the correct side of a level
boundary every time.

**Migration of existing characters.** All 7 live characters are level 1–2 with
a maximum of 213 XP, so this is near-trivial in practice, but the rule is
stated for correctness: each character keeps its raw `experience`, is
re-levelled by the new curve, receives `passive_points_per_level × (level - 1)`
passive points, and every stat point previously allocated above the class base
is refunded as an additional passive point. Stat columns are reset to the class
base.

## 5. The passive tree

### 5.1 Production

Hand-authoring 1800 nodes is not viable, so the tree is **generated**:

```
backend/seeds/data/passiveTree.js        authored: ~40 archetype templates
backend/seeds/generatePassiveTree.js     deterministic generator
  └─> passive_nodes + passive_edges      via `make seed-passive-tree`
```

The generator is deterministic and re-runnable (same input ⇒ byte-identical
output), so the tree is diffable in review. Nodes are keyed by a stable
generator-derived `key`, which means a regeneration does not orphan anyone's
`character_passives` rows. After seeding, individual nodes are editable in the
admin UI; regeneration preserves admin edits by key unless `--force` is passed.

### 5.2 Shape

Six sectors radiating from a shared core, one per stat:

```
                    WIS  (Monk)
                     ╱ ╲
        CHA (Druid) ╱   ╲ INT (Mage)
                   │CORE │
        CON(Cultist)╲   ╱ DEX (Archer)
                     ╲ ╱
                    STR (Warrior)
```

| Region | Nodes | Composition |
|---|---|---|
| Core (shared) | ~30 | generic minors, reachable from every start |
| Each sector × 6 | ~295 | ring 1: 60 minor / 8 notable · ring 2: 100 minor / 14 notable / 2 keystone · ring 3: 90 minor / 18 notable / 3 keystone |
| **Total** | **~1800** | ~1500 minor, ~240 notable, ~30 keystone |

Class → main stat → start node:

| Class | Main stat | What that stat already drives |
|---|---|---|
| Monk | wisdom | mana regen |
| Warrior | strength | melee damage |
| Cultist | constitution | max HP (= their casting resource) |
| Archer | dexterity | attack speed |
| Druid | charisma | merchant prices; **now also charm power** |
| Mage | intelligence | max mana + spell damage |

No stat is renamed. All six already exist in `player_progression` and already
drive a real formula in `playerStats.js`.

### 5.3 Node kinds

- **minor** — `+2` to the sector's stat. The connective tissue.
- **notable** — `+8` to a stat, or a real modifier (`+12% projectile damage`,
  `+15 max mana`, `-8% cooldown`).
- **keystone** — changes a rule. Roughly five per sector, e.g.
  - CON: *"Blood Pact — life costs are reduced 25%"* (Cultist)
  - CHA: *"Beast Bond — charm budget +1 creature level per 10 CHA"* (Druid)
  - DEX: *"Fleet — cooldown floor lowered from 0.40 to 0.32"*
  - WIS: *"Clarity — mana regen also restores 20% as much life"*

### 5.4 Allocation rules

- A node is allocatable iff it is your class's start node, or it is adjacent
  (via `passive_edges`) to a node you have already allocated.
- One point per node. No multi-rank nodes.
- 150 points across ~1800 nodes reaches about 8% of the tree — the PoE ratio.
- Respec is all-or-nothing and costs `respec_base_gold × level`, matching the
  existing respec behaviour.
- Deallocating a single node is not supported (it can orphan a subtree).

### 5.5 Generator guard tests

These are the tests that stop the classic generator bugs, and they must fail
loudly rather than warn:

1. Every node is reachable from **every one of the six start nodes**. An
   orphaned cluster is invisible in the UI and unallocatable forever.
2. No node has degree 0. No duplicate edge. No self-edge.
3. Every `grants` payload validates against the known grant types — a typo'd
   stat name would silently grant nothing.
4. Node count is within 5% of 1800, and keystone count is exactly as specced.
5. Two consecutive generator runs produce identical output.

## 6. Rarity and affixes

### 6.1 Grades

| Grade | Affix count | Notes |
|---|---|---|
| white | 0 | base defence / attack only |
| blue | 1 | one buff affix |
| yellow | 3–6 | buff affixes |
| foxy | 3–9 | values ×1.25 vs yellow; may include **debuff** affixes |

Debuff affixes are the only affixes that act on someone else: they apply a
status to whatever the wielder hits. They ride the existing status system in
`backend/src/authority/effects.js`, which already supplies refresh-not-stack
semantics and — critically — the anti-chain-lock immunity window that
`effects.js` documents at length. A new debuff kind must obey those rules or
it becomes a permanent-lock exploit.

### 6.2 Rolling

Rolls happen **once, at drop time**, and are persisted per instance. The roller
is pure and takes an injected `rng`, matching `rollDrops`/`rollGold`:

```js
rollItemInstance({ itemType, itemLevel, rarity, affixPool }, rng) -> {
  rarity, itemLevel, affixes: [{ affixTypeId, value }, ...]
}
```

- `itemLevel` = the killed creature's level (or the chest's level).
- Pool filter: `min_item_level <= itemLevel`, `max_item_level` open or ≥,
  slot allowed, `min_rarity` satisfied, and `kind='debuff'` only when
  `rarity='foxy'`.
- Weighted sample **without replacement** — one affix key cannot appear twice
  on one item.
- `value = min_value + rng() * (max_value - min_value)`, scaled by item level,
  then ×1.25 for foxy.

### 6.3 Drop weighting

Interpolated by item level from `game_settings.rarity_weights`:

| item level | white | blue | yellow | foxy |
|---|---|---|---|---|
| 1 | 90% | 9% | 1% | 0% |
| 50 | 70% | 21% | 8% | 1% |
| 150 | 45% | 30% | 20% | 5% |

Weights are linearly interpolated between the anchor rows and always
normalised to 1.0 before rolling, so an admin who edits them to something that
does not sum to 100 gets a proportional result rather than a broken roll.

## 7. Equipment requirements

`item_types` gains `req_level` plus one `req_*` column per stat. `canEquip`
(`backend/src/authority/items.js:338`) gains the check.

**Circularity rule.** Requirements are evaluated against effective stats
**excluding the candidate item's own affixes**. Without this, an item granting
+20 STR satisfies its own 20-STR requirement, and a chain of such items
bootstraps a level-1 character into endgame gear.

**Requirements can stop being met** (respec, or unequipping a stat-granting
item). Policy: on respec, items that no longer qualify are auto-unequipped into
the backpack. If there is no room, **the respec is refused** with a clear
message — never silently delete gear, and never leave an illegally equipped
item live in the combat path.

**"No room" means `usedSlots > capacity`, not "no free slot".** An earlier
revision of this section said "if the backpack is full". That condition is
*unreachable*: equipped items are `player_items` rows, `usedSlots`
(`items.js:307`) counts them, and `visibleItems` draws them in the same grid,
so unequipping is capacity-neutral and a full-backpack refusal could never
fire. Its test would have been green and vacuous — the dominant failure shape
in this repo. The reachable condition is an over-capacity backpack, which
`characters.inventory_slots` permits (its CHECK is only `> 0`).

Unequipping item A that another equipped item B depends on is prevented by the
same evaluation: the unequip is refused while B would become illegal, naming B.

## 8. Classes

### 8.1 The six

Warrior and Mage already exist and stay playable. Monk, Cultist, Archer and
Druid are four new `entity_types` rows. `Ranger` is **kept** and marked
not-playable rather than renamed into Archer, following the precedent set for
the legacy `Player` row — existing characters reference it, and a rename would
silently rebalance them. Each playable row gains `main_stat` and a `class_loadouts` set.

### 8.2 Druid — charm and summoning

**Creatures (full):** charm sets `world_creatures.charmed_by_character_id` and
`charm_expires_at`. The creature's faction flips, it follows the druid and
attacks the druid's target. Every creature ever charmed is recorded in
`character_summons`, and the druid may re-summon from that roster.

Budget rule, from the brief ("number depends on creature level and charm level
of the character"):

```
charmBudget = floor(effectiveCharisma / 2) + treeCharmBonus
sum(level of every active summon) <= charmBudget
```

So a level-40 druid can hold one level-20 creature or four level-5 ones.

**Players (pacify only):** a new `charmed` status effect, 4 seconds:
- the target cannot damage the druid or the druid's summons;
- the target receives a soft repel away from the druid;
- the target keeps their own movement input — no control transfer, no
  suppression of client input, and they can never become a summon;
- a non-refreshing immunity window follows, modelled directly on the shock
  interrupt in `effects.js` (which exists specifically because refresh
  semantics on a control-removing effect equal a permanent lock).

This is a deliberate reduction from the original brief. Full control transfer
of another player needs a PvP consent model, safe zones, a control-owner
concept in the wire protocol, and an escape action — roughly doubling this
slice for a mechanic that is a griefing vector by construction. Ticketed
separately if wanted later.

### 8.3 Cultist — life instead of mana

Every `item_types.mana_cost` is paid as HP at 0.6×:

```
hpCost = Math.ceil(manaCost * 0.6 * lifeCostMultiplier)   // tree keystones lower the multiplier
```

- A cast that would leave the cultist below 1 HP is **refused**, not lethal.
  The failure surfaces as "not enough life", the same shape as the existing
  "not enough mana".
- The cultist's mana bar is hidden client-side; CON scales both max HP and
  therefore their total castable resource.
- The check lives in the same place the mana check does today, so there is one
  cost gate, not two.

## 9. Loot lifetime

`ttlMs` currently defaults to `600000` in three call sites. It becomes a read
of `game_settings.ground_item_ttl_seconds` (default 180) resolved once per
world tick rather than per drop.

On expiry, `GroundItemSim.removeExpired` returns the removed items. Its
signature changes from `[id]` to `[{id, x, y}]`: it returned ids alone, and by
the time it returns the entry is gone from the map, so there is no position
left to site the puff at.

The server broadcasts a `vfx` event named `item_despawn` at each removed item's
position. The effect is a **client-side built-in** following `BLOCK_EFFECT_DEF`
(`core/vfx.js:45`), not a `vfx_effects` row — an admin-undeletable presentation
cue is already this repo's pattern, and it keeps the task migration-free. A `vfx_effects` row seeds a small puff — **no damage, no knockback,
no collision**; it is presentation only, and a test asserts that no damage
event is emitted alongside it.

## 10. UI

### 10.1 Deleted

The standalone level popup (`frontend/src/games/something2/CharacterSheet.jsx`
overlay, the `C` key toggle) is removed. Its data flow — the single-writer
websocket `progression` handler documented in that file's F1 header — is
**preserved and reused**, not rewritten; that comment describes a race that was
already fixed once and would come straight back if a second writer were
reintroduced.

### 10.2 Character tab in the inventory panel

A new tab in `frontend/src/games/something2/src/js/systems/inventoryPanel.js`
(which already has a `TABS` mechanism and a testable layout function separate
from the canvas draw). It shows:

- class, level, XP bar;
- the six stats, each itemised: `STR 42  =  5 base + 33 tree + 4 gear`;
- derived stats (max HP, max mana, melee ×, spell ×, cooldown ×, mana regen,
  sell price ×);
- **strong point** = highest effective stat, **weak point** = lowest (ties
  broken toward the class main stat);
- a combined, expanded list of every active modifier with its source —
  each equipment affix and each allocated passive that grants something,
  rendered from `composeStats().modifiers` rather than recomputed.

### 10.3 Passive tree overlay

New canvas overlay, `P` key, pan + zoom. 1800 nodes will not survive a naive
draw loop, so: a grid spatial index, viewport culling, and edges drawn only
between visible nodes. Allocated / allocatable / locked are three distinct
visual states; hovering a node shows its grants.

### 10.4 Character select

`CharacterSelect.jsx` grows from 3 to 6 classes, showing each class's main stat
and a one-line identity.

### 10.5 Admin

New route `/game/admin/progression`, alongside the existing admin pages:

- `game_settings` editor (points per level, ground TTL, rarity weights, respec
  cost);
- affix catalog CRUD;
- passive-node browser and single-node editor (search by key/sector/kind).

## 11. Testing

Backend `npm test` from `backend/`, frontend `npx vitest run` from `frontend/`,
plus browser verification for every UI surface — per AGENTS.md.

Two repo-specific hazards apply directly to this epic:

- **DB tests default to the shared dev database** when `TEST_DATABASE_URL` is
  unset. Every DB-touching task must set it to a per-branch scratch database
  and seed the map specs, or ~15 tests fail spuriously. No task may run a
  destructive statement against the shared dev DB.
- **Assertions derived from the same constants as the code are vacuous.** This
  epic is unusually exposed: an XP-curve test that calls `xpToNext` to build
  its own expectation proves nothing. Curve, affix-roll and stat-composition
  tests use literal expected values checked in by hand.

Specific coverage this epic must have:

1. Tree generator guards (§5.5) — the five listed checks.
2. `composeStats` — base + tree + gear, with a hand-written expected breakdown.
3. Requirement circularity — an item granting +20 STR does **not** satisfy its
   own 20-STR requirement.
4. Respec with a full backpack is refused and leaves equipment untouched.
5. Drop-and-repick round-trips rarity, item level, affixes and soulbound.
6. Rarity weights that do not sum to 1.0 still produce a valid distribution.
7. A cultist cast that would be lethal is refused and costs nothing.
8. Charm budget: summon totals cannot exceed the budget; a charmed player never
   becomes a summon and cannot be chain-locked.
9. Ground despawn emits a vfx event and **no** damage event.

## 12. Risks

| Risk | Mitigation |
|---|---|
| 1800-node tree is unbalanceable in one pass | Generated from ~40 templates; retuning is a template edit + reseed, not 1800 hand edits |
| Tree UI performance | Spatial index + viewport culling specified up front; measure in-browser, not with `getImageData` (which has previously given confident wrong answers on this host) |
| Rarity inflation trivialises existing content | Weights are admin-editable; creature levels already span 1–150 so the content range exists |
| Requirement checks fire in the combat hot path | Requirements are validated on equip only, never per attack |
| Migration ordering across parallel branches | Timestamps have collided before across concurrent branches. Reserve a contiguous block for this epic: `1714440400000`–`1714440430000`, one task per 1000 |
| Several sessions share one working directory | Every implementation task runs in its own git worktree and stages by path; no `checkout`/`stash`/`branch` in the shared checkout |

## 13. Task breakdown

Fifteen tasks in five groups. **A gates everything. B, C and D run in
parallel after A. E needs C7 and D12.**

**A — Foundations**
- **T1** `game_settings` table, admin API, `/game/admin/progression` page shell
- **T2** Level cap 150, new XP curve, remove stat points and the +buttons, migrate existing characters

**B — Classes**
- **T3** Six playable classes, `main_stat`, loadouts, CharacterSelect UI
- **T4** Cultist life-cost resource substitution
- **T5** Druid charm: creature control transfer + summon roster + budget; player pacify

**C — Passive tree**
- **T6** Schema, generator, seed command, the five guard tests
- **T7** Allocation/respec API and `statComposition.js`
- **T8** In-game tree overlay (canvas, pan/zoom, `P`)
- **T9** Admin node browser/editor

**D — Items**
- **T10** Equipment requirements, `canEquip` gating, respec/unequip policy
- **T11** Base gear ladder generator (~150 items, 8 slots × 10 tiers)
- **T12** Rarity + affix catalog + per-instance rolls + `world_items` carry
- **T13** Drop rarity weighting by item level
- **T14** Ground TTL 180s + despawn puff VFX

**E — Sheet**
- **T15** Character tab in the inventory panel; delete the standalone popup
