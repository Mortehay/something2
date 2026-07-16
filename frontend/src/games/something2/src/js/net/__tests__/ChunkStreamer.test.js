import { it, expect } from "vitest";
import { ChunkStreamer } from "../ChunkStreamer.js";
import { ChunkedMap } from "../../core/ChunkedMap.js";
import { MAP_TILE_SIZE } from "../../core/constants.js";

const N = 4;                       // tiles per chunk
const CHUNK_PX = N * MAP_TILE_SIZE; // px per chunk

// fake fetch: records requested keys, returns a grid tagged with its coords.
function makeFetch() {
  const requested = [];
  const fetchChunk = async (cx, cy) => {
    requested.push(`${cx},${cy}`);
    return Array.from({ length: N }, () => Array.from({ length: N }, () => `t-${cx}-${cy}`));
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
    return Array.from({ length: N }, () => Array.from({ length: N }, () => `t-${cx}-${cy}`));
  };
  const s = new ChunkStreamer(map, fetchChunk, 1);

  const res1 = await s.update(0, 0); // center (0,0): 8 succeed, "1,1" throws
  expect(map.hasChunk(1, 1)).toBe(false); // failed chunk stays unloaded
  expect(res1.loaded.length).toBe(8);
  expect(map.loadedKeys().length).toBe(8);

  // SECOND update with the SAME center: under the old early-return behavior this
  // would be a no-op and "1,1" would remain permanently unloaded (invisible wall).
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
    resolvers[`${cx},${cy}`] = () => resolve(
      Array.from({ length: N }, () => Array.from({ length: N }, () => `t-${cx}-${cy}`)));
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
