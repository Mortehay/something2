const { rollCreatureLevel, scaleCreature } = require('./creatureLevel');
// inBox is re-exported below as pointInVillageBox: it used to be a
// byte-for-byte duplicate of safeRegion.js's own box test, the same
// duplicated-geometry trap this repo already carries once (resolveMove).
// safeRegion.js imports nothing (see its header -- a require back into this
// module would be a cycle), so the box test lives there and this module is
// the one that imports it, never the reverse.
const { buildSafeContext, isSafeTile, inBox: pointInVillageBox } = require('./safeRegion');
const { buildDensityField } = require('./creatureDensityField');

// generateWFC() (a wave-function-collapse generator driven by
// tile_types.valid_neighbors) was removed here as dead code (F-010 /
// SOMET-190): it had zero callers anywhere in the codebase outside its own
// definition -- world generation goes through generateWorld/generateRegion
// below instead, which never reads valid_neighbors. The valid_neighbors
// column, its CRUD in index.js, and its checkbox editor in
// frontend/src/games/something2/TileTypesAdmin.jsx were deliberately left in
// place: removing them is a product decision (wire generateWorld to honour
// the field, or drop the column/editor entirely) that spans a migration and
// the frontend, both out of scope for this backend-api pass. See the
// SOMET-190 fix commit message for the full reasoning.

// --- Layered world generation (biomes -> paths) ---------------------------
//
// generateWorld builds large-scale structure the way a hand-authored
// overworld reads: cohesive biome regions from low-frequency noise, then
// winding paths carved between anchor points. Output is a rows x cols grid
// of tile-type NAMES, so storage/API/loader are unchanged. Deterministic for
// a given seed.

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

// Structural overlay tiles are stamped explicitly (stampBounds / stampVillage),
// never sampled as biome terrain. Excluded from biome bands so they don't leak
// into generated terrain as random impassable blobs.
const STRUCTURAL_TILES = new Set(['map_wall', 'map_doorway', 'wooden_wall', 'village_gate']);

function detectPathTile(tileNames, override) {
    if (override && tileNames.includes(override)) return override;
    return tileNames.find((n) => PATH_NAME_RE.test(n)) || null;
}

// A biome's terrain list, reduced to tiles this world can actually place:
// present in the catalog, not a structural overlay tile. Unlike the global
// `cfg.terrainNames` list (which DOES exclude the path tile, so carved paths
// read as distinct from the terrain around them, and preserves byte-identical
// output for biome-less worlds — do not touch that exclusion), a biome's
// terrain list is authored intent: if an admin lists the path tile as part of
// a biome (e.g. `sand` in a desert biome), it must appear as regular terrain,
// not just in carved path ribbons. The cost is only cosmetic — in a biome that
// itself contains the path tile, carved paths blend into the terrain, which is
// acceptable and arguably natural. Structural tiles stay excluded: those are
// stamped overlays and would generate as impassable blobs if sampled as terrain.
// A biome that filters down to nothing (references only deleted or structural
// tiles) must not yield `undefined` tile names, so callers fall back to the
// global list — see sampleTerrain.
function biomeTerrainNames(biome, names) {
  return (biome.terrain_tiles || []).filter(
    (n) => names.includes(n) && !STRUCTURAL_TILES.has(n),
  );
}

// Normalize raw biome rows (services/biomes.js shape) into the compact records
// the samplers use. Done once per worldConfig call rather than per tile.
function normalizeBiomes(rawBiomes, names) {
  if (!Array.isArray(rawBiomes)) return [];
  return rawBiomes
    .filter((b) => b && typeof b.name === 'string')
    .map((b) => ({
      name: b.name,
      terrainNames: biomeTerrainNames(b, names),
      floraTypes: Array.isArray(b.flora_types) ? b.flora_types : [],
      creatureTypes: Array.isArray(b.creature_types) ? b.creature_types : [],
      // The creature-density field's biome term (Slice A). Anything that is
      // not a positive finite number becomes 1.0 -- "no opinion" -- rather
      // than 0 or NaN: a 0 would make a biome silently uninhabitable and a
      // NaN would poison the whole normalized field through the mean.
      creatureDensity: (Number.isFinite(b.creature_density) && b.creature_density > 0)
        ? Number(b.creature_density) : 1,
    }));
}

// Biome-field noise cell size, in tiles. A world wants roughly
// min(width, height) / 3 so each biome gets a visible region instead of one
// biome swallowing the map; that is the derived default when the world does
// not pin `biomeCell`. Unbounded worlds have no size to derive from.
const DEFAULT_BIOME_CELL = 24;
function resolveBiomeCell(world) {
  if (Number.isFinite(world.biomeCell)) {
    const floored = Math.floor(world.biomeCell);
    // A floored value < 1 (fractional 0<x<1, zero, or negative) would divide
    // globalValueNoise by zero or a negative cell size -- NaN propagates
    // through Math.floor(NaN * length) into an out-of-bounds array index,
    // silently returning `undefined` from sampleBiomeRegion in violation of
    // its `record | null` contract. Fall through to the derived/default cell
    // instead of trusting a value this small.
    if (floored >= 1) return floored;
  }
  if (world.width && world.height) {
    return Math.max(8, Math.floor(Math.min(world.width, world.height) / 3));
  }
  return DEFAULT_BIOME_CELL;
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
  const nonStructural = names.filter((n) => !STRUCTURAL_TILES.has(n));
  const biomeSource = nonStructural.length > 0 ? nonStructural : names;
  const terrainNames = pathTile && biomeSource.length > 1
    ? biomeSource.filter((n) => n !== pathTile)
    : biomeSource;
  return {
    seed: world.seed || 0,
    chunkSize: world.chunkSize || 64,
    cellSize: world.cellSize || 8,
    pathCell: world.pathCell || 24,
    pathJitter: world.pathJitter || 6,
    pathTile,
    names,
    terrainNames,
    biomes: normalizeBiomes(world.biomes, names),
    biomeCell: resolveBiomeCell(world),
    bounds: (world.width && world.height) ? {
      width: world.width,
      height: world.height,
      wallTile: world.wallTile || 'map_wall',
      doorwayTile: world.doorwayTile || 'map_doorway',
      doorways: world.doorways instanceof Set ? world.doorways : new Set(world.doorways || []),
    } : null,
    villages: Array.isArray(world.villages) && world.villages.length
      ? world.villages.map((v) => ({
          id: v.id,
          minRow: v.minRow, minCol: v.minCol,
          width: v.width, height: v.height,
          gateEdge: v.gateEdge,
          spawnX: v.spawnX, spawnY: v.spawnY,
          wallTile: 'wooden_wall', gateTile: 'village_gate',
        }))
      : null,
    // SOMET-288. safeRegion.buildSafeContext does the real normalization (a
    // junk radius becomes 0, never NaN); the radius is coerced here as well so
    // a hand-built test world and a world that came through
    // buildWorldGenConfig present the same shape, and so `cfg.safeRoadRadius`
    // is always a number for the `radius > 0` short-circuit in safeContextFor.
    safeRoadRadius: Number(world.safeRoadRadius) || 0,
    // The rectangles are passed through UNTOUCHED on purpose. This line used to
    // read `Array.isArray(world.safeRects) ? world.safeRects : []`, which
    // swallowed a malformed value into "no rectangles at all" before
    // buildSafeContext -- the single validator, which THROWS -- ever saw it.
    // An authored rectangle that quietly does not exist is exactly the failure
    // safeRegion.normalizeSafeRects was written to make impossible.
    safeRects: world.safeRects,
    // SOMET-289. Normalized (and THROWN on) here rather than passed through,
    // because unlike safeRects there is no second validator downstream: nothing
    // between this and collectPathCells' walker would notice a malformed
    // polyline, and the walker itself would either loop forever on a
    // non-axis-aligned segment or silently draw nothing on a malformed point.
    authoredRoads: normalizeAuthoredRoads(world.authoredRoads),
  };
}

// Decorrelates the biome field from the terrain field. Sharing a seed would
// put every region border exactly on a terrain-band border and collapse the
// two-level sampler back into one level.
const BIOME_FIELD_XOR = 0x6a09e667;

// Which biome owns this absolute cell, or null when the world declares none.
// Coarse global noise (biomeCell >> cellSize), so regions read as places and
// stay continuous across chunk borders for the same reason terrain does.
function sampleBiomeRegion(cfg, gRow, gCol) {
  if (cfg.biomes.length === 0) return null;
  const v = globalValueNoise((cfg.seed ^ BIOME_FIELD_XOR) >>> 0, gRow, gCol, cfg.biomeCell);
  return cfg.biomes[Math.min(cfg.biomes.length - 1, Math.floor(v * cfg.biomes.length))];
}

// Terrain tile name at absolute world coords: band the global terrain noise
// across the names available AT THIS CELL -- the owning biome's list when the
// world has biomes, else every non-structural tile (the pre-biome behaviour,
// preserved bit-for-bit: same seed, same field, same name list). A biome whose
// list filtered down to nothing falls back to the global list rather than
// producing undefined tiles. Only the global list excludes the path tile; a
// biome's own list keeps it if authored that way (see biomeTerrainNames) --
// paths are stamped separately over whichever terrain sampleTerrain picked.
function sampleTerrain(cfg, gRow, gCol) {
  const region = sampleBiomeRegion(cfg, gRow, gCol);
  const names = (region && region.terrainNames.length) ? region.terrainNames : cfg.terrainNames;
  const v = globalValueNoise(cfg.seed, gRow, gCol, cfg.cellSize);
  return names[Math.min(names.length - 1, Math.floor(v * names.length))];
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

// Player-centered coarse overview for the in-game minimap. Distinct from
// generateWorldPreview (fixed origin window): this window follows the player.
// Snapping the center to a span/4 grid keeps the response cacheable — small
// moves reuse the same window.
function overviewOrigin(centerCol, centerRow, span) {
  const half = Math.floor(span / 2);
  const snap = Math.max(1, Math.floor(span / 4));
  const snappedCol = Math.round(centerCol / snap) * snap;
  const snappedRow = Math.round(centerRow / snap) * snap;
  return { snappedCol, snappedRow, originCol: snappedCol - half, originRow: snappedRow - half };
}

function overviewDoorwayMarkers(world) {
  if (!world.width || !world.height) return [];
  const W = world.width, H = world.height;
  const midW = Math.floor(W / 2), midH = Math.floor(H / 2);
  const at = { N: { col: midW, row: 0 }, S: { col: midW, row: H - 1 }, W: { col: 0, row: midH }, E: { col: W - 1, row: midH } };
  return (world.doorways || []).filter((e) => at[e]).map((e) => ({ edge: e, ...at[e] }));
}

function overviewVillageMarkers(world) {
  return (world.villages || []).map((v) => ({
    col: v.minCol + Math.floor(v.width / 2),
    row: v.minRow + Math.floor(v.height / 2),
  }));
}

function generateWorldOverview(world, centerCol, centerRow, span, step) {
  const { originCol, originRow } = overviewOrigin(centerCol, centerRow, span);
  // One contiguous span×span generation, then sample every `step`th tile —
  // far cheaper than one generateRegion call per coarse cell.
  const full = generateRegion(world, originRow, originCol, span, span);
  const rows = Math.floor(span / step), cols = Math.floor(span / step);
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    const row = new Array(cols);
    for (let c = 0; c < cols; c++) row[c] = full[r * step][c * step];
    tiles[r] = row;
  }
  return {
    step, originCol, originRow, cols, rows, tiles,
    doorways: overviewDoorwayMarkers(world),
    villages: overviewVillageMarkers(world),
  };
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
        : sampleTerrain(cfg, gRow, gCol);
    }
    grid[r] = row;
  }
  if (cfg.bounds) stampBounds(grid, rMin, cMin, rows, cols, cfg.bounds);
  if (cfg.villages) {
    for (const v of cfg.villages) stampVillage(grid, rMin, cMin, rows, cols, v);
  }
  return grid;
}

function generateChunk(world, cx, cy) {
  const cfg = worldConfig(world);
  const N = cfg.chunkSize;
  return generateRegion(world, cy * N, cx * N, N, N);
}

// Decoration placement tuning. The density field uses a seed derived from the
// world seed (distinct from terrain) so decoration clumps don't align with
// biome bands. GAIN expands a def's `chance` into contiguous area; FILL is the
// fraction of an in-clump eligible tile that actually gets an object.
const DECO_SEED_XOR = 0x9e3779b9; // density-field seed (where clumps form)
const DECO_FILL_XOR = 0x85ebca6b; // gap roll seed (holes inside a clump)
const DECO_PICK_XOR = 0x27d4eb2d; // weighted type-pick seed (which def wins a tile)
const DECO_CELL = 6;              // clump cell size (smaller = tighter stands)
const DECO_DENSITY = 0.58;        // a tile is "in a clump" when the density field >= this
const DECO_FILL = 0.6;            // fraction of in-clump tiles that actually get an object
const SPAWN_CLEAR_RADIUS = 1;     // Chebyshev tiles around entry spawn kept clear of blockers

// SOMET-339 — the lane kept clear of blockers directly outside a village gate.
//
// LENGTH is DECO_CELL, not a round number picked by feel: DECO_CELL is the
// clump cell size, so a lane that long is guaranteed to run past at least one
// whole clump rather than stopping inside the one sitting on the gate. HALFWIDTH
// gives the gate line one tile of slack either side, so a walker can step around
// a blocker that lands just off-centre instead of needing a pixel-perfect line.
const GATE_CORRIDOR_LENGTH = DECO_CELL;
const GATE_CORRIDOR_HALFWIDTH = 1;

// Entry-spawn tile (row,col) for a bounded world, or null. entry_spawn is world
// pixels; MAP_TILE_SIZE-agnostic here (100 px/tile, matching collision.js).
function spawnTileCell(world) {
  const sp = world.entry_spawn;
  if (!sp || typeof sp.x !== 'number' || typeof sp.y !== 'number') return null;
  return { row: Math.floor(sp.y / 100), col: Math.floor(sp.x / 100) };
}

// SOMET-339 — true when this absolute cell lies in the lane running outward
// from a village's gate.
//
// The midRow/midCol expressions are deliberately identical to villageGateCell's
// (and villageGatePoint's): all three must agree on which tile the gate is, or
// this clears a lane leading out of a wall. They are repeated rather than
// factored out for the same reason villageGatePoint repeats them — villageGateCell
// sits on the terrain stamper's hot per-tile loop — and are pinned by test
// instead. A village with no gateEdge has no corridor at all rather than a
// default one, because guessing an edge would clear a lane through solid wall.
function inGateCorridor(v, gRow, gCol) {
  if (!v.gateEdge) return false;
  const rMax = v.minRow + v.height - 1;
  const cMax = v.minCol + v.width - 1;
  const midCol = v.minCol + Math.floor(v.width / 2);
  const midRow = v.minRow + Math.floor(v.height / 2);
  const L = GATE_CORRIDOR_LENGTH;
  const H = GATE_CORRIDOR_HALFWIDTH;
  if (v.gateEdge === 'E') return gCol > cMax && gCol <= cMax + L && Math.abs(gRow - midRow) <= H;
  if (v.gateEdge === 'W') return gCol < v.minCol && gCol >= v.minCol - L && Math.abs(gRow - midRow) <= H;
  if (v.gateEdge === 'S') return gRow > rMax && gRow <= rMax + L && Math.abs(gCol - midCol) <= H;
  if (v.gateEdge === 'N') return gRow < v.minRow && gRow >= v.minRow - L && Math.abs(gCol - midCol) <= H;
  return false;
}

// True when a BLOCKING decoration must not occupy this absolute cell: within the
// spawn clear radius, inside a village footprint, or in the lane leading out of a
// village gate. (Path cells are excluded by the caller for ALL decorations,
// blocking or not.)
//
// The gate corridor is the SOMET-339 fix. Sparing only the footprint left the
// ground outside the gate fair game, so the clump field could wall a village in
// completely -- which is exactly what happened to the entry world: a solid
// blocking column one tile past the wall, and a new player sealed inside with a
// reachable area of nine tiles. It was survivable while players spawned outside
// a village (a sealed gate merely meant "cannot get in"); SOMET-335 moved the
// entry spawn inside one and turned it into "cannot play the game".
function isExcludedBlockerCell(cfg, spawn, gRow, gCol) {
  if (spawn && Math.max(Math.abs(gRow - spawn.row), Math.abs(gCol - spawn.col)) <= SPAWN_CLEAR_RADIUS) {
    return true;
  }
  if (cfg.villages) {
    for (const v of cfg.villages) {
      if (gRow >= v.minRow && gRow < v.minRow + v.height &&
          gCol >= v.minCol && gCol < v.minCol + v.width) return true;
      if (inGateCorridor(v, gRow, gCol)) return true;
    }
  }
  return false;
}

