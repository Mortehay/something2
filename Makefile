.PHONY: up down build logs restart rebuild clean nuke shell-backend shell-frontend db-shell \
        engine-build engine-test engine-up engine-down engine-logs engine-shell engine-rebuild \
        redis-shell admin-password admin-password-rotate seed-catalogs seed-map \
        clear-maps list-maps reseed-map

COMPOSE_FILE = compose/docker-compose.yml

up:
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) up -d

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
# Runs on the host so the script parses .env with the same dotenv the backend
# and node-pg-migrate use; the db port is published on localhost per .env.

# Push the ADMIN_USERNAME/ADMIN_PASSWORD already in .env into the users table.
admin-password:
	node backend/scripts/set-admin-password.js

# Generate a fresh random password, write it to .env, then apply it.
admin-password-rotate:
	node backend/scripts/set-admin-password.js --rotate

# Upsert the tile / biome / decoration catalogs. Idempotent and NON-destructive:
# it never deletes, so a tile or biome added by hand in the admin UI survives.
seed-catalogs:
	node backend/scripts/seed-catalogs.js

# Apply one map spec from backend/seeds/maps/<SPEC>.map.json. Idempotent:
# re-running an unchanged spec is a no-op. Validates before writing anything.
seed-map:
	@[ -n "$(SPEC)" ] || (echo "usage: make seed-map SPEC=<name>  (see: make list-maps)"; exit 1)
	SPEC=$(SPEC) node backend/scripts/seed-map.js

# Destructive. Deletes every world and everything cascading from it -- including
# player_binds, every player's respawn point. Catalogs and inventory survive.
clear-maps:
	node backend/scripts/clear-maps.js

# What specs exist, and what is currently in the database.
list-maps:
	node backend/scripts/list-maps.js

# Full reset to one spec: clear, re-seed the catalogs, apply the map.
#
# NOT written as `reseed-map: clear-maps seed-catalogs seed-map` -- make runs
# prerequisites to completion in order, so clear-maps would finish (destroying
# every world) before seed-map's own "SPEC is required" guard ever ran,
# leaving a bare database on a plain `make reseed-map`. The guards below run
# first, as this target's own recipe lines, before anything destructive.
#
# Two guards, not one: non-empty SPEC alone is not enough -- `make reseed-map
# SPEC=hub-val` (typo) has a non-empty SPEC, would sail past that check, run
# clear-maps to completion, and only THEN have seed-map discover the spec
# file does not exist. That leaves an empty `worlds` table and no map applied.
# Checking the file exists here, before clear-maps runs, is what actually
# prevents the data loss -- seed-map's own existsSync check is too late to
# help once this target is the one calling it.
#
# RESEED_SPEC (not SPEC) is passed through to clear-maps so it can name what
# is about to be applied in its confirmation prompt, without the standalone
# `make clear-maps` path (where RESEED_SPEC is unset) changing at all.
reseed-map:
	@[ -n "$(SPEC)" ] || (echo "usage: make reseed-map SPEC=<name>  (see: make list-maps)"; exit 1)
	@[ -f backend/seeds/maps/$(SPEC).map.json ] || (echo "no such spec: backend/seeds/maps/$(SPEC).map.json  (see: make list-maps)"; exit 1)
	RESEED_SPEC=$(SPEC) $(MAKE) clear-maps
	$(MAKE) seed-catalogs
	$(MAKE) seed-map SPEC=$(SPEC)
