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
];

module.exports = { DEFAULT_TILE_TYPES };
