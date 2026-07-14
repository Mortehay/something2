---
name: game-netcode
description: Use when working on client↔server realtime — the WebSocket protocol, prediction/reconciliation, and AOI. The authority is being rebuilt in Node (Go frozen).
---

# Game netcode (something2)

Transport is WebSockets. The authoritative server is currently the (frozen) Go engine; it is being rebuilt in Node with the **same protocol**.

- **Protocol** (source of truth: `engine/README.md`): client→server `join {map_id}`, `move {x, y}`, `ping`; server→client `joined {player_id, map_id, tick}`, `state {tick, players[], mobs[]}`, `collision {with, id}`, `error`, `pong`. Coordinates are **world-pixel centers**.
- **Client:** `frontend/src/games/something2/src/js/net/EngineClient.js` connects with `?token=<jwt>` and exposes `onState` / `onCollision` callbacks and `sendMove(cx, cy)` (throttled ~20Hz).
- **Prediction/reconciliation:** the local player predicts movement each frame; on each server `state` the client reconciles in `core/Game.js` (`_reconcileSelf`): diff ≤ 20px trust local, ≤ 200px lerp (0.25), > 200px snap. Remote players are overwritten directly into `Game.remotePlayers`.
- **JWT:** HS256, shared secret with the backend. The Node rebuild keeps this.
- When building the Node authority, match this protocol exactly so `EngineClient.js` changes only its URL. See [[go-dev]] (reference), [[nodejs-dev]].

Related: [[js-game-dev]], [[nodejs-dev]], [[go-dev]].
