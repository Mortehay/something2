import { describe, it, expect } from "vitest";
import { makeChunkFetcher } from "../chunkFetcher.js";
import { storeToken, clearToken } from "../auth.js";

// getStoredToken() expiry-checks the token, so a placeholder string would be
// discarded as expired and no header would be sent.
function futureToken(tag) {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  return `${b64({ alg: "HS256" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, tag })}.sig`;
}

function fakeFetch(response, ok = true) {
  return async (url) => ({ ok, url, json: async () => response });
}

describe("makeChunkFetcher", () => {
  it("returns { tiles, decorations }, not the envelope", async () => {
    const grid = [["grass", "grass"], ["dirt", "water"]];
    const decorations = [{ name: "Tree", row: 0, col: 1, blocking: true }];
    const fetchImpl = fakeFetch({ world_id: "w1", cx: 2, cy: -1, data: grid, decorations });
    const fetchChunk = makeChunkFetcher("w1", "http://api", fetchImpl);
    const out = await fetchChunk(2, -1);
    expect(out).toEqual({ tiles: grid, decorations }); // NOT { data: grid, ... }
  });

  it("defaults decorations to [] when the envelope omits it", async () => {
    const grid = [["grass"]];
    const fetchImpl = fakeFetch({ world_id: "w1", cx: 0, cy: 0, data: grid });
    const fetchChunk = makeChunkFetcher("w1", "http://api", fetchImpl);
    const out = await fetchChunk(0, 0);
    expect(out).toEqual({ tiles: grid, decorations: [] });
  });

  it("builds the correct URL incl. negative coords", async () => {
    let seen = null;
    const fetchImpl = async (url) => { seen = url; return { ok: true, json: async () => ({ data: [] }) }; };
    const fetchChunk = makeChunkFetcher("abc", "http://api", fetchImpl);
    await fetchChunk(-3, 4);
    expect(seen).toBe("http://api/api/worlds/abc/chunk?cx=-3&cy=4");
  });

  it("throws on a non-ok response", async () => {
    const fetchChunk = makeChunkFetcher("w1", "http://api", fakeFetch({}, false));
    await expect(fetchChunk(0, 0)).rejects.toThrow();
  });

  // --- SOMET-559: the chunk route is behind playerGuard ------------------
  it("sends the stored bearer token with every chunk request", async () => {
    const token = futureToken("a");
    storeToken(token);
    let seen = null;
    const fetchImpl = async (url, init) => { seen = init; return { ok: true, json: async () => ({ data: [] }) }; };
    await makeChunkFetcher("w1", "http://api", fetchImpl)(0, 0);
    expect(seen.headers.Authorization).toBe(`Bearer ${token}`);
    clearToken();
  });

  it("reads the token per request, so a refresh mid-session is picked up", async () => {
    // A Game instance outlives a token refresh. If the fetcher captured the
    // header once at construction it would keep streaming the OLD token until
    // the world was rebuilt, and every chunk would 401 after a re-login.
    const first = futureToken("first");
    storeToken(first);
    const seen = [];
    const fetchImpl = async (url, init) => { seen.push(init.headers.Authorization); return { ok: true, json: async () => ({ data: [] }) }; };
    const fetchChunk = makeChunkFetcher("w1", "http://api", fetchImpl);
    await fetchChunk(0, 0);

    const second = futureToken("second");
    storeToken(second);
    await fetchChunk(1, 0);

    expect(seen).toEqual([`Bearer ${first}`, `Bearer ${second}`]);
    clearToken();
  });

  it("omits Authorization when signed out rather than sending \"Bearer null\"", async () => {
    clearToken();
    let seen = null;
    const fetchImpl = async (url, init) => { seen = init; return { ok: true, json: async () => ({ data: [] }) }; };
    await makeChunkFetcher("w1", "http://api", fetchImpl)(0, 0);
    expect(seen.headers.Authorization).toBeUndefined();
  });
});
