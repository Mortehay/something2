// Plain fetcher for a world's downsampled biome preview grid. Kept dependency-
// free (no React/query) so it is unit-testable in the node vitest env.
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:13101';

export async function fetchWorldPreview(worldId) {
  const res = await fetch(`${API_URL}/api/worlds/${worldId}/preview`);
  if (!res.ok) throw new Error(`Failed to fetch world preview: HTTP ${res.status}`);
  return res.json();
}
