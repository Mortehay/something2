// Dependency-free fetcher + refetch predicate for the minimap's player-centered
// overview. Kept React/query-free so it is unit-testable in the node vitest env,
// mirroring worldPreviewClient.js.
import { API_URL } from '../../../../../config.js';

export async function fetchWorldOverview(worldId, centerCol, centerRow) {
  const res = await fetch(`${API_URL}/api/worlds/${worldId}/overview?cx=${centerCol}&cy=${centerRow}`);
  if (!res.ok) throw new Error(`Failed to fetch world overview: HTTP ${res.status}`);
  return res.json();
}

// True when there is no cached window, or the player has moved within `margin`
// tiles of its edge (so terrain would run out before the next fetch lands).
export function needsRefetch(cached, playerCol, playerRow, margin) {
  if (!cached) return true;
  const maxCol = cached.originCol + cached.cols * cached.step;
  const maxRow = cached.originRow + cached.rows * cached.step;
  return playerCol < cached.originCol + margin || playerCol > maxCol - margin
      || playerRow < cached.originRow + margin || playerRow > maxRow - margin;
}
