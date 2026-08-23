// backend/scripts/dungeon/gen-p5-map-content.js
//
// Generates backend/seeds/maps/p5-descent.map.json: 8 chained dungeons
// (Task 1's DUNGEONS, Task 3's SKELETONS) escalating via Task 2's math,
// plus 10 standalone surface worlds. See
// docs/superpowers/specs/2026-08-08-p5-map-content-design.md.
const fs = require('fs');
const path = require('path');
const { DUNGEONS, SURFACE_BIOMES } = require('./content');
const { deriveLevelBand, deriveDensity, deriveSize } = require('./escalation');
const { SKELETONS } = require('./skeletons');
// EDGE_DELTA is the same compass-grid convention validateMapSpec enforces --
// imported (not duplicated) so a surface-world graft point computed here can
// never drift from what the validator considers "adjacent". mapSpec.js is a
// pure, database-free require (see its own header comment): it only pulls in
// villages.js/densityTiers.js, neither of which creates a DB pool at import
// time.
const { EDGE_DELTA } = require('../../seeds/mapSpec.js');
const CHUNK_SIZE = 32;
const SURFACE_SIZE = 96;    // the size ramp's shallowest step

// World-pixel centre of a SIZE x SIZE world at 100 px/tile: tile index
// SIZE/2, whose centre is SIZE/2 * 100 + 50. This was the module constant
// PORTAL_TILE_PX = 3250, which is this expression hand-evaluated at
// WORLD_SIZE = 64. Once size varies per world (SOMET-304) it has to be
// computed from that world's own size, or a deep world's portal arrival
// lands in its top-left quadrant instead of its middle.
//
// Every size on the ramp is even, so SIZE/2 is always an integer.
function portalCenterPx(size) {
  return (size / 2) * 100 + 50;
}

// The entry village box, centred on a SIZE x SIZE world. 6x4, NOT 6x5:
// SOMET-282 caps width + height at VILLAGE_LIMITS.maxSum (10 tiles), the
// largest village whose on-screen bounding box fits in a quarter of the
// 1280x720 viewport. See services/villages.js for the derivation.
//
// The spawn sits two tiles west and three tiles north of centre -- interior
// for this box, and far enough in that the whole 64px player square lands
// inside the interior. It also avoids the merchant post and both gate-guard
// posts. At size 64 this reproduces the hand-written literal it replaces.
function entryVillageBox(size, key) {
  const c = size / 2;                       // centre tile index
  return {
    // REQUIRED since SOMET-312, and first emitted here by SOMET-451. `key` is
    // the village's identity: it is what lets a re-seed MOVE a village instead
    // of leaving it where it was, and validateMapSpec rejects a village
    // without one. It reached the checked-in spec as a hand patch and the
    // generator never learned it, so regenerating p5-descent silently dropped
    // all three village keys and produced a spec that no longer validated --
    // the same shape of bug as the allows_fast_travel hand patch this file
    // already carries a comment about (SOMET-306). Generated, not hand-held.
    key,
    min_row: c - 4, min_col: c - 4, width: 6, height: 4, gate_edge: 'S',
    spawn_x: (c - 2) * 100 + 50,
    spawn_y: (c - 3) * 100 + 50,
  };
}

