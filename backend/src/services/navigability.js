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
//
// WHY THE FRACTION FLOOR EXISTS. The mutual-connectivity question above is
// vacuous when there is only ONE required tile: the fill starts there, and the
// membership scan then finds that tile in its own frontier, always. Nine of
// the twenty shipped worlds are in exactly that shape (one doorway, no
// entry_spawn), and one of them -- Blackfen Sinks -- shipped with 3 of 3844
// interior cells reachable while this module reported it clean. So a second,
// absolute question is asked as well: does the fill reach a plausible share of
// the interior at all? That one needs nothing to compare against.
const { worldConfig, generateRegion } = require('./mapService');

// Fraction of the bounded INTERIOR the anchor's flood fill must reach.
//
// Measured against all 20 shipped worlds: the healthy ones reach 70.7%-100% of
// their interior (and every one of them reaches EVERY walkable cell it has --
// one connected component, no islands). The sealed Blackfen Sinks reached
// 0.08%. 0.25 sits ~2.8x below the worst healthy world and ~300x above the
// failure, which is the widest margin the real data offers. A world where a
// player walking in the front door can reach under a quarter of the map is
// broken by any content standard; if a deliberately maze-like biome set ever
// lands legitimately below this, raise it here rather than deleting the check.
const MIN_REACHABLE_FRACTION = 0.25;

// Denominator is every INTERIOR CELL, walkable or not -- deliberately not "the
// walkable cells". A world whose interior banded solid cave_wall has almost no
// walkable cells, so a walkable-cell denominator would score its 3-cell
// doorway pocket at 100% and wave through the most completely sealed world
// there is. Counting cells makes "how much of this map can I walk?" the
// question, which is the one that matters.
function interiorArea(width, height) {
  return Math.max(0, (width - 2) * (height - 2));
}

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

  // The absolute question, asked whether or not there was anything to compare
  // the anchor against. `seen` counts every reached cell including the doorway
  // gap on the ring, so a fully-open world scores slightly over 1.0 -- fine,
  // this is a floor.
  const area = interiorArea(width, height);
  if (area > 0 && seen.size < area * MIN_REACHABLE_FRACTION) {
    const pct = (100 * seen.size / area).toFixed(1);
    problems.push(
      `only ${seen.size} of ${area} interior cells (${pct}%) are reachable from `
      + `${start.what} at (${start.row},${start.col}) -- the world is effectively sealed`);
  }
  return problems;
}

module.exports = { assertNavigable, MIN_REACHABLE_FRACTION };
