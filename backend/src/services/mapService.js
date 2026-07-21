function generateWFC(rows, cols, tileTypes) {
    const tileNames = Object.keys(tileTypes);
    const grid = Array(rows).fill(null).map(() => 
        Array(cols).fill(null).map(() => [...tileNames])
    );

    const getEntropy = (r, c) => grid[r][c].length;

    const getLowestEntropyCoords = () => {
        let minEntropy = Infinity;
        let coords = [];

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (grid[r][c].length > 1) {
                    const entropy = getEntropy(r, c);
                    if (entropy < minEntropy) {
                        minEntropy = entropy;
                        coords = [[r, c]];
                    } else if (entropy === minEntropy) {
                        coords.push([r, c]);
                    }
                }
            }
        }
        return coords.length > 0 ? coords[Math.floor(Math.random() * coords.length)] : null;
    };

    const propagate = (r, c) => {
        const stack = [[r, c]];
        while (stack.length > 0) {
            const [currR, currC] = stack.pop();
            const currOptions = grid[currR][currC];

            const neighbors = [
                [currR - 1, currC], [currR + 1, currC],
                [currR, currC - 1], [currR, currC + 1]
            ];

            for (const [nR, nC] of neighbors) {
                if (nR >= 0 && nR < rows && nC >= 0 && nC < cols) {
                    const neighborOptions = grid[nR][nC];
                    if (neighborOptions.length <= 1) continue;

                    const validForNeighbor = new Set();
                    currOptions.forEach(opt => {
                        const allowedNeighbors = tileTypes[opt]?.validNeighbors || [];
                        allowedNeighbors.forEach(validOpt => validForNeighbor.add(validOpt));
                    });

                    const nextNeighborOptions = neighborOptions.filter(opt => validForNeighbor.has(opt));

                    if (nextNeighborOptions.length < neighborOptions.length) {
                        grid[nR][nC] = nextNeighborOptions;
                        stack.push([nR, nC]);
                    }
                }
            }
        }
    };

    let next;
    while (next = getLowestEntropyCoords()) {
        const [r, c] = next;
        const options = grid[r][c];
        const pick = options[Math.floor(Math.random() * options.length)];
        grid[r][c] = [pick];
        propagate(r, c);
    }

    return grid.map(row => row.map(cell => cell[0] || tileNames[0] || 'grass'));
}

// --- Layered world generation (biomes -> paths) ---------------------------
//
// generateWFC only produces per-tile adjacency noise. generateWorld builds
// large-scale structure the way a hand-authored overworld reads: cohesive
// biome regions from low-frequency noise, then winding paths carved between
// anchor points. Output is the same rows x cols grid of tile-type NAMES, so
// storage/API/loader are unchanged. Deterministic for a given seed.

// Small seeded PRNG (mulberry32): deterministic 0..1 stream from an integer.
function makeRng(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Smoothstep easing for value-noise interpolation.
function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

// Deterministic integer hash -> float in [0,1). Pure function of (seed, x, y);
// handles negative coordinates (chunks exist at negative cx/cy). This replaces
// the sequential-rng lattice of valueNoise with a coordinate-addressable one so
// any lattice node is reproducible without generating its neighbors.
function hash2(seed, x, y) {
  let h = seed >>> 0;
  h = Math.imul(h ^ (x | 0), 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h ^ (y | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Value noise sampled at ABSOLUTE world coords: bilinear-interpolate the four
// hashed lattice nodes surrounding (gRow, gCol). Same coords -> same value,
// regardless of which chunk asks -> adjacent chunks are continuous.
function globalValueNoise(seed, gRow, gCol, cellSize) {
  const gy = gRow / cellSize, gx = gCol / cellSize;
  const y0 = Math.floor(gy), x0 = Math.floor(gx);
  const sy = smoothstep(gy - y0), sx = smoothstep(gx - x0);
  const v00 = hash2(seed, x0, y0),     v10 = hash2(seed, x0 + 1, y0);
  const v01 = hash2(seed, x0, y0 + 1), v11 = hash2(seed, x0 + 1, y0 + 1);
  const top = v00 + (v10 - v00) * sx;
  const bot = v01 + (v11 - v01) * sx;
  return top + (bot - top) * sy;
}

// Value-noise field: a coarse random lattice (cellSize apart) smoothly
// interpolated to full resolution -> contiguous low-frequency regions.
function valueNoise(rows, cols, cellSize, rng) {
    const gRows = Math.ceil(rows / cellSize) + 2;
    const gCols = Math.ceil(cols / cellSize) + 2;
    const lattice = Array.from({ length: gRows }, () =>
        Array.from({ length: gCols }, () => rng()));

    const smooth = (t) => t * t * (3 - 2 * t); // smoothstep
    const field = [];
    for (let r = 0; r < rows; r++) {
        field[r] = [];
        for (let c = 0; c < cols; c++) {
            const gy = r / cellSize, gx = c / cellSize;
            const y0 = Math.floor(gy), x0 = Math.floor(gx);
            const sy = smooth(gy - y0), sx = smooth(gx - x0);
            const v00 = lattice[y0][x0], v10 = lattice[y0][x0 + 1];
            const v01 = lattice[y0 + 1][x0], v11 = lattice[y0 + 1][x0 + 1];
            const top = v00 + (v10 - v00) * sx;
            const bot = v01 + (v11 - v01) * sx;
            field[r][c] = top + (bot - top) * sy;
        }
    }
    return field;
}

// Pick a tile to use for carved paths: honor an explicit option, else the
// first tile whose name looks path-like, else null (skip path carving).
const PATH_NAME_RE = /path|dirt|road|trail|earth|sand/i;
function detectPathTile(tileNames, override) {
    if (override && tileNames.includes(override)) return override;
    return tileNames.find((n) => PATH_NAME_RE.test(n)) || null;
}

// Normalize a world config, applying defaults and deriving name lists. Throws
// on empty tileTypes (a world must have at least one tile).
function worldConfig(world = {}) {
  const tileTypes = world.tileTypes || {};
  const names = Object.keys(tileTypes);
  if (names.length === 0) throw new Error('worldConfig: tileTypes is empty');
  const pathTile = world.pathTile !== undefined
    ? world.pathTile
    : detectPathTile(names);
  const biomeNames = pathTile && names.length > 1
    ? names.filter((n) => n !== pathTile)
    : names;
  return {
    seed: world.seed || 0,
    chunkSize: world.chunkSize || 64,
    cellSize: world.cellSize || 8,
    pathCell: world.pathCell || 24,
    pathJitter: world.pathJitter || 6,
    pathTile,
    names,
    biomeNames,
    bounds: (world.width && world.height) ? {
      width: world.width,
      height: world.height,
      wallTile: world.wallTile || 'map_wall',
      doorwayTile: world.doorwayTile || 'map_doorway',
      doorways: world.doorways instanceof Set ? world.doorways : new Set(world.doorways || []),
    } : null,
  };
}

// Biome tile name at absolute world coords: band the global noise value across
// the biome names (path tile excluded — paths are stamped separately).
function sampleBiome(cfg, gRow, gCol) {
  const v = globalValueNoise(cfg.seed, gRow, gCol, cfg.cellSize);
  const idx = Math.min(cfg.biomeNames.length - 1, Math.floor(v * cfg.biomeNames.length));
  return cfg.biomeNames[idx];
}

// Coherent overview grid for a world preview: a dim x dim CONTIGUOUS window of
// the world centered on origin, rendered at full resolution the same way
// generateRegion builds gameplay chunks — so it carries both biomes and carved
// paths and reads like a hand-authored map.
//
// The previous implementation point-sampled one biome value every `stride`
// world tiles. With stride equal to the biome noise cellSize (both 8), every
// preview cell landed in a different lattice cell and the smooth interpolation
// was skipped entirely, aliasing the field into per-tile confetti. A contiguous
// window samples the same smooth field at full resolution instead. Pure +
// deterministic.
function generateWorldPreview(world, dim) {
  const origin = -Math.floor(dim / 2);
  return generateRegion(world, origin, origin, dim, dim);
}

// Generate an arbitrary rows x cols window of the world. Cell [r][c] is the
// world tile at (rMin + r, cMin + c). Overlays carved paths on biomes.
// generateChunk is a fixed-size wrapper over this.
function generateRegion(world, rMin, cMin, rows, cols) {
  const cfg = worldConfig(world);
  const paths = collectPathCells(cfg, rMin, cMin, rows, cols);
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = new Array(cols);
    for (let c = 0; c < cols; c++) {
      const gRow = rMin + r, gCol = cMin + c;
      row[c] = cfg.pathTile && paths.has(`${gRow},${gCol}`)
        ? cfg.pathTile
        : sampleBiome(cfg, gRow, gCol);
    }
    grid[r] = row;
  }
  if (cfg.bounds) stampBounds(grid, rMin, cMin, rows, cols, cfg.bounds);
  return grid;
}

function generateChunk(world, cx, cy) {
  const cfg = worldConfig(world);
  const N = cfg.chunkSize;
  return generateRegion(world, cy * N, cx * N, N, N);
}

// --- Global carved paths --------------------------------------------------
//
// Coarse path lattice: one anchor per `pathCell` tiles, jittered deterministically.
// Each anchor connects to its East and South neighbor via a biased random walk
// seeded ONLY by the two node ids -> the same trail cells regardless of which
// window regenerates them, so paths cross chunk seams continuously.

function pathAnchor(cfg, pi, pj) {
  const jr = Math.floor(hash2(cfg.seed ^ 0x1111, pi, pj) * (2 * cfg.pathJitter + 1)) - cfg.pathJitter;
  const jc = Math.floor(hash2(cfg.seed ^ 0x2222, pi, pj) * (2 * cfg.pathJitter + 1)) - cfg.pathJitter;
  return [pi * cfg.pathCell + jr, pj * cfg.pathCell + jc];
}

function pathSegmentCells(cfg, pi, pj, dir) {
  const from = pathAnchor(cfg, pi, pj);
  const to = dir === 'E' ? pathAnchor(cfg, pi, pj + 1) : pathAnchor(cfg, pi + 1, pj);
  // Deterministic per-segment RNG: distinct integer per (node, dir).
  const segSeed = (Math.imul(hash2(cfg.seed, pi, pj) * 4294967296 >>> 0, 31)
    ^ (dir === 'E' ? 0xE : 0x5)) >>> 0;
  const rng = makeRng(segSeed || 1);
  const cells = [];
  let [r, c] = from;
  const [tr, tc] = to;
  let guard = (cfg.pathCell + 2 * cfg.pathJitter) * 6 + 8;
  while ((r !== tr || c !== tc) && guard-- > 0) {
    cells.push([r, c]);
    const dr = Math.sign(tr - r), dc = Math.sign(tc - c);
    const roll = rng();
    if (roll < 0.45 && dr !== 0) r += dr;
    else if (roll < 0.9 && dc !== 0) c += dc;
    else if (rng() < 0.5 && dr !== 0) r += dr;
    else if (dc !== 0) c += dc;
    else if (dr !== 0) r += dr;
  }
  cells.push([tr, tc]);
  return cells;
}

// Every path cell inside the window [rMin,rMin+rows) x [cMin,cMin+cols).
// Iterate coarse nodes whose segments could reach the window (one extra ring),
// union their segment cells, clipped to the window.
function collectPathCells(cfg, rMin, cMin, rows, cols) {
  const set = new Set();
  if (!cfg.pathTile) return set;
  const rMax = rMin + rows, cMax = cMin + cols;
  // Coarse-node index range covering the window, padded so trails entering
  // from outside are included. A node's segment can reach up to pathJitter
  // tiles beyond its nominal pathCell span (anchor jitter), so the padding
  // ring must cover that reach -- not just a fixed 1 node -- or a window
  // computed narrowly could miss cells a wider region would include.
  const pad = Math.ceil(cfg.pathJitter / cfg.pathCell) + 1;
  const piLo = Math.floor(rMin / cfg.pathCell) - pad;
  const piHi = Math.floor((rMax - 1) / cfg.pathCell) + pad;
  const pjLo = Math.floor(cMin / cfg.pathCell) - pad;
  const pjHi = Math.floor((cMax - 1) / cfg.pathCell) + pad;
  const add = (cells) => {
    for (const [r, c] of cells) {
      if (r >= rMin && r < rMax && c >= cMin && c < cMax) set.add(`${r},${c}`);
    }
  };
  for (let pi = piLo; pi <= piHi; pi++) {
    for (let pj = pjLo; pj <= pjHi; pj++) {
      add(pathSegmentCells(cfg, pi, pj, 'E'));
      add(pathSegmentCells(cfg, pi, pj, 'S'));
    }
  }
  return set;
}

// Global object-density field at absolute coords. Independent frequency + seed
// offset from the biome field so object clumps don't mirror biome bands. Read
// by later phases to place clustered objects/creatures consistently across
// chunk seams. Deterministic and continuous.
function densityAt(world, gRow, gCol) {
  const cfg = worldConfig(world);
  return globalValueNoise((cfg.seed ^ 0x9e3779b9) >>> 0, gRow, gCol, cfg.cellSize);
}

const CREATURE_TILE_PX = 100;      // world px per tile (matches frontend MAP_TILE_SIZE)
const CREATURE_SALT = 0x5eed1e;    // separate the creature roll from terrain fields
const CREATURE_SPAWN_CHANCE = 0.01; // ~1% of tiles seed a creature (sparse)

// Deterministic per-chunk creature spawn. Pure function of (seed, cx, cy,
// creatureTypes). Each tile gets a seeded roll; a hit spawns a creature of a
// deterministically-picked type at the tile center (world pixels). Empty
// creatureTypes -> no creatures.
function spawnChunkCreatures(world, cx, cy, creatureTypes) {
  if (!creatureTypes || creatureTypes.length === 0) return [];
  const cfg = worldConfig(world);
  const N = cfg.chunkSize;
  const out = [];
  for (let lr = 0; lr < N; lr++) {
    for (let lc = 0; lc < N; lc++) {
      const gRow = cy * N + lr;
      const gCol = cx * N + lc;
      const roll = hash2(cfg.seed ^ CREATURE_SALT, gCol, gRow);
      if (roll >= CREATURE_SPAWN_CHANCE) continue;
      // pick a type deterministically from a second hash
      const pick = hash2((cfg.seed ^ CREATURE_SALT) >>> 1, gCol, gRow);
      const t = creatureTypes[Math.min(creatureTypes.length - 1, Math.floor(pick * creatureTypes.length))];
      out.push({
        type: t.name,
        x: gCol * CREATURE_TILE_PX + CREATURE_TILE_PX / 2,
        y: gRow * CREATURE_TILE_PX + CREATURE_TILE_PX / 2,
        hp: t.hp || 10,
        facing: 'S',
        // Carried from the entity type so a spawned creature arrives with the
        // data CreatureSim builds its `mit` from.
        defense: Number(t.defense ?? 0) || 0,
        resistances: t.resistances || {},
      });
    }
  }
  return out;
}

// Count-based creature placement for a BOUNDED map. Rejection-samples `count`
// interior tiles (strictly inside the wall ring), keeping only walkable,
// non-wall, non-doorway tiles, and assigns a random allowed type. Pure and
// deterministic given `rngSeed`. Returns rows shaped like spawnChunkCreatures.
// Unbounded worlds return [] (they keep the per-chunk roll).
function placeMapCreatures(world, count, allowedTypes, rngSeed, maxAttempts = 40) {
  const cfg = worldConfig(world);
  if (!cfg.bounds) return [];
  if (!count || count < 1) return [];
  if (!allowedTypes || allowedTypes.length === 0) return [];
  const { width, height, wallTile, doorwayTile } = cfg.bounds;
  const rLo = 1, rHi = height - 2, cLo = 1, cHi = width - 2;
  if (rHi < rLo || cHi < cLo) return [];
  const rng = makeRng(rngSeed >>> 0);
  const out = [];
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < maxAttempts; a++) {
      const row = rLo + Math.floor(rng() * (rHi - rLo + 1));
      const col = cLo + Math.floor(rng() * (cHi - cLo + 1));
      const name = generateRegion(world, row, col, 1, 1)[0][0];
      if (name === wallTile || name === doorwayTile) continue;
      const def = world.tileTypes && world.tileTypes[name];
      if (def && def.walkable === false) continue;
      const t = allowedTypes[Math.floor(rng() * allowedTypes.length)];
      out.push({
        type: t.name,
        x: col * CREATURE_TILE_PX + CREATURE_TILE_PX / 2,
        y: row * CREATURE_TILE_PX + CREATURE_TILE_PX / 2,
        hp: t.hp || 10,
        facing: 'S',
        defense: Number(t.defense ?? 0) || 0,
        resistances: t.resistances || {},
      });
      break;
    }
  }
  return out;
}

// --- Bounded-world boundary overlay ---------------------------------------
//
// A bounded world is a width x height tile rectangle. Its outer ring is a solid
// wall; each edge listed in `doorways` gets a centered DOORWAY_TILES-wide
// passable gap. Cells outside the rectangle are wall too, so a chunk fetched
// beyond the bound reads as solid. Pure overlay applied after biome+path fill.

const DOORWAY_TILES = 3; // width of a doorway gap, in tiles (centered on its edge)

function isDoorwayCell(gRow, gCol, width, height, doorways) {
  const half = Math.floor(DOORWAY_TILES / 2);
  const midCol = Math.floor(width / 2);
  const midRow = Math.floor(height / 2);
  if (doorways.has('N') && gRow === 0 && gCol >= midCol - half && gCol <= midCol + half) return true;
  if (doorways.has('S') && gRow === height - 1 && gCol >= midCol - half && gCol <= midCol + half) return true;
  if (doorways.has('W') && gCol === 0 && gRow >= midRow - half && gRow <= midRow + half) return true;
  if (doorways.has('E') && gCol === width - 1 && gRow >= midRow - half && gRow <= midRow + half) return true;
  return false;
}

function stampBounds(grid, rMin, cMin, rows, cols, bounds) {
  const { width, height, wallTile, doorwayTile, doorways } = bounds;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gRow = rMin + r, gCol = cMin + c;
      const outside = gRow < 0 || gRow >= height || gCol < 0 || gCol >= width;
      if (outside) { grid[r][c] = wallTile; continue; }
      const onRing = gRow === 0 || gRow === height - 1 || gCol === 0 || gCol === width - 1;
      if (onRing) {
        grid[r][c] = isDoorwayCell(gRow, gCol, width, height, doorways) ? doorwayTile : wallTile;
      }
    }
  }
  return grid;
}

