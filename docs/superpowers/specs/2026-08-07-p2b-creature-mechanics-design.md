# P2b — Pack-leader buffs, apex abilities, knockback, per-rung loot

**Plane item:** SOMET-253 (In Progress)
**Umbrella:** `docs/superpowers/specs/2026-08-06-bestiary-program-design.md`
**Depends on:** P2a (SOMET-249), Done and merged at `51a16d3`
**Blocks:** P4 (SOMET-250). Order is P2a → P2b → P4.
**Migration range:** `1714440083000`–`1714440089000` (P2a consumed `80000`–`82000`).

---

## Goal

Finish the creature-mechanics half of the Bestiary Program: give the umbrella's
top rungs the abilities that distinguish them, and give every rung a loot
baseline, so that P4 can author 288 creature rows against a complete schema
without a second pass.

P2a made creatures able to attack. P2b makes them able to attack in more than
one way, to strengthen each other, to shove, and to drop something worth
killing them for.

---

## What P2a left behind

P2a shipped a twelve-row `creature_behaviors` catalog carrying both halves of a
creature's character on one row: how it moves and thinks (`aggro_radius`,
`leash_radius`, `chase_style`, `preferred_range`, `move_speed_mult`) and what it
does (`attack_kind`, `attack_range`, `attack_cooldown`, `projectile_speed`,
`projectile_radius`, `damage_override`). One creature, one attack.

Four things the umbrella asks for do not fit that row:

- A **Champion** buffs the creatures around it. Nothing in the schema relates
  one creature instance to another.
- An **Apex** has a repertoire. The behaviour row holds exactly one attack.
- A **Brute** knocks its target back. Nothing displaces anything.
- Every rung should drop loot appropriate to its tier. `creature_drops` is keyed
  on `entity_type_id` and knows nothing about rungs.

---

## Architecture

### The behaviour row splits along a real seam

`creature_behaviors` keeps **how a creature moves and thinks**. A new
`creature_abilities` child table owns **what it does** — one row per attack.
P2a's six attack columns migrate into slot-1 ability rows and are dropped from
the parent.

This is the larger of the two refactors considered; the alternative was leaving
the primary attack on the parent and putting only extra abilities in the child
table. That would have been cheaper but would have left a permanent asymmetry —
"attack 1 is here, the rest are there" — that every future reader has to carry.
Splitting on the movement/action seam instead produces two tables that each mean
one thing.

```
creature_behaviors                creature_abilities
  id                                id
  name                              behavior_id  → creature_behaviors (CASCADE)
  aggro_radius                      slot          (1..N, UNIQUE per behavior)
  leash_radius                      name
  chase_style                       attack_kind   melee | ranged | cast
  preferred_range                   attack_range
  move_speed_mult                   attack_cooldown
  damage_override                   projectile_speed
  aura_radius        (new)          projectile_radius
  aura_damage_mult   (new)          element       nullable
  aura_defense_mult  (new)          damage_mult
  aura_speed_mult    (new)          knockback     (new)
  gold_min           (new)
  gold_max           (new)
```

`damage_override` stays on the parent: it answers "how hard does a creature of
this rung hit", which is a property of the creature, not of one swing. Per-swing
variation is `creature_abilities.damage_mult`, which multiplies whatever the
creature's damage resolves to. A `cast` ability with `damage_mult = 0` is a pure
status-rider — that is a real configuration and must survive, so every read of
`damage_mult` is an explicit null check, never `||`.

`element` is nullable per ability and falls back to `entity_types.attack_element`,
so an Apex can pair a fire breath with a physical slam without needing two
entity types.

### The frozen golden trace is the guard for this refactor

P2a froze a 120-tick simulation trace
(`backend/tests/fixtures/creature_tick_golden.json`) before any production file
moved. That trace exercises the **simulation**, not the read path. If the
resolver emits the same primary-attack shape from a different source, all 120
ticks stay byte-identical.

That makes "the restructure changed nothing" a proven claim rather than an
asserted one — and it is the single most valuable thing P2a left for P2b.

**The trace must never be regenerated.** Not to accommodate a signature change,
not to "update it for the new shape". If it goes red, the refactor changed
behaviour and the refactor is wrong. `git log -- backend/tests/fixtures/` must
continue to show no commit to the fixture after the first production edit of
this branch.

### Both loaders read abilities in one query, live

P2a's inertness trap is the thing most likely to recur here, so it gets designed
against rather than tested for afterwards. There are **two** creature-loading
paths and both must carry abilities:

- `loadCreatureTypes` (`authority/creatures.js`) — the TYPE catalog
- the per-chunk instance query (`authority/server.js:596`) — the live creatures

Each gains a lateral join rather than a second round-trip:

