// The authoritative tile_types catalog for `make seed-catalogs`.
//
// Unlike biomes and decoration_types, this data could not simply be moved out
// of its migration: it lives as an object literal INSIDE
// 1714440002000_create_tile_types.js's `up`, and two later migrations
// (1714440027000_bounded_worlds, 1714440029000_villages_and_binds) add more
// tiles with raw SQL. Consolidating them here and leaving those migrations
// untouched keeps migration behaviour identical on existing databases while
// giving the seeder one place to read. catalog_seed_data.test.js pins this
// file as a superset of what those migrations insert.

// --- Generation prompts --------------------------------------------------
//
// A tile's prompt is its SUBJECT plus a styling suffix, and the suffix is not
// decoration: it is what decides whether the result is renderable at all.
//
// Two suffixes, because the renderer treats tiles two ways:
//
//   floor() -- systems/tileTexture.js clips to the iso diamond and stretches
//              the whole square image into it, so the generator must return a
//              flat overhead close-up with no horizon and no perspective.
//   wall()  -- systems/wallRenderer.js skews the SAME image onto the left
//              face, the right face AND the top diamond. An overhead shot
//              cannot serve all three, so these ask for a straight-on
//              material with no baked-in lighting direction.
//
// The wording is deliberate and was measured against a real SDXL provider,
// not guessed. Words that sound right are the ones that break it: "tile",
// "seamless" and "repeating pattern" produce stripes or asset sheets, and
// "isometric" makes the model draw an entire village scene. Describe the
// material and the camera angle instead. sprite-gen's build_tile_prompt uses
// the opposite vocabulary because local sd-turbo responds to it differently;
// the two are not interchangeable.
//
// Negatives live in the provider's request_template -- `negative_prompt` is a
// separate API field and cannot travel inside this string. See
// docs/ai-providers.md.
const FLOOR_STYLE = 'seen from directly above, extreme close-up, '
  + 'fills the entire frame, even soft daylight, pixel art';
const WALL_STYLE = 'flat material surface, straight-on view, '
  + 'fills the entire frame, even flat lighting, no shadows, pixel art';

// The sweep that validated these found a second trap beyond the structural
// nouns above: ABSTRACT subjects fail too. "starless void-black surface" drew
// white blocks, "a black bottomless chasm" drew a pale smear, and "spongy
// fungal mat floor" drew bordered UI panels -- at close range the model needs
// a physical material to render, and the word `floor` pulls it toward
// dungeon-tileset panels with frames. Name what the ground is MADE OF.
//
// A NOTE ON SUBJECT WORDING, learned the expensive way: name the MATERIAL,
// never the structure it forms. "packed tan dirt road, worn wheel ruts"
// generated an aerial street grid and "clear blue rippling water" generated
// venetian blinds -- at an overhead close-up the model reads `road`, `track`,
// `ruts` and `rippling` as linear infrastructure and draws it. The road_*
// tiles are named for their ROLE but must be described as ground.
const floor = (subject) => `${subject}, ${FLOOR_STYLE}`;
const wall = (subject) => `${subject}, ${WALL_STYLE}`;

