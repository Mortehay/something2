// SOMET-742. Which loading scene a world shows, from its first biome (the array
// is order-sensitive and the first entry is the one the world leads with).
// Scenes are families, not one per biome: frontend/public/loading-scenes/ holds
// one SVG per value here, and a biome added later falls back to the default
// until someone maps it. A family word is all the client learns, so it is safe
// on the row of a world the player has not visited.
const DEFAULT_LOADING_SCENE = 'forest';

const SCENE_BIOMES = {
  forest: ['Deep Forest'],
  meadow: ['Meadow', 'Highlands'],
  jungle: ['Verdant Jungle'],
  swamp: ['Mire', 'Gloomfen', 'Pestilent Deep', 'Blightworks'],
  desert: ['Arid Dunes'],
  snow: ['Frozen Waste', 'Frostvault'],
  volcanic: ['Ashfields', 'Emberdepths', 'Infernal Gate', 'Sunken Foundry'],
  coast: ['Storm Coast', 'Sunken Ruins', 'Sunken Cistern'],
  cavern: ['Cavern', 'Crystal Hollows', 'Fungal Deep', 'Hive Warrens', 'Umbral Warren', 'The Maw', 'Abyssal Rift', 'Dreaming Dark', 'Deepvault'],
  ruins: ['Catacombs', 'Ossuary', 'Fallen Sanctum', 'Grave of Titans', 'Shattered Vault'],
};

const BIOME_TO_SCENE = new Map(Object.entries(SCENE_BIOMES)
  .flatMap(([scene, biomes]) => biomes.map((b) => [b, scene])));

function loadingSceneFor(biomes) {
  const first = Array.isArray(biomes) ? biomes[0] : null;
  return BIOME_TO_SCENE.get(first) || DEFAULT_LOADING_SCENE;
}

module.exports = { loadingSceneFor, DEFAULT_LOADING_SCENE, SCENE_NAMES: Object.keys(SCENE_BIOMES), BIOME_TO_SCENE };
