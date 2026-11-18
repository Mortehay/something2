const { styleEntityPrompt } = require('./spritePrompt.js');

// Real on-screen sizes for the pre-existing decorations (they were seeded 0×0).
const SIZE_FIXES = {
  Tree: { w: 64, h: 96 },
  Stone: { w: 48, h: 48 },
  IceRock: { w: 48, h: 48 },
};

// New decoration types. image/sprite are left null until art is generated.
//
// THE COMMENT HERE USED TO CLAIM these are "skipped (no hole) until then".
// They are not: RenderSystem.drawEntity falls through to fillRect with the
// type's colour, so a decoration seeded render_mode 'static' with no image
// draws a solid coloured square on the map. That is what the flat blocks
// scattered over the world were.
//
// `prompt` is what lets `make entities-generate` draw them. Without one they
// are permanently ungeneratable -- the generator skips a promptless row rather
// than send an empty prompt and get back a plausible picture of nothing. Keep
// these as plain SUBJECTS: the framing ("isolated on a solid white
// background", which the cutout step depends on) is added by
// scripts/generate-entity-textures.js, not stored here.
const NEW_DECORATIONS = [
  { name: 'bush',      is_creature: false, walkable: true,  render_mode: 'static', spawn_tiles: ['grass', 'highgrass'],        chance: 0.30, display_width: 40, display_height: 40, color: '#3a7d34', prompt: styleEntityPrompt('a round leafy green shrub') },
  { name: 'rose_bush', is_creature: false, walkable: true,  render_mode: 'static', spawn_tiles: ['grass', 'highgrass'],        chance: 0.10, display_width: 40, display_height: 44, color: '#a83254', prompt: styleEntityPrompt('a green shrub covered in red roses') },
  { name: 'pine_tree', is_creature: false, walkable: false, render_mode: 'static', spawn_tiles: ['leafs', 'grass', 'snow'],    chance: 0.30, display_width: 64, display_height: 104, color: '#1f5c2e', prompt: styleEntityPrompt('a tall dark green pine tree with a straight trunk') },
  { name: 'dead_tree', is_creature: false, walkable: false, render_mode: 'static', spawn_tiles: ['earth', 'dirt', 'sand'],     chance: 0.15, display_width: 56, display_height: 92, color: '#6b5a45', prompt: styleEntityPrompt('a bare dead tree with broken branches') },
];

// World dressing (SOMET-772): 60 decoration types. Each entry names the
// biomes whose flora list it joins (biomes.js merges these) and its layer:
// 'main' rides the clump pass and may block; 'ground' is flat cover placed by
// its own pass on tiles the main pass left empty, never blocks, draws under
// actors. Prompts are plain SUBJECTS -- framing is added by the generator.
//
// chance is a relative weight inside its layer (see generateChunkDecorations).
const WD = (name, walkable, deco_layer, [display_width, display_height], spawn_tiles, biomes, chance, color, subject) => ({
  name, is_creature: false, walkable, deco_layer, render_mode: 'static',
  spawn_tiles, biomes, chance, display_width, display_height, color,
  prompt: styleEntityPrompt(subject),
});
const M = 'main', G = 'ground';
const FOREST = ['Meadow', 'Deep Forest'];

const WORLD_DRESSING_DECORATIONS = [
  // --- trees (block) ---
  WD('oak_tree_a', false, M, [72, 110], ['grass', 'earth', 'leafs'], FOREST, 0.12, '#3f7a2e', 'a broad oak tree with a thick gnarled trunk and a full round green crown'),
  WD('oak_tree_b', false, M, [72, 110], ['grass', 'earth', 'leafs'], FOREST, 0.12, '#4a7f30', 'an old oak tree with a wide lopsided crown of autumn orange and green leaves'),
  WD('birch_tree_a', false, M, [60, 110], ['grass', 'highgrass', 'leafs'], [...FOREST, 'Highlands'], 0.12, '#8fbf5a', 'a slender white birch tree with black bark marks and light green leaves'),
  WD('birch_tree_b', false, M, [60, 110], ['grass', 'highgrass', 'leafs'], [...FOREST, 'Highlands'], 0.12, '#c9b84a', 'a pair of thin white birch trees with golden yellow leaves'),
  WD('willow_tree', false, M, [80, 110], ['swamp', 'grass'], ['Mire', 'Gloomfen'], 0.12, '#5c7d3a', 'a weeping willow tree with long drooping green branches'),
  WD('palm_tree_a', false, M, [64, 120], ['sand', 'storm_shingle', 'jungle_floor'], ['Storm Coast', 'Verdant Jungle', 'Arid Dunes'], 0.12, '#4f8f3a', 'a tall coconut palm tree with a curved trunk and wide fronds'),
  WD('palm_tree_b', false, M, [64, 110], ['sand', 'storm_shingle', 'jungle_floor'], ['Storm Coast', 'Verdant Jungle', 'Arid Dunes'], 0.12, '#5a9440', 'a short date palm tree with a thick scaly trunk and a bushy crown'),
  WD('jungle_tree_a', false, M, [80, 120], ['jungle_floor', 'highgrass'], ['Verdant Jungle'], 0.12, '#1f6b2e', 'a tall kapok tree with a straight smooth grey trunk and a flat wide green canopy'),
  WD('jungle_tree_b', false, M, [80, 120], ['jungle_floor', 'highgrass'], ['Verdant Jungle'], 0.12, '#2a7a35', 'a dense tropical tree with huge glossy leaves and red flowers'),
  WD('burnt_tree_a', false, M, [56, 96], ['ash_waste', 'ember_rock', 'earth', 'blight_floor'], ['Ashfields', 'Blightworks', 'Deep Forest'], 0.12, '#2b2420', 'a charred black burnt tree trunk with broken scorched branches'),
  WD('burnt_tree_b', false, M, [56, 90], ['ash_waste', 'ember_rock', 'earth', 'blight_floor'], ['Ashfields', 'Blightworks', 'Deep Forest'], 0.12, '#3a2c24', 'a burnt hollow tree with glowing embers inside its cracked trunk'),
  WD('snowy_pine', false, M, [64, 110], ['snow', 'ice'], ['Frozen Waste', 'Highlands'], 0.12, '#dfe9ef', 'a dark pine tree heavily covered in snow'),
  // --- logs / stumps ---
  WD('fallen_log', false, M, [90, 40], ['grass', 'leafs', 'earth', 'swamp'], [...FOREST, 'Mire'], 0.08, '#6b4a2a', 'a long fallen tree log lying on its side with bark and a cut end'),
  WD('mossy_log', false, M, [90, 40], ['leafs', 'swamp', 'jungle_floor'], ['Deep Forest', 'Verdant Jungle', 'Gloomfen'], 0.08, '#4f6b32', 'a rotting fallen log covered in green moss and small mushrooms'),
  WD('tree_stump', true, M, [40, 32], ['grass', 'leafs', 'earth', 'dirt'], [...FOREST, 'Highlands'], 0.08, '#7a5634', 'a short cut tree stump with visible rings and roots'),
  WD('cactus_a', false, M, [44, 80], ['sand', 'dirt'], ['Arid Dunes'], 0.12, '#4f8a3a', 'a tall green saguaro cactus with two raised arms'),
  WD('cactus_b', false, M, [48, 56], ['sand', 'dirt'], ['Arid Dunes'], 0.12, '#5c9440', 'a round barrel cactus cluster with pink flowers on top'),
  // --- bushes (walkable) ---
  WD('berry_bush', true, M, [44, 40], ['grass', 'highgrass'], FOREST, 0.15, '#3b6e2f', 'a round green bush dotted with bright red berries'),
  WD('fern_a', true, M, [40, 36], ['leafs', 'highgrass', 'jungle_floor'], ['Deep Forest', 'Verdant Jungle'], 0.15, '#3f8a3a', 'a lush green fern with long curling fronds'),
  WD('fern_b', true, M, [44, 36], ['leafs', 'highgrass', 'jungle_floor'], ['Deep Forest', 'Verdant Jungle'], 0.15, '#4a7a2e', 'a cluster of young ferns with unfurling fiddleheads'),
  WD('dry_scrub_a', true, M, [40, 32], ['sand', 'dirt', 'earth', 'rocks'], ['Arid Dunes', 'Storm Coast', 'Sunken Ruins'], 0.15, '#9a8a4a', 'a dry leafless desert shrub with thin brown twigs, botanical illustration'),
  WD('dry_scrub_b', true, M, [40, 28], ['sand', 'dirt', 'earth', 'rocks'], ['Arid Dunes', 'Storm Coast', 'Sunken Ruins'], 0.15, '#a8955a', 'a round tumbleweed of dry tangled branches'),
  WD('snow_shrub', true, M, [40, 32], ['snow'], ['Frozen Waste'], 0.15, '#cfdde6', 'a small frozen shrub with frost covered branches'),
  WD('thorn_bush', true, M, [44, 40], ['earth', 'dirt', 'ash_waste', 'blight_floor'], ['Ashfields', 'Blightworks', 'Sunken Ruins'], 0.15, '#5a4a3a', 'a dark thorny bramble bush with sharp spines'),
  WD('jungle_fern', true, M, [48, 44], ['jungle_floor'], ['Verdant Jungle'], 0.15, '#2f7a3a', 'a large tropical plant with broad split leaves'),
  WD('heather', true, M, [40, 28], ['highland_rock', 'grass'], ['Highlands'], 0.15, '#8a5a8a', 'a low clump of purple heather flowers'),
  // --- ground cover (never blocks) ---
  WD('grass_tuft_a', true, G, [32, 24], ['grass', 'highgrass', 'earth'], [...FOREST, 'Highlands', 'Verdant Jungle'], 0.2, '#5aa84f', 'a small tuft of tall green grass blades'),
  WD('grass_tuft_b', true, G, [32, 24], ['grass', 'highgrass', 'earth'], [...FOREST, 'Highlands', 'Verdant Jungle'], 0.2, '#6ab05a', 'a clump of wild grass with a few seed heads'),
  WD('flower_patch_a', true, G, [32, 20], ['grass', 'highgrass'], ['Meadow', 'Highlands'], 0.2, '#e0c040', 'a small bouquet of yellow wildflowers on thin green stems, botanical illustration'),
  WD('flower_patch_b', true, G, [32, 20], ['grass', 'highgrass'], ['Meadow', 'Highlands'], 0.2, '#5a7ae0', 'a small bouquet of blue and white wildflowers on thin green stems, botanical illustration'),
  WD('clover_patch', true, G, [32, 18], ['grass', 'leafs'], FOREST, 0.2, '#4a9a40', 'a sprig of three green clover leaves with two tiny white flowers, botanical illustration'),
  WD('dune_grass', true, G, [32, 28], ['sand', 'storm_shingle'], ['Arid Dunes', 'Storm Coast'], 0.2, '#b8a860', 'a tuft of pale dune grass bending in the wind'),
  WD('frost_grass', true, G, [32, 24], ['snow', 'rime_floor'], ['Frozen Waste', 'Frostvault'], 0.2, '#d8e8f0', 'a tuft of frozen grass coated in white frost'),
  WD('moss_patch', true, G, [32, 16], ['rocks', 'cave_floor', 'ruin_stone', 'leafs', 'cobblestone'], ['Deep Forest', 'Sunken Ruins', 'Cavern', 'Catacombs'], 0.2, '#4a6b32', 'a flat irregular patch of green moss'),
  WD('pebbles', true, G, [28, 14], ['earth', 'dirt', 'rocks', 'highland_rock', 'storm_shingle'], ['Meadow', 'Highlands', 'Storm Coast', 'Arid Dunes', 'Cavern'], 0.2, '#8a8478', 'three smooth round grey pebbles'),
  WD('fallen_leaves', true, G, [32, 14], ['leafs', 'earth'], ['Deep Forest'], 0.2, '#b8702a', 'a small pile of fallen orange and brown leaves'),
  // --- water plants ---
  WD('reeds_a', true, M, [40, 56], ['water', 'swamp', 'cistern_shallows'], ['Mire', 'Storm Coast', 'Sunken Cistern', 'Gloomfen'], 0.15, '#7a8a4a', 'a bundle of tall thin green reeds tied at the base, botanical illustration'),
  WD('reeds_b', true, M, [40, 52], ['water', 'swamp', 'cistern_shallows'], ['Mire', 'Storm Coast', 'Sunken Cistern', 'Gloomfen'], 0.15, '#8a9450', 'a cluster of brown dry reeds with feathery tops'),
  WD('lily_pads', true, G, [40, 16], ['water', 'swamp'], ['Mire', 'Gloomfen'], 0.2, '#3f8a4a', 'a few floating green lily pads with one pink water lily'),
  WD('cattails', true, M, [36, 60], ['swamp'], ['Mire', 'Gloomfen'], 0.15, '#6b5a3a', 'a clump of cattails with brown velvet heads'),
  WD('mangrove_roots', true, M, [64, 48], ['swamp', 'water'], ['Mire'], 0.12, '#5a4a32', 'a tangle of arching mangrove roots rising from mud'),
  // --- rocks ---
  WD('rock_small_a', true, G, [28, 20], ['earth', 'dirt', 'rocks', 'grass', 'highland_rock', 'sand', 'storm_shingle'], ['Meadow', 'Highlands', 'Arid Dunes', 'Storm Coast', 'Sunken Ruins'], 0.2, '#8a8580', 'a small grey stone half buried in the ground'),
  WD('rock_small_b', true, G, [28, 20], ['earth', 'dirt', 'rocks', 'grass', 'highland_rock', 'sand', 'storm_shingle'], ['Meadow', 'Highlands', 'Arid Dunes', 'Storm Coast', 'Sunken Ruins'], 0.2, '#9a9188', 'two small flat brown rocks side by side'),
  WD('boulder_a', false, M, [60, 52], ['rocks', 'highland_rock', 'earth'], ['Highlands', 'Meadow', 'Cavern'], 0.12, '#7a7670', 'a large rounded grey granite boulder'),
  WD('boulder_b', false, M, [64, 56], ['rocks', 'highland_rock', 'earth'], ['Highlands', 'Meadow', 'Cavern'], 0.12, '#6f6a62', 'a cracked angular boulder split into two pieces'),
  WD('mossy_rock', false, M, [52, 44], ['grass', 'leafs', 'jungle_floor', 'ruin_stone'], ['Deep Forest', 'Verdant Jungle', 'Sunken Ruins'], 0.12, '#5a7a4a', 'a grey rock covered in thick green moss'),
  WD('sandstone_rock', false, M, [56, 48], ['sand', 'dirt'], ['Arid Dunes'], 0.12, '#c99a5a', 'a wind carved orange sandstone rock'),
  WD('basalt_rock', false, M, [56, 52], ['ember_rock', 'ash_waste'], ['Ashfields'], 0.12, '#2f2a28', 'a jagged black basalt rock with glowing orange cracks'),
  // --- underground ---
  WD('mushroom_cluster', true, G, [36, 32], ['cave_floor', 'fungal_floor', 'dirt', 'plague_floor', 'blight_floor'], ['Cavern', 'Fungal Deep', 'Blightworks', 'Pestilent Deep'], 0.2, '#b07a5a', 'a bunch of brown cave mushrooms with thick pale stems, botanical illustration'),
  WD('glowcap', true, G, [32, 32], ['fungal_floor', 'umbral_floor'], ['Fungal Deep', 'Umbral Warren'], 0.2, '#5ad0c0', 'a few glowing cyan bioluminescent mushrooms'),
  WD('giant_mushroom', false, M, [60, 90], ['fungal_floor'], ['Fungal Deep'], 0.15, '#8a4a8a', 'a giant purple mushroom with a wide spotted cap'),
  WD('crystal_cluster', false, M, [48, 56], ['crystal_floor', 'ice'], ['Crystal Hollows', 'Frostvault'], 0.15, '#7ab8e0', 'a bunch of tall glowing blue crystal shards growing out of one small rock'),
  WD('stalagmite', false, M, [36, 64], ['cave_floor', 'rocks'], ['Cavern', 'Umbral Warren', 'Hive Warrens'], 0.15, '#6a6058', 'a single tall pointed limestone stalagmite spike'),
  WD('bone_pile', true, G, [40, 24], ['bone_floor', 'crypt_floor', 'titan_floor', 'plague_floor', 'maw_floor'], ['Ossuary', 'Catacombs', 'Grave of Titans', 'Pestilent Deep', 'The Maw'], 0.2, '#d8d0b8', 'a small pile of old bones and a skull'),
  WD('hive_lump', false, M, [52, 48], ['hive_floor'], ['Hive Warrens'], 0.15, '#b08a3a', 'a lumpy amber wax hive mound with small holes'),
  WD('rusted_scrap', true, G, [40, 24], ['vault_floor', 'foundry_floor'], ['Deepvault', 'Sunken Foundry'], 0.2, '#8a5a3a', 'a small pile of rusted iron gears and broken metal plates'),
  WD('broken_pillar', false, M, [44, 80], ['ruin_stone', 'sanctum_floor', 'titan_floor', 'crypt_floor'], ['Sunken Ruins', 'Fallen Sanctum', 'Grave of Titans', 'Catacombs'], 0.15, '#b8b0a0', 'a broken ancient stone column with a cracked top'),
  WD('void_shard', false, M, [40, 72], ['void_floor', 'chaos_floor', 'dream_floor'], ['Abyssal Rift', 'Shattered Vault', 'Dreaming Dark'], 0.15, '#6a3a8a', 'a floating jagged shard of dark violet crystal'),
  WD('brimstone_vent', true, G, [40, 24], ['brimstone', 'ember_rock'], ['Infernal Gate', 'Emberdepths'], 0.2, '#d0a020', 'a small cracked vent in rock leaking yellow sulfur smoke'),
  WD('cistern_weed', true, G, [36, 20], ['cistern_shallows'], ['Sunken Cistern'], 0.2, '#3a6a5a', 'a clump of long dark green water weed leaves, botanical illustration'),
];