// "The Underdeep: Hub" -> "underdeep-hub". The dungeon's own name, minus a
// leading article and its room suffix, slugified. Reproduces the three keys
// that were hand-written into the spec, so this is not a rename.
function villageKeyFor(worldName) {
  return worldName
    .split(':')[0]
    .replace(/^The\s+/i, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') + '-hub';
}

const DUNGEON_GRID_SPACING = 12; // cells between each dungeon's local grid origin -- wider than any skeleton's own bounding box (max 5x3)

const OPPOSITE_EDGE = { N: 'S', S: 'N', E: 'W', W: 'E' };

// Portal placement: when a world has a village, the portal must sit OUTSIDE
// the village (not on the gate, wall, or interior), so it does not block the
// city entrance or spawn inside the city. For a south-facing village gate,
// place the portal outside the village south wall.
function portalPlacement(world) {
  if (world && world.village) {
    const v = world.village;
    const midCol = v.min_col + Math.floor(v.width / 2);
    // 4 tiles south of the village south wall, outside the city
    const row = v.min_row + v.height + 4;
    const col = midCol;
    return { x: col * 100 + 50, y: row * 100 + 50 };
  }
  return { x: portalCenterPx(world.width), y: portalCenterPx(world.width) };
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
  // The rest of D7 (default seeds 5601-5607) and all of D8 plus one surface
  // world turned out to have the same terrain-luck problem once the
  // navigability check reached past d7_entry -- seed-map.js's loop
  // throws on the first bad world, so these were masked behind the earlier
  // failures above until those were fixed. Found via a read-only offline
  // scan against the real navigability checker (assertNavigable +
  // buildWorldGenConfig), not further live-apply guessing.
  d7_cache: 9001,
  d7_gorge: 9101,
  d7_deep: 9200,
  d8_spokeN: 9500,
  d8_spokeS: 9600,

  // --- SOMET-306 retune -- deriveSize gave these 9 worlds a size other than
  // the 64 every seed above was screened at. The terrain generator's output
  // for a given seed depends on the world's dimensions, not just the seed
  // itself -- so a seed that was fine (or simply never checked) at 64 can
  // reopen the exact terrain-luck problem the block above exists to fix, once
  // the world grows. Found the same way as the block above: an offline scan
  // against the real navigability checker (assertNavigable +
  // buildWorldGenConfig + requiredTilesFor, no DB, no live-apply guessing),
  // this time re-run after deriveSize resized each affected world.

  // d3_eastwing grew to 128 (was 64). At 128, seed 5212 -- this room's own
  // pre-SOMET-306 override, picked for the size-64 terrain -- blocked its E
  // doorway and the arrival tiles one step in from its W and E doorways, and
  // left only 3/15876 interior cells reachable from the W doorway --
  // effectively sealed.
  d3_eastwing: 20000,
  // d5_spokeW grew to 160 (was 64, and never previously needed an override --
  // its default seed 5404 was only ever screened at 64). At 160 it blocked
  // the arrival tile one step in from its E doorway and left only 3/24964
  // interior cells reachable -- effectively sealed.
  d5_spokeW: 20500,
  // d7_pass grew to 224 (was 64; its pre-SOMET-306 override 5721 was picked
  // for the size-64 terrain; this room, with all four compass edges
  // consumed, is the most seed-sensitive in the chain). At 224 it blocked
  // its S doorway and the arrival tile one step in.
  d7_pass: 21006,
  // d7_end grew to 224 (was 64; pre-SOMET-306 override 9300). At 224 it
  // blocked the arrival tile one step in from its W doorway, its D7->D8
  // portal source tile, and left only 3/49284 interior cells reachable --
  // effectively sealed.
  d7_end: 21500,
  // d8_hub grew to 224 (was 64; pre-SOMET-306 override 9408). At 224 it
  // blocked the arrival tile one step in from its W doorway (the D7->D8
  // portal's arrival room).
  d8_hub: 22004,
  // d8_spokeE grew to 224 (was 64, and never previously needed an override --
  // its default seed 5702 was only ever screened at 64). At 224 it blocked
  // its N doorway, the arrival tiles one step in from both its W and N
  // doorways, and left only 3/49284 interior cells reachable -- effectively
  // sealed.
  d8_spokeE: 22502,
  // d8_subBranch grew to 224 (was 64, never previously needed an override --
  // default seed 5705, only ever screened at 64). At 224 it blocked the
  // arrival tile one step in from its S doorway.
  d8_subBranch: 23000,
  // surface_storm_coast_0 grew to 96 (was 64; pre-SOMET-306 override 9700 --
  // this world's own default seed already needed an unrelated size-64
  // terrain-luck fix once). At 96 it blocked the arrival tile one step in
  // from its N doorway and left only 3/8836 interior cells reachable --
  // effectively sealed.
  surface_storm_coast_0: 23501,
  // surface_storm_coast_1 grew to 96 (was 64, never previously needed an
  // override -- default seed 6051, only ever screened at 64). At 96 it
  // blocked the arrival tile one step in from its W doorway.
  surface_storm_coast_1: 24001,
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
      width: null, height: null, chunk_size: CHUNK_SIZE,   // set by the size pass in generateSpec
      biomes: secondBiome && secondBiome !== biome ? [biome, secondBiome] : [biome],
      biome_cell: 16,
      allowed_creature_types: [creatureName(line, 'Swarm'), creatureName(line, 'Skirmisher'), creatureName(line, 'Line')],
      is_entry: false,
    };
    if (skeleton.needsVillageAtEntry && room.role === 'entry') {
      // The village box is centred on the world, so it cannot be stamped
      // until deriveSize has run. Mark the room and let generateSpec's
      // finalisation pass stamp it; the marker is deleted there so it never
      // reaches the JSON.
      world._needsVillage = true;
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

// Every free (unused) compass edge across the CANDIDATE dungeons' rooms,
// grouped by dungeon in skeleton room order, one entry per room listing ALL
// of that room's unconsumed edges (not just the first). "Free" here means
// edge-wise only: not used as either side of any of that dungeon's own
// skeleton links -- a link A --edge--> B consumes A's `edge` AND B's
// opposite edge (setLink writes that mirror in the database), so both
// directions are marked used here even though the JSON only declares one.
// Grid-cell collisions (a candidate edge's delta landing on another room's
// own cell) are checked separately, in pickGraftPoints, against the running
// `occupied` set -- this function only knows about declared links.
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
        const edges = ['N', 'E', 'S', 'W'].filter((e) => !(usedEdges.get(w.key) || new Set()).has(e));
        return edges.length ? { worldKey: w.key, grid: w.grid, edges } : null;
      })
      .filter(Boolean));
}

