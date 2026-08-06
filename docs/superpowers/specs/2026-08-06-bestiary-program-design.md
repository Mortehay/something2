# Bestiary Program — Umbrella Design

**Status:** program umbrella. Each sub-project below gets its own spec, plan and
implementation cycle. This document holds the shared structure they all draw
from, and nothing else.

**Origin:** play-testing found most maps empty of creatures, and the few
populated ones drawing on a three-creature bestiary. Investigation turned up a
structural defect underneath the content complaint.

---

## The defect this program starts from

Seeded worlds arrive with **zero creatures on the ground**.

`applyMapSpec` (`backend/scripts/seed-map.js`) writes `creature_count` and
`allowed_creature_types` onto the world row but never calls
`placeMapCreatures`. The only production caller is the admin re-roll route,
`POST /api/worlds/:id/creatures` (`backend/src/index.js:1707`).

The per-chunk spawn path in `backend/src/authority/server.js:553` cannot cover
for it. That branch is gated on `!isBoundedWorld(entry.row)`, and
`isBoundedWorld` is just `width && height` — every world in the database is
bounded, so the branch never runs. **Creature placement has two
implementations and only one is reachable**, and the reachable one fires only
when a human clicks a button in the admin UI, one world at a time.

Measured on the live dev database: 11 of 20 worlds hold no creatures at all,
including every dungeon world. The 9 populated worlds each hold exactly their
configured `creature_count`, confirming they came from manual re-rolls rather
than any automatic path.

A second, quieter defect compounds it. `placeMapCreatures` intersects a
world's `allowed_creature_types` with the **biome's** own `creature_types`
list (`backend/src/services/mapService.js:581`), and an empty intersection
places nothing. Dungeon worlds currently declare `"biomes": ["Meadow"]` and
`["Meadow", "Mire"]` — there is no cave, crypt or catacomb biome anywhere in
the catalog. The catacombs are meadows underground, and no creature the
meadow does not already contain can ever spawn in one.

## Current catalog

Five `is_creature` entity types exist: Bat, Skeleton, Slime, Wolf, and Village
Guard (`faction = 'guard'`, structural, not a wild spawn). Wolf is placed in
no world at all. Across all 20 worlds the entire live bestiary is Skeleton
×25, Bat ×12, Slime ×4.

Five biomes exist, all surface: Meadow, Deep Forest, Arid Dunes, Frozen Waste,
Mire.

---

## Shared structure

Every sub-project below draws on the same three definitions. They are fixed
here so five specs cannot drift apart.

### Lines and rungs

A **line** is a thematic creature family with an elemental identity and a
depth tier. Every line fields the same nine **rungs**, so a pack assembled at
any depth has a coherent shape.

| rung | hp | def | mechanic |
|---|---|---|---|
| Swarm | 8 | 0 | packs of 8–12, melee, no ability |
| Skirmisher | 16 | 1 | fast, hit-and-run aggro |
| Line | 30 | 3 | core melee body |
| Ranged | 22 | 1 | projectile attack |
| Caster | 26 | 1 | elemental ranged ability |
| Brute | 48 | 5 | slow heavy melee, knockback |
| Heavy | 60 | 8 | armoured, punishes one damage type |
| Champion | 85 | 9 | pack leader, buffs its pack |
| Apex | 130 | 13 | boss, multiple abilities |

The hp and def figures are the rung's value at its band midpoint, before A1
level scaling (`scaleCreature`) applies.

**32 lines × 9 rungs = 288 creatures.**

### Resistances

Resistances express a line's identity, shifted by rung. The game has exactly
four elements: `physical`, `fire`, `ice`, `lightning`.

- Swarm and Skirmisher rungs carry no resistance or one weak one. They die to
  anything, which is what makes them safe to field in large numbers.
- Line, Ranged and Caster rungs carry the line's primary element at .4–.7.
- Brute, Heavy, Champion and Apex rungs carry the primary element strongly
  plus partial `physical`.

**The gap is the design.** A creature with no resistance in an element is
exactly where it is vulnerable, and that is what turns four elements from
flavour into a loadout decision. A Construct-line Heavy shrugging off swords
and fire but folding to lightning is the intended shape.

### Depth tiers and bands

| tier | band range |
|---|---|
| I — surface / shallow | 1–12 |
| II — mid depths | 8–24 |
| III — deep | 20–36 |
| IV — abyssal | 32–50 |

Player `MAX_LEVEL` is 50 (`backend/src/services/progressionConstants.js:17`),
so tier IV sits inside the ceiling with headroom.

### The 32 lines

**Surface — 10 lines.** Five reuse existing biomes; five biomes are new.

