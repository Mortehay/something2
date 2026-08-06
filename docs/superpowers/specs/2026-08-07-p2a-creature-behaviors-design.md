# P2a — Creature Attack Kinds and Aggro Profiles

**Plane:** SOMET-249. Sub-project of the Bestiary Program (SOMET-248), whose
umbrella is `docs/superpowers/specs/2026-08-06-bestiary-program-design.md`.

**Status:** design approved 2026-08-07, ready for a plan.

**Migration range:** `1714440080000`–`1714440089000`, shared with P2b.

---

## Why this is P2a and not P2

The umbrella scoped one P2 covering ranged attacks, casters, aggro profiles,
pack-leader buffs, apex abilities and per-rung loot. It also named P2 the
engineering risk of the whole program, because it touches the authority tick
loop, the projectile system and the creature sim — the surfaces where SOMET-243
needed three review rounds.

P2 is therefore split:

- **P2a (this spec)** — attack kinds and aggro profiles.
- **P2b (SOMET-253)** — pack-leader buffs, apex abilities, Brute knockback,
  per-rung loot.

**The split does not license starting P4 early.** Authoring 288 creature rows
against half a schema reintroduces exactly the second pass the split exists to
avoid. The order is **P2a → P2b → P4**.

---

## What exists today

Six facts, each verified against `main` at `1b05a18`.

**Every creature has exactly one attack.** Walk to within `CONTACT_RANGE` (60
px), deal `c.damage` as `physical`, serve a 1.0 s cooldown
(`backend/src/authority/creatures.js:281`). Guards are the same code with
different constants. There is no ranged attack, no element, no ability.

**`loadCreatureTypes` selects nine columns** (`creatures.js:46`). Its own
comment records why it is a named export rather than inline SQL: a column the
mapping consumes but the SELECT omits loads as `undefined` and *silently
disables the feature it feeds*. A guard test pins this. Every column P2a adds
must extend both.

**`ProjectileSim` assumes projectiles are player-owned.** `ownerId` is a
userId; collision skips `pl.userId === p.ownerId` (`projectiles.js:165`); kills
are reported as `{ id, killerUserId }`. A creature-fired projectile has no
valid owner in that model.

**Aggro is two module constants** — `AGGRO_RADIUS` 400, `LEASH_RADIUS` 800 —
plus "walk straight at the target". Nothing is per-type.

**Packs are not persisted as packs.** P1's `placeCreaturePacks` clusters
positions at insert time; `world_creatures` has no pack column. This is why
pack-leader buffs are P2b, not P2a.

**The client is render-only.** `frontend/.../entities/CreatureManager.js` is 80
lines that reconcile a rendered set to the server's snapshot. The "port of the
client roam logic" comment in `creatures.js` is historical. There is no
dual-implementation parity burden here, unlike the movement/collision pair.

---

## Data model

### `creature_behaviors` — a new name-keyed catalog

Follows the `tile_types` / `biomes` pattern: a catalog table, a checked-in seed
file owned by `make seed-catalogs`, and an admin route.

| column | type | notes |
|---|---|---|
| `id` | serial PK | |
| `name` | text UNIQUE NOT NULL | the twelve seeded rows below |
| `attack_kind` | text NOT NULL | CHECK `melee` \| `ranged` \| `cast` |
| `attack_range` | real NOT NULL | contact range for `melee`, flight range otherwise |
| `attack_cooldown` | real NOT NULL | seconds |
| `projectile_speed` | real NOT NULL DEFAULT 0 | 0 for `melee` |
| `projectile_radius` | real NOT NULL DEFAULT 0 | 0 for `melee` |
| `aggro_radius` | real NOT NULL | replaces `AGGRO_RADIUS` |
| `leash_radius` | real NOT NULL | replaces `LEASH_RADIUS` |
| `chase_style` | text NOT NULL | CHECK `charge` \| `kite` \| `skirmish` \| `hold` \| `ambush` \| `guard` |
| `preferred_range` | real NOT NULL DEFAULT 0 | the distance `kite` and `skirmish` hold |
| `move_speed_mult` | real NOT NULL DEFAULT 1 | multiplies `CREATURE_SPEED` (40) |
| `damage_override` | real NULL | NULL means use the creature's own instance damage |
| `created_at`, `updated_at` | timestamptz | |