// Picks `count` (room, free-edge) graft points, at most one per room, spread
// across dungeons rather than piled on a single one: round-robin across the
// candidate queues of the dungeons `dungeonBuilds` was called with,
// alternating scan direction each round so a second pass doesn't always
// favor the same dungeons.
//
// Callers pass only the shallowest dungeons (see buildSurfaceWorlds below,
// SOMET-251 final review): surface worlds are shallow content
// (level_band [1,8]/[4,12], hardcoded, not derived from graph position), so
// their graft point must sit near the entry too, or a new player has to
// clear the entire dungeon chain just to reach a starter-tier surface zone --
// breaking whole-graph escalation monotonicity even though every dungeon
// room's own escalation stays clean. D1+D2 alone have enough uncollided free
// edges to comfortably clear the 10 grafts needed (see buildSurfaceWorlds).
//
// `occupied` is the set of grid cells (as "x,y" strings) already claimed by
// ANY room across ALL 8 dungeons, PLUS every graft's own destination cell as
// it is accepted -- so an accepted graft can never collide with a
// pre-existing room OR an earlier accepted graft. Restricting grafts to
// D1+D2 packs far more of the 10 grafts into two dungeons' free edges than
// the old round-robin-across-8 version did, which surfaced a latent
// collision the original code never checked for at all: a candidate edge's
// delta can land exactly on another room's own grid cell (e.g. d1_shrine, a
// branch room a few cells off the spine) even though that cell was never
// "used" in the edge sense -- nothing ever declared a link there. Each
// candidate room tries its free edges in order and is skipped entirely (not
// retried later) only if every one of them collides.
function pickGraftPoints(dungeonBuilds, count, occupied) {
  const perDungeonQueues = findFreeEdgesByDungeon(dungeonBuilds);
  const grafts = [];
  let round = 0;
  while (grafts.length < count) {
    const order = perDungeonQueues.map((_, idx) => idx);
    if (round % 2 === 1) order.reverse();
    for (const d of order) {
      if (grafts.length >= count) break;
      const q = perDungeonQueues[d];
      if (q.length <= round) continue;
      const candidate = q[round];
      const edge = candidate.edges.find((e) => {
        const [dx, dy] = EDGE_DELTA[e];
        return !occupied.has(`${candidate.grid[0] + dx},${candidate.grid[1] + dy}`);
      });
      if (!edge) continue; // every free edge of this room collides -- skip the room
      const [dx, dy] = EDGE_DELTA[edge];
      occupied.add(`${candidate.grid[0] + dx},${candidate.grid[1] + dy}`);
      grafts.push({ worldKey: candidate.worldKey, grid: candidate.grid, edge });
    }
    round += 1;
    if (round > 20) throw new Error('ran out of free, uncollided compass edges while grafting surface worlds onto the dungeon chain');
  }
  return grafts;
}

