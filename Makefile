.PHONY: up down build logs restart rebuild clean nuke shell-backend shell-frontend db-shell \
        engine-build engine-test engine-up engine-down engine-logs engine-shell engine-rebuild \
        redis-shell admin-password admin-password-rotate seed-catalogs seed-map seed-passive-tree \
        tiles-generate tiles-export tiles-seamless tiles-seed \
        entities-generate entities-export entities-cutout entities-seed \
        clear-maps list-maps list-specs reseed-map dev dev-stop dev-status \
        migrate-up migrate-status migrate-repair tunnel tunnel-stop verify-routing \
        pi-keygen pi-provision pi-deploy pi-up pi-down pi-restart pi-logs pi-status \
        pi-migrate-up pi-migrate-status pi-seed-catalogs pi-seed-map pi-reseed-map \
        pi-shell pi-db-shell pi-tunnel-url pi-hook-secret pi-hook-register \
        pi-publish-url pi-reconcile pi-watch-install pi-watch-uninstall pi-reset \
        pi-backup pi-backup-status pi-restore pi-backup-install pi-backup-uninstall

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
	-@$(COMPOSE) exec -T backend pkill -f "nodemon src/index.js"
	-@$(COMPOSE) exec -T frontend pkill -f "vite"

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

# --- Tile textures -------------------------------------------------------
#
# Three targets, in the order you use them. The first needs an AI provider and
# the GPU it points at; the other two need neither, which is the whole point.
#
#   make tiles-generate PROVIDER="desktop gpu"
#       Pin every tile to that provider, give each one a biome art context if
#       it has none, and draw the textures that are missing. Idempotent: an
#       already-textured tile is skipped unless FORCE=1. Add ONLY=grass,sand to
#       limit it, DRY=1 to see what it would do.
#   make tiles-export
#       Copy the generated PNGs out of MinIO into seeds/textures/tiles/ so they
#       can be committed.
#   make tiles-seed
#       Replay those committed PNGs into MinIO on a machine that has no GPU,
#       and point the catalog at them. FORCE=1 overwrites local art.
#
# PROVIDER accepts the provider's name or its id; omit it to use whichever
# provider is active in Settings.
tiles-generate:
	$(COMPOSE) exec -T backend node scripts/generate-tile-textures.js \
		$(if $(PROVIDER),--provider "$(PROVIDER)") $(if $(FORCE),--force) \
		$(if $(ONLY),--only "$(ONLY)") $(if $(DRY),--dry-run) $(if $(NOPIN),--no-pin) $(if $(NOBIOME),--no-biome)

tiles-export:
	$(COMPOSE) exec -T backend node scripts/export-tile-textures.js

# Make the exported textures tile against themselves. Runs on the HOST (needs
# Pillow), not in a container, because no service image carries an image
# library and adding one to shrink a seed asset is a poor trade.
#
# Order matters: generate -> export -> seamless -> seed. CHECK=1 measures the
# seam score without writing (0 is perfect); PREVIEW=grass writes a 2x2 tiling
# to /tmp so a seam is visible if one survives.
tiles-seamless:
	python3 tools/make-tiles-seamless.py $(if $(CHECK),--check) $(if $(PREVIEW),--preview "$(PREVIEW)") \
		$(if $(REPEAT),--repeat $(REPEAT),--repeat 2) $(if $(FORCE),--force)

tiles-seed:
	$(COMPOSE) exec -T backend node scripts/seed-tile-textures.js $(if $(FORCE),--force)

# --- Entity art ----------------------------------------------------------
#
# The same four steps for props and creatures, with one swap: tiles are ground
# and get made seamless, entities are silhouettes and get their backdrop cut
# out instead. Skipping entities-cutout ships every prop inside an opaque white
# square, so entities-seed refuses art that has not been through it.
#
#   make entities-generate PROVIDER="desktop gpu" OBJECTS=1   # 11 props first
#   make entities-export
#   make entities-cutout
#   make entities-seed
#
# OBJECTS=1 limits the run to world props; CREATURES=1 to the bestiary (293 of
# them). Same PROVIDER/FORCE/ONLY/DRY/NOPIN as the tile target. Each entity
# gets ONE STILL -- directional walk sets remain a sprite-gen job.
#
# LOCAL=1 generates through the in-compose sprite-gen service instead of a
# remote provider, and for entities that is usually what you want. The remote
# SDXL + pixel-art model draws ground textures beautifully and refuses to draw
# an isolated object: ask it for one tree and it returns a tileset of trees or
# a framed gallery card on a checkered backdrop, which no cutout can rescue.
# sprite-gen asks for an isolated subject on a flat field and keys the
# background out itself, so its output arrives already transparent and needs
# no entities-cutout pass. It is sd-turbo on CPU -- about a minute an entity
# against the remote's five seconds.
entities-generate:
	$(COMPOSE) exec -T backend node scripts/generate-entity-textures.js \
		$(if $(PROVIDER),--provider "$(PROVIDER)") $(if $(FORCE),--force) \
		$(if $(ONLY),--only "$(ONLY)") $(if $(DRY),--dry-run) $(if $(NOPIN),--no-pin) \
		$(if $(OBJECTS),--objects-only) $(if $(CREATURES),--creatures-only) $(if $(LOCAL),--local)

