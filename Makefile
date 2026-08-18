.PHONY: up down build logs restart rebuild clean nuke shell-backend shell-frontend db-shell \
        engine-build engine-test engine-up engine-down engine-logs engine-shell engine-rebuild \
        redis-shell admin-password admin-password-rotate seed-catalogs seed-map \
        clear-maps list-maps list-specs reseed-map dev dev-stop dev-status \
        migrate-up migrate-status migrate-repair tunnel tunnel-stop verify-routing \
        pi-keygen pi-provision pi-deploy pi-up pi-down pi-restart pi-logs pi-status \
        pi-migrate-up pi-migrate-status pi-seed-catalogs pi-seed-map pi-reseed-map \
        pi-shell pi-db-shell pi-tunnel-url pi-reset

COMPOSE_FILE = compose/develop/docker-compose.yml
COMPOSE = docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE)

# --- Map specs -------------------------------------------------------------
# SPEC= for seed-map/reseed-map is a FILENAME STEM under backend/seeds/maps,
# not the `name` field inside the JSON (those differ), so the list is derived
# from the filenames here rather than by parsing the specs.
#
# Read on the HOST, on purpose. `make list-maps` already prints the same list
# but only via `docker compose exec backend`, so the one moment you most need
# it -- a bare `make seed-map` that just told you SPEC is required, quite
# possibly before the stack is even up -- was the one moment it could not
# answer. Guarding and listing here costs no container.
MAPS_DIR = backend/seeds/maps
SPECS = $(patsubst %.map.json,%,$(notdir $(wildcard $(MAPS_DIR)/*.map.json)))

SHOW_SPECS = echo "available specs ($(MAPS_DIR)/*.map.json):"; \
	     for s in $(SPECS); do echo "  $$s"; done; \
	     [ -n "$(SPECS)" ] || echo "  (none found -- is $(MAPS_DIR) present?)";

# Canned recipe: reject a missing or misspelled SPEC before shelling into the
# container, and always say what the valid answers are.
define require-spec
@[ -n "$(SPEC)" ] || { echo "usage: make $@ SPEC=<name>"; $(SHOW_SPECS) exit 1; }
@[ -f "$(MAPS_DIR)/$(SPEC).map.json" ] || { echo "no such spec: $(SPEC)  ($(MAPS_DIR)/$(SPEC).map.json not found)"; $(SHOW_SPECS) exit 1; }
endef

up:
	docker compose --project-directory . --env-file .env -f $(COMPOSE_FILE) up -d
	@echo
	@echo "Containers are up, but the app is NOT serving yet -- run 'make dev'."

# The frontend/backend/engine images all end in `CMD ["tail","-f","/dev/null"]`
# (compose/develop/*.Dockerfile), so `make up` gives you idle containers with the
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
# over /app/node_modules (compose/develop/docker-compose.yml) purely to stop the host
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

# --- Public tunnel (SOMET-370) ---------------------------------------------
# `make tunnel` puts the stack in TUNNEL MODE: an ngrok agent published on the
# reserved domain, plus a frontend rebuilt to speak to that public origin.
#
# The second half is the part that is easy to miss. The client calls the backend
# at an ABSOLUTE url (VITE_API_URL, ~20 call sites) and derives the authority ws
# url from it, so a remote browser left on the default would call ITS OWN
# localhost and fail at login. Tunnel mode repoints that at https://<domain>,
# which comes back through the tunnel and lands on vite's /api + /authority
# proxy (frontend/vite.config.js).
#
# Why a target instead of just reading NGROK_DOMAIN: that var lives permanently
# in .env, so anything keyed off "is it set" would drag ordinary local dev onto
# the public origin with no tunnel even running. Tunnel mode is opt-in per
# invocation, and `make tunnel-stop` puts it back.
#
# --force-recreate is load-bearing: a container's environment is fixed when it
# is CREATED, so restarting vite alone would keep serving the old origin while
# looking like it worked.
NGROK_DOMAIN := $(shell sed -n 's/^NGROK_DOMAIN=//p' .env 2>/dev/null | tail -1)

tunnel:
	@[ -n "$(NGROK_DOMAIN)" ] || { echo "NGROK_DOMAIN is not set in .env -- add your reserved ngrok domain first."; exit 1; }
	@grep -qE '^NGROK_AUTHTOKEN=.+' .env || { echo "NGROK_AUTHTOKEN is not set in .env -- get one from dashboard.ngrok.com."; exit 1; }
	@echo "==> tunnel mode: client origin https://$(NGROK_DOMAIN)"
	TUNNEL_HOST=$(NGROK_DOMAIN) VITE_API_URL=https://$(NGROK_DOMAIN) \
	  $(COMPOSE) --profile tunnel up -d --force-recreate frontend ngrok
	@$(MAKE) --no-print-directory dev
	@echo
	@echo "public URL: https://$(NGROK_DOMAIN)"
	@echo "  * OPEN TO ANYONE who has it -- registration and the admin panel included."
	@echo "  * free tier shows a warning page on first load; click 'Visit Site' once."
	@echo "  * request inspector: http://localhost:14040"
	@echo "  * close it again with 'make tunnel-stop'."

# Takes the agent offline and puts the frontend back on the localhost origin.
# Both halves matter: leaving the container on the public origin would break
# local dev the moment the tunnel is gone.
tunnel-stop:
	@$(COMPOSE) --profile tunnel rm -sf ngrok
	@echo "==> restoring local origin (http://localhost:13101)"
	$(COMPOSE) up -d --force-recreate frontend
	@$(MAKE) --no-print-directory dev

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

# `npm run migrate:up` without having to shell in first. Same reason the seed
# targets exist: the command only works from /app inside the backend container
# (that is where node_modules, the migrations directory and DATABASE_URL all
# line up), so running it from the host checkout fails in a way that looks like
# a broken migration rather than a wrong working directory.
#
# Note the dev server also applies migrations on start, so a `make dev` can get
# there first and this prints "No migrations to run!" even though the migration
# is new -- check the pgmigrations ledger, not this output, before concluding a
# migration did not run.
migrate-up:
	$(COMPOSE) exec -T backend npm run migrate:up

# What has actually run, newest first. `migrate-up` reports nothing useful once
# a migration has been applied, and the usual confusion ("Not run migration X
# is preceding Y") is an ORDERING complaint about rows in here, not a missing
# file -- read the ledger before reaching for migrate-repair.
migrate-status:
	$(COMPOSE) exec -T db psql -U user -d game_db \
	  -c "SELECT name, run_on FROM pgmigrations ORDER BY id DESC LIMIT 20;"

# The supported fix for that ordering complaint. Never pass --no-check-order to
# node-pg-migrate instead: that silences the check rather than repairing the
# ledger it is complaining about.
migrate-repair:
	$(COMPOSE) exec -T backend node scripts/repair-migration-order.js

admin-password:
	$(COMPOSE) exec -T backend node scripts/set-admin-password.js

admin-password-rotate:
	$(COMPOSE) exec -T backend node scripts/set-admin-password.js --rotate

seed-catalogs:
	$(COMPOSE) exec -T backend node scripts/seed-catalogs.js
#make seed-map SPEC=vale-region
#make seed-map SPEC=p5-descent
seed-map:
	$(require-spec)
	$(COMPOSE) exec -T backend sh -c "SPEC=$(SPEC) node scripts/seed-map.js"

clear-maps:
	$(COMPOSE) exec -T backend node scripts/clear-maps.js

# Specs plus what is currently seeded in `worlds` (needs the stack up).
list-maps:
	$(COMPOSE) exec -T backend node scripts/list-maps.js

# Just the spec names, straight off the host -- works with the stack down.
list-specs:
	@$(SHOW_SPECS)

reseed-map:
	$(require-spec)
	RESEED_SPEC=$(SPEC) $(MAKE) clear-maps
	$(MAKE) seed-catalogs
	$(MAKE) seed-map SPEC=$(SPEC)

# --- Orange Pi production stack (SOMET-423) --------------------------------
# compose/orangepi/ is the production-shaped stack: see the README's
# "Production stack (local verification)" section for how to bring it up.

# Behavioral test of compose/orangepi/caddy/Caddyfile against real throwaway
# containers -- its own network, its own stub backend, cleaned up on exit
# either way. Proves actual HTTP routing AND websocket upgrade forwarding,
# not just that the Caddyfile's text looks right (that half is
# backend/tests/orangepi_compose.test.js, which runs on every `node --test`).
# Run this after editing the Caddyfile.
verify-routing:
	bash compose/orangepi/scripts/verify-routing.sh
# --- Orange Pi remote operation (make pi-*) --------------------------------
# Operate the BOARD the way the local stack is operated. Every target is a
# single line because compose/orangepi/scripts/lib.sh holds the ssh transport
# and the step reporting; see the README's "Operating the Orange Pi" section.
#
# These targets never touch the local stack: they run compose ON THE BOARD,
# over ssh, against compose/orangepi/docker-compose.yml there. The local
# equivalents above are the ones without the pi- prefix.

# Run FIRST, before pi-provision. Generates the workstation key if absent --
# never if present -- installs its public half on the board and proves a
# password-free login actually works.
pi-keygen:
	@bash compose/orangepi/scripts/keygen.sh

# Bare board to a running, publicly reachable stack. Idempotent: a second run
# changes nothing and destroys nothing -- the data directory is never touched.
pi-provision:
	@bash compose/orangepi/scripts/provision.sh

# The update path, and what the CI deploy hook calls: reset to the branch tip,
# pull the SHA-tagged image or build on the board, migrate, restart.
pi-deploy:
	@bash compose/orangepi/scripts/deploy.sh

# --- Remote lifecycle ------------------------------------------------------
# The tunnel profile is included, so `pi-up` opens the public URL and
# `pi-down` closes it. Every one of these acts on the BOARD; the local
# equivalents are the same names without the pi- prefix.

pi-up:
	@bash compose/orangepi/scripts/remote.sh compose up -d

pi-down:
	@bash compose/orangepi/scripts/remote.sh compose down --remove-orphans

pi-restart:
	@bash compose/orangepi/scripts/remote.sh compose restart

pi-logs:
	@bash compose/orangepi/scripts/remote.sh compose logs -f --tail 200

pi-status:
	@bash compose/orangepi/scripts/status.sh

pi-tunnel-url:
	@bash compose/orangepi/scripts/remote.sh tunnel-url

# --- Remote migrations -----------------------------------------------------
# Migrations are a deploy STEP on this stack, never a side effect of the
# server booting (MIGRATE_ON_BOOT is unset in compose/orangepi). These are for
# running one by hand between deploys.

pi-migrate-up:
	@bash compose/orangepi/scripts/remote.sh backend npm run migrate:up

pi-migrate-status:
	@bash compose/orangepi/scripts/remote.sh compose exec -T db psql -U user -d game_db -c "SELECT name, run_on FROM pgmigrations ORDER BY id DESC LIMIT 20;"

# --- Remote seeding --------------------------------------------------------
# require-spec is the SAME guard the local seed targets use, so a missing or
# misspelled SPEC is rejected on the workstation, before anything reaches the
# network -- and the spec list it prints is read from the host checkout.

pi-seed-catalogs:
	@bash compose/orangepi/scripts/remote.sh backend node scripts/seed-catalogs.js

pi-seed-map:
	$(require-spec)
	@bash compose/orangepi/scripts/remote.sh backend sh -c "SPEC=$(SPEC) node scripts/seed-map.js"

pi-reseed-map:
	$(require-spec)
	@bash compose/orangepi/scripts/remote.sh backend sh -c "RESEED_SPEC=$(SPEC) node scripts/clear-maps.js"
	@bash compose/orangepi/scripts/remote.sh backend node scripts/seed-catalogs.js
	@bash compose/orangepi/scripts/remote.sh backend sh -c "SPEC=$(SPEC) node scripts/seed-map.js"

# --- Interactive -----------------------------------------------------------

pi-shell:
	@bash compose/orangepi/scripts/remote.sh shell

pi-db-shell:
	@bash compose/orangepi/scripts/remote.sh db-shell

# --- Destructive -----------------------------------------------------------
# Requires CONFIRM=<the board's address>. See compose/orangepi/scripts/reset.sh.
pi-reset:
	@bash compose/orangepi/scripts/reset.sh
