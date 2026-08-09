// backend/scripts/dungeon/gen-p5-map-content.js
//
// Generates backend/seeds/maps/p5-descent.map.json: 8 chained dungeons
// (Task 1's DUNGEONS, Task 3's SKELETONS) escalating via Task 2's math,
// plus 10 standalone surface worlds. See
// docs/superpowers/specs/2026-08-08-p5-map-content-design.md.
const fs = require('fs');
const path = require('path');
const { DUNGEONS, SURFACE_BIOMES } = require('./content');
const { deriveLevelBand, deriveDensity } = require('./escalation');
const { SKELETONS } = require('./skeletons');
// EDGE_DELTA is the same compass-grid convention validateMapSpec enforces --
// imported (not duplicated) so a surface-world graft point computed here can
// never drift from what the validator considers "adjacent". mapSpec.js is a
// pure, database-free require (see its own header comment): it only pulls in
// villages.js/densityTiers.js, neither of which creates a DB pool at import
// time.
const { EDGE_DELTA } = require('../../seeds/mapSpec.js');
const WORLD_SIZE = 64;      // matches the 3 shipped examples
const CHUNK_SIZE = 32;
const PORTAL_TILE_PX = 3250; // world-pixel center of a 64x64 world, 100px/tile -- same convention the shipped specs use for entry_spawn
const DUNGEON_GRID_SPACING = 12; // cells between each dungeon's local grid origin -- wider than any skeleton's own bounding box (max 5x3)

const OPPOSITE_EDGE = { N: 'S', S: 'N', E: 'W', W: 'E' };

// Pixel arrival point at a hub-topology dungeon's village gate cell, computed
// the same way mapService.js's villageGateCell() selects the gate tile: gate
// row = minRow + height - 1, gate col = minCol + floor(width/2), for
// gate_edge 'S' (the only edge any hub dungeon's village uses in this plan).
// A fixed world-center portal arrival (PORTAL_TILE_PX) lands on the village's
// south wall -- always a wooden_wall tile, one column off from the gate --
// for every hub dungeon, since they all share this identical village
// geometry (SOMET-251). Grafting an inbound portal onto a hub dungeon must
// land here instead, so arriving players hit the (walkable) gate, not the
// wall next to it.
function villageGateArrival(village) {
  const { min_row, min_col, width, height, gate_edge } = village;
  const midCol = min_col + Math.floor(width / 2);
  const midRow = min_row + Math.floor(height / 2);
  const rMax = min_row + height - 1;
  const cMax = min_col + width - 1;
  let row, col;
  if (gate_edge === 'N') { row = min_row; col = midCol; }
  else if (gate_edge === 'S') { row = rMax; col = midCol; }
  else if (gate_edge === 'W') { row = midRow; col = min_col; }
  else if (gate_edge === 'E') { row = midRow; col = cMax; }
  else throw new Error(`villageGateArrival: unsupported gate_edge ${gate_edge}`);
  return { x: col * 100 + 50, y: row * 100 + 50 };
}

// A "{Line} {Rung}" name, exactly gen-p4-bestiary.js's convention -- every
// one of the 288 P4 creatures is named this way.
function creatureName(line, rung) { return `${line} ${rung}`; }

