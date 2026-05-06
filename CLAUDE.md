Maintenance Commands:

make build-engine: Compile the Go binary.

make engine-logs: Stream logs from the engine container.

make dev: Spin up all services (Node, Go, DBs).

Project Standards:

Docker: All new engine dependencies must be reflected in ./compose/docker-compose.yml.

Migrations: Database schema changes should still be managed by the primary Node.js backend (Prisma/TypeORM) to maintain a single source of truth for the DB.

Environment: Use a shared .env file at the root for DB credentials and JWT secrets.