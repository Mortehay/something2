# Phase 6 Slice 3b-3a — Weapon catalog, stamina, melee line-of-sight

**Date:** 2026-07-19
**Plane:** SOMET-61 (3b-3), sub-slice a
**Depends on:** Slice 3b-2b (loot, merged `c44cf1e`) and its fast-follows (`c575444`)

## Goal

Fill the world with weapons that play differently, give martial combat its own resource,
and stop melee attacks passing through walls.

## Decomposition note

SOMET-61 as originally scoped bundled five subsystems. It is split into three sub-slices,
each with its own spec → plan → build cycle:

- **3b-3a (this spec)** — the content catalog, stamina, melee line-of-sight.
- **3b-3b** — AoE and consumable ammo.
- **3b-3c** — elemental identity, status effects, mana economy depth.

The order is dependency-driven: the later slices attach mechanics to weapons, so the
weapons should exist first. Line-of-sight is pulled forward into this slice specifically
because this slice is what multiplies long-reach weapons.

## Decisions (locked during brainstorming)

1. **Weapons differ along reach/arc vs speed vs damage** — not a flat power ladder. There
   must be no strictly-best weapon.
2. **Stamina is a real resource**, and it is implemented as mana's twin.
3. **Martial weapons cost stamina; magic costs mana.** No weapon costs both.
4. **Melee line-of-sight is a terrain ray-walk**, matching what projectiles already do.

## Stamina — deliberately a copy of mana

Mana already works: a pool on the player state, a regen applied in `World.tick`, a
per-weapon cost, a denial that **does not consume the attack cooldown**, and a field on
the `state` snapshot. Stamina is the same shape with different constants:

```js
PLAYER_MAX_STAMINA = 100;
PLAYER_STAMINA_REGEN = 12; // per second
```

The denial rule matters and must match mana's exactly: when the player cannot afford the
cost, the attack is refused **without** starting the cooldown, so a player who spams
attacks while empty is not additionally punished by a cooldown they never got value from.

`item_types` gains `stamina_cost integer NOT NULL DEFAULT 0`. A weapon with `mana_cost > 0`
should have `stamina_cost = 0` and vice versa — this is a **content** convention, not a DB
constraint, because a future hybrid weapon is plausible and the engine handles both costs
independently. Both are checked before either is deducted, so a weapon that somehow costs
both can never deduct one and then fail on the other.

## Melee line-of-sight

Today `inArc` decides a melee hit from geometry alone, so a 190px halberd hits through a
wall while projectiles are correctly terrain-blocked. That asymmetry is an exploit now
that PvP is on, and this slice raises the longest melee reach to 200px.

Add one shared helper:

```js
// weapons.js
function hasLineOfSight(map, x0, y0, x1, y1)  // -> boolean
```

It walks from `(x0,y0)` toward `(x1,y1)` in steps of at most `MAX_SUB` px, testing
`map.isWalkable` at each step, and returns false on the first blocked sample.

**`MAX_SUB` must be shared, not duplicated.** It is currently a function-local constant
inside `ProjectileSim.step`. Lift it to a single exported constant and have both the
projectile sub-stepping and the LOS walk import it. Two independently-maintained copies of
a sampling resolution is exactly how melee and ranged drift apart again.

The helper is applied to every melee candidate — creatures **and** players — in
`World.attack` and `CreatureSim.applyMeleeArc`. Cost is bounded: it runs only on an attack
(not per tick), and at most `reach / MAX_SUB` samples per candidate — 13 samples for the
longest weapon in the game.

**Deliberately not addressed:** creature contact damage does not get an LOS check. Contact
damage requires the creature to be within 60px, which it can only reach by pathing there,
so terrain already gates it.

## The catalog

22 weapons; the 4 existing rows keep their current stats and gain a `stamina_cost`.

**Close melee** — fast, short, narrow, cheap:

| name | dmg | cd | reach | arc | stam |
|---|---|---|---|---|---|
| knife | 6 | 0.25 | 70 | 0.5 | 0 |
| dagger* | 8 | 0.30 | 80 | 0.6 | 0 |
| stick | 7 | 0.35 | 90 | 0.7 | 0 |
| club | 10 | 0.45 | 85 | 0.8 | 2 |
| short sword | 11 | 0.45 | 100 | 0.9 | 2 |

**Mid melee:**

| name | dmg | cd | reach | arc | stam |
|---|---|---|---|---|---|
| mid club | 14 | 0.60 | 115 | 1.0 | 4 |
| long sword | 15 | 0.65 | 140 | 1.2 | 4 |
| morning star | 17 | 0.75 | 130 | 1.6 | 6 |

**Long melee** — all two-handed:

| name | dmg | cd | reach | arc | stam |
|---|---|---|---|---|---|
| two-handed sword | 22 | 1.00 | 170 | 1.4 | 9 |
| scythe | 20 | 0.95 | 175 | 2.0 | 8 |
| pike | 19 | 0.85 | 200 | 0.5 | 7 |
| halberd* | 18 | 0.90 | 190 | 1.8 | 8 |

**Ranged** — projectile, `element` null (physical), stamina-costed:

