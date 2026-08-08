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

const WORLD_SIZE = 64;      // matches the 3 shipped examples
const CHUNK_SIZE = 32;
const PORTAL_TILE_PX = 3250; // world-pixel center of a 64x64 world, 100px/tile -- same convention the shipped specs use for entry_spawn
const DUNGEON_GRID_SPACING = 12; // cells between each dungeon's local grid origin -- wider than any skeleton's own bounding box (max 5x3)
// The 10 surface worlds must be reachable from the spec's single is_entry
// world -- validateMapSpec (backend/seeds/mapSpec.js) does a BFS over the
// WHOLE spec's link graph and rejects any world it can't reach, so
// "standalone, not chained to the dungeon" (the design doc's phrasing, about
// narrative framing) still has to resolve to *some* physical link within
// this one spec file. D1's entry room only uses its E edge (to 'pass'), so
// its N edge is free; the surface ladder anchors there and runs north
// (y < 0), well clear of every dungeon's y in {-1,0,1} row band, so it
// cannot collide with any dungeon room's grid cell. This deliberately
// contradicts the design doc's "grid layout" note (`y: 20`) in favor of the
// validator's hard reachability requirement -- see task-5-report.md.
const SURFACE_ANCHOR_X = 20;
const SURFACE_ANCHOR_Y = -1;

// A "{Line} {Rung}" name, exactly gen-p4-bestiary.js's convention -- every
// one of the 288 P4 creatures is named this way.
function creatureName(line, rung) { return `${line} ${rung}`; }

function buildDungeon(dungeon, dungeonIndex, hopOffset) {
  const skeleton = SKELETONS[dungeon.topology];
  const originX = 20 + dungeonIndex * DUNGEON_GRID_SPACING;
  const originY = 0;
  const worlds = [];
  const links = [];
  const keyMap = new Map(); // skeleton-local key -> globally-unique key

  // First pass: every room's own coarse local hop index (hopOffset + its
  // position in skeleton.rooms), keyed by the skeleton-local room key. A
  // branch room's OWN hop is looked up here only as a fallback; branch rooms
  // instead use their attachment room's hop below. Every skeleton's
  // branchAttachment always points at a room earlier in `rooms`, but this map
  // is built as its own pass (not inline) so that ordering assumption is not
  // load-bearing.
  const hopByKey = new Map();
  skeleton.rooms.forEach((room, i) => hopByKey.set(room.key, hopOffset + i));

  skeleton.rooms.forEach((room, i) => {
    const globalKey = `${dungeon.key}_${room.key}`;
    keyMap.set(room.key, globalKey);
    const hop = hopOffset + i; // coarse local hop index, refined by real BFS in the caller if needed
    const attachKey = skeleton.branchAttachment && skeleton.branchAttachment[room.key];
    // Branch rooms inherit their ATTACHMENT POINT's hop (per escalation.js's
    // contract), not the dungeon's starting hop -- a branch off a deep
    // critical-path room (e.g. spine's "shrine" off "gorge") must band like
    // that room, not like the entry.
    const bandHop = attachKey ? hopByKey.get(attachKey) : hop;
    const lineIdx = i % dungeon.lines.length;
    const { line, biome } = dungeon.lines[lineIdx];
    const secondBiome = dungeon.lines.length > 1 ? dungeon.lines[(lineIdx + 1) % dungeon.lines.length].biome : null;

    const world = {
      key: globalKey,
      name: `${dungeon.name}: ${room.key[0].toUpperCase()}${room.key.slice(1)}`,
      grid: [originX + room.grid[0], originY + room.grid[1]],
      seed: 5000 + dungeonIndex * 100 + i,
      width: WORLD_SIZE, height: WORLD_SIZE, chunk_size: CHUNK_SIZE,
      biomes: secondBiome && secondBiome !== biome ? [biome, secondBiome] : [biome],
      biome_cell: 16,
      allowed_creature_types: [creatureName(line, 'Swarm'), creatureName(line, 'Skirmisher'), creatureName(line, 'Line')],
      is_entry: false,
    };
    // placeholder, corrected below once we know the real hop fraction range
    world.__bandHop = bandHop;
    world.__globalHop = hop;
    if (skeleton.needsVillageAtEntry && room.role === 'entry') {
      world.village = { min_row: 28, min_col: 28, width: 6, height: 5, gate_edge: 'S', spawn_x: PORTAL_TILE_PX, spawn_y: PORTAL_TILE_PX };
    }
    worlds.push(world);
  });

  for (const l of skeleton.links) {
    links.push({ from: keyMap.get(l.from), edge: l.edge, to: keyMap.get(l.to) });
  }

  return { worlds, links, entryKey: keyMap.get(skeleton.entryRoleKey), exitKey: keyMap.get(skeleton.exitRoleKey), roomCount: skeleton.rooms.length };
}

