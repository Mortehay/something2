# P4 — Bestiary: 288 Creatures Across 32 Lines × 9 Rungs

**Plane item:** SOMET-250 (Backlog)
**Umbrella:** `docs/superpowers/specs/2026-08-06-bestiary-program-design.md` — the line × rung × tier
structure, the 32 lines, the 9 rungs' hp/def/mechanic table, resistance rules, and depth
tiers/bands are all fixed there. This spec instantiates that structure; it does not redesign it.
**Depends on:** P2 (SOMET-249 + SOMET-253, both Done) — creature abilities, pack-leader auras,
knockback, per-rung loot are all live. P3 (SOMET-247, Done) — all 32 biomes and ~30 new tile
types exist. Both dependencies are satisfied.

---

## Goal

Turn the umbrella's fixed line/rung template into 292 real `entity_types` rows (288 new + 4
existing creatures re-themed to fit the taxonomy), each with correct stats, resistances, level
band, sprite prompt, gold range, and at least one drop rule — so the bestiary stops being three
creature types repeated across 20 worlds.

Content only. No schema changes, no new migration, no tick-loop code changes.

---

## Architecture

### Deterministic generation, not hand-authoring

A one-off script (not part of `seed-catalogs.js`'s regular idempotent path — this runs once,
its *output* is what gets committed and seeded) derives every field from two already-fixed
tables in the umbrella spec:

- **The 32-line table**: name, biome, primary element, depth tier.
- **The 9-rung table**: hp, defense, mechanic (which also fixes `behavior_id` — see below).

Per-field derivation rules:

| Field | Rule |
|---|---|
| `hp` / `defense` | Rung table value directly (band-midpoint, pre-`scaleCreature`). |
| `resistances` | Computed from the umbrella's rung-tier rule: Swarm/Skirmisher → none or one weak resistance; Line/Ranged/Caster → primary element at .4–.7; Brute/Heavy/Champion/Apex → primary element strong + partial `physical`. Never hand-picked — this is what keeps all 288 internally consistent with each other. |
| `behavior_id` | Exact 1:1 lookup by rung name against the already-seeded `creature_behaviors` catalog (`Swarm`, `Skirmisher`, `Line`, `Ranged`, `Caster`, `Brute`, `Heavy`, `Champion`, `Apex` — all 9 exist today, live, with abilities/auras/gold already wired by P2a/P2b). **No new behavior work.** |
| level band | Line's tier (I–IV) from the umbrella table, scaled within that tier's band range by rung (Swarm/Skirmisher near the tier floor, Apex near the ceiling). |
| `color`, `prompt` | Templated from line theme + rung size/role as a first pass, then hand-polished during human review (Step 3 below) — never shipped as raw, unreviewed template output. |
| `gold_min` / `gold_max` | Left unset (falls back to the rung's already-seeded `creature_behaviors` gold range) unless a specific creature's flavor calls for an override. |
| drop rule | One `creature_drops` row per creature (per-type, in addition to the automatic rung-level fallback), item chosen from the existing `item_types` catalog by tier/theme match. **Requires an inventory of the current item catalog before the mapping rules can be written concretely — first task of the implementation plan.** |

Output is a generated file in the same shape as `backend/seeds/data/entityTypes.js`
(`HOSTILE_CREATURES` + `CREATURE_DROPS` arrays) — committed to the repo as reviewable content,
not generated at seed time. `make seed-catalogs` stays deterministic and idempotent exactly as
it is today; this just gives it more rows to insert.

No new migration. No new columns. This is pure content on top of schema P2a/P2b already built.

### Legacy creature remapping

`Wolf`, `Slime`, `Skeleton`, `Bat` predate the 32-line taxonomy and don't cleanly map onto it —
their resistances/themes were chosen ad hoc. Rather than leave them as an orphaned fifth
taxonomy or duplicate near-identical creatures, they get folded in: same **name** (never
renamed — `world_creatures.type` stores it as text, not a foreign key, so a rename would
silently orphan every live placement), re-themed to a specific line's **Line rung**:

| Creature | → Line | Biome | Element | Tier | Live placements today |
|---|---|---|---|---|---|
| Wolf | Beast | Meadow | — | I | **0** — free change, no balance risk |
| Skeleton | Undead | Catacombs | ice | I–II | 25 — real balance change (existing ice resistance already fits) |
| Bat | Fungal | Fungal Deep | lightning | II | 12 — real balance change (existing lightning resistance already fits) |
| Slime | Desert | Arid Dunes | fire | I | 4 — real balance change (existing fire resistance already fits) |

The three non-Wolf remappings are **live-balance changes**, same category as P2b's Line-profile
gold/drop additions — disclosed here explicitly, not hidden inside a generic "content update."
These four line/rung assignments are proposals to be confirmed during the human review pass
(Section below), not locked commitments — any can be reassigned before seeding if the generated
result doesn't read right.

### Review workflow

1. Inventory the current `item_types` catalog — needed before the drop-rule mapping can be
   written concretely.
2. Write the generator script; run it once to produce the committed seed-data file (292 rows:
   288 new + 4 remapped, plus 292 `creature_drops` rows).
3. Human review pass over the generated file as a diff — coherence, flavor, any line/rung that
   reads wrong, before anything is seeded anywhere.
4. Seed against the dev DB via the existing `make seed-catalogs` idempotent path.
5. Fix `creature_drops_db.test.js` (and any sibling catalog-wide invariant test) to expect 292
   creature types instead of 5 — mechanical, not a design change.

---

## Testing

- `creature_drops_db.test.js` and sibling catalog-wide invariants (element resistance shape,
  loader guard tests) pass against the full 292-row catalog.
- No golden-trace risk: this is pure content, zero changes to `backend/src/authority/` or the
  tick loop.
- No new migration to round-trip.
- Full visual/browser verification of the new content is gated on sprite generation (separate,
  user-run, ~6 hours of local machine time per the umbrella's own risk note) — out of scope for
  this plan's own verification. A spot-check of a small sample per realm, not all 288, is
  reasonable once sprites exist.

---

## Out of scope

- **Sprites.** Coding agents cannot generate images. Every new creature renders as a flat color
  box until the user runs local sprite generation. Not blocking, per the umbrella.
- **Map placement of the new creatures into specific worlds.** That's P5 (SOMET-251), which
  consumes P4's output — not part of this plan.
- **XP curve retuning.** The umbrella already flags this as explicitly deferred, its own pass
  once content lands, not any single sub-project's job.
- **Splitting this plan by realm.** Considered (surface/underground/abyssal) and explicitly
  rejected for the design/spec phase — the full 288-creature generation approach is decided as
  one pass. The *implementation plan* built from this spec may still batch work by realm if
  that proves more reviewable in practice; that's a planning-level decision, not a design one.

---

## Risks

**288 generated rows is still 288 rows a human has to actually read.** The generation script
removes per-row guessing (every field traces to a rule, not a judgment call), but the review
pass in Step 3 is real work and is where most of this plan's actual time will go.

**Three live creatures get retuned.** Skeleton/Bat/Slime's stat and resistance changes affect
creatures already placed in live worlds (25/12/4 instances respectively). This is a disclosed,
intentional content change, not a side effect — flag it in the eventual PR/commit the same way
P2b flagged its own live-balance changes.

**Drop-item mapping needs the item catalog inventoried first.** This spec names the *rule*
(tier/theme match) but not the specific item assignments — that's the first concrete task of
the implementation plan, not resolved here.
