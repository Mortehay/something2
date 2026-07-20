# Phase 6 Slice 3b-3c — Elemental identity, status effects, mana depth

**Date:** 2026-07-20
**Plane:** SOMET-61 (3b-3), sub-slice c — the final sub-slice
**Depends on:** 3b-3a (weapon catalog, stamina, melee LOS — `4e50a51`) and 3b-3b (AoE + ammo — `51c4ecb`)

## Goal

Make the element on a weapon change how a fight plays, not just which number is printed.

## The problem this slice exists to fix

Elements are almost entirely **inert** today, and the evidence is in the data:

- The catalog has **one** fire weapon, **one** ice weapon, **one** lightning weapon. Sixteen weapons have `element` NULL (physical).
- The only armor carrying any resistance at all is `arcane-ward` (`{"arcane": 0.3}`). No armor resists fire, ice, lightning, or physical.
- **Creatures carry no mitigation whatsoever.** `creatures.js` damages them with a direct `c.hp -= damage` at three sites (lines 125, 141, 153), while *dealing* damage to players through `applyDamage` (line 96).

So picking a frost staff over a flame staff currently changes nothing except raw damage and cooldown. In PvE — most of the game — the `element` column is decorative.

This is the same failure mode as 3b-3a's stamina economy: a complete, correct, fully-tested feature whose numbers guarantee it never engages. It is already shipped. This slice is the correction.

## Decisions (locked during brainstorming)

1. **Both** status effects and creature resistances. Resistances alone leave the staves interchangeable; status effects alone leave elements absorbed by nothing in PvE.
2. **Effects are transient, in memory only.** They last seconds; persisting them would mean database writes on a tick loop, the opposite of every decision this project has made about transient state (projectiles work exactly this way). Creature death and player disconnect clear them naturally.
3. **Re-application refreshes duration; effects never stack.** One entry per `(target, effectKey)`, so the structure is bounded by the number of effect kinds, not by rate of fire.
4. **Lightning carries all three riders** — vulnerability, interrupt, and mana drain. This was chosen deliberately over spreading them, with the cost understood and priced in (see "Balancing the storm staff").
5. **Arcane gets no rider** and remains the pure-damage generalist.

## Part 0 — There is only one creature, so the slice must add some

Discovered while writing the plan: `entity_types` contains exactly **one** creature — `Wolf`. Everything else is scenery (`Tree`, `Stone`, `IceRock`) plus `Player`.

This invalidates the original framing. With a single creature type, resistances create no matchup: giving Wolf ice resistance does not make element choice a decision, it just makes ice worse. An invariant asserting "several creature types carry resistances" would have been unsatisfiable.

**Creature variety is therefore in scope**, and it is far cheaper than it first appears:

- `spawnChunkCreatures` picks uniformly from the creature list by hash, so **a new row spawns in the world automatically** — no spawn-table wiring.
- Creatures render from their `color` field, so **no sprite work is required**.
- A creature type is any `entity_types` row with `is_creature = true`.

So the cost is genuinely: insert rows, and make sure the loader reads the new columns.

### The roster

Four creatures, each with a distinct elemental profile so element choice becomes a real decision rather than a flat nerf:

| name | hp | defense | resistances | the choice it creates |
|---|---|---|---|---|
| Wolf (existing) | 12 | 0 | `{}` | the neutral baseline — every element works |
| Slime | 18 | 0 | `{ fire: 0.6, physical: 0.3 }` | tanky vs fire and melee; **ice and lightning are the answer** |
| Skeleton | 14 | 2 | `{ ice: 0.6, physical: 0.2 }` | shrugs off frost; **fire is the answer** |
| Bat | 8 | 0 | `{ lightning: 0.5 }` | fragile but shrugs off shock; fast to kill with anything else |

No creature resists arcane, which is deliberate: arcane carries no status rider, so reliable unresisted damage is its identity — the generalist's compensation for having no effect.

**Resistance cap is 0.8 in `applyDamage` and nothing here approaches it**, so no creature is ever close to immune, and the damage floor of 1 guarantees any weapon can eventually kill anything.

### The loader trap this must not repeat

