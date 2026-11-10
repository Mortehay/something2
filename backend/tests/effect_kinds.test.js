const test = require('node:test');
const assert = require('node:assert/strict');
const { EFFECT_KINDS, kindOf } = require('../src/services/effectKinds.js');
const { approveColumns } = require('../src/services/effectSprites.js');
const { subjectPrompt } = require('../src/services/effectCatalog.js');
const describer = require('../src/services/subjectDescriber.js');

test('kindOf names the table and key column of each effect subject kind, null for anything else', () => {
  assert.deepEqual(Object.keys(EFFECT_KINDS).sort(), ['aura', 'buff', 'status', 'vfx']);
  assert.equal(kindOf('buff').table, 'buff_visuals');
  assert.equal(kindOf('buff').keyCol, 'skill_id');
  assert.deepEqual(kindOf('buff').spriteCols, ['sprite_image', 'sprite_frames', 'sprite_additive', 'sprite_fps']);
  assert.equal(kindOf('aura').table, 'aura_effects');
  assert.equal(kindOf('vfx').table, 'vfx_effects');
  assert.equal(kindOf('vfx').keyCol, 'name');
  assert.equal(kindOf('nope'), null);
  assert.equal(kindOf('toString'), null);
  assert.equal(kindOf(undefined), null);
});

test('approveColumns for a buff is the aura column set (always loops, fps from the atlas else 10)', () => {
  const c = approveColumns({ subject_kind: 'buff', kind: 'aura', atlas: { frames: 8, fps_hint: 9, blend: 'alpha' }, imageKey: 'vfx/b.png', frames: 8, blend: 'additive' });
  assert.deepEqual(c, { sprite_image: 'vfx/b.png', sprite_frames: 8, sprite_additive: false, sprite_fps: 9 });
  assert.deepEqual(Object.keys(c).sort(), [...kindOf('buff').spriteCols].sort());
  const d = approveColumns({ subject_kind: 'buff', kind: 'aura', atlas: { frames: 8 }, imageKey: 'vfx/b.png', frames: 8, blend: 'additive' });
  assert.equal(d.sprite_fps, 10);
});

test('a buff default prompt is its English name and colour word, then where it draws', () => {
  const body = { subject_kind: 'buff', name: 'war_shield_wall', nameEn: 'Shield Wall', color: '#3b82f6', placement: 'body' };
  const ground = { subject_kind: 'buff', name: 'mag_immolation_aura', nameEn: 'Immolation Aura', color: '#ea580c', placement: 'ground' };
  assert.equal(subjectPrompt(body), 'Shield Wall, blue, shell around a figure');
  assert.equal(subjectPrompt(ground), 'Immolation Aura, orange, seen from above');
  // vfx / aura are unchanged: the name with underscores spaced, the ring top-down.
  assert.equal(subjectPrompt({ subject_kind: 'aura', name: 'pack_leader', color: '#d4a017', topDown: false }), 'pack leader, gold');
  assert.equal(subjectPrompt({ subject_kind: 'vfx', name: 'frost_nova', color: '#8fdcff', topDown: true }), 'frost nova, ice blue, seen from above');
});

test('the describer gives a buff the effect contract, budget and clean-up', () => {
  const subject = { kind: 'buff', key: 'war_shield_wall', name: 'Shield Wall', basePrompt: 'Shield Wall, blue, shell around a figure', row: { type: 'aura' } };
  const [sys] = describer.buildMessages(subject, 'medium');
  assert.match(sys.content, /^You describe ONE animated visual effect/);
  assert.equal(describer.CONTRACTS.buff, describer.CONTRACTS.aura);
  assert.deepEqual(describer.budgetFor(subject, 'medium'), describer.EFFECT_LENGTHS.medium);
  assert.equal(describer.clean('pixel art blue shimmering shell', 'medium', subject), describer.clean('pixel art blue shimmering shell', 'medium', { ...subject, kind: 'aura' }));
});
