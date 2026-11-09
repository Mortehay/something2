# World boss attacks

Each world boss has **one mechanic family** and five or six attacks that play differently from each
other and from the other bosses. The kits are catalog data (`creature_skills`, bound through
`creature_behavior_skills`), built by `backend/migrations/1714440874000_world_boss_distinct_kits.js`
on the schema from `1714440873000_world_boss_attack_kits.js`, and an admin can retune or extend them
without a deploy. `backend/tests/boss_distinct_kits.test.js` pins that no two attacks of a boss share
a mechanic signature and that each boss's signature mechanics belong to it alone.

Slot order is priority (the lowest ready slot casts): the ultimate first, the plain filler last.
"Phase" is the boss phase an attack opens in (2 at 75 % hp, 3 at 50 %, 4 at 25 %).

## Ignis, Magma Colossus (fire): ground that stays

| Slot | Attack | Kind | What it does | Phase |
| --- | --- | --- | --- | --- |
| 1 | **Meltdown** | shelter | the ultimate: one green safe circle appears 420 px toward you; everyone near the boss outside it takes ×3.2 | 4 |
| 2 | **Scorched Earth** | zone (ring) | a ring of fire round the boss (r 430 to 720) burns for 16 s; the middle stays clear | 3 |
| 3 | **Ember Mark** | mark | marks one player; after 3 s it explodes (r 230, ×2.2) where they stand NOW | 2 |
| 4 | **Lava Pools** | zone (targets) | pools under up to 4 players, burning for 9 s | 2 |
| 5 | **Cinder Brood** | summon | two Ember Skirmishers | 1 |
| 6 | **Magma Slam** | slam | strike on the target's spot | 1 |

## Glacius, Frost Leviathan (ice): control

| Slot | Attack | Kind | What it does | Phase |
| --- | --- | --- | --- | --- |
| 1 | **Absolute Zero** | nova | the ultimate: r 430, ×2.4, then **root 2.5 s** and slow 50 % | 4 |
| 2 | **Frost Field** | zone (scatter) | five patches for 12 s that do **no damage** but slow you 65 % while you stand in them | 3 |
| 3 | **Ice Spikes** | rain (ring) | six spikes in a ring round the target: step between them | 2 |
| 4 | **Flash Freeze** | slam | strike that **roots** for 2.2 s | 2 |
| 5 | **Glacial Lance** | projectile | long-range lance | 1 |
| 6 | **Permafrost Nova** | nova | r 250, slows 40 % for 3 s | 1 |

## Gorgon, Thunder Titan (lightning): speed and chains

| Slot | Attack | Kind | What it does | Phase |
| --- | --- | --- | --- | --- |
| 1 | **Thunderstorm** | rain, 4 waves | the ultimate: four rounds of seven strikes, 1.1 s apart, each planned round where you are NOW | 4 |
| 2 | **Static Charge** | mark (everyone) | every player is marked; after 3 s each explodes (r 170): stand apart, blasts stack | 3 |
| 3 | **Storm Dash** | charge | a dash through everyone on the line | 2 |
| 4 | **Static Pulse** | nova | huge nova with a 2.2 s warning | 1 |
| 5 | **Chain Lightning** | chain | strikes the target, then jumps to nearby players (up to 4, each 15 % weaker) | 1 |
| 6 | **Thunder Slam** | slam | fast strike | 1 |

## Abyssor, Voidreaver (arcane): space and mind

| Slot | Attack | Kind | What it does | Phase |
| --- | --- | --- | --- | --- |
| 1 | **Reality Tear** | rain | the ultimate: eight tears that **silence** 3 s whoever they hit | 4 |
| 2 | **Gravity Well** | nova | r 320 that **pulls** survivors 160 px toward the centre | 2 |
| 3 | **Mind Rend** | slam | strike that **silences** for 4 s (no attacks, no skills; you can still walk) | 2 |
| 4 | **Void Blink** | blink | teleports onto you | 2 |
| 5 | **Void Orbs** | projectile (fan) | five slow orbs across 0.9 rad | 1 |
| 6 | **Void Bolt** | projectile | fast bolt | 1 |

## Beats of the fight (`authority/bossSkillRules.js`)

* **Entering phase 3 / 4** the boss throws, ahead of the rotation: Scorched Earth / Meltdown,
  Frost Field / Absolute Zero, Static Charge / Thunderstorm, Gravity Well / Reality Tear.
