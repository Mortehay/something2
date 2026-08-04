# Progression, dungeons and loot — design

Date: 2026-08-03
Status: approved (sections 1–3), ready for planning of slices A1 and A2

## The request

Dungeons/catacombs reachable from an entrance somewhere on the map, sometimes
guarded by a strong creature or a pack of them, with several levels. Chests
that store loot, also guarded, where stronger guards mean better contents.
Loot maps dropped by creatures. Levels for creatures and some entities, where
a higher level means a stronger creature. Magic stones that hold a spell and
socket into weapons or armour, level up as the player gains experience, and
also exist as pure buffs — with the existing magic weapons modified to fit.

## Why this is five projects, not one

Two findings from exploring the codebase set the shape.

**There is no XP or levelling system at all.** `users` has `gold` and nothing
else resembling progression. A search for xp/experience/level across
`backend/src/` returns nothing. Two of the requested features — creature
levels, and stones that "level up when user gains experience" — are defined in
terms of a system that does not exist. Player progression is a prerequisite,
not a sibling.

**`map_links` structurally cannot express a dungeon entrance.** The table is
`CHECK (edge IN ('N','E','S','W'))` with `UNIQUE(from_world_id, edge)`: worlds
connect edge-to-edge, at most four neighbours each. The map-seed tooling
merged in `14876c4` depends on exactly that to embed every world in a 2D grid
and derive World Map coordinates from it. A dungeon entrance is a *point
inside* a world and its levels stack downward; neither fits an edge, and
dungeon levels must sit outside the grid rule. This needs a second link kind.

The rest of the request lands on serviceable seams: `player_items` already
carries per-instance UUIDs, so sockets have something to attach to;
`damage.js` is a single mitigation path; `loot.js` already exists.

### Decomposition and build order

| | Sub-project | Depends on |
|---|---|---|
| **A1** | Creature levels | — |
| **A2** | Player progression | A1 (per-kill XP scales with creature level) |
| **C** | Dungeons and catacombs | A1 |
| **B** | Chests, guards and loot maps | A1, C |
| **D** | Magic stones and sockets | A2 |

Build order chosen: **A → C → B → D**. Dungeons early means chests land
somewhere that shows them off.

Only A1 and A2 are specified here. C, B and D are recorded as stubs holding
the decisions already made, and each gets its own brainstorm → spec → plan
cycle when it comes up. Specifying D today would be fiction: its shape depends
on what A2's stat system looks like once built.

## Decisions taken

| Question | Decision |
|---|---|
| Creature level source | Per-world level band |
| What a player level grants | Stat points the player allocates |
| Death penalty | Lose a fraction of progress into the current level |
| Stats that do something | All six, each mapped to a mechanic |
| Respec | Allowed, costs gold |
| XP sources | Kills, chests, dungeon clears |
| Existing magic weapons | Converted: spells become pre-slotted stones (project D) |
| Progression storage | Its own `player_progression` table |

## A1 — Creature levels

Self-contained: no `users` change, no change to any existing player-facing
formula. It is what dungeon difficulty (C) and chest loot tiers (B) hang off.

### Data model

```
worlds.level_min       int not null default 1
worlds.level_max       int not null default 1   -- CHECK (level_max >= level_min)
world_creatures.level  int not null default 1
```

Map specs gain an optional per-world `level_band`, so a seeded map declares
difficulty directly and dungeon level N is just a higher band.

### Level assignment

A creature's level is rolled at spawn from its world's band, **using the same
deterministic hash `spawnChunkCreatures` already uses to choose the type**.
This is not a stylistic preference: `world_chunks` is cached, and a creature
whose level changed on chunk reload would be a live bug — the same creature
would harden or soften as a player walked away and back.

### Scaling

One pure function, `scaleCreature(baseStats, level)`, derives hp, damage and
defense from the `entity_types` base row. Server-side only — the repo already
carries a two-copy `resolveMove` between frontend and backend authority and
must not grow a second such pair.

Resistances stay flat. Scaling a 0.6 fire resistance by level reaches
effective immunity within a few levels.

Level is displayed on the creature nameplate.

## A2 — Player progression

### Data model

A new table rather than nine more columns on `users`. `users.gold` sets a
precedent for game state on the auth row, but XP + level + points + six stats
is a different order of magnitude, and the authority already joins per-user
rows on join for equipment.

```
player_progression (user_id PK -> users ON DELETE CASCADE)
  experience   bigint not null default 0
  level        int    not null default 1
  stat_points  int    not null default 0     -- unspent
  strength, dexterity, constitution,
  intelligence, wisdom, charisma
               int    not null default 5
```

### The six stats and the seam each touches

| Stat | Effect | Seam |
|---|---|---|
| STR | Melee damage | `w.damage` at `world.js:278`, `:285` |
| INT | Spell damage, max mana | same damage path, split by `element` |
| DEX | Attack speed | `p._attackCd = w.cooldown` at `world.js:290` **and** `:314` |
| CON | Max HP | replaces the `PLAYER_MAX_HP` constant at `world.js:17` |
| WIS | Mana regen | new tick, mirroring stamina's at `world.js:183` |
| CHA | Merchant prices | `sellPriceFor()` at `merchantStock.js:8` |

STR versus INT splits on the weapon's existing `element` column: `physical`
scales off STR, every other element off INT. No new field, and it gives the
element system weight it currently lacks.

