#!/usr/bin/env node
// Writes backend/seeds/maps/boss-arenas.map.json: the four world-boss arena worlds.
//
//   node backend/scripts/gen-boss-arenas-spec.js          write the file
//   node backend/scripts/gen-boss-arenas-spec.js --check  exit 1 if the file is stale
//
// The spec is GENERATED because the arena floor is a paved disk -- a few dozen road
// segments per world -- and hand-keeping geometry like that is how a floor ends up
// lopsided. tests/boss_arena_worlds.test.js compares the committed file with this
// function's output, so the two cannot drift.
//
// LAYOUT (tile coordinates are [row, col]; one tile = 100 px)
//   * Each arena is a 64x64 world with NO wandering creatures (density 'dead'): the
//     only thing in it is the boss.
//   * The ARENA is a disk of PAVED_RADIUS_PX centred on the world's centre, paved
//     entirely with road_stone, the fastest ground tile (speed 1.2). A boss fight is
//     about moving; nothing in the disk slows you down.
//   * The RETURN PORTAL stands west of the arena, joined to it by a three-wide
//     road_stone road, so the walk in is fast too. The way out is always open.
//   * The ENTRY portals stand in the Vale Crossing hub, in a tight group just outside
//     the village gate, each on its own road_stone spur off the town's east road
//     (see HUB_SPURS, which belongs to vale-region.map.json's vale_hub).

const fs = require('node:fs');
const path = require('node:path');

const TILE = 100;
const SIZE_TILES = 64;
const CHUNK_SIZE = 32;
const CENTER_PX = (SIZE_TILES * TILE) / 2;           // 3200: the arena centre, a tile corner
const PAVED_RADIUS_PX = 700;                          // the floor (bossArena.js asks for 450 open)
const PORTAL_TILE = { row: 32, col: 14 };             // west of the arena, 17 tiles from its centre
const ROAD_TILE = 'road_stone';

// The four hub pads, as pixel CENTRES of their tiles, in a 2x2 group either side of
// the east road (row 46) two tiles out from the village gate (tile 46,49; its exit is
// col 50). Distance to the gate centre (4950, 4650): 283 px (inner) and 447 px (outer).
const HUB_PORTALS = {
  arena_glacius: { row: 44, col: 51 },
  arena_ignis: { row: 44, col: 53 },
  arena_abyssor: { row: 48, col: 51 },
  arena_gorgon: { row: 48, col: 53 },
};
// The spurs that pave the way to each pad: from the east road (row 46) to the pad.
// vale-region.map.json's vale_hub carries these as authored roads.
const HUB_SPURS = [
  { type: ROAD_TILE, line: [[46, 51], [44, 51]] },
  { type: ROAD_TILE, line: [[46, 53], [44, 53]] },
  { type: ROAD_TILE, line: [[46, 51], [48, 51]] },
  { type: ROAD_TILE, line: [[46, 53], [48, 53]] },
];

const ARENAS = [
  { key: 'arena_glacius', name: 'Boss Arena: Glacius', seed: 7101, biome: 'Frostvault' },
  { key: 'arena_ignis', name: 'Boss Arena: Ignis', seed: 7102, biome: 'Emberdepths' },
  { key: 'arena_abyssor', name: 'Boss Arena: Abyssor', seed: 7103, biome: 'Abyssal Rift' },
  { key: 'arena_gorgon', name: 'Boss Arena: Gorgon', seed: 7104, biome: 'Storm Coast' },
];

const tileCentre = (n) => n * TILE + TILE / 2;

// One horizontal segment per row of the disk: the cells whose CENTRE is within the
// radius of the arena centre. Contiguous per row by construction.
function diskRoads(radiusPx = PAVED_RADIUS_PX) {
  const out = [];
  for (let row = 0; row < SIZE_TILES; row += 1) {
    const dy = tileCentre(row) - CENTER_PX;
    if (Math.abs(dy) > radiusPx) continue;
    const half = Math.sqrt(radiusPx * radiusPx - dy * dy);
    let c0 = null; let c1 = null;
    for (let col = 0; col < SIZE_TILES; col += 1) {
      if (Math.abs(tileCentre(col) - CENTER_PX) <= half) { if (c0 === null) c0 = col; c1 = col; }
    }
    if (c0 !== null) out.push({ type: ROAD_TILE, line: [[row, c0], [row, c1]] });
  }
  return out;
}

// The road from the return portal to the disk: three tiles wide (rows 31..33), from a
// tile west of the portal to inside the disk's west edge.
function approachRoads() {
  const out = [];
  for (let row = PORTAL_TILE.row - 1; row <= PORTAL_TILE.row + 1; row += 1) {
    out.push({ type: ROAD_TILE, line: [[row, PORTAL_TILE.col - 1], [row, 27]] });
  }
  return out;
}

function buildSpec() {
  const worlds = ARENAS.map((a, i) => ({
    key: a.key,
    name: a.name,
    seed: a.seed,
    width: SIZE_TILES,
    height: SIZE_TILES,
    chunk_size: CHUNK_SIZE,
    biomes: [a.biome],
    biome_cell: 16,
    allowed_creature_types: [],
    density: 'dead',
    // The validator wants exactly one entry world per spec; this one is only a placeholder
    // (apply with KEEP_ENTRY=1 so the game's real entry world is not moved here).
    is_entry: i === 0,
    entry_spawn: { x: tileCentre(PORTAL_TILE.col + 2), y: tileCentre(PORTAL_TILE.row) },
    roads: [...approachRoads(), ...diskRoads()],
  }));
  // Each link is ONE row pair: the return portal in the arena (from) and the entry
  // portal in the hub (to), both written by the seeder, exactly like the Spire's.
  const links = ARENAS.map((a) => ({
    kind: 'portal',
    from: a.key,
    from_x: tileCentre(PORTAL_TILE.col),
    from_y: tileCentre(PORTAL_TILE.row),
    to: '@Vale Crossing',
    to_name: 'Vale Crossing',
    to_x: tileCentre(HUB_PORTALS[a.key].col),
    to_y: tileCentre(HUB_PORTALS[a.key].row),
  }));
  return { name: 'boss-arenas', topology: 'portal-arenas-off-the-hub', worlds, links };
}

const SPEC_PATH = path.join(__dirname, '..', 'seeds', 'maps', 'boss-arenas.map.json');
const render = (spec) => `${JSON.stringify(spec, null, 2)}\n`;

if (require.main === module) {
  const text = render(buildSpec());
  if (process.argv.includes('--check')) {
    const have = fs.existsSync(SPEC_PATH) ? fs.readFileSync(SPEC_PATH, 'utf8').replace(/\r\n/g, '\n') : '';
    if (have !== text) { console.error('boss-arenas.map.json is stale: run gen-boss-arenas-spec.js'); process.exit(1); }
  } else {
    fs.writeFileSync(SPEC_PATH, text);
    console.log(`wrote ${SPEC_PATH}`);
  }
}

module.exports = {
  buildSpec, render, diskRoads, approachRoads, tileCentre, ARENAS, HUB_PORTALS, HUB_SPURS,
  TILE, SIZE_TILES, CHUNK_SIZE, CENTER_PX, PAVED_RADIUS_PX, PORTAL_TILE, ROAD_TILE, SPEC_PATH,
};
