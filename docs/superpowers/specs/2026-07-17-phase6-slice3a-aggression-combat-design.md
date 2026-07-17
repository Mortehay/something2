# Phase 6 — Slice 3a: Creature Aggression + Contact Combat

**Date:** 2026-07-17
**Epic:** SOMET-53 connected-chunked-world, Phase 6 (authoritative simulation)
**Status:** Design approved, ready for implementation plan
**Builds on:** Slice 1 (Node authority; players), Slice 2 (server-owned creatures). Specs `2026-07-16-phase6-slice1-node-authority-design.md`, `2026-07-17-phase6-slice2-server-creatures-design.md`.

## Context

Slice 2 made creatures server-owned but purely **wandering** — they roam randomly and ignore players (`CreatureSim.tick(dt, activeKeys)` only knows `this.map`, not player positions). The authority's players have position/facing/input but **no health**. This slice adds the first mob-AI + combat milestone: creatures notice and chase players, deal contact damage, and can be killed by a player melee attack; players have health and die/respawn.

Slice 3 is decomposed; this is **3a**. Deferred to later milestones: smarter pathfinding, creature respawn after death, client interpolation tuning, interest-management beyond the 3×3 ring, facing-cone melee (3b/3c).

## Goals

- Creatures detect the nearest player within an aggro radius and **chase** them server-authoritatively, leashing back to random roam when the player escapes.
- Aggro'd creatures deal **contact damage** to players (rate-limited); players have server-side hp and **die → respawn** at spawn.
- Players **melee-attack** creatures via an explicit `attack` message (server-validated, rate-limited); creatures reaching 0 hp **die** (removed + deleted from `world_creatures`).
- Clients render player HP and creature HP; attack is bound to a key.

## Locked decisions (from brainstorming)

1. First milestone = **aggression + contact combat** (not aggression-only).
2. Combat model = **creatures auto-hit on contact; player melee-attacks via an explicit `attack` action**; both have hp; player death → respawn (full hp), creature death → removed.
3. Melee is **omnidirectional** (radius around the player) this milestone; facing-cone is deferred.
4. Attack input = **spacebar** (edge-triggered on keydown; server rate-limits). No aiming.
5. **No creature respawn** after death this milestone (killed creatures stay gone; respawn is a 3c follow-up).

## Tuning constants (placeholders, centralized)

- `AGGRO_RADIUS = 400` (world px) — creature acquires the nearest player within this range.
- `LEASH_RADIUS = 800` — a chased target beyond this is dropped (back to roam).
- `CONTACT_RANGE = 60` — creature within this of its target may deal contact damage.
- `CREATURE_DAMAGE = 5`, creature `ATTACK_COOLDOWN = 1.0` s (per creature).
- `PLAYER_MAX_HP = 100` (no regen this milestone).
- `MELEE_RANGE = 90`, `PLAYER_DAMAGE = 10`, player `ATTACK_COOLDOWN = 0.5` s (per player).
- Creature hp comes from its `entity_types.hp` (already loaded/persisted; default 10).

All distances compare **center-to-center** (actor center = `x + width/2`), consistent with `resolveMove`.

## Architecture

The `World` owns both players and the `CreatureSim`, so it mediates AI + combat: creature AI reads player positions; melee reads creatures. The authority tick loop already ticks players (20 Hz) then creatures; this slice threads players into the creature tick and adds an attack handler. Broadcasts gain hp fields; a new inbound `attack` message drives player melee.

## Components

### `backend/src/authority/creatures.js` — `CreatureSim` (AI + combat)

- Creature state gains `_target` (userId or null), `mode` (`'roam'`/`'chase'`), `_attackCd` (seconds remaining), and `maxHp` (captured from the spawned/loaded `hp` at add time so the client can draw a bar).
- `tick(dt, activeChunkKeys, players)` — `players` is an array of `{ userId, x, y, width, height }` (the world's players). For each active creature:
  - **Acquire/leash:** find the nearest player (center distance) within `AGGRO_RADIUS`. If one exists → `mode='chase'`, `_target=that userId`. Else if the current `_target` is gone or beyond `LEASH_RADIUS` → `mode='roam'`, `_target=null`.
  - **Chase:** move toward the target's center via `resolveMove` (direction = normalized target-minus-self vector; facing from the vector's dominant octant). Mark dirty on move; if blocked, keep trying (no random turn while chasing).
  - **Roam:** the existing random-wander behavior (unchanged).
  - Decrement `_attackCd` by `dt` (floor 0).
