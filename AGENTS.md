# something2 — Agent Index

Real-time 2D MMORPG. Shared maps with multiple live players. Go game engine handles collisions, pathfinding, and mob/NPC aggression. Postgres for durable state, Redis for live state, websockets for transport.

Claude and Codex follow the same rules. This file is the source of truth for both. Tool-specific config (when added) lives in `.claude/` or `.codex/`.

## Layout

- [backend/](backend/) — Node + Express REST API, Postgres persistence, MinIO. See [backend/package.json](backend/package.json).
- [frontend/](frontend/) — Vite + React 19 client. See [frontend/package.json](frontend/package.json).
- [engine/](engine/) — Go game engine: JWT-authed WebSocket hub, 60Hz tick loop, grid-based collisions, Postgres + Redis stores, 5-min batch flush. See [engine/README.md](engine/README.md).
- [compose/](compose/) — Docker Compose dev stack: frontend, backend, game-engine, db, redis, minio.

## Project context

- [.ai/context.md](.ai/context.md) — what this project is and what the engine is for
- [.ai/commands.md](.ai/commands.md) — make / npm / engine commands
- [.ai/stack.md](.ai/stack.md) — versions, services, infra, port convention
- [.ai/styleguides/frontend.md](.ai/styleguides/frontend.md) — React + styled-components + TanStack Query patterns
- [.ai/styleguides/backend.md](.ai/styleguides/backend.md) — Express + pg patterns
- `.ai/decisions/` — architecture decisions go here (created as needed)

## Quick start

```
make up        # start db + backend + frontend
make logs      # tail logs
make db-shell  # psql into game_db
make down      # stop everything
```

Full command list: [.ai/commands.md](.ai/commands.md).
