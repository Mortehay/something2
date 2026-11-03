import { chunkOf, CHUNK_KEY, parseKey } from "../core/worldCoords.js";
import { neighborhoodKeys, diffNeighborhoods } from "../core/NeighborhoodManager.js";

// A chunk whose fetch failed is not asked for again until this has passed, then
// twice as long after each further failure, capped. update() runs EVERY FRAME, so
// without this a failing route (429 from the rate limiter, 401 after the token
// expired, a 5xx) became one request per frame per missing chunk -- up to 9 per
// round trip -- which kept a 429 limiter tripped for good. worldOverviewClient
// documents the same failure for the overview route and backs off there.
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 15000;

// Keeps a ChunkedMap populated with the (2*radius+1)^2 neighborhood around the
// player. Fetching is injected (async fetchChunk(cx,cy) -> { tiles, decorations })
// so this is transport-agnostic and unit-testable. Phase 4b supplies a real
// HTTP/TanStack fetch; Phase 4b also calls update() from the game loop.
export class ChunkStreamer {
  constructor(chunkedMap, fetchChunk, radius = 1, {
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    retryBaseMs = RETRY_BASE_MS,
    retryMaxMs = RETRY_MAX_MS,
  } = {}) {
    this.map = chunkedMap;
    this.fetchChunk = fetchChunk;
    this.radius = radius;
    this.now = now;
    this.sleep = sleep;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.centerKey = null;     // last center chunk "cx,cy"
    this.inflight = new Set(); // keys currently being fetched
    this.wanted = new Set();   // keys in the currently-wanted neighborhood
    this.failures = new Map(); // key -> { count, retryAt } for chunks that failed
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

    // Chunks that left the neighborhood take their failure record along.
    for (const k of this.failures.keys()) {
      if (!this.wanted.has(k)) this.failures.delete(k);
    }

    // Always: load any wanted chunk not already loaded, not inflight, and not
    // still cooling down from a failure. This retries failed chunks even when the
    // center is unchanged, but no faster than the backoff allows.
    const t = this.now();
    const toLoad = next.filter((k) => {
      const { cx: lcx, cy: lcy } = parseKey(k);
      if (this.map.hasChunk(lcx, lcy) || this.inflight.has(k)) return false;
      const f = this.failures.get(k);
      return !f || t >= f.retryAt;
    });

    const loaded = [];
    await Promise.all(
      toLoad.map(async (k) => {
        const { cx: lcx, cy: lcy } = parseKey(k);
        this.inflight.add(k);
        try {
          const chunk = await this.fetchChunk(lcx, lcy);
          if (!this.wanted.has(k)) return; // neighborhood moved on; discard stale load
          this.map.setChunk(lcx, lcy, chunk.tiles, chunk.decorations, chunk.biomes);
          this.failures.delete(k);
          loaded.push(k);
        } catch (err) {
          // Leave unloaded; a later update() retries after the backoff. Don't
          // crash the loop.
          const count = (this.failures.get(k)?.count || 0) + 1;
          const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (count - 1));
          this.failures.set(k, { count, retryAt: this.now() + delay });
          console.error(`ChunkStreamer: failed to load ${k} (retry in ${delay}ms)`, err);
        } finally {
          this.inflight.delete(k);
        }
      }),
    );

    return { loaded, dropped };
  }

  // Whether the chunk under a world point is loaded.
  isLoadedAt(worldX, worldY) {
    const { cx, cy } = chunkOf(worldX, worldY, this.map.chunkSize);
    return this.map.hasChunk(cx, cy);
  }

  // Loads the neighborhood around a point and makes sure the chunk UNDER it is
  // there, retrying through the backoff up to `attempts` times. The game calls
  // this once before its first frame: an unloaded chunk is unwalkable, so starting
  // on a failed first load left the player stuck on an empty map. Resolves true if
  // the center chunk is loaded, false if it still is not.
  async loadCenter(worldX, worldY, { attempts = 4 } = {}) {
    for (let i = 0; i < attempts; i++) {
      await this.update(worldX, worldY);
      if (this.isLoadedAt(worldX, worldY)) return true;
      if (i === attempts - 1) break;
      const { cx, cy } = chunkOf(worldX, worldY, this.map.chunkSize);
      const f = this.failures.get(CHUNK_KEY(cx, cy));
      await this.sleep(f ? Math.max(0, f.retryAt - this.now()) : this.retryBaseMs);
    }
    return this.isLoadedAt(worldX, worldY);
  }
}
