// Biome scenery catalogue: the new feature / ground-cover entity types, the
// floors the pre-existing decorations gain, and per-biome additions + densities.
// Spec: docs/superpowers/specs/2026-10-22-biome-scenery-density-design.md.
//
// Consumers: migration 1714440825000_biome_scenery.js (one-time additive
// rollout) and scripts/seed-catalogs.js (idempotent re-seed). Both only ADD:
// types are inserted ON CONFLICT DO NOTHING (an empty prompt may be filled),
// flora is appended to, never reordered or removed.
//
// Layers: 'feature' = sparse, larger objects (may block via block_radius, in
// world px, always smaller than a tile). 'cover' = small flat clutter that
// never blocks. Art is generated later through the Art Generation tab, so
// every row carries a prompt and no image.
//
// worldGen.js (byte-parity port of the GPU box generator) is NOT edited; the
// flora it mirrors may drift from this catalogue. See the spec.
const { styleEntityPrompt } = require('./spritePrompt.js');
const { STARTER_BIOMES } = require('./biomes.js');

// Floors per biome group (unwalkable tiles are never listed: water, chasm,
// rubble, cave_wall, map_wall, wooden_wall).
const GROUPS = {
  A: { // Meadow, Highlands
    biomes: ['Meadow', 'Highlands'],
    tiles: ['grass', 'highgrass', 'earth', 'highland_rock', 'rocks'],
  },
  B: { // Deep Forest, Verdant Jungle
    biomes: ['Deep Forest', 'Verdant Jungle'],
    tiles: ['leafs', 'highgrass', 'earth', 'jungle_floor'],
  },
  C: { // Arid Dunes, Storm Coast
    biomes: ['Arid Dunes', 'Storm Coast'],
    tiles: ['sand', 'rocks', 'dirt', 'storm_shingle'],
  },
  D: { // Frozen Waste, Frostvault, Crystal Hollows
    biomes: ['Frozen Waste', 'Frostvault', 'Crystal Hollows'],
    tiles: ['snow', 'ice', 'rocks', 'rime_floor', 'crystal_floor'],
  },
  E: { // Mire, Gloomfen, Fungal Deep, Blightworks
    biomes: ['Mire', 'Gloomfen', 'Fungal Deep', 'Blightworks'],
    tiles: ['swamp', 'earth', 'dirt', 'fungal_floor', 'cistern_shallows', 'blight_floor'],
  },
  F: { // Ashfields, Emberdepths, Infernal Gate, Sunken Foundry
    biomes: ['Ashfields', 'Emberdepths', 'Infernal Gate', 'Sunken Foundry'],
    tiles: ['ash_waste', 'ember_rock', 'rocks', 'brimstone', 'foundry_floor', 'vault_floor'],
  },
  G: { // crypts and ruins
    biomes: ['Catacombs', 'Ossuary', 'Deepvault', 'Fallen Sanctum', 'Grave of Titans', 'Sunken Ruins', 'Sunken Cistern'],
    tiles: ['cobblestone', 'crypt_floor', 'bone_floor', 'vault_floor', 'sanctum_floor', 'titan_floor', 'ruin_stone', 'rocks', 'earth', 'cistern_shallows'],
  },
  H: { // Cavern, Umbral Warren, Hive Warrens
    biomes: ['Cavern', 'Umbral Warren', 'Hive Warrens'],
    tiles: ['cave_floor', 'rocks', 'dirt', 'umbral_floor', 'hive_floor'],
  },
  I: { // Abyssal Rift, Dreaming Dark, The Maw, Pestilent Deep, Shattered Vault
    biomes: ['Abyssal Rift', 'Dreaming Dark', 'The Maw', 'Pestilent Deep', 'Shattered Vault'],
    tiles: ['void_floor', 'umbral_floor', 'dream_floor', 'maw_floor', 'plague_floor', 'blight_floor', 'chaos_floor', 'vault_floor'],
  },
};

