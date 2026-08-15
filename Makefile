.PHONY: up down build logs restart rebuild clean nuke shell-backend shell-frontend db-shell \
        engine-build engine-test engine-up engine-down engine-logs engine-shell engine-rebuild \
        redis-shell admin-password admin-password-rotate seed-catalogs seed-map \
        clear-maps list-maps reseed-map dev dev-stop dev-status

COMPOSE_FILE = compose/docker-compose.yml
COMPOSE = docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE)

up:
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) up -d
	@echo
	@echo "Containers are up, but the app is NOT serving yet -- run 'make dev'."

# The frontend/backend/engine images all end in `CMD ["tail","-f","/dev/null"]`
# (compose/*.Dockerfile), so `make up` gives you idle containers with the
# source bind-mounted and nothing listening on :15173 or :13101. That is
# deliberate -- it lets you restart a dev server without bouncing the
# container -- but the "now start the servers" half was never written down or
# scripted, so it was done by hand and silently lost on every `make up`,
# `make restart` and `make rebuild`. These three targets are that half.
dev:
	@echo "==> syncing dependencies (self-heals a stale node_modules volume)"
	$(COMPOSE) exec -T backend npm install --no-audit --no-fund
	$(COMPOSE) exec -T frontend npm install --no-audit --no-fund
	@echo "==> starting dev servers"
	@$(MAKE) --no-print-directory dev-stop
	$(COMPOSE) exec -d backend npm run dev
	$(COMPOSE) exec -d frontend npm run dev -- --host 0.0.0.0 --port 5173
	@echo
	@echo "frontend: http://localhost:15173    backend: http://localhost:13101"
	@echo "check with 'make dev-status', follow output with 'make logs'."

# `npm install` above is not busywork. Both services mount an ANONYMOUS volume
# over /app/node_modules (compose/docker-compose.yml) purely to stop the host
# checkout's node_modules from shadowing the image's. An anonymous volume is
# populated once, when it is first created, and then survives `docker compose
# build` and `up` untouched -- so adding a dependency to package.json and
# rebuilding leaves the container running against the OLD tree. That is not
# hypothetical: react-cytoscapejs, cytoscape and cytoscape-edgehandles were
# all declared in frontend/package.json and all missing from the volume,
# which fails at import time as a blank World Map tab rather than anything
# that names a missing package.

dev-stop:
	@$(COMPOSE) exec -T backend sh -c 'pkill -f "nodemon src/index.js" || true' 2>/dev/null || true
	@$(COMPOSE) exec -T frontend sh -c 'pkill -f "[v]ite" || true' 2>/dev/null || true

# Reports what is actually LISTENING, not what make thinks it started: an
# `exec -d` that dies a second later still exits 0, so a started-successfully
# message from `make dev` proves nothing on its own.
dev-status:
	@printf 'backend  :13101  '; c=$$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:13101/api/health 2>/dev/null); [ "$$c" = "000" ] && echo "DOWN (nothing listening)" || echo "HTTP $$c"
	@printf 'frontend :15173  '; c=$$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:15173/ 2>/dev/null); [ "$$c" = "000" ] && echo "DOWN (nothing listening)" || echo "HTTP $$c"

down:
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) down --remove-orphans

build:
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) build

logs:
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) logs -f

restart:
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) down && docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) up -d

rebuild:
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) down
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) build
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) up -d

clean:
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) down --rmi all --remove-orphans

# Destructive: also deletes the named volumes (postgres_data, redis_data,
# minio_data, sprite-models) -- the local Postgres DB (maps/entities/users/
# inventory) and every MinIO-stored sprite/tile. `clean` above deliberately
# does NOT do this (F-042/SOMET-222): a developer running `make clean`
# expecting the same kind of tidy-up as `down`/`restart`/`rebuild` (none of
# which touch volumes) should not silently lose all local game state. Use
# this only when you actually want to wipe local data and start over.
nuke:
	@echo "This deletes ALL local data: Postgres DB, MinIO sprites/tiles, sprite-gen model cache."
	@read -p "Type 'yes' to confirm: " confirm && [ "$$confirm" = "yes" ] || (echo "Aborted."; exit 1)
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) down -v --rmi all --remove-orphans

shell-backend:
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) exec backend sh

shell-frontend:
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) exec frontend sh

db-shell:
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) exec db psql -U user -d game_db

redis-shell:
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) exec redis redis-cli

# --- Engine ----------------------------------------------------------------

engine-build:
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) build game-engine

engine-test:
	cd engine && go test ./...

engine-up:
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) up -d redis db game-engine

engine-down:
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) stop game-engine

engine-rebuild:
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) build game-engine
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) up -d game-engine

engine-logs:
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) logs -f game-engine

engine-shell:
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) exec game-engine sh

# --- Admin -----------------------------------------------------------------
# Runs scripts inside the running backend container.

admin-password:
	$(COMPOSE) exec -T backend node scripts/set-admin-password.js

admin-password-rotate:
	$(COMPOSE) exec -T backend node scripts/set-admin-password.js --rotate

seed-catalogs:
	$(COMPOSE) exec -T backend node scripts/seed-catalogs.js

seed-map:
	@[ -n "$(SPEC)" ] || (echo "usage: make seed-map SPEC=<name>  (see: make list-maps)"; exit 1)
	$(COMPOSE) exec -T backend sh -c "SPEC=$(SPEC) node scripts/seed-map.js"

clear-maps:
	$(COMPOSE) exec -T backend node scripts/clear-maps.js

list-maps:
	$(COMPOSE) exec -T backend node scripts/list-maps.js

reseed-map:
	@[ -n "$(SPEC)" ] || (echo "usage: make reseed-map SPEC=<name>  (see: make list-maps)"; exit 1)
	$(COMPOSE) exec -T backend sh -c "test -f seeds/maps/$(SPEC).map.json" || (echo "no such spec: backend/seeds/maps/$(SPEC).map.json  (see: make list-maps)"; exit 1)
	RESEED_SPEC=$(SPEC) $(MAKE) clear-maps
	$(MAKE) seed-catalogs
	$(MAKE) seed-map SPEC=$(SPEC)