// SOMET-779: COVERAGE. The owner found big empty areas: whole biome x
// terrain pairs that no ground cover could land on (Fungal Deep's swamp,
// Hive Warrens' floors, ice, ash, cobblestone...). Each entry widens an
// EXISTING type -- extra terrain it can stand on and extra biomes that list
// it -- so no new art is needed. Ground layer only: it never blocks, so this
// cannot seal anything (new blockers on new terrain did, in SOMET-772).
// A test requires every walkable terrain of every biome to get ground cover.
const COVERAGE = {
  frost_grass: { tiles: ['ice'], biomes: ['Crystal Hollows'] },
  pebbles: { tiles: ['ash_waste', 'ember_rock', 'crystal_floor', 'void_floor', 'umbral_floor'],
    biomes: ['Frozen Waste', 'Ashfields', 'Emberdepths', 'Sunken Foundry', 'Crystal Hollows', 'Abyssal Rift'] },
  grass_tuft_a: { tiles: [], biomes: ['Mire'] },
  fallen_leaves: { tiles: ['jungle_floor'], biomes: ['Verdant Jungle'] },
  moss_patch: { tiles: [], biomes: ['Deepvault', 'Sunken Cistern', 'Fallen Sanctum'] },
  mushroom_cluster: { tiles: ['swamp', 'hive_floor'], biomes: ['Hive Warrens', 'Umbral Warren', 'Gloomfen'] },
  cistern_weed: { tiles: [], biomes: ['Gloomfen'] },
  glowcap: { tiles: ['dream_floor', 'umbral_floor'], biomes: ['Dreaming Dark'] },
  rusted_scrap: { tiles: ['chaos_floor', 'cobblestone'], biomes: ['Shattered Vault'] },
  bone_pile: { tiles: ['sanctum_floor', 'ruin_stone', 'cobblestone', 'void_floor'], biomes: ['Fallen Sanctum'] },
};
for (const d of WORLD_DRESSING_DECORATIONS) {
  const c = COVERAGE[d.name];
  if (!c) continue;
  if (d.deco_layer !== 'ground') throw new Error(`COVERAGE may only widen ground types (${d.name})`);
  d.spawn_tiles = [...new Set([...d.spawn_tiles, ...c.tiles])];
  d.biomes = [...new Set([...d.biomes, ...c.biomes])];
}

