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

  // --- P3 (SOMET-247): underground, abyssal and new surface biomes --------
  //
  // terrain_tiles ORDER IS THE BANDING ORDER (names[floor(v*len)]). Never
  // reorder one to tidy it -- that rewrites the terrain of every world
  // listing the biome.
  //
  // creature_types is [] on every entry. The catalog holds only Bat,
  // Skeleton, Slime and Wolf, so authoring the intended fauna now would leave
  // 27 biomes carrying dangling creature references -- a failure this repo
  // has already paid for (see seeds/data/entityTypes.js's header). P4 fills
  // them as it authors each creature line.
  //
  // Impassable terrain (cave_wall / rubble / chasm) appears in exactly ten
  // biomes: Deepvault, Umbral Warren and the eight abyssal ones. That is an
  // explicit list, not a tier rule -- a tier rule would sweep in Crystal
  // Hollows and Hive Warrens, which sit at bands 4-6.

  // Surface
  { name: 'Highlands', terrain_tiles: ['highland_rock', 'rocks', 'grass'], flora_types: ['Stone', 'pine_tree'], creature_types: [], palette: ['slate grey', 'moss green', 'pale sky'], art_style: 'windswept highland fantasy, cold clear light', exclusions: 'no sand, no jungle, no lava', color: '#7d8471' },
  { name: 'Verdant Jungle', terrain_tiles: ['jungle_floor', 'highgrass', 'leafs'], flora_types: ['Tree', 'bush', 'rose_bush'], creature_types: [], palette: ['emerald', 'deep jade', 'wet bark'], art_style: 'lush overgrown jungle fantasy, humid filtered light', exclusions: 'no snow, no ice, no sand', color: '#1f6b2e' },
  { name: 'Storm Coast', terrain_tiles: ['storm_shingle', 'sand', 'water'], flora_types: ['Stone', 'dead_tree'], creature_types: [], palette: ['storm grey', 'sea foam', 'wet slate'], art_style: 'wind-lashed coastal fantasy, overcast squall light', exclusions: 'no lava, no jungle, no snow', color: '#6b7280' },
  { name: 'Sunken Ruins', terrain_tiles: ['ruin_stone', 'cobblestone', 'earth'], flora_types: ['Stone', 'dead_tree', 'bush'], creature_types: [], palette: ['weathered limestone', 'lichen green', 'pale dust'], art_style: 'crumbling overgrown ruins, flat ancient light', exclusions: 'no lava, no snow, no jungle', color: '#8a8577' },
  { name: 'Ashfields', terrain_tiles: ['ash_waste', 'ember_rock', 'rocks'], flora_types: ['dead_tree', 'Stone'], creature_types: [], palette: ['ash grey', 'ember orange', 'charcoal'], art_style: 'volcanic ashfall fantasy, dim red-lit haze', exclusions: 'no grass, no water, no snow', color: '#4a4038' },

  // Underground
  { name: 'Catacombs', terrain_tiles: ['cobblestone', 'crypt_floor', 'rocks'], flora_types: ['Stone'], creature_types: [], palette: ['cold stone grey', 'candle amber', 'deep shadow'], art_style: 'claustrophobic catacomb fantasy, torchlit gloom', exclusions: 'no sky, no grass, no daylight', color: '#55504a' },
  { name: 'Ossuary', terrain_tiles: ['bone_floor', 'crypt_floor', 'cobblestone'], flora_types: ['Stone'], creature_types: [], palette: ['bone ivory', 'dried blood', 'ash grey'], art_style: 'bone-stacked ossuary fantasy, cold dim light', exclusions: 'no grass, no daylight, no water', color: '#c9c2ad' },
  { name: 'Cavern', terrain_tiles: ['cave_floor', 'rocks', 'dirt'], flora_types: ['Stone'], creature_types: [], palette: ['damp brown', 'wet grey', 'faint blue glow'], art_style: 'natural cave fantasy, damp echoing dark', exclusions: 'no sky, no grass, no built stone', color: '#5a5148' },
  { name: 'Fungal Deep', terrain_tiles: ['fungal_floor', 'swamp', 'dirt'], flora_types: ['bush', 'Stone'], creature_types: [], palette: ['spore green', 'bruised purple', 'damp umber'], art_style: 'fungal cavern fantasy, bioluminescent murk', exclusions: 'no sky, no fire, no snow', color: '#6b7f3a' },
  { name: 'Emberdepths', terrain_tiles: ['ember_rock', 'ash_waste', 'rocks'], flora_types: ['Stone'], creature_types: [], palette: ['ember orange', 'basalt black', 'smoke'], art_style: 'volcanic underdepth fantasy, glowing molten light', exclusions: 'no water, no ice, no grass', color: '#7a3b22' },
  { name: 'Frostvault', terrain_tiles: ['rime_floor', 'ice', 'snow'], flora_types: ['IceRock'], creature_types: [], palette: ['frost white', 'pale cyan', 'deep blue shadow'], art_style: 'frozen vault fantasy, cold blue underlight', exclusions: 'no fire, no grass, no sand', color: '#a8c6d6' },
  { name: 'Deepvault', terrain_tiles: ['vault_floor', 'cobblestone', 'rubble'], flora_types: ['Stone'], creature_types: [], palette: ['iron grey', 'rust', 'lantern amber'], art_style: 'buried iron vault fantasy, dead still air', exclusions: 'no grass, no sky, no plants', color: '#4f5560' },
  { name: 'Hive Warrens', terrain_tiles: ['hive_floor', 'dirt', 'cave_floor'], flora_types: ['Stone'], creature_types: [], palette: ['amber wax', 'chitin brown', 'sickly gold'], art_style: 'insect hive fantasy, close humming dark', exclusions: 'no sky, no snow, no built stone', color: '#8a6a2f' },
  { name: 'Sunken Cistern', terrain_tiles: ['cistern_shallows', 'cobblestone', 'water'], flora_types: ['Stone'], creature_types: [], palette: ['stagnant green', 'wet stone', 'dim teal'], art_style: 'flooded cistern fantasy, rippling reflected light', exclusions: 'no fire, no grass, no sand', color: '#3f5a63' },
  { name: 'Umbral Warren', terrain_tiles: ['umbral_floor', 'cave_floor', 'cave_wall'], flora_types: ['Stone'], creature_types: [], palette: ['void violet', 'pitch black', 'faint silver'], art_style: 'lightless umbral warren, near-total dark', exclusions: 'no daylight, no grass, no fire', color: '#2e2a35' },
  { name: 'Crystal Hollows', terrain_tiles: ['crystal_floor', 'ice', 'rocks'], flora_types: ['IceRock', 'Stone'], creature_types: [], palette: ['crystal blue', 'prismatic white', 'deep indigo'], art_style: 'crystal cavern fantasy, refracted glow', exclusions: 'no fire, no grass, no mud', color: '#6fa8c9' },
  { name: 'Blightworks', terrain_tiles: ['blight_floor', 'fungal_floor', 'dirt'], flora_types: ['dead_tree', 'Stone'], creature_types: [], palette: ['sickly ochre', 'rot brown', 'pale green'], art_style: 'blighted underworks fantasy, diseased haze', exclusions: 'no clean water, no snow, no daylight', color: '#5e6b3a' },
  { name: 'Gloomfen', terrain_tiles: ['swamp', 'fungal_floor', 'cistern_shallows'], flora_types: ['dead_tree', 'bush'], creature_types: [], palette: ['fen grey', 'drowned green', 'mist white'], art_style: 'subterranean fen fantasy, low drifting mist', exclusions: 'no fire, no sand, no daylight', color: '#4a5a4a' },
  { name: 'Sunken Foundry', terrain_tiles: ['foundry_floor', 'vault_floor', 'ember_rock'], flora_types: ['Stone'], creature_types: [], palette: ['soot black', 'forge orange', 'tarnished bronze'], art_style: 'abandoned deep foundry fantasy, cooling forge light', exclusions: 'no grass, no daylight, no snow', color: '#6a5a48' },

  // Abyssal
  { name: 'Abyssal Rift', terrain_tiles: ['void_floor', 'umbral_floor', 'chasm'], flora_types: [], creature_types: [], palette: ['void black', 'rift violet', 'cold starlight'], art_style: 'abyssal rift fantasy, vertiginous emptiness', exclusions: 'no daylight, no plants, no warmth', color: '#1c1a24' },
  { name: 'Infernal Gate', terrain_tiles: ['brimstone', 'ember_rock', 'chasm'], flora_types: [], creature_types: [], palette: ['hellfire red', 'brimstone yellow', 'charred black'], art_style: 'infernal gateway fantasy, roaring furnace light', exclusions: 'no water, no ice, no plants', color: '#8c3a1e' },
  { name: 'Shattered Vault', terrain_tiles: ['chaos_floor', 'vault_floor', 'rubble'], flora_types: [], creature_types: [], palette: ['fractured violet', 'broken steel', 'arcane sheen'], art_style: 'shattered arcane vault, unstable geometry', exclusions: 'no plants, no daylight, no calm', color: '#6b2f6b' },
  { name: 'Fallen Sanctum', terrain_tiles: ['sanctum_floor', 'cobblestone', 'rubble'], flora_types: [], creature_types: [], palette: ['tarnished gold', 'marble white', 'deep crimson'], art_style: 'defiled holy sanctum, guttering sacred light', exclusions: 'no plants, no daylight, no snow', color: '#b8a97a' },
  { name: 'Dreaming Dark', terrain_tiles: ['dream_floor', 'umbral_floor', 'chasm'], flora_types: [], creature_types: [], palette: ['indigo haze', 'dream silver', 'deep violet'], art_style: 'oneiric dark fantasy, softly impossible space', exclusions: 'no daylight, no hard edges, no fire', color: '#4a3f6b' },
  { name: 'Grave of Titans', terrain_tiles: ['titan_floor', 'ruin_stone', 'rubble'], flora_types: ['Stone'], creature_types: [], palette: ['weathered granite', 'bone grey', 'dust gold'], art_style: 'colossal buried ruin, monumental scale', exclusions: 'no plants, no daylight, no water', color: '#7a7266' },
  { name: 'Pestilent Deep', terrain_tiles: ['plague_floor', 'blight_floor', 'chasm'], flora_types: [], creature_types: [], palette: ['pestilent yellow', 'rot green', 'bile'], art_style: 'plague-choked deep, thick miasmic air', exclusions: 'no clean water, no daylight, no snow', color: '#6b6b33' },
  { name: 'The Maw', terrain_tiles: ['maw_floor', 'void_floor', 'chasm'], flora_types: [], creature_types: [], palette: ['visceral red', 'black bile', 'wet crimson'], art_style: 'living devouring maw, organic horror', exclusions: 'no stone, no daylight, no plants', color: '#3d1f22' },
];

module.exports = { STARTER_BIOMES };
