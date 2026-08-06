// Can a player actually reach everything this world requires?
//
// P3 lets ten deep biomes band impassable terrain (cave_wall / rubble /
// chasm). That makes a new failure possible: a blob over the entry spawn, or
// a doorway walled off from the rest of the interior, produces a dungeon
// nobody can enter -- and the only way to notice is to walk into it.
//
// So seeding checks. Generation is deterministic, and a 64x64 interior is
// ~4000 cells, so this is cheap enough to run per world on every seed.
//
// WHERE THE FILL STARTS. Only the entry world has an `entry_spawn`; every
// other world's is null. So the fill starts from the FIRST required tile and
// asks whether the rest are reachable from it. That is well defined for every
// world, and it is the right question anyway: what matters is not that some
// absolute point is walkable, but that everything a player can arrive at or
// leave through is mutually connected.
const { worldConfig, generateRegion } = require('./mapService');

function assertNavigable(world, requiredTiles) {
  if (!requiredTiles || requiredTiles.length === 0) return [];
  const cfg = worldConfig(world);
  // Unbounded worlds have no interior to seal. P1 made these unreachable via
  // the API, but the check stays total rather than assuming that holds.
  if (!cfg.bounds) return [];
  const { width, height } = cfg.bounds;

  const grid = generateRegion(world, 0, 0, height, width);
  const walkable = (r, c) => {
    if (r < 0 || r >= height || c < 0 || c >= width) return false;
    const def = world.tileTypes && world.tileTypes[grid[r][c]];
    return !(def && def.walkable === false);
  };

  const inBounds = (t) => t.row >= 0 && t.row < height && t.col >= 0 && t.col < width;
  const outside = requiredTiles.filter((t) => !inBounds(t));
  const inside = requiredTiles.filter(inBounds);
  const problems = outside.map((t) => `${t.what} at (${t.row},${t.col}) is outside the map`);
  if (inside.length === 0) return problems;

  // The start must itself be walkable -- reported, never silently skipped,
  // because a spawn buried in rock is the exact failure this guards.
  const start = inside[0];
  if (!walkable(start.row, start.col)) {
    return [...problems, ...inside.map((t) => `${t.what} at (${t.row},${t.col}) is unreachable`)];
  }

  const seen = new Set([`${start.row},${start.col}`]);
  const queue = [[start.row, start.col]];
  while (queue.length) {
    const [r, c] = queue.pop();
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr, nc = c + dc;
      const key = `${nr},${nc}`;
      if (seen.has(key) || !walkable(nr, nc)) continue;
      seen.add(key);
      queue.push([nr, nc]);
    }
  }

  for (const t of inside) {
    if (!seen.has(`${t.row},${t.col}`)) {
      problems.push(`${t.what} at (${t.row},${t.col}) is unreachable`);
    }
  }
  return problems;
}

module.exports = { assertNavigable };
