const test = require('node:test');
const assert = require('node:assert/strict');

const { optionsForEntity, optionsForAppearance, SPRITE_DIRECTIONS } = require('../src/services/spriteBatchOptions.js');

test('creatures derive a four-frame directional sprite job', () => {
  assert.deepEqual(optionsForEntity({
    id: 7,
    name: 'Wolf',
    prompt: 'a grey forest wolf',
    is_creature: true,
    is_playable: false,
    render_mode: 'static',
  }), {
    entityTypeId: 7,
    appearanceVariant: null,
    subject: 'Wolf',
    prompt: 'a grey forest wolf',
    kind: 'creature',
    frames: 4,
    directions: SPRITE_DIRECTIONS,
  });
});

test('static props fall back to their name when the entity has no prompt', () => {
  assert.deepEqual(optionsForEntity({
    id: 8,
    name: 'pine_tree',
    prompt: '',
    is_creature: false,
    is_playable: false,
    render_mode: 'rect',
  }), {
    entityTypeId: 8,
    appearanceVariant: null,
    subject: 'pine_tree',
    prompt: 'pine_tree',
    kind: 'object',
    frames: 1,
    directions: ['s'],
  });
});

test('animated props get four frames', () => {
  const options = optionsForEntity({
    id: 9,
    name: 'Torch',
    prompt: 'a burning wall torch',
    is_creature: false,
    is_playable: false,
    render_mode: 'animated',
  });

  assert.equal(options.kind, 'object');
  assert.equal(options.frames, 4);
});

test('an appearance variant derives a four-frame directional job keyed by class:variant', () => {
  const options = optionsForAppearance({
    entity_type_id: 3,
    variant: 2,
    class_name: 'Mage',
    class_prompt: 'a spell-flinging mage',
  });

  assert.equal(options.entityTypeId, 3);
  assert.equal(options.appearanceVariant, 2);
  assert.equal(options.subject, 'Mage:2');
  assert.equal(options.kind, 'creature');
  assert.equal(options.frames, 4);
  assert.match(options.prompt, /Mage/);
});

test('prop options get ["s"]', () => {
  const options = optionsForEntity({ id: 8, name: 'Torch', prompt: 'x', is_creature: false, is_playable: false, render_mode: 'animated' });
  assert.deepEqual(options.directions, ['s']);
});

test('appearance options get 8 facings', () => {
  const options = optionsForAppearance({ entity_type_id: 3, variant: 2, class_name: 'Mage', class_prompt: 'm' });
  assert.deepEqual(options.directions, ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw']);
});
