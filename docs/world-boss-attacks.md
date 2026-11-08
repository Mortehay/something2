# World boss attacks

Each world boss throws more than its two original skills. The kit is catalog data
(`creature_skills`, bound through `creature_behavior_skills`), the schema and the content come from
`backend/migrations/1714440873000_world_boss_attack_kits.js`, and an admin can retune or extend it
without a deploy.

## The kits

Slot order is priority: the lowest ready slot casts. Every boss's ultimate has the first new slot (3).

| Boss | Original | New (slot: skill, kind, opens in phase) |
| --- | --- | --- |
| Ignis (fire) | 1 Magma Slam, 2 Cinder Brood | 3 Magma Cataclysm (ultimate nova, 3) · 4 Lava Ring (nova with a safe middle, 2) · 5 Blazing Charge (charge, 2) · 6 Meteor Shower (rain, 3) · 7 Meteor Shower (rain, **enrage only**) |
| Glacius (ice) | 1 Permafrost Nova, 2 Glacial Lance | 3 Frozen Cataclysm (3) · 4 Frost Breath (fan of 3 projectiles, 1) · 5 Glacier Blink (blink, 2) · 6 Ice Spikes (rain in a ring around the target, 2) · 7 Ice Spikes (**enrage only**) |
| Gorgon (lightning) | 1 Thunder Slam, 2 Static Pulse | 3 Storm Cataclysm (3) · 4 Chain Lightning (chain, 1) · 5 Overload (fast close nova, 1) · 6 Storm Dash (charge, 2) · 7 Thunderstorm (rain, cross pattern, 3) · 8 Thunderstorm (**enrage only**) |
| Abyssor (arcane) | 1 Void Bolt, 2 Rift Collapse | 3 Void Cataclysm (3) · 4 Void Orbs (fan of 5 slow projectiles, 1) · 5 Gravity Well (nova that pulls players in, 2) · 6 Void Blink (blink, 2) · 7 Rift Rain (rain, 3) · 8 Rift Rain (**enrage only**) |

The enrage-only binding is a second copy of one rain skill with its own cooldown slot and
`power_scale` 1.2, so enrage roughly doubles that hazard's pressure.

## Beats of the fight (`authority/bossSkillRules.js`)

* **Entering a phase** the boss throws its signature attack ahead of the rotation (queued with
  `queueSkill`, cast ignoring cooldown and range): phase 3 its hazard attack (Meteor Shower, Ice Spikes,
  Thunderstorm, Gravity Well), phase 4 its Cataclysm.
* **Every Ward** (from phase 2, every 45 s) comes with an attack: Lava Ring, Frost Breath, Overload, Void Orbs.
* **Enrage** (hp under 10 % or the last minute of the boss's life) shortens every cooldown
  (`ENRAGE_COOLDOWN_SCALE` = 0.75) and opens the enrage-only bindings, so the ultimate comes round more
  often the closer the fight is to its end.

A name in those tables that no longer matches a bound skill is dropped by the sim: renaming a skill costs the
cue and nothing else.

## Skill kinds and `params`

`creature_skills.kind` is one of `slam`, `nova`, `summon`, `projectile`, `charge`, `blink`, `rain`, `chain`.
`creature_skills.params` (jsonb, optional) shapes them:

| param | for | meaning |
| --- | --- | --- |
| `inner_radius` | nova, slam | world units of safe middle (a ring); the telegraph leaves the hole unfilled |
| `pull` | nova, slam | drags a surviving player this far toward the centre (wall-aware) |
| `proj_count`, `proj_spread`, `proj_speed` | projectile | a fan of shots across `proj_spread` radians |
| `dash_distance` | charge | how far the dash runs (default 500) |
| `hits` | all area kinds; chain | blows per area; for `chain` the number of jumps |
| `zones` `{count, spread, pattern}` | rain | `scatter` (first on the target), `ring` (around it), `cross` |
| `ultimate` | any | drawn more urgently on the client |

`chain` strikes where its telegraph showed (a 70 px circle on the target), then leaps to the nearest player
not yet hit within `radius`, `hits` times, each blow 15 % weaker; a target who stepped out takes nothing.

The binding (`creature_behavior_skills`) adds two gates: `min_phase` (1-4) and `requires_enrage`. An editor
that saves a behaviour without sending them keeps what was there.

## Sprites on attacks

Every attack's `vfx` binding (`telegraph`, `cast`, `impact`) names a `vfx_effects` row, and a row can now
carry a sprite sheet. Each new skill has its **own** rows (`boss_meteor`, `boss_lava_ring`, ...), so adding art
to one attack does not touch a shared effect.

In the admin **Attack Effects** tab, on an effect:

1. **Sprite sheet**: pick a PNG (at most 600 KB, 8192x2048 px). It is a **horizontal strip of equal frames**.
2. **Frames**: how many frames the strip holds. It plays once across the effect's `duration_ms` and holds the
   last frame.
3. **Size (world)**: the width in world units; 0 uses the attack's own reach (a ring's diameter, a bolt's length).
4. **glow (additive)**: blend with `lighter` (fire, lightning, magic).
5. The preview uses the picked file at once; it is uploaded when you press Save
   (`POST /api/vfx-effects/sprite` -> `vfx/<uuid>.png`).

How the shape lays the sheet out: `ring` a flattened ground disc that grows open, `burst` an upright billboard
on the impact, `line`/`arc` a strip stretched along the aim, `bolt` a strip that travels to the reach. In a
**telegraph** the sprite is drawn over the ground and steps through its frames as the wind-up fills; the red
outline always stays, so the danger zone is readable whatever the art. Until a sheet has loaded (or if it never
does) the effect is drawn as its vector shape.

## Operator steps

Run the migration; then `make seed-sync-export GROUP=attack_effects` and `GROUP=creature_behaviors` on a machine
that has pulled this change, so the checked-in JSON carries the new rows (they already do for the migrated
defaults). The `sprite_image` KEY travels with the effect row in that export, but the PNG itself lives only in
the asset store of the environment it was uploaded to: on another machine the effect falls back to its vector
shape until the sheet is uploaded there too.