// Per-room seed overrides, keyed by global room key. buildDungeon()'s
// default seed formula (5000 + dungeonIndex*100 + i) is deterministic but
// otherwise arbitrary -- ordinary procgen bad luck can have it land
// impassable terrain (cave_wall/rubble/chasm) on a tile a skeleton link
// needs as a doorway, which seed-map.js's navigability check then rejects.
// This is not a structural conflict (see villageGateArrival above for that
// class); it's exactly the terrain-luck case the implementation plan
// anticipated (docs/superpowers/plans/2026-08-08-p5-map-content.md, Task 7
// Step 3), fixed by trying a different seed for just that room.
const SEED_OVERRIDES = {
  // Default 5200 (5000 + dungeonIndex 2 * 100 + room 0) blocked d3_entry's S
  // doorway -- the link consumed by d3_southwing --N--> d3_entry (LOOP
  // skeleton's closing edge) -- with impassable terrain at (63,32)/(62,32).
  // Picked 5210 (not 5201) to avoid colliding with d3_spur's own default
  // seed (5201, dungeonIndex 2 * 100 + room 1) -- a collision would give two
  // distinct rooms byte-identical terrain, which is confusing even though
  // it isn't itself a correctness bug (each room's own doorway set still
  // gets checked against that terrain independently).
  d3_entry: 5210,
  // Default 5201 blocked d3_spur's E doorway -- the link entry --W--> spur
  // (LOOP skeleton) -- with impassable terrain; only 3/3844 interior cells
  // reachable from the doorway. Same terrain-luck class, different room,
  // surfaced only once d3_entry's own failure above stopped masking it
  // (seed-map.js's navigability loop throws on the first bad world).
  d3_spur: 5211,
  // Default 5202 blocked d3_eastwing's E doorway -- the link
  // eastwing --E--> farhall (LOOP skeleton) -- with impassable terrain at
  // (32,63)/(32,62). Same terrain-luck class as d3_entry/d3_spur above.
  d3_eastwing: 5212,
  // Default 5204 blocked d3_heart's W doorway (link heart --W--> deepvault),
  // N doorway (arrival for farhall --S--> heart) and the D3->D4 portal
  // source tile at world-center (32,32) -- interior almost entirely sealed
  // (3/3844 cells reachable). Same terrain-luck class as the rooms above.
  d3_heart: 5215,
  // Default 5600 (5000 + dungeonIndex 6 * 100 + room 0) blocked d7_entry's N
  // doorway (its one free edge, used for a surface-world graft link) and the
  // D6->D7 portal arrival at world-center (32,32) -- interior almost
  // entirely sealed (3/3844 cells reachable). Same terrain-luck class as the
  // d3 rooms above. 5715 chosen (not 5601-5607, already the other d7 rooms'
  // default seeds) to avoid giving two distinct rooms byte-identical terrain.
  d7_entry: 5715,
  // Default 5601 blocked d7_pass's doorways -- it has all FOUR compass edges
  // consumed (W from d7_entry --E--> d7_pass, plus its own N/S/E links to
  // cache/elite/gorge), the most constrained room in the whole chain, so it
  // is the most seed-sensitive. Same terrain-luck class as the rooms above.
  d7_pass: 5721,
  // The rest of D7 (default seeds 5602-5607) and all of D8 plus one surface
  // world turned out to have the same terrain-luck problem once the
  // navigability check reached past d7_entry/d7_pass -- seed-map.js's loop
  // throws on the first bad world, so these were masked behind the earlier
  // failures above until those were fixed. Found via a read-only offline
  // scan against the real navigability checker (assertNavigable +
  // buildWorldGenConfig), not further live-apply guessing.
  d7_cache: 9001,
  d7_gorge: 9101,
  d7_deep: 9200,
  d7_end: 9300,
  d8_hub: 9408,
  d8_spokeN: 9500,
  d8_spokeS: 9600,
  surface_storm_coast_0: 9700,
};

function buildDungeon(dungeon, dungeonIndex) {
  const skeleton = SKELETONS[dungeon.topology];
  const originX = 20 + dungeonIndex * DUNGEON_GRID_SPACING;
  const originY = 0;
  const worlds = [];
  const links = [];
  const keyMap = new Map(); // skeleton-local key -> globally-unique key

  skeleton.rooms.forEach((room, i) => {
    const globalKey = `${dungeon.key}_${room.key}`;
    keyMap.set(room.key, globalKey);
    const lineIdx = i % dungeon.lines.length;
    const { line, biome } = dungeon.lines[lineIdx];
    const secondBiome = dungeon.lines.length > 1 ? dungeon.lines[(lineIdx + 1) % dungeon.lines.length].biome : null;

    const world = {
      key: globalKey,
      name: `${dungeon.name}: ${room.key[0].toUpperCase()}${room.key.slice(1)}`,
      grid: [originX + room.grid[0], originY + room.grid[1]],
      seed: SEED_OVERRIDES[globalKey] ?? (5000 + dungeonIndex * 100 + i),
      width: WORLD_SIZE, height: WORLD_SIZE, chunk_size: CHUNK_SIZE,
      biomes: secondBiome && secondBiome !== biome ? [biome, secondBiome] : [biome],
      biome_cell: 16,
      allowed_creature_types: [creatureName(line, 'Swarm'), creatureName(line, 'Skirmisher'), creatureName(line, 'Line')],
      is_entry: false,
    };
    if (skeleton.needsVillageAtEntry && room.role === 'entry') {
      world.village = { min_row: 28, min_col: 28, width: 6, height: 5, gate_edge: 'S', spawn_x: PORTAL_TILE_PX, spawn_y: PORTAL_TILE_PX };
    }
    worlds.push(world);
  });

  for (const l of skeleton.links) {
    links.push({ from: keyMap.get(l.from), edge: l.edge, to: keyMap.get(l.to) });
  }

  // branch room's global key -> the global key of the critical-path room it
  // attaches to. escalation.js's contract: a branch bands/densities like its
  // attachment point, not its own (deeper) BFS distance. Consumed by
  // generateSpec once real hop distances are known.
  const attachMap = new Map();
  if (skeleton.branchAttachment) {
    for (const [roomKey, attachKey] of Object.entries(skeleton.branchAttachment)) {
      attachMap.set(keyMap.get(roomKey), keyMap.get(attachKey));
    }
  }

  return {
    worlds, links, attachMap,
    entryKey: keyMap.get(skeleton.entryRoleKey),
    exitKey: keyMap.get(skeleton.exitRoleKey),
  };
}

