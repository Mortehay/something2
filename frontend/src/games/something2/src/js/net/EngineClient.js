/**
 * EngineClient — thin wrapper around the WebSocket connection to the Go engine.
 *
 * Wire protocol mirrors engine/internal/ws/protocol.go:
 *   client → server: {type: "join"|"move"|"ping", ...}
 *   server → client: {type: "joined"|"state"|"collision"|"error"|"pong", ...}
 *
 * Concurrency model: outbound `move` is throttled to ~20Hz so the 60Hz render
 * loop doesn't flood the socket. Inbound `state` ticks fire onState — the
 * caller (Game) decides how to reconcile.
 *
 * Auth: caller passes a token getter (we fetch /api/dev-token in callers).
 * No auto-reconnect for now: surface errors via onError and let the caller
 * decide the policy.
 */

const DEFAULT_MOVE_INTERVAL_MS = 50; // 20Hz

export class EngineClient {
  constructor({ url, token, onJoined, onState, onCollision, onError, onClose, moveIntervalMs }) {
    this.url = url;
    this.token = token;
    this.onJoined = onJoined || (() => {});
    this.onState = onState || (() => {});
    this.onCollision = onCollision || (() => {});
    this.onError = onError || ((err) => console.error("EngineClient error:", err));
    this.onClose = onClose || (() => {});
    this.moveIntervalMs = moveIntervalMs ?? DEFAULT_MOVE_INTERVAL_MS;

    this.ws = null;
    this.connected = false;
    this.joined = false;
    this.mapId = null;
    this._lastMoveSentAt = 0;
    this._pendingMove = null;
  }

  connect(mapId) {
    this.mapId = mapId;
    const sep = this.url.includes("?") ? "&" : "?";
    const wsUrl = `${this.url}${sep}token=${encodeURIComponent(this.token)}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.addEventListener("open", () => {
      this.connected = true;
      this._send({ type: "join", map_id: mapId });
    });

    this.ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "joined":
          this.joined = true;
          this.onJoined(msg);
          break;
        case "state":
          this.onState(msg);
          break;
        case "collision":
          this.onCollision(msg);
          break;
        case "error":
          this.onError(new Error(msg.message || "engine error"));
          break;
        case "pong":
          break;
        default:
          // Unknown message type — log but don't crash.
          console.warn("EngineClient: unknown msg type", msg.type);
      }
    });

    this.ws.addEventListener("error", () => {
      this.onError(new Error("websocket error"));
    });

    this.ws.addEventListener("close", (event) => {
      this.connected = false;
      this.joined = false;
      this.onClose(event);
    });
  }

  /**
   * Throttled move push. Call this every frame; it'll only actually send at
   * the configured cadence. The most recent (x, y) wins.
   */
  sendMove(x, y) {
    if (!this.connected) return;
    this._pendingMove = { x, y };
    const now = performance.now();
    if (now - this._lastMoveSentAt >= this.moveIntervalMs) {
      this._flushMove(now);
    }
  }

  _flushMove(now) {
    if (!this._pendingMove) return;
    this._send({ type: "move", x: this._pendingMove.x, y: this._pendingMove.y });
    this._lastMoveSentAt = now;
    this._pendingMove = null;
  }

  ping() {
    this._send({ type: "ping" });
  }

  disconnect() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (err) {
        // Already closed — fine.
        void err;
      }
      this.ws = null;
    }
    this.connected = false;
    this.joined = false;
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }
}

/**
 * Fetches a dev JWT from the backend. Replace with a real auth flow later.
 */
export async function fetchDevToken(apiUrl, userId) {
  const qs = userId != null ? `?user_id=${encodeURIComponent(userId)}` : "";
  const res = await fetch(`${apiUrl}/api/dev-token${qs}`);
  if (!res.ok) throw new Error(`dev-token: HTTP ${res.status}`);
  return res.json();
}
