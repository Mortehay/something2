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

// ---------------------------------------------------------------------------
// Real auth: register / login against /api/auth, plus token storage helpers.
// The dev-token takeover primitive is retired (it minted a fresh anonymous
// user on every page load — SOMET-97). These functions are deliberately pure
// (no DOM) so they can be unit-tested in the node vitest env; the login FORM
// itself is verified by the build + browser pass.
// ---------------------------------------------------------------------------

const TOKEN_KEY = "something2.authToken";

// In-memory copy so a running session doesn't re-read localStorage on every
// use, and so the token survives even where localStorage is unavailable
// (private-mode quotas, etc.). localStorage is the source of truth ACROSS a
// reload; memory is the fast path within a session.
let memoryToken = null;

function storage() {
  try {
    return typeof globalThis !== "undefined" && globalThis.localStorage
      ? globalThis.localStorage
      : null;
  } catch {
    // Accessing localStorage can throw (sandboxed iframes, disabled storage).
    return null;
  }
}

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  if (typeof atob === "function") return atob(b64);
  // Node (vitest) fallback.
  return Buffer.from(b64, "base64").toString("binary");
}

// Decode a JWT's payload without verifying the signature (verification is the
// server's job). Returns the claims object, or null if the token is malformed.
export function parseJwt(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(b64urlDecode(parts[1]));
  } catch {
    return null;
  }
}

// A token is expired if it has no numeric `exp`, or `exp` is at/behind now.
// nowSec is injectable so tests don't depend on the wall clock.
export function isTokenExpired(token, nowSec = Date.now() / 1000) {
  const payload = parseJwt(token);
  if (!payload || typeof payload.exp !== "number") return true;
  return payload.exp <= nowSec;
}

export function storeToken(token) {
  memoryToken = token || null;
  const s = storage();
  if (s && token) {
    try { s.setItem(TOKEN_KEY, token); } catch { /* storage full/blocked: memory still holds it */ }
  }
}

export function clearToken() {
  memoryToken = null;
  const s = storage();
  if (s) {
    try { s.removeItem(TOKEN_KEY); } catch { /* best-effort */ }
  }
}

// Returns a stored token that still parses as unexpired, or null. An expired
// (or malformed) token is CLEARED as a side effect so a reload doesn't keep
// retrying a dead token. This is the SOMET-97 fix: a valid token survives the
// reload instead of minting a brand-new identity.
export function getStoredToken(nowSec = Date.now() / 1000) {
  const s = storage();
  let stored = memoryToken;
  if (!stored && s) {
    try { stored = s.getItem(TOKEN_KEY); } catch { stored = null; }
  }
  if (!stored) return null;
  if (isTokenExpired(stored, nowSec)) {
    clearToken();
    return null;
  }
  memoryToken = stored;
  return stored;
}

async function postAuth(apiUrl, path, username, password) {
  const res = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data; // { token, user }
}

// Both return { token, user }. Callers store the token via storeToken().
export function register(apiUrl, username, password) {
  return postAuth(apiUrl, "/api/auth/register", username, password);
}
export function login(apiUrl, username, password) {
  return postAuth(apiUrl, "/api/auth/login", username, password);
}