// Row: [name, layer F|C, blockRadius (0 = walk-through), w, h, color, subject, groups, tiles?]
// `tiles` narrows the group's floors (union of the groups' floors if omitted).
// block_radius > 0 only on features; a blocking circle stays inside its tile.
const ROWS = [
  // --- A: Meadow, Highlands ---
  ['boulder', 'F', 12, 48, 44, '#8a8d86', 'a large mossy grey boulder', 'A', ['highland_rock', 'rocks', 'grass', 'earth']],
  ['grass_tuft', 'C', 0, 20, 18, '#4f9a3c', 'a small tuft of green grass', 'A', ['grass', 'highgrass']],
  ['wildflowers', 'C', 0, 24, 20, '#d9a441', 'a few small yellow and purple wildflowers', 'A', ['grass', 'highgrass', 'earth']],
  ['pebbles', 'C', 0, 20, 14, '#9a958a', 'a small flat scatter of grey pebbles', 'AC'],
  ['clover', 'C', 0, 20, 16, '#3f8f4a', 'a small patch of clover leaves', 'A', ['grass', 'highgrass']],
  ['dandelions', 'C', 0, 22, 22, '#e6c63a', 'a few small yellow dandelions in grass', 'A', ['grass', 'highgrass']],
  ['tall_grass_clump', 'F', 0, 34, 38, '#5aa84f', 'a tall clump of swaying green grass', 'A', ['grass', 'highgrass', 'earth']],
  ['lavender_patch', 'C', 0, 26, 24, '#8a6fb8', 'a small patch of purple lavender', 'A', ['grass', 'highgrass']],
  ['mole_hill', 'C', 0, 24, 16, '#7a5a3a', 'a small low mound of brown dirt', 'A', ['grass', 'earth']],
  ['berry_bush', 'F', 0, 38, 36, '#3a7d34', 'a green shrub with red berries', 'A', ['grass', 'highgrass']],
  ['daisies', 'C', 0, 22, 20, '#f0f0e6', 'a few small white daisies', 'A', ['grass', 'highgrass']],
  ['buttercups', 'C', 0, 22, 20, '#f2d230', 'a few small yellow buttercups', 'A', ['grass', 'highgrass']],
  ['mushroom_ring', 'C', 0, 30, 20, '#c8b89a', 'a small ring of pale mushrooms', 'A', ['grass', 'highgrass', 'earth']],
  ['fallen_branch', 'C', 0, 30, 14, '#6b4f33', 'a short fallen tree branch', 'A', ['grass', 'highgrass', 'earth', 'highland_rock']],
  ['hay_tuft', 'C', 0, 22, 18, '#d8b960', 'a small bundle of dry yellow hay', 'A', ['grass', 'earth', 'rocks']],

  // --- B: Deep Forest, Verdant Jungle ---
  ['jungle_palm', 'F', 10, 64, 96, '#2f8a3c', 'a tall jungle palm tree with broad fronds', 'B', ['jungle_floor', 'highgrass']],
  ['fern_large', 'F', 0, 40, 40, '#2f7a3a', 'a large spreading green fern', 'B', ['leafs', 'jungle_floor', 'highgrass']],
  ['fern', 'C', 0, 22, 20, '#2f7a3a', 'a small green fern frond', 'B', ['leafs', 'jungle_floor', 'highgrass']],
  ['mushrooms', 'C', 0, 20, 18, '#b88a5a', 'a small cluster of brown forest mushrooms', 'B', ['leafs', 'earth', 'jungle_floor']],
  ['fallen_leaves', 'C', 0, 26, 18, '#9a6a2a', 'a small flat pile of fallen autumn leaves', 'B', ['leafs', 'earth', 'jungle_floor']],
  ['twigs', 'C', 0, 24, 14, '#6b4f33', 'a few small dry twigs', 'B', ['leafs', 'earth', 'highgrass']],
  ['moss_rock', 'C', 0, 24, 18, '#6f8a5a', 'a small moss covered rock', 'B'],
  ['tree_stump', 'F', 0, 36, 32, '#7a5a3a', 'a cut tree stump with visible rings', 'B', ['leafs', 'earth', 'highgrass']],
  ['fallen_log', 'F', 10, 64, 28, '#5e4630', 'a large fallen mossy log', 'B', ['leafs', 'earth', 'jungle_floor']],
  ['vines_patch', 'C', 0, 26, 20, '#2f8a3c', 'a low tangle of green creeping vines', 'B', ['jungle_floor', 'leafs']],
  ['pinecones', 'C', 0, 20, 14, '#7a5a33', 'a few brown pinecones', 'B', ['leafs', 'earth']],
  ['jungle_flowers', 'C', 0, 24, 22, '#d9467a', 'a few bright pink tropical flowers', 'B', ['jungle_floor', 'highgrass']],
  ['bamboo_cluster', 'F', 8, 40, 72, '#7aa84f', 'a tight cluster of tall green bamboo stalks', 'B', ['jungle_floor', 'highgrass']],
  ['bluebells', 'C', 0, 22, 22, '#5a6fd0', 'a few small blue bell flowers', 'B', ['leafs', 'highgrass']],
  ['acorns', 'C', 0, 18, 14, '#8a6a3a', 'a few small acorns', 'B', ['leafs', 'earth']],
  ['exposed_roots', 'C', 0, 30, 16, '#5e4630', 'a short stretch of twisting exposed tree roots', 'B', ['leafs', 'earth', 'jungle_floor']],
  ['orchid_patch', 'C', 0, 24, 22, '#c05aa8', 'a small patch of purple orchids', 'B', ['jungle_floor']],

  // --- C: Arid Dunes, Storm Coast ---
  ['cactus', 'F', 8, 36, 64, '#4f8a4a', 'a tall green saguaro cactus', 'C', ['sand', 'dirt']],
  ['dry_shrub', 'F', 0, 36, 32, '#a8955a', 'a dry brown desert shrub', 'C', ['sand', 'dirt', 'storm_shingle']],
  ['sand_ripple_rock', 'C', 0, 22, 16, '#c2a56a', 'a small sandy rock half buried in sand', 'C', ['sand', 'storm_shingle']],
  ['bleached_bones', 'C', 0, 26, 16, '#e6dcc4', 'a few small sun bleached bones', 'C', ['sand', 'dirt', 'rocks']],
  ['driftwood', 'C', 0, 32, 14, '#8a7a62', 'a piece of pale weathered driftwood', 'C', ['storm_shingle']],
  ['sandstone_rock', 'F', 12, 48, 44, '#c28a54', 'a large layered orange sandstone rock', 'C', ['sand', 'rocks', 'dirt']],
  ['tumbleweed', 'C', 0, 28, 26, '#a8955a', 'a small round dry tumbleweed', 'C', ['sand', 'dirt']],
  ['desert_flower', 'C', 0, 20, 20, '#e0645a', 'a small red desert flower', 'C', ['sand', 'dirt']],
  ['seashells', 'C', 0, 20, 14, '#e8d8c8', 'a few small pale seashells', 'C', ['storm_shingle']],
  ['beach_grass', 'C', 0, 24, 24, '#9aa85a', 'a small tuft of coastal beach grass', 'C', ['storm_shingle']],
  ['desert_succulent', 'C', 0, 22, 20, '#6fa87a', 'a small round desert succulent', 'C', ['sand', 'dirt', 'rocks']],
  ['animal_skull', 'C', 0, 24, 18, '#e6dcc4', 'a small bleached animal skull', 'C', ['sand', 'dirt', 'rocks']],
  ['cracked_earth_patch', 'C', 0, 30, 20, '#9a7a5a', 'a flat patch of dry cracked earth', 'C', ['dirt', 'rocks']],
  ['washed_up_seaweed', 'C', 0, 28, 16, '#4f6a3a', 'a small heap of washed up dark seaweed', 'C', ['storm_shingle']],
  ['crab_shell', 'C', 0, 20, 16, '#d0704a', 'a small empty crab shell', 'C', ['storm_shingle']],

  // --- D: Frozen Waste, Frostvault, Crystal Hollows ---
  ['crystal_cluster', 'F', 10, 44, 56, '#7ac8e6', 'a cluster of tall blue crystals', 'D', ['crystal_floor', 'ice', 'rime_floor']],
  ['snow_tuft', 'C', 0, 22, 16, '#e8f0f6', 'a small tuft of snow covered grass', 'D', ['snow', 'rime_floor']],
  ['ice_shards', 'C', 0, 24, 18, '#b8e0f0', 'a few small sharp ice shards', 'D', ['ice', 'rime_floor', 'crystal_floor', 'snow']],
  ['frost_pebbles', 'C', 0, 20, 14, '#a8b8c6', 'a few small frosted pebbles', 'D', ['snow', 'rocks', 'rime_floor', 'ice']],
  ['small_crystals', 'C', 0, 22, 22, '#8ad0e6', 'a few small blue crystals', 'D', ['crystal_floor', 'ice']],
  ['frozen_shrub', 'F', 0, 36, 32, '#9ab8c6', 'a small shrub frozen in white frost', 'D', ['snow', 'rime_floor', 'rocks']],
  ['icicle_cluster', 'C', 0, 24, 26, '#c6ecf6', 'a small cluster of icicles standing on the ground', 'D', ['ice', 'rime_floor', 'crystal_floor']],
  ['snowdrift', 'F', 0, 40, 24, '#f0f6fa', 'a low smooth drift of white snow', 'D', ['snow', 'rime_floor']],
  ['frozen_bones', 'C', 0, 26, 16, '#d8e6ec', 'a few small bones covered in frost', 'D', ['snow', 'ice', 'rime_floor']],
  ['blue_crystal_shards', 'C', 0, 22, 20, '#5aa0e0', 'a few small deep blue crystal shards', 'D', ['crystal_floor', 'ice']],
  ['mammoth_tusk', 'F', 10, 40, 64, '#e6dcc4', 'a large curved mammoth tusk standing upright in the ground', 'D', ['snow', 'ice', 'rime_floor']],
  ['pine_sapling', 'F', 0, 32, 44, '#2f6a4a', 'a small young pine sapling dusted with snow', 'D', ['snow']],
  ['frozen_puddle', 'C', 0, 28, 16, '#a8d6ec', 'a flat frozen puddle of clear ice', 'D', ['ice', 'snow', 'rime_floor']],
  ['snow_rock', 'C', 0, 24, 18, '#b8c6d0', 'a small rock topped with snow', 'D', ['snow', 'rocks', 'rime_floor']],
  ['frost_flowers', 'C', 0, 22, 20, '#d0ecf6', 'a few small pale blue frost flowers', 'D', ['snow', 'rime_floor']],

  // --- E: Mire, Gloomfen, Fungal Deep, Blightworks ---
  ['giant_mushroom', 'F', 10, 56, 72, '#9a5a8a', 'a giant glowing purple mushroom with a wide cap', 'E', ['fungal_floor', 'swamp', 'blight_floor']],
  ['reeds', 'C', 0, 24, 28, '#7a8a4a', 'a small clump of green marsh reeds', 'E', ['swamp', 'cistern_shallows', 'earth']],
  ['lily_moss', 'C', 0, 24, 16, '#5a7a4a', 'a small flat patch of green moss', 'E', ['swamp', 'cistern_shallows', 'fungal_floor']],
  ['glowcaps', 'C', 0, 20, 20, '#6ad8b0', 'a few small glowing cyan mushroom caps', 'E', ['fungal_floor', 'blight_floor']],
  ['bog_bubbles_rock', 'C', 0, 24, 18, '#6a7a5a', 'a small dark rock beside rising bog bubbles', 'E', ['swamp', 'cistern_shallows', 'blight_floor']],
  ['swamp_log', 'F', 10, 64, 28, '#4a4a32', 'a large rotting log covered in slime and moss', 'E', ['swamp', 'earth', 'cistern_shallows']],
  ['mossy_stump', 'F', 0, 36, 32, '#5a6a3a', 'a rotting tree stump covered in moss', 'E', ['swamp', 'earth', 'fungal_floor']],
  ['cattails', 'C', 0, 22, 30, '#8a6a3a', 'a small clump of brown cattail reeds', 'E', ['swamp', 'cistern_shallows', 'earth']],
  ['toadstools', 'C', 0, 20, 18, '#c0504a', 'a few small red toadstools', 'E', ['fungal_floor', 'swamp', 'dirt', 'blight_floor']],
  ['bog_lily', 'C', 0, 22, 20, '#e0c6d8', 'a single pale bog lily flower', 'E', ['swamp', 'cistern_shallows']],
  ['gnarled_roots', 'C', 0, 28, 16, '#4a3a2a', 'a short stretch of gnarled dark roots', 'E', ['swamp', 'earth', 'dirt']],
  ['lily_pads', 'C', 0, 26, 16, '#4a8a4a', 'a few flat green lily pads', 'E', ['swamp', 'cistern_shallows']],
  ['swamp_skull', 'C', 0, 22, 18, '#c6c0a8', 'a small skull half sunk in mud', 'E', ['swamp', 'earth', 'dirt', 'blight_floor']],
  ['glowing_spores', 'C', 0, 22, 20, '#a8e66a', 'a small cloud of glowing green spores resting on the ground', 'E', ['fungal_floor', 'blight_floor', 'swamp']],
  ['wisp_stone', 'C', 0, 22, 20, '#7ad8c0', 'a small mossy stone with a faint teal glow', 'E', ['swamp', 'cistern_shallows', 'fungal_floor']],

  // --- F: Ashfields, Emberdepths, Infernal Gate, Sunken Foundry ---
  ['charred_stump', 'F', 10, 44, 60, '#2e2a28', 'a blackened charred tree stump', 'F', ['ash_waste', 'ember_rock', 'foundry_floor', 'brimstone']],
  ['ember_rock_spire', 'F', 10, 40, 64, '#8a3a22', 'a tall black rock spire with glowing orange cracks', 'F', ['ember_rock', 'ash_waste', 'brimstone', 'rocks']],
  ['ash_pile', 'C', 0, 26, 16, '#7a7470', 'a small low pile of grey ash', 'F', ['ash_waste', 'foundry_floor', 'rocks']],
  ['ember_pebbles', 'C', 0, 20, 14, '#d86a2a', 'a few small glowing ember pebbles', 'F', ['ember_rock', 'brimstone', 'ash_waste']],
  ['slag_bits', 'C', 0, 22, 14, '#5a4a42', 'a few small dark chunks of slag', 'F', ['foundry_floor', 'vault_floor', 'ember_rock']],
  ['burnt_shrub', 'F', 0, 36, 32, '#3a322e', 'a blackened burnt shrub with bare twigs', 'F', ['ash_waste', 'rocks']],
  ['scorched_bones', 'C', 0, 26, 16, '#a89a88', 'a few small scorched blackened bones', 'F'],
  ['lava_crack', 'C', 0, 30, 14, '#e8601e', 'a small glowing crack in the ground full of lava', 'F', ['ember_rock', 'brimstone']],
  ['obsidian_shard', 'C', 0, 22, 22, '#2a2433', 'a small sharp black obsidian shard', 'F', ['ember_rock', 'brimstone', 'ash_waste', 'rocks']],
  ['sulfur_vent', 'C', 0, 26, 18, '#d8c43a', 'a small yellow sulfur crusted vent', 'F', ['brimstone', 'ember_rock']],
  ['magma_rock', 'F', 12, 48, 44, '#6a2a1e', 'a large dark rock with glowing magma seams', 'F', ['ember_rock', 'brimstone']],
  ['ash_skeleton', 'C', 0, 30, 18, '#b8aea0', 'a small ash covered skeleton lying flat', 'F'],
  ['ember_flowers', 'C', 0, 22, 20, '#f0803a', 'a few small glowing orange ember flowers', 'F', ['ash_waste', 'ember_rock']],
  ['charcoal_chunks', 'C', 0, 22, 14, '#2a2624', 'a few small chunks of black charcoal', 'F'],
  ['cinder_tuft', 'C', 0, 22, 16, '#6a5a52', 'a small tuft of scorched dry grass', 'F', ['ash_waste', 'rocks', 'brimstone']],

  // --- G: Catacombs, Ossuary, Deepvault, Fallen Sanctum, Grave of Titans, Sunken Ruins, Sunken Cistern ---
  ['broken_pillar', 'F', 12, 40, 72, '#9a948a', 'a broken ancient stone pillar', 'G'],
  ['rubble_heap', 'F', 12, 52, 40, '#7a766e', 'a heap of broken stone rubble', 'G'],
  ['bones', 'C', 0, 26, 16, '#e6dcc4', 'a few scattered old bones', 'G'],
  ['skull', 'C', 0, 20, 18, '#e6dcc4', 'a single small human skull', 'G'],
  ['rubble_bits', 'C', 0, 22, 14, '#8a867e', 'a few small chips of broken stone', 'G'],
  ['candle_stub', 'C', 0, 16, 20, '#e8c46a', 'a short melted candle stub with a tiny flame', 'G', ['crypt_floor', 'bone_floor', 'sanctum_floor', 'vault_floor', 'cobblestone']],
  ['cracked_tile', 'C', 0, 26, 18, '#8a867e', 'a flat cracked stone floor tile', 'G', ['cobblestone', 'crypt_floor', 'sanctum_floor', 'vault_floor', 'ruin_stone', 'titan_floor']],
  ['tombstone', 'F', 10, 36, 52, '#8a8a84', 'a weathered stone tombstone', 'G', ['crypt_floor', 'bone_floor', 'earth', 'cobblestone', 'sanctum_floor']],
  ['fallen_statue_head', 'C', 0, 32, 28, '#9a948a', 'a large carved stone statue head lying on its side', 'G', ['ruin_stone', 'titan_floor', 'sanctum_floor', 'cobblestone']],
  ['broken_urn', 'C', 0, 24, 22, '#9a6a4a', 'a small broken clay urn', 'G'],
  ['cobwebs', 'C', 0, 28, 20, '#d8d8d8', 'a flat tangle of grey cobwebs', 'G', ['crypt_floor', 'bone_floor', 'vault_floor', 'cobblestone']],
  ['rusty_chains', 'C', 0, 30, 16, '#8a5a3a', 'a short length of rusty iron chain on the ground', 'G', ['vault_floor', 'crypt_floor', 'cobblestone', 'cistern_shallows']],
  ['coffin_lid', 'F', 10, 56, 28, '#5e4630', 'a heavy wooden coffin lid leaning on the ground', 'G', ['crypt_floor', 'bone_floor', 'sanctum_floor', 'cobblestone']],
  ['bone_pile', 'C', 0, 30, 22, '#e0d6bc', 'a small heap of stacked bones', 'G', ['bone_floor', 'crypt_floor', 'titan_floor', 'cobblestone']],
  ['candle_cluster', 'C', 0, 26, 22, '#e8c46a', 'a small cluster of lit candles of different heights', 'G', ['crypt_floor', 'bone_floor', 'sanctum_floor', 'vault_floor', 'cobblestone']],
  ['scattered_scrolls', 'C', 0, 28, 18, '#d8c89a', 'a few scattered old parchment scrolls', 'G', ['sanctum_floor', 'vault_floor', 'crypt_floor', 'cobblestone']],
  ['offering_bowl', 'C', 0, 24, 18, '#a88a4a', 'a small bronze offering bowl', 'G', ['sanctum_floor', 'crypt_floor', 'titan_floor', 'ruin_stone']],

  // --- H: Cavern, Umbral Warren, Hive Warrens ---
  ['stalagmite', 'F', 10, 40, 64, '#8a8278', 'a tall pointed cave stalagmite', 'H', ['cave_floor', 'umbral_floor', 'hive_floor', 'rocks']],
  ['cave_pebbles', 'C', 0, 20, 14, '#7a7268', 'a few small damp cave pebbles', 'H'],
  ['glowworm_moss', 'C', 0, 24, 16, '#6ad8c0', 'a small patch of moss with glowing blue dots', 'H', ['cave_floor', 'umbral_floor', 'dirt']],
  ['small_stalagmite', 'C', 0, 20, 26, '#8a8278', 'a small pointed stalagmite', 'H', ['cave_floor', 'rocks', 'umbral_floor']],
  ['crystal_vein_rock', 'F', 12, 48, 44, '#6a6478', 'a large dark rock with veins of violet crystal', 'H', ['cave_floor', 'rocks', 'umbral_floor']],
  ['cave_mushrooms', 'C', 0, 22, 20, '#b8a888', 'a small cluster of pale cave mushrooms', 'H', ['cave_floor', 'dirt', 'hive_floor']],
  ['dripping_puddle', 'C', 0, 26, 14, '#5a7a8a', 'a small dark puddle of dripping water', 'H', ['cave_floor', 'dirt', 'umbral_floor']],
  ['hive_resin', 'C', 0, 24, 18, '#d8a83a', 'a small sticky glob of amber hive resin', 'H', ['hive_floor']],
  ['small_loose_rocks', 'C', 0, 24, 16, '#7a7268', 'a few small loose rocks', 'H'],
  ['rock_column', 'F', 10, 40, 72, '#7a7268', 'a thick natural rock column', 'H', ['cave_floor', 'rocks', 'umbral_floor', 'hive_floor']],
  ['cave_bones', 'C', 0, 26, 16, '#d8cfb8', 'a few small old bones', 'H'],
  ['glowing_fungus', 'C', 0, 24, 18, '#7ae0a8', 'a patch of softly glowing green fungus', 'H', ['cave_floor', 'umbral_floor', 'hive_floor']],
  ['drip_stones', 'C', 0, 22, 16, '#8a8278', 'a few small stones beneath a dripping point', 'H', ['cave_floor', 'rocks']],
  ['spider_webs', 'C', 0, 28, 20, '#d8d8e0', 'a flat tangle of thick spider webs', 'H', ['cave_floor', 'umbral_floor', 'hive_floor']],

  // --- I: Abyssal Rift, Dreaming Dark, The Maw, Pestilent Deep, Shattered Vault ---
  ['void_crystal', 'F', 10, 44, 64, '#6a3ab8', 'a tall dark purple void crystal', 'I'],
  ['void_motes_rock', 'C', 0, 22, 18, '#4a3a6a', 'a small dark rock with faint violet motes', 'I', ['void_floor', 'umbral_floor', 'dream_floor', 'maw_floor']],
  ['chaos_shards', 'C', 0, 24, 18, '#a85ae0', 'a few small jagged chaos crystal shards', 'I', ['chaos_floor', 'vault_floor', 'void_floor']],
  ['plague_pustule', 'C', 0, 22, 18, '#a8b83a', 'a small swollen yellow green pustule', 'I', ['plague_floor', 'blight_floor', 'maw_floor']],
  ['dream_wisp_stone', 'C', 0, 22, 20, '#a8a0e6', 'a small pale stone with a faint drifting wisp', 'I', ['dream_floor', 'umbral_floor']],
  ['floating_rune_stone', 'F', 0, 40, 44, '#7a6ad0', 'a small stone slab floating above the ground carved with glowing runes', 'I', ['dream_floor', 'chaos_floor', 'void_floor', 'vault_floor', 'umbral_floor']],
  ['void_tendrils', 'C', 0, 26, 22, '#3a2a5a', 'a few dark writhing void tendrils rising from the ground', 'I', ['void_floor', 'maw_floor', 'umbral_floor', 'dream_floor']],
  ['shattered_glass', 'C', 0, 24, 16, '#b8d0e6', 'a scatter of shattered glass shards', 'I', ['chaos_floor', 'vault_floor', 'dream_floor']],
  ['rotting_spores', 'C', 0, 22, 18, '#8a8a3a', 'a small rotting cluster of yellow spore pods', 'I', ['plague_floor', 'blight_floor', 'maw_floor']],
  ['dream_lilies', 'C', 0, 24, 22, '#c6b8f0', 'a few small pale glowing dream lilies', 'I', ['dream_floor', 'umbral_floor']],
  ['obelisk_fragment', 'F', 12, 40, 72, '#5a4a7a', 'a broken fragment of a dark carved obelisk', 'I', ['chaos_floor', 'vault_floor', 'void_floor', 'dream_floor', 'maw_floor']],
  ['void_pool_rock', 'C', 0, 24, 16, '#2a2040', 'a small rock beside a tiny black pool', 'I', ['void_floor', 'maw_floor', 'umbral_floor']],
  ['star_shards', 'C', 0, 22, 20, '#f0e6a8', 'a few small glittering star shaped shards', 'I', ['dream_floor', 'void_floor', 'umbral_floor']],
  ['eye_stalks', 'C', 0, 22, 26, '#c04a5a', 'a few small fleshy stalks each topped with an eye', 'I', ['maw_floor', 'plague_floor', 'void_floor']],
  ['corrupted_bones', 'C', 0, 26, 16, '#a89ab8', 'a few small twisted corrupted bones', 'I', ['plague_floor', 'blight_floor', 'maw_floor', 'void_floor']],
];