// Deterministic per-chunk decoration placement. Pure fn of (world, cx, cy, the
// chunk's generated tiles, decorationDefs). Reads the FINAL tile grid (so
// stamped walls/gates/village tiles are never decorated) and samples a GLOBAL
// density field at absolute coords, so clumps are continuous across chunk
// borders. Returns chunk-local [{ name, row, col, blocking }].
function generateChunkDecorations(world, cx, cy, tiles, decorationDefs) {
  if (!decorationDefs || decorationDefs.length === 0 || !tiles) return [];
  const cfg = worldConfig(world);
  const N = cfg.chunkSize;
  const rMin = cy * N, cMin = cx * N;
  const paths = collectPathCells(cfg, rMin, cMin, N, N);
  const spawn = spawnTileCell(world);
  const out = [];
  for (let r = 0; r < N; r++) {
    if (!tiles[r]) continue;
    for (let c = 0; c < N; c++) {
      const gRow = rMin + r, gCol = cMin + c;
      if (cfg.bounds && (gRow < 0 || gCol < 0 || gRow >= cfg.bounds.height || gCol >= cfg.bounds.width)) continue;
      if (paths.has(`${gRow},${gCol}`)) continue; // keep carved paths clear
      const terrain = tiles[r][c];
      // Two independent gates decide IF a tile gets an object: the density
      // field (where clumps form) and a per-tile fill roll (holes in a clump).
      const density = globalValueNoise((cfg.seed ^ DECO_SEED_XOR) >>> 0, gRow, gCol, DECO_CELL);
      if (density < DECO_DENSITY) continue;
      if (hash2((cfg.seed ^ DECO_FILL_XOR) >>> 0, gCol, gRow) >= DECO_FILL) continue;
      // WHICH types are eligible here at all: when the world has biomes, only
      // the flora the owning biome lists. Empty flora_types is a legitimate
      // authored choice ("this biome is barren"), not a config error -- there
      // is deliberately no fallback to the global def list.
      const region = sampleBiomeRegion(cfg, gRow, gCol);
      const flora = region ? region.floraTypes : null;
      // WHICH object: weighted pick among ALL defs whose spawn_tiles match this
      // terrain, weighted by `chance`. (Not first-match — that shadowed every
      // type but the lowest-id one on shared terrain.) Deterministic: the roll
      // is a seeded per-tile hash and `decorationDefs` is ORDER BY id.
      let totalW = 0;
      const matches = [];
      for (const def of decorationDefs) {
        if (flora && !flora.includes(def.name)) continue;
        const spawnTiles = def.spawn_tiles || def.spawnTiles;
        if (spawnTiles && spawnTiles.includes(terrain)) { matches.push(def); totalW += (def.chance || 0); }
      }
      if (matches.length === 0 || totalW <= 0) continue;
      let roll = hash2((cfg.seed ^ DECO_PICK_XOR) >>> 0, gCol, gRow) * totalW;
      let picked = matches[matches.length - 1];
      for (const def of matches) { roll -= (def.chance || 0); if (roll <= 0) { picked = def; break; } }
      const blocking = picked.walkable === false;
      // A blocking pick near spawn / in a village would trap the player -> skip
      // the tile entirely (leave it open) rather than force a passable type.
      if (blocking && isExcludedBlockerCell(cfg, spawn, gRow, gCol)) continue;
      out.push({ name: picked.name, row: r, col: c, blocking });
    }
  }
  return out;
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

// Cells of one authored polyline (SOMET-289). Consecutive points must be
// axis-aligned -- seeds/mapSpec.js rejects anything else, and normalizeAuthoredRoads
// below throws on it, so this walker never has to decide how to rasterise a
// diagonal. An author who cannot predict the cells cannot predict the safe
// corridor either.
//
// A one-point polyline is a single cell, not an error: a lone waypost-sized
// patch of road is a legitimate (if odd) thing to author, and silently dropping
// it would be the class of failure this whole feature exists to avoid.
function authoredLineCells(line, emit) {
  if (line.length === 1) { emit(line[0][0], line[0][1]); return; }
  for (let i = 0; i < line.length - 1; i++) {
    const [r0, c0] = line[i];
    const [r1, c1] = line[i + 1];
    const dr = Math.sign(r1 - r0);
    const dc = Math.sign(c1 - c0);
    let r = r0;
    let c = c0;
    emit(r, c);
    while (r !== r1 || c !== c1) {
      r += dr;
      c += dc;
      emit(r, c);
    }
  }
}

// THE validator for authored roads, and the reason it throws rather than
// coercing -- the same argument safeRegion.normalizeSafeRects makes. A
// malformed polyline has no safe fallback: the only one available is "this road
// does not exist", which is precisely the silent failure the column was added to
// end. A non-axis-aligned segment additionally has no defined meaning at all,
// and guessing one would put the drawn road somewhere the author did not choose.
function normalizeAuthoredRoads(authoredRoads) {
  if (authoredRoads === undefined || authoredRoads === null) return [];
  if (!Array.isArray(authoredRoads)) {
    throw new Error(`authoredRoads must be an array (got ${typeof authoredRoads})`);
  }
  for (let i = 0; i < authoredRoads.length; i++) {
    const line = authoredRoads[i];
    if (!Array.isArray(line) || line.length === 0) {
      throw new Error(`authoredRoads[${i}] must be a non-empty array of [row, col] points`);
    }
    for (let j = 0; j < line.length; j++) {
      const p = line[j];
      if (!Array.isArray(p) || p.length !== 2
          || !Number.isInteger(p[0]) || !Number.isInteger(p[1])) {
        throw new Error(
          `authoredRoads[${i}][${j}] must be a [row, col] pair of integers `
          + `(got ${JSON.stringify(p)})`);
      }
      if (j > 0 && line[j - 1][0] !== p[0] && line[j - 1][1] !== p[1]) {
        throw new Error(
          `authoredRoads[${i}] segment ${j - 1}->${j} is not axis-aligned `
          + `(${JSON.stringify(line[j - 1])} -> ${JSON.stringify(p)}) -- each pair of `
          + 'consecutive points must share a row or a column');
      }
    }
  }
  return authoredRoads;
}

// Every path cell inside the window [rMin,rMin+rows) x [cMin,cMin+cols).
// Iterate coarse nodes whose segments could reach the window (one extra ring),
// union their segment cells, clipped to the window.
//
// SOMET-289: cfg.authoredRoads is unioned in as well, clipped to the same
// window. THIS is the one place roads are derived, so an authored road is drawn
// by generateRegion (which stamps cfg.pathTile on whatever this returns) AND
// made safe by safeRegion (which is handed this same Set through
// safeContextFor) without either of them naming the feature. An empty
// authoredRoads adds nothing, so every world that has not opted in gets the
// byte-identical Set it got before.
function collectPathCells(cfg, rMin, cMin, rows, cols) {
  const set = new Set();
  // Authored roads share the lattice's fate on a world with no path tile:
  // generateRegion has nothing to draw them WITH, so a "safe road" that is
  // invisible would be worse than none. Inside the guard, not before it.
  if (!cfg.pathTile) return set;
  {
    const rMaxA = rMin + rows;
    const cMaxA = cMin + cols;
    for (const line of cfg.authoredRoads || []) {
      authoredLineCells(line, (r, c) => {
        if (r >= rMin && r < rMaxA && c >= cMin && c < cMaxA) set.add(`${r},${c}`);
      });
    }
  }
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

// densityAt() (a global object-density field) was removed here as dead code
// alongside generateWFC (F-010 / SOMET-190): despite its own comment
// claiming it was "read by later phases to place clustered objects/
// creatures", nothing in the codebase ever called it outside its own tests.

const CREATURE_TILE_PX = 100;      // world px per tile (matches frontend MAP_TILE_SIZE)
// LEVEL_SALT (a per-tile salt separating the level roll from the type-pick
// draw) was removed here alongside its only caller, the per-chunk random-roll
// spawn path retired as unreachable dead code (SOMET-246). It briefly survived
// that retirement as "kept in case a future per-tile path wants it again" --
// the same speculative justification the F-010 / SOMET-190 cleanup rejected
// for densityAt() a few lines above. placeMapCreatures and placeCreaturePacks
// separate their streams with their own salts and never needed it.
// The baseline a creature's damage scales from. Creature attack damage is
// otherwise the flat CREATURE_DAMAGE constant in authority/creatures.js; this
// mirrors it so an unscaled level-1 creature is byte-identical to today.
const CREATURE_BASE_DAMAGE = 5;

// The tile-validity rules every creature placement obeys, in ONE place.
//
// placeMapCreatures (scatter) and placeCreaturePacks must apply identical
// rules -- a pack must never stand somewhere scatter would refuse. Extracted
// rather than copied: two copies drift the first time either is edited, and
// this repo already carries one byte-for-byte duplicated movement routine as
// a standing hazard.
//
// One safe context per generation config (SOMET-288).
//
// Keyed on the cfg OBJECT, not on a world id: worldConfig() returns a fresh
// object per call and both placers call it exactly once at the top of a run, so
// this computes the whole map's road cells ONCE per placement run rather than
// once per rejection-sampling attempt -- of which there are up to 40 per
// creature. A WeakMap rather than a field on cfg so nothing observable is
// mutated and the entry dies with the config.
//
// The pathCells sweep is skipped entirely at radius 0, which is every world
// that has not opted in: an opted-out world must not pay for a feature it does
// not use, and collectPathCells over a whole map is not free.
const SAFE_CTX = new WeakMap();

function safeContextFor(cfg) {
  const hit = SAFE_CTX.get(cfg);
  if (hit) return hit;
  const radius = Number(cfg.safeRoadRadius) || 0;
  const ctx = buildSafeContext({
    villages: cfg.villages,
    pathCells: radius > 0 && cfg.bounds
      ? collectPathCells(cfg, 0, 0, cfg.bounds.height, cfg.bounds.width)
      : new Set(),
    safeRoadRadius: radius,
    safeRects: cfg.safeRects,
  });
  SAFE_CTX.set(cfg, ctx);
  return ctx;
}

// One density field per generation config, cached exactly as SAFE_CTX is and
// for the same reason: worldConfig() returns a fresh object per call, both
// placers call it once at the top of a run, and building the field walks the
// whole map. A WeakMap so nothing observable is mutated and the entry dies with
// the config.
//
// NOTE the argument order trap: this takes the ALREADY-NORMALIZED cfg that
// worldConfig returns, never a raw world row. worldConfig is not idempotent --
// it deliberately omits tileTypes, so worldConfig(worldConfig(x)) throws
// 'tileTypes is empty'.
const DENSITY_FIELD = new WeakMap();

function densityFieldFor(world) {
  const cfg = worldConfig(world);
  return densityFieldForConfig(cfg);
}

function densityFieldForConfig(cfg) {
  const hit = DENSITY_FIELD.get(cfg);
  if (hit) return hit;
  const safeCtx = safeContextFor(cfg);
  const field = buildDensityField(cfg, {
    safeAt: (r, c) => isSafeTile(safeCtx, r, c),
  }, {
    noise: globalValueNoise,
    regionAt: sampleBiomeRegion,
  });
  DENSITY_FIELD.set(cfg, field);
  return field;
}

// Returns the creature types the local biome admits here, or null if no
// creature may stand on this tile at all. The world's allowlist stays
// authoritative -- a biome can only REMOVE candidates from it, never add one.
function creatureTileCandidates(world, cfg, gRow, gCol, allowedTypes) {
  const { wallTile, doorwayTile } = cfg.bounds;
  const name = generateRegion(world, gRow, gCol, 1, 1)[0][0];
  if (name === wallTile || name === doorwayTile) return null;
  const def = world.tileTypes && world.tileTypes[name];
  if (def && def.walkable === false) return null;
  // SOMET-288. Subsumes the village check that used to stand here: a village
  // box is one of the three things isSafeTile calls safe, alongside the road
  // corridor and any authored rectangle. THIS is the single chokepoint --
  // placeMapCreatures, placeCreaturePacks, seeding via applyMapSpec and the
  // admin re-roll route all reach hostile placement through this function and
  // nowhere else, so the rule cannot be half-applied the way SOMET-153's
  // village geometry rule was.
  if (isSafeTile(safeContextFor(cfg), gRow, gCol)) return null;
  const region = sampleBiomeRegion(cfg, gRow, gCol);
  const candidates = region
    ? allowedTypes.filter((t) => region.creatureTypes.includes(t.name))
    : allowedTypes;
  return candidates.length ? candidates : null;
}

// Count-based creature placement for a BOUNDED map. Rejection-samples `count`
// interior tiles (strictly inside the wall ring), keeping only walkable,
// non-wall, non-doorway tiles, and assigns a random allowed type. Pure and
// deterministic given `rngSeed`. Returns rows shaped like placeCreaturePacks'.
// Unbounded worlds return [] (world creation now requires width and height
// together, SOMET-246, so this is a defensive no-op rather than a live path).
//
// `precomputedCfg`, if given, is used INSTEAD of calling worldConfig(world) --
// for a caller that must place creatures for the same world several times in
// one pass (creatureRespawn.js's per-sweep loop) and wants SAFE_CTX/
// DENSITY_FIELD's cfg-identity-keyed caches to hit on every call after the
// first, rather than rebuilding the O(width*height) BFS + normalization pass
// every time. Must be the exact object worldConfig(world) itself returned
// (worldConfig is not idempotent), and it is the caller's job to discard it
// rather than reuse it across a world re-roll or a later sweep pass -- this
// function does no caching of its own and does not remember what it is given.
function placeMapCreatures(world, count, allowedTypes, rngSeed, maxAttempts = 40, precomputedCfg = null) {
  const cfg = precomputedCfg || worldConfig(world);
  if (!cfg.bounds) return [];
  if (!count || count < 1) return [];
  if (!allowedTypes || allowedTypes.length === 0) return [];
  const { width, height } = cfg.bounds;
  const rLo = 1, rHi = height - 2, cLo = 1, cHi = width - 2;
  if (rHi < rLo || cHi < cLo) return [];
  const rng = makeRng(rngSeed >>> 0);
  const field = densityFieldForConfig(cfg);
  const out = [];
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < maxAttempts; a++) {
      const row = rLo + Math.floor(rng() * (rHi - rLo + 1));
      const col = cLo + Math.floor(rng() * (cHi - cLo + 1));
      const candidates = creatureTileCandidates(world, cfg, row, col, allowedTypes);
      if (!candidates) continue;
      // The density gate (Slice A). AFTER creatureTileCandidates, never
      // before: safe regions, walls and biome type-gating are absolute, and
      // this only redistributes among tiles that already passed them.
      //
      // Drawn from the same rng stream so placement stays deterministic. This
      // consumes one extra draw per ATTEMPT (not per placement), which shifts
      // the stream for everything after it -- newly seeded and re-rolled worlds
      // lay out differently than they did before this change. Creatures are
      // persisted at world creation, so existing worlds are untouched until
      // re-rolled. Expected, not a bug report.
      if (rng() * field.max > field.weightAt(row, col)) continue;
      const t = candidates[Math.floor(rng() * candidates.length)];
      // Drawn from the same stream, immediately after the type pick, so the
      // roll stays deterministic given rngSeed. NOTE: this consumes one extra
      // draw per placed creature, which shifts the stream for everything after
      // it. Creatures are persisted to world_creatures once at world creation,
      // so already-seeded worlds are unaffected; a NEWLY seeded or re-rolled
      // world will lay its creatures out differently than it would have before
      // this change. That is expected and acceptable -- it is not a bug report.
      const level = rollCreatureLevel(rng(), world.levelMin, world.levelMax);
      const scaled = scaleCreature(
        { hp: t.hp || 10, damage: CREATURE_BASE_DAMAGE, defense: Number(t.defense ?? 0) || 0 },
        level,
      );
      out.push({
        type: t.name,
        x: col * CREATURE_TILE_PX + CREATURE_TILE_PX / 2,
        y: row * CREATURE_TILE_PX + CREATURE_TILE_PX / 2,
        hp: scaled.hp,
        damage: scaled.damage,
        level,
        facing: 'S',
        defense: scaled.defense,
        resistances: t.resistances || {},
      });
      break;
    }
  }
  return out;
}

