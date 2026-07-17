// World-space (px) <-> chunk coords for the authority. CommonJS port of the
// frontend core/worldCoords.js + NeighborhoodManager.js — must stay identical
// so server activation/AOI and client streaming agree on chunk ownership.
const MAP_TILE_SIZE = 100;

function chunkOf(worldX, worldY, chunkSize) {
  const gCol = Math.floor(worldX / MAP_TILE_SIZE);
  const gRow = Math.floor(worldY / MAP_TILE_SIZE);
  return { cx: Math.floor(gCol / chunkSize), cy: Math.floor(gRow / chunkSize) };
}

function CHUNK_KEY(cx, cy) { return `${cx},${cy}`; }

function parseKey(key) {
  const [cx, cy] = key.split(',').map(Number);
  return { cx, cy };
}

function neighborhoodKeys(cx, cy, radius = 1) {
  const keys = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      keys.push(CHUNK_KEY(cx + dx, cy + dy));
    }
  }
  return keys;
}

module.exports = { MAP_TILE_SIZE, chunkOf, CHUNK_KEY, parseKey, neighborhoodKeys };
