import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  storeToken, clearToken, getStoredToken, noteAuthFailure, apiFetch, AUTH_EXPIRED_EVENT,
} from "../EngineClient.js";

// A token that is well-formed and NOT expired — the shape that broke things.
// getStoredToken() only rejects expired/malformed tokens, so a REVOKED one
// (valid signature, stale token_version) sails through every client-side check
// and the app keeps acting signed-in while the server 401s every write.
function liveToken(claims = {}) {
  const body = { user_id: 1, username: "admin", role: "admin", tv: 2,
                 exp: Math.floor(Date.now() / 1000) + 3600, ...claims };
  return `h.${Buffer.from(JSON.stringify(body)).toString("base64")}.sig`;
}

describe("dead-token handling", () => {
  beforeEach(() => {
    clearToken();
    storeToken(liveToken());
  });
  afterEach(() => { vi.unstubAllGlobals(); clearToken(); });

  it("a revoked token still looks valid to the client on its own", () => {
    // Precisely why a server round-trip is required to detect revocation.
    expect(getStoredToken()).not.toBeNull();
  });

  it("clears the token on a 401", () => {
    noteAuthFailure({ status: 401 });
    expect(getStoredToken()).toBeNull();
  });

  it("fires the auth-expired event on a 401", () => {
    // vitest runs in the node environment, so stub the DOM seam the browser
    // provides; the UI listens for exactly this event to drop to sign-in.
    const dispatch = vi.fn();
    vi.stubGlobal("CustomEvent", class { constructor(type) { this.type = type; } });
    vi.stubGlobal("dispatchEvent", dispatch);

    noteAuthFailure({ status: 401 });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].type).toBe(AUTH_EXPIRED_EVENT);
  });

  it("keeps the session on success and on non-401 failures", () => {
    for (const status of [200, 201, 304, 403, 404, 500, 502]) {
      storeToken(liveToken());
      noteAuthFailure({ status });
      expect(getStoredToken(), `status ${status} must not sign the user out`).not.toBeNull();
    }
  });

  it("does not re-fire the event when already signed out", () => {
    const dispatch = vi.fn();
    vi.stubGlobal("CustomEvent", class { constructor(type) { this.type = type; } });
    vi.stubGlobal("dispatchEvent", dispatch);

    noteAuthFailure({ status: 401 });   // clears the token, fires once
    noteAuthFailure({ status: 401 });   // nothing left to clear

    // Several hooks can have requests in flight at once; a burst of 401s must
    // not produce a burst of "session expired" toasts.
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("apiFetch passes the response through and clears on 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 401 })));
    const res = await apiFetch("/api/entity-types/1", { method: "PUT" });
    expect(res.status).toBe(401);
    expect(getStoredToken()).toBeNull();
  });

  it("apiFetch leaves a good session alone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200 })));
    await apiFetch("/api/entity-types");
    expect(getStoredToken()).not.toBeNull();
  });
});
