# something2

Real-time 2D MMORPG. Go game engine over websockets (collisions, pathfinding, mob AI), Node + Express backend, Vite + React client, Postgres + Redis + MinIO.

## Quickstart

```
make up        # start db + backend + frontend
make logs      # tail logs
make db-shell  # psql into game_db
make down      # stop everything
```

## Layout

- `backend/` — Node + Express REST API, Postgres persistence
- `frontend/` — Vite + React 19 client
- `engine/` — Go game engine (websocket server) — scaffold only for now
- `compose/` — Docker Compose dev stack

## More

- [AGENTS.md](AGENTS.md) — index for AI agents and humans alike
- [.ai/context.md](.ai/context.md) — project context
- [.ai/commands.md](.ai/commands.md) — full command reference
- [.ai/stack.md](.ai/stack.md) — tech stack details
