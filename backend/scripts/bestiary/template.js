// backend/scripts/bestiary/template.js
//
// Transcribed verbatim from docs/superpowers/specs/2026-08-06-bestiary-program-design.md
// ("The 32 lines" and the rung table). Do not hand-edit a value here without also updating
// the umbrella doc — this file exists so nothing drifts from it silently.

const RUNGS = [
  { name: 'Swarm', hp: 8, defense: 0, index: 0 },
  { name: 'Skirmisher', hp: 16, defense: 1, index: 1 },
  { name: 'Line', hp: 30, defense: 3, index: 2 },
  { name: 'Ranged', hp: 22, defense: 1, index: 3 },
  { name: 'Caster', hp: 26, defense: 1, index: 4 },
  { name: 'Brute', hp: 48, defense: 5, index: 5 },
  { name: 'Heavy', hp: 60, defense: 8, index: 6 },
  { name: 'Champion', hp: 85, defense: 9, index: 7 },
  { name: 'Apex', hp: 130, defense: 13, index: 8 },
];

const TIER_BANDS = { I: [1, 12], II: [8, 24], III: [20, 36], IV: [32, 50] };

const LINES = [
  // Surface — 10 lines
  { name: 'Beast', biome: 'Meadow', element: null, tier: 'I' },
  { name: 'Woodland', biome: 'Deep Forest', element: null, tier: 'I' },
  { name: 'Desert', biome: 'Arid Dunes', element: 'fire', tier: 'I' },
  { name: 'Tundra', biome: 'Frozen Waste', element: 'ice', tier: 'I-II' },
  { name: 'Swamp', biome: 'Mire', element: 'physical', tier: 'I-II' },
  { name: 'Highland', biome: 'Highlands', element: 'physical', tier: 'II' },
  { name: 'Jungle', biome: 'Verdant Jungle', element: 'lightning', tier: 'II' },
  { name: 'Storm', biome: 'Storm Coast', element: 'lightning', tier: 'II-III' },
  { name: 'Ruin', biome: 'Sunken Ruins', element: 'ice', tier: 'II-III' },
  { name: 'Volcanic', biome: 'Ashfields', element: 'fire', tier: 'II-III' },
  // Underground — 14 lines
  { name: 'Undead', biome: 'Catacombs', element: 'ice', tier: 'I-II' },
  { name: 'Bonelord', biome: 'Ossuary', element: 'ice', tier: 'II-III' },
  { name: 'Cave', biome: 'Cavern', element: 'physical', tier: 'I-II' },
  { name: 'Fungal', biome: 'Fungal Deep', element: 'lightning', tier: 'II' },
  { name: 'Ember', biome: 'Emberdepths', element: 'fire', tier: 'II-III' },
  { name: 'Rime', biome: 'Frostvault', element: 'ice', tier: 'II-III' },
  { name: 'Construct', biome: 'Deepvault', element: 'physical', tier: 'III' },
  { name: 'Hive', biome: 'Hive Warrens', element: 'physical', tier: 'II-III' },
  { name: 'Drowned', biome: 'Sunken Cistern', element: 'ice', tier: 'II-III' },
  { name: 'Umbral', biome: 'Umbral Warren', element: 'physical', tier: 'III-IV' },
  { name: 'Crystal', biome: 'Crystal Hollows', element: 'lightning', tier: 'III' },
  { name: 'Blight', biome: 'Blightworks', element: 'physical', tier: 'II-III' },
  { name: 'Gloom', biome: 'Gloomfen', element: 'ice', tier: 'II' },
  { name: 'Stoneborn', biome: 'Sunken Foundry', element: 'fire', tier: 'III' },
  // Abyssal — 8 lines
  { name: 'Void', biome: 'Abyssal Rift', element: 'physical', tier: 'IV' }, // "all four, partial" — see Task 2
  { name: 'Demonic', biome: 'Infernal Gate', element: 'fire', tier: 'III-IV' },
  { name: 'Chaos', biome: 'Shattered Vault', element: 'lightning', tier: 'IV' },
  { name: 'Fallen', biome: 'Fallen Sanctum', element: 'ice', tier: 'IV' },
  { name: 'Nightmare', biome: 'Dreaming Dark', element: 'physical', tier: 'IV' },
  { name: 'Titan', biome: 'Grave of Titans', element: 'physical', tier: 'IV' },
  { name: 'Plague', biome: 'Pestilent Deep', element: 'fire', tier: 'III-IV' },
  { name: 'Eldritch', biome: 'The Maw', element: 'physical', tier: 'IV' }, // "all four, partial" — see Task 2
];

module.exports = { LINES, RUNGS, TIER_BANDS };
