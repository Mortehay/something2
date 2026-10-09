# Boss entities, auras and creature skills — design

Date: 2026-10-10
Status: approved in brainstorming, awaiting spec review

## 1. Purpose

Bosses today have no identity the asset pipelines can reach. The four world
bosses (Ignis, Glacius, Abyssor, Gorgon) are a hardcoded array in
`backend/src/authority/worldBoss.js`, are never rows in `entity_types`, and so
can receive neither art (`catalog_art`) nor sound (`audio_bindings`, creature
kind lists `entity_types WHERE is_creature`). They are drawn procedurally, with
the element guessed from the name. Dungeon `End`/`Elite` rooms have boss-room
music but spawn ordinary creatures — there is no dungeon boss at all.

This epic makes every boss a catalog creature, gives bosses extended sound,
adds a reusable aura system with real gameplay effect, adds creature skills
(boss-scale, reusable at smaller scale by ordinary creatures), and places
bosses in the dungeon End and Elite rooms.

### Success criteria

- Every boss (4 world, 3 dungeon End, 3 dungeon Elite) and every world-boss
  minion type is an `entity_types` row and appears in the Art, Sprite and
  Audio tabs with no special casing.
- A boss with approved art is drawn with that art at boss size; without art
  it falls back to the procedural drawing keyed on `element`, never on name.
- The server hitbox of a boss matches its catalog size (today it is forced to
  48 because `addCreatures` drops the boss fields).
- A boss on or near the screen plays its `presence` loop; `spawn`, `phase`,
  `enrage` one-shots play at a priority that creature chatter cannot evict.
- Auras are edited in an **Aura Effects** admin tab, bound to any entity, and
  can buff allies or harm enemies (players), with sound in the Audio tab.
- Creature skills (slam, nova, summon, projectile) are edited in the Creature
  Behaviors tab and bound per behaviour with a `power_scale`, so the same
  skill runs at full size on a boss and scaled down on an ordinary creature.
- Each p5-descent dungeon has exactly one boss in its End room and one
  mini-boss in its Elite room, respawning after death.
- Boss loot is better for a heavier boss: tier sets roll count and rarity
  floor, level moves the rarity curve; tunable per boss in the Entities tab.

### Out of scope

- Balance and performance tuning: tested and tuned after the slices land, as
  a separate follow-up, not a per-slice gate.
- Player-skill auras (the generic aura table makes them possible later).
- Persisting boss instances to `world_creatures`.

## 2. Current state (verified 2026-10-10)

| Thing | Where | Fact |
|---|---|---|
| World boss definitions | `worldBoss.js:19` `WORLD_BOSS_CATALOG` | JS constant, not in DB |
| Boss spawn | `worldBoss.js:476` | plain object → `creatures.addCreatures` |
| Field loss | `creatures.js:1179` | `addCreatures` whitelists fields; `isWorldBoss`, `bossElement`, `name` dropped, size forced to `CREATURE_SIZE = 48` |
| Boss render | `RenderSystem.js:3206, 3339` | procedural; boss detected by `isWorldBoss` **or name substrings** |
| Phase minions | `worldBoss.js:307` | `"<ELEMENT> Elemental Guard"`, not catalog rows |
| Existing aura | `creature_behaviors.aura_*`, `computeAuras` `creatures.js:965` | ally-only buff, one per behaviour; only `Champion` uses it (r 260, ×1.25/×1.2/×1.1) |
| Creature audio slots | `audioSubjects.js:64` | `nearby, attack, hurt, death` |
| SFX priority | `sfxLimits.js` | `nearby < nearest < own`, 12 voices |
| Dungeon boss rooms | `p5-descent.map.json` | `<Dungeon>: Elite` / `: End` worlds, `allowed_creature_types` only |

## 3. Data model

### 3.1 `entity_types` (extended)

| Column | Type | Notes |
|---|---|---|
| `boss_tier` | `text NULL` | CHECK `IN ('world','dungeon_end','dungeon_elite')`; NULL = ordinary. The ONE boss flag for render, audio, HUD and spawn. |
| `element` | `text NULL` | same vocabulary as `item_types.element` |
| `auras` | `jsonb NULL` | array of `aura_effects.name`; no FK (same trade-off as `vfx`): unknown name → no-op + one log line |
| `hitbox_size` | `integer NULL` | server collision size; NULL → `CREATURE_SIZE` |
| `xp_reward` | `integer NULL` | world-boss kill XP |

