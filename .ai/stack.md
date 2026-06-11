# Stack

Source of truth for each piece is the linked config file. Update those, then update this file.

## Frontend — [frontend/package.json](frontend/package.json)

- Vite 8, React 19
- styled-components 6
- react-router-dom 7
- @tanstack/react-query-devtools 5
- react-hot-toast, react-icons, react-error-boundary
- ESLint 10 (flat config: [frontend/eslint.config.js](frontend/eslint.config.js))

## Backend — [backend/package.json](backend/package.json)

- Express 4
- cors 2
- pg 8
- node-pg-migrate 6
- minio 7
- dotenv 16
- nodemon (dev)

## Engine — [engine/](engine/)

- Go 1.22 — see [engine/go.mod](engine/go.mod)
- WebSocket hub: live game state transport, client ↔ engine; JWT-authed (HS256, shared secret with backend)
- Postgres for durable state, Redis for live state; 5-min batch flush Redis → Postgres
- Authoritative for collisions (grid spatial hash), pathfinding, mob/NPC AI; 60Hz tick loop
- Local dev and full layout: [engine/README.md](engine/README.md)

## Infra — [compose/docker-compose.yml](compose/docker-compose.yml)

- Postgres — db `game_db`, user `user` (compose default), host port 15432
- Redis — live runtime state for the engine, image `redis:7-alpine`, host port 16379
- MinIO — asset storage
- Docker Compose orchestrates frontend + backend + game-engine + db + redis + minio for dev
- Required env: `JWT_SECRET` (engine refuses to start without it; shared secret with backend) — see [.env](.env) and [engine/README.md](engine/README.md)

## Port convention

External (host) ports use a `1xxxx` prefix to avoid clashes with other dev projects on the same machine. Internal (container) ports are unchanged.

| Service  | Host  | Container |
|----------|-------|-----------|
| frontend | 15173 | 5173      |
| backend  | 13101 | 3101      |
| engine   | 18080 | 8080      |
| db       | 15432 | 5432      |
| redis    | 16379 | 6379      |
| minio    | 19000 | 9000      |
| minio UI | 19001 | 9001      |

Backend defaults to `process.env.PORT \|\| 3101` ([backend/src/index.js](backend/src/index.js)) — that's the **internal** port. The frontend hits `http://localhost:13101` ([compose/docker-compose.yml](compose/docker-compose.yml) `VITE_API_URL`) — that's the **host-mapped** port. They look mismatched but aren't.