// A second stream off the same seed, for the same reason a per-tile salt
// separated draws in the old per-chunk spawn roll: sharing one stream with
// scatter would make pack anchors start from draws scatter already
// consumed, clustering packs on top of the scattered creatures instead of
// somewhere else on the map.
const PACK_SALT = 0x9ac4;

// Tiles from the anchor a member may sit. Grows with pack size so a pack of
// 12 does not have to fit in the same footprint as a pack of 3, and is capped
// so a large pack still reads as a group rather than a thin smear.
function packRadius(size) {
  return Math.min(4, Math.max(2, Math.ceil(Math.sqrt(size)) + 1));
}

// Clustered creature placement for a BOUNDED map. Each entry in `packSpecs`
// ({ size }) becomes one group of a SINGLE type, anchored on a valid tile and
// spread within packRadius(size) of it. Same validity rules as scatter, via
// creatureTileCandidates. Pure and deterministic given `rngSeed`. Returns rows
// shaped exactly like placeMapCreatures'. Unbounded worlds return [].
//
// A pack that cannot seat every member ships SHORT rather than failing: a
// crypt whose walkable area is mostly narrow corridor holds tighter, smaller
// packs, and that is a correct outcome, not an error to report.
function placeCreaturePacks(world, packSpecs, allowedTypes, rngSeed, maxAttempts = 40) {
  const cfg = worldConfig(world);
  if (!cfg.bounds) return [];
  if (!packSpecs || packSpecs.length === 0) return [];
  if (!allowedTypes || allowedTypes.length === 0) return [];
  const { width, height } = cfg.bounds;
  const rLo = 1, rHi = height - 2, cLo = 1, cHi = width - 2;
  if (rHi < rLo || cHi < cLo) return [];
  const rng = makeRng((rngSeed ^ PACK_SALT) >>> 0);
  const field = densityFieldForConfig(cfg);
  const out = [];

  const emit = (t, gRow, gCol) => {
    const level = rollCreatureLevel(rng(), world.levelMin, world.levelMax);
    const scaled = scaleCreature(
      { hp: t.hp || 10, damage: CREATURE_BASE_DAMAGE, defense: Number(t.defense ?? 0) || 0 },
      level,
    );
    out.push({
      type: t.name,
      x: gCol * CREATURE_TILE_PX + CREATURE_TILE_PX / 2,
      y: gRow * CREATURE_TILE_PX + CREATURE_TILE_PX / 2,
      hp: scaled.hp,
      damage: scaled.damage,
      level,
      facing: 'S',
      defense: scaled.defense,
      resistances: t.resistances || {},
    });
  };

  for (const p of packSpecs) {
    const size = Math.max(1, Math.floor(p.size) || 0);

    // Anchor: rejection-sample a valid tile, then fix the pack's ONE type
    // from what the local biome admits there.
    let anchorRow = -1, anchorCol = -1, packType = null;
    for (let a = 0; a < maxAttempts; a++) {
      const row = rLo + Math.floor(rng() * (rHi - rLo + 1));
      const col = cLo + Math.floor(rng() * (cHi - cLo + 1));
      const candidates = creatureTileCandidates(world, cfg, row, col, allowedTypes);
      if (!candidates) continue;
      // Anchors obey the field; MEMBERS do not. A pack straddling a density
      // boundary must stay a pack -- gating members would shred it into the
      // heavy half and defeat the point of placing a group.
      if (rng() * field.max > field.weightAt(row, col)) continue;
      anchorRow = row;
      anchorCol = col;
      packType = candidates[Math.floor(rng() * candidates.length)];
      break;
    }
    if (!packType) continue;  // nowhere legal to seat this pack at all

    emit(packType, anchorRow, anchorCol);

    // Cells this pack has already used, so two members never land on the
    // same tile (stacked sprites read as one creature, not a group). Scoped
    // to this pack only -- scatter, and other packs, are free to reuse a
    // cell; that is pre-existing behaviour and out of scope here.
    const usedCells = new Set([`${anchorRow},${anchorCol}`]);

    const radius = packRadius(size);
    const span = 2 * radius + 1;
    for (let m = 1; m < size; m++) {
      for (let a = 0; a < maxAttempts; a++) {
        const row = anchorRow + Math.floor(rng() * span) - radius;
        const col = anchorCol + Math.floor(rng() * span) - radius;
        if (row < rLo || row > rHi || col < cLo || col > cHi) continue;
        const key = `${row},${col}`;
        if (usedCells.has(key)) continue;
        const candidates = creatureTileCandidates(world, cfg, row, col, allowedTypes);
        // The member's OWN tile must admit the pack's type. A pack straddling
        // a biome boundary must not push a creature into a biome that forbids
        // it -- exactly the rule scatter enforces per cell.
        if (!candidates || !candidates.some((t) => t.name === packType.name)) continue;
        usedCells.add(key);
        emit(packType, row, col);
        break;
      }
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

// A world is "bounded" (a Slice-2 map) when it has a finite width AND height.
// Bounded worlds use count-based placement (placeMapCreatures); unbounded
// worlds keep the per-chunk spawn roll.
function isBoundedWorld(row) {
  return !!(row && row.width && row.height);
}

// --- Villages Slice A: interior wall box + single gate overlay ------------
//
// A village is a small walled rectangle stamped INSIDE a region (unlike
// stampBounds, which walls the outer edge of the whole map). One edge carries
// a centered single-tile gate gap. Pure overlay applied after bounds.

function villageContaining(gRow, gCol, villages) {
  if (!villages) return null;
  for (const v of villages) {
    if (pointInVillageBox(gRow, gCol, v)) return v;
  }
  return null;
}

function villageGateCell(gRow, gCol, v) {
  const midCol = v.minCol + Math.floor(v.width / 2);
  const midRow = v.minRow + Math.floor(v.height / 2);
  const rMax = v.minRow + v.height - 1;
  const cMax = v.minCol + v.width - 1;
  if (v.gateEdge === 'N' && gRow === v.minRow && gCol === midCol) return true;
  if (v.gateEdge === 'S' && gRow === rMax && gCol === midCol) return true;
  if (v.gateEdge === 'W' && gCol === v.minCol && gRow === midRow) return true;
  if (v.gateEdge === 'E' && gCol === cMax && gRow === midRow) return true;
  return false;
}

// SOMET-291 — the gate tile's own pixel centre.
//
// villageGateCell above already knows which tile is the gate, but it answers a
// yes/no question about a tile the caller supplies; nothing could ASK it where
// the gate is. The mid-row/mid-col expressions are repeated rather than
// factored out of it because that function is on the terrain stamper's hot
// per-tile loop, and the two are pinned against each other by a test
// (guard_rescue_leash.test.js) instead: villageGateCell must be true for
// exactly the tile this returns, for every legal village.
//
// Used by villages.js's guardRescueLeashRadius to measure how far a guard's
// post is from the doorway it defends.
function villageGatePoint(v) {
  const midCol = v.minCol + Math.floor(v.width / 2);
  const midRow = v.minRow + Math.floor(v.height / 2);
  const rMax = v.minRow + v.height - 1;
  const cMax = v.minCol + v.width - 1;
  let row, col;
  if (v.gateEdge === 'N')      { row = v.minRow; col = midCol; }
  else if (v.gateEdge === 'S') { row = rMax;     col = midCol; }
  else if (v.gateEdge === 'W') { col = v.minCol; row = midRow; }
  else                         { col = cMax;     row = midRow; } // 'E'
  return { x: col * 100 + 50, y: row * 100 + 50 };
}

// Pixel centers of the two INTERIOR tiles flanking a village's gate — where the
// gate guards stand. Clamped into the interior box, so a minimum-size village
// (3x3, interior = one tile) yields two identical posts rather than posts on
// the wall ring.
function villageGatePosts(v) {
  const rMax = v.minRow + v.height - 1;
  const cMax = v.minCol + v.width - 1;
  const midCol = v.minCol + Math.floor(v.width / 2);
  const midRow = v.minRow + Math.floor(v.height / 2);
  const loR = v.minRow + 1, hiR = rMax - 1;
  const loC = v.minCol + 1, hiC = cMax - 1;
  const clampR = (r) => Math.min(hiR, Math.max(loR, r));
  const clampC = (c) => Math.min(hiC, Math.max(loC, c));
  let cells;
  if (v.gateEdge === 'S')      cells = [[hiR, clampC(midCol - 1)], [hiR, clampC(midCol + 1)]];
  else if (v.gateEdge === 'N') cells = [[loR, clampC(midCol - 1)], [loR, clampC(midCol + 1)]];
  else if (v.gateEdge === 'W') cells = [[clampR(midRow - 1), loC], [clampR(midRow + 1), loC]];
  else                         cells = [[clampR(midRow - 1), hiC], [clampR(midRow + 1), hiC]];
  return cells.map(([r, c]) => ({ x: c * 100 + 50, y: r * 100 + 50 }));
}

// Where the village merchant stands: on the gate's centre line, one tile deeper
// into the village than the guard posts, clamped into the interior so a
// minimum-size village still yields a legal interior tile.
function villageMerchantPost(v) {
  const rMax = v.minRow + v.height - 1;
  const cMax = v.minCol + v.width - 1;
  const midCol = v.minCol + Math.floor(v.width / 2);
  const midRow = v.minRow + Math.floor(v.height / 2);
  const loR = v.minRow + 1, hiR = rMax - 1;
  const loC = v.minCol + 1, hiC = cMax - 1;
  const clampR = (r) => Math.min(hiR, Math.max(loR, r));
  const clampC = (c) => Math.min(hiC, Math.max(loC, c));
  let row, col;
  if (v.gateEdge === 'S')      { row = clampR(rMax - 2); col = clampC(midCol); }
  else if (v.gateEdge === 'N') { row = clampR(v.minRow + 2); col = clampC(midCol); }
  else if (v.gateEdge === 'W') { row = clampR(midRow); col = clampC(v.minCol + 2); }
  else                         { row = clampR(midRow); col = clampC(cMax - 2); }
  return { x: col * 100 + 50, y: row * 100 + 50 };
}

// SOMET-310. Where the account chest's bank post stands: the interior tile
// beside the merchant, offset PERPENDICULAR to the gate axis so the two never
// stack along the approach a player actually walks in on.
//
// DERIVED, NOT STORED. villages.merchant_x/merchant_y are real columns, so the
// obvious move was a matching pair of bank columns -- but every input here is
// already on the row (minRow/minCol/width/height/gateEdge), which makes those
// columns pure derived state plus a backfill for every village that already
// exists. Computing it in fetchVillages instead means every village in every
// world, authored or generated, past or future, has a bank the moment this
// ships, and there is no second source of truth to drift.
//
// The offset flips to -1 when the merchant is already against the far interior
// wall, so the post cannot land on the impassable wall ring.
//
// `merchant` IS AN INPUT, NOT RE-DERIVED HERE. villages.merchant_x/merchant_y
// is a stored column: createVillage writes it from villageMerchantPost, but the
// stored value is what the client actually draws the merchant marker at, and
// the two can disagree -- a map spec that authors a merchant position, or a row
// written before this derivation last changed. Deriving the bank from a
// recomputed merchant post would then place the chest relative to a merchant
// that is not where the player sees one. Callers pass the row's real position
// and get a post beside THAT; the fallback only covers a village with no stored
// merchant at all.
//
// THE 3x3 VILLAGE IS A REAL DEGENERATE CASE, not an oversight. VILLAGE_LIMITS
// allows minW/minH of 3, whose interior is a single tile: loR === hiR and
// loC === hiC, so both offsets clamp back and the bank returns the merchant's
// exact tile. Both markers then draw on one tile. That is accepted rather than
// worked around -- the alternatives are putting a post on an impassable wall
// tile or raising the minimum village size, and a 3x3 village is already a
// closet nobody authors. It stays legal and both interactions still work,
// because each is picked by its own proximity radius, not by which marker the
// player clicked.
function villageBankPost(v, merchant = null) {
  const rMax = v.minRow + v.height - 1;
  const cMax = v.minCol + v.width - 1;
  const loR = v.minRow + 1, hiR = rMax - 1;
  const loC = v.minCol + 1, hiC = cMax - 1;
  const clampR = (r) => Math.min(hiR, Math.max(loR, r));
  const clampC = (c) => Math.min(hiC, Math.max(loC, c));
  const m = (merchant && Number.isFinite(merchant.x) && Number.isFinite(merchant.y))
    ? merchant
    : villageMerchantPost(v);
  // Clamped before the offset as well as after: a stored merchant position
  // outside the interior (bad authored data) must not drag the bank onto the
  // wall ring with it.
  const mRow = clampR(Math.floor(m.y / 100));
  const mCol = clampC(Math.floor(m.x / 100));
  let row = mRow, col = mCol;
  if (v.gateEdge === 'S' || v.gateEdge === 'N') {
    col = clampC(mCol + 1 <= hiC ? mCol + 1 : mCol - 1);
  } else {
    row = clampR(mRow + 1 <= hiR ? mRow + 1 : mRow - 1);
  }
  return { x: col * 100 + 50, y: row * 100 + 50 };
}

function stampVillage(grid, rMin, cMin, rows, cols, village) {
  const { minRow, minCol, width, height, wallTile, gateTile } = village;
  const rMax = minRow + height - 1;
  const cMax = minCol + width - 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gRow = rMin + r, gCol = cMin + c;
      if (gRow < minRow || gRow > rMax || gCol < minCol || gCol > cMax) continue;
      const onRing = gRow === minRow || gRow === rMax || gCol === minCol || gCol === cMax;
      if (!onRing) continue;
      grid[r][c] = villageGateCell(gRow, gCol, village) ? gateTile : wallTile;
    }
  }
  return grid;
}

// --- Slice 3: edge geometry + spawn selection (pure) ---
const PLAYER_HALF = 32; // player is 64px; center offset from top-left

function oppositeEdge(edge) {
  return { N: 'S', S: 'N', E: 'W', W: 'E' }[edge] || null;
}

// Which ring edge a tile (gRow,gCol) sits on for a width x height bounded map;
// null if it is not on the ring. Corners resolve to a vertical edge first (N/S).
function edgeOfDoorwayTile(gRow, gCol, width, height) {
  if (gRow === 0) return 'N';
  if (gRow === height - 1) return 'S';
  if (gCol === 0) return 'W';
  if (gCol === width - 1) return 'E';
  return null;
}

// Player top-left pixel just INSIDE the destination's arriveEdge doorway.
// Doorway center tile is midCol/midRow (Slice-1 geometry); step one tile inward.
function arrivalPoint(width, height, arriveEdge) {
  const midCol = Math.floor(width / 2);
  const midRow = Math.floor(height / 2);
  let col, row;
  if (arriveEdge === 'N') { row = 1; col = midCol; }
  else if (arriveEdge === 'S') { row = height - 2; col = midCol; }
  else if (arriveEdge === 'W') { col = 1; row = midRow; }
  else { col = width - 2; row = midRow; } // 'E'
  return { x: col * CREATURE_TILE_PX + (CREATURE_TILE_PX / 2) - PLAYER_HALF,
           y: row * CREATURE_TILE_PX + (CREATURE_TILE_PX / 2) - PLAYER_HALF };
}

const PLAYER_SIZE = PLAYER_HALF * 2;
const FOOT_EPS = 1; // inset so a position flush against a wall edge is not read as inside it

// Is the player's whole 64px box inside the world and standing on walkable
// ground? isWalkable is ServerMap.isWalkable (authority/collision.js) injected
// by the caller, so this stays a pure function and the walkability rule is not
// duplicated a third time -- resolveMove already exists as two byte-for-byte
// copies across frontend/movement.js and backend/authority/collision.js.
//
// All four corners, not the top-left: a box whose origin sits on open ground
// can still have three quarters of itself inside a wall.
function spawnIsValid(x, y, worldRow, isWalkable) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (isBoundedWorld(worldRow)) {
    const maxX = worldRow.width * CREATURE_TILE_PX - PLAYER_SIZE;
    const maxY = worldRow.height * CREATURE_TILE_PX - PLAYER_SIZE;
    if (x < 0 || y < 0 || x > maxX || y > maxY) return false;
  }
  if (typeof isWalkable !== 'function') return true;
  const corners = [
    [x + FOOT_EPS, y + FOOT_EPS],
    [x + PLAYER_SIZE - FOOT_EPS, y + FOOT_EPS],
    [x + FOOT_EPS, y + PLAYER_SIZE - FOOT_EPS],
    [x + PLAYER_SIZE - FOOT_EPS, y + PLAYER_SIZE - FOOT_EPS],
  ];
  return corners.every(([cx, cy]) => isWalkable(cx, cy));
}

