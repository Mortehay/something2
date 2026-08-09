// backend/scripts/dungeon/content.js
//
// Static content tables for P5 (SOMET-251), instantiating the umbrella
// spec's (docs/superpowers/specs/2026-08-06-bestiary-program-design.md)
// 22 underground/abyssal lines into 8 chained dungeons, and its 5 new
// surface lines into 5 standalone surface biomes. See
// docs/superpowers/specs/2026-08-08-p5-map-content-design.md's "The
// 8-dungeon chain" table for the grouping rationale.
//
// tierClamp is [floor, ceiling] in player levels (1-50), the union of every
// depth tier (I:1-12, II:8-24, III:20-36, IV:32-50) a dungeon's lines span
// -- this is the outer bound escalation.js clamps level_band into.
//
// guardCreature names the portal guard standing on this dungeon's entry
// tile, drawn from the dungeon's first-listed line at the Line rung
// ("{Line} Line", matching gen-p4-bestiary.js's "{Line} {Rung}" naming) --
// every one of the 288 P4 creatures follows this exact naming, so this is
// a real, already-seeded creature type name, not a placeholder.
const DUNGEONS = [
  {
    key: 'd1', name: 'The Catacombs', topology: 'spine', tierClamp: [1, 24],
    lines: [{ line: 'Undead', biome: 'Catacombs' }, { line: 'Cave', biome: 'Cavern' }],
    guardCreature: 'Undead Line',
  },
  {
    key: 'd2', name: 'The Underdeep', topology: 'hub', tierClamp: [8, 24],
    lines: [{ line: 'Fungal', biome: 'Fungal Deep' }, { line: 'Gloom', biome: 'Gloomfen' }],
    guardCreature: 'Fungal Line',
  },
  {
    key: 'd3', name: 'The Ossuary Depths', topology: 'loop', tierClamp: [8, 36],
    lines: [{ line: 'Bonelord', biome: 'Ossuary' }, { line: 'Drowned', biome: 'Sunken Cistern' }],
    guardCreature: 'Bonelord Line',
  },
  {
    key: 'd4', name: 'The Emberhive', topology: 'spine', tierClamp: [8, 36],
    lines: [{ line: 'Ember', biome: 'Emberdepths' }, { line: 'Hive', biome: 'Hive Warrens' }],
    guardCreature: 'Ember Line',
  },
  {
    key: 'd5', name: 'The Frozen Vaults', topology: 'hub', tierClamp: [8, 36],
    lines: [
      { line: 'Rime', biome: 'Frostvault' },
      { line: 'Blight', biome: 'Blightworks' },
      { line: 'Construct', biome: 'Deepvault' },
    ],
    guardCreature: 'Rime Line',
  },
  {
    key: 'd6', name: 'The Crystal Foundry', topology: 'loop', tierClamp: [20, 36],
    lines: [{ line: 'Crystal', biome: 'Crystal Hollows' }, { line: 'Stoneborn', biome: 'Sunken Foundry' }],
    guardCreature: 'Crystal Line',
  },
  {
    key: 'd7', name: 'The Umbral Gate', topology: 'spine', tierClamp: [20, 50],
    lines: [
      { line: 'Umbral', biome: 'Umbral Warren' },
      { line: 'Demonic', biome: 'Infernal Gate' },
      { line: 'Plague', biome: 'Pestilent Deep' },
    ],
    guardCreature: 'Umbral Line',
  },
  {
    key: 'd8', name: 'The Abyss', topology: 'hub', tierClamp: [32, 50],
    lines: [
      { line: 'Void', biome: 'Abyssal Rift' }, { line: 'Chaos', biome: 'Shattered Vault' },
      { line: 'Fallen', biome: 'Fallen Sanctum' }, { line: 'Nightmare', biome: 'Dreaming Dark' },
      { line: 'Titan', biome: 'Grave of Titans' }, { line: 'Eldritch', biome: 'The Maw' },
    ],
    guardCreature: 'Void Line',
  },
];

// The 5 new surface lines from the umbrella's surface table, tier I-III.
// Each gets 2 standalone worlds (Task 4) -- shallow content, so
// allowed_creature_types only ever draws Swarm/Skirmisher/Line rungs.
const SURFACE_BIOMES = [
  { line: 'Highland', biome: 'Highlands', element: 'physical' },
  { line: 'Jungle', biome: 'Verdant Jungle', element: 'lightning' },
  { line: 'Storm', biome: 'Storm Coast', element: 'lightning' },
  { line: 'Ruin', biome: 'Sunken Ruins', element: 'ice' },
  { line: 'Volcanic', biome: 'Ashfields', element: 'fire' },
];

module.exports = { DUNGEONS, SURFACE_BIOMES };