Boss display size uses existing `display_width/display_height`; gold uses
`gold_min/gold_max`; description goes to `prompt`.

### 3.2 `aura_effects` (new)

| Column | Notes |
|---|---|
| `name` | unique text |
| `target_side` | `allies` \| `enemies` |
| `radius` | world units, > 0 |
| `damage_mult`, `defense_mult`, `speed_mult` | real, default 1 |
| `dot_dps`, `dot_element`, `tick_ms` | DoT; `dot_dps` 0 = none; `tick_ms` 100..5000 |
| `shape` | `ring` \| `disc` \| `particles` |
| `color`, `pulse_ms` | visual |
| `particle_count, particle_spread, particle_speed, particle_gravity, particle_lifetime_ms, particle_size` | copied from `vfx_effects` |

Stacking: the same aura from several sources → strongest value per stat
(today's `Math.max` rule). Different auras → multiply. Enemy-side results are
floored: `speed_mult ≥ 0.5`, `damage_mult ≥ 0.5`, `defense_mult ≥ 0.5`.

Migration seeds `pack_leader` from Champion's current values and binds it to
every entity whose behaviour is Champion; then drops `creature_behaviors.aura_*`.

### 3.3 `creature_skills` (new)

| Column | Notes |
|---|---|
| `name` | unique |
| `kind` | `slam` \| `nova` \| `summon` \| `projectile` |
| `cooldown_ms`, `telegraph_ms` | telegraph 0..3000 |
| `radius`, `range` | area size, cast range |
| `damage_mult`, `element` | relative to caster damage |
| `summon_entity`, `summon_count` | `summon` only |
| `vfx` | jsonb `{ telegraph, cast, impact }` → `vfx_effects.name` |

### 3.4 `creature_behaviors` (extended)

- `skills jsonb`: `[{ "skill": "<creature_skills.name>", "power_scale": 0.1..1.5 }]`.
  `power_scale` multiplies `radius`, `damage_mult` and `summon_count` (rounded,
  min 1).
- `aura_*` columns dropped (S3).

### 3.5 Map spec (S9)

Per world, optional:

```json
"boss": { "entity": "<entity_types.name>", "x": 0, "y": 0, "respawn_s": 600 }
```

`validateMapSpec` requires: `entity` names a row with `boss_tier` in
(`dungeon_end`, `dungeon_elite`); End worlds use `dungeon_end`, Elite worlds
`dungeon_elite`; the point is inside the world and walkable; `respawn_s > 0`.

### 3.6 Audio subjects

| Kind | Slots |
|---|---|
| `creature` (all) | `nearby, attack, hurt, death` |
| `creature` (rows with `boss_tier`) | + `spawn, presence, phase, enrage` |
| `aura` (new) | `loop, pulse, apply` |
| `creature_skill` (new) | `telegraph, use, hit` |

Slot availability for `creature` depends on the row's `boss_tier`; ordinary
creatures never list boss slots.

### 3.7 Boss loot

Heavier boss → better drop, on two axes: **tier** sets the floor and the
number of rolls; the boss's **level** (→ item level) moves the rarity curve
through the existing `rollRarity(itemLevel, anchors)`.

New nullable `entity_types` columns (NULL = tier default below):

| Column | Meaning |
|---|---|
| `loot_rolls` | extra item rolls on death, on top of the entity's normal drop rows |
| `loot_min_rarity` | floor: a lower roll is raised to this grade |
| `loot_rarity_bias` | 0..0.9; maps the rarity rng into `[bias, 1)` so the roll stays monotonic but skews up |
| `loot_chest` | boolean: spawn a boss chest (`world_chests`) at the death point |

Tier defaults:

| Tier | Rolls | Min rarity | Bias | Chest | Extra |
|---|---|---|---|---|---|
| `dungeon_elite` | 2 | blue | 0.2 | no | — |
| `dungeon_end` | 4 | yellow | 0.4 | yes | — |
| `world` | 3 per damaging participant | yellow | 0.5 | yes | top-3 guaranteed foxy, gold pile, Victor's Boon (kept) |

Rules:
- Item level = boss level, so a level-50 End boss outdrops a level-6 one
  inside the same tier through the existing rarity anchors.
- Rolls use the existing `rollDrops` / `rollRarity` / `rollItemInstance`
  path; the boss profile only supplies count, floor and bias.
- Dungeon boss loot goes to the killer's world as ground items (existing
  `world_items` path); world boss participant rolls keep today's
  per-player drop.
- Respawn does not reset a player's eligibility rules beyond what normal
  creatures have (no per-player lockout this epic).
- Editable in the Entities tab next to Boss tier.

### 3.8 Boss roster

World (existing stats move into rows): Ignis the Magma Colossus (fire),
Glacius the Frost Leviathan (ice), Abyssor the Voidreaver (arcane), Gorgon the
Thunder Titan (lightning); minion types Fire/Ice/Arcane/Lightning Elemental
Guard.

Dungeon (working names, editable in the Entities tab):

| Dungeon | End (`dungeon_end`) | Elite (`dungeon_elite`) |
|---|---|---|
| The Catacombs | The Bone Regent (undead) | Ossuary Warden |
| The Emberhive | The Ember Queen (fire/hive) | Cinder Matriarch |
| The Umbral Gate | The Umbral Gatekeeper (void) | Shade Herald |

Levels follow each dungeon's `level_band` upper bound (End) and midpoint+
(Elite). Elite bosses carry one aura and 1-2 skills at `power_scale` ≤ 0.6.

## 4. Runtime flow

### 4.1 Spawning

- **One hydration function** (row → creature) is shared by the chunk loader,
  the bounded spawn path, `WorldBossManager` and dungeon boss placement, so
  stats, behaviour, `vfx`, `auras`, `hitbox_size`, `boss_tier`, `element`
  arrive one way only. `addCreatures` keeps `bossTier`, `name`, `element`,
  `hitboxSize`, `auras`.
- **World bosses**: `WorldBossManager` loads `boss_tier='world'` rows (startup
  and each rotation); arena logic unchanged; phase minions hydrate from the
  Elemental Guard rows.
- **Dungeon bosses**: when a dungeon world with `boss` loads, spawn one
  instance with fixed id `boss:<worldKey>` (re-load is a no-op since
  `addCreatures` skips known ids); respawn after `respawn_s` via the existing
  respawn sweep (SOMET-309).
- Boss instances are not persisted.

### 4.2 Aura tick

`computeAuras` becomes `applyAuras(creatures, players)`, once per tick:
- allies side: buff same-faction creatures in radius (current behaviour);
- enemies side: players in radius get the stat multipliers for the tick and a
  DoT charged every `tick_ms` **through the normal damage path** (resistances,
  death);
- existing aura cap (`creatures.js:2195`) kept; distance compared squared.

Snapshot additions: creature's active aura names; player's active debuffs.

### 4.3 Skill execution

Per creature, a cooldown per bound skill. Target in `range` and off cooldown →
stop, emit `skill_telegraph {creatureId, skill, x, y, radius, telegraph_ms}`,
wait, resolve:
- `slam`/`nova`: area damage at point / around self;
- `projectile`: existing creature projectile path;
- `summon`: `addCreatures` with deterministic per-cast ids, capped per caster.

Then emit `skill_cast` / `skill_hit` on the existing creature attack event
channel. Boss events: `phase` at 66% and 33% HP (replaces the current minion
trigger), `enrage` at < 10% HP or near the lifetime limit.

### 4.4 Audio (client)

- Screen radius = half the viewport diagonal in world units, computed per
  tick on the client.
- Limiter tiers become `nearby < nearest < boss < own`. `boss` evicts
  `nearby` then `nearest`; never `own`.
- `presence`: loop while the boss is within screen radius, fade out on exit
  (world-point loop pattern). `spawn`/`phase`/`enrage`: one-shots at `boss`.
- Aura `loop`: `nearby`, or `boss` when the owner has `boss_tier`. Aura
  `apply`: plays when the local player enters an enemy aura, at `own`.
- Skill `telegraph/use/hit`: `nearest` normally, `boss` when caster is a boss.

### 4.5 Rendering

- Boss with approved art/sprite → drawn at `display_width/height`; else the
  procedural boss drawing keyed on `element`. Name-substring detection removed.
- Auras drawn beneath the entity from `aura_effects` visual fields.
- Telegraph: ground area filling over `telegraph_ms`.
- HUD: debuff icons for active enemy auras on the player.

## 5. Admin UI

- **Aura Effects tab** (`/game/auras`, next to Attack Effects,
  `adminType: 'entity'`): list + form (Target, Modifiers, Damage over time,
  Visual) + live preview canvas; "Used by" list; delete blocked while bound.
