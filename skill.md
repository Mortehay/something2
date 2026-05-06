Project Architecture & Tooling:

Infrastructure: Docker Compose for multi-container orchestration.

Automation: GNU Make for cross-service builds and migrations.

Engine (Go): gorilla/websocket, pgx (Postgres driver), go-redis.

Backend (Node.js): Existing logic for Auth, Account Management, and non-real-time API.

Inter-service: Shared JWT Secret for Auth; Redis for real-time state synchronization.