// Which edges of a bounded world have a doorway. Slice 1: every edge, so a
// bounded world is traversable for testing. Slice 3 replaces the body with a
// lookup of map_links (only linked edges get a doorway). Callers pass the raw
// `worlds` DB row.
function doorwaysForWorld(worldRow) {
  if (!worldRow || !worldRow.width || !worldRow.height) return new Set();
  return new Set(['N', 'E', 'S', 'W']);
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Biased random walk from `from` to `to`, stamping pathTile. Mostly steps
// toward the target but jitters laterally so trails wind instead of running
// straight. Bounded by a guard so it always terminates.
function walkPath(grid, rows, cols, from, to, pathTile, rng) {
    let [r, c] = from;
    const [tr, tc] = to;
    let guard = (rows + cols) * 4;
    while ((r !== tr || c !== tc) && guard-- > 0) {
        grid[r][c] = pathTile;
        const dr = Math.sign(tr - r), dc = Math.sign(tc - c);
        const roll = rng();
        if (roll < 0.45 && dr !== 0) r += dr;
        else if (roll < 0.9 && dc !== 0) c += dc;
        else if (rng() < 0.5) r = clamp(r + (rng() < 0.5 ? -1 : 1), 0, rows - 1);
        else c = clamp(c + (rng() < 0.5 ? -1 : 1), 0, cols - 1);
    }
    grid[tr][tc] = pathTile;
}

function carvePaths(grid, rows, cols, pathTile, anchorCount, rng) {
    const anchors = [];
    for (let i = 0; i < anchorCount; i++) {
        anchors.push([Math.floor(rng() * rows), Math.floor(rng() * cols)]);
    }
    for (let i = 0; i < anchors.length - 1; i++) {
        walkPath(grid, rows, cols, anchors[i], anchors[i + 1], pathTile, rng);
    }
    return anchors;
}

function generateWorld(rows, cols, tileTypes, options = {}) {
    const names = Object.keys(tileTypes || {});
    if (names.length === 0) {
        return Array.from({ length: rows }, () => Array(cols).fill('grass'));
    }

    const {
        seed = 0,
        cellSize = Math.max(4, Math.round(Math.min(rows, cols) / 8)),
        anchors = 4,
        pathTile = detectPathTile(names),
    } = options;

    const rng = makeRng(seed);

    // Stage A: biome field -> map each tile's noise value to a tile-type band.
    // Exclude the path tile from the biome bands (when other tiles exist) so
    // carved paths read as distinct trails rather than blending into a biome.
    const biomeNames = pathTile && names.length > 1
        ? names.filter((n) => n !== pathTile)
        : names;
    const field = valueNoise(rows, cols, cellSize, rng);
    const grid = field.map((row) => row.map((v) => {
        const idx = Math.min(biomeNames.length - 1, Math.floor(v * biomeNames.length));
        return biomeNames[idx];
    }));

    // Stage B: carve winding paths between anchor points (if a path tile exists).
    if (pathTile) {
        carvePaths(grid, rows, cols, pathTile, anchors, rng);
    }

    return grid;
}

// --- Density-driven object placement --------------------------------------
//
// Replaces the flat per-tile `Math.random() < chance` roll (which scatters
// objects uniformly) with a smooth density field so objects CLUMP: forests
// form dense stands, open ground stays sparse, carved paths and deliberate
// clearings stay empty, and optional landmarks seed dense groves.
//
// entityDefs: [{ chance, spawnTiles: string[], ...anything }]. Returns
// { placed: [{ def, row, col }], clearings: [[r,c]], landmarks: [[r,c]] }.
function uniqueTileNames(tiles) {
    const s = new Set();
    for (const row of tiles) for (const t of row) s.add(t);
    return [...s];
}

function placeEntities(tiles, entityDefs, options = {}) {
    const rows = tiles.length;
    const cols = rows ? tiles[0].length : 0;
    if (!rows || !cols || !entityDefs || entityDefs.length === 0) {
        return { placed: [], clearings: [], landmarks: [] };
    }

    const {
        seed = 0,
        cellSize = Math.max(4, Math.round(Math.min(rows, cols) / 8)),
        clearings = 3,
        landmarks = 1,
        fill = 0.85,   // fraction of an in-clump tile that actually gets an object
        gain = 3,      // how much a def's `chance` expands into contiguous area
        pathTiles = detectPathTile(uniqueTileNames(tiles)),
    } = options;

    const pathSet = new Set(
        Array.isArray(pathTiles) ? pathTiles : (pathTiles ? [pathTiles] : [])
    );

    const rng = makeRng(seed);
    const field = valueNoise(rows, cols, cellSize, rng);
    // Hard-exclusion mask (clearings): kept separate from the density field so
    // a clearing stays empty even when a high `chance` pushes the threshold to 0.
    const blocked = Array.from({ length: rows }, () => new Array(cols).fill(false));

    const disc = (cr, cc, radius, fn) => {
        for (let r = Math.max(0, cr - radius); r <= Math.min(rows - 1, cr + radius); r++) {
            for (let c = Math.max(0, cc - radius); c <= Math.min(cols - 1, cc + radius); c++) {
                if ((r - cr) ** 2 + (c - cc) ** 2 <= radius * radius) fn(r, c);
            }
        }
    };

    const radius = Math.max(2, Math.round(Math.min(rows, cols) / 10));
    const clearingCenters = [];
    for (let i = 0; i < clearings; i++) {
        const cr = Math.floor(rng() * rows), cc = Math.floor(rng() * cols);
        clearingCenters.push([cr, cc]);
        disc(cr, cc, radius, (r, c) => { blocked[r][c] = true; }); // open clearing
    }
    const landmarkCenters = [];
    for (let i = 0; i < landmarks; i++) {
        const cr = Math.floor(rng() * rows), cc = Math.floor(rng() * cols);
        landmarkCenters.push([cr, cc]);
        disc(cr, cc, Math.max(2, Math.round(radius * 0.6)), (r, c) => { field[r][c] = 1; }); // dense grove
    }

    const placed = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const t = tiles[r][c];
            if (pathSet.has(t) || blocked[r][c]) continue; // paths + clearings stay open
            const d = field[r][c];
            for (const def of entityDefs) {
                const spawn = def.spawnTiles || def.spawn_tiles;
                if (!spawn || !spawn.includes(t)) continue;
                const threshold = 1 - clamp((def.chance || 0) * gain, 0, 1);
                if (d >= threshold && rng() < fill) {
                    placed.push({ def, row: r, col: c });
                    break; // one object per tile
                }
            }
        }
    }

    return { placed, clearings: clearingCenters, landmarks: landmarkCenters };
}

module.exports = {
    generateWFC,
    generateWorld,
    placeEntities,
    // exported for unit testing / reuse
    makeRng,
    valueNoise,
    detectPathTile,
    carvePaths,
    uniqueTileNames,
    hash2,
    globalValueNoise,
    worldConfig,
    sampleBiome,
    generateWorldPreview,
    generateRegion,
    generateChunk,
    pathAnchor,
    pathSegmentCells,
    collectPathCells,
    densityAt,
    spawnChunkCreatures,
    placeMapCreatures,
    stampBounds,
    doorwaysForWorld,
    DOORWAY_TILES,
};