- `applyContactDamage(dt, players)` — for each chasing creature within `CONTACT_RANGE` of its target whose `_attackCd <= 0`: reduce that player's `hp` by `CREATURE_DAMAGE`, set the creature's `_attackCd = ATTACK_COOLDOWN`. Returns nothing (mutates player hp). (Can be folded into `tick` after movement; kept named for clarity/testing.)
- `applyAttack(px, py, range, damage) -> string[]` — melee: for each creature within `range` of the point `(px,py)` (the attacking player's center), reduce `hp` by `damage`; collect ids whose `hp <= 0`, remove them from the sim, and return the killed ids (so the server can `DELETE` their rows). Does not require the creature to be in an active chunk beyond being loaded (it is, since it's near the player).
- `snapshotForNeighborhood(keys)` — add `maxHp` (and keep `hp`, `mode` optional) to each entry.

### `backend/src/authority/world.js` — `World` (player hp + mediation)

- `PlayerState` gains `hp` and `maxHp` (`= PLAYER_MAX_HP`); set on `addPlayer` (respawn/join → full hp). Export `PLAYER_MAX_HP`.
- `tickCreatures(dt, activeKeys)` (new) — calls `this.creatures.tick(dt, activeKeys, [...this.players.values()])` then `this.creatures.applyContactDamage(dt, [...this.players.values()])`; then resolves any player deaths: a player with `hp <= 0` respawns (position → its spawn, `hp = maxHp`). Spawn point: the world center (`chunkSize*100/2`) or the player's join spawn; store the spawn on `PlayerState` at `addPlayer` for respawn.
- `attack(userId, meleeRange, playerDamage) -> string[]` (new) — rate-limit via a per-player `_attackCd`; if ready, call `creatures.applyAttack(playerCenterX, playerCenterY, meleeRange, playerDamage)`, reset the cooldown, and return killed creature ids; else return `[]`.
- `snapshot()` — add `hp`, `maxHp` per player.

### `backend/src/authority/server.js` — wiring

- Tick loop: replace the direct `entry.world.creatures.tick(...)` call with `entry.world.tickCreatures(dt, entry.activeChunks)` (players threaded in).
- `state` broadcast: include `hp`/`maxHp` (already in `snapshot()`).
- New message handler: `case 'attack'`: `const killed = entry.world.attack(ws.userId)`; for each killed id, `DELETE FROM world_creatures WHERE id = $1` (best-effort). (`world.attack(userId)` encapsulates `MELEE_RANGE`/`PLAYER_DAMAGE`/cooldown; the creature is already removed from the in-memory sim by `applyAttack`.)
- Tuning constants are single-sourced in the sim modules (`creatures.js`/`world.js` exports); the server does not pass tuning args — it calls `world.attack(userId)` and deletes the returned killed rows.
- Persistence: killed creatures are deleted (above). Creature flush (Slice 2) is unchanged for survivors. Player hp is transient (not persisted).

### `backend/src/authority/consts.js` (optional) or inline

Centralize the tuning constants (aggro/leash/contact/damage/cooldowns/hp/melee) so tests and the sim share exact values. May live in `creatures.js`/`world.js` exports rather than a new file — implementer's call, but the values must be single-sourced.

### Client — `WorldAuthorityClient.js`

- `sendAttack()` — sends `{ type: 'attack' }` (no throttle needed; server rate-limits, but a light client guard is fine).

### Client — `Game.js` / `Player.js`

