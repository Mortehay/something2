# engine

Authoritative real-time game server for **something2**.

- `cmd/engine` — entry point (HTTP/WS listener, lifecycle orchestration).
- `internal/config` — env-driven configuration.
- `internal/auth` — JWT validation middleware (HS256, shared secret with backend).
- `internal/store` — Postgres + Redis adapters.
- `internal/game` — world state, 60Hz tick loop, grid-based spatial hash collisions.
- `internal/ws` — WebSocket hub, per-connection client, JSON message protocol.
- `internal/ticker` — 5-minute batch UPSERT flush from Redis to Postgres.

## Run

From repo root:

```
make engine-up      # docker compose up -d redis db game-engine
make engine-test    # go test ./...
make engine-build   # docker build the engine image
```

Local dev (requires Go 1.22):

```
cd engine && go run ./cmd/engine
```

## Environment

See [.env](../.env) at the repo root. Required: `JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`.

## WebSocket protocol

Client connects to `ws://<host>:8080/ws?token=<jwt>` (or with `Authorization: Bearer <jwt>` header).

Client → server messages (JSON):

| type   | fields                          | description |
|--------|---------------------------------|-------------|
| join   | `{ "map_id": int }`             | enter a map |
| move   | `{ "x": float, "y": float }`    | request authoritative move |
| ping   | —                               | keepalive |

Server → client messages:

| type     | fields                                                  |
|----------|---------------------------------------------------------|
| joined   | `{ "player_id": int, "map_id": int, "tick": int }`      |
| state    | `{ "tick": int, "players": [...], "mobs": [...] }`      |
| collision| `{ "with": "player|mob", "id": int }`                   |
| error    | `{ "message": string }`                                 |
| pong     | —                                                       |