`damage_override` exists for exactly one reason: guards currently ignore
`c.damage` and hit for the hardcoded `GUARD_DAMAGE` (25). Without this column
the Guard profile could not reproduce today's behaviour, and behaviour
preservation is this sub-project's load-bearing invariant.

`GUARD_HOME_EPSILON` (24 px — "close enough to the post to stand still") stays
a code constant. It is a numerical-stability threshold, not a tuning knob.

### `entity_types` gains two columns

- `behavior_id integer NULL REFERENCES creature_behaviors(id)` — an integer FK,
  deliberately not a name reference. `biomes.creature_types` references
  `entity_types` by name with no FK, which is why `index.js` has to guard
  renames; a profile rename must not be able to orphan 288 creatures.
  `ON DELETE` is left at the default (RESTRICT) so a profile still in use
  cannot be deleted out from under its creatures.
- `attack_element text NOT NULL DEFAULT 'physical'` — CHECK `physical` \|
  `fire` \| `ice` \| `lightning`. Read only when `attack_kind = 'cast'`.

### Three attack kinds

| kind | delivery | element |
|---|---|---|
| `melee` | contact damage within `attack_range` | always `physical` |
| `ranged` | projectile | always `physical`, no status rider |
| `cast` | projectile | the creature's `attack_element`, **and applies that element's status rider** |

`cast` is what makes the four-element system bite in PvE. `effects.js` already
implements burn, chill and shock, and `applyElementEffect` is already called
from every player damage path — creatures simply never inflict them today.

A `melee` creature never uses its `attack_element`. Elemental identity for
melee rungs lives in `resistances` (what they shrug off), which is the
umbrella's stated design: "the gap is the design".

### Six chase styles, four of them new logic

| style | behaviour |
|---|---|
| `charge` | walk straight at the target, attack within `attack_range`. **Today's hostile behaviour, unchanged.** |
| `kite` | hold `preferred_range`: close if further than `attack_range`, back away if nearer than `preferred_range`, otherwise stand and attack |
| `skirmish` | close to `attack_range`, attack, then retreat to `preferred_range` before closing again |
| `hold` | never moves at all. Attacks any valid target within `attack_range` with line of sight |
| `ambush` | does not roam. Stands still until a target enters `aggro_radius`, then behaves as `charge` |
| `guard` | chase within `leash_radius` of `home`, return home when no target, stand still at the post. **Today's guard branch, unchanged.** |

**Two of the six are existing branches given names**, not new behaviour:
`charge` is today's hostile path and `guard` is today's guard path, both moved
into data so their constants become tunable. The four genuinely new styles are
`kite`, `skirmish`, `hold` and `ambush`.

`hold` differs from `guard`: `hold` never moves at all and needs no home
anchor, which is why it needs no new column and no change to
`worldPopulation.js`.

`ambush` likewise needs no new column: "does not roam" is the absence of the
roam branch, and the speed burst is `move_speed_mult`.

### The twelve seeded profiles

Nine rungs from the umbrella, plus `Guard`, plus two that give `hold` and
`ambush` real consumers rather than leaving them dead code.

| name | kind | range | cooldown | proj speed | proj radius | aggro | leash | style | preferred | speed × | dmg override |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Swarm | melee | 60 | 0.7 | 0 | 0 | 400 | 800 | charge | 0 | 1.2 | — |
| Skirmisher | melee | 60 | 0.9 | 0 | 0 | 450 | 800 | skirmish | 150 | 1.5 | — |
| **Line** | melee | **60** | **1.0** | 0 | 0 | **400** | **800** | **charge** | 0 | **1.0** | — |
| Ranged | ranged | 340 | 1.8 | 520 | 6 | 460 | 800 | kite | 240 | 1.0 | — |
| Caster | cast | 300 | 2.4 | 420 | 8 | 460 | 800 | kite | 220 | 0.9 | — |
| Brute | melee | 70 | 1.8 | 0 | 0 | 380 | 800 | charge | 0 | 0.7 | — |
| Heavy | melee | 65 | 1.5 | 0 | 0 | 300 | 500 | charge | 0 | 0.6 | — |
| Champion | melee | 65 | 1.1 | 0 | 0 | 480 | 900 | charge | 0 | 1.05 | — |
| Apex | cast | 260 | 2.0 | 460 | 10 | 600 | 1200 | charge | 0 | 0.95 | — |
| **Guard** | melee | **60** | **1.0** | 0 | 0 | **400** | **300** | **guard** | 0 | **1.0** | **25** |
| Sentry | ranged | 380 | 2.0 | 500 | 6 | 400 | 800 | hold | 0 | 1.0 | — |
| Lurker | melee | 60 | 0.9 | 0 | 0 | 180 | 700 | ambush | 0 | 1.6 | — |

