# Phase 6 — Slice 3b-1: Combat Engine + Aiming + Projectiles

**Date:** 2026-07-18
**Epic:** SOMET-53 connected-chunked-world, Phase 6 (authoritative simulation)
**Status:** Design approved, ready for implementation plan
**Builds on:** Slice 1 (authoritative players), Slice 2 (server creatures), Slice 3a (aggression + contact combat + player hp/death/respawn), authority-hardening batch.

## Context

Combat today (Slice 3a) is a single hardcoded attack: omnidirectional melee, `MELEE_RANGE=90`, `PLAYER_DAMAGE=10`, `PLAYER_ATTACK_COOLDOWN=0.5`, driven by the spacebar; creatures deal contact damage. Players have hp/death/respawn. There is latent, unused scaffolding — `entity_types` carries `mana`/`max_mana`/`mana_regen_rate`, and the client `Entity`/`Player` carry `weapons=[]` and six stats — none of it wired into the authority.

This slice replaces the hardcoded attack with a **data-driven weapon engine** that unifies every weapon type the epic targets (close→long melee, bows/arbalests/slings/darts, staves, magic) into **two server resolution paths**: melee **reach + arc** hitscan, and traveling **projectiles** (ranged and magic share the projectile path — a fireball and an arrow differ only in data). It adds **mouse 360° aiming** and **PvP** (attacks hit other players, not just creatures).

This is the **foundation** sub-slice (3b-1) of a decomposed foundation:
- **3b-1 (this doc):** combat engine + aiming + projectiles + minimal mana, proven with 4 representative weapons and a number-key weapon-switch stand-in.
- **3b-2 (later):** inventory + equipment + `weapon_types` editor + persistence; equip UI replaces the number-key stand-in.
- **3b-3 (later):** full weapon catalog content, mana economy, magic elements/status/AoE, ammo.

## Goals

- A `weapon_types` catalog (data) seeded with 4 representative weapons: **dagger** (close/narrow melee), **halberd** (long/wide melee sweep), **bow** (fast projectile), **magic-bolt** (mana-gated projectile).
- Server resolves attacks by weapon `kind`: **melee** → reach+arc hitscan hitting all valid targets in the cone; **projectile** → spawns a server-simulated projectile.
- **Projectiles** are simulated server-side: travel along the aim vector, collide with terrain (walls block), creatures, and players; respect `pierce` and `range`; broadcast to clients for render.
- **Mouse 360° aiming**: client sends a normalized aim vector with each attack (left-click). Server owns all damage/range/cooldown/mana/collision/death.
- **PvP**: melee and projectiles damage creatures **and** other players (owner excluded from own projectiles). Existing player death/respawn applies.
- **Minimal mana**: players have a mana pool that regenerates; the magic-bolt path deducts `mana_cost` and is gated when mana is insufficient.
- A **number-key weapon switch** (1–4) among the seeded weapons stands in for inventory so all four kinds are exercisable this slice.
- Clients render projectiles (magic tinted by element), a brief melee swing, an HP bar (existing), and a mana bar + current weapon name.

## Locked decisions (from brainstorming)

1. Aiming = **mouse free-aim (360°)**; left-click attacks in the cursor direction. Replaces the Slice-3a spacebar melee.
2. Scope = **full engine + 4 representative weapons** (both resolution paths, incl. a mana-gated magic bolt).
3. Weapon acquisition this slice = **number-key switch among the seeded catalog** (real inventory/equipment is 3b-2). The `weapon_types` catalog table is created now.
4. **PvP on** — attacks hit other players too; owner excluded from their own projectiles.
5. Slice ordering = engine (3b-1) → inventory (3b-2) → magic depth (3b-3).
6. Creatures keep **contact damage** this slice (weaponized/ranged creatures deferred to a later slice).
7. Mana this slice = **pool + regen + cost** only; elements/schools/status effects deferred to 3b-3.

## Tuning constants (placeholders, single-sourced)

Per-player (constants in `world.js`, alongside the existing `PLAYER_*`):
- `PLAYER_MAX_MANA = 100`, `PLAYER_MANA_REGEN = 10` (per second, no overflow past max).

Seeded weapons (`weapon_types` rows, via migration; center-to-center distances in world px, angles in radians, cooldown/seconds):

| name | kind | damage | cooldown | reach | arc_width | range | proj_speed | proj_radius | pierce | mana_cost | element |
|------|------|--------|----------|-------|-----------|-------|------------|-------------|--------|-----------|---------|
| dagger | melee | 8 | 0.30 | 80 | 0.6 | — | — | — | — | 0 | — |
| halberd | melee | 18 | 0.90 | 190 | 1.8 | — | — | — | — | 0 | — |
| bow | projectile | 12 | 0.60 | 700 | — | 700 | 900 | 8 | 1 | 0 | — |
| magic-bolt | projectile | 14 | 0.70 | 600 | — | 600 | 700 | 12 | 1 | 15 | arcane |

