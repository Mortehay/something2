.PHONY: up down build logs restart clean shell-backend shell-frontend

COMPOSE_FILE = compose/docker-compose.yml

up:
	docker compose -f $(COMPOSE_FILE) up -d

down:
	docker compose -f $(COMPOSE_FILE) down --remove-orphans

build:
	docker compose -f $(COMPOSE_FILE) build

logs:
	docker compose -f $(COMPOSE_FILE) logs -f

restart:
	docker compose -f $(COMPOSE_FILE) down && docker compose -f $(COMPOSE_FILE) up -d

rebuild:
	docker compose -f $(COMPOSE_FILE) down
	docker compose -f $(COMPOSE_FILE) build
	docker compose -f $(COMPOSE_FILE) up -d

clean:
	docker compose -f $(COMPOSE_FILE) down -v --rmi all --remove-orphans

shell-backend:
	docker compose -f $(COMPOSE_FILE) exec backend sh

shell-frontend:
	docker compose -f $(COMPOSE_FILE) exec frontend sh

db-shell:
	docker compose -f $(COMPOSE_FILE) exec db psql -U user -d game_db
