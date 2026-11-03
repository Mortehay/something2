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
- `make seed` (or `make seed-all`) — run all seed targets in order (AI provider templates, catalogs, passive tree, quests, art, audio, and starter map)
- `make seed-catalogs` — seed catalog rows (tiles, biomes, decorations, creatures, loot, classes)
- `make seed-passive-tree` — seed passive skill tree (supports `FORCE=1`)
- `make seed-quests` — seed storyline quests
- `make art-seed` — seed committed textures into MinIO + catalog rows
- `make audio-seed` — seed committed audio clips into MinIO + bindings
- `make seed-map SPEC=<name>` — seed a specific map (e.g. `SPEC=vale-region`)

## Backend — [backend/](backend/)

- `npm start` — `node src/index.js`
- `npm run dev` — `nodemon src/index.js --inspect`
- `npm run migrate` — `node-pg-migrate`
- `npm run migrate:up` — apply pending migrations
- Migrations live in [backend/migrations/](backend/migrations/)
- `node scripts/repair-migration-order.js [--prune-stale] [--apply]` — fix a `pgmigrations` ledger that disagrees with the files (`make migrate-repair`); `--prune-stale` also drops the old name of a renumbered migration whose new name is recorded too
- `make test-clean [ARGS="tests/x.test.js"]` — the backend suite against a throwaway database built from nothing (every migration, then the DB-only seeds) by [backend/scripts/testdb.js](backend/scripts/testdb.js); `make test-db-reset` / `make test-db-drop` manage it by hand
- **After editing backend code, check the dev server restarted.** nodemon does not see file changes through the Windows bind mount, so the server can keep running old code while the client (vite, which does reload) already speaks the new protocol — the server ignores unknown message types silently. `make dev` restarts it.

## Frontend — [frontend/](frontend/)

- `make skills-sync` / `make skills-check` — regenerate / verify the client's skill catalog (`skillsCatalog.generated.js`), which is GENERATED from [backend/seeds/data/skills.js](backend/seeds/data/skills.js); never edit it by hand
- `make enchant-cost` — expected gold/scrolls to enchant a fresh weapon to each level (odds, both scroll prices, burn-and-restart), for tuning the economy

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
