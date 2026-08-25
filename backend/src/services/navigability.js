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
//
// DECORATIONS (SOMET-510). This module used to flood TERRAIN only, and a
// blocking decoration (Stone / Tree / IceRock / pine_tree / dead_tree) is real
// collision at runtime -- authority/collision.js consults the same
// generateChunkDecorations overlay -- so a world could seed clean and still drop
// an arriving player into a pocket. That is not hypothetical: with the SOMET-349
// connector roads switched off (which is how seeding judges a world), 11 arrival
// points across 10 of the 100 live worlds had a blocker sitting ON the arrival
// tile, the entry world's own E doorway among them. The roads were hiding it,
// because generateChunkDecorations skips carved path cells and the connectors
// run to exactly the places that seal. See assertNavigable below for why the
// decoration check is a SECOND PASS rather than extra bits in the same grid.
const { worldConfig, generateRegion, generateChunkDecorations } = require('./mapService');

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

// SOMET-510 — the cells a BLOCKING decoration occupies in a bounded world, as
// "row,col" keys.
//
// Built by calling generateChunkDecorations chunk by chunk, exactly as the
// authority's ServerMap and the REST /chunk preview do, rather than by
// re-deriving placement here. A checker that models placement its own way finds
// its own bugs, not the game's -- which is why scan-decoration-seals.js imports
// THIS function instead of keeping the second copy it used to carry.
function blockingDecorationCells(world, decorationDefs) {
  const cells = new Set();
  if (!decorationDefs || decorationDefs.length === 0) return cells;
  const cfg = worldConfig(world);
  if (!cfg.bounds) return cells;
  const { width, height } = cfg.bounds;
  const N = cfg.chunkSize;
  for (let cy = 0; cy * N < height; cy++) {
    for (let cx = 0; cx * N < width; cx++) {
      const tiles = generateRegion(world, cy * N, cx * N, N, N);
      for (const d of generateChunkDecorations(world, cx, cy, tiles, decorationDefs)) {
        if (!d.blocking) continue;
        const gRow = cy * N + d.row, gCol = cx * N + d.col;
        if (gRow < 0 || gRow >= height || gCol < 0 || gCol >= width) continue;
        cells.add(`${gRow},${gCol}`);
      }
    }
  }
  return cells;
}

// One pass: flood from the first required tile under `walkable`, then report
// every required tile the fill missed and whether the fill covered a plausible
// share of the interior. `label` is appended to each message so a caller running
// this twice can tell the two verdicts apart; it is EMPTY for the terrain pass,
// whose wording predates this split and is asserted verbatim by several tests.
function connectivityProblems({ inside, walkable, width, height, label }) {
  const problems = [];
  // The start must itself be walkable -- reported, never silently skipped,
  // because a spawn buried in rock is the exact failure this guards.
  const start = inside[0];
  if (!walkable(start.row, start.col)) {
    return inside.map((t) => `${t.what} at (${t.row},${t.col}) is unreachable${label}`);
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
      problems.push(`${t.what} at (${t.row},${t.col}) is unreachable${label}`);
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
      + `${start.what} at (${start.row},${start.col}) -- the world is effectively sealed${label}`);
  }
  return problems;
}

// SOMET-510. What the decoration pass appends to every message it raises. It
// names the lever to pull: a terrain failure is repaired in the map spec, a
// decoration failure in the clearance rule (mapService's isExcludedBlockerCell)
// or the decoration catalog.
const DECO_LABEL = ' once blocking decorations are placed';

// TWO PASSES, NOT ONE MERGED BITMASK (SOMET-510).
//
// It is tempting to OR the blocking decorations into `walkable` and be done in
// three lines. Four reasons not to, in descending order of how much they cost:
//
// 1. THEY HAVE DIFFERENT REPAIRS. Terrain is a function of (seed, size, biome
//    banding) authored in the map spec; a terrain seal is fixed by editing the
//    spec. A decoration is placed by the entity_types catalog under the
//    clearance rule; a decoration seal is fixed by widening the clearance or
//    changing the catalog. One merged message cannot say which lever to pull,
//    and a seeding failure that does not name its own fix is the failure mode
//    this repo keeps paying for.
// 2. IT WOULD SILENTLY RECALIBRATE THE TERRAIN CHECK. MIN_REACHABLE_FRACTION
//    was measured against 20 shipped worlds' TERRAIN (70.7%-100% reachable).
//    Decorations cost up to a further 20% of that (measured across the 100 live
//    worlds: worst decorated/bare ratio 0.800), so a merged pass would score a
//    decorated world against a terrain-calibrated floor and sit nearer its
//    threshold for a reason unrelated to the failure the floor was built for.
// 3. DECORATIONS ARE NOT PERMANENT THE WAY TERRAIN IS. The def catalog is an
//    admin-editable table, read at world activation; the same `worlds` row can
//    produce different decorations tomorrow with no re-seed. Terrain cannot.
//    Merged, an admin's catalog edit could flip a TERRAIN verdict.
// 4. ADDITIVE MEANS PROVABLY NO REGRESSION. Every world's terrain verdict is
//    bit-for-bit what it was before this ticket, because pass 1 is the old
//    function unchanged and pass 2 only ever appends.
//
// The decoration pass runs ONLY when the caller supplies `decorationDefs`. A
// caller that has none (the offline spec fixtures, the unit tests that hand-build
// a world) gets exactly the old behaviour -- deliberately, so "no defs" is
// "nothing to check", never a silent pass over an unchecked hazard.
function assertNavigable(world, requiredTiles, options = {}) {
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

  problems.push(...connectivityProblems({ inside, walkable, width, height, label: '' }));

  const decorationDefs = options.decorationDefs;
  if (decorationDefs && decorationDefs.length > 0) {
    const blocked = blockingDecorationCells(world, decorationDefs);
    // A required tile with a blocker ON it gets its own wording. It is not
    // "unreachable" in any interesting sense -- you cannot stand there at all --
    // and it is the failure that was actually live: 11 arrival points across 10
    // of the 100 seeded worlds, road network off.
    for (const t of inside) {
      if (blocked.has(`${t.row},${t.col}`)) {
        problems.push(`${t.what} at (${t.row},${t.col}) is under a blocking decoration`);
      }
    }
    const walkableDecorated = (r, c) => walkable(r, c) && !blocked.has(`${r},${c}`);
    problems.push(...connectivityProblems({
      inside, walkable: walkableDecorated, width, height, label: DECO_LABEL,
    }));
  }
  return problems;
}

module.exports = {
  assertNavigable, MIN_REACHABLE_FRACTION, blockingDecorationCells, DECO_LABEL,
};
