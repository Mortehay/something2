import { CHUNK_KEY } from "./worldCoords.js";

// The (2*radius+1)^2 chunk keys centered on (cx,cy). Row-major (dy outer).
export function neighborhoodKeys(cx, cy, radius = 1) {
  const keys = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      keys.push(CHUNK_KEY(cx + dx, cy + dy));
    }
  }
  return keys;
}

// Which keys are newly needed (toLoad) and which are no longer needed (toDrop).
export function diffNeighborhoods(prevKeys, nextKeys) {
  const prev = new Set(prevKeys);
  const next = new Set(nextKeys);
  const toLoad = nextKeys.filter((k) => !prev.has(k));
  const toDrop = prevKeys.filter((k) => !next.has(k));
  return { toLoad, toDrop };
}
