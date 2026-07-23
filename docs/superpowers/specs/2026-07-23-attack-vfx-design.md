# Attack VFX — melee, ranged and magic attack display

**Date:** 2026-07-23
**Plane:** SOMET-157 (epic) — slices SOMET-158 (A), 159 (B), 160 (C), 161 (D), 162 (E)
**Depends on:** 3b-3a (weapon catalog — `reach`/`arc_width`), 3b-3b (AoE + ammo), 3b-3c (elements)

## Goal

Make an attack visible, and make each weapon and each staff look like itself.

## The problem this spec exists to fix

Combat is mechanically complete and visually almost absent. The evidence:

| Attack type | Weapons | What the player sees today |
|---|---|---|
| Melee | 12 | **Nothing at all.** `world.attack()` resolves the arc synchronously and returns only `killedCreatureIds`. No frame ever tells the client an attack happened. |
| Ranged | 4 (bow, arbalest, sling, darts) | A 6px circle. |
| Magic | 6 staves | The *same* 6px circle, tinted by element. AoE staves add an expanding ring. |

So a halberd (reach 190, arc 1.8 rad) and a knife (reach 70, arc 0.5 rad) are visually identical: both are nothing. A player swinging at empty air gets no signal distinguishing "missed" from "the button didn't register". And the four mundane ranged weapons are indistinguishable from each other and from four of the six staves.

The weapon data to drive all of this **already exists and is already correct** — `reach`, `arc_width`, `range`, `element`, `aoe_radius`, `projectile_radius`. Nothing needs deriving; the geometry just needs to reach the client.

This is the same failure mode as the 3b-3c elements slice: a complete, correct, fully-tested combat engine whose output the player cannot perceive.

## Decisions (locked during brainstorming)

1. **Effects are hand-authored per weapon, not derived from stats.** Stat-derived visuals were considered and rejected: they would make a dagger and a knife look alike because their stats are alike. Authoring is explicit.
2. **Effect definitions are fully data-driven** — a `vfx_effects` table, tunable in an admin screen without a deploy. Not a code constant table.
3. **The vocabulary is geometric primitives *plus* particles.** Shapes alone were judged too flat for impacts; particles are where a hit reads as a hit.
4. **Every actor's attacks are visible** — local player, remote players, and creatures — through one server-driven code path. Local prediction was rejected: in a multiplayer world it would leave a wolf's HP-draining bite unanimated.
5. **All four moments are in scope:** the attack itself, impact on the target, miss/whiff feedback, and projectile trails.
6. **Bindings live in `jsonb`, not FK columns.** See "Why jsonb" below.
7. **An unbound weapon falls back to a kind-level default** rather than rendering nothing. See "Why a fallback exists" below.

## Data model

### `vfx_effects` — the library

One row per distinct look. Referenced by name.

The table below is the **final** shape. It arrives in two migrations: the geometry columns in slice A, the `particle_*` columns in slice C — so slice A is not blocked on settling particle semantics it cannot yet draw.

| column | type | notes |
|---|---|---|
| `id` | serial PK | |
| `name` | text unique not null | `'sweep_heavy'`, `'spark_fire'` — the stable reference key |
| `shape` | text not null | `arc` \| `line` \| `ring` \| `burst` \| `bolt` |
| `color` | text not null | `'#dddddd'` |
| `width` | real not null default 2 | stroke px |
| `duration_ms` | int not null default 180 | |
| `ease` | text not null default `'out'` | `linear` \| `out` \| `in` |
| `fade` | bool not null default true | alpha → 0 across the lifetime |
| `follows_weapon` | bool not null default false | geometry uses the event's `reach`/`arc` rather than fixed size |
| `particle_count` | int not null default 0 | 0 disables particles entirely |
| `particle_spread` | real not null default 0 | radians, centred on the aim vector |
| `particle_speed` | real not null default 0 | px/s |
| `particle_gravity` | real not null default 0 | px/s² |
| `particle_lifetime_ms` | int not null default 0 | |
| `particle_size` | real not null default 2 | px |

Constraints: `shape` and `ease` are CHECK-constrained to their enums (matching how `item_types.element` and `category` are constrained). `particle_count` is capped at a sane ceiling (see "Performance").

### Bindings — `vfx jsonb` on `item_types` and `entity_types`

```json
{ "attack": "sweep_heavy", "impact": "spark_steel",
  "miss": "whiff", "trail": "streak_arrow" }
```

Keys are moments, values are `vfx_effects.name`. Absent keys fall back (below). Both tables get the identical column so weapons and creatures resolve through one function.

`item_types.vfx` lands in slice A (weapons are what slice A draws). `entity_types.vfx` lands in slice D alongside creature attacks — the column is pointless until something reads it.

#### Why jsonb rather than FK columns

Four moments across two owner tables is eight nullable FK columns. The alternative considered was a `vfx_bindings(owner_kind, owner_id, moment, effect_id)` join table.

`jsonb` wins because it mirrors an established precedent in this codebase exactly — `tile_types.sprite` and `entity_types.sprite` are both jsonb descriptors referencing generated assets — and because adding a fifth moment later costs no migration.

**The cost is real and accepted:** there is no referential integrity, so renaming a row in `vfx_effects` silently orphans every binding pointing at it. Two mitigations: the admin screen binds via a dropdown of existing names rather than free text, and an unresolved name resolves to the fallback rather than throwing or drawing nothing.

#### Why a fallback exists

Decision 1 says effects are hand-authored. Taken literally, a weapon nobody has bound yet renders *nothing* — which is indistinguishable from the bug this whole spec exists to fix, and it would regress silently every time someone adds a weapon in the Items admin.

