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
// SOMET: the original five carry their P4 line ALONGSIDE their legacy fauna.
//
// biome_catalog_integrity.test.js records how the 27 P3 biomes were left at
// `creature_types: []` because P4 authored the 288 "{Line} {Rung}" creatures
// into entity_types and never came back to fill this field. The original five
// hit the same gap for the opposite reason: they were already populated with
// the four legacy names, so nothing flagged them, and they were never
// revisited. The result was a ceiling -- Meadow, Deep Forest, Arid Dunes,
// Frozen Waste and Mire admit only Slime/Wolf/Bat/Skeleton BETWEEN THEM, so a
// region built from surface biomes tops out at four creature kinds no matter
// how it is authored.
//
// The line each one gains is not an editorial choice: scripts/bestiary/
// template.js's LINES table already declares every P4 line's home biome, and
// these five are exactly the five it names (Beast/Meadow, Woodland/Deep
// Forest, Desert/Arid Dunes, Tundra/Frozen Waste, Swamp/Mire). This is
// transcribing that mapping, not inventing one. The [Swarm, Skirmisher, Line]
// rung set matches what all 27 other biomes ship.
//
// WHY THIS CANNOT CHANGE A LIVE WORLD: creatureTileCandidates
// (services/mapService.js) intersects a world's allowed_creature_types with
// its biome's list -- "the world's allowlist stays authoritative, a biome can
// only REMOVE candidates from it, never add one". A world allowing only
// ['Slime'] still spawns only Slime. Widening a biome raises the CEILING for
// specs that ask for these creatures; it changes nothing that is already
// seeded.
//
// The legacy names stay. Removing them would rewrite shipped content
// (vale_hub allows ['Slime']) and break the invariant tests that assert the
// four legacy types share one profile.
const STARTER_BIOMES = [
  {
    name: 'Meadow',
    path_tile: 'road_dirt',
    terrain_tiles: ['grass', 'highgrass', 'earth'],
    flora_types: ['bush', 'rose_bush', 'Tree', 'Stone'],
    creature_types: ['Slime', 'Wolf', 'Beast Swarm', 'Beast Skirmisher', 'Beast Line'],
    palette: ['spring green', 'wildflower yellow', 'warm brown'],
    art_style: 'lush hand-drawn fantasy, soft daylight',
    exclusions: 'no snow, no ice, no dead trees',
    color: '#5aa84f',
    creature_density: 0.5,
  },
  {
    name: 'Deep Forest',
    path_tile: 'road_dirt',
    terrain_tiles: ['leafs', 'highgrass', 'earth'],
    flora_types: ['Tree', 'pine_tree', 'dead_tree', 'bush', 'Stone'],
    creature_types: ['Wolf', 'Bat', 'Skeleton', 'Woodland Swarm', 'Woodland Skirmisher', 'Woodland Line'],
    palette: ['deep green', 'moss', 'bark brown'],
    art_style: 'dense hand-drawn fantasy, dappled shade',
    exclusions: 'no sand, no snow',
    color: '#2f6b3a',
    creature_density: 1.0,
  },
  {
    name: 'Arid Dunes',
    path_tile: 'road_sand',
    terrain_tiles: ['sand', 'rocks', 'dirt'],
    flora_types: ['dead_tree', 'Stone'],
    creature_types: ['Skeleton', 'Bat', 'Desert Swarm', 'Desert Skirmisher', 'Desert Line'],
    palette: ['ochre', 'gold', 'burnt sienna'],
    art_style: 'sun-bleached hand-drawn fantasy, harsh light',
    exclusions: 'no grass, no snow, no ice, no leaves',
    color: '#c9a227',
    creature_density: 0.8,
  },
  {
    name: 'Frozen Waste',
    path_tile: 'road_snow',
    terrain_tiles: ['snow', 'ice', 'rocks'],
    flora_types: ['IceRock', 'pine_tree'],
    creature_types: ['Bat', 'Skeleton', 'Tundra Swarm', 'Tundra Skirmisher', 'Tundra Line'],
    palette: ['pale blue', 'white', 'slate grey'],
    art_style: 'cold hand-drawn fantasy, flat overcast light',
    exclusions: 'no grass, no sand, no flowers',
    color: '#8fb8d6',
    creature_density: 1.1,
  },
  {
    name: 'Mire',
    path_tile: 'road_dirt',
    terrain_tiles: ['swamp', 'water', 'earth'],
    flora_types: ['dead_tree', 'bush', 'Stone'],
    creature_types: ['Slime', 'Bat', 'Swamp Swarm', 'Swamp Skirmisher', 'Swamp Line'],
    palette: ['murky olive', 'peat brown', 'sickly green'],
    art_style: 'damp hand-drawn fantasy, low misty light',
    exclusions: 'no snow, no ice, no sand',
    color: '#4d6b41',
    creature_density: 2.0,
  },

  // --- P3 (SOMET-247): underground, abyssal and new surface biomes --------
  //
  // terrain_tiles ORDER IS THE BANDING ORDER (names[floor(v*len)]). Never
  // reorder one to tidy it -- that rewrites the terrain of every world
  // listing the biome.
  //
  // creature_types was [] on every entry through P4 (SOMET-250): the catalog
  // held only Bat, Skeleton, Slime and Wolf, so authoring the intended fauna
  // then would have left these 27 biomes carrying dangling creature
  // references -- a failure this repo has already paid for (see
  // seeds/data/entityTypes.js's header). P4 added the 288 "{Line} {Rung}"
  // creatures to entity_types but never came back to fill this field, which
  // silently zeroed out wild-creature spawns in every P5 world using these
  // biomes (placeMapCreatures intersects a world's allowed_creature_types
  // against its biome's creature_types -- empty biome list, empty
  // intersection, no matter what the world allows). Fixed here per biome's
  // Line, using exactly the ['{Line} Swarm', '{Line} Skirmisher', '{Line}
  // Line'] rung set gen-p5-map-content.js already declares in every P5
  // world's allowed_creature_types -- the minimal set that makes the
  // intersection non-empty (SOMET-251 follow-up, closing the SOMET-247/
  // SOMET-250 gap). The investigation that found this: P4 populated
  // entity_types with the 288 creatures but its task briefing never named
  // this file, so nothing came back to wire the new creatures into the
  // biomes that were supposed to spawn them -- confirmed live before the fix
  // (all 66 P5 worlds seeded with zero wild/hostile creatures, guards only),
  // and confirmed fixed after (creature_types populated per biome's Line,
  // re-seeded, non-zero hostile counts observed in the same 66 worlds).
  //
  // Impassable terrain (cave_wall / rubble / chasm) appears in exactly ten
  // biomes: Deepvault, Umbral Warren and the eight abyssal ones. That is an
  // explicit list, not a tier rule -- a tier rule would sweep in Crystal
  // Hollows and Hive Warrens, which sit at bands 4-6.
  //
  // KNOWN, DELIBERATE, NOT A BUG YET: nine of these biomes render BARREN.
  // Decoration placement only puts a flora object on a tile named in that
  // decoration's OWN entity_types.spawn_tiles, and every decoration we ship
  // spawns on surface terrain only (Stone -> earth/rocks/sand, bush ->
  // grass/highgrass, dead_tree -> earth/dirt/sand, and so on). So a biome whose
  // terrain is entirely new underground tiles declares flora that nothing can
  // ever place:
  //   Ossuary, Fungal Deep, Deepvault, Hive Warrens, Sunken Cistern,
  //   Umbral Warren, Gloomfen, Sunken Foundry, Grave of Titans
  // The flora_types lists above are correct as INTENT and are left alone. The
  // fix is on the decoration side -- extend the relevant decorations'
  // spawn_tiles to include the underground terrain names (or author underground
  // decorations of their own) -- and it is content work for a later
  // sub-project, not something to paper over by editing these lists.

  // Surface
  { name: 'Highlands', path_tile: 'road_stone', terrain_tiles: ['highland_rock', 'rocks', 'grass'], flora_types: ['Stone', 'pine_tree'], creature_types: ['Highland Swarm', 'Highland Skirmisher', 'Highland Line'], palette: ['slate grey', 'moss green', 'pale sky'], art_style: 'windswept highland fantasy, cold clear light', exclusions: 'no sand, no jungle, no lava', color: '#7d8471', creature_density: 0.9 },
  { name: 'Verdant Jungle', path_tile: 'road_dirt', terrain_tiles: ['jungle_floor', 'highgrass', 'leafs'], flora_types: ['Tree', 'bush', 'rose_bush'], creature_types: ['Jungle Swarm', 'Jungle Skirmisher', 'Jungle Line'], palette: ['emerald', 'deep jade', 'wet bark'], art_style: 'lush overgrown jungle fantasy, humid filtered light', exclusions: 'no snow, no ice, no sand', color: '#1f6b2e', creature_density: 1.6 },
  { name: 'Storm Coast', path_tile: 'road_sand', terrain_tiles: ['storm_shingle', 'sand', 'water'], flora_types: ['Stone', 'dead_tree'], creature_types: ['Storm Swarm', 'Storm Skirmisher', 'Storm Line'], palette: ['storm grey', 'sea foam', 'wet slate'], art_style: 'wind-lashed coastal fantasy, overcast squall light', exclusions: 'no lava, no jungle, no snow', color: '#6b7280', creature_density: 0.6 },
  { name: 'Sunken Ruins', path_tile: 'road_stone', terrain_tiles: ['ruin_stone', 'cobblestone', 'earth'], flora_types: ['Stone', 'dead_tree', 'bush'], creature_types: ['Ruin Swarm', 'Ruin Skirmisher', 'Ruin Line'], palette: ['weathered limestone', 'lichen green', 'pale dust'], art_style: 'crumbling overgrown ruins, flat ancient light', exclusions: 'no lava, no snow, no jungle', color: '#8a8577', creature_density: 1.4 },
  { name: 'Ashfields', path_tile: 'road_ash', terrain_tiles: ['ash_waste', 'ember_rock', 'rocks'], flora_types: ['dead_tree', 'Stone'], creature_types: ['Volcanic Swarm', 'Volcanic Skirmisher', 'Volcanic Line'], palette: ['ash grey', 'ember orange', 'charcoal'], art_style: 'volcanic ashfall fantasy, dim red-lit haze', exclusions: 'no grass, no water, no snow', color: '#4a4038', creature_density: 1.7 },

  // Underground
  { name: 'Catacombs', path_tile: 'road_stone', terrain_tiles: ['cobblestone', 'crypt_floor', 'rocks'], flora_types: ['Stone'], creature_types: ['Undead Swarm', 'Undead Skirmisher', 'Undead Line'], palette: ['cold stone grey', 'candle amber', 'deep shadow'], art_style: 'claustrophobic catacomb fantasy, torchlit gloom', exclusions: 'no sky, no grass, no daylight', color: '#55504a', creature_density: 2.3 },
  { name: 'Ossuary', path_tile: 'road_stone', terrain_tiles: ['bone_floor', 'crypt_floor', 'cobblestone'], flora_types: ['Stone'], creature_types: ['Bonelord Swarm', 'Bonelord Skirmisher', 'Bonelord Line'], palette: ['bone ivory', 'dried blood', 'ash grey'], art_style: 'bone-stacked ossuary fantasy, cold dim light', exclusions: 'no grass, no daylight, no water', color: '#c9c2ad', creature_density: 2.4 },
  { name: 'Cavern', path_tile: 'road_dirt', terrain_tiles: ['cave_floor', 'rocks', 'dirt'], flora_types: ['Stone'], creature_types: ['Cave Swarm', 'Cave Skirmisher', 'Cave Line'], palette: ['damp brown', 'wet grey', 'faint blue glow'], art_style: 'natural cave fantasy, damp echoing dark', exclusions: 'no sky, no grass, no built stone', color: '#5a5148', creature_density: 1.9 },
  { name: 'Fungal Deep', path_tile: 'road_dirt', terrain_tiles: ['fungal_floor', 'swamp', 'dirt'], flora_types: ['bush', 'Stone'], creature_types: ['Fungal Swarm', 'Fungal Skirmisher', 'Fungal Line'], palette: ['spore green', 'bruised purple', 'damp umber'], art_style: 'fungal cavern fantasy, bioluminescent murk', exclusions: 'no sky, no fire, no snow', color: '#6b7f3a', creature_density: 2.1 },
  { name: 'Emberdepths', path_tile: 'road_ash', terrain_tiles: ['ember_rock', 'ash_waste', 'rocks'], flora_types: ['Stone'], creature_types: ['Ember Swarm', 'Ember Skirmisher', 'Ember Line'], palette: ['ember orange', 'basalt black', 'smoke'], art_style: 'volcanic underdepth fantasy, glowing molten light', exclusions: 'no water, no ice, no grass', color: '#7a3b22', creature_density: 2.2 },
  { name: 'Frostvault', path_tile: 'road_snow', terrain_tiles: ['rime_floor', 'ice', 'snow'], flora_types: ['IceRock'], creature_types: ['Rime Swarm', 'Rime Skirmisher', 'Rime Line'], palette: ['frost white', 'pale cyan', 'deep blue shadow'], art_style: 'frozen vault fantasy, cold blue underlight', exclusions: 'no fire, no grass, no sand', color: '#a8c6d6', creature_density: 1.8 },
  { name: 'Deepvault', path_tile: 'road_stone', terrain_tiles: ['vault_floor', 'cobblestone', 'rubble'], flora_types: ['Stone'], creature_types: ['Construct Swarm', 'Construct Skirmisher', 'Construct Line'], palette: ['iron grey', 'rust', 'lantern amber'], art_style: 'buried iron vault fantasy, dead still air', exclusions: 'no grass, no sky, no plants', color: '#4f5560', creature_density: 1.8 },
  { name: 'Hive Warrens', path_tile: 'road_dirt', terrain_tiles: ['hive_floor', 'dirt', 'cave_floor'], flora_types: ['Stone'], creature_types: ['Hive Swarm', 'Hive Skirmisher', 'Hive Line'], palette: ['amber wax', 'chitin brown', 'sickly gold'], art_style: 'insect hive fantasy, close humming dark', exclusions: 'no sky, no snow, no built stone', color: '#8a6a2f', creature_density: 2.2 },
  { name: 'Sunken Cistern', path_tile: 'road_stone', terrain_tiles: ['cistern_shallows', 'cobblestone', 'water'], flora_types: ['Stone'], creature_types: ['Drowned Swarm', 'Drowned Skirmisher', 'Drowned Line'], palette: ['stagnant green', 'wet stone', 'dim teal'], art_style: 'flooded cistern fantasy, rippling reflected light', exclusions: 'no fire, no grass, no sand', color: '#3f5a63', creature_density: 1.8 },
  { name: 'Umbral Warren', path_tile: 'road_stone', terrain_tiles: ['umbral_floor', 'cave_floor', 'cave_wall'], flora_types: ['Stone'], creature_types: ['Umbral Swarm', 'Umbral Skirmisher', 'Umbral Line'], palette: ['void violet', 'pitch black', 'faint silver'], art_style: 'lightless umbral warren, near-total dark', exclusions: 'no daylight, no grass, no fire', color: '#2e2a35', creature_density: 2.2 },
  { name: 'Crystal Hollows', path_tile: 'road_snow', terrain_tiles: ['crystal_floor', 'ice', 'rocks'], flora_types: ['IceRock', 'Stone'], creature_types: ['Crystal Swarm', 'Crystal Skirmisher', 'Crystal Line'], palette: ['crystal blue', 'prismatic white', 'deep indigo'], art_style: 'crystal cavern fantasy, refracted glow', exclusions: 'no fire, no grass, no mud', color: '#6fa8c9', creature_density: 1.6 },
  { name: 'Blightworks', path_tile: 'road_ash', terrain_tiles: ['blight_floor', 'fungal_floor', 'dirt'], flora_types: ['dead_tree', 'Stone'], creature_types: ['Blight Swarm', 'Blight Skirmisher', 'Blight Line'], palette: ['sickly ochre', 'rot brown', 'pale green'], art_style: 'blighted underworks fantasy, diseased haze', exclusions: 'no clean water, no snow, no daylight', color: '#5e6b3a', creature_density: 2 },
  { name: 'Gloomfen', path_tile: 'road_dirt', terrain_tiles: ['swamp', 'fungal_floor', 'cistern_shallows'], flora_types: ['dead_tree', 'bush'], creature_types: ['Gloom Swarm', 'Gloom Skirmisher', 'Gloom Line'], palette: ['fen grey', 'drowned green', 'mist white'], art_style: 'subterranean fen fantasy, low drifting mist', exclusions: 'no fire, no sand, no daylight', color: '#4a5a4a', creature_density: 1.9 },
  { name: 'Sunken Foundry', path_tile: 'road_stone', terrain_tiles: ['foundry_floor', 'vault_floor', 'ember_rock'], flora_types: ['Stone'], creature_types: ['Stoneborn Swarm', 'Stoneborn Skirmisher', 'Stoneborn Line'], palette: ['soot black', 'forge orange', 'tarnished bronze'], art_style: 'abandoned deep foundry fantasy, cooling forge light', exclusions: 'no grass, no daylight, no snow', color: '#6a5a48', creature_density: 1.8 },

  // Abyssal
  { name: 'Abyssal Rift', path_tile: 'road_stone', terrain_tiles: ['void_floor', 'umbral_floor', 'chasm'], flora_types: [], creature_types: ['Void Swarm', 'Void Skirmisher', 'Void Line'], palette: ['void black', 'rift violet', 'cold starlight'], art_style: 'abyssal rift fantasy, vertiginous emptiness', exclusions: 'no daylight, no plants, no warmth', color: '#1c1a24', creature_density: 2.4 },
  { name: 'Infernal Gate', path_tile: 'road_ash', terrain_tiles: ['brimstone', 'ember_rock', 'chasm'], flora_types: [], creature_types: ['Demonic Swarm', 'Demonic Skirmisher', 'Demonic Line'], palette: ['hellfire red', 'brimstone yellow', 'charred black'], art_style: 'infernal gateway fantasy, roaring furnace light', exclusions: 'no water, no ice, no plants', color: '#8c3a1e', creature_density: 2.5 },
  { name: 'Shattered Vault', path_tile: 'road_stone', terrain_tiles: ['chaos_floor', 'vault_floor', 'rubble'], flora_types: [], creature_types: ['Chaos Swarm', 'Chaos Skirmisher', 'Chaos Line'], palette: ['fractured violet', 'broken steel', 'arcane sheen'], art_style: 'shattered arcane vault, unstable geometry', exclusions: 'no plants, no daylight, no calm', color: '#6b2f6b', creature_density: 2.3 },
  { name: 'Fallen Sanctum', path_tile: 'road_stone', terrain_tiles: ['sanctum_floor', 'cobblestone', 'rubble'], flora_types: [], creature_types: ['Fallen Swarm', 'Fallen Skirmisher', 'Fallen Line'], palette: ['tarnished gold', 'marble white', 'deep crimson'], art_style: 'defiled holy sanctum, guttering sacred light', exclusions: 'no plants, no daylight, no snow', color: '#b8a97a', creature_density: 2.2 },
  { name: 'Dreaming Dark', path_tile: 'road_stone', terrain_tiles: ['dream_floor', 'umbral_floor', 'chasm'], flora_types: [], creature_types: ['Nightmare Swarm', 'Nightmare Skirmisher', 'Nightmare Line'], palette: ['indigo haze', 'dream silver', 'deep violet'], art_style: 'oneiric dark fantasy, softly impossible space', exclusions: 'no daylight, no hard edges, no fire', color: '#4a3f6b', creature_density: 2.3 },
  { name: 'Grave of Titans', path_tile: 'road_stone', terrain_tiles: ['titan_floor', 'ruin_stone', 'rubble'], flora_types: ['Stone'], creature_types: ['Titan Swarm', 'Titan Skirmisher', 'Titan Line'], palette: ['weathered granite', 'bone grey', 'dust gold'], art_style: 'colossal buried ruin, monumental scale', exclusions: 'no plants, no daylight, no water', color: '#7a7266', creature_density: 2.1 },
  { name: 'Pestilent Deep', path_tile: 'road_ash', terrain_tiles: ['plague_floor', 'blight_floor', 'chasm'], flora_types: [], creature_types: ['Plague Swarm', 'Plague Skirmisher', 'Plague Line'], palette: ['pestilent yellow', 'rot green', 'bile'], art_style: 'plague-choked deep, thick miasmic air', exclusions: 'no clean water, no daylight, no snow', color: '#6b6b33', creature_density: 2.4 },
  { name: 'The Maw', path_tile: 'road_ash', terrain_tiles: ['maw_floor', 'void_floor', 'chasm'], flora_types: [], creature_types: ['Eldritch Swarm', 'Eldritch Skirmisher', 'Eldritch Line'], palette: ['visceral red', 'black bile', 'wet crimson'], art_style: 'living devouring maw, organic horror', exclusions: 'no stone, no daylight, no plants', color: '#3d1f22', creature_density: 2.5 },
];

module.exports = { STARTER_BIOMES };
