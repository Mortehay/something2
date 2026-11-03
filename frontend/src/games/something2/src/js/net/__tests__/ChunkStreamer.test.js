import { it, expect, vi } from "vitest";
import { ChunkStreamer } from "../ChunkStreamer.js";
import { ChunkedMap } from "../../core/ChunkedMap.js";
import { MAP_TILE_SIZE } from "../../core/constants.js";

const N = 4;                       // tiles per chunk
const CHUNK_PX = N * MAP_TILE_SIZE; // px per chunk

// fake fetch: records requested keys, returns { tiles, decorations } tagged
// with its coords (matches the real fetchChunk's { tiles, decorations } shape).
function makeFetch() {
  const requested = [];
  const fetchChunk = async (cx, cy) => {
    requested.push(`${cx},${cy}`);
    const tiles = Array.from({ length: N }, () => Array.from({ length: N }, () => `t-${cx}-${cy}`));
    return { tiles, decorations: [] };
  };
  return { fetchChunk, requested };
}

it("loads the full 3x3 neighborhood on first update", async () => {
  const map = new ChunkedMap(N);
  const { fetchChunk, requested } = makeFetch();
  const s = new ChunkStreamer(map, fetchChunk, 1);
  const res = await s.update(0, 0); // center chunk (0,0)
  expect(map.loadedKeys().length).toBe(9);
  expect(new Set(requested)).toEqual(new Set([
    "-1,-1", "0,-1", "1,-1", "-1,0", "0,0", "1,0", "-1,1", "0,1", "1,1",
  ]));
  expect(res.loaded.length).toBe(9);
  expect(res.dropped.length).toBe(0);
});

it("issues no new fetches when all wanted chunks are already loaded", async () => {
  const map = new ChunkedMap(N);
  const { fetchChunk, requested } = makeFetch();
  const s = new ChunkStreamer(map, fetchChunk, 1);
  await s.update(0, 0);
  const before = requested.length;
  const res = await s.update(MAP_TILE_SIZE, MAP_TILE_SIZE); // still chunk (0,0), all 9 already loaded
  expect(requested.length).toBe(before); // no new fetches: toLoad is empty
  expect(res.loaded.length).toBe(0);
  expect(res.dropped.length).toBe(0);
});

it("retries a chunk whose fetch failed, even when the center chunk is unchanged", async () => {
  const map = new ChunkedMap(N);
  const requested = [];
  const failingKey = "1,1";
  let failedOnce = false;
  const fetchChunk = async (cx, cy) => {
    const key = `${cx},${cy}`;
    requested.push(key);
    if (key === failingKey && !failedOnce) {
      failedOnce = true;
      throw new Error("simulated transient network failure");
    }
    const tiles = Array.from({ length: N }, () => Array.from({ length: N }, () => `t-${cx}-${cy}`));
    return { tiles, decorations: [] };
  };
  let t = 0;
  const s = new ChunkStreamer(map, fetchChunk, 1, { now: () => t, retryBaseMs: 100 });

  const res1 = await s.update(0, 0); // center (0,0): 8 succeed, "1,1" throws
  expect(map.hasChunk(1, 1)).toBe(false); // failed chunk stays unloaded
  expect(res1.loaded.length).toBe(8);
  expect(map.loadedKeys().length).toBe(8);

  // SECOND update with the SAME center: under the old early-return behavior this
  // would be a no-op and "1,1" would remain permanently unloaded (invisible wall).
  t = 100; // the failure's backoff has passed
  const res2 = await s.update(0, 0);
  expect(res2.loaded).toEqual(["1,1"]);
  expect(map.hasChunk(1, 1)).toBe(true); // retried and now loaded
  expect(map.loadedKeys().length).toBe(9);
});

it("streams the new ring and drops the far ring when crossing a seam", async () => {
  const map = new ChunkedMap(N);
  const { fetchChunk, requested } = makeFetch();
  const s = new ChunkStreamer(map, fetchChunk, 1);
  await s.update(0, 0);                 // center (0,0)
  requested.length = 0;                 // reset
  const res = await s.update(CHUNK_PX, 0); // step east into chunk (1,0)
  expect(new Set(res.loaded)).toEqual(new Set(["2,-1", "2,0", "2,1"]));
  expect(new Set(res.dropped)).toEqual(new Set(["-1,-1", "-1,0", "-1,1"]));
  // only the new column was fetched; the shared 6 chunks were not re-fetched.
  expect(new Set(requested)).toEqual(new Set(["2,-1", "2,0", "2,1"]));
  expect(map.hasChunk(-1, 0)).toBe(false); // dropped
  expect(map.hasChunk(2, 0)).toBe(true);   // loaded
  expect(map.loadedKeys().length).toBe(9);
});

it("handles negative-chunk neighborhoods", async () => {
  const map = new ChunkedMap(N);
  const { fetchChunk } = makeFetch();
  const s = new ChunkStreamer(map, fetchChunk, 1);
  await s.update(-CHUNK_PX - 1, -CHUNK_PX - 1); // some negative chunk
  expect(map.loadedKeys().length).toBe(9);
});

it("does not re-fetch an already-loaded chunk", async () => {
  const map = new ChunkedMap(N);
  const { fetchChunk, requested } = makeFetch();
  const s = new ChunkStreamer(map, fetchChunk, 1);
  await s.update(0, 0);
  // Move east then back west: the chunks around (0,0) that survived are not re-fetched.
  await s.update(CHUNK_PX, 0);
  requested.length = 0;
  await s.update(0, 0); // back to center (0,0); its neighborhood chunks (0,*) etc still loaded
  // only the re-entered west column (-1,*) should be fetched, not the whole 3x3.
  expect(new Set(requested)).toEqual(new Set(["-1,-1", "-1,0", "-1,1"]));
});