**WIS fixes a real gap.** Mana is spent at `world.js:274` and restored only on
respawn at `world.js:339`. Stamina has a regen tick; mana has none. A caster
currently runs permanently dry until death. The WIS tick is the fix.

Two hazards, both to be pinned by the plan:

- DEX has **two** cooldown write sites. Changing one is precisely the class of
  bug this repo has shipped before; the plan routes both through one call.
- WIS's regen tick is new code, not a modified formula — it has no existing
  behaviour to regress against.

Everything funnels through one pure function:

```
derivePlayerStats(progression) ->
  { maxHp, maxMana, meleeMult, spellMult, cooldownMult, manaRegen, priceMult }
```

The authority calls it on join and after any level, respec or allocation.
Nothing else reads the raw stat columns.

### XP

```
awardXp(client, userId, amount, source) -> { leveledUp, newLevel, pointsGained }
source in { kill, chest, dungeon_clear }
```

`chest` and `dungeon_clear` are defined now and unused until B and C. This is
the seam those projects plug into.

Per-kill XP scales with the creature's A1 level **relative to** the player's,
so farming level-1 slimes decays toward nothing.

**The curve is deliberately untuned.** Three XP sources were chosen and only
one will exist when A2 ships. Tuning against kills alone guarantees retuning
later, so the constants live in one module, are documented as provisional, and
are not treated as a balance deliverable.

### Death

```
lost = roll(0.5%, 10%) * xpToNext(level)      # rolled fresh per death
experience = max(xpFloor(level), experience - lost)
```

A player can lose a level's worth of grinding, never a level.

The base is what the level **costs**, not the progress already made into it,
so dying early in a level is not cheaper than dying late — the clamp is what
stops it crossing the floor, and a player who has just levelled up loses
nothing. The roll is drawn by the caller and passed into the penalty maths,
never generated inside it, so the formula stays a pure function testable
against literal values.

### Respec

Costs `RESPEC_BASE * level` gold, refunds every point, resets the six stats to
base. The gold deduction and the reset happen in one transaction, or a failed
payment yields a free respec.

### Level-up must not heal to full

Raising max HP by Δ raises current HP by Δ. Healing to max would make
levelling mid-fight a free full heal, and the optimal play would become
hoarding a nearly-dead creature for emergencies.

### Failure modes the plan pins

- Allocation spends points atomically (`UPDATE ... WHERE stat_points >= $n`)
  or a double-click double-spends.
- XP awards are idempotent per kill, or an authority retry inflates them.
- Respec's gold movement and stat reset are one transaction.

### UI

An in-game character sheet: level, XP progress, the six stats with allocation
controls, unspent points, and a respec button showing its gold cost. Player-
facing and in-game, not an admin route.

## Testing

Backend is `node:test`. The frontend runs vitest in a plain **node**
environment with no DOM, so UI work gets pure-function and source-text tests
rather than rendering tests. That is a project constraint, not a gap to close
here.

The governing risk is this repo's documented failure mode: assertions derived
from the same constants as the code, which pass regardless of what the code
does. It shipped twice in the week before this design — most recently
`biomes_seed.test.js`, which checked biome creature references against a
hand-typed list containing the very name that was dangling, and stayed green
throughout.

So `derivePlayerStats`, `xpToNext` and the death-penalty maths are tested with
**literal expected values**, never recomputations of the formula. Acceptance
for each task includes a mutation check: neutralise the guard, confirm a test
goes red.

Three invariants get that treatment specifically:

1. Death never de-levels.
2. Allocation can never exceed `stat_points`.
3. Respec cannot complete without the gold moving.

## Risks

- **Balance is unfalsifiable until B and C ship.** Stated above; the
  consequence is that XP tuning is explicitly out of scope for A2.
- **Six stats is six curves.** STR and INT both scale damage through the same
  path, so a mistuned split makes one build strictly dominant.
- **DEX's two cooldown sites and WIS's new regen tick** are the two places in
  A2 most likely to ship green and behave wrong.
- **Migration ordering across parallel branches.** This repo has already had a
  timestamp collision (`1714440008000`) and a three-way ordering scramble
  across concurrent branches. Each sub-project reserves a timestamp range
  before work starts.
- **D rewrites items players own.** Converting magic weapons to pre-slotted
  stones migrates live `player_items` rows. It needs a reversible migration
  with a verified rollback, and it is the one place where a bad deploy costs a
  player their gear.

## Deferred sub-projects

Recorded so the decisions already made are not lost. Each needs its own
brainstorm before planning.

**C — Dungeons and catacombs.** Requires a second link kind: an interior
portal at a coordinate inside a world, rather than an edge crossing. Dungeon
levels sit outside the 2D grid rule that `mapSpec.js` enforces for overworld
maps. Entrances may be guarded by a strong creature or a pack. Difficulty per
level is expressed as an A1 level band.

**B — Chests, guards and loot maps.** Chests are persistent containers, unlike
`world_items`, which is ephemeral ground loot with an `expires_at`. Guard
level determines loot tier. Loot maps drop from creatures and point at a
chest.

**D — Magic stones and sockets.** Sockets attach to `player_items.id`, which
already exists per-instance. Existing magic weapons (`item_types.element` +
`mana_cost`) convert to a pre-slotted, removable stone. Stones level with
player XP. Buff-only stones exist alongside spell stones.