```sql
LEFT JOIN LATERAL (
  SELECT COALESCE(json_agg(
           json_build_object(
             'slot', a.slot, 'name', a.name, 'attack_kind', a.attack_kind,
             'attack_range', a.attack_range, 'attack_cooldown', a.attack_cooldown,
             'projectile_speed', a.projectile_speed, 'projectile_radius', a.projectile_radius,
             'element', a.element, 'damage_mult', a.damage_mult, 'knockback', a.knockback
           ) ORDER BY a.slot
         ), '[]'::json) AS abilities
  FROM creature_abilities a WHERE a.behavior_id = b.id
) ab ON true
```

One row per creature, abilities as parsed JSON, and behaviour edits made in the
admin UI still take effect on the next chunk load exactly as they do today. A
catalog cached at world load would have silently broken that.

The `ORDER BY a.slot` inside the aggregate is load-bearing: slot order is
priority order, and an unordered `json_agg` would make ability selection depend
on physical row order.

**Both queries keep a SELECT-completeness guard**, extended to the ability
columns. As P2a learned: rationale comments must stay OUTSIDE the template
literal, or the comment text satisfies the guard by itself.

### Ability selection is deterministic

Each tick, for a creature with a target:

1. Filter to abilities whose per-slot cooldown has elapsed.
2. Filter to abilities whose `attack_range` covers the current target distance.
3. Take the **lowest slot** among the survivors.

No randomness. A creature with one ability always picks it, which is what keeps
the golden trace green by construction. Per-instance cooldowns become
`_abilityCd` keyed by slot, generalising P2a's single `_attackCd`.

Slot order is authored priority: an Apex's slot 1 should be its signature move,
slot 2 its filler. Nothing enforces that beyond authoring.

### Auras are transient and never persisted

A creature with `aura_radius > 0` is a leader. Each tick, before movement and
attack resolution, every living leader buffs same-faction creatures within its
radius — **excluding itself**, because an aura is leadership rather than
self-empowerment.

**Non-stacking: the strongest single value wins per stat.** Two overlapping
Champions do not compound into a 2.25× damage pack. This is the difference
between a hard fight and an unwinnable one, and it is asserted directly.

Nothing is written to `world_creatures`. The buff is recomputed from scratch
every tick, so a leader's death removes it instantly and there is no cleanup
path to get wrong — the failure mode where a buff outlives its source simply
cannot occur.

Following P2a's `movedWith` precedent, the buff **never mutates** `c.damage`,
`c.speed` or `c.defense`. Effective values are computed at the use site from the
base value and the buff. Mutating the instance would compound across ticks — a
1.5× aura applied every tick for ten seconds is a 57-times-stronger creature.

Cost is O(leaders × creatures) per world, and leaders are rare. `MAX_WORLD_CREATURES`
already bounds the inner term.

### Knockback extends the existing primitive

`server.js:142` already has `knockbackPosition` — pure, wall-guarded, written for
SOMET-243's blocked-portal bounce. It moves to a shared module and the portal
path keeps calling it **exactly as it does today**, with the same arguments and
the same all-or-nothing semantics.

Combat knockback wraps it: try the full distance, then half, then a quarter,
taking the first that lands somewhere walkable. Without the retry a target
standing against a wall absorbs the shove entirely, which reads as the mechanic
being broken. The portal path does not get the retry, because changing the
bounce is not this item's business.

Nothing goes through `resolveMove`. That function is one of two byte-for-byte
copies (frontend/backend) and is explicitly off-limits.

**Symmetric:** `creature_abilities.knockback` shoves players and other players'
targets; a new `item_types.knockback` shoves creatures. Player displacement
reuses the server-authoritative assignment at `server.js:1147`. Creature
displacement is easier — no client reconciliation.

For the melee arc, knockback applies to **survivors**, not to everything hit:
`meleeArcTargets` already returns the pre-swing target list and `applyMeleeArc`
returns the dead, so survivors are the difference. Shoving a corpse is wasted
work and would move a creature the sim has already removed.

### Loot inherits by rung

`behavior_drops` mirrors `creature_drops` — same columns, same CHECK constraints
— but keys on `behavior_id`. `spawnDrops` rolls **both** tables. A rung supplies
the baseline; a creature type's own rows stay pure flavour.

Gold works the same way. It is currently `entity_types.gold_min/gold_max`, read
into `entry.creatureGold` at world load. The behaviour row gains the same pair as
a **fallback**, used when the type's range is absent or zero.

The result is what P4 needs: 288 creature rows can be authored with no drop
authoring and no gold authoring at all, and each still drops something
appropriate to its rung.

---

## Admin surface

Following P2a's pattern and the catalog convention:

- The **Creature Behaviors** tab gains the aura fields and the gold range, plus a
  nested ability editor (add/remove/reorder rows, slot implied by position).
- The **Item Types** weapon form gains `knockback`.