| line | biome | primary element | tier |
|---|---|---|---|
| Beast | Meadow | — | I |
| Woodland | Deep Forest | — | I |
| Desert | Arid Dunes | fire | I |
| Tundra | Frozen Waste | ice | I–II |
| Swamp | Mire | physical | I–II |
| Highland | Highlands *(new)* | physical | II |
| Jungle | Verdant Jungle *(new)* | lightning | II |
| Storm | Storm Coast *(new)* | lightning | II–III |
| Ruin | Sunken Ruins *(new)* | ice | II–III |
| Volcanic | Ashfields *(new)* | fire | II–III |

**Underground — 14 lines, 14 new biomes.**

| line | biome | primary element | tier |
|---|---|---|---|
| Undead | Catacombs | ice | I–II |
| Bonelord | Ossuary | ice | II–III |
| Cave | Cavern | physical | I–II |
| Fungal | Fungal Deep | lightning | II |
| Ember | Emberdepths | fire | II–III |
| Rime | Frostvault | ice | II–III |
| Construct | Deepvault | physical | III |
| Hive | Hive Warrens | physical | II–III |
| Drowned | Sunken Cistern | ice | II–III |
| Umbral | Umbral Warren | physical | III–IV |
| Crystal | Crystal Hollows | lightning | III |
| Blight | Blightworks | physical | II–III |
| Gloom | Gloomfen | ice | II |
| Stoneborn | Sunken Foundry | fire | III |

**Abyssal — 8 lines, 8 new biomes.**

| line | biome | primary element | tier |
|---|---|---|---|
| Void | Abyssal Rift | all four, partial | IV |
| Demonic | Infernal Gate | fire | III–IV |
| Chaos | Shattered Vault | lightning | IV |
| Fallen | Fallen Sanctum | ice | IV |
| Nightmare | Dreaming Dark | physical | IV |
| Titan | Titan's Grave | physical | IV |
| Plague | Pestilent Deep | fire | III–IV |
| Eldritch | The Maw | all four, partial | IV |

**32 biomes total, 27 of them new. Roughly 30 new tile types**, one to two
signature tiles per new biome, with existing tiles (`rocks`, `dirt`, `earth`,
`swamp`, `ice`, `snow`) reused wherever they fit.

---

## Sub-projects

Five, each with its own spec, plan and implementation cycle.

| # | sub-project | nature | depends on |
|---|---|---|---|
| **P1** | World population — `populateWorld`, density tiers, packs, retire the dead spawn path | engineering | — |
| **P2** | Creature mechanics — ranged, casters, aggro profiles, pack-leader buffs, per-rung loot | engineering | P1 |
| **P3** | Tiles & biomes — ~30 tiles, 32 biomes | content | — |
| **P4** | Bestiary — 288 creatures with stats, abilities, prompts, drop rules | content | P2, P3 |
| **P5** | Map content — ~58 worlds, multi-level dungeons, branching | content | P1, P4 |

### Build order

**P1 first and alone.** Nothing in this program is observable until it exists:
today no seeded world ever receives a creature, so every content sub-project
would land invisible. P1 also has no content dependencies, which makes it the
only piece that can start immediately.

**P3 may run parallel to P2** — they share no files. P4 needs both. P5 is last
because it consumes everything.

### Migration ranges

This repo has already had a migration timestamp collision (`1714440008000`)
and a three-way ordering scramble across concurrent branches. Each
sub-project reserves a range before work starts:

| sub-project | reserved range |
|---|---|
| P1 | `1714440070000`–`1714440079000` |
| P2 | `1714440080000`–`1714440089000` |
| P3 | `1714440090000`–`1714440099000` |
| P4 | `1714440100000`–`1714440109000` |
| P5 | `1714440110000`–`1714440119000` |

Highest migration currently on `main` is `1714440061000`.

---

## Risks

**The art queue is the real bill.** 288 creatures plus ~30 tiles is roughly
318 local sprite generations, around six hours of machine time on the CPU
sd-turbo path. Coding agents cannot generate images; this lands entirely on
the user. Until each is generated, that creature or tile renders as a flat
colour box. No sub-project blocks on it, but the program does not *look*
finished until it is done.

**P4 is 288 hand-reviewed rows.** The plan can generate them from the line ×
rung template, but a human still reviews 288 stat rows for coherence. This is
the sub-project most likely to want splitting further at plan time — most
plausibly by realm, into surface / underground / abyssal.

**P2 is the engineering risk.** Ranged creature attacks, aggro behaviour
profiles and pack-leader buffs touch the authority tick loop, the projectile
system and the creature sim — the same live-combat surfaces where the
dungeons sub-project (SOMET-243) needed three rounds of review to shake out a
chunk-activation race and a mirrored-portal bounce. Budget review capacity
accordingly.

**Balance is unvalidated by construction.** The XP curve in
`progressionConstants.js` is explicitly provisional — it was tuned against
kills alone, with chests and dungeon clears not yet implemented. Adding 288
creatures across bands 1–50 will move the curve. Retuning is expected and is
not in any sub-project's scope; it wants its own pass once the content lands.