// Every free (unused) compass edge across all 8 dungeons' rooms, one
// candidate per room (its first free edge -- one is all a single graft
// needs), grouped by dungeon in skeleton room order. "Free" means not used
// as either side of any of that dungeon's own skeleton links: a link
// A --edge--> B consumes A's `edge` AND B's opposite edge (setLink writes
// that mirror in the database), so both directions are marked used here even
// though the JSON only declares one.
function findFreeEdgesByDungeon(dungeonBuilds) {
  const usedEdges = new Map(); // world key -> Set(edges)
  const markUsed = (key, edge) => {
    if (!usedEdges.has(key)) usedEdges.set(key, new Set());
    usedEdges.get(key).add(edge);
  };
  for (const { built } of dungeonBuilds) {
    for (const l of built.links) {
      markUsed(l.from, l.edge);
      markUsed(l.to, OPPOSITE_EDGE[l.edge]);
    }
  }

  return dungeonBuilds.map(({ built }) =>
    built.worlds
      .map((w) => {
        const free = ['N', 'E', 'S', 'W'].filter((e) => !(usedEdges.get(w.key) || new Set()).has(e));
        return free.length ? { worldKey: w.key, grid: w.grid, edge: free[0] } : null;
      })
      .filter(Boolean));
}

// Picks 10 (room, free-edge) graft points, at most one per room, spread
// across dungeons rather than piled on a single one: round-robin across the
// 8 dungeons' candidate queues, alternating scan direction each round so a
// second pass doesn't always favor the same dungeons. 8 dungeons / 50 rooms
// give 124 free edges total (verified: 3 spine dungeons x 18 + 3 hub x 14 +
// 2 loop x 14) -- 10 grafts never come close to exhausting that.
function pickGraftPoints(dungeonBuilds, count) {
  const perDungeonQueues = findFreeEdgesByDungeon(dungeonBuilds);
  const grafts = [];
  let round = 0;
  while (grafts.length < count) {
    const order = perDungeonQueues.map((_, idx) => idx);
    if (round % 2 === 1) order.reverse();
    for (const d of order) {
      if (grafts.length >= count) break;
      const q = perDungeonQueues[d];
      if (q.length > round) grafts.push(q[round]);
    }
    round += 1;
    if (round > 20) throw new Error('ran out of free compass edges while grafting surface worlds onto the dungeon chain');
  }
  return grafts;
}

// worlds[] plus one ordinary compass link per world, each grafted onto its
// own distinct free edge somewhere across the 8 dungeons -- no links between
// any two surface worlds, so they stay genuinely "standalone, not chained to
// each other" (the design doc's phrasing) while still resolving to a real
// physical link, which validateMapSpec's entry-BFS reachability check
// requires (see backend/seeds/mapSpec.js). A surface world's grid position
// is therefore its graft room's grid cell plus that edge's delta -- not a
// fixed column -- which is what keeps every link's declared edge consistent
// with the grid the validator checks it against.
function buildSurfaceWorlds(dungeonBuilds) {
  const worlds = [];
  const links = [];
  const flat = [];
  SURFACE_BIOMES.forEach((s) => {
    for (let variant = 0; variant < 2; variant++) flat.push({ s, variant });
  });

  const grafts = pickGraftPoints(dungeonBuilds, flat.length);

  flat.forEach(({ s, variant }, row) => {
    const key = `surface_${s.biome.toLowerCase().replace(/\s+/g, '_')}_${variant}`;
    const graft = grafts[row];
    const [dx, dy] = EDGE_DELTA[graft.edge];
    worlds.push({
      key,
      name: `${s.biome} ${variant === 0 ? 'Reach' : 'Frontier'}`,
      grid: [graft.grid[0] + dx, graft.grid[1] + dy],
      seed: SEED_OVERRIDES[key] ?? (6000 + row * 10 + variant),
      width: WORLD_SIZE, height: WORLD_SIZE, chunk_size: CHUNK_SIZE,
      biomes: [s.biome],
      biome_cell: 16,
      allowed_creature_types: [creatureName(s.line, 'Swarm'), creatureName(s.line, 'Skirmisher'), creatureName(s.line, 'Line')],
      is_entry: false,
      level_band: variant === 0 ? [1, 8] : [4, 12],
      density: variant === 0 ? 'sparse' : 'normal',
    });
    links.push({ from: graft.worldKey, edge: graft.edge, to: key });
  });

  return { worlds, links };
}

