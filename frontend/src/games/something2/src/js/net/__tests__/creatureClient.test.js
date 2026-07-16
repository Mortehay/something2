import { describe, it, expect } from "vitest";
import { makeCreatureFetcher, makeCreatureFlusher } from "../creatureClient.js";

describe("creatureClient", () => {
  it("fetches creatures for a chunk", async () => {
    let url = null;
    const fetchImpl = async (u) => { url = u; return { ok: true, json: async () => [{ id: "c1" }] }; };
    const fetchCreatures = makeCreatureFetcher("w1", "http://api", fetchImpl);
    const out = await fetchCreatures(2, -1);
    expect(out).toEqual([{ id: "c1" }]);
    expect(url).toBe("http://api/api/worlds/w1/creatures?cx=2&cy=-1");
  });

  it("flush POSTs dirty creatures and returns updated count", async () => {
    let body = null;
    const fetchImpl = async (u, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({ updated: 2 }) }; };
    const flush = makeCreatureFlusher("w1", "http://api", fetchImpl);
    const n = await flush([{ id: "c1", x: 1, y: 2 }, { id: "c2", x: 3, y: 4 }]);
    expect(n).toBe(2);
    expect(body.creatures.length).toBe(2);
  });

  it("flush is a no-op for an empty list", async () => {
    let called = false;
    const flush = makeCreatureFlusher("w1", "http://api", async () => { called = true; return { ok: true, json: async () => ({}) }; });
    expect(await flush([])).toBe(0);
    expect(called).toBe(false);
  });
});
