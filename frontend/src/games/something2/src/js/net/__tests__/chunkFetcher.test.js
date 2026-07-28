import { describe, it, expect } from "vitest";
import { makeChunkFetcher } from "../chunkFetcher.js";

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
});
