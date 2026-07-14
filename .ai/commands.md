# Commands

## Dev stack — root [Makefile](Makefile)

- `make up` — start db + backend + frontend (docker compose, detached)
- `make down` — stop and remove containers
- `make build` — build images
- `make rebuild` — down + build + up
- `make restart` — down + up
- `make logs` — tail logs (`-f`)
- `make clean` — down with volumes and images removed
- `make shell-backend` — exec `sh` in backend container
- `make shell-frontend` — exec `sh` in frontend container
- `make db-shell` — psql into `game_db` as user `user`
- `make redis-shell` — `redis-cli` into the redis container

## Backend — [backend/](backend/)

- `npm start` — `node src/index.js`
- `npm run dev` — `nodemon src/index.js --inspect`
- `npm run migrate` — `node-pg-migrate`
- `npm run migrate:up` — apply pending migrations
- Migrations live in [backend/migrations/](backend/migrations/)

## Frontend — [frontend/](frontend/)

- `npm run dev` — vite dev server
- `npm run build` — production build
- `npm run lint` — eslint (flat config: [frontend/eslint.config.js](frontend/eslint.config.js))
- `npm run preview` — serve the production build locally

## Engine — [engine/](engine/)

Docker (from repo root):

- `make engine-up` — start db + redis + game-engine
- `make engine-down` — stop game-engine
- `make engine-build` — build the engine image
- `make engine-rebuild` — build + up
- `make engine-logs` — tail engine logs (`-f`)
- `make engine-shell` — exec `sh` in engine container
- `make engine-test` — `cd engine && go test ./...`

Local dev (Go 1.22):

- `cd engine && go run ./cmd/engine`
- `cd engine && go test ./...`
- `cd engine && go vet ./...`
- `cd engine && go mod tidy`

Engine WebSocket: `ws://localhost:18080/ws?token=<jwt>`. Protocol reference: [engine/README.md](engine/README.md).
