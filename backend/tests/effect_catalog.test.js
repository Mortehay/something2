const test = require('node:test');
const assert = require('node:assert/strict');
const { BATCH_1, defaultPrompt } = require('../src/services/effectSprites.js');
const {
  kindForShape, isDarkColor, subjectDefaults, groupOf, PLAYER_SKILL_EFFECTS, RETIRED_EFFECTS, GROUP_ORDER,
} = require('../src/services/effectCatalog.js');

// Each batch-1 vfx name's live vfx_effects.shape (dev DB, 2026-11-10). Auras have no shape.
const SHAPE_OF = {
  arcane_beam: 'line', ball_lightning: 'burst', blizzard_blast: 'burst', bolt_arcane: 'bolt',
  bolt_fire: 'bolt', bolt_ice: 'bolt', bolt_storm: 'bolt', boss_chain_lightning: 'bolt',
  chain_lightning: 'bolt', curse_blast: 'burst', fireball_blast: 'burst', spark_hit: 'burst',
};

const pick = (d) => ({ kind: d.kind, frames: d.frames, size: d.size, loop: d.loop, topDown: d.topDown });

test('shape → kind', () => {
  assert.deepEqual(['bolt', 'line', 'burst', 'ring', 'arc'].map(kindForShape), ['projectile', 'beam', 'burst', 'burst', 'beam']);
});

test('dark colours blend alpha, bright additive', () => {
  assert.equal(isDarkColor('#2a1840'), true);
  assert.equal(isDarkColor('#ff7a1a'), false);
  assert.equal(isDarkColor(null), false);
  assert.equal(subjectDefaults({ subject_kind: 'vfx', name: 'x_dark', shape: 'burst', color: '#2a1840' }).blend, 'alpha');
  assert.equal(subjectDefaults({ subject_kind: 'vfx', name: 'x_bright', shape: 'burst', color: '#ff7a1a' }).blend, 'additive');
});

test('the 21 batch-1 effects keep their exact settings', () => {
  assert.equal(BATCH_1.length, 21);
  for (const b of BATCH_1) {
    const d = subjectDefaults({ subject_kind: b.subject_kind, name: b.name, shape: SHAPE_OF[b.name], color: '#ffffff' });
    assert.deepEqual({ kind: d.kind, frames: d.frames, size: d.size, loop: d.loop, blend: d.blend },
      { kind: b.kind, frames: b.frames, size: b.size, loop: b.loop, blend: b.blend }, b.name);
  }
});

test('arc → beam one-shot 6 frames 96; ring → burst top-down 6 frames 128', () => {
  assert.deepEqual(pick(subjectDefaults({ subject_kind: 'vfx', name: 'cleave', shape: 'arc', color: '#ffffff' })),
    { kind: 'beam', frames: 6, size: 96, loop: false, topDown: false });
  assert.deepEqual(pick(subjectDefaults({ subject_kind: 'vfx', name: 'frost_nova', shape: 'ring', color: '#8fdcff' })),
    { kind: 'burst', frames: 6, size: 128, loop: false, topDown: true });
});

test('a non-batch-1 aura is an 8-frame looping 128 aura', () => {
  assert.deepEqual(pick(subjectDefaults({ subject_kind: 'aura', name: 'new_aura', shape: null, color: '#ffffff' })),
    { kind: 'aura', frames: 8, size: 128, loop: true, topDown: false });
});

test('groupOf takes the first matching group', () => {
  const refs = { weapon: new Set(['generic_whiff']), creatureSkill: new Set(['x']), playerSkill: new Set(['x', 'y']), fallback: new Set(['generic_whiff']) };
  assert.equal(groupOf('generic_whiff', refs), 'Weapon attacks');
  assert.equal(groupOf('x', refs), 'Creature & boss skills');
  assert.equal(groupOf('y', refs), 'Player skills');
  assert.equal(groupOf('zzz', refs), 'Not used yet');
});

test('group order and retired names', () => {
  assert.deepEqual(GROUP_ORDER, ['Weapon attacks', 'Creature & boss skills', 'Player skills', 'Fallbacks', 'Auras', 'Buff auras', 'Status visuals', 'Not used yet']);
  assert.deepEqual([...RETIRED_EFFECTS].sort(), ['spark_fire', 'spark_ice', 'spark_lightning']);
});

test('player-skill set equals the frontend resolver over the frontend catalog', async () => {
  const fe = await import('../../frontend/src/games/something2/src/js/core/skillsData.js');
  assert.deepEqual([...PLAYER_SKILL_EFFECTS].sort(), [...new Set(fe.SKILLS.map(fe.resolveSkillVfx))].sort());
});

test('ring prompt says seen from above', () => {
  assert.equal(defaultPrompt('frost_nova', '#8fdcff', { topDown: true }), 'frost nova, ice blue, seen from above');
  assert.equal(defaultPrompt('frost_nova', '#8fdcff'), 'frost nova, ice blue');
});
