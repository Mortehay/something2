// Starter biomes over the existing catalog. terrain_tiles reference
// tile_types.name and flora/creature_types reference entity_types.name by
// convention, with no FK — the same pattern entity_types.spawn_tiles and
// worlds.allowed_creature_types already use. Values contain no single quotes:
// they are interpolated straight into SQL below (same style as the
// create_tile_types and decoration_types seeds).
//
// NOTE: no world is assigned a biome set here. worlds.biomes defaults to '[]',
// which the generator reads as "band all terrain globally, exactly as before" —
// so every existing world keeps its current terrain and its cached chunks.
const STARTER_BIOMES = [
  {
    name: 'Meadow',
    terrain_tiles: ['grass', 'highgrass', 'earth'],
    flora_types: ['bush', 'rose_bush', 'Tree', 'Stone'],
    creature_types: ['Slime', 'Wolf'],
    palette: ['spring green', 'wildflower yellow', 'warm brown'],
    art_style: 'lush hand-drawn fantasy, soft daylight',
    exclusions: 'no snow, no ice, no dead trees',
    color: '#5aa84f',
  },
  {
    name: 'Deep Forest',
    terrain_tiles: ['leafs', 'highgrass', 'earth'],
    flora_types: ['Tree', 'pine_tree', 'dead_tree', 'bush', 'Stone'],
    creature_types: ['Wolf', 'Bat', 'Skeleton'],
    palette: ['deep green', 'moss', 'bark brown'],
    art_style: 'dense hand-drawn fantasy, dappled shade',
    exclusions: 'no sand, no snow',
    color: '#2f6b3a',
  },
  {
    name: 'Arid Dunes',
    terrain_tiles: ['sand', 'rocks', 'dirt'],
    flora_types: ['dead_tree', 'Stone'],
    creature_types: ['Skeleton', 'Bat'],
    palette: ['ochre', 'gold', 'burnt sienna'],
    art_style: 'sun-bleached hand-drawn fantasy, harsh light',
    exclusions: 'no grass, no snow, no ice, no leaves',
    color: '#c9a227',
  },
  {
    name: 'Frozen Waste',
    terrain_tiles: ['snow', 'ice', 'rocks'],
    flora_types: ['IceRock', 'pine_tree'],
    creature_types: ['Bat', 'Skeleton'],
    palette: ['pale blue', 'white', 'slate grey'],
    art_style: 'cold hand-drawn fantasy, flat overcast light',
    exclusions: 'no grass, no sand, no flowers',
    color: '#8fb8d6',
  },
  {
    name: 'Mire',
    terrain_tiles: ['swamp', 'water', 'earth'],
    flora_types: ['dead_tree', 'bush', 'Stone'],
    creature_types: ['Slime', 'Bat'],
    palette: ['murky olive', 'peat brown', 'sickly green'],
    art_style: 'damp hand-drawn fantasy, low misty light',
    exclusions: 'no snow, no ice, no sand',
    color: '#4d6b41',
  },
];

module.exports = { STARTER_BIOMES };
