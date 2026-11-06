// Where a world boss fights: a FOUND open clearing in whatever world it is in.
//
// WHY THIS EXISTS. The arena used to be a hard-coded point per region
// (BOSS_ARENAS, e.g. Vale Crossing = 8800,8800) with a "0.75 of the map" fallback
// for any other world. Nothing checked that the point was open ground: Vale
// Crossing's was inside the hub town, so a boss woke up among the shops and the
// players, and a world with no entry in the table could put it in a wall.
//
// This module takes the old point as a STARTING POINT and returns the nearest spot
// that is really an arena:
//   * a disk of ARENA_RADIUS that is at least MIN_OPEN walkable (sampled every
//     SAMPLE_STEP px through the world's own map, which generates chunks on demand,
//     so an unloaded chunk is answered, not guessed);
//   * inside the map with a margin;
//   * clear of every village (plus a margin), and of portals, waypoints and chests.
//
// Pure and deterministic: the same world gives the same arena on every server and
// every restart, so there is nothing to persist. There is no RNG; the search order
// is a fixed outward spiral. The result is cached per world.

const { villageContaining } = require('../services/mapService.js');
const { arenaForWorldName } = require('./bossArenaWorlds.js');

const TILE = 100;
const ARENA_RADIUS = 450;
const SAMPLE_STEP = 64;
const MIN_OPEN = 0.95;
// The disk centre keeps this far from every map edge (the radius plus a buffer, so
// the ring never touches the wall or an edge doorway).
const EDGE_MARGIN = ARENA_RADIUS + 200;
// The disk's edge keeps this far from any village tile.
const VILLAGE_MARGIN = 350;
// The centre keeps this far from a portal / waypoint / chest.
const LANDMARK_CLEARANCE = 600;
const RING_STEP = 250;

// Hand-picked starting points per region (the old table). Only a starting point now.
const BOSS_ARENAS = [
  { matchKeys: ['vale_hub', 'vale crossing', 'vale-crossing'], arenaName: 'Colossus Caldera', x: 8800, y: 8800 },
  { matchKeys: ['vale_dunes', 'sunscar flats', 'sunscar'], arenaName: 'Scorched Arena', x: 7500, y: 2500 },
  { matchKeys: ['vale_frozen', 'rimehollow'], arenaName: 'Glacier Throne', x: 2500, y: 7500 },
  { matchKeys: ['vale_forest', 'thornbriar reach', 'thornbriar'], arenaName: 'Thundergrove Glade', x: 2200, y: 2200 },
  { matchKeys: ['vale_mire', 'blackfen sinks', 'blackfen'], arenaName: 'Abyssal Chasm', x: 7200, y: 7200 },
];

function resolveArena(worldKey, worldName) {
  const normKey = (worldKey || '').toLowerCase();
  const normName = (worldName || '').toLowerCase();
  for (const arena of BOSS_ARENAS) {
    if (arena.matchKeys.some((k) => normKey.includes(k) || normName.includes(k))) return arena;
  }
  return null;
}

const cache = new Map();
const warned = new Set();
function clearArenaCache() { cache.clear(); warned.clear(); }

function mapOf(entry) {
  return (entry && entry.world && entry.world.map) || (entry && entry.map) || null;
}

function sizeOf(entry) {
  const row = (entry && entry.row) || {};
  const w = Number(row.width) > 0 ? Number(row.width) * TILE : 9600;
  const h = Number(row.height) > 0 ? Number(row.height) * TILE : 9600;
  return { w, h };
}

// Everything a clearing must keep away from, as {x, y} pixel points.
function landmarksOf(entry) {
  const out = [];
  if (entry && entry.portalLinks && entry.portalLinks.keys) {
    for (const key of entry.portalLinks.keys()) {
      const [gRow, gCol] = String(key).split(',').map(Number);
      if (Number.isFinite(gRow) && Number.isFinite(gCol)) out.push({ x: (gCol + 0.5) * TILE, y: (gRow + 0.5) * TILE });
    }
  }
  if (entry && entry.waypoints && entry.waypoints.values) {
    for (const wp of entry.waypoints.values()) if (Number.isFinite(Number(wp.x)) && Number.isFinite(Number(wp.y))) out.push({ x: Number(wp.x), y: Number(wp.y) });
  }
  if (entry && Array.isArray(entry.chests)) {
    for (const c of entry.chests) if (c && Number.isFinite(Number(c.x)) && Number.isFinite(Number(c.y))) out.push({ x: Number(c.x), y: Number(c.y) });
  }
  return out;
}

function inVillage(entry, x, y) {
  if (!entry || !entry.villages || entry.villages.length === 0) return false;
  return villageContaining(Math.floor(y / TILE), Math.floor(x / TILE), entry.villages) != null;
}