- **Attack input:** in the keydown handler, when the attack key (spacebar) goes down and chunked mode is active, call `this.authorityClient.sendAttack()` (edge-triggered — fire on the keydown transition, not every frame while held).
- **Player hp:** `_onWorldState` reads the local player's `hp`/`maxHp` from `state` and sets `this.player.hp`/`this.player.maxHp`; remote players carry `hp`/`maxHp` in `this.remotePlayers`.
- **Respawn:** no special handling — when the server respawns the player (hp→full, position→spawn), the authoritative `state` position flows through the existing reconciliation and the client snaps to the respawn point (the `_inputBuffer` replay is harmless; optionally clear it on a large position delta).

### Client — `RenderSystem.js`

- Draw a **player HP bar** (HUD or above the player) from `player.hp`/`player.maxHp`.
- Draw **creature HP bars** above creatures whose `hp < maxHp` (from the `creatures` snapshot; `CreatureManager` stores `hp`/`maxHp`).
- Optionally tint/indicate a chasing creature (from `mode`) — nice-to-have.

### Client — `CreatureManager.js`

- `applySnapshot` already upserts creatures; ensure `hp` and `maxHp` (and optional `mode`) are stored for the HP bar.

## Protocol

- Client → server: new `{ type: 'attack' }`.
- Server → client:
  - `state` (20 Hz): players now `{ id, x, y, facing, hp, maxHp }`.
  - `creatures` (~5 Hz): entries now `{ id, type, x, y, facing, hp, maxHp, color[, mode] }`.

Anti-cheat: the attack is intent-only; the server owns range, cooldown, and damage. Contact damage is fully server-computed. Player hp is never client-set.

## Data model

No schema change. `world_creatures` rows for killed creatures are `DELETE`d. `entity_types.hp` already provides creature max hp. Player hp is in-memory only.

## Error handling

- `attack` before join / with no player → ignored.
- A chased target disconnecting mid-chase → target dropped next tick (leash/gone check), creature returns to roam.
- Creature killed while its flush is in flight → `applyAttack` removes it from the sim; the DELETE is best-effort; a racing UPDATE for a just-deleted row is a harmless no-op.
- Player hp underflow is clamped at death handling (respawn sets full hp).

## Testing

Backend (`node --test`):
- `CreatureSim`: acquires the nearest in-radius player and chases toward it (position moves closer); drops target beyond `LEASH_RADIUS` (back to roam); `applyContactDamage` reduces target hp only within `CONTACT_RANGE` and respects `ATTACK_COOLDOWN`; `applyAttack` reduces hp of in-range creatures, removes + returns those at ≤0 hp, ignores out-of-range.
- `World`: `tickCreatures` threads players and applies contact damage; a player at ≤0 hp respawns at spawn with full hp; `attack` respects the per-player cooldown and returns killed ids; `snapshot` includes hp/maxHp.
- `server` integration (ws + fakePool): a player adjacent to an aggro'd creature sees its `state.hp` drop over ticks; sending `attack` next to a creature removes it from a later `creatures` message and issues a `DELETE`; a player taking lethal damage respawns (position jumps to spawn, hp restored) in a later `state`.

Frontend (Vitest):
- `WorldAuthorityClient.sendAttack` sends `{type:'attack'}`.
- `CreatureManager.applySnapshot` stores `hp`/`maxHp`.
- (HP-bar rendering is verified by build + browser, consistent with the untested render layer.)

## Global constraints

- Server owns all combat: range, cooldowns, damage, death, respawn. Client sends input/attack intent only; never positions or hp.
- Reuse `resolveMove`/`ServerMap` for chase movement — no new collision math. Reuse Slice-2 creature lifecycle (activation/AOI/flush); dead creatures are removed, not respawned.
- Tuning constants are single-sourced and shared between the sim and its tests.
- Distances are center-to-center.
- The 20 Hz `state` and ~5 Hz `creatures` cadences are unchanged; only their payloads gain hp fields plus the new inbound `attack` message.
- Player authority movement/prediction/reconciliation (Slice 1) is unchanged except for the additive hp fields and respawn-via-position-snap.

## Out of scope (→ 3b/3c)

Creature respawn after death; ranged/weapon variety; facing-cone or aimed melee; player hp regen/persistence; XP/loot; smarter pathfinding (A*); interpolation/AOI tuning; death animations/effects.