So resolution is: **binding → kind-level default → nothing**. Defaults are keyed on `item_types.kind` (`melee` → generic slash, `projectile` → generic bolt) and on `is_creature` for entities. Authoring stays fully explicit; *missing* authoring degrades to plain-but-visible.

## Protocol

Attacks and impacts are transient per-tick facts. They ride the existing `state` frame using the same stash-and-clear pattern `pendingDetonations` already uses in `server.js` — conditional fields on a frame that is already being sent, so no new message type and no extra sends.

```js
frame.attacks = [{
  a: 'p:1',            // actor: 'p:<userId>' | 'c:<creatureId>'
  v: 'sweep_heavy',    // resolved effect name (already fallback-resolved server-side)
  x, y,                // origin, world px
  nx, ny,              // aim unit vector
  reach, arc,          // real weapon geometry; null for projectile kinds
  hit: false           // false -> client plays the `miss` effect instead
}]

frame.impacts = [{
  t: 'c:88',           // who was hit
  x, y,                // where
  v: 'spark_fire',     // resolved effect name
  el: 'fire'           // element, for tinting; null = physical
}]
```

Every value here is already computed inside `world.attack()` — `normalizeAim` produces `nx/ny`, the weapon row carries `reach`/`arc_width`, and the hit set is already known because damage is already applied. This exposes existing facts rather than deriving new ones.

**Effect names are resolved server-side**, not on the client. The client should never need the weapon catalog or the fallback rules to draw a frame; it receives a name and looks it up.

Creature contact damage in `creatures.js` (the `_attackCd` path, two sites) stamps the same descriptor shape, which is what makes decision 4 one code path rather than two.

## Client

### `core/vfx.js` — pure, canvas-free

Follows the `blasts.js` precedent precisely: pure and canvas-free so it unit-tests under vitest's `node` environment, with the renderer as a thin consumer.

- `addEffects(list, events, nowMs, defs)` — stamp each event with its **arrival** time (the only clock both ends agree on without clock sync — the same reasoning `addBlasts` documents)
- `pruneEffects(list, nowMs)` — returns a **new** array, so an effect can't be mutated out from under an in-progress draw
- `effectProgress(fx, nowMs)` → 0..1, eased
- `particlesAt(fx, progress)` → positions, a **pure function of progress and a per-effect seed**

Particles are deterministic by construction. `Math.random()` inside a draw loop would make them untestable and would make the same effect look different on every client; a seed derived from the event makes them reproducible in a unit test.

### Rendering

`RenderSystem` gains a `drawVfx()` pass after the depth-sorted entity pass and before the HUD, so effects sit above the world but below UI. Effect definitions load once via `GET /api/vfx-effects` and are handed to `Game` the same way `tileTypes` and `entityTypes` already are.

## Testing

| Layer | What is tested |
|---|---|
| `vfx.js` | lifetime and pruning, eased progress curves, particle determinism (same seed → same positions), fallback resolution order |
| Migration | columns and CHECK constraints exist, seeded rows present — in the style of `migration_tile_prompts.test.js` |
| Authority | `attacks` carries correct geometry for a melee arc; `hit:false` on a whiff; `impacts` lists exactly the damaged targets; creature attacks emit the same shape |
| API | `GET /api/vfx-effects` shape; admin CRUD guarded by `requireAdmin` |
| Browser | each slice verified in a real world before it is called done |

The browser step is not optional. Twice in recent work a fully green suite hid a real defect that only appeared in the running app.

## Performance

Particles are the only genuine risk: 22 weapons firing bursts in a crowded neighbourhood.

- Hard cap on **total live particles**, oldest-first eviction.
- `particle_count` validated on write, not just at draw time.
- Effects prune by lifetime every frame (`pruneEffects`), so the list is bounded by rate × lifetime, not by session length.
- The `attacks`/`impacts` fields are omitted entirely from frames with nothing to report, exactly as `detonations` already is — idle worlds pay nothing.

## Slices

Sequenced so the riskiest unknowns — protocol shape, schema expressiveness, render timing — are proven on a thin end-to-end path before the expensive surface (the admin screen) is built against them.

| Slice | Contents | Done when |
|---|---|---|
| **A** <br>SOMET-158 | `vfx_effects` table (geometry columns only) + `vfx` jsonb on `item_types` + server `attacks` event + arc renderer. Melee only, one seeded effect. | A halberd swing is visible in a real world. |
| **B** <br>SOMET-159 | Full shape vocabulary (`line`/`ring`/`burst`/`bolt`), all 22 weapons bound, miss feedback, kind-level fallbacks. | Every weapon looks distinct; a whiff reads as a whiff. |
| **C** <br>SOMET-160 | `impacts` event + particle columns + particle renderer + element tinting. | A hit sparks in the element's colour. |
| **D** <br>SOMET-161 | Projectile trails replacing the 6px dot; creature attack + impact effects. | An arrow, a fire bolt and a wolf bite are each distinct. |
| **E** <br>SOMET-162 | Admin CRUD screen for `vfx_effects` + binding dropdowns in the Items and Entity admins. | Effects are tunable live, no deploy. |

Slice A is deliberately the thinnest thing that exercises all three layers at once. Slices B–D widen a proven spine. Slice E is last because it is the most expensive single item and benefits most from a schema that drawing has already validated.

## Out of scope

- **AI-generated VFX sprites.** Considered and deferred; the sprite pipeline exists but VFX transparency and frame-to-frame consistency are materially harder than the props it currently handles.
- **Hit-stop, screen shake, damage numbers.** Adjacent combat feel, not attack display.
- **Reworking the existing blast ring.** It already works; it may later be re-expressed as a `ring` effect row, but not in these slices.
