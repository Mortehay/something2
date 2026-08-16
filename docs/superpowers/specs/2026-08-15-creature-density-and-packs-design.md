# Creature Density Field and Pack Masters — Design

**Status:** approved in brainstorm, not yet planned
**Supersedes tuning from:** SOMET-301 (world scale + creature density), SOMET-302 (tier rate doubling)
**Builds on:** SOMET-309 (creature respawn), SOMET-246 (one population path)

## Problem

A player crossing the world sees almost nothing, and what they do see is
undifferentiated. Two separate failures produce that:

**Density is far too low, and flat.** The canvas is a fixed 1280×720 with no
zoom, and a tile projects to a 128×64 isometric diamond (4096 px²), so one
screen shows **≈225 tiles**. Against that, the shipped ladder delivers:

| tier | per 1000 tiles | per screen |
|---|---|---|
| sparse | 3 | 0.7 |
| normal | 6 | 1.4 |
| dense | 12 | 2.7 |
| horde | 24 | 5.4 |
| swarm | 48 | 10.8 |

All four checked-in map specs use only `sparse`, `normal`, and `dense`. The
live game is therefore a **0.7–2.7 creatures-per-screen** game. Worse, the
number is uniform: `placeMapCreatures` rejection-samples the interior with a
flat distribution, so every screen of a world is statistically identical.
There is no reason to prefer one direction over another, and no such thing as
a dangerous place.

**A pack is a clump, not a group.** `placeCreaturePacks` anchors N creatures of
one type near each other, but each member calls `rollCreatureLevel`
independently against the world band. A pack of six comes out levels 3, 7, 4,
9, 5, 6 — a crowd with no leader, no cohesion, and nothing to fight *toward*.

## Goals

Creature population becomes a function of **where you are**, not just which
world you are in:

- Local density swings from empty stretches to genuine hordes within one world:
  roughly **2 to 30 creatures on screen** depending on position and world tier.
- Thick and thin are *legible*. A player can tell why it got busy — they left
  the road, or entered a swamp, or descended.
- Packs read as units: a cohesive horde with a visibly stronger master leading
  it.
- Solo wanderers remain the common case in quiet areas.

## Non-goals

- **Pack AI.** Members do not coordinate, follow the master, or flee when it
  dies. Existing per-creature behaviours (`creature_behaviors`) are unchanged.
  Cohesion here is a *placement* property only.
