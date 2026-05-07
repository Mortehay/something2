# Project context

**something2** is a real-time 2D MMORPG.

## What it is

- Multiple players share the same map(s) live.
- A Go game engine will be the authoritative server for the live world: collision detection, NPC/mob pathfinding, and NPC/mob aggression behavior.
- Transport between engine and clients: websockets.
- Durable state (players, world data, accounts): Postgres.
- Live runtime state: Redis.
- Asset storage: MinIO.

## Architecture (three layers)

1. **Go authoritative server — planned.** Lives under [engine/](../engine/). Currently only `bin/`; sources not yet committed. Will own collisions, pathfinding, and mob AI, and will hold the canonical world state in Redis.
2. **JS client-side renderer — exists.** Substantial in-browser game under [frontend/src/games/something2/src/js/](../frontend/src/games/something2/src/js/) — `Game.js`, `Map.js`, `Camera.js`, `RenderSystem.js`, `Entity.js`, `Player.js`, etc. This is the rendering / input loop the player sees. It does **not** own authoritative state — once the Go engine is in place, the client should read from it.
3. **Express REST API — exists.** [backend/src/index.js](../backend/src/index.js) provides content/admin endpoints: maps, tile types, entity types, WFC map generation, entity spawn generation. Not realtime — sits next to the realtime engine, not in front of it.

Frontend pages mount the JS game from `frontend/src/games/something2/Something2.jsx` and admin UIs from `EntityTypesAdmin.jsx` / `TileTypesAdmin.jsx`.

## Goals of the Go engine

1. Collision detection.
2. Pathfinding for mobs / NPCs.
3. Mob / NPC aggression behavior.
4. Multi-player shared-world play (many players on the same map).

## Current state (2026-05-07)

- Backend Express API is real (maps + tile-types + entity-types CRUD + WFC generation). No auth.
- Frontend client-side game has core loop, map rendering, entities, camera. Recent work: Player + Entity classes wired to db, basic enter/exit world flow.
- Redis is part of the planned stack but **not yet wired into [compose/docker-compose.yml](../compose/docker-compose.yml)**.
- Go engine is empty (`engine/bin/` only).

## Things to avoid

Not defined yet. Add here as constraints surface (e.g. "engine is authoritative for X — don't duplicate logic in backend", "don't run migrations against prod from a dev container").
