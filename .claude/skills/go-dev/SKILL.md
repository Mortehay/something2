---
name: go-dev
description: Use before touching anything in engine/ — the Go engine is PAUSED. Read this first; do not do new Go work without an explicit decision to un-pause.
---

# Go engine — PAUSED ⏸️

> **The Go engine (`engine/`) is frozen as reference.** Its realtime-authority role is being rebuilt fresh in Node (`realtime/`, a separate future sub-project). Do **not** add features, refactor, or "improve" the Go code. Do not delete it either — it is the reference for the Node port.

If a task seems to require Go changes, stop and confirm the pause is being lifted.

What the engine is (for reference only):
- Entry point `engine/cmd/engine`, config `engine/internal/config`, JWT auth `engine/internal/auth` (HS256, shared secret with backend), stores `engine/internal/store` (Postgres + Redis), world/tick/collision `engine/internal/game`, WebSocket hub `engine/internal/ws`, 5-min flush `engine/internal/ticker`.
- WebSocket protocol is documented in `engine/README.md` — the Node rebuild must match it. See [[game-netcode]].

Build/test commands (only if the pause is lifted): `make engine-test`, `cd engine && go test ./...`.