- **Restoring pack cohesion on respawn.** A slain pack respawns member by
  member at each member's own spot, on the existing 30s timer. Same-spot
  respawn is already farmable by design (SOMET-309, user's explicit choice).
- **Guard density.** Village, portal, and vault guards are structural, placed by
  their own owners, and untouched here.
- **New creature art.** The design deliberately uses only creature types that
  already exist in the catalog.
- **Client-side pack rendering.** No follow-the-leader formation, no shared
  health bar. `is_master` reaches the client, and what the client does with it
  is out of scope.

## Component 1 — The density field

`resolveDensity` keeps returning one number per world, but that number becomes
the world's **mean** rather than a uniform rate. A position-dependent weight
with mean ≈ 1.0 multiplies it, so world totals stay predictable while local
counts swing.

```
weight(row, col) = safety(row, col) × biome(row, col) × noise(row, col)
```

### Where it lives — and why that placement is load-bearing

The weight is applied **inside `placeMapCreatures`**, as an extra acceptance
gate in the existing rejection-sampling loop:

```
sample a tile
  -> creatureTileCandidates() rejects walls, doorways, safe zones, biome misfits
  -> NEW: accept with probability weight(row,col) / MAX_WEIGHT
  -> place
```

This placement is not an implementation detail. **Two** call sites place wild
creatures:

- `worldPopulation.populateWorld` — seeding and admin re-roll
- `creatureRespawn.enqueueDeficit` — the respawn backstop at world load

Both call `placeMapCreatures`. Putting the field inside it means the backstop
inherits it automatically. Putting it in either caller means refills are
uniform, and every world erodes back toward flatness over hours of play — a
silent regression no test of the seeding path would catch.

`placeCreaturePacks` uses the same weight for its **anchor** search only.
Members spread within `packRadius` unweighted: a pack that straddles a
density boundary should stay a pack.

### The three terms

**`safety` — 0 → 1.6, over a 20-tile ramp.** Distance from the nearest
village, road corridor, or authored safe rectangle. Inside a safe region the
weight is 0, which is already enforced separately by `creatureTileCandidates`
and stays enforced there; the ramp governs the approach.

`safeRegion.js` exposes `isSafeTile(ctx, gRow, gCol)` — a boolean, not a
distance. Rather than probing outward per sample (O(r²) inside a loop that runs
up to 40 times per creature), compute a **multi-source BFS distance field
once per generation config**, capped at the ramp length, cached in the existing
`SAFE_CTX` WeakMap beside the safe context. One pass over a 224² map is ~50k
cells and runs in single-digit milliseconds; the rejection loop then does an
array lookup.

```
dist 0      (inside safe region)  -> 0.0   (already excluded)
dist 1-5                          -> 0.4
dist 6-12                         -> 1.0
dist 13-20                        -> 1.4
dist > 20                         -> 1.6
```

**`biome` — 0.4 → 2.5.** A new `creature_density` column on `biomes` (real,
not null, default 1.0). Biomes already gate *which* creature types may spawn
via `creature_types`; this extends them to gate *how many*. Loaded by the
existing `loadBiomes` and read through `sampleBiomeRegion`, which
`creatureTileCandidates` already calls — so the sample is free, the region
lookup having happened anyway.

A world with no biomes uses 1.0.

**`noise` — 0.3 → 1.8.** `globalValueNoise(seed ^ CREATURE_DENSITY_SALT, gRow,
gCol, CREATURE_DENSITY_CELL)`, the same function that gives decorations their
forests. Mapped linearly from the noise's [0,1) onto [0.3, 1.8]. A cell size of
**12 tiles** puts a full quiet-to-thick cycle at roughly two screens, so the
variation is something a player walks through rather than something that
averages out under them.

Off the world seed, so the field is deterministic and reproducible, and salted
away from both the decoration field and the two placement streams.

### Normalization and clamp — why the raw product is not the weight

The three terms are **relative** weights, and their raw product does not have
mean 1.0. Taken literally it ranges over `0 → 1.6 × 2.5 × 1.8 = 7.2`, which
would put a `swarm` swamp far from any road at 144 creatures per screen and
make the tier's "mean" a number the world never actually averages.

Two steps fix that, both computed in the same single pass that builds the BFS
distance field:

1. **Normalize.** While walking the map, accumulate the raw product over every
   interior non-safe tile and divide each weight by that mean, so the field has
   mean 1.0 on any map whatever its biome mix and noise happen to be.
2. **Clamp to `[0.15, 1.5]`** after normalizing. The floor keeps quiet regions
   genuinely quiet without creating dead map; the ceiling is what makes the
   "field peak" column below true by construction.

**What normalization is and is not for.** `placeMapCreatures` loops
`for (i = 0; i < count; i++)` with up to `maxAttempts` retries per creature, so
it places `count` creatures whatever the field says. **The field is purely
redistributive**: it decides *where* a world's creatures go, not *how many*
it gets. A world's total stays exactly what the tier and `MAX_WORLD_CREATURES`
dictate — the thick regions are paid for by the thin ones.

Normalization therefore exists to keep the **acceptance rate** high, not to hit
a target count. An un-normalized field on a low-density map would reject the
vast majority of samples, exhaust `maxAttempts`, and under-deliver — which is
the actual failure mode to test for. Tests must assert the *distribution*
(thick regions hold proportionally more) and that the *total* is unchanged;
a test asserting that the field changes a world's headcount is asserting a
bug.

This also means the per-screen figures in the ladder below are properties of
the field's shape, not of the count: a `swarm` world holds its mean of 20 per
screen and its clamped peak of 30 in the same world, at the same time.

**The clamp is deliberately tight, and authored hotspots are the escape
hatch.** Organic terrain stays inside `[0.15, 1.5]`; a true set-piece — a
horde room, a nest — is authored via Component 3, which *replaces* the weight
rather than multiplying it. Set-pieces should be intentional, not an accident
of three multipliers peaking together.

A mean weight of 1.0 against `MAX_WEIGHT = 1.5` means the acceptance gate
passes ~67% of otherwise-valid samples, so placement needs roughly 1.5× the
attempts it does today. `maxAttempts = 40` absorbs that comfortably: even at
the 0.15 floor a single creature fails all 40 attempts about 1.4% of the time.
No change to `maxAttempts` is required.

### The re-scaled ladder

`DENSITY_TIERS.perThousand` becomes the world **mean**:

| tier | per 1000 | quiet (×0.15) | mean/screen | peak (×1.5) |
|---|---|---|---|---|
| dead | 0 | 0 | 0 | 0 |
| sparse | 9 | 0.3 | 2 | 3 |
| normal | 18 | 0.6 | 4 | 6 |
| dense | 36 | 1.2 | 8 | 12 |
| horde | 62 | 2.1 | 14 | 21 |
| swarm | 89 | 3 | 20 | **30** |

The quiet and peak columns follow from the clamp, so they are bounds rather
than estimates. The 2–30 span is delivered jointly: `sparse` averages 2, and a
`swarm` region at the field ceiling holds 30. Because every shipped spec sits at sparse/normal/dense,
this change alone moves the live game from 0.7–2.7 to 2–8 per screen with no
spec edits at all.

Tier *keys* are unchanged, so `worlds_density_check` (migration 1714440070000)
needs no migration and no spec churn.

### Budget

`MAX_WORLD_CREATURES = 4000` stays as the backstop. It now binds in a case it
did not before: `swarm` on the largest shipped world (224², 50,176 tiles)
resolves to ~4,470 and clamps.

**How the tick actually scales** — measured from `CreatureSim.tick`
(`authority/creatures.js:1122`), because the obvious reading of it is wrong.
The tick has two layers with different costs:

- **Chunk-scoped.** The main behaviour loop skips any creature whose chunk is
  outside `activeChunkKeys` (`if (!active.has(...)) continue;`). The expensive
  per-creature AI — pathing, aggro, attack resolution — is therefore paid only
  near players, not for the whole world.
- **Whole-set, every tick, regardless of activity.** Three passes are not
  scoped: `[...this.creatures.values()]` allocates an array of every creature,
  `computeAuras(all)` runs over all of them, and `for (const c of all) c._buff
  = ...` assigns to every one.

`computeAuras` is the one that matters, because it is **O(leaders × all)** —
each aura-carrying creature scans the entire population for creatures in
range.

**This is a direct constraint on Component 2, not a background worry.**
`Champion` is the *only* behaviour in the catalog with `aura_radius > 0`
(radius 260, +25% damage / +20% defense / +10% speed to its faction), and
`Champion` is exactly the role a pack master gets promoted into. Today leaders
are rare. With one master per pack and pack counts scaling by area, leaders
scale with area too — and `leaders × all` becomes quadratic in world size.

Concretely: 50 packs on a swarm 224² world is 50 leaders × ~4,500 creatures =
225,000 distance checks per tick, 13.5M/second at 60 Hz. At 200 leaders it is
54M/second, which will not hold.

Two consequences, both binding:

1. Slice A's measurement must cover the **whole-set passes at a realistic
   leader count**, not just the chunk-scoped loop, or it will measure the cheap
   half and report a false all-clear.
2. **Slice B may not scale pack counts by area without either capping the
   leader count or making `computeAuras` spatially indexed.** That is a
   decision for Slice B's plan, recorded here so it is not discovered during
   its final review.

Today a 224² swarm world ships 2,408 creatures with a handful of leaders and
runs.

**The cap moves only on a measurement, never on a guess.** The implementation
plan must include a tick-cost measurement at ~2,400 and ~4,500 creatures. If
4,500 is affordable, raise the cap to 5,000; if it is not, `swarm` stays a
tier for smaller maps and the clamp warning (already implemented) is the
signal. Either outcome is acceptable. Shipping an unmeasured raise is not.

## Component 2 — Pack cohesion and masters

### Cohesive horde level

`placeCreaturePacks` rolls the level **once per pack** rather than once per
member. Members get that level ±1 (clamped to the world band). The pack reads
as one threat of one strength.

### The master

The bestiary (`backend/seeds/data/bestiaryP4.js`) is already a **30 families ×
9 roles** matrix — `Woodland Swarm` through `Woodland Apex`, with hp rising 8 →
130 and each role carrying its own behaviour. The elite a pack needs therefore
already exists for every family, with stats and a behaviour, requiring **no new
catalog rows and no new sprites**.

Each pack promotes **one** member to master — the anchor, which
`placeCreaturePacks` already emits first and seats at the pack's centre. A pack
of size 7 is therefore one master and six members, not eight creatures; pack
sizes keep their current meaning and the budget arithmetic is unchanged.

- **Type:** same family, **two roles up** the ladder, capped at `Apex`.
- **Level:** the horde's level **+3**.

A pack whose own type is already `Apex` (rank 8) has nowhere to climb; its
master keeps the type and takes the +3 levels alone. That is the same shape as
the family-less fallback below, and both go through one code path.

```
pack of Woodland Line      (rank 2, hp 30)  ->  Woodland Brute     (rank 5, hp 48)
pack of Woodland Brute     (rank 5, hp 48)  ->  Woodland Champion  (rank 7, hp 85)
pack of Woodland Champion  (rank 7, hp 85)  ->  Woodland Apex      (rank 8, capped)
```

Relative rather than fixed-at-Champion, deliberately: a fixed elite tier would
drop a level-14 Champion into a level-2 starter area.

### Family and rank are columns, not a string parse

Deriving family and role by splitting `"Woodland Line"` on a space is a parser
one rename away from silently mis-promoting. Two new `entity_types` columns:

- `family` — text, nullable. `'Woodland'`.
- `role_rank` — integer, nullable. 0 (`Swarm`) … 8 (`Apex`).

Written by `backend/scripts/gen-p4-bestiary.js`, which already generates these
rows from a template and knows both values structurally.

### Fallback: no elite, no problem

Hand-authored types outside the bestiary — `Wolf` — have `family = NULL`. Those
packs fall back to a **promoted member**: same type, +3 levels, no rank change.

This is not politeness. Without it the feature ships inert: no pack gets a
master until someone backfills the catalog, the suite passes green throughout,
and the failure is invisible. The fallback means masters appear on day one
everywhere, and the catalog columns improve them rather than enable them.

### Two invariant changes, stated deliberately

**The allowlist governs families, not ranks.** `worlds.allowed_creature_types`
is currently authoritative in a strong sense — `creatureTileCandidates`
documents that a biome may only *remove* candidates, never add one. A master
two ranks up is a type the world's spec almost certainly does not list.

The rule is redefined: **the allowlist and the biome jointly admit a family;
the pack rule selects rank within an already-admitted family.** The rejected
alternative — requiring masters to be listed — means no world has a master
until all four specs are hand-edited, which is the same inert-feature failure
as above.

The master still passes `creatureTileCandidates` for its own tile, so safe
regions, walls, and biome type-gating apply to it unchanged.

**Masters exceed the world level band.** `worlds.level_max` stops being a hard
ceiling; a master may sit up to +3 above it. That is the point of an elite,
and it is a real change to what that column promises. Any code or test
asserting "no creature in this world exceeds level_max" must be found and
updated rather than discovered later.

### Pack counts scale with area

`packCount` is a flat 0–6 per world regardless of size, so six packs on a 224²
map are statistically invisible. It becomes a per-1000-tiles rate like scatter,
with the same `MAX_WORLD_CREATURES` ceiling absorbing the pack budget.

### New `world_creatures` columns

- `pack_id` — uuid, nullable. Null for scattered creatures; shared by all
  members of one pack including its master.
- `is_master` — boolean, not null, default false.

`is_master` reaches the client through the existing creature payload. What the
client draws is out of scope for this design.

### The `enqueueDeficit` fix these columns enable

`creatureRespawn.enqueueDeficit` compares:

```
target = resolveDensity(...).scatterCount      -- scatter ONLY
live   = count(world_creatures WHERE home_x IS NULL ...)   -- scatter AND packs
```

`populateWorld` inserts both with `home_x` null, so `live` over-counts against
`target` by the whole pack budget. SOMET-309 documented this as a deliberate
dead zone of up to ~72 creatures, accepted because packs had no persistent
representation to count.

Area-scaled pack counts turn that dead zone from ~72 into hundreds, at which
point the backstop stops firing on exactly the worlds that most need it.

`pack_id` is that missing representation. The count becomes:

```sql
SELECT count(*) FROM world_creatures
 WHERE world_id = $1 AND home_x IS NULL AND blocks_portal_id IS NULL
   AND pack_id IS NULL
```

now comparable like-for-like with `target`, closing the known limitation as a
side effect rather than deepening it.

## Component 3 — Authored hotspots (optional, last)

Map specs may name explicit high-density rectangles:

```json
"hotspots": [
  { "rect": [40, 40, 12, 12], "density": "swarm", "type": "Bonelord Heavy" }
]
```

A hotspot **replaces** the computed weight inside its rectangle rather than
multiplying it, so an author gets exactly what they asked for. Gated in
`validateMapSpec` — which `map_spec_fixtures` runs over the real specs — so a
hotspot outside the map bounds, or naming an unknown density or an unknown
creature type, fails at seed time rather than producing a quietly empty room.

**This component is genuinely optional.** Components 1 and 2 may already
deliver the dungeon-horde feel, and shipping them first is how we find out.

## Data model summary

| table | column | type | note |
|---|---|---|---|
| `biomes` | `creature_density` | real not null default 1.0 | field multiplier |
| `entity_types` | `family` | text null | `'Woodland'` |
| `entity_types` | `role_rank` | integer null | 0–8 |
| `world_creatures` | `pack_id` | uuid null | groups a pack |
| `world_creatures` | `is_master` | boolean not null default false | the elite |

No `worlds` columns change, so `loadWorld`'s explicit SELECT is unaffected —
but see trap 3 below, which applies the moment that stops being true.

## Slices

Each slice ships working, testable software on its own.

- **Slice A — density field.** Weighted acceptance in `placeMapCreatures`,
  BFS distance field, `biomes.creature_density`, re-scaled `DENSITY_TIERS`,
  tick-cost measurement. Delivers 2–8 per screen to every existing world with
  no spec edits.
- **Slice B — packs and masters.** `entity_types.family`/`role_rank`,
  `world_creatures.pack_id`/`is_master`, cohesive levels, master promotion with
  fallback, area-scaled pack counts, `enqueueDeficit` target fix.
- **Slice C — authored hotspots.** Spec schema, `validateMapSpec` gate,
  weight override. Optional; decide after A and B are live.

## Rollout

Every world is re-rolled **once**, after merge, as an explicit and confirmed
step — not by an implementer mid-task, and not by any subagent.

`populateWorld` is built for this: its delete is scoped by
`type <> 'Village Guard' AND blocks_portal_id IS NULL AND home_x IS NULL`, so
village guards, portal guards, and vault guards all survive, as do chests,
stones, and every other non-creature entity. It is the same operation the
per-world admin re-roll button already performs.

The pass must print a dry-run count of affected worlds and creatures before
writing anything.

## Testing

### What must be true

- The field is deterministic: the same seed and config produce the same
  placement, every time.
- Both placement paths — `populateWorld` and `enqueueDeficit` — produce
  field-weighted output. A parity test asserts this directly.
- Weighted acceptance does not break the safe-region guarantee: no creature is
  ever placed on a safe tile, at any weight.
- A pack's members share one level ±1; its master is +3 and two ranks up.
- A pack of a family-less type still gets a master, by promotion.
- Under-delivery is still reported. Weighted acceptance rejects more samples
  than uniform, so `maxAttempts` exhaustion becomes more likely and the
  existing `scatter under-delivered` warning matters more, not less.

### Traps specific to this repo

1. **Extra RNG draws shift every seeded layout.** The acceptance gate consumes
   draws, so newly seeded or re-rolled worlds lay out differently than before.
   Persisted worlds are unaffected until re-rolled — but `map_spec_fixtures`
   and any test asserting a creature *position* will move. Find those before
   implementing, not during review.

2. **The two-loader trap.** `populateWorld` and `enqueueDeficit` both place
   creatures. This repo has shipped this exact failure before (SOMET-249's two
   loaders, SOMET-246's unreachable second placement path). The parity test
   belongs in the plan, not in the hope that review catches it.

3. **Silent column defaults.** Anything read from `worlds` must be named in
   `loadWorld`'s explicit SELECT (`authority/server.js`) or it arrives
   `undefined` on the live authority and nowhere else — green suite, dead
   feature (SOMET-288, and again in SOMET-309). This design adds no `worlds`
   columns, so the trap is dormant; it wakes the moment a task adds one. The
   guard that works is a **source-text test** asserting the SELECT names the
   column, not a DB test, which builds its row with `SELECT *` and cannot see
   the difference.

4. **Expected values must be hand-typed literals.** A tier-table test that
   recomputes its expectation from `DENSITY_TIERS` passes at any value and
   asserts nothing. Type the numbers.

5. **Never mutate the shared dev database.** No `DELETE`, no re-roll, no
   `migrate:up`, no `pgmigrations` edit from any implementer or reviewer. The
   rollout re-roll is a separate, confirmed, post-merge step.

6. **Migration timestamps collide.** Several sessions share this repo. Pick
   migration timestamps at merge time and check `main` first
   (see `migration-ledger-repair`).

## Open question deferred to the plan

Whether `MAX_WORLD_CREATURES` rises above 4,000 depends on the tick-cost
measurement described under Budget. Both outcomes are acceptable; the
measurement is not optional.