**Every numeric input defaults to the field's documented default, never to 0.**
P2a's final review caught an Add-Behavior modal that defaulted everything to
zero, producing creatures that never moved, aggroed or attacked. A `damage_mult`
defaulting to 0 would produce an ability that hits for nothing; an
`attack_cooldown` of 0 would produce unbounded fire rate.

---

## Testing

**Never derive an expected value from the constant or seed file the
implementation reads.** This is the project's most-repeated vacuous-test shape.

**The golden trace gates the ability migration.** The task that moves attack
columns into `creature_abilities` is not complete until the frozen 120-tick trace
passes unchanged. It is not regenerated under any circumstance.

**Aura tests assert non-stacking directly.** A test with one leader passes
against an implementation that stacks. The load-bearing case is two overlapping
leaders producing the stronger value, not the product.

**Aura tests assert non-mutation.** After N ticks inside an aura and M ticks
outside it, the creature's base `damage`/`speed` must be unchanged. A test that
only checks the buffed output passes against an implementation that compounds.

**Ability-selection tests assert the loser.** "The ready ability fired" passes
for an implementation with no cooldown logic. The cases that bite: an ability on
cooldown is skipped in favour of a higher slot; an out-of-range ability is
skipped; and when nothing qualifies, the creature fires nothing rather than
falling back to slot 1.

**Knockback tests assert direction and the wall case.** "The target moved" passes
for a creature that moved on its own. Assert the target moved *away from the
attacker*, and that a target with its back to a wall ends somewhere walkable —
never inside geometry, and never nowhere at all if a shorter push would fit.

**Loot tests assert the union.** A creature whose type has drops AND whose rung
has drops must roll both. A test using a creature with only one of the two passes
against an implementation that picks whichever it finds first.

**Loader guard tests extend to every new column**, in both loaders.

### Database safety

These are absolute, and they exist because they have each been violated:

- **No test may write to a real catalog row** — not by id, not by name, not even
  a write it expects to be rejected. A P2a task asserted an FK would refuse a
  `DELETE` of the `Line` row; the FK did not exist yet and the delete destroyed
  it.
- **No `DELETE FROM` a catalog table, no `TRUNCATE`, no `DROP`.** A reviewer once
  wiped `entity_types` to test a seeder.
- **Fixtures are `zz`-prefixed and deleted by name, unconditionally, in a
  `finally`** — never by an id captured mid-test.
- `make seed-catalogs` must never cost an admin something they authored by hand.

### Browser verification

Each of the four mechanics is verified live, not inferred from a green suite:

- **Aura** — give a common creature type a Champion-style profile with an aura,
  observe buffed neighbours, kill the leader, observe the buff vanish.
- **Multi-ability** — give a type two abilities with different elements and
  cooldowns; observe both in the projectile stream.
- **Knockback** — observe the player displaced by a creature hit, and a creature
  displaced by a weapon swing.
- **Loot** — kill a creature whose type has no drops of its own and observe the
  rung's drop and gold on the ground.

All temporary catalog edits are reverted afterwards and the revert is verified.
`autoJoinTarget` returns null for admins — demote to player or the world picker
blocks the join.

---

## Out of scope

**Creature attack VFX.** Unchanged from P2a: the `attacks` frame array is
player-only. Creature projectiles render because the client draws everything in
`snap.projectiles`; they still have no per-attack effect name.

**Pack membership.** Deliberately not built. Auras make it unnecessary, and a
`pack_id` column would need P1's placement path, the regenerate route, and a
chunk-border story.

**Authoring rung content.** P2b builds the mechanism and seeds enough to exercise
it. Assigning rungs to 288 creatures is P4.

**Not touched:** `PATH_NAME_RE`, `detectPathTile`, `authority/collision.js`,
`frontend/.../movement.js`, and `resolveMove` in either copy.

---

## Risks

**This branch touches the live combat tick four times.** That is the review-surface
concern that split P2 in the first place. The mitigation is ordering: the three
creature-side mechanics land first, each behind its own review gate, and the
weapon-knockback half — which pulls in `item_types` and the weapon admin — goes
last, so the widest surface is added to a branch that is already stable.

**The ability migration re-touches everything P2a shipped.** Both loaders, the
resolver, the admin form, the SELECT guards, the seeder. The golden trace is the
reason this is acceptable rather than reckless.

**Knockback is the first mechanic that moves a player against their input.** The
precedent exists and is narrow (a blocked portal bounce, once per bump). Combat
knockback fires far more often, so a mistake in the wall clamp is a mistake
players will find immediately.

**Difficulty moves again.** P2a already made creatures able to kill players.
Auras and multi-ability Apexes move it further, and the XP curve is still
provisional per the umbrella. Retuning is P5's problem, but P2b is what makes it
urgent.
