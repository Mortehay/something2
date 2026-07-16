// Builds an async fetchChunk(cx,cy) -> string[][] for a specific world, hitting
// the Phase 2 chunk API and unwrapping the `data` grid from the response
// envelope. fetchImpl is injectable for tests. The backend caches chunks in
// world_chunks, so repeat requests are cheap; ChunkStreamer + ChunkedMap avoid
// re-requesting currently-loaded chunks.
export function makeChunkFetcher(worldId, apiUrl, fetchImpl = fetch) {
  return async function fetchChunk(cx, cy) {
    const url = `${apiUrl}/api/worlds/${worldId}/chunk?cx=${cx}&cy=${cy}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`chunk fetch failed (${cx},${cy})`);
    const body = await res.json();
    return body.data;
  };
}