// worlds[] plus one ordinary compass link per world, each grafted onto its
// own distinct free edge somewhere across the shallowest dungeons -- no links
// between any two surface worlds, so they stay genuinely "standalone, not
// chained to each other" (the design doc's phrasing) while still resolving to
// a real physical link, which validateMapSpec's entry-BFS reachability check
// requires (see backend/seeds/mapSpec.js). A surface world's grid position
// is therefore its graft room's grid cell plus that edge's delta -- not a
// fixed column -- which is what keeps every link's declared edge consistent
// with the grid the validator checks it against.
//
// Only D1 and D2's free edges are candidates (SOMET-251 final review,
// Important #3), not all 8 dungeons: surface worlds carry a hardcoded shallow
// level_band regardless of where they graft on, so grafting one 31 hops deep
// into the endgame chain (as the old round-robin-across-all-8 version did for
// surface_ashfields_0, landing it in The Abyss) makes a level 1-8 zone sit
// behind the entire dungeon chain -- content-nonsensical, and it breaks the
// design doc's whole-graph escalation-is-monotonic acceptance criterion. D1+D2
// keep every graft within a couple of hops of the entry, matching the bands.
function buildSurfaceWorlds(dungeonBuilds) {
  const worlds = [];
  const links = [];
  const flat = [];
  SURFACE_BIOMES.forEach((s) => {
    for (let variant = 0; variant < 2; variant++) flat.push({ s, variant });
  });

  // Occupied by every room across ALL 8 dungeons (not just D1/D2, the
  // candidate source below) -- a graft's destination cell must never land on
  // ANY existing room's grid position, wherever in the chain it sits.
  const occupied = new Set();
  for (const { built } of dungeonBuilds) {
    for (const w of built.worlds) occupied.add(w.grid.join(','));
  }
  const shallowDungeonBuilds = dungeonBuilds.slice(0, 2); // D1, D2 -- see header comment above
  const grafts = pickGraftPoints(shallowDungeonBuilds, flat.length, occupied);

  flat.forEach(({ s, variant }, row) => {
    const key = `surface_${s.biome.toLowerCase().replace(/\s+/g, '_')}_${variant}`;
    const graft = grafts[row];
    const [dx, dy] = EDGE_DELTA[graft.edge];
    worlds.push({
      key,
      name: `${s.biome} ${variant === 0 ? 'Reach' : 'Frontier'}`,
      grid: [graft.grid[0] + dx, graft.grid[1] + dy],
      seed: SEED_OVERRIDES[key] ?? (6000 + row * 10 + variant),
      // Surface worlds graft onto D1/D2, the two shallowest dungeons, and
      // carry hand-set shallow bands -- so they take the ramp's first step
      // rather than going through deriveSize.
      width: SURFACE_SIZE, height: SURFACE_SIZE, chunk_size: CHUNK_SIZE,
      biomes: [s.biome],
      biome_cell: 16,
      allowed_creature_types: [creatureName(s.line, 'Swarm'), creatureName(s.line, 'Skirmisher'), creatureName(s.line, 'Line')],
      is_entry: false,
      level_band: variant === 0 ? [1, 8] : [4, 12],
      density: variant === 0 ? 'sparse' : 'normal',
      // allows_fast_travel is NOT set here -- see applyFirstJoinFlags below,
      // which derives it from the assembled graph. Setting it unconditionally
      // (which is what this line used to do) flagged 5 surface worlds that sit
      // BEHIND the d1_end -> d2_hub guard, so a character with no history could
      // first-join one and walk into The Underdeep without meeting it
      // (SOMET-451). The flag was originally a hand patch on the checked-in
      // spec that the generator did not know about and silently dropped on
      // regeneration (SOMET-306) -- it belongs in the generator, but derived,
      // not asserted.
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
      // Structure only. The BFS below needs from/to to compute hop distance,
      // and hop distance is what decides each world's size -- so coordinates,
      // which depend on size, cannot be filled until after that. The
      // finalisation pass at the end of this function fills them.
      portalLinks.push({
        kind: 'portal',
        from: prevExit, from_x: null, from_y: null,
        to: built.entryKey, to_x: null, to_y: null,
        guard: { creature_type: dungeon.guardCreature, count: 1 },
      });
    } else {
      // D1's entry is the spec's sole is_entry -- no separate surface
      // gateway world needed; is_entry alone is what makes new characters
      // spawn here (see the design doc's "is_entry handling" section).
      const entryWorld = allWorlds.find((w) => w.key === built.entryKey);
      entryWorld.is_entry = true;
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
  // maxHop is computed over the ATTACHMENT-SUBSTITUTED hops (bandHopOf), so a
  // branch room's own raw BFS distance can exceed it (a branch always sits at
  // least one hop past its attachment point) -- hopFraction is clamped to
  // [0,1] below rather than trusted to land in range, so that invariant does
  // not depend on deriveDensity's internal Math.min clamp (a different
  // module's implementation detail).
  const maxHop = Math.max(...allWorlds.map(bandHopOf));
  for (const w of allWorlds) {
    const dungeon = DUNGEONS.find((d) => w.key.startsWith(`${d.key}_`));
    // density uses the SAME attachment-substituted hop as level_band
    // (bandHopOf, not the room's own raw dist.get(w.key)) -- escalation.js's
    // header comment documents branch rooms banding like their attachment
    // point, and that contract applies to density exactly as much as it does
    // to level_band. Using the raw hop here used to make every branch room
    // (e.g. a hub's spokes) mismatch its hub's density tier.
    const rawFraction = maxHop === 0 ? 0 : bandHopOf(w) / maxHop;
    const hopFraction = Math.min(1, Math.max(0, rawFraction));
    w.level_band = deriveLevelBand(hopFraction, dungeon.tierClamp);
    w.density = deriveDensity(hopFraction);
    // Third progression-scaled property from the same hopFraction. Assigned
    // here rather than in buildDungeon because hop distance is only known
    // once the whole graph is assembled.
    w.width = deriveSize(hopFraction);
    w.height = w.width;
  }

  // Everything below depends on a world's final size, so it runs after the
  // size assignment above and nowhere earlier.
  const sizedByKey = new Map([...allWorlds, ...surfaceWorlds].map((w) => [w.key, w]));

  // Stamp the deferred entry villages now that sizes are known.
  for (const w of allWorlds) {
    if (!w._needsVillage) continue;
    delete w._needsVillage;
    w.village = entryVillageBox(w.width, villageKeyFor(w.name));
  }

  // The sole is_entry world spawns new characters at its centre.
  const d1Entry = sizedByKey.get(d1EntryKey);
  d1Entry.entry_spawn = {
    x: portalCenterPx(d1Entry.width),
    y: portalCenterPx(d1Entry.width),
  };

  // Portal coordinates. Hub-topology destinations have a village stamped at
  // their entry room -- portals sit outside the village so they never spawn
  // inside the city or block the village gate. Spine/loop destinations have no
  // village at their entry room, so they keep the centre-tile convention.
  for (const l of portalLinks) {
    const from = sizedByKey.get(l.from);
    const to = sizedByKey.get(l.to);
    const departure = portalPlacement(from);
    const arrival = portalPlacement(to);
    l.from_x = departure.x;
    l.from_y = departure.y;
    l.to_x = arrival.x;
    l.to_y = arrival.y;
  }

  // Minor #6 (SOMET-251 final review): SEED_OVERRIDES[globalKey] ?? default
  // silently no-ops if a key is ever mistyped or a room gets renamed -- no
  // error, just a quiet fall-through to the (probably-unnavigable) default
  // seed. Assert every override actually landed on a real world with that
  // exact seed, so a future typo/rename fails loudly here instead of shipping
  // a room the navigability check (seed-map.js, or tests/p5_navigability.test.js)
  // was specifically tuned to route around.
  const finalWorlds = [...allWorlds, ...surfaceWorlds];
  const finalByKey = new Map(finalWorlds.map((w) => [w.key, w]));
  for (const [key, overrideSeed] of Object.entries(SEED_OVERRIDES)) {
    const w = finalByKey.get(key);
    if (!w) {
      throw new Error(`SEED_OVERRIDES has an entry for "${key}" but no world with that key was generated`);
    }
    if (w.seed !== overrideSeed) {
      throw new Error(`SEED_OVERRIDES["${key}"] = ${overrideSeed} was never applied (world's seed is ${w.seed})`);
    }
  }

  const finalLinks = [...allLinks, ...portalLinks];
  applyFirstJoinFlags(finalWorlds, finalLinks);

  return {
    name: 'p5-descent',
    topology: 'chained-dungeons-plus-surface',
    worlds: finalWorlds,
    links: finalLinks,
  };
}

// SOMET-451. Which worlds may a character with NO HISTORY join?
//
// `allows_fast_travel` no longer authorizes travel -- SOMET-293 retired that
// leg -- but it is still the sole input to joinPolicy's `first-join`
// (src/services/joinPolicy.js:157): `!hasHistory && (isEntry ||
// allowsFastTravel)`. So a flagged world is a world a brand-new character can
// be created directly into.
//
// The rule that has to hold: never flag a world that sits behind a portal
// guard, or the guard is skippable by making a new character. Derived from the
// graph rather than hand-listed, because the hand-listed version is what went
// wrong -- the old code flagged all 10 surface worlds unconditionally, and 5 of
// them hang off d2_* rooms, which are only reachable through the
// d1_end -> d2_hub Fungal Line.
//
// The remaining 5 keep the flag, which matters: the `first-join` leg exists so
// that a new character is not locked out if `is_entry` is lost from live data,
// as it was in SOMET-265. Those 5 are reachable without passing any guard, so
// the safety net survives at full strength.
//
// Pinned from the other side by tests/dungeon_guard_invariants.test.js, which
// asserts the same property over every shipped spec.
function applyFirstJoinFlags(worlds, links) {
  const entry = worlds.find((w) => w.is_entry === true);
  if (!entry) throw new Error('applyFirstJoinFlags: no entry world');

  // Adjacency WITHOUT guarded portals: what a character can reach on foot
  // from the entry without ever defeating a guard.
  const adjacency = new Map(worlds.map((w) => [w.key, []]));
  for (const l of links) {
    if (l.kind === 'portal' && l.guard) continue;
    adjacency.get(l.from).push(l.to);
    adjacency.get(l.to).push(l.from);
  }
  const free = new Set([entry.key]);
  const queue = [entry.key];
  while (queue.length) {
    for (const next of adjacency.get(queue.shift()) ?? []) {
      if (!free.has(next)) { free.add(next); queue.push(next); }
    }
  }

  // Surface worlds only. A dungeon room is never a first-join target even
  // when it is guard-free (D1's rooms are), because dropping a new character
  // into a dungeon is not what the safety net is for.
  let flagged = 0;
  for (const w of worlds) {
    if (!w.key.startsWith('surface_')) continue;
    if (!free.has(w.key)) continue;
    w.allows_fast_travel = true;
    flagged++;
  }
  if (flagged === 0) {
    throw new Error('applyFirstJoinFlags: no world is a valid first-join target -- '
      + 'a new character would be locked out if is_entry were ever lost');
  }
  return flagged;
}

function writeOutput() {
  const spec = generateSpec();
  const outPath = path.join(__dirname, '../../seeds/maps/p5-descent.map.json');
  fs.writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n');
  console.log(`Wrote ${spec.worlds.length} worlds, ${spec.links.length} links to ${outPath}`);
}

module.exports = { generateSpec, portalCenterPx, entryVillageBox, villageKeyFor };
if (require.main === module) writeOutput();