entities-export:
	$(COMPOSE) exec -T backend node scripts/export-entity-textures.js

entities-cutout:
	python3 tools/cutout-entity-textures.py $(if $(CHECK),--check) $(if $(FORCE),--force)

entities-seed:
	$(COMPOSE) exec -T backend node scripts/seed-entity-textures.js $(if $(FORCE),--force)
# Regenerate the passive tree and upsert it. Safe to re-run: nodes are upserted
# by their stable generated key, never deleted, so no character_passives row is
# ever orphaned. An admin's edited kind/label/grants survive a plain run --
# pass FORCE=1 to overwrite them from the checked-in spec.
#
#   make seed-passive-tree
#   make seed-passive-tree FORCE=1
seed-passive-tree:
	$(COMPOSE) exec -T backend node scripts/seed-passive-tree.js $(if $(FORCE),--force,)
#make seed-map SPEC=vale-region
#make seed-map SPEC=p5-descent
seed-map:
	$(require-spec)
	$(COMPOSE) exec -T backend sh -c "SPEC=$(SPEC) node scripts/seed-map.js"

clear-maps:
	$(COMPOSE) exec backend node scripts/clear-maps.js

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

# The GAME containers only. Restarting cloudflared would take a new random
# trycloudflare hostname -- changing the URL players hold and invalidating
# the deploy hook's registered URL -- for no benefit, since the tunnel
# reconnects to the replacement Caddy by name. `pi-down` + `pi-up` is the
# full cycle when that is genuinely what you want.
pi-restart:
	@bash compose/orangepi/scripts/remote.sh compose restart backend caddy

pi-logs:
	@bash compose/orangepi/scripts/remote.sh compose logs -f --tail 200

pi-status:
	@bash compose/orangepi/scripts/status.sh

pi-tunnel-url:
	@bash compose/orangepi/scripts/remote.sh tunnel-url

# The board's deploy-hook secret, generated on the board by provisioning.
pi-hook-secret:
	@bash compose/orangepi/scripts/remote.sh hook-secret

# Point GitHub Actions at this board: sets DEPLOY_HOOK_SECRET and
# DEPLOY_HOOK_URL. Re-run after a tunnel restart -- a quick tunnel's hostname
# changes every time.
pi-hook-register:
	@bash compose/orangepi/scripts/hook-register.sh

# Publish a stable address for players that forwards to the board's current
# tunnel hostname, so a reboot does not invalidate every link you handed out.
# Runs from THIS machine, using its gh credentials -- the board holds none.
pi-publish-url:
	@bash compose/orangepi/scripts/publish-url.sh

# One idempotent pass: if the board's tunnel hostname has moved, repair the
# published page and the CI hook URL. Silent when there is nothing to do.
pi-reconcile:
	@bash compose/orangepi/scripts/reconcile-url.sh

# Run that on a timer, so a hostname change after a board reboot heals itself.
# A systemd USER timer -- no root, no new secrets.
pi-watch-install:
	@bash compose/orangepi/scripts/watch-install.sh install

pi-watch-uninstall:
	@bash compose/orangepi/scripts/watch-install.sh uninstall

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

# --- Backups (SOMET-400) ---------------------------------------------------
#
# A PULL, from here. The board never needs a credential for this machine, and
# nothing has to reach inward: it is the same ssh path every other pi-* target
# already uses, in the direction it already goes.

pi-backup:
	@bash compose/orangepi/scripts/backup.sh

# Age and content, not merely presence -- a directory full of three-week-old
# dumps looks healthy in a listing and is exactly the failure this guards.
# Non-zero when stale, so it can gate a deploy or drive an alert.
pi-backup-status:
	@bash compose/orangepi/scripts/backup.sh --status

pi-backup-install:
	@bash compose/orangepi/scripts/backup-install.sh install

pi-backup-uninstall:
	@bash compose/orangepi/scripts/backup-install.sh uninstall

# DUMP= a file from the backup directory. Restoring onto the board replaces
# live data and refuses without the explicit flag; --into-local DB= is the safe
# way to inspect a dump first, and is the path the tests exercise.
pi-restore:
	$(if $(DUMP),,$(error DUMP=<file.sql.gz> is required. See: make pi-backup-status))
	@bash compose/orangepi/scripts/restore.sh "$(DUMP)" $(if $(DB),--into-local "$(DB)",--into-board --yes-really-replace-live-data)

pi-shell:
	@bash compose/orangepi/scripts/remote.sh shell

pi-db-shell:
	@bash compose/orangepi/scripts/remote.sh db-shell

# --- Destructive -----------------------------------------------------------
# Requires CONFIRM=<the board's address>. See compose/orangepi/scripts/reset.sh.
pi-reset:
	@bash compose/orangepi/scripts/reset.sh