function tilesFor(groupKeys, narrow) {
  const all = [];
  for (const k of groupKeys) for (const t of GROUPS[k].tiles) if (!all.includes(t)) all.push(t);
  return narrow ? narrow.filter((t) => all.includes(t)) : all;
}

const SCENERY_TYPES = ROWS.map(([name, kind, br, w, h, color, subject, groups, narrow]) => {
  const feature = kind === 'F';
  return {
    name,
    scenery_layer: feature ? 'feature' : 'cover',
    walkable: br === 0,
    block_radius: br,
    max_per_tile: feature ? 2 : 4,
    spawn_tiles: tilesFor([...groups], narrow),
    chance: feature ? (br > 0 ? 0.12 : 0.2) : 0.35,
    display_width: w,
    display_height: h,
    color,
    prompt: styleEntityPrompt(subject + (feature ? '' : ', small and flat, low to the ground')),
  };
});

// Existing decorations gain the walkable floors of the biomes that list them,
// closing the "listed but never spawns" gap (Stone on cave_floor, ...).
// Derived once from the pre-rollout biome flora lists; never removes a floor.
const SPAWN_TILE_ADDITIONS = {
  Tree: ['highgrass', 'jungle_floor'],
  Stone: [
    'ash_waste', 'blight_floor', 'bone_floor', 'cave_floor', 'cistern_shallows', 'cobblestone',
    'crypt_floor', 'crystal_floor', 'dirt', 'ember_rock', 'foundry_floor', 'fungal_floor', 'grass',
    'highgrass', 'highland_rock', 'hive_floor', 'ice', 'leafs', 'ruin_stone', 'storm_shingle',
    'swamp', 'titan_floor', 'umbral_floor', 'vault_floor',
  ],
  IceRock: ['crystal_floor', 'rime_floor', 'rocks'],
  bush: [
    'cistern_shallows', 'cobblestone', 'dirt', 'earth', 'fungal_floor', 'jungle_floor', 'leafs',
    'ruin_stone', 'swamp',
  ],
  rose_bush: ['earth', 'jungle_floor', 'leafs'],
  pine_tree: ['earth', 'highgrass', 'highland_rock', 'ice', 'rocks'],
  dead_tree: [
    'ash_waste', 'blight_floor', 'cistern_shallows', 'cobblestone', 'ember_rock', 'fungal_floor',
    'highgrass', 'leafs', 'rocks', 'ruin_stone', 'storm_shingle', 'swamp',
  ],
};