// SOMET-776: monument sprites. Entity types so the art pipeline, the client's
// decoTypes map and art-seed treat them like any decoration -- but with NO
// spawn_tiles, so loadDecorationDefs never hands them to the clump pass: they
// are placed only as monuments (seeds/data/structureTypes.js MONUMENT_TYPES).
// Drawn over a 2x2 / 3x3 footprint, so roughly that footprint's iso diamond
// wide (128 px per tile).
const MON = (name, [display_width, display_height], color, subject) => ({
  name, is_creature: false, walkable: false, deco_layer: 'main', render_mode: 'static',
  spawn_tiles: [], chance: 0, display_width, display_height, color,
  prompt: styleEntityPrompt(subject),
});
const MONUMENT_DECORATIONS = [
  MON('collapsed_tower', [360, 420], '#8a8173', 'a large collapsed round stone watchtower, its top fallen away, broken walls and a heap of rubble blocks at its base'),
  MON('broken_statue', [240, 300], '#9c9a92', 'a huge broken stone statue of a robed king on a cracked plinth, its head and one arm missing'),
  MON('wrecked_wagon', [260, 200], '#7a5634', 'a wrecked wooden covered wagon tipped on its side, one wheel broken off, torn canvas cover and spilled crates'),
  MON('toppled_obelisk', [260, 200], '#6f6a7a', 'a fallen carved stone obelisk lying broken in three pieces on the ground, covered in faded runes'),
  MON('giant_skull', [360, 300], '#d8cfb8', 'an enormous ancient monster skull half sunk in the ground, with long cracked horns and empty eye sockets'),
  MON('ruined_windmill', [340, 440], '#8b6f4e', 'a ruined wooden windmill with broken torn sails on a crumbling round stone base'),
  MON('shipwreck_hull', [380, 260], '#6b4a2e', 'the broken wooden hull of a small shipwreck lying on its side, its curved ribs exposed'),
  MON('fallen_giant_tree', [380, 240], '#5a4a2c', 'a huge fallen ancient tree trunk with its tangled roots torn out of the earth, covered in moss'),
  MON('stone_circle', [360, 260], '#8d8a80', 'a small ring of weathered grey standing stones, two of them toppled over'),
  MON('ruined_archway', [260, 300], '#a39a86', 'a lone crumbling stone archway standing on its own, its keystone cracked'),
  MON('abandoned_well', [220, 220], '#7d7a72', 'an old abandoned round stone well with a broken wooden roof and a frayed rope'),
  MON('wrecked_catapult', [380, 320], '#6e5232', 'a wrecked wooden catapult siege engine, its throwing arm snapped and one wheel off'),
  MON('dragon_ribcage', [400, 300], '#e0d6bd', 'the giant bleached ribcage of a long-dead dragon arching out of the ground'),
  MON('sunken_shrine', [240, 260], '#5f6b55', 'a small moss-covered stone shrine half sunk in mud, holding a cracked stone idol'),
  MON('frozen_mammoth', [380, 300], '#a8cfe6', 'a woolly mammoth carcass frozen solid inside a cracked block of blue glacier ice'),
  MON('ice_spire_ruin', [240, 320], '#9fd3ef', 'a cracked jagged spire of blue ice with a broken stone pillar trapped inside it'),
  MON('giant_crystal_cluster', [340, 360], '#9b6fd6', 'a huge cluster of glowing violet crystals bursting out of a split boulder'),
  MON('ruined_forge', [360, 320], '#7a4a32', 'a ruined dwarven stone forge with a cracked anvil and glowing lava cooling in its hearth'),
  MON('demon_gate_fragment', [260, 320], '#4a2a2a', 'a broken black stone gateway arch carved with demon faces and faintly glowing red runes'),
  MON('fallen_bell', [240, 220], '#5f8a6a', 'a huge cracked bronze church bell lying on its side, green with verdigris'),
  MON('overturned_minecart', [240, 200], '#6d6a66', 'an overturned iron mine cart spilling ore beside broken rail tracks and a fallen wooden beam'),
  MON('collapsed_mushroom', [260, 300], '#a0566a', 'a giant rotting mushroom with its huge spotted cap collapsed onto its broken thick stalk'),
  MON('broken_hive_mound', [360, 320], '#b88a3a', 'a broken insect hive mound of hardened amber resin with cracked hollow wax chambers'),
  MON('plague_cart', [260, 220], '#5a5040', 'an abandoned wooden plague cart with a broken wheel, rotting barrels and old sacks'),
  MON('broken_golem', [360, 300], '#7f7a70', 'the shattered stone body of a giant golem lying in heavy broken blocks, moss growing in its cracks'),
  MON('shadow_obelisk', [220, 340], '#2e2840', 'a tall cracked obelisk of black stone wrapped in faint violet smoke'),
  MON('open_sarcophagus', [260, 220], '#8a8578', 'a cracked open stone sarcophagus with its heavy carved lid slid off to one side'),
  MON('bone_throne', [240, 300], '#d6ccb0', 'a ruined empty throne built from bones and skulls, one armrest broken off'),
  MON('colossus_head', [380, 300], '#a29d90', 'the giant fallen stone head of a colossal statue lying on its side, cracked and half buried in the ground'),
  MON('burnt_watchpost', [240, 320], '#3d2f26', 'a burned wooden lookout platform on stilts, its charred beams leaning and partly collapsed'),
  MON('stone_fangs', [380, 300], '#5c4f4a', 'a ring of giant jagged stone fangs jutting from the ground like a buried jaw'),
  MON('broken_pillars', [240, 300], '#c8c2b4', 'three broken marble pillars of different heights standing in a shallow puddle'),
  MON('fallen_cage', [240, 260], '#5b4a3e', 'a large rusted iron hanging cage fallen to the ground, its door torn open'),
];

module.exports = { NEW_DECORATIONS, SIZE_FIXES, WORLD_DRESSING_DECORATIONS, MONUMENT_DECORATIONS };
