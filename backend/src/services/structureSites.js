// SOMET-773: where ruins go. PURE: a world config in, resolved ruin stamps out
// (the shape stored on worlds.structures and drawn by mapService's
// stampStructure). Deterministic from the world seed.
//
// The rules, cheapest first:
//   1. a seeded anchor inside the map (2 tiles off the edge);
//   2. the owning biome must have a style (seeds/data/structureTypes.js);
//   3. footprint + a 1-tile margin all in bounds, on walkable terrain, in that
//      one biome region, outside every exclusion zone (roads, villages and
//      their houses, required points, caller-supplied avoid points, other
//      sites);
//   4. THE SEAL CHECK: the world with every accepted site plus this one must
//      still pass assertNavigable -- roads off, decorations on, the way
//      seed-map judges a world -- with each ruin's interior added as a
//      required tile. A site that fails is dropped, never "fixed".
// Rule 4 is the only one that can prove anything; 1-3 just keep it cheap.
const { worldConfig, generateRegion, collectPathCells, sampleBiomeRegion, hash2, villageHouses } = require('./mapService');
const { assertNavigable } = require('./navigability');

const STRUCTURE_SEED_XOR = 0x5bd1e995;
const STRUCTURE_CAP = 16;
const TILES_PER_SITE = 700;
const ATTEMPTS_PER_SITE = 40;
const EDGE_MARGIN = 2;
const ROAD_CLEAR = 1;
const VILLAGE_CLEAR = 4;
const REQUIRED_CLEAR = 4;
const SITE_GAP = 2;

function targetCount(width, height) {
  return Math.min(STRUCTURE_CAP, Math.floor((width * height) / TILES_PER_SITE));
}

// Ring cells of a footprint, corners excluded (corners stay as posts so a
// ruin still reads as a building), tagged with their side.
function ringCells(r0, c0, w, h) {
  const out = [];
  for (let c = c0 + 1; c < c0 + w - 1; c++) { out.push({ cell: [r0, c], side: 'N' }); out.push({ cell: [r0 + h - 1, c], side: 'S' }); }
  for (let r = r0 + 1; r < r0 + h - 1; r++) { out.push({ cell: [r, c0], side: 'W' }); out.push({ cell: [r, c0 + w - 1], side: 'E' }); }
  return out;
}

// Knock gaps until about `wallKeep` of the ring stands: at least two, and the
// first two on different sides so a ruin is never a dead end with one door.
function pickGaps(r0, c0, w, h, wallKeep, seed, i) {
  const ring = ringCells(r0, c0, w, h);
  const total = 2 * (w + h) - 4;
  const want = Math.max(2, Math.min(ring.length, Math.ceil(total * (1 - wallKeep))));
  const order = ring
    .map((x, k) => ({ ...x, roll: hash2(seed, i * 64 + k, 7) }))
    .sort((a, b) => a.roll - b.roll);
  const chosen = [order[0]];
  const second = order.find((x) => x.side !== order[0].side);
  if (second) chosen.push(second);
  for (const x of order) {
    if (chosen.length >= want) break;
    if (!chosen.includes(x)) chosen.push(x);
  }
  return chosen.map((x) => x.cell).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function generateStructureSites(world, { styles, decorationDefs = null, required = [], avoid = [], keep = [] } = {}) {
  const bareWorld = { ...world, structures: [] };
  const cfg = worldConfig(bareWorld);
  if (!cfg.bounds) return [...keep];
  const { width, height } = cfg.bounds;
  const styleByBiome = new Map();
  for (const s of styles || []) for (const b of s.biomes) styleByBiome.set(b, s);
  if (styleByBiome.size === 0) return [...keep];

  const terrain = generateRegion(bareWorld, 0, 0, height, width);
  const tileTypes = world.tileTypes || {};
  const walkable = (r, c) => { const d = tileTypes[terrain[r][c]]; return !(d && d.walkable === false); };

  const blocked = new Set();
  const markRect = (r0, c0, r1, c1) => {
    for (let r = Math.max(0, r0); r <= Math.min(height - 1, r1); r++) {
      for (let c = Math.max(0, c0); c <= Math.min(width - 1, c1); c++) blocked.add(`${r},${c}`);
    }
  };
  const mark = (r, c, rad) => markRect(r - rad, c - rad, r + rad, c + rad);
  // Live roads count: a ruin on a road is a ruin in a player's way.
  for (const key of collectPathCells(cfg, 0, 0, height, width).keys()) {
    const [r, c] = key.split(',').map(Number);
    mark(r, c, ROAD_CLEAR);
  }
  for (const v of cfg.villages || []) {
    for (const box of [v, ...villageHouses(v)]) {
      markRect(box.minRow - VILLAGE_CLEAR, box.minCol - VILLAGE_CLEAR,
        box.minRow + box.height - 1 + VILLAGE_CLEAR, box.minCol + box.width - 1 + VILLAGE_CLEAR);
    }
  }
  for (const p of required) mark(p.row, p.col, REQUIRED_CLEAR);
  for (const a of avoid) mark(a.row, a.col, a.radius || 0);

  const accepted = [...keep];
  const claim = (s) => markRect(s.minRow - SITE_GAP, s.minCol - SITE_GAP,
    s.minRow + s.height - 1 + SITE_GAP, s.minCol + s.width - 1 + SITE_GAP);
  for (const k of keep) claim(k);

  const target = targetCount(width, height);
  const seed = (Number(world.seed || 0) ^ STRUCTURE_SEED_XOR) >>> 0;
  const attempts = target * ATTEMPTS_PER_SITE;
  for (let i = 0; i < attempts && accepted.length < target; i++) {
    const r0 = EDGE_MARGIN + Math.floor(hash2(seed, i, 1) * (height - 2 * EDGE_MARGIN));
    const c0 = EDGE_MARGIN + Math.floor(hash2(seed, i, 2) * (width - 2 * EDGE_MARGIN));
    const region = sampleBiomeRegion(cfg, r0, c0);
    const style = region && styleByBiome.get(region.name);
    if (!style) continue;
    const [w, h] = style.sizes[Math.floor(hash2(seed, i, 3) * style.sizes.length)];
    if (r0 + h - 1 > height - 1 - EDGE_MARGIN || c0 + w - 1 > width - 1 - EDGE_MARGIN) continue;

    let ok = true;
    for (let r = r0 - 1; ok && r <= r0 + h; r++) {
      for (let c = c0 - 1; c <= c0 + w; c++) {
        if (r < 0 || c < 0 || r >= height || c >= width || blocked.has(`${r},${c}`) || !walkable(r, c)
          || sampleBiomeRegion(cfg, r, c) !== region) { ok = false; break; }
      }
    }
    if (!ok) continue;

    const site = {
      type: style.name, minRow: r0, minCol: c0, width: w, height: h,
      wallTile: style.wallTile, floorTile: style.floorTile,
      gaps: pickGaps(r0, c0, w, h, style.wallKeep, seed, i), source: 'auto',
    };
    const trial = [...accepted, site];
    const interiors = trial.map((s) => ({ row: s.minRow + 1, col: s.minCol + 1, what: `ruin ${s.type} interior` }));
    const problems = assertNavigable({ ...world, structures: trial, noGeneratedRoads: true },
      [...required, ...interiors], { decorationDefs });
    if (problems.length > 0) continue;
    accepted.push(site);
    claim(site);
  }
  return accepted;
}

module.exports = { generateStructureSites, STRUCTURE_CAP, targetCount, pickGaps };
