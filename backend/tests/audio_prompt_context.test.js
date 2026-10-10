// backend/tests/audio_prompt_context.test.js
const test = require('node:test');
const assert = require('node:assert');
const {
  buildContext, isStale, stripImageStyling, worldKind, worldMusicStyle,
} = require('../src/services/audioPromptContext');

const CAT = {
  worlds: new Map([['Vale', {
    biomes: ['Meadow', 'Deep Forest'], level_min: 1, level_max: 10, allows_fast_travel: true, has_village: false, width: 96,
  }]]),
  biomes: new Map([['Meadow', { art_style: 'rolling grass, wildflowers' }]]),
  entities: new Map([
    ['Wolf', { prompt: 'pixel art, a grey timber wolf, single object, solid transparent background' }],
    ['Shrine', { prompt: 'pixel art, a stone waypoint shrine' }],
  ]),
  items: new Map([['arbalest', { category: 'weapon', req_level: 12 }]]),
  skills: new Map([['war_whirlwind', { nameEn: 'Whirlwind', class: 'Warrior', type: 'melee' }]]),
  artDescriptions: new Map([['entity/Wolf', 'lean grey wolf with bared fangs'], ['skill/war_whirlwind', 'spinning greatsword']]),
};

test('stripImageStyling drops styling clauses, keeps the subject', () => {
  assert.equal(stripImageStyling('pixel art, a grey timber wolf, single object, solid transparent background'), 'a grey timber wolf');
  assert.equal(stripImageStyling(''), '');
});

test('world context names biomes and level band', () => {
  assert.equal(buildContext(CAT, 'world', 'Vale', 'music'),
    'world "Vale"; type: overworld area; regions: Meadow, Deep Forest; levels 1-10; slot: music');
});

// Live 2026-10-04: told only name/regions/levels, the model picked "dungeon"
// for 18 of 20 worlds, overworld frontiers included. The kind now comes from
// what the database knows: fast travel (overworld) and a village row.
test('worldKind reads fast travel, villages, boss rooms and the legacy chunked world', () => {
  const room = { allows_fast_travel: false, has_village: false, width: 96 };
  assert.equal(worldKind(room, 'The Catacombs: Deep'), 'dungeon room');
  assert.equal(worldKind(room, 'The Catacombs: Elite'), 'dungeon boss room');
  assert.equal(worldKind(room, 'The Umbral Gate: End'), 'dungeon boss room');
  assert.equal(worldKind({ ...room, has_village: true }, 'The Abyss: Hub'), 'dungeon hub with a village');
  assert.equal(worldKind({ allows_fast_travel: true, has_village: false, width: 96 }, 'Glacier\'s End'), 'overworld area');
  assert.equal(worldKind({ allows_fast_travel: true, has_village: true, width: 96 }, 'Vale Crossing'), 'overworld village');
  assert.equal(worldKind({ allows_fast_travel: false, has_village: false, width: null }, 'Overworld'), 'overworld area');
  assert.equal(worldKind({ ...room, is_entry: true }, 'Start'), 'overworld area');
});

test('worldMusicStyle maps each kind to one box style', () => {
  const pairs = [
    [{ allows_fast_travel: false, has_village: false, width: 96 }, 'The Catacombs: Deep', 'dungeon'],
    [{ allows_fast_travel: false, has_village: false, width: 96 }, 'The Catacombs: Elite', 'battle'],
    [{ allows_fast_travel: false, has_village: true, width: 96 }, 'The Abyss: Hub', 'tavern'],
    [{ allows_fast_travel: true, has_village: true, width: 96 }, 'Vale Crossing', 'village'],
    [{ allows_fast_travel: true, has_village: false, width: 96 }, 'Ashfields Frontier', 'medieval_fantasy'],
  ];
  for (const [w, name, style] of pairs) assert.equal(worldMusicStyle(w, name), style, name);
});

test('biome context carries art_style', () => {
  assert.equal(buildContext(CAT, 'biome', 'Meadow', 'ambience'),
    'biome "Meadow"; looks like: rolling grass, wildflowers; slot: ambience');
});

test('creature prefers the ACTIVE ART DESCRIPTION over the image prompt', () => {
  assert.equal(buildContext(CAT, 'creature', 'Wolf', 'hurt', { cue: 'hit' }),
    'creature "Wolf"; looks like: lean grey wolf with bared fangs; slot: hurt; sound cue: hit');
});

test('world point with NO art description falls back to the stripped entity prompt', () => {
  assert.equal(buildContext(CAT, 'world_point', 'Shrine', 'nearby', { cue: 'waypoint' }),
    'world point "Shrine"; looks like: a stone waypoint shrine; slot: nearby; sound cue: waypoint');
});

test('item and skill carry their catalog fields', () => {
  assert.equal(buildContext(CAT, 'item', 'arbalest', 'use', { cue: 'slash' }),
    'weapon "arbalest"; required level 12; slot: use; sound cue: slash');
  assert.equal(buildContext(CAT, 'skill', 'war_whirlwind', 'use', { cue: 'slash' }),
    'Warrior melee skill "Whirlwind"; looks like: spinning greatsword; slot: use; sound cue: slash');
});

test('attack_type uses the per-slot phrase', () => {
  assert.equal(buildContext(CAT, 'attack_type', 'melee', 'hit', { cue: 'hit' }),
    'melee attack: a blade on a creature; slot: hit; sound cue: hit');
});

test('unknown subject -> null', () => {
  assert.equal(buildContext(CAT, 'creature', 'Nope', 'hurt'), null);
  assert.equal(buildContext(CAT, 'nope', 'x', 'y'), null);
});

test('isStale', () => {
  assert.equal(isStale({ source_input: 'a' }, 'a'), false);
  assert.equal(isStale({ source_input: 'a' }, 'b'), true);
  assert.equal(isStale({ source_input: null }, 'b'), false, 'hand-written is never stale');
  assert.equal(isStale(null, 'b'), false);
  assert.equal(isStale({ source_input: 'a' }, null), false, 'unknown subject is not stale');
});

test('SOMET-605: a boss creature row carries its tier and element; a boss slot says what it is for', () => {
  const catalog = {
    worlds: new Map(), biomes: new Map(), items: new Map(), skills: new Map(), artDescriptions: new Map(),
    entities: new Map([
      ['zzTitan', { name: 'zzTitan', prompt: 'a molten giant', boss_tier: 'world', element: 'fire' }],
      ['zzSlime', { name: 'zzSlime', prompt: 'a green blob', boss_tier: null, element: null }],
    ]),
  };
  assert.equal(buildContext(catalog, 'creature', 'zzTitan', 'presence'),
    'creature "zzTitan"; boss tier: world; element: fire; looks like: a molten giant; slot: presence (a loop that plays while the boss is on screen)');
  assert.equal(buildContext(catalog, 'creature', 'zzTitan', 'hurt', { cue: 'hit' }),
    'creature "zzTitan"; boss tier: world; element: fire; looks like: a molten giant; slot: hurt; sound cue: hit');
});

test('SOMET-605: an ordinary creature context is byte-identical to before (no stale flood)', () => {
  const catalog = {
    worlds: new Map(), biomes: new Map(), items: new Map(), skills: new Map(), artDescriptions: new Map(),
    entities: new Map([['zzSlime', { name: 'zzSlime', prompt: 'a green blob', boss_tier: null, element: 'fire' }]]),
  };
  // The literal is today's output, written out -- not recomputed.
  assert.equal(buildContext(catalog, 'creature', 'zzSlime', 'hurt', { cue: 'hit' }),
    'creature "zzSlime"; looks like: a green blob; slot: hurt; sound cue: hit');
});