**Heavy "holds ground" through numbers, not through the `hold` style** — a
small aggro radius (300), a short leash (500) and a slow walk. A melee creature
using `hold` could never reach anything.

**Apex is `cast` + `charge`** — a boss that closes on you *and* throws
elemental bolts on the way in, because `attack_range` (260) is larger than the
distance at which it stops approaching.

---

## Behaviour preservation is the load-bearing invariant

The bold rows above are not arbitrary. `Line` reproduces today's hostile
constants exactly (`CONTACT_RANGE` 60, `CREATURE_ATTACK_COOLDOWN` 1.0,
`AGGRO_RADIUS` 400, `LEASH_RADIUS` 800, `CREATURE_SPEED` × 1). `Guard`
reproduces `GUARD_AGGRO_RADIUS` 400, `GUARD_LEASH_RADIUS` 300, `GUARD_DAMAGE`
25.

The existing five creature types are assigned accordingly: Bat, Skeleton, Slime
and Wolf get `Line`; Village Guard gets `Guard`. A creature type with
`behavior_id IS NULL` falls back to the `Line` values in code, so a
hand-authored creature and a database mid-migration both still work.

**Therefore P2a ships with zero observable behaviour change, and that is
assertable rather than argued.** See Testing below for the form the assertion
takes — a claim this strong is worth a test that could actually fail.

Every new style arrives unused by real content until P4 assigns rungs, except
`guard`, which has live consumers on day one (village guards and the portal
guards that gate dungeon entrances).

---

## Sim changes

### `creatures.js`

`loadCreatureTypes` joins `creature_behaviors` and returns a `behavior` object
per type. Its SELECT-completeness guard test extends to every new column — that
test exists precisely because an omitted column silently disables its feature,
which is the single most likely way this sub-project ships inert.

`CreatureSim.addCreatures` attaches the resolved behaviour to each creature
instance, the same way `mit`, `level` and `damage` are attached today.

`CreatureSim.tick` dispatches on `chase_style` and returns **`{ killed, shots }`**
instead of a bare array. Callers update accordingly.

A creature fires only when it has line of sight to its target
(`hasLineOfSight`, the same helper the melee arc and projectiles already use).
Without this, ranged creatures spend their cooldowns shooting walls and read as
broken.

### `world.js`

`World` already owns both sims (`world.js:117` and `:120`), so `tickCreatures`
(`world.js:266`) spawns the returned shots into `this.projectiles`. This keeps
`CreatureSim` free of any dependency on `ProjectileSim` — the shots are data,
not a callback.

`MAX_CREATURE_PROJECTILES` caps concurrent creature-owned projectiles per
world. A `swarm`-density world can hold 12-creature packs; twelve Ranged
creatures on a 1.8 s cooldown sustain roughly seven shots per second, and
`ProjectileSim.step` is O(projectiles × creatures) per sub-step. Shots beyond
the cap are dropped, not queued.

### `projectiles.js`

`spawn` takes `ownerKind: 'player' | 'creature'`, defaulting to `'player'` so
every existing call site is unchanged.

Collision resolves by the targeting rules the sim already enforces elsewhere —
guards never target players, hostiles never target guards:

| shooter | damages |
|---|---|
| player | creatures, other players |
| hostile creature | players, guard-faction creatures |
| guard creature | hostile creatures only |

A projectile never damages its own shooter, which is the existing owner rule
generalised rather than a second rule.

