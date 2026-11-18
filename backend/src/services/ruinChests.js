// SOMET-774: guarded field chests in point-of-interest ruins.
//
// reconcileRuinChests makes a world's ruin chests match its stored ruins:
// one `world_chests` row per POI ruin (structure_key "<minRow>,<minCol>",
// kind 'field', guard_count N) with an anchored pack of N guards; a chest
// whose ruin is no longer stored (or no longer a POI) is removed together with
// its living guards. Idempotent: a world whose chests already match is not
// touched. Chests with a NULL structure_key (vault, loot map, boss) are never
// looked at.
//
// Guards are ANCHORED (home_x/home_y set) because populateWorld deletes only
// unanchored creatures -- an unanchored pack would be wiped on every re-seed,
// leaving its chest open for free. Their type comes from the world's
// allowlist narrowed by the ruin's biome (the authority's rule: a biome can
// only remove candidates); an empty intersection means the ruin stays scenery.
const { generateRegion, sampleBiomeRegion, worldConfig, hash2 } = require('./mapService');
const { rollCreatureLevel, scaleCreature } = require('./creatureLevel');
const { buildWorldGenConfig } = require('./worldGenConfig');
const { loadTileTypes } = require('./tileTypes');
const { loadBiomes } = require('./biomes');
const { fetchVillages } = require('./villages');
const { fetchLinks } = require('./mapLinks');
const { isPoiRuin } = require('./structureSites');
const { STRUCTURE_TYPES } = require('../../seeds/data/structureTypes.js');

const T = 100;
const PACK_XOR = 0x7f4a7c15;
const keyOf = (s) => `${s.minRow},${s.minCol}`;

// Walkable cells (on the STAMPED grid) for a pack: the ruin's interior first,
// then the ring within 2 tiles of its footprint; the chest tile itself
// excluded. Ordered by a seeded hash so the same ruin always gets the same
// spots.
function packCells(grid, tileTypes, st, chestCell, seed) {
  const height = grid.length, width = grid[0].length;
  const walkable = (r, c) => {
    if (r < 1 || c < 1 || r >= height - 1 || c >= width - 1) return false;
    const d = tileTypes[grid[r][c]];
    return !(d && d.walkable === false);
  };
  const inner = [], outer = [];
  for (let r = st.minRow - 2; r < st.minRow + st.height + 2; r++) {
    for (let c = st.minCol - 2; c < st.minCol + st.width + 2; c++) {
      if (r === chestCell.row && c === chestCell.col) continue;
      if (!walkable(r, c)) continue;
      const interior = r > st.minRow && r < st.minRow + st.height - 1 && c > st.minCol && c < st.minCol + st.width - 1;
      (interior ? inner : outer).push({ row: r, col: c, roll: hash2(seed, r * 4096 + c, 13) });
    }
  }
  const byRoll = (a, b) => a.roll - b.roll;
  return [...inner.sort(byRoll), ...outer.sort(byRoll)];
}

async function reconcileRuinChests(db, worldId, { world = null, styles = STRUCTURE_TYPES } = {}) {
  const { rows: [row] } = await db.query('SELECT * FROM worlds WHERE id = $1', [worldId]);
  if (!row) throw new Error(`reconcileRuinChests: no world ${worldId}`);
  const stamps = Array.isArray(row.structures) ? row.structures : [];
  const seed = Number(row.seed || 0);
  const poi = new Map(stamps.filter((s) => isPoiRuin(seed, s, styles)).map((s) => [keyOf(s), s]));

  const { rows: existing } = await db.query(
    'SELECT id, structure_key, guard_creature_ids FROM world_chests WHERE world_id = $1 AND structure_key IS NOT NULL',
    [worldId]);
  let removed = 0;
  for (const ch of existing) {
    if (poi.has(ch.structure_key)) { poi.delete(ch.structure_key); continue; }
    const ids = Array.isArray(ch.guard_creature_ids) ? ch.guard_creature_ids : [];
    if (ids.length) await db.query('DELETE FROM world_creatures WHERE id = ANY($1::uuid[])', [ids]);
    await db.query('DELETE FROM world_chests WHERE id = $1', [ch.id]);
    removed++;
  }
  if (poi.size === 0) return { added: 0, removed };

  let cfgWorld = world;
  if (!cfgWorld) {
    const [tileTypes, links, villages, biomes] = await Promise.all([
      loadTileTypes(db), fetchLinks(db, worldId), fetchVillages(db, worldId), loadBiomes(db, row.biomes)]);
    const doorways = links.filter((l) => l.edge !== 'PORTAL').map((l) => l.edge);
    cfgWorld = buildWorldGenConfig({ row, tileTypes, doorways, villages, biomes, links });
  }
  cfgWorld = { ...cfgWorld, structures: stamps };
  if (!cfgWorld.width || !cfgWorld.height) return { added: 0, removed };
  const cfg = worldConfig(cfgWorld);
  const grid = generateRegion(cfgWorld, 0, 0, cfgWorld.height, cfgWorld.width);
  const allowed = new Set(Array.isArray(row.allowed_creature_types) ? row.allowed_creature_types : []);

  let added = 0;
  for (const [key, st] of poi) {
    const chestCell = { row: st.minRow + 1, col: st.minCol + 1 };
    const region = sampleBiomeRegion(cfg, chestCell.row, chestCell.col);
    const names = (region ? region.creatureTypes : [...allowed]).filter((n) => allowed.has(n));
    if (names.length === 0) continue;
    const { rows: types } = await db.query(
      'SELECT id, name, hp, defense FROM entity_types WHERE is_creature = true AND name = ANY($1::text[]) ORDER BY id',
      [names]);
    if (types.length === 0) continue;
    const pSeed = (seed ^ PACK_XOR) >>> 0;
    const n = 3 + Math.floor(hash2(pSeed, st.minRow, st.minCol) * 3);
    const cells = packCells(grid, cfgWorld.tileTypes || {}, st, chestCell, pSeed).slice(0, n);
    if (cells.length === 0) continue;
    const type = types[Math.floor(hash2(pSeed, st.minCol, st.minRow) * types.length)];
    const ids = [];
    let topLevel = 1;
    for (const cell of cells) {
      const level = rollCreatureLevel(hash2(pSeed, cell.row, cell.col), row.level_min, row.level_max);
      topLevel = Math.max(topLevel, level);
      const s = scaleCreature({ hp: type.hp || 10, defense: Number(type.defense ?? 0) || 0 }, level);
      const x = cell.col * T + T / 2, y = cell.row * T + T / 2;
      const g = await db.query(
        `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y, level, defense)
         VALUES ($1,$2,$3,$4,$5,'S',$3,$4,$6,$7) RETURNING id`,
        [worldId, type.name, x, y, s.hp, level, s.defense]);
      ids.push(g.rows[0].id);
    }
    await db.query(
      `INSERT INTO world_chests (world_id, x, y, kind, guard_entity_type_id, guard_level, guard_creature_ids,
                                 state, guard_count, structure_key)
       VALUES ($1,$2,$3,'field',$4,$5,$6,'locked',$7,$8)`,
      [worldId, chestCell.col * T + T / 2, chestCell.row * T + T / 2, type.id, topLevel,
        JSON.stringify(ids), ids.length, key]);
    added++;
  }
  return { added, removed };
}

module.exports = { reconcileRuinChests, packCells };