`arc_width` is the **full** cone angle: a target at angle θ from the aim vector is hit iff `|θ| <= arc_width/2`. Dagger 0.6 rad (~34°) hits ~one target ahead; halberd 1.8 rad (~103°) sweeps a wide frontal arc.

All distances compare **center-to-center** (`x + width/2`), consistent with Slice 3a.

## Architecture

The `World` owns players, the `CreatureSim`, and now a `ProjectileSim`, plus the loaded `weapon_types` catalog. An attack message carries an aim vector; `World.attack(userId, ax, ay)` looks up the player's equipped weapon and dispatches to the melee-arc resolver or spawns a projectile. Projectiles advance each tick and resolve collisions against terrain + creatures + players. Player deaths from any source (contact, melee, projectile) are resolved once per tick. The 20 Hz `state` broadcast gains per-player `mana`/`maxMana` and a world-level `projectiles` array; a new inbound `equip` message switches the active weapon.

## Components

### `backend/migrations/<ts>_create_weapon_types.js` — catalog + seed

New table `weapon_types`:
- `id serial primary key`, `name text unique not null`, `kind text not null check (kind in ('melee','projectile'))`,
- `damage real not null`, `cooldown real not null`,
- `reach real`, `arc_width real` (melee; null for projectile),
- `range real`, `projectile_speed real`, `projectile_radius real`, `pierce int` (projectile; null for melee),
- `mana_cost real not null default 0`, `element text`, `icon text`,
- timestamps.

Seed the 4 rows from the table above (idempotent `INSERT ... ON CONFLICT (name) DO NOTHING`). The seed also defines a **default weapon** by name (`dagger`).

### `backend/src/authority/weapons.js` — catalog helpers (new, pure)

- `loadWeaponTypes(pool) -> Map<id, weapon>` — `SELECT * FROM weapon_types` into a Map keyed by id (and a name→id index for the default/seed lookup). Each `weapon` is a plain object with the fields above (numbers coerced).
- `DEFAULT_WEAPON_NAME = 'dagger'`.
- Pure geometry helpers reused by resolution and tests:
  - `normalizeAim(ax, ay, fallbackFacing) -> { nx, ny }` — normalize `(ax,ay)`; if zero-length, derive a unit vector from the player's 8-way `facing` string (so a keyboard-only attack still fires forward).
  - `inArc(originX, originY, nx, ny, targetX, targetY, reach, arcWidth) -> boolean` — true iff the target center is within `reach` (center distance) AND the angle between the aim vector and the origin→target vector is `<= arcWidth/2`.

### `backend/src/authority/projectiles.js` — `ProjectileSim` (new)

