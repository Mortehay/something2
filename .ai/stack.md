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
- pg 8
- node-pg-migrate 6
- minio 7
- dotenv 16
- nodemon (dev)

## Engine — [engine/](engine/)

- Go (target language; sources not yet committed)
- Websocket server: live game state transport, client ↔ engine
- Reads/writes Postgres for durable state and Redis for live state
- Authoritative for collisions, pathfinding, mob/NPC AI

## Infra — [compose/docker-compose.yml](compose/docker-compose.yml)

- Postgres — db `game_db`, user `user` (compose default)
- Redis — planned for live runtime state (**not yet in compose**)
- MinIO — asset storage
- Docker Compose orchestrates db + backend + frontend (+ minio) for dev

## Port convention

External (host) ports use a `1xxxx` prefix to avoid clashes with other dev projects on the same machine. Internal (container) ports are unchanged.

| Service  | Host  | Container |
|----------|-------|-----------|
| frontend | 15173 | 5173      |
| backend  | 13101 | 3101      |
| db       | 15432 | 5432      |
| minio    | 19000 | 9000      |
| minio UI | 19001 | 9001      |

Backend defaults to `process.env.PORT \|\| 3101` ([backend/src/index.js](backend/src/index.js)) — that's the **internal** port. The frontend hits `http://localhost:13101` ([compose/docker-compose.yml](compose/docker-compose.yml) `VITE_API_URL`) — that's the **host-mapped** port. They look mismatched but aren't.
