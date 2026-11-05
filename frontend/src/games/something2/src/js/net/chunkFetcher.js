// Builds an async fetchChunk(cx,cy) -> { tiles, decorations } for a specific
// world, hitting the chunk API and unwrapping the `data` grid + `decorations`
// list from the response envelope. fetchImpl is injectable for tests. The
// backend caches chunks in world_chunks, so repeat requests are cheap;
// ChunkStreamer + ChunkedMap avoid re-requesting currently-loaded chunks.
import { authHeaders } from "./auth.js";

// SOMET-742. A request that never finishes must fail into ChunkStreamer's retries:
// entry waits on these chunks, and the loading screen hides the recovery panel
// until entry ends one way or the other.
const CHUNK_FETCH_TIMEOUT_MS = 15000;

export function makeChunkFetcher(worldId, apiUrl, fetchImpl = fetch) {
  return async function fetchChunk(cx, cy) {
    const url = `${apiUrl}/api/worlds/${worldId}/chunk?cx=${cx}&cy=${cy}`;
    // SOMET-559: the chunk route is behind playerGuard. authHeaders() is read
    // per request, not captured when the fetcher is built -- a Game instance
    // outlives a token refresh, so binding the header once at construction
    // would keep streaming a stale token until the world was rebuilt.
    const res = await fetchImpl(url, { headers: authHeaders(), signal: AbortSignal.timeout(CHUNK_FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`chunk fetch failed (${cx},${cy})`);
    const body = await res.json();
    return { tiles: body.data, decorations: body.decorations || [], biomes: body.biomes || null };
  };
}
