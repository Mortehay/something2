.PHONY: up down build logs restart rebuild clean shell-backend shell-frontend db-shell \
        engine-build engine-test engine-up engine-down engine-logs engine-shell engine-rebuild \
        redis-shell admin-password admin-password-rotate

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