Kills from creature-owned projectiles carry `killerUserId: null`.
`commitCreatureDeath` already handles that case — it is the path guard kills
take today — and skips the XP branch entirely rather than awarding zero.

---

## Surfaces

**API.** `GET/POST/PUT/DELETE /api/creature-behaviors`, following the tile-type
and biome routes. DELETE carries a reference guard (409 when any
`entity_types` row still points at the profile). SOMET-238 records that
`DELETE /api/tile-types/:id` and `/api/entity-types/:id` still lack such
guards; that gap is not being fixed here, but it will not be repeated in new
code.

**Admin.** A `Creature Behaviors` sidebar route beside Tile Types and Biomes.
`EntityTypesAdmin` gains a behaviour dropdown and an attack-element dropdown.

**Seeding.** `backend/seeds/data/creatureBehaviors.js` holding the twelve rows,
plus a `seedOneBehavior` in `seed-catalogs.js` exported so tests exercise the
real SQL — the pattern P3 established. Upserts use `COALESCE($n, table.col)`
for omitted fields, because `make seed-catalogs` must never cost an admin
something they tuned by hand.

---

## Testing

**The behaviour-preservation test is the one that matters.** It must be capable
of failing. Expected values are written as **literal numbers in the test file**
(60, 1.0, 400, 800, 300, 25) — never imported from the same constants or seed
data the implementation reads, which would make the assertion vacuous. Prior
sub-projects in this repo shipped fifteen tests with that shape; the audit
record is in the project's vacuous-test notes.

The strongest form, and the one to prefer: run a frozen copy of today's
hardcoded tick against the new profile-driven tick over N ticks with the same
seed and the same map, and assert identical positions, facings and hp. That
compares two implementations rather than a number against itself.

**Per-style tests assert direction, not motion.** "The creature moved" passes
for a kiting creature that charges. A `kite` test asserts the creature moved
*away* from a target closer than `preferred_range`, and *toward* one beyond
`attack_range`.

**Projectile targeting is a 3 × 3 matrix** — three shooter kinds against
players, hostiles and guards — asserted exhaustively. Half of these cells are
"no damage", and a test that only checks the damaging cells would pass against
an implementation with no faction logic at all.

**Loader guard test** extends to every new column.

**Browser verification.** Four of the six styles have no live consumer until P4
assigns rungs, so verification requires temporarily assigning a profile to one
existing creature type through the admin UI, observing it in the running game,
and reverting. This is a normal use of the admin surface, not a database
experiment — but it is a write to the shared dev database and must be reverted.
No destructive SQL, ever: a reviewer once ran `DELETE FROM entity_types` to
test a seeder and wiped the catalog.

---

## Out of scope

**Deferred to P2b (SOMET-253):** pack-leader buffs, Apex multi-abilities, Brute
knockback, per-rung loot tables.

**In neither:** creature attack VFX. The `attacks` frame array
(`server.js:178`) is player-only, and wiring creatures into it is a separate
concern from making them shoot. Creature projectiles will render, because the
client already draws everything in `snap.projectiles`; what they will not have
is a per-attack effect name.

**Not touched:** `PATH_NAME_RE`, `detectPathTile`, `authority/collision.js`,
`frontend/.../movement.js`.

---

## Risks

**Four styles ship without live content.** `kite`, `skirmish`, `hold` and
`ambush` have no creature using them until P4. The seeded `Sentry` and `Lurker`
profiles exist so `hold` and `ambush` are at least reachable by an admin
without a code change, but reachable is not exercised. This is the cost of
building mechanism before content, which is the whole reason P2 precedes P4.

**Creature projectiles are a new way for players to die.** Death and respawn
already exist and are unchanged, but the difficulty curve moves the moment a
Caster can apply burn — and the umbrella already notes the XP curve is
provisional and will need retuning once content lands.

**`ProjectileSim` is shared with live player combat.** Every change to it
carries the risk of regressing something players already rely on. The
`ownerKind` default of `'player'` is what keeps existing call sites
byte-identical, and that default is worth a test of its own.

**The tick loop is the program's highest-risk surface.** SOMET-243 needed three
review rounds here, and its second fix round introduced a fresh bug. Expect
empirical reproduction, not unit tests alone, to be what catches defects.