const DEFAULT_TILE_TYPES = [
  // From 1714440002000_create_tile_types.js's defaultTileTypes object.
  { name: 'grass', color: '#00FF00', walkable: true, speed: 1, image: '', valid_neighbors: ['grass', 'highgrass', 'leafs', 'sand', 'earth'], prompt: floor('lush green meadow grass') },
  { name: 'highgrass', color: '#035c03ff', walkable: true, speed: 0.8, image: '', valid_neighbors: ['highgrass', 'grass', 'leafs', 'swamp'], prompt: floor('tall dense green grass blades') },
  { name: 'leafs', color: '#023b02ff', walkable: true, speed: 0.8, image: '', valid_neighbors: ['leafs', 'highgrass', 'grass', 'dirt'], prompt: floor('dark green forest leaf litter') },
  { name: 'sand', color: '#FFFF00', walkable: true, speed: 0.6, image: '', valid_neighbors: ['sand', 'grass', 'earth', 'water'], prompt: floor('fine golden beach sand') },
  { name: 'rocks', color: '#808080', walkable: true, speed: 0.8, image: '', valid_neighbors: ['rocks', 'earth', 'snow', 'dirt'], prompt: floor('grey rocky stone ground') },
  { name: 'earth', color: '#8B4513', walkable: true, speed: 1, image: '', valid_neighbors: ['earth', 'grass', 'sand', 'rocks', 'dirt', 'swamp'], prompt: floor('bare brown soil with small clumps and pebbles') },
  { name: 'dirt', color: '#301604ff', walkable: true, speed: 0.6, image: '', valid_neighbors: ['dirt', 'earth', 'rocks', 'leafs', 'swamp'], prompt: floor('dark packed dirt ground') },
  { name: 'snow', color: '#FFFFFF', walkable: true, speed: 0.5, image: '', valid_neighbors: ['snow', 'rocks', 'ice'], prompt: floor('fresh white snow with fine granular texture') },
  { name: 'ice', color: '#bae6fd', walkable: true, speed: 0.2, image: '', valid_neighbors: ['ice', 'snow', 'water'], prompt: floor('pale blue cracked ice') },
  { name: 'swamp', color: '#4d7c0f', walkable: true, speed: 0.1, image: '', valid_neighbors: ['swamp', 'earth', 'dirt', 'water', 'highgrass'], prompt: floor('murky green-brown mud with algae scum') },
  { name: 'water', color: '#3b82f6', walkable: false, speed: 0, image: '', valid_neighbors: ['water', 'sand', 'ice', 'swamp'], prompt: floor('clear blue water surface, scattered foam flecks') },

  // From MAP_TILE_TYPES in 1714440027000_bounded_worlds.js. These tiles are
  // stamped (not WFC-placed), so valid_neighbors is '[]' in that migration —
  // an empty array here is correct and matches it.
  { name: 'map_wall', color: '#2b2b2b', walkable: false, speed: 1.0, image: '', valid_neighbors: [], prompt: wall('mortared grey stone block wall') },
  { name: 'map_doorway', color: '#6b4f2a', walkable: true, speed: 1.0, image: '', valid_neighbors: [], prompt: wall('heavy wooden door set in a stone frame') },

  // From VILLAGE_TILE_TYPES in 1714440029000_villages_and_binds.js. Also
  // stamped, not WFC-placed, so valid_neighbors is '[]' there too.
  { name: 'wooden_wall', color: '#6b4a2a', walkable: false, speed: 1.0, image: '', valid_neighbors: [], prompt: wall('vertical wooden plank wall') },
  { name: 'village_gate', color: '#c9a24b', walkable: true, speed: 1.0, image: '', valid_neighbors: [], prompt: wall('heavy timber gate with iron bands') },

  // --- P3 (SOMET-247): biome signature floors -----------------------------
  //
  // One signature floor per new biome. A tile carries ONE image shared by
  // every biome that lists it (services/biomePrompt.js), so biomes cannot be
  // told apart by reusing `rocks` under a different palette -- distinct
  // identity requires distinct tiles.
  //
  // `color` is not filler: until sprites are generated locally, these colours
  // ARE the game's appearance.
  //
  // No name here matches PATH_NAME_RE (/path|dirt|road|trail|earth|sand/i).
  // The coastal tile is `storm_shingle`, not the obvious `storm_sand`, for
  // exactly that reason -- see tile_catalog_integrity.test.js.

  // Surface
  { name: 'highland_rock', color: '#7d8471', walkable: true, speed: 0.8, image: '', valid_neighbors: ['highland_rock', 'rocks', 'snow', 'grass'], prompt: floor('windswept grey-green highland stone') },
  { name: 'jungle_floor', color: '#1f6b2e', walkable: true, speed: 0.7, image: '', valid_neighbors: ['jungle_floor', 'highgrass', 'leafs', 'swamp'], prompt: floor('fallen green leaves and creeping vines on soil') },
  { name: 'storm_shingle', color: '#6b7280', walkable: true, speed: 0.6, image: '', valid_neighbors: ['storm_shingle', 'sand', 'water', 'rocks'], prompt: floor('wet dark pebbles and shingle stones') },
  { name: 'ruin_stone', color: '#8a8577', walkable: true, speed: 0.9, image: '', valid_neighbors: ['ruin_stone', 'rocks', 'earth', 'cobblestone'], prompt: floor('cracked weathered ruin flagstones') },
  { name: 'ash_waste', color: '#4a4038', walkable: true, speed: 0.7, image: '', valid_neighbors: ['ash_waste', 'ember_rock', 'rocks', 'dirt'], prompt: floor('deep soft drifts of grey ash and soot dust') },

  // Underground
  { name: 'cobblestone', color: '#6e6a63', walkable: true, speed: 0.9, image: '', valid_neighbors: ['cobblestone', 'crypt_floor', 'ruin_stone', 'rocks'], prompt: floor('worn grey cobblestone paving') },
  { name: 'crypt_floor', color: '#55504a', walkable: true, speed: 0.9, image: '', valid_neighbors: ['crypt_floor', 'cobblestone', 'bone_floor', 'rocks'], prompt: floor('cold crypt flagstone floor') },
  { name: 'bone_floor', color: '#c9c2ad', walkable: true, speed: 0.8, image: '', valid_neighbors: ['bone_floor', 'crypt_floor', 'cobblestone'], prompt: floor('floor of packed bone fragments') },
  { name: 'cave_floor', color: '#5a5148', walkable: true, speed: 0.9, image: '', valid_neighbors: ['cave_floor', 'rocks', 'dirt', 'cave_wall'], prompt: floor('damp brown cave floor stone') },
  { name: 'fungal_floor', color: '#6b7f3a', walkable: true, speed: 0.7, image: '', valid_neighbors: ['fungal_floor', 'swamp', 'dirt', 'blight_floor'], prompt: floor('dense pale mushroom caps and spongy mycelium') },
  { name: 'ember_rock', color: '#7a3b22', walkable: true, speed: 0.8, image: '', valid_neighbors: ['ember_rock', 'ash_waste', 'rocks', 'brimstone'], prompt: floor('cracked rock veined with glowing embers') },
  { name: 'rime_floor', color: '#a8c6d6', walkable: true, speed: 0.5, image: '', valid_neighbors: ['rime_floor', 'ice', 'snow', 'rocks'], prompt: floor('frost-rimed pale stone floor') },
  { name: 'vault_floor', color: '#4f5560', walkable: true, speed: 1.0, image: '', valid_neighbors: ['vault_floor', 'cobblestone', 'foundry_floor', 'rocks'], prompt: floor('flat riveted steel plates bolted flush together') },
  { name: 'hive_floor', color: '#8a6a2f', walkable: true, speed: 0.8, image: '', valid_neighbors: ['hive_floor', 'dirt', 'cave_floor'], prompt: floor('amber honeycomb wax cells') },
  { name: 'cistern_shallows', color: '#3f5a63', walkable: true, speed: 0.4, image: '', valid_neighbors: ['cistern_shallows', 'water', 'cobblestone', 'swamp'], prompt: floor('shallow clear water covering pale stone slabs') },
  { name: 'umbral_floor', color: '#2e2a35', walkable: true, speed: 0.9, image: '', valid_neighbors: ['umbral_floor', 'cave_floor', 'void_floor', 'rocks'], prompt: floor('lightless violet-black stone') },
  { name: 'crystal_floor', color: '#6fa8c9', walkable: true, speed: 0.8, image: '', valid_neighbors: ['crystal_floor', 'ice', 'rocks', 'cave_floor'], prompt: floor('pale blue crystal shard floor') },
  { name: 'blight_floor', color: '#5e6b3a', walkable: true, speed: 0.7, image: '', valid_neighbors: ['blight_floor', 'fungal_floor', 'swamp', 'dirt'], prompt: floor('cracked sickly grey-green crust over dead soil') },
  { name: 'foundry_floor', color: '#6a5a48', walkable: true, speed: 0.9, image: '', valid_neighbors: ['foundry_floor', 'vault_floor', 'ember_rock', 'rocks'], prompt: floor('flat soot-blackened iron plate surface, riveted seams') },

  // Abyssal
  { name: 'void_floor', color: '#1c1a24', walkable: true, speed: 0.9, image: '', valid_neighbors: ['void_floor', 'umbral_floor', 'chaos_floor'], prompt: floor('matte black surface with faint dark speckles') },
  { name: 'brimstone', color: '#8c3a1e', walkable: true, speed: 0.8, image: '', valid_neighbors: ['brimstone', 'ember_rock', 'ash_waste'], prompt: floor('crusted yellow sulphur over dark rock') },
  { name: 'chaos_floor', color: '#6b2f6b', walkable: true, speed: 0.9, image: '', valid_neighbors: ['chaos_floor', 'void_floor', 'crystal_floor'], prompt: floor('shifting iridescent chaos stone') },
  { name: 'sanctum_floor', color: '#b8a97a', walkable: true, speed: 1.0, image: '', valid_neighbors: ['sanctum_floor', 'cobblestone', 'ruin_stone'], prompt: floor('cream marble slabs with thin gold veins') },
  { name: 'dream_floor', color: '#4a3f6b', walkable: true, speed: 0.9, image: '', valid_neighbors: ['dream_floor', 'void_floor', 'umbral_floor'], prompt: floor('hazy indigo dreamlike ground') },
  { name: 'titan_floor', color: '#7a7266', walkable: true, speed: 1.0, image: '', valid_neighbors: ['titan_floor', 'ruin_stone', 'rocks'], prompt: floor('colossal weathered titan masonry') },
  { name: 'plague_floor', color: '#6b6b33', walkable: true, speed: 0.7, image: '', valid_neighbors: ['plague_floor', 'blight_floor', 'fungal_floor'], prompt: floor('sickly yellow-green slime over wet mud') },
  { name: 'maw_floor', color: '#3d1f22', walkable: true, speed: 0.8, image: '', valid_neighbors: ['maw_floor', 'void_floor', 'brimstone'], prompt: floor('raw pulsing flesh-like ground') },

  // Impassable. Banded ONLY by the ten deep biomes (see seeds/data/biomes.js).
  // cave_wall carries wall_height 48 to match map_wall/wooden_wall, which is
  // what makes it render with height rather than as a flat block.
  { name: 'cave_wall', color: '#3a352e', walkable: false, speed: 1.0, image: '', valid_neighbors: ['cave_wall', 'cave_floor', 'rocks'], prompt: wall('solid rough cave rock wall'), wall_height: 48 },
  { name: 'rubble', color: '#57524a', walkable: false, speed: 1.0, image: '', valid_neighbors: ['rubble', 'cave_floor', 'cobblestone', 'rocks'], prompt: floor('impassable heap of collapsed rubble') },
  { name: 'chasm', color: '#14121a', walkable: false, speed: 0, image: '', valid_neighbors: ['chasm', 'cave_floor', 'void_floor'], prompt: floor('pitch black rock, almost featureless darkness') },

  // --- Roads (SOMET-349 follow-up) ----------------------------------------
  //
  // Until now there was no road tile at all. `cfg.pathTile` -- the tile both
  // the ambient carvePaths noise AND the village-gate->doorway highways stamp
  // -- was whatever detectPathTile's regex happened to hit first in catalog id
  // order, which is `sand` (#FFFF00). So a deliberate highway was drawn in the
  // same bright yellow as the procedural squiggles crossing the whole map, and
  // was invisible as a road.
  //
  // These tiles are STAMPED, never WFC-placed and never sampled as terrain, so
  // valid_neighbors is [] exactly as it is for map_wall/village_gate. Two
  // mechanisms keep them out of terrain:
  //   - mapService's isStructuralTile() treats the `road_` prefix as
  //     structural, so they never enter cfg.terrainNames or a biome's list;
  //   - detectPathTile() skips the prefix, so the AMBIENT path tile every
  //     existing world already resolved to is unchanged and cached chunks stay
  //     byte-identical.
  // Both are pinned by tile_catalog_integrity.test.js -- the `road_` prefix is
  // load-bearing, not cosmetic. Renaming one of these to e.g. `stone_road`
  // would silently turn it into terrain AND make it a detectPathTile
  // candidate.
  //
  // `speed` is deliberately >= the terrain each one runs over: a road that
  // slowed you down would be a trap, not a road.
  //
  // Colours are picked to sit clearly off the terrain they cross, because
  // until sprites are generated these colours ARE the road.
  { name: 'road_dirt', color: '#b08d5e', walkable: true, speed: 1.15, image: '', valid_neighbors: [], prompt: floor('dry tan earth with fine gravel and dust') },
  { name: 'road_stone', color: '#9a958b', walkable: true, speed: 1.2, image: '', valid_neighbors: [], prompt: floor('dressed pale flagstone paving') },
  { name: 'road_sand', color: '#e0c27a', walkable: true, speed: 1.1, image: '', valid_neighbors: [], prompt: floor('dry pale desert sand, wind-scoured grit') },
  { name: 'road_snow', color: '#8fa3b3', walkable: true, speed: 1.1, image: '', valid_neighbors: [], prompt: floor('grey-blue slush over packed snow') },
  { name: 'road_ash', color: '#6e6257', walkable: true, speed: 1.15, image: '', valid_neighbors: [], prompt: floor('trodden grey cinders and coarse ash grit') },
];

module.exports = { DEFAULT_TILE_TYPES };
