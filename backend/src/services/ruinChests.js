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
const { generateRegion, sampleBiomeRegion, worldConfig, hash2, inMonument } = require('./mapService');
const { rollCreatureLevel, scaleCreature } = require('./creatureLevel');
const { buildWorldGenConfig } = require('./worldGenConfig');
const { loadTileTypes } = require('./tileTypes');
const { loadBiomes } = require('./biomes');
const { fetchVillages } = require('./villages');
const { fetchLinks } = require('./mapLinks');
const { isPoiRuin, monumentFront } = require('./structureSites');
const { STRUCTURE_TYPES, MONUMENT_TYPES } = require('../../seeds/data/structureTypes.js');

const T = 100;
const PACK_XOR = 0x7f4a7c15;
// The ruin's corner AND shape (review I2): a different ruin re-rolled onto the
// same corner gets a new chest instead of inheriting one whose pack was placed
// around walls that are no longer there.
const keyOf = (s) => `${s.minRow},${s.minCol},${s.type},${s.width}x${s.height}`;

// Where the chest stands: a ruin's first interior tile; a monument's front
// tile, south of its footprint (SOMET-776) -- the one generation keeps
// reachable.
const chestCellOf = (st) => (st.kind === 'monument' ? monumentFront(st) : { row: st.minRow + 1, col: st.minCol + 1 });

// Walkable cells (on the STAMPED grid) for a pack: the ruin's interior first,
// then the ring within 2 tiles of its footprint; the chest tile itself
// excluded. Ordered by a seeded hash so the same ruin always gets the same
// spots.
function packCells(grid, tileTypes, st, chestCell, seed, cfg = null) {
  const height = grid.length, width = grid[0].length;
  const walkable = (r, c) => {
    if (r < 1 || c < 1 || r >= height - 1 || c >= width - 1) return false;
    const d = tileTypes[grid[r][c]];
    if (d && d.walkable === false) return false;
    // A monument footprint is solid though its terrain is not (SOMET-776).
    return !(cfg && inMonument(cfg, r, c));
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

async function reconcileRuinChests(db, worldId, { world = null, styles = STRUCTURE_TYPES, monuments = MONUMENT_TYPES } = {}) {
  const { rows: [row] } = await db.query('SELECT * FROM worlds WHERE id = $1', [worldId]);
  if (!row) throw new Error(`reconcileRuinChests: no world ${worldId}`);
  const stamps = Array.isArray(row.structures) ? row.structures : [];
  const seed = Number(row.seed || 0);
  const poi = new Map(stamps.filter((s) => isPoiRuin(seed, s, styles, monuments)).map((s) => [keyOf(s), s]));

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
  for (const [, st] of poi) {
    const chestCell = chestCellOf(st);
    const region = sampleBiomeRegion(cfg, chestCell.row, chestCell.col);
    const names = (region ? region.creatureTypes : [...allowed]).filter((n) => allowed.has(n));
    if (names.length === 0) continue;
    const pSeed = (seed ^ PACK_XOR) >>> 0;
    const n = 3 + Math.floor(hash2(pSeed, st.minRow, st.minCol) * 3);
    const cells = packCells(grid, cfgWorld.tileTypes || {}, st, chestCell, pSeed, cfg).slice(0, n);
    if (cells.length === 0) continue;
    if (await addRuinChest(db, row, st, { names, cells })) added++;
  }
  return { added, removed };
}

// One ruin's chest and pack. The chest row is CLAIMED FIRST (the partial
// unique index on (world_id, structure_key) decides a race between two
// reconciles), and guards are inserted only by the winner -- anchored guards
// are spared by every cleanup, so a pack without a chest would be permanent
// (review I1). Returns the chest id, or null when the ruin already has one or
// no allowed creature type exists.
async function addRuinChest(db, row, st, { names, cells }) {
  const { rows: types } = await db.query(
    `SELECT id, name, hp, defense FROM entity_types
      WHERE is_creature = true AND name = ANY($1::text[])
        AND boss_tier IS NULL AND COALESCE(faction, 'hostile') <> 'guard'
      ORDER BY id`, [names]);
  if (types.length === 0 || cells.length === 0) return null;
  const pSeed = (Number(row.seed || 0) ^ PACK_XOR) >>> 0;
  const type = types[Math.floor(hash2(pSeed, st.minCol, st.minRow) * types.length)];
  const chestCell = chestCellOf(st);
  const claim = await db.query(
    `INSERT INTO world_chests (world_id, x, y, kind, guard_entity_type_id, guard_level, guard_creature_ids,
                               state, guard_count, structure_key)
     VALUES ($1,$2,$3,'field',$4,1,'[]'::jsonb,'locked',$5,$6)
     ON CONFLICT (world_id, structure_key) WHERE structure_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [row.id, chestCell.col * T + T / 2, chestCell.row * T + T / 2, type.id, cells.length, keyOf(st)]);
  if (claim.rowCount === 0) return null;
  const chestId = claim.rows[0].id;
  const ids = [];
  let topLevel = 1;
  for (const cell of cells) {
    const level = rollCreatureLevel(hash2(pSeed, cell.row, cell.col), row.level_min, row.level_max);
    topLevel = Math.max(topLevel, level);
    const sc = scaleCreature({ hp: type.hp || 10, defense: Number(type.defense ?? 0) || 0 }, level);
    const x = cell.col * T + T / 2, y = cell.row * T + T / 2;
    const g = await db.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y, level, defense)
       VALUES ($1,$2,$3,$4,$5,'S',$3,$4,$6,$7) RETURNING id`,
      [row.id, type.name, x, y, sc.hp, level, sc.defense]);
    ids.push(g.rows[0].id);
  }
  await db.query('UPDATE world_chests SET guard_creature_ids = $1::jsonb, guard_level = $2 WHERE id = $3',
    [JSON.stringify(ids), topLevel, chestId]);
  return chestId;
}

module.exports = { reconcileRuinChests, addRuinChest, packCells, keyOf, chestCellOf };