// Hard rules: where an arena may not be, whatever the ground looks like.
function passesHard(entry, ctx, cx, cy, r) {
  if (cx < EDGE_MARGIN || cy < EDGE_MARGIN || cx > ctx.w - EDGE_MARGIN || cy > ctx.h - EDGE_MARGIN) return false;
  for (const l of ctx.landmarks) {
    if ((l.x - cx) ** 2 + (l.y - cy) ** 2 < LANDMARK_CLEARANCE * LANDMARK_CLEARANCE) return false;
  }
  if (entry.villages && entry.villages.length > 0) {
    const R = r + VILLAGE_MARGIN;
    for (let dy = -R; dy <= R; dy += TILE) {
      for (let dx = -R; dx <= R; dx += TILE) {
        if (dx * dx + dy * dy > R * R) continue;
        if (inVillage(entry, cx + dx, cy + dy)) return false;
      }
    }
  }
  return true;
}

// Fraction of the disk that is walkable. Stops early once it can no longer reach
// `need` (a candidate that is mostly wall is rejected after a handful of samples).
function openRatio(map, cx, cy, r, need = 0) {
  let total = 0;
  for (let dy = -r; dy <= r; dy += SAMPLE_STEP) {
    for (let dx = -r; dx <= r; dx += SAMPLE_STEP) if (dx * dx + dy * dy <= r * r) total += 1;
  }
  const maxMiss = Math.floor(total * (1 - need));
  let open = 0, miss = 0;
  for (let dy = -r; dy <= r; dy += SAMPLE_STEP) {
    for (let dx = -r; dx <= r; dx += SAMPLE_STEP) {
      if (dx * dx + dy * dy > r * r) continue;
      if (map.isWalkable(cx + dx, cy + dy)) open += 1;
      else { miss += 1; if (miss > maxMiss) return open / total; }
    }
  }
  return open / total;
}

// Candidate centres, nearest first: the start, then rings of growing radius.
function* candidates(start, ctx) {
  yield start;
  const reach = Math.max(ctx.w, ctx.h);
  for (let k = 1; k * RING_STEP <= reach; k += 1) {
    const R = k * RING_STEP;
    const n = Math.max(8, Math.ceil((2 * Math.PI * R) / RING_STEP));
    const phase = (k % 2) * (Math.PI / n);
    for (let i = 0; i < n; i += 1) {
      const a = phase + (i * 2 * Math.PI) / n;
      yield { x: Math.round(start.x + Math.cos(a) * R), y: Math.round(start.y + Math.sin(a) * R) };
    }
  }
}

// -> { x, y, radius, name, source: 'configured' | 'found' | 'fallback' }
function findArena(entry, { radius = ARENA_RADIUS } = {}) {
  const map = mapOf(entry);
  const { w, h } = sizeOf(entry);
  const row = (entry && entry.row) || {};
  const landmarks = landmarksOf(entry);
  const key = [entry && entry.worldId, w, h, radius, (entry.villages || []).length, landmarks.length].join('|');
  if (cache.has(key)) return { ...cache.get(key) };

  // A DEDICATED arena world (bossArenaWorlds.js, seeded by boss-arenas.map.json) has its
  // arena at the world's centre, where the spec paves it; the search only runs from
  // there if that ground is somehow not open. Any other world uses the region table or
  // the 75% point as before.
  const dedicated = arenaForWorldName(row.name);
  const configured = dedicated ? null : resolveArena(row.key || row.canonical_id, row.name);
  const name = dedicated ? `${dedicated.short}'s Arena` : (configured ? configured.arenaName : 'Boss Arena');
  let start;
  if (dedicated) start = { x: Math.floor(w / 2), y: Math.floor(h / 2) };
  else if (configured) start = { x: configured.x, y: configured.y };
  else start = { x: Math.floor(w * 0.75), y: Math.floor(h * 0.75) };
  const ctx = { w, h, landmarks };

  let result = null;
  let best = null; // best hard-passing spot that is not open enough
  let bestRatio = -1;
  if (map) {
    let first = true;
    for (const c of candidates(start, ctx)) {
      const isStart = first; first = false;
      if (!passesHard(entry, ctx, c.x, c.y, radius)) continue;
      const ratio = openRatio(map, c.x, c.y, radius, MIN_OPEN);
      if (ratio >= MIN_OPEN) {
        result = { x: c.x, y: c.y, radius, name, source: isStart && (configured || dedicated) ? (dedicated ? 'dedicated' : 'configured') : 'found' };
        break;
      }
      if (ratio > bestRatio) { bestRatio = ratio; best = c; }
    }
  }
  if (!result) {
    // Nothing is open enough: the most open legal spot, else the middle of the map.
    const c = best || { x: Math.floor(w / 2), y: Math.floor(h / 2) };
    result = { x: c.x, y: c.y, radius, name, source: 'fallback' };
    const wk = String(entry && entry.worldId);
    if (map && !warned.has(wk)) {
      warned.add(wk);
      console.warn(`[world boss] no open arena in world ${wk}; using the most open spot (${Math.round(Math.max(0, bestRatio) * 100)}% open)`);
    }
  }
  cache.set(key, result);
  return { ...result };
}

module.exports = {
  findArena, resolveArena, clearArenaCache, BOSS_ARENAS,
  ARENA_RADIUS, MIN_OPEN, EDGE_MARGIN, VILLAGE_MARGIN, LANDMARK_CLEARANCE, SAMPLE_STEP,
};
