// backend/tests/audio_prompt_context.test.js
const test = require('node:test');
const assert = require('node:assert');
const { buildContext, isStale, stripImageStyling } = require('../src/services/audioPromptContext');

const CAT = {
  worlds: new Map([['Vale', { biomes: ['Meadow', 'Deep Forest'], level_min: 1, level_max: 10 }]]),
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
    'world "Vale"; regions: Meadow, Deep Forest; levels 1-10; slot: music');
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