// worlds[] plus the CHAIN of ordinary N compass links that connects all 10
// of them into one component, single-file up column SURFACE_ANCHOR_X. (A
// two-column ladder was tried first, but D1's 'cache' branch room sits at
// the dungeon's own grid [21,-1], one column right of the anchor -- a second
// column there collides. Single-file up one column sidesteps every
// dungeon's occupied cells, all of which sit at y in {-1,0,1}, entirely by
// construction: nothing else in the spec ever uses SURFACE_ANCHOR_X at
// y <= SURFACE_ANCHOR_Y.) This does not by itself reach the dungeon graph --
// the caller adds the one link that grafts the chain's first world onto D1's
// entry (see generateSpec).
function buildSurfaceWorlds() {
  const worlds = [];
  const links = [];
  const flat = [];
  SURFACE_BIOMES.forEach((s, i) => {
    for (let variant = 0; variant < 2; variant++) flat.push({ s, variant });
  });
  flat.forEach(({ s, variant }, row) => {
    const key = `surface_${s.biome.toLowerCase().replace(/\s+/g, '_')}_${variant}`;
    worlds.push({
      key,
      name: `${s.biome} ${variant === 0 ? 'Reach' : 'Frontier'}`,
      grid: [SURFACE_ANCHOR_X, SURFACE_ANCHOR_Y - row],
      seed: 6000 + row * 10 + variant,
      width: WORLD_SIZE, height: WORLD_SIZE, chunk_size: CHUNK_SIZE,
      biomes: [s.biome],
      biome_cell: 16,
      allowed_creature_types: [creatureName(s.line, 'Swarm'), creatureName(s.line, 'Skirmisher'), creatureName(s.line, 'Line')],
      is_entry: false,
      level_band: variant === 0 ? [1, 8] : [4, 12],
      density: variant === 0 ? 'sparse' : 'normal',
    });
    // Each next row is further NORTH (SURFACE_ANCHOR_Y - row decreases), so
    // the link from the previous row down to this one is edge 'N' (EDGE_DELTA
    // N = [0,-1] in mapSpec.js), not 'S'.
    if (row > 0) links.push({ from: flat[row - 1].key, edge: 'N', to: key });
    flat[row].key = key; // stash for the next iteration's link
  });
  return { worlds, links };
}

function generateSpec() {
  const allWorlds = [];
  const allLinks = [];
  const portalLinks = [];
  let hopCursor = 0;
  let prevExit = null;
  let d1EntryKey = null;

  DUNGEONS.forEach((dungeon, i) => {
    const built = buildDungeon(dungeon, i, hopCursor);
    allWorlds.push(...built.worlds);
    allLinks.push(...built.links);
    if (prevExit) {
      portalLinks.push({
        kind: 'portal',
        from: prevExit, from_x: PORTAL_TILE_PX, from_y: PORTAL_TILE_PX,
        to: built.entryKey, to_x: PORTAL_TILE_PX, to_y: PORTAL_TILE_PX,
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
    hopCursor += built.roomCount;
  });

  const maxHop = Math.max(...allWorlds.map((w) => w.__bandHop));
  for (const w of allWorlds) {
    const dungeon = DUNGEONS.find((d) => w.key.startsWith(`${d.key}_`));
    const hopFraction = maxHop === 0 ? 0 : w.__bandHop / maxHop;
    w.level_band = deriveLevelBand(hopFraction, dungeon.tierClamp);
    w.density = deriveDensity(w.__globalHop / maxHop);
    delete w.__bandHop; delete w.__globalHop;
  }

  const { worlds: surfaceWorlds, links: surfaceLinks } = buildSurfaceWorlds();
  // Graft the surface ladder onto D1's entry room (free N edge -- 'entry'
  // only uses E, to 'pass') so every surface world is reachable from the
  // spec's single is_entry, as validateMapSpec's BFS requires. An ordinary
  // compass link, not an 8th PORTAL: the surface ladder's anchor cell
  // (SURFACE_ANCHOR_X, SURFACE_ANCHOR_Y) is grid-adjacent (N) to D1 entry by
  // construction, and p5_gen_map_content.test.js already pins the portal
  // count at exactly 7 (the 7 inter-dungeon jumps).
  allLinks.push({ from: d1EntryKey, edge: 'N', to: surfaceWorlds[0].key });

  return {
    name: 'p5-descent',
    topology: 'chained-dungeons-plus-surface',
    worlds: [...allWorlds, ...surfaceWorlds],
    links: [...allLinks, ...surfaceLinks, ...portalLinks],
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
