import { chunkOf, CHUNK_KEY, parseKey } from "../core/worldCoords.js";
import { neighborhoodKeys, diffNeighborhoods } from "../core/NeighborhoodManager.js";

// Keeps a ChunkedMap populated with the (2*radius+1)^2 neighborhood around the
// player. Fetching is injected (async fetchChunk(cx,cy) -> grid) so this is
// transport-agnostic and unit-testable. Phase 4b supplies a real HTTP/TanStack
// fetch; Phase 4b also calls update() from the game loop.
export class ChunkStreamer {
  constructor(chunkedMap, fetchChunk, radius = 1) {
    this.map = chunkedMap;
    this.fetchChunk = fetchChunk;
    this.radius = radius;
    this.centerKey = null;     // last center chunk "cx,cy"
    this.inflight = new Set(); // keys currently being fetched
    this.wanted = new Set();   // keys in the currently-wanted neighborhood
  }

  async update(worldX, worldY) {
    const { cx, cy } = chunkOf(worldX, worldY, this.map.chunkSize);
    const key = CHUNK_KEY(cx, cy);
    const next = neighborhoodKeys(cx, cy, this.radius);
    this.wanted = new Set(next);

    // Drops only when the center chunk changed.
    let dropped = [];
    if (key !== this.centerKey) {
      const prev = this.centerKey
        ? neighborhoodKeys(...Object.values(parseKey(this.centerKey)), this.radius)
        : [];
      dropped = diffNeighborhoods(prev, next).toDrop;
      for (const k of dropped) {
        const { cx: dcx, cy: dcy } = parseKey(k);
        this.map.removeChunk(dcx, dcy);
      }
      this.centerKey = key;
    }

    // Always: load any wanted chunk not already loaded and not inflight.
    // This retries chunks whose earlier fetch failed, even when the center is unchanged.
    const toLoad = next.filter((k) => {
      const { cx: lcx, cy: lcy } = parseKey(k);
      return !this.map.hasChunk(lcx, lcy) && !this.inflight.has(k);
    });

    const loaded = [];
    await Promise.all(
      toLoad.map(async (k) => {
        const { cx: lcx, cy: lcy } = parseKey(k);
        this.inflight.add(k);
        try {
          const grid = await this.fetchChunk(lcx, lcy);
          if (!this.wanted.has(k)) return; // neighborhood moved on; discard stale load
          this.map.setChunk(lcx, lcy, grid);
          loaded.push(k);
        } catch (err) {
          // Leave unloaded; a later update() retries. Don't crash the loop.
          console.error(`ChunkStreamer: failed to load ${k}`, err);
        } finally {
          this.inflight.delete(k);
        }
      }),
    );

    return { loaded, dropped };
  }
}