- State: `this.projectiles = []` (array of `{ id, ownerId, x, y, vx, vy, remaining, damage, radius, pierceLeft, element, hitIds:Set }`).
- `spawn({ ownerId, x, y, nx, ny, weapon }) -> id` — push a projectile with `vx=nx*projectile_speed`, `vy=ny*projectile_speed`, `remaining=range`, `radius=projectile_radius`, `pierceLeft=pierce`, `damage`, `element`. `id` is a per-sim incrementing counter (string) — projectiles are transient in-memory only, never persisted (no DB, no `Math.random`).
- `step(dt, { creatures, players, map }) -> { killedCreatureIds: string[] }` — for each projectile, in order:
  1. Advance: `dx=vx*dt, dy=vy*dt`; `x+=dx; y+=dy`; `remaining -= hypot(dx,dy)`.
  2. **Terrain:** if `!map.isWalkable(x, y)` → mark for removal (walls stop projectiles), skip to next.
  3. **Targets:** test creatures then players. For each candidate not in `hitIds` and not the owner (players only; the owner cannot be hit by their own projectile), if center distance `<= radius + targetHalf` (targetHalf = target.width/2): apply `damage` (creature via the sim's hp; player via `player.hp -= damage`), add its id to `hitIds`, decrement `pierceLeft`. If the creature died, collect its id for deletion + remove from the creature sim. If `pierceLeft < 0` → mark for removal and stop testing this projectile.
  4. **Expiry:** if `remaining <= 0` → mark for removal.
  - Remove all marked projectiles. Return killed creature ids (so the server can `DELETE`).
- `snapshot() -> [{ id, x, y, element }]` — for the client render (position + element only; velocity/damage stay server-side).

Creature damage is applied through a small `CreatureSim` method rather than reaching into creature internals — see below.

### `backend/src/authority/creatures.js` — arc + point damage entry points

The existing `applyAttack(px, py, range, damage)` is a radius test. Add:
- `applyMeleeArc(originX, originY, nx, ny, reach, arcWidth, damage) -> string[]` — like `applyAttack` but uses `inArc` (from `weapons.js`) instead of a bare radius; reduces hp of every creature in the cone, removes + returns those at `<= 0` hp. (Replaces the radius-only melee for creatures.)
- `damageCreatureById(id, damage) -> boolean` — reduce one creature's hp by `damage`, remove it if `<= 0`, return `true` if it died. Used by `ProjectileSim` so projectile collision code doesn't duplicate creature bookkeeping.
- `hitTestCreatures(x, y, radius) -> string[]` — creature ids whose center is within `radius + creatureHalf` of `(x,y)`, in a stable order (used by projectile collision to find candidates). (May be folded into `ProjectileSim` iterating the creature list via a read accessor; implementer's call, but creature removal must go through `damageCreatureById`.)

Keep `applyAttack` if any test still references it, or migrate those tests to `applyMeleeArc`. `snapshotForNeighborhood`, roam, aggro, and contact damage are unchanged.

### `backend/src/authority/world.js` — weapon dispatch + mana + projectiles + death resolution

- Constants: add `PLAYER_MAX_MANA = 100`, `PLAYER_MANA_REGEN = 10`. Keep `PLAYER_*` from Slice 3a; `MELEE_RANGE`/`PLAYER_DAMAGE`/`PLAYER_ATTACK_COOLDOWN` become **fallback/default-weapon** values only (the dagger seed matches the design table, not these — the weapon is the source of truth now).
- `World` constructor takes the weapon catalog: `new World(map, weaponsById, defaultWeaponId)`; `this.projectiles = new ProjectileSim()`.
- `PlayerState` gains `mana`, `maxMana` (`=PLAYER_MAX_MANA`), `weaponId` (`=defaultWeaponId` on join).
- `setWeapon(userId, weaponId)` — if `weaponId` is a known catalog id, set `p.weaponId`; else ignore.
- `tick(dt)` — after the existing move/cooldown, regenerate mana: `p.mana = min(p.maxMana, p.mana + PLAYER_MANA_REGEN*dt)`.
- `attack(userId, ax, ay) -> { killedCreatureIds: string[] }`:
  - Reject if no player or `_attackCd > 0`.
  - `w = this.weapons.get(p.weaponId)`; if missing, use the default.
  - `{ nx, ny } = normalizeAim(ax, ay, p.facing)`; update `p.facing` from `(nx,ny)` so the attack faces the aim.
  - **melee:** `killed = creatures.applyMeleeArc(cx, cy, nx, ny, w.reach, w.arc_width, w.damage)`; also damage **other players** in the arc (`inArc` per other player; `other.hp -= w.damage`). Set `_attackCd = w.cooldown`. Return `{ killedCreatureIds: killed }`.
  - **projectile:** if `p.mana < w.mana_cost` → return `{ killedCreatureIds: [] }` (attack denied; no cooldown consumed, so the client can retry when mana is back). Else `p.mana -= w.mana_cost`, `projectiles.spawn({ ownerId: userId, x: cx, y: cy, nx, ny, weapon: w })`, `_attackCd = w.cooldown`, return `{ killedCreatureIds: [] }`.
- `tickProjectiles(dt) -> string[]` — `return this.projectiles.step(dt, { creatures: this.creatures, players: [...this.players.values()], map: this.map }).killedCreatureIds`.
- `resolveDeaths()` — new single place that respawns any player with `hp <= 0` (pos→spawn, hp→maxHp, **mana→maxMana**). Called once per tick after all damage. `tickCreatures` no longer respawns (it calls contact damage only); the server tick calls `resolveDeaths()` after creatures + projectiles.
- `snapshot()` — per player add `mana`, `maxMana`, and `weaponId` (so the client HUD shows the current weapon + mana). Add a top-level `projectiles: this.projectiles.snapshot()`.

### `backend/src/authority/server.js` — wiring

- `loadWorld`: after loading `creatureTypes`, `const { map: weaponsById, defaultId } = await loadWeapons(pool)` (a thin wrapper returning the catalog Map + default weapon id); construct `new World(map, weaponsById, defaultId)`.
- Tick loop: after `tickCreatures`, call `const killedByProjectiles = entry.world.tickProjectiles(dt)` and `DELETE FROM world_creatures WHERE id=$1` for each; then `entry.world.resolveDeaths()`; then build the `state` snapshot (now includes `projectiles`, `mana`, `weaponId`). Ordering: move → creatures(contact) → projectiles → resolveDeaths → broadcast (so all same-tick damage is reflected before respawn and before the client sees it).
- `attack` message: read `ax`/`ay` from the message; `const { killedCreatureIds } = entry.world.attack(ws.userId, msg.ax, msg.ay)`; `DELETE` each killed id (as today).
- New `equip` message: `entry.world.setWeapon(ws.userId, msg.weaponId)`.
- Broadcast: `state` payload gains `projectiles` (world-level; not AOI-filtered this slice — worlds are small; AOI-filtering projectiles is a 3b-3 optimization).

### Client — `net/WorldAuthorityClient.js`

- `sendAttack(ax, ay)` → `{ type: 'attack', ax, ay }` (edge-triggered on click; server cooldown throttles).
- `sendEquip(weaponId)` → `{ type: 'equip', weaponId }`.
- Dispatch `state.projectiles`, per-player `mana`/`maxMana`/`weaponId` (extend the existing `state` handler).

### Client — `core/Game.js` + aim math

- **Mouse aim:** track the latest cursor position (canvas `mousemove`). On left-click (`mousedown`, `button===0`) in `playing`+`chunked`, compute the **world-space aim vector**: convert the cursor screen offset (cursor − player screen position) to a world-space direction via the **inverse of the iso projection's linear part** (the iso transform is linear + camera translation; direction ignores translation), normalize, and `authorityClient.sendAttack(nx, ny)`. Provide the inverse mapping from the same constants `RenderSystem` uses for `worldToScreen` (document the exact formula in the plan).
- **Weapon switch:** number keys `1`–`4` map to the seeded weapon ids (fetched once, or a fixed name→key map) → `authorityClient.sendEquip(weaponId)`. (Stand-in for inventory; removed in 3b-2.)
- **State handling:** `_onWorldState` stores local `mana`/`maxMana`/`weaponId` and a **projectile store** from `state.projectiles`; remote players already carry hp; add mana if shown.
- **Projectile store:** a light client-side map id→{x,y,element,prevX,prevY} updated from each `state`, interpolated between broadcasts for smooth motion (mirrors `CreatureManager.interpolate`).
- Remove the Slice-3a spacebar attack (superseded by click). Keep the `playing`+`chunked` guards.

### Client — `systems/RenderSystem.js`

- Draw **projectiles** depth-sorted with entities: a small circle/diamond, tinted by `element` (arcane = a magic color; null = a neutral arrow color).
- Draw a brief **melee swing** arc on local attack (client-side feedback keyed off the click; reach+arc from the current weapon) — nice-to-have, keep minimal.
- HUD: add a **mana bar** below the HP bar and the **current weapon name**. Existing HP bar unchanged.

### Client — projectile render store

Either a tiny `entities/ProjectileManager.js` (mirrors `CreatureManager`: `applySnapshot(list)` + `interpolate(dt)`) or inline in `Game`. A dedicated module is cleaner and testable — recommended.

## Protocol

- Client → server:
  - `{ type: 'attack', ax, ay }` — aim vector (server normalizes; falls back to facing if zero).
  - `{ type: 'equip', weaponId }` — switch active weapon.
- Server → client:
  - `state` (20 Hz): players now `{ id, x, y, facing, hp, maxHp, mana, maxMana, weaponId }`; plus top-level `projectiles: [{ id, x, y, element }]`.
  - `creatures` (~5 Hz): unchanged.

Anti-cheat: attack + aim are intent-only. The server owns weapon stats, damage, range, cooldown, mana, collision, projectile motion, and death. The client never sets positions, hp, mana, or damage. `equip` is validated against the catalog.

## Data model

- New `weapon_types` catalog (migration + seed). Read once per world load.
- Projectiles are **in-memory only** (transient; never persisted).
- Player `weaponId`/`mana` are **in-memory** this slice (equip + mana are not persisted; persistence is 3b-2). Player hp remains transient (Slice 3a).
- Creature rows: killed-by-projectile/melee creatures are `DELETE`d (as Slice 3a). No schema change to `world_creatures`.

## Error handling

- `attack`/`equip` before join, or with an unknown `weaponId` → ignored (equip keeps the current weapon).
- Zero/near-zero aim vector → falls back to the player's facing direction (never a NaN velocity).
- Projectile insufficient mana → attack denied, no cooldown consumed, no projectile spawned.
- Projectile owner disconnecting mid-flight → the projectile keeps flying (owner id just won't match any player; harmless) and expires normally; owner-exclusion simply never triggers.
- A creature killed by a projectile while its flush is in flight → removed from the sim by `damageCreatureById`; the `DELETE` is best-effort; a racing `UPDATE` for a deleted row is a no-op (as Slice 3a).
- Player killed by PvP damage → `resolveDeaths()` respawns at spawn with full hp+mana next tick (same as creature death).
- Two projectiles / melee killing the same creature the same tick → `damageCreatureById` returns `true` only for the first; the id is collected once (guard against double-DELETE by deduping the killed-id list per tick).

## Testing

Backend (`node --test`):
- `weapons.js`: `normalizeAim` normalizes a vector and falls back to facing on zero; `inArc` true inside reach+arc, false outside reach, false outside the angular cone; a wide arc includes a target a narrow arc excludes.
- `weapons.js` catalog: `loadWeaponTypes` maps rows by id and resolves the default by name (via `__setPool` mock).
- `ProjectileSim`: `spawn` sets velocity from aim×speed and `remaining=range`; `step` advances position, decrements range, despawns on `remaining<=0`; despawns on an unwalkable tile (stub map); hits a creature in range (returns its killed id, removes it) and a player in range (reduces hp), never the owner; respects `pierce` (a pierce-1 projectile despawns after the first hit; pierce-2 hits two); never re-hits the same target (`hitIds`).
- `World`: `attack` with a melee weapon hits creatures **and** other players in the arc; `attack` with a projectile weapon spawns a projectile and deducts mana; a projectile attack with insufficient mana spawns nothing and consumes no cooldown; mana regenerates in `tick` up to max; `tickProjectiles` returns killed creature ids; `resolveDeaths` respawns a player at `hp<=0` with full hp+mana; `snapshot` includes mana/maxMana/weaponId per player and a top-level projectiles array; `setWeapon` ignores unknown ids.
- `server` integration (ws + fakePool with a seeded weapon_types query): an `attack` with a projectile weapon makes a projectile appear in a later `state.projectiles`; a melee `attack` next to a creature removes it and issues a `DELETE`; two players — one shooting a projectile through the other — reduces the target's `state.hp`; an `equip` message changes the player's `weaponId` in a later `state`.

Frontend (Vitest):
- `WorldAuthorityClient.sendAttack(ax,ay)` sends `{type:'attack',ax,ay}`; `sendEquip` sends `{type:'equip',weaponId}`; the `state` handler surfaces `projectiles` + `mana`/`weaponId`.
- The screen→world aim conversion util returns the correct world-space unit vector for known iso constants (pure function, unit-tested).
- `ProjectileManager.applySnapshot`/`interpolate` store + interpolate projectiles.
- (HP/mana bars, projectile/swing rendering, and mouse wiring are verified by build + live browser, consistent with the untested render layer.)

## Global constraints

- Server owns all combat: weapon stats, damage, range, arc, cooldown, mana, collision, projectile motion, death, respawn. Client sends attack intent + aim vector + equip selection only — never positions, hp, mana, or damage.
- Weapons are **data** (`weapon_types`); exactly **two** resolution paths (melee arc, projectile). No per-weapon code.
- Reuse `ServerMap` for projectile terrain collision and the existing world tick; creature removal goes through `CreatureSim.damageCreatureById`/`applyMeleeArc` (no duplicated creature bookkeeping in the projectile code).
- PvP: the damageable target set = creatures ∪ other players; a projectile never hits its owner.
- Distances are center-to-center; `arc_width` is the full cone angle (`|θ| <= arc_width/2`).
- Aim is client-provided and normalized server-side; a zero vector falls back to the player's facing.
- Mana never exceeds `maxMana`; a magic attack below `mana_cost` is denied without consuming cooldown.
- The 20 Hz `state` / ~5 Hz `creatures` cadences are unchanged; `state` gains mana/weaponId/projectiles fields plus the new inbound `attack`(with aim)/`equip` messages. The Slice-3a spacebar attack is replaced by left-click.
- Creatures still deal contact damage only (unchanged); they do not use weapons this slice.

## Out of scope (→ 3b-2 / 3b-3)

Inventory, equipment slots, weapon pickups, and `weaponId`/mana persistence; the `weapon_types` admin editor; the full weapon catalog content (all daggers→halberds, bows/arbalests/slings/darts, staff variety); mana-economy tuning; magic elements/schools/status effects/AoE; ammunition; weaponized/ranged creatures; AOI-filtering of projectiles; kill credit / XP / loot; off-hand / dual-wield; per-player stat scaling (`strength`/`dexterity`/multipliers) into damage.