| name | dmg | cd | range | speed | radius | pierce | stam | 2H |
|---|---|---|---|---|---|---|---|---|
| darts | 7 | 0.35 | 350 | 800 | 6 | 1 | 1 | no |
| sling | 8 | 0.50 | 450 | 700 | 8 | 1 | 1 | no |
| bow* | 12 | 0.60 | 700 | 900 | 8 | 1 | 3 | no |
| arbalest | 20 | 1.20 | 850 | 1100 | 8 | 2 | 5 | yes |

**Staves** — projectile, elemental, mana-costed, `stamina_cost = 0`:

| name | dmg | cd | range | speed | radius | mana | element | 2H |
|---|---|---|---|---|---|---|---|---|
| apprentice staff | 10 | 0.55 | 500 | 650 | 10 | 8 | arcane | no |
| magic-bolt* | 14 | 0.70 | 600 | 700 | 12 | 15 | arcane | no |
| frost staff | 13 | 0.70 | 620 | 650 | 12 | 16 | ice | no |
| flame staff | 16 | 0.80 | 550 | 600 | 14 | 18 | fire | no |
| storm staff | 19 | 0.95 | 700 | 1000 | 10 | 24 | lightning | yes |
| archmage staff | 24 | 1.10 | 800 | 850 | 14 | 32 | arcane | yes |

*\* = already seeded; stats unchanged.*

### Why these numbers

Raw single-target DPS *falls* as weapons get heavier (dagger 26.7, long sword 23.1,
halberd 20.0, arbalest 16.7). Heavy weapons buy three things instead: **reach**, **arc
width**, and **per-hit burst**. Because an arc hits every target inside the cone, a wide
weapon's effective DPS scales with the number of enemies engaged — a scythe at arc 2.0
facing three creatures out-damages any dagger. Pike inverts the pattern deliberately:
the longest reach in the game paired with the narrowest arc, so it is a duelling
weapon that cannot sweep.

This is what makes the choice real rather than a ladder. It is also why elemental
resistances matter: staves trade raw damage for a damage type that armour may not
cover.

Ranged weapons are stamina-costed rather than free so that kiting has a cost before
ammo exists in 3b-3b.

## Surfaces this touches

Adding a column to the item catalog has repeatedly caught this project out, so all of
these must move together:

- **Migration** — `stamina_cost` column + seed 18 rows. `down()` drops the column and the
  seeded rows. Must survive a round trip with admin-authored rows present.
- **`validateItemType` in `backend/src/index.js`** — must accept and validate
  `stamina_cost`. In 3b-2a a validator that lagged the schema produced a 500; the API and
  the DB constraints must agree.
- **`items.js` `loadItemTypes`** — select and expose the new column, or every weapon loads
  with `stamina_cost` undefined and the gate silently never fires.
- **`ItemTypesAdmin.jsx`** — a field for it, so admin-authored weapons can set it.
- **`world.js`** — stamina pool, regen, the cost gate in `attack`, and the `state` snapshot.
- **Client HUD** — a stamina bar beside the mana bar.

### `renderHud` options-object refactor

`renderHud` currently takes 7 positional parameters; stamina makes 8, with two adjacent
same-typed pairs (`mana, maxMana, stamina, maxStamina`) that would silently compile if
transposed. This is the same debt already paid down for `renderChunked` in 3b-2b, and the
same reasoning applies. Convert it to an options object as its own commit, before the
stamina fields are added, so the refactor is reviewable in isolation.

## Testing

- **Stamina:** regen accrues and clamps to max; an attack deducts the cost; an attack with
  insufficient stamina is refused **and leaves the cooldown untouched** (the mana test for
  this already exists — mirror it); a zero-cost weapon is unaffected by an empty pool.
- **Line-of-sight:** a target in reach and arc but behind a blocked tile is NOT hit; the
  same target with clear terrain IS hit (the pair is the test — either alone proves
  nothing); a target at point-blank range is unaffected; LOS applies to players as well as
  creatures.
- **Shared constant:** a test asserting the projectile sub-step and the LOS walk read the
  same exported `MAX_SUB`, so the two cannot drift.
- **Catalog:** every seeded weapon loads with the fields its `kind` requires (a melee row
  needs reach and arc_width; a projectile row needs range, speed and radius) — this is the
  "unhittable weapon" class of bug the category CHECKs were added for in 3b-2a. Assert
  across the whole seeded catalog rather than spot-checking, so a typo in one of 18 rows
  cannot slip through.
- **API:** `validateItemType` rejects a negative or non-numeric `stamina_cost`.

Live browser verification must cover: swinging a long weapon at a target through a wall
(no damage), the same target in the open (damage), stamina draining and refusing a heavy
swing, and the HUD showing both bars.

## Out of scope

Ammo and AoE (3b-3b); status effects and per-element behaviour beyond existing resistance
(3b-3c); weapon durability; dual-wield damage stacking; weapon-specific animations or
sprites; rebalancing armour against the new damage range.

## Known risk to watch, not to pre-solve

`pike` at reach 200 out-ranges everything in a corridor. Its arc of 0.5 means it cannot
sweep, which should be enough — but it is the most likely balance outlier and should be
watched during the browser pass rather than pre-nerfed on speculation.