* **Every Ward** (from phase 2, every 45 s) comes with an attack: Lava Pools, Flash Freeze,
  Chain Lightning, Mind Rend.
* **Enrage** (hp under 10 % or the last minute of life) shortens every cooldown by 25 %
  (`ENRAGE_COOLDOWN_SCALE`).
* **Shield, resistances and auras** are unchanged (see `services/bossBalance.js`).

## Skill kinds and `params`

`creature_skills.kind` is one of `slam`, `nova`, `summon`, `projectile`, `charge`, `blink`, `rain`,
`chain`, `zone`, `mark`, `shelter`. `creature_skills.params` (jsonb, optional) shapes them:

| param | for | meaning |
| --- | --- | --- |
| `status` `{root_s, slow_pct, slow_s, silence_s}` | slam, nova, rain, zone, mark, shelter | what a hit puts on a player (the same root / slow / silence the player skills use; a boss is immune) |
| `hazard` `{pattern, count, spread, inner, outer, linger_ms, tick_ms, slow_pct}` | zone | ground that stays: `pattern` is `targets` (under the nearest players), `ring` (round the boss, `inner` to `outer`) or `scatter`; `damage_mult` is per tick (0 = only slows) |
| `mark` `{targets}` | mark | how many players are marked (1 to 8, or `"all"`); the fuse is `telegraph_ms`, the blast `radius`; overlapping blasts stack |
| `shelter` `{safe_radius, safe_dist, reach}` | shelter | the safe circle and how far from the boss the damage reaches |
| `waves`, `wave_ms` | rain | the storm comes in rounds, re-planned on the target each time |
| `zones` `{count, spread, pattern}` | rain | `scatter`, `ring` (around the target) or `cross` |
| `inner_radius` | nova, slam | a safe middle (a ring) |
| `pull` | nova, slam | drags survivors toward the centre (wall-aware) |
| `proj_count`, `proj_spread`, `proj_speed` | projectile | a fan of shots |
| `dash_distance` | charge | how far the dash runs |
| `hits` | area kinds; chain | blows per area; for `chain` the number of jumps |
| `ultimate` | any | drawn more urgently, and given a longer warning |

On the client: **hazards** are drawn under the telegraphs (a disc, or a ring with its hole clear,
in the element's colour, fading over its last second; a sprite bound to the skill's cast effect loops
over it), **marks** are a ring and a growing fuse disc on each marked player, and a **shelter**'s safe
circle is a whole green pulsing circle (the danger is everywhere else).

The binding (`creature_behavior_skills`) carries `min_phase` (1 to 4) and `requires_enrage`. An editor
that saves a behaviour without sending them keeps what was there; likewise an update of a skill that
does not send `params` leaves its mechanics alone.

## Sprites on attacks

Every attack's `vfx` binding (`telegraph`, `cast`, `impact`) names a `vfx_effects` row, and a row can
carry a sprite sheet. Each new attack has its **own** rows (`boss_lava_pools`, `boss_meltdown`, ...), so
adding art to one attack does not touch a shared effect.

In the admin **Attack Effects** tab, on an effect:

1. **Sprite sheet**: pick a PNG (at most 600 KB, 8192x2048 px), a **horizontal strip of equal frames**.
2. **Frames**: how many frames the strip holds. It plays once across the effect's `duration_ms`
   (a hazard loops it) and holds the last frame.
3. **Size (world)**: the width in world units; 0 uses the attack's own reach.
4. **glow (additive)**: blend with `lighter` (fire, lightning, magic).
5. The preview uses the picked file at once; it is uploaded when you press Save.

In a **telegraph** the sprite is drawn over the ground and steps through its frames as the wind-up
fills; the outline always stays, so the danger zone is readable whatever the art. Until a sheet has
loaded the effect is drawn as its vector shape.

## Editing skills in the admin

The Creature Behaviors admin's skill modal offers every kind and a **Params (JSON)** box that
round-trips `params`; invalid JSON is refused before it is sent.

## Operator steps

Run the migration; the checked-in sync JSON (`attack_effects`, `creature_behaviors`) already carries
the new kits. The `sprite_image` KEY travels with an effect row in a sync export, but the PNG lives only
in the asset store of the environment it was uploaded to: elsewhere the effect falls back to its vector
shape until the sheet is uploaded there too.
