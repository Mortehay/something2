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
};