// Collision radius (world px) for the pre-existing blocking decorations.
const EXISTING_BLOCK_RADIUS = { Tree: 12, pine_tree: 10, dead_tree: 10, Stone: 14, IceRock: 14 };

// cover_density: ground cover per tile multiplier. feature_density null keeps
// today's feature look (DECO_FILL). Tuned later against the ratio report.
const GROUP_COVER_DENSITY = { A: 2.0, B: 2.2, C: 1.0, D: 1.2, E: 1.6, F: 1.2, G: 1.2, H: 1.2, I: 0.8 };

const BIOME_GROUP = {};
for (const [k, g] of Object.entries(GROUPS)) for (const b of g.biomes) BIOME_GROUP[b] = k;

// add: this biome's scenery types, in catalogue order -- the group's types
// whose floors meet the biome's terrain. Existing flora stays as listed in
// biomes.js (this is appended after it).
const BIOME_SCENERY = {};
for (const b of STARTER_BIOMES) {
  const group = BIOME_GROUP[b.name];
  if (!group) throw new Error(`sceneryCatalog: biome ${b.name} is in no group`);
  const terrain = new Set(b.terrain_tiles);
  const add = SCENERY_TYPES
    .filter((t, i) => ROWS[i][7].includes(group) && t.spawn_tiles.some((s) => terrain.has(s)))
    .map((t) => t.name);
  BIOME_SCENERY[b.name] = { add, feature_density: b.feature_density ?? null, cover_density: GROUP_COVER_DENSITY[group] };
}

module.exports = { SCENERY_TYPES, SPAWN_TILE_ADDITIONS, BIOME_SCENERY, EXISTING_BLOCK_RADIUS };
