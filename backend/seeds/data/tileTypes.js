// The authoritative tile_types catalog for `make seed-catalogs`.
//
// Unlike biomes and decoration_types, this data could not simply be moved out
// of its migration: it lives as an object literal INSIDE
// 1714440002000_create_tile_types.js's `up`, and two later migrations
// (1714440027000_bounded_worlds, 1714440029000_villages_and_binds) add more
// tiles with raw SQL. Consolidating them here and leaving those migrations
// untouched keeps migration behaviour identical on existing databases while
// giving the seeder one place to read. catalog_seed_data.test.js pins this
// file as a superset of what those migrations insert.
const DEFAULT_TILE_TYPES = [
  // From 1714440002000_create_tile_types.js's defaultTileTypes object.
  { name: 'grass', color: '#00FF00', walkable: true, speed: 1, image: '', valid_neighbors: ['grass', 'highgrass', 'leafs', 'sand', 'earth'] },
  { name: 'highgrass', color: '#035c03ff', walkable: true, speed: 0.8, image: '', valid_neighbors: ['highgrass', 'grass', 'leafs', 'swamp'] },
  { name: 'leafs', color: '#023b02ff', walkable: true, speed: 0.8, image: '', valid_neighbors: ['leafs', 'highgrass', 'grass', 'dirt'] },
  { name: 'sand', color: '#FFFF00', walkable: true, speed: 0.6, image: '', valid_neighbors: ['sand', 'grass', 'earth', 'water'] },
  { name: 'rocks', color: '#808080', walkable: true, speed: 0.8, image: '', valid_neighbors: ['rocks', 'earth', 'snow', 'dirt'] },
  { name: 'earth', color: '#8B4513', walkable: true, speed: 1, image: '', valid_neighbors: ['earth', 'grass', 'sand', 'rocks', 'dirt', 'swamp'] },
  { name: 'dirt', color: '#301604ff', walkable: true, speed: 0.6, image: '', valid_neighbors: ['dirt', 'earth', 'rocks', 'leafs', 'swamp'] },
  { name: 'snow', color: '#FFFFFF', walkable: true, speed: 0.5, image: '', valid_neighbors: ['snow', 'rocks', 'ice'] },
  { name: 'ice', color: '#bae6fd', walkable: true, speed: 0.2, image: '', valid_neighbors: ['ice', 'snow', 'water'] },
  { name: 'swamp', color: '#4d7c0f', walkable: true, speed: 0.1, image: '', valid_neighbors: ['swamp', 'earth', 'dirt', 'water', 'highgrass'] },
  { name: 'water', color: '#3b82f6', walkable: false, speed: 0, image: '', valid_neighbors: ['water', 'sand', 'ice', 'swamp'] },

  // From MAP_TILE_TYPES in 1714440027000_bounded_worlds.js. These tiles are
  // stamped (not WFC-placed), so valid_neighbors is '[]' in that migration —
  // an empty array here is correct and matches it.
  { name: 'map_wall', color: '#2b2b2b', walkable: false, speed: 1.0, image: '', valid_neighbors: [] },
  { name: 'map_doorway', color: '#6b4f2a', walkable: true, speed: 1.0, image: '', valid_neighbors: [] },

  // From VILLAGE_TILE_TYPES in 1714440029000_villages_and_binds.js. Also
  // stamped, not WFC-placed, so valid_neighbors is '[]' there too.
  { name: 'wooden_wall', color: '#6b4a2a', walkable: false, speed: 1.0, image: '', valid_neighbors: [] },
  { name: 'village_gate', color: '#c9a24b', walkable: true, speed: 1.0, image: '', valid_neighbors: [] },

  // --- P3 (SOMET-247): biome signature floors -----------------------------
  //
  // One signature floor per new biome. A tile carries ONE image shared by
  // every biome that lists it (services/biomePrompt.js), so biomes cannot be
  // told apart by reusing `rocks` under a different palette -- distinct
  // identity requires distinct tiles.
  //
  // `color` is not filler: until sprites are generated locally, these colours
  // ARE the game's appearance.
  //
  // No name here matches PATH_NAME_RE (/path|dirt|road|trail|earth|sand/i).
  // The coastal tile is `storm_shingle`, not the obvious `storm_sand`, for
  // exactly that reason -- see tile_catalog_integrity.test.js.

  // Surface
  { name: 'highland_rock', color: '#7d8471', walkable: true, speed: 0.8, image: '', valid_neighbors: ['highland_rock', 'rocks', 'snow', 'grass'], prompt: 'windswept grey-green highland stone' },
  { name: 'jungle_floor', color: '#1f6b2e', walkable: true, speed: 0.7, image: '', valid_neighbors: ['jungle_floor', 'highgrass', 'leafs', 'swamp'], prompt: 'dense jungle undergrowth and vines' },
  { name: 'storm_shingle', color: '#6b7280', walkable: true, speed: 0.6, image: '', valid_neighbors: ['storm_shingle', 'sand', 'water', 'rocks'], prompt: 'dark wet storm-beaten shore shingle' },
  { name: 'ruin_stone', color: '#8a8577', walkable: true, speed: 0.9, image: '', valid_neighbors: ['ruin_stone', 'rocks', 'earth', 'cobblestone'], prompt: 'cracked weathered ruin flagstones' },
  { name: 'ash_waste', color: '#4a4038', walkable: true, speed: 0.7, image: '', valid_neighbors: ['ash_waste', 'ember_rock', 'rocks', 'dirt'], prompt: 'grey volcanic ash drift' },

  // Underground
  { name: 'cobblestone', color: '#6e6a63', walkable: true, speed: 0.9, image: '', valid_neighbors: ['cobblestone', 'crypt_floor', 'ruin_stone', 'rocks'], prompt: 'worn grey cobblestone paving' },
  { name: 'crypt_floor', color: '#55504a', walkable: true, speed: 0.9, image: '', valid_neighbors: ['crypt_floor', 'cobblestone', 'bone_floor', 'rocks'], prompt: 'cold crypt flagstone floor' },
  { name: 'bone_floor', color: '#c9c2ad', walkable: true, speed: 0.8, image: '', valid_neighbors: ['bone_floor', 'crypt_floor', 'cobblestone'], prompt: 'floor of packed bone fragments' },
  { name: 'cave_floor', color: '#5a5148', walkable: true, speed: 0.9, image: '', valid_neighbors: ['cave_floor', 'rocks', 'dirt', 'cave_wall'], prompt: 'damp brown cave floor stone' },
  { name: 'fungal_floor', color: '#6b7f3a', walkable: true, speed: 0.7, image: '', valid_neighbors: ['fungal_floor', 'swamp', 'dirt', 'blight_floor'], prompt: 'spongy fungal mat floor' },
  { name: 'ember_rock', color: '#7a3b22', walkable: true, speed: 0.8, image: '', valid_neighbors: ['ember_rock', 'ash_waste', 'rocks', 'brimstone'], prompt: 'cracked rock veined with glowing embers' },
  { name: 'rime_floor', color: '#a8c6d6', walkable: true, speed: 0.5, image: '', valid_neighbors: ['rime_floor', 'ice', 'snow', 'rocks'], prompt: 'frost-rimed pale stone floor' },
  { name: 'vault_floor', color: '#4f5560', walkable: true, speed: 1.0, image: '', valid_neighbors: ['vault_floor', 'cobblestone', 'foundry_floor', 'rocks'], prompt: 'riveted iron vault plating' },
  { name: 'hive_floor', color: '#8a6a2f', walkable: true, speed: 0.8, image: '', valid_neighbors: ['hive_floor', 'dirt', 'cave_floor'], prompt: 'waxy amber hive comb floor' },
  { name: 'cistern_shallows', color: '#3f5a63', walkable: true, speed: 0.4, image: '', valid_neighbors: ['cistern_shallows', 'water', 'cobblestone', 'swamp'], prompt: 'shallow standing water over stone' },
  { name: 'umbral_floor', color: '#2e2a35', walkable: true, speed: 0.9, image: '', valid_neighbors: ['umbral_floor', 'cave_floor', 'void_floor', 'rocks'], prompt: 'lightless violet-black stone' },
  { name: 'crystal_floor', color: '#6fa8c9', walkable: true, speed: 0.8, image: '', valid_neighbors: ['crystal_floor', 'ice', 'rocks', 'cave_floor'], prompt: 'pale blue crystal shard floor' },
  { name: 'blight_floor', color: '#5e6b3a', walkable: true, speed: 0.7, image: '', valid_neighbors: ['blight_floor', 'fungal_floor', 'swamp', 'dirt'], prompt: 'sickly blighted crusted ground' },
  { name: 'foundry_floor', color: '#6a5a48', walkable: true, speed: 0.9, image: '', valid_neighbors: ['foundry_floor', 'vault_floor', 'ember_rock', 'rocks'], prompt: 'soot-stained foundry stone' },

  // Abyssal
  { name: 'void_floor', color: '#1c1a24', walkable: true, speed: 0.9, image: '', valid_neighbors: ['void_floor', 'umbral_floor', 'chaos_floor'], prompt: 'starless void-black surface' },
  { name: 'brimstone', color: '#8c3a1e', walkable: true, speed: 0.8, image: '', valid_neighbors: ['brimstone', 'ember_rock', 'ash_waste'], prompt: 'sulphurous brimstone crust' },
  { name: 'chaos_floor', color: '#6b2f6b', walkable: true, speed: 0.9, image: '', valid_neighbors: ['chaos_floor', 'void_floor', 'crystal_floor'], prompt: 'shifting iridescent chaos stone' },
  { name: 'sanctum_floor', color: '#b8a97a', walkable: true, speed: 1.0, image: '', valid_neighbors: ['sanctum_floor', 'cobblestone', 'ruin_stone'], prompt: 'gilded fallen sanctum marble' },
  { name: 'dream_floor', color: '#4a3f6b', walkable: true, speed: 0.9, image: '', valid_neighbors: ['dream_floor', 'void_floor', 'umbral_floor'], prompt: 'hazy indigo dreamlike ground' },
  { name: 'titan_floor', color: '#7a7266', walkable: true, speed: 1.0, image: '', valid_neighbors: ['titan_floor', 'ruin_stone', 'rocks'], prompt: 'colossal weathered titan masonry' },
  { name: 'plague_floor', color: '#6b6b33', walkable: true, speed: 0.7, image: '', valid_neighbors: ['plague_floor', 'blight_floor', 'fungal_floor'], prompt: 'festering plague-slick ground' },
  { name: 'maw_floor', color: '#3d1f22', walkable: true, speed: 0.8, image: '', valid_neighbors: ['maw_floor', 'void_floor', 'brimstone'], prompt: 'raw pulsing flesh-like ground' },

  // Impassable. Banded ONLY by the ten deep biomes (see seeds/data/biomes.js).
  // cave_wall carries wall_height 48 to match map_wall/wooden_wall, which is
  // what makes it render with height rather than as a flat block.
  { name: 'cave_wall', color: '#3a352e', walkable: false, speed: 1.0, image: '', valid_neighbors: ['cave_wall', 'cave_floor', 'rocks'], prompt: 'solid rough cave rock wall', wall_height: 48 },
  { name: 'rubble', color: '#57524a', walkable: false, speed: 1.0, image: '', valid_neighbors: ['rubble', 'cave_floor', 'cobblestone', 'rocks'], prompt: 'impassable heap of collapsed rubble' },
  { name: 'chasm', color: '#14121a', walkable: false, speed: 0, image: '', valid_neighbors: ['chasm', 'cave_floor', 'void_floor'], prompt: 'a black bottomless chasm' },
];

module.exports = { DEFAULT_TILE_TYPES };
