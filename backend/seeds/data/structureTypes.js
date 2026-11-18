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
  // SOMET-776 variants (owner, 2026-11-18): every biome gets several monuments.
  { name: 'ruined_windmill', sprite: 'ruined_windmill', size: [3, 3], weight: 1, poiChance: 0.3,
    biomes: ['Meadow', 'Highlands', 'Storm Coast'] },
  { name: 'shipwreck_hull', sprite: 'shipwreck_hull', size: [3, 3], weight: 1, poiChance: 0.35,
    biomes: ['Storm Coast', 'Sunken Ruins', 'Mire', 'Sunken Cistern'] },
  { name: 'fallen_giant_tree', sprite: 'fallen_giant_tree', size: [3, 3], weight: 1, poiChance: 0.25,
    biomes: ['Deep Forest', 'Verdant Jungle', 'Gloomfen', 'Mire'] },
  { name: 'stone_circle', sprite: 'stone_circle', size: [3, 3], weight: 1, poiChance: 0.3,
    biomes: ['Meadow', 'Highlands', 'Frozen Waste', 'Deep Forest', 'Frostvault'] },
  { name: 'ruined_archway', sprite: 'ruined_archway', size: [2, 2], weight: 1, poiChance: 0.2,
    biomes: ['Arid Dunes', 'Sunken Ruins', 'Fallen Sanctum', 'Highlands', 'Shattered Vault'] },
  { name: 'abandoned_well', sprite: 'abandoned_well', size: [2, 2], weight: 1, poiChance: 0.3,
    biomes: ['Meadow', 'Deep Forest', 'Arid Dunes', 'Highlands'] },
  { name: 'wrecked_catapult', sprite: 'wrecked_catapult', size: [3, 3], weight: 1, poiChance: 0.3,
    biomes: ['Ashfields', 'Highlands', 'Grave of Titans', 'Blightworks'] },
  { name: 'dragon_ribcage', sprite: 'dragon_ribcage', size: [3, 3], weight: 1, poiChance: 0.35,
    biomes: ['Arid Dunes', 'Ashfields', 'Grave of Titans', 'The Maw', 'Ossuary', 'Emberdepths'] },
  { name: 'sunken_shrine', sprite: 'sunken_shrine', size: [2, 2], weight: 1, poiChance: 0.3,
    biomes: ['Mire', 'Gloomfen', 'Verdant Jungle', 'Sunken Cistern', 'Pestilent Deep'] },
  { name: 'frozen_mammoth', sprite: 'frozen_mammoth', size: [3, 3], weight: 1, poiChance: 0.3,
    biomes: ['Frozen Waste', 'Frostvault'] },
  { name: 'ice_spire_ruin', sprite: 'ice_spire_ruin', size: [2, 2], weight: 1, poiChance: 0.2,
    biomes: ['Frostvault', 'Frozen Waste', 'Crystal Hollows'] },
  { name: 'giant_crystal_cluster', sprite: 'giant_crystal_cluster', size: [3, 3], weight: 1, poiChance: 0.3,
    biomes: ['Crystal Hollows', 'Shattered Vault', 'Deepvault', 'Dreaming Dark', 'Cavern'] },
  { name: 'ruined_forge', sprite: 'ruined_forge', size: [3, 3], weight: 1, poiChance: 0.35,
    biomes: ['Emberdepths', 'Infernal Gate', 'Sunken Foundry', 'Ashfields'] },
  { name: 'demon_gate_fragment', sprite: 'demon_gate_fragment', size: [2, 2], weight: 1, poiChance: 0.3,
    biomes: ['Infernal Gate', 'Abyssal Rift', 'The Maw', 'Emberdepths'] },
  { name: 'fallen_bell', sprite: 'fallen_bell', size: [2, 2], weight: 1, poiChance: 0.25,
    biomes: ['Sunken Cistern', 'Sunken Ruins', 'Storm Coast', 'Catacombs'] },
  { name: 'overturned_minecart', sprite: 'overturned_minecart', size: [2, 2], weight: 1, poiChance: 0.3,
    biomes: ['Cavern', 'Deepvault', 'Sunken Foundry', 'Hive Warrens', 'Fungal Deep', 'Crystal Hollows', 'Emberdepths'] },
  { name: 'collapsed_mushroom', sprite: 'collapsed_mushroom', size: [2, 2], weight: 1, poiChance: 0.2,
    biomes: ['Fungal Deep', 'Gloomfen', 'Pestilent Deep', 'Dreaming Dark', 'Cavern', 'Umbral Warren'] },
  { name: 'broken_hive_mound', sprite: 'broken_hive_mound', size: [3, 3], weight: 1, poiChance: 0.35,
    biomes: ['Hive Warrens', 'Pestilent Deep', 'Blightworks'] },
  { name: 'plague_cart', sprite: 'plague_cart', size: [2, 2], weight: 1, poiChance: 0.3,
    biomes: ['Pestilent Deep', 'Blightworks', 'Gloomfen', 'Mire', 'Fungal Deep'] },
  { name: 'broken_golem', sprite: 'broken_golem', size: [3, 3], weight: 1, poiChance: 0.35,
    biomes: ['Shattered Vault', 'Sunken Foundry', 'Deepvault', 'Fallen Sanctum', 'Cavern', 'Frostvault'] },
  { name: 'shadow_obelisk', sprite: 'shadow_obelisk', size: [2, 2], weight: 1, poiChance: 0.25,
    biomes: ['Umbral Warren', 'Dreaming Dark', 'Abyssal Rift', 'Catacombs', 'Crystal Hollows'] },
  { name: 'open_sarcophagus', sprite: 'open_sarcophagus', size: [2, 2], weight: 1, poiChance: 0.35,
    biomes: ['Catacombs', 'Ossuary', 'Grave of Titans', 'Umbral Warren'] },
  { name: 'bone_throne', sprite: 'bone_throne', size: [2, 2], weight: 1, poiChance: 0.35,
    biomes: ['Ossuary', 'The Maw', 'Infernal Gate', 'Abyssal Rift', 'Emberdepths'] },
  { name: 'colossus_head', sprite: 'colossus_head', size: [3, 3], weight: 1, poiChance: 0.35,
    biomes: ['Grave of Titans', 'Arid Dunes', 'Fallen Sanctum', 'Sunken Ruins', 'Shattered Vault'] },
  { name: 'burnt_watchpost', sprite: 'burnt_watchpost', size: [2, 2], weight: 1, poiChance: 0.25,
    biomes: ['Ashfields', 'Deep Forest', 'Highlands', 'Frozen Waste'] },
  { name: 'stone_fangs', sprite: 'stone_fangs', size: [3, 3], weight: 1, poiChance: 0.3,
    biomes: ['The Maw', 'Abyssal Rift', 'Dreaming Dark'] },
  { name: 'broken_pillars', sprite: 'broken_pillars', size: [2, 2], weight: 1, poiChance: 0.25,
    biomes: ['Sunken Cistern', 'Sunken Ruins', 'Deepvault', 'Fallen Sanctum', 'Crystal Hollows', 'Shattered Vault', 'Frostvault'] },
  { name: 'fallen_cage', sprite: 'fallen_cage', size: [2, 2], weight: 1, poiChance: 0.3,
    biomes: ['Umbral Warren', 'Catacombs', 'Infernal Gate', 'Hive Warrens', 'Cavern'] },
];

module.exports = { STRUCTURE_TYPES, MONUMENT_TYPES };
