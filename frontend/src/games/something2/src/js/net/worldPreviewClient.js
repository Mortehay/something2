// Plain fetcher for a world's downsampled biome preview grid. Kept dependency-
// free (no React/query) so it is unit-testable in the node vitest env.
import { API_URL } from '../../../../../config.js';
import { authHeaders } from './auth.js';

export async function fetchWorldPreview(worldId) {
  // SOMET-559: the preview route is behind playerGuard.
  const res = await fetch(`${API_URL}/api/worlds/${worldId}/preview`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to fetch world preview: HTTP ${res.status}`);
  return res.json();
}