- **Creature Behaviors tab**: new Skills sub-list with CRUD; per-behaviour
  skill kit editor (add from dropdown, `power_scale` slider 0.1–1.5, preview of
  scaled radius/damage).
- **Entities tab**: Boss tier, Element, Hitbox size, XP reward, Auras
  multi-select; Boss badge on rows; "placed by" hint from seeded specs.
- **Audio tab**: boss slots on boss creature rows; new Auras and Creature
  Skills groups (registry-driven, so batches, prompt writer and misses pick
  them up); prompt context includes element, tier, description, skill kind.
- **World Boss test panel**: boss picker; trigger phase / enrage buttons.

## 6. Slices

| # | Slice | Depends on |
|---|---|---|
| S1 | Bosses as entities: columns, seed 4 world bosses + 4 minion types, shared hydration, `addCreatures` keeps boss fields, catalog-driven manager, art-or-procedural render | — |
| S2 | Extended boss sounds: boss slots, `boss` limiter tier, screen-radius presence loop, spawn/phase/enrage events | S1 |
| S3 | Aura library + Aura Effects tab + Entities aura picker; migrate Champion; drop `aura_*`; single loader | — |
| S4 | Aura gameplay vs players: enemy-side multipliers, DoT via damage path, floors, HUD debuffs | S3 |
| S5 | Aura visuals + `aura` audio kind | S3 |
| S6 | Creature skills: table, behaviour kits with `power_scale`, server execution with telegraphs, admin editing | S1 |
| S7 | Skill VFX + `creature_skill` audio kind + boss kits + scaled kits on some ordinary creatures | S2, S6 |
| S8 | Content run: art, sprites, sounds for bosses, minions, auras, skills | S1, S2, S5, S7 |
| S9 | Dungeon bosses: 6 entities, spec `boss` block + validation, placement + respawn | S1 |
| S10 | Boss loot: loot columns + tier defaults, biased rarity roll, dungeon boss drops + chest, world-boss participant rolls, Entities tab fields | S1, S9 |

Order: S1 ∥ S3 → S2, S4, S5, S6, S9 → S7, S10 → S8.

Migration timestamp ranges (the untracked `1714440660000` is taken):
S1 `1714440670000+`, S3 `1714440680000+`, S6 `1714440690000+`,
S9 `1714440700000+`, others `1714440710000+`. Re-check for collisions before
each merge.

## 7. Testing and verification

Per slice:
- **S1**: hydrate a boss row → `bossTier`, `hitboxSize`, `element` present in
  `CreatureSim` (fails on today's code); manager spawns from DB rows.
- **S2**: limiter eviction rules for `boss`; registry lists boss slots only for
  boss-tier rows.
- **S3**: golden-trace parity — Champion's buffs identical before/after;
  source guard that nothing reads `creature_behaviors.aura_*`; test that
  `applyAuras` is invoked from the tick (not just exported).
- **S4**: DoT respects resistances and fires death; floors hold under overlap.
- **S6**: cooldown, telegraph→resolve order, `power_scale`, summon cap with
  deterministic ids.
- **S9**: `validateMapSpec` rejects non-boss entity / unwalkable point, run over
  the real specs via `map_spec_fixtures`; exactly one instance after double load.
- **S10**: biased roll is monotonic (higher rng never worse) and never below
  `loot_min_rarity`; at equal rng an End boss never rolls worse than an Elite
  boss of the same level; a higher-level boss of the same tier never has a
  worse rarity distribution; dungeon End kill produces `loot_rolls` items + a
  chest.
- Every new guard is shown RED against a broken implementation first; fixtures
  do not derive expected values from the constants under test.

Browser verification per slice (required): exit fullscreen, confirm a fresh
bundle, trigger via the test panel; check art at boss size, aura ring, presence
loop starting/stopping at screen edge, debuff + HP loss inside an enemy aura,
telegraph before the slam; dungeon End/Elite: one boss, kill, respawn.

Environment rules for implementers: one git worktree per slice (never
checkout/stash in the shared checkout); one scratch DB per branch with both
`DATABASE_URL` and `TEST_DATABASE_URL` set and both specs seeded (vale-region
last); no destructive queries against the dev DB; S8 generation only while no
session is editing `backend/`.

## 8. Delivery

Each slice: own branch, PR and Plane ticket under one epic; done = merged to
`main` with tests green and browser-verified. Staging (Orange Pi) deploy once
at epic end. Balance/performance tuning is a follow-up ticket after S9.