function generateSpec() {
  const allWorlds = [];
  const allLinks = [];
  const portalLinks = [];
  const dungeonBuilds = [];
  const attachMap = new Map(); // global room key -> its branch attachment's global key
  let prevExit = null;
  let d1EntryKey = null;

  DUNGEONS.forEach((dungeon, i) => {
    const built = buildDungeon(dungeon, i);
    dungeonBuilds.push({ dungeon, built });
    allWorlds.push(...built.worlds);
    allLinks.push(...built.links);
    for (const [k, v] of built.attachMap) attachMap.set(k, v);
    if (prevExit) {
      // Hub-topology destinations have a village stamped at their entry room
      // (skeleton.needsVillageAtEntry) -- arrive at the village's gate cell,
      // not the fixed world-center tile, or the arrival lands on the
      // village's south wall (see villageGateArrival above, SOMET-251).
      // Spine/loop destinations have no village at their entry room, so they
      // keep the existing fixed-center convention.
      const destEntryWorld = built.worlds.find((w) => w.key === built.entryKey);
      const arrival = destEntryWorld && destEntryWorld.village
        ? villageGateArrival(destEntryWorld.village)
        : { x: PORTAL_TILE_PX, y: PORTAL_TILE_PX };
      portalLinks.push({
        kind: 'portal',
        from: prevExit, from_x: PORTAL_TILE_PX, from_y: PORTAL_TILE_PX,
        to: built.entryKey, to_x: arrival.x, to_y: arrival.y,
        guard: { creature_type: dungeon.guardCreature, count: 1 },
      });
    } else {
      // D1's entry is the spec's sole is_entry -- no separate surface
      // gateway world needed; is_entry alone is what makes new characters
      // spawn here (see the design doc's "is_entry handling" section).
      const entryWorld = allWorlds.find((w) => w.key === built.entryKey);
      entryWorld.is_entry = true;
      entryWorld.entry_spawn = { x: PORTAL_TILE_PX, y: PORTAL_TILE_PX };
      d1EntryKey = built.entryKey;
    }
    prevExit = built.exitKey;
  });

  const { worlds: surfaceWorlds, links: graftLinks } = buildSurfaceWorlds(dungeonBuilds);
  allLinks.push(...graftLinks);

  // Real BFS hop distance from the single entry, over the FULLY assembled
  // undirected graph (every compass link -- dungeon-internal plus the 10
  // surface grafts -- plus the 7 inter-dungeon portal links). This replaces
  // a coarse per-room index counter, which didn't see that a loop skeleton's
  // closing edge (D3/D6: southwing -> entry) gives some rooms a shorter true
  // graph distance than their position in the room list suggests -- e.g.
  // southwing sits right next to entry via that closing edge, not six rooms
  // deep. Mirrors bfsDistances() in backend/tests/map_spec_fixtures.test.js
  // exactly, since that is the real ground truth this must agree with.
  const bfsWorlds = [...allWorlds, ...surfaceWorlds];
  const graphLinks = [...allLinks, ...portalLinks];
  const adjacency = new Map(bfsWorlds.map((w) => [w.key, []]));
  for (const l of graphLinks) {
    adjacency.get(l.from).push(l.to);
    adjacency.get(l.to).push(l.from);
  }
  const dist = new Map([[d1EntryKey, 0]]);
  const queue = [d1EntryKey];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of adjacency.get(cur) ?? []) {
      if (!dist.has(next)) { dist.set(next, dist.get(cur) + 1); queue.push(next); }
    }
  }

  // Branch rooms band like their attachment point (escalation.js's
  // contract), using its real BFS distance, not their own.
  const bandHopOf = (w) => {
    const attachKey = attachMap.get(w.key);
    return dist.get(attachKey !== undefined ? attachKey : w.key);
  };
  const maxHop = Math.max(...allWorlds.map(bandHopOf));
  for (const w of allWorlds) {
    const dungeon = DUNGEONS.find((d) => w.key.startsWith(`${d.key}_`));
    const hopFraction = maxHop === 0 ? 0 : bandHopOf(w) / maxHop;
    w.level_band = deriveLevelBand(hopFraction, dungeon.tierClamp);
    w.density = deriveDensity(dist.get(w.key) / maxHop);
  }

  return {
    name: 'p5-descent',
    topology: 'chained-dungeons-plus-surface',
    worlds: [...allWorlds, ...surfaceWorlds],
    links: [...allLinks, ...portalLinks],
  };
}

function writeOutput() {
  const spec = generateSpec();
  const outPath = path.join(__dirname, '../../seeds/maps/p5-descent.map.json');
  fs.writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n');
  console.log(`Wrote ${spec.worlds.length} worlds, ${spec.links.length} links to ${outPath}`);
}

module.exports = { generateSpec };
if (require.main === module) writeOutput();