`server.js:70` reads `SELECT id, name, color, hp FROM entity_types WHERE is_creature = true` and maps only `{name, hp, color}`. Adding `defense`/`resistances` columns without extending BOTH the SELECT and the mapping loads them as `undefined`, and every resistance is silently inert — the identical failure mode that a guard test was added for in 3b-3b (`loadItemTypes`). **That guard pattern must be applied here too**: a test asserting the SELECT names every column the mapping consumes.

### Known inconsistency, noted not fixed

`Wolf` has `hp = 12` and `max_hp = 0`, and `creatures.js` spawns with `hp: c.hp, maxHp: c.hp` — so `max_hp` is unused and wrong in the data. New rows should set both consistently, but repairing the column's meaning across the codebase is out of scope here.

## Part 1 — Creature damage must route through the one mitigation path

This is the highest-value change in the slice and it is mostly the deletion of a divergence.

`entity_types` gains:

| column | type | meaning |
|---|---|---|
| `defense` | `real NOT NULL DEFAULT 0` | flat reduction, same semantics as armor |
| `resistances` | `jsonb NOT NULL DEFAULT '{}'` | per-element 0..1, same shape and validation as armor |

Creatures gain a `mit` field at spawn (built once from their entity type, exactly as a player's `mit` is built from equipment), and **all three raw-damage sites route through `applyDamage(c, raw, element, c.mit)`**.

`applyDamage` already floors at 1 and caps resistance at 0.8, so a creature can never become immune or unkillable. Its NaN-guarding comment already explains why that matters.

**The element must be threaded to those call sites.** Today `applyMeleeArc` and `damageCreatureById` receive only a number. They gain an `element` parameter. A missed call site silently reverts that path to element-blind damage — the DEFECT this whole part exists to remove — so every caller must be found and updated, and a test must assert each path passes its weapon's element through.

## Part 2 — Status effects

### The structure

```js
// effects.js
// target.effects : Map<effectKey, { until, magnitude, sourceId }>
```

One entry per `(target, effectKey)`. `applyEffect` overwrites `until` (refresh) and never appends. Ticked once per `World.tick`, for players and creatures alike, via one shared function — two implementations would drift the way melee and ranged LOS drifted before 3b-3a unified `MAX_SUB`.

### The effects

| element | key | behaviour |
|---|---|---|
| fire | `burn` | damage over time, applied through `applyDamage` with element `fire` |
| ice | `chill` | movement speed × 0.6 |
| lightning | `shock` | **+25% damage taken**, **mana drain per tick**, **and a ~0.4s interrupt** |
| arcane | — | no rider |

Burn routing through `applyDamage` matters: a burn on a fire-resistant target must be reduced by that resistance, or fire resistance would stop the hit and not the fire.

### Shock's interrupt is the one exception to refresh semantics

Refresh-stacking means that under sustained fire, **a refreshed effect is a permanent effect**. That is acceptable for damage over time and for a partial slow. It is NOT acceptable for anything that removes player control: a storm staff on a 0.95s cooldown would hold a target interrupted indefinitely.

So the interrupt gets a **separate per-target immunity window (3s)**, stamped when the interrupt lands and **deliberately not refreshed by later hits** — it runs to completion, then the next shock may interrupt again.

The immunity window MUST exceed the fastest lightning weapon's cooldown, or it never limits anything and the exception is decorative. That is an invariant test, not a comment.

### Ordering within a tick

Effects are applied **before** movement resolution in `World.tick`, so a chill applied this tick affects this tick's movement rather than lagging by one frame. Deaths from burn damage resolve through the existing single `resolveDeaths` / `onCreatureDeath` path — burn must not introduce a fourth way for something to die. A creature killed by a burn tick routes through `commitCreatureDeath` exactly like any other kill, so it still rolls loot.

## Part 3 — Mana depth

Shock's mana drain gives mana a second pressure beyond spending it. Combined with 3b-3a's regen and 3b-3b's untouched cost model, a caster fighting a storm staff manages a pool that is being actively attacked — which is what makes mana an economy rather than a cooldown.

Drain is clamped at 0 (never negative) and does nothing to a target with no mana pool, which is every creature.

## Balancing the storm staff

Lightning carrying three riders makes it the strongest element. Because **lightning is exactly one weapon**, that is tunable in one row rather than across a tier.

Storm staff moves from `damage 19, cooldown 0.95, mana 24` to **`damage 14, cooldown 1.10, mana 34`**. It becomes the worst raw-damage staff per point of mana in the game, and buys that with the richest rider set.

An invariant test asserts storm staff's damage-per-mana is strictly below every other staff's. Without it, a future rebalance could quietly restore dominance — and every other test would still pass.

## Known risk, stated rather than pre-solved

**Two of lightning's three riders are PvP-only.** Creatures have no mana, so drain does nothing to them, and vulnerability plus interrupt is all that lands in PvE. Lightning's dominance is therefore concentrated in PvP — which is exactly where a stun-adjacent effect is most resented. Watch this during the browser pass. If it reads as oppressive, the lever is the immunity window, not the damage.

## Reachability — what this slice must prove about itself

This project has twice shipped a feature that was correct and inert. Each mechanic here gets a test that it can actually **engage**:

- **Creature resistances are populated AND they create a real choice.** A resistance table nobody fills is the current inert state with more code — but so is a table where every creature resists the same thing. Assert that at least three creature types carry a non-empty `resistances`, **and** that no single element is the best choice against all of them (for each element, some creature resists it, and for each creature, some element is unresisted). That second half is what makes it a matchup rather than a set of flat nerfs, and it is the assertion that would fail if a future edit made every creature fire-resistant.
- **Time-to-kill measurably differs by element.** Against Slime, an ice weapon must kill measurably faster than a fire weapon of equal raw damage. This is the end-to-end proof of the slice's premise, and it fails if any of the three creature-damage sites is still bypassing `applyDamage`.
- **Burn is meaningful.** `burn_tick_damage × duration` must be a non-trivial fraction of the weapon's hit damage, or the DoT is decoration.
- **Chill actually changes outcomes — but not the outcome you would first assume.** `PLAYER_SPEED` is 200 and `CREATURE_SPEED` is 40, so a chilled player at ×0.6 still moves at 120, **three times** creature speed. Creatures cannot catch any player, chilled or not, at any multiplier this slice would sanely use. Chill is therefore a **PvP and projectile-dodging** mechanic, not an anti-escape one, and its reachability test must say so: assert the chilled/unchilled speed differential is large enough to decide a player-versus-player chase (a 40% gap closes distance quickly), and assert the chilled speed against the real `PLAYER_SPEED` constant rather than a literal. A test written against creature pursuit would be vacuous — it can never fail, because the pursuit never succeeds either way.
- **The interrupt immunity window limits something.** `IMMUNITY_MS > storm staff cooldown`, with a failure message that explains the chain-lock this prevents.
- **Storm staff is not strictly dominant** (damage-per-mana, above).

## Testing

- Each of the four elements applies its own effect and no other.
- Re-application refreshes and does not stack: apply twice, assert exactly one entry and the later expiry.
- An expired effect is removed and stops acting.
- Burn damage goes through `applyDamage` — a fire-resistant target takes reduced burn. **Pair it with a non-resistant control**; either alone proves nothing.
- Chill slows and expires cleanly, restoring the **exact** original speed. Apply and expire chill many times in sequence and assert the speed is still precisely `PLAYER_SPEED` — a multiply-on-apply / divide-on-expire implementation accumulates float drift and leaves a player permanently a fraction slower. Store the base speed and recompute, rather than mutating in place.
- Shock's interrupt cannot chain-lock: apply repeatedly at the storm staff's fire rate and assert the target acts within a bounded window.
- Mana drain clamps at 0 and no-ops against a target with no mana.
- Creature damage routes through `applyDamage`: a fire-resistant creature takes less from a flame staff than from an equal-damage physical weapon. This is the test that fails if any of the three raw sites is missed.
- A creature killed by a burn tick still drops loot (proving it went through the single death commit).
- Effects are cleared on player disconnect and creature death — no leak into a respawned entity.

Live browser verification must cover: visible burn ticking on a creature, a chilled player moving slowly, shock's interrupt feeling brief rather than oppressive, mana visibly draining under lightning fire, and a resistant creature visibly taking longer to kill with the wrong element.

## Out of scope

Dispels and cleanses; effect-resistance stats; elemental *vulnerabilities* (>100% damage) as distinct from resistances; damage-over-time ground patches left by AoE; per-effect visual art beyond a tint or icon; rebalancing armor against the new effect load; status effects on creature contact damage.
