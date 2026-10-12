const test = require('node:test');
const assert = require('node:assert/strict');

const { optionsForEntity } = require('../src/services/spriteBatchOptions.js');

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
    subject: 'Wolf',
    prompt: 'a grey forest wolf',
    kind: 'creature',
    frames: 4,
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
    subject: 'pine_tree',
    prompt: 'pine_tree',
    kind: 'object',
    frames: 1,
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
