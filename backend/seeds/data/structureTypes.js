// SOMET-773: ruin styles. A biome's ruins look like it -- overgrown in the
// meadow, burned in the forest, sand-worn on the dunes. Generation
// (services/structureSites.js) picks a style by the biome that owns the site,
// then a size, then knocks gaps into the wall ring until `wallKeep` of it
// remains. The RESOLVED stamp is what is stored on the world row, so editing
// this file never moves or reshapes a ruin that already exists -- it only
// changes what future generation produces.
//
// poiChance (SOMET-774): the share of this style's ruins that hold a guarded
// field chest -- decided per ruin from the world seed and its position, so it
// applies to ruins stored before the chest slice too.
//
// No biome may appear in two styles (a test enforces it), and a biome with no
// style gets no ruins: the abyssal and infernal biomes are left out on purpose.
const STRUCTURE_TYPES = [
  { name: 'overgrown_hut', biomes: ['Meadow', 'Verdant Jungle'], wallTile: 'mossy_wall', floorTile: 'rubble_floor', sizes: [[4, 3], [4, 4], [5, 4]], wallKeep: 0.6, weight: 1, poiChance: 0.25 },
  { name: 'burned_cabin', biomes: ['Deep Forest', 'Ashfields', 'Blightworks'], wallTile: 'burnt_wall', floorTile: 'charred_floor', sizes: [[4, 3], [4, 4], [5, 3]], wallKeep: 0.55, weight: 1, poiChance: 0.25 },
  { name: 'broken_watchtower', biomes: ['Highlands', 'Sunken Ruins', 'Grave of Titans'], wallTile: 'ruined_wall', floorTile: 'rubble_floor', sizes: [[3, 3], [4, 4]], wallKeep: 0.7, weight: 1, poiChance: 0.3 },
  { name: 'buried_walls', biomes: ['Arid Dunes', 'Storm Coast'], wallTile: 'weathered_wall', floorTile: 'rubble_floor', sizes: [[4, 3], [5, 4]], wallKeep: 0.5, weight: 1, poiChance: 0.2 },
  { name: 'snowed_hut', biomes: ['Frozen Waste', 'Frostvault'], wallTile: 'ruined_wall', floorTile: 'rubble_floor', sizes: [[4, 3], [4, 4]], wallKeep: 0.6, weight: 1, poiChance: 0.25 },
  { name: 'rotted_stilts', biomes: ['Mire', 'Gloomfen'], wallTile: 'burnt_wall', floorTile: 'rubble_floor', sizes: [[3, 3], [4, 3]], wallKeep: 0.5, weight: 1, poiChance: 0.2 },
  { name: 'collapsed_crypt', biomes: ['Catacombs', 'Ossuary', 'Cavern', 'Fungal Deep', 'Hive Warrens', 'Deepvault', 'Sunken Foundry', 'Fallen Sanctum'], wallTile: 'ruined_wall', floorTile: 'rubble_floor', sizes: [[4, 3], [4, 4], [5, 4]], wallKeep: 0.6, weight: 1, poiChance: 0.3 },
];

// SOMET-776: monuments. One big sprite (an entity type of the same name, see
// decorationTypes.js MONUMENT_DECORATIONS) over a square footprint whose every
// cell blocks. Square only: the model draws no particular orientation, so a
// long footprint could not be made to match its sprite. Placed by the same
// site generator as ruins, after them; a biome MAY appear in several
// monuments (and in a ruin style) -- the weighted pick chooses.
const MONUMENT_TYPES = [
  { name: 'collapsed_tower', sprite: 'collapsed_tower', size: [3, 3], weight: 1, poiChance: 0.35,
    biomes: ['Meadow', 'Highlands', 'Deep Forest', 'Frozen Waste', 'Storm Coast', 'Sunken Ruins'] },
  { name: 'broken_statue', sprite: 'broken_statue', size: [2, 2], weight: 1, poiChance: 0.25,
    biomes: ['Meadow', 'Verdant Jungle', 'Highlands', 'Arid Dunes', 'Sunken Ruins', 'Grave of Titans', 'Fallen Sanctum'] },
  { name: 'wrecked_wagon', sprite: 'wrecked_wagon', size: [2, 2], weight: 1, poiChance: 0.3,
    biomes: ['Meadow', 'Deep Forest', 'Arid Dunes', 'Highlands', 'Ashfields', 'Mire', 'Storm Coast'] },
  { name: 'toppled_obelisk', sprite: 'toppled_obelisk', size: [2, 2], weight: 1, poiChance: 0.2,
    biomes: ['Arid Dunes', 'Ashfields', 'Blightworks', 'Gloomfen', 'Frozen Waste', 'Grave of Titans', 'Catacombs'] },
  { name: 'giant_skull', sprite: 'giant_skull', size: [3, 3], weight: 1, poiChance: 0.35,
    biomes: ['Catacombs', 'Ossuary', 'Cavern', 'Fungal Deep', 'Deepvault', 'Hive Warrens', 'Grave of Titans', 'Sunken Foundry'] },
];

module.exports = { STRUCTURE_TYPES, MONUMENT_TYPES };