function nearestPortal(portals, x, y) {
  let best = null;
  let bestD2 = Infinity;
  for (const p of portals || []) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const d2 = ((p.x - x) ** 2) + ((p.y - y) ** 2);
    if (d2 < bestD2) { bestD2 = d2; best = p; }
  }
  return best;
}

// Decide a join spawn. Priority: doorway arrival > persisted position (if it is
// still valid) > nearest portal > entry_spawn (entry world, first join) >
// bounded interior center > chunk center.
//
// The nearest-portal step is SOMET-261. Before it, an invalid persisted
// position fell all the way through to "world centre", which after a world
// resize or a regeneration can be inside geometry -- the player loaded stuck,
// with no way out. A portal is a tile the map author guaranteed is reachable,
// which makes it the right last resort.
//
// `portals` and `isWalkable` are optional with inert defaults so the five
// pre-existing branches (and edgeHelpers.test.js, which calls this with neither)
// behave exactly as before. That inertness is also the risk: a caller that
// forgets to pass them silently never uses the fallback, which is why
// spawn_portal_fallback.test.js asserts loadSpawn actually supplies both.
function chooseSpawn({ pending, persisted, worldRow, chunkSize, portals = [], isWalkable = null }) {
  if (pending) return { x: pending.x, y: pending.y, viaDoorway: true, viaPortalFallback: false };
  if (persisted) {
    if (spawnIsValid(persisted.x, persisted.y, worldRow, isWalkable)) {
      return { x: persisted.x, y: persisted.y, viaDoorway: false, viaPortalFallback: false };
    }
    const near = nearestPortal(portals, persisted.x, persisted.y);
    if (near) return { x: near.x, y: near.y, viaDoorway: false, viaPortalFallback: true };
  }
  if (worldRow && worldRow.is_entry && worldRow.entry_spawn &&
      Number.isFinite(worldRow.entry_spawn.x) && Number.isFinite(worldRow.entry_spawn.y)) {
    return { x: worldRow.entry_spawn.x, y: worldRow.entry_spawn.y, viaDoorway: false, viaPortalFallback: false };
  }
  if (isBoundedWorld(worldRow)) {
    const col = Math.floor(worldRow.width / 2);
    const row = Math.floor(worldRow.height / 2);
    return { x: col * CREATURE_TILE_PX + (CREATURE_TILE_PX / 2) - PLAYER_HALF,
             y: row * CREATURE_TILE_PX + (CREATURE_TILE_PX / 2) - PLAYER_HALF,
             viaDoorway: false, viaPortalFallback: false };
  }
  const center = (chunkSize * CREATURE_TILE_PX) / 2;
  return { x: center, y: center, viaDoorway: false, viaPortalFallback: false };
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
    const nonStructural = names.filter((n) => !STRUCTURAL_TILES.has(n));
    const biomeSource = nonStructural.length > 0 ? nonStructural : names;
    const biomeNames = pathTile && biomeSource.length > 1
        ? biomeSource.filter((n) => n !== pathTile)
        : biomeSource;
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
    sampleTerrain,
    sampleBiomeRegion,
    biomeTerrainNames,
    generateWorldPreview,
    overviewOrigin,
    generateWorldOverview,
    generateRegion,
    generateChunk,
    generateChunkDecorations,
    pathAnchor,
    pathSegmentCells,
    collectPathCells,
    normalizeAuthoredRoads,
    placeMapCreatures,
    CREATURE_BASE_DAMAGE,
    placeCreaturePacks,
    densityFieldFor,
    densityFieldForConfig,
    creatureTileCandidates,
    stampBounds,
    isBoundedWorld,
    stampVillage,
    pointInVillageBox,
    villageContaining,
    villageGatePosts,
    // SOMET-291: the gate's own centre, plus the yes/no form it must agree
    // with. villageGateCell was previously internal to the stamper; it is
    // exported only so the two can be pinned against each other.
    villageGatePoint,
    villageGateCell,
    villageMerchantPost,
    villageBankPost,
    DOORWAY_TILES,
    oppositeEdge,
    edgeOfDoorwayTile,
    arrivalPoint,
    chooseSpawn,
    CREATURE_TILE_PX,
};

