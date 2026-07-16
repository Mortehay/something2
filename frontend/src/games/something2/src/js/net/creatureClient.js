export function makeCreatureFetcher(worldId, apiUrl, fetchImpl = fetch) {
  return async function fetchCreatures(cx, cy) {
    const res = await fetchImpl(`${apiUrl}/api/worlds/${worldId}/creatures?cx=${cx}&cy=${cy}`);
    if (!res.ok) throw new Error(`creature fetch failed (${cx},${cy})`);
    return res.json();
  };
}

export function makeCreatureFlusher(worldId, apiUrl, fetchImpl = fetch) {
  return async function flushCreatures(creatures) {
    if (!creatures || creatures.length === 0) return 0;
    const res = await fetchImpl(`${apiUrl}/api/worlds/${worldId}/creatures/flush`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creatures }),
    });
    if (!res.ok) throw new Error("creature flush failed");
    const body = await res.json();
    return body.updated || 0;
  };
}