it("discards a stale in-flight load whose chunk was dropped before it resolved", async () => {
  const map = new ChunkedMap(N);
  // Deferred fetch: hold each chunk's resolver so we control timing.
  const resolvers = {};
  const fetchChunk = (cx, cy) => new Promise((resolve) => {
    resolvers[`${cx},${cy}`] = () => resolve({
      tiles: Array.from({ length: N }, () => Array.from({ length: N }, () => `t-${cx}-${cy}`)),
      decorations: [],
    });
  });
  const s = new ChunkStreamer(map, fetchChunk, 1);

  // Start loading the neighborhood around (0,0) but DON'T resolve yet.
  const p1 = s.update(0, 0);
  // Move far away to center (5,0): (-1,0) is dropped and no longer wanted.
  // Resolve everything from BOTH updates.
  const p2 = s.update(5 * CHUNK_PX, 0);
  Object.values(resolvers).forEach((r) => r());
  await Promise.all([p1, p2]);

  // The stale (-1,0) fetch (started for center (0,0), dropped by the move) must
  // NOT have been applied to the map.
  expect(map.hasChunk(-1, 0)).toBe(false);
  // The current neighborhood around (5,0) is present.
  expect(map.hasChunk(5, 0)).toBe(true);
});

// G2. update() runs every frame. A failing chunk route (429 / 401 / 5xx) must not
// become one request per frame per missing chunk.
it("backs off a failing chunk exponentially instead of re-requesting it every frame", async () => {
  const map = new ChunkedMap(N);
  const calls = [];
  const fetchChunk = async (cx, cy) => {
    calls.push(`${cx},${cy}`);
    if (cx === 1 && cy === 1) throw new Error("429");
    return { tiles: Array.from({ length: N }, () => Array.from({ length: N }, () => "t")), decorations: [] };
  };
  let t = 0;
  const s = new ChunkStreamer(map, fetchChunk, 1, { now: () => t, retryBaseMs: 500, retryMaxMs: 2000 });
  const failing = () => calls.filter((k) => k === "1,1").length;

  await s.update(0, 0);
  expect(failing()).toBe(1);
  for (let frame = 0; frame < 200; frame++) { t += 2; await s.update(0, 0); } // 400 ms of frames
  expect(failing()).toBe(1); // still cooling down: no storm

  t = 500; await s.update(0, 0);
  expect(failing()).toBe(2);           // retried once the first delay (500) passed
  t = 500 + 999; await s.update(0, 0);
  expect(failing()).toBe(2);           // second delay is 1000, not yet
  t = 500 + 1000; await s.update(0, 0);
  expect(failing()).toBe(3);
  t += 1999; await s.update(0, 0);     // third delay would be 2000 (the cap)
  expect(failing()).toBe(3);
  t += 1; await s.update(0, 0);
  expect(failing()).toBe(4);
  t += 2000; await s.update(0, 0);     // capped: stays at 2000, never grows past it
  expect(failing()).toBe(5);
  // The healthy chunks were never re-requested.
  expect(calls.filter((k) => k !== "1,1").length).toBe(8);
});

it("a chunk that leaves the neighborhood forgets its failure record", async () => {
  const map = new ChunkedMap(N);
  const fetchChunk = async (cx) => { if (cx === 1) throw new Error("boom"); return { tiles: [[1]], decorations: [] }; };
  const s = new ChunkStreamer(map, fetchChunk, 1, { now: () => 0 });
  vi.spyOn(console, "error").mockImplementation(() => {});
  await s.update(0, 0);
  expect(s.failures.size).toBeGreaterThan(0);
  await s.update(-3 * CHUNK_PX, 0); // far west: the east column is gone
  expect([...s.failures.keys()].every((k) => s.wanted.has(k))).toBe(true);
});

it("loadCenter retries through the backoff until the chunk under the player is there", async () => {
  const map = new ChunkedMap(N);
  let failuresLeft = 2;
  const fetchChunk = async (cx, cy) => {
    if (cx === 0 && cy === 0 && failuresLeft-- > 0) throw new Error("transient");
    return { tiles: Array.from({ length: N }, () => Array.from({ length: N }, () => "t")), decorations: [] };
  };
  let t = 0;
  const waits = [];
  const s = new ChunkStreamer(map, fetchChunk, 1, {
    now: () => t, retryBaseMs: 500,
    sleep: async (ms) => { waits.push(ms); t += ms; },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await s.loadCenter(10, 10)).toBe(true);
  expect(s.isLoadedAt(10, 10)).toBe(true);
  expect(waits).toEqual([500, 1000]); // waited out each backoff, no busy loop
});

it("loadCenter gives up (false) when the chunk under the player never loads", async () => {
  const map = new ChunkedMap(N);
  const fetchChunk = async (cx, cy) => {
    if (cx === 0 && cy === 0) throw new Error("401");
    return { tiles: [[1]], decorations: [] };
  };
  let t = 0;
  const s = new ChunkStreamer(map, fetchChunk, 1, { now: () => t, sleep: async (ms) => { t += ms; } });
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await s.loadCenter(10, 10, { attempts: 3 })).toBe(false);
  expect(s.isLoadedAt(10, 10)).toBe(false);
});
