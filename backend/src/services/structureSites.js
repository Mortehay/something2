// SOMET-773: where ruins go. PURE: a world config in, resolved ruin stamps out
// (the shape stored on worlds.structures and drawn by mapService's
// stampStructure). Deterministic from the world seed AND the constraints the
// caller passes -- live creatures and saved player positions are among them,
// so two databases with the same spec can get different ruins (by design: a
// ruin must never land on something that is already standing there).
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
const POI_XOR = 0x2c1b3c6d;

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

// Everything a site must respect, computed once per world: the bare terrain,
// the biome field and the blocked cells (roads, villages + houses, required
// points, caller avoid points). Shared by placement and re-validation so a
// stored ruin is judged by exactly the rules that placed it (review I2).
function siteContext(world, { styles, required = [], avoid = [] } = {}) {
  const bareWorld = { ...world, structures: [] };
  const cfg = worldConfig(bareWorld);
  if (!cfg.bounds) return null;
  const { width, height } = cfg.bounds;
  const styleByBiome = new Map();
  for (const s of styles || []) for (const b of s.biomes) styleByBiome.set(b, s);
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
  const claimed = new Set();
  const claim = (st) => {
    for (let r = st.minRow - SITE_GAP; r <= st.minRow + st.height - 1 + SITE_GAP; r++) {
      for (let c = st.minCol - SITE_GAP; c <= st.minCol + st.width - 1 + SITE_GAP; c++) claimed.add(`${r},${c}`);
    }
  };
  return { cfg, width, height, styleByBiome, walkable, blocked, claimed, claim };
}

// Footprint + a 1-tile margin: inside the map (EDGE_MARGIN), walkable, not
// blocked or claimed, all in ONE biome region whose style is `style`.
function siteFits(ctx, st, style) {
  const { cfg, width, height } = ctx;
  if (st.minRow < EDGE_MARGIN || st.minCol < EDGE_MARGIN
    || st.minRow + st.height - 1 > height - 1 - EDGE_MARGIN || st.minCol + st.width - 1 > width - 1 - EDGE_MARGIN) return false;
  const region = sampleBiomeRegion(cfg, st.minRow, st.minCol);
  if (!region || !style.biomes.includes(region.name)) return false;
  for (let r = st.minRow - 1; r <= st.minRow + st.height; r++) {
    for (let c = st.minCol - 1; c <= st.minCol + st.width; c++) {
      if (r < 0 || c < 0 || r >= height || c >= width) return false;
      const k = `${r},${c}`;
      if (ctx.blocked.has(k) || ctx.claimed.has(k) || !ctx.walkable(r, c)) return false;
      if (sampleBiomeRegion(cfg, r, c) !== region) return false;
    }
  }
  return true;
}

// SOMET-776: the tile a monument's chest stands on (when it is a POI), and
// which generation keeps reachable: the middle of the row just south of the
// footprint -- the side facing the camera.
function monumentFront(st) {
  return { row: st.minRow + st.height, col: st.minCol + Math.floor((st.width - 1) / 2) };
}

const isMonument = (st) => st && st.kind === 'monument';

// What every accepted site needs reachable: a ruin's interior, a monument's
// front tile.
function siteRequired(sites) {
  return sites.map((st) => (isMonument(st)
    ? { ...monumentFront(st), what: `monument ${st.type} front` }
    : { row: st.minRow + 1, col: st.minCol + 1, what: `ruin ${st.type} interior` }));
}

// Stored auto sites that still fit, in order (a later one must also keep clear
// of the earlier survivors). Navigability of the kept set is the caller's job.
// A monument is judged against the monument catalog: one whose type has left
// it is dropped like a ruin whose style has.
function validSites(world, sites, { styles, monuments = [], required = [], avoid = [] } = {}) {
  const ctx = siteContext(world, { styles, required, avoid });
  if (!ctx) return [];
  const byName = new Map((styles || []).map((s) => [s.name, s]));
  const monByName = new Map((monuments || []).map((m) => [m.name, m]));
  const out = [];
  for (const st of sites) {
    const style = isMonument(st) ? monByName.get(st.type) : byName.get(st.type);
    if (style && siteFits(ctx, st, style)) { out.push(st); ctx.claim(st); }
  }
  return out;
}

const MONUMENT_SEED_XOR = 0x1b873593;
const MONUMENT_CAP = 6;
const TILES_PER_MONUMENT = 1500;
function monumentTarget(width, height) {
  return Math.min(MONUMENT_CAP, Math.floor((width * height) / TILES_PER_MONUMENT));
}

function generateStructureSites(world, { styles, monuments = [], decorationDefs = null, required = [], avoid = [], keep = [] } = {}) {
  const ctx = siteContext(world, { styles, required, avoid });
  if (!ctx) return [...keep];
  const { cfg, width, height } = ctx;
  const accepted = [...keep];
  for (const k of keep) ctx.claim(k);
  // A site is accepted only if the world with it still passes the seal check.
  const navigableWith = (site) => {
    const trial = [...accepted, site];
    return assertNavigable({ ...world, structures: trial, noGeneratedRoads: true },
      [...required, ...siteRequired(trial)], { decorationDefs }).length === 0;
  };

  // Ruins first, exactly as before monuments existed: the ruin count and the
  // ruin roll sequence ignore monuments, so adding the monument pass moved no
  // stored ruin.
  const target = targetCount(width, height);
  const seed = (Number(world.seed || 0) ^ STRUCTURE_SEED_XOR) >>> 0;
  const attempts = ctx.styleByBiome.size === 0 ? 0 : target * ATTEMPTS_PER_SITE;
  let ruins = accepted.filter((st) => !isMonument(st)).length;
  for (let i = 0; i < attempts && ruins < target; i++) {
    const r0 = EDGE_MARGIN + Math.floor(hash2(seed, i, 1) * (height - 2 * EDGE_MARGIN));
    const c0 = EDGE_MARGIN + Math.floor(hash2(seed, i, 2) * (width - 2 * EDGE_MARGIN));
    const region = sampleBiomeRegion(cfg, r0, c0);
    const style = region && ctx.styleByBiome.get(region.name);
    if (!style) continue;
    const [w, h] = style.sizes[Math.floor(hash2(seed, i, 3) * style.sizes.length)];
    const shape = { minRow: r0, minCol: c0, width: w, height: h };
    if (!siteFits(ctx, shape, style)) continue;

    const site = {
      type: style.name, minRow: r0, minCol: c0, width: w, height: h,
      wallTile: style.wallTile, floorTile: style.floorTile,
      gaps: pickGaps(r0, c0, w, h, style.wallKeep, seed, i), source: 'auto',
    };
    if (!navigableWith(site)) continue;
    accepted.push(site);
    ctx.claim(site);
    ruins++;
  }

  // Monuments (SOMET-776): own seed, own count, weighted pick among the types
  // whose biomes include the anchor's region.
  const mTarget = (monuments || []).length ? monumentTarget(width, height) : 0;
  const mSeed = (Number(world.seed || 0) ^ MONUMENT_SEED_XOR) >>> 0;
  let placed = accepted.filter(isMonument).length;
  for (let i = 0; i < mTarget * ATTEMPTS_PER_SITE && placed < mTarget; i++) {
    const r0 = EDGE_MARGIN + Math.floor(hash2(mSeed, i, 1) * (height - 2 * EDGE_MARGIN));
    const c0 = EDGE_MARGIN + Math.floor(hash2(mSeed, i, 2) * (width - 2 * EDGE_MARGIN));
    const region = sampleBiomeRegion(cfg, r0, c0);
    if (!region) continue;
    const fits = monuments.filter((m) => m.biomes.includes(region.name) && m.weight > 0);
    if (fits.length === 0) continue;
    let roll = hash2(mSeed, i, 3) * fits.reduce((a, m) => a + m.weight, 0);
    let type = fits[fits.length - 1];
    for (const m of fits) { roll -= m.weight; if (roll <= 0) { type = m; break; } }
    const [w, h] = type.size;
    const site = { kind: 'monument', type: type.name, sprite: type.sprite, minRow: r0, minCol: c0, width: w, height: h, source: 'auto' };
    if (!siteFits(ctx, site, type)) continue;
    if (!navigableWith(site)) continue;
    accepted.push(site);
    ctx.claim(site);
    placed++;
  }
  return accepted;
}

// SOMET-774: is this ruin a point of interest (guarded field chest)? DERIVED
// from the stamp, never stored, so ruins written before this slice qualify
// without being moved. An explicit boolean `poi` on the stamp (spec-authored
// ruins, SOMET-775) wins over the roll.
function isPoiRuin(seed, stamp, styles, monuments = []) {
  if (typeof stamp.poi === 'boolean') return stamp.poi;
  const style = (isMonument(stamp) ? monuments : styles || []).find((s) => s.name === stamp.type);
  if (!style || !(style.poiChance > 0)) return false;
  return hash2((Number(seed || 0) ^ POI_XOR) >>> 0, stamp.minRow, stamp.minCol) < style.poiChance;
}

module.exports = {
  isPoiRuin, generateStructureSites, validSites, siteFits, siteContext, siteRequired, monumentFront,
  STRUCTURE_CAP, MONUMENT_CAP, targetCount, monumentTarget, pickGaps,
};
