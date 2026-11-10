// Status visuals (amber stance art): the effect-kind registry entry, the Sprite-tab catalog group
// and the amber prompt. Pure: no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { kindOf, alwaysLoops } = require('../src/services/effectKinds.js');
const { statusSubject, subjectPrompt, subjectDefaults, GROUP_ORDER } = require('../src/services/effectCatalog.js');
const { STATUS_KEYS, STATUS_COLOR } = require('../src/services/statusVisuals.js');
const { PROMPT_KINDS } = require('../src/services/spritePrompts.js');
const { CONTRACTS } = require('../src/services/subjectDescriber.js');
const { approveColumns } = require('../src/services/effectSprites.js');

const rowOf = (variant) => ({ key: `amber_stance_${variant}`, status_key: 'amber_stance', variant });

test('the status kind lives in status_visuals, keyed by its generated subject_key, and always loops', () => {
  const k = kindOf('status');
  assert.equal(k.table, 'status_visuals');
  assert.equal(k.keyCol, 'subject_key');
  assert.equal(k.boxKind, 'aura');
  assert.deepEqual(k.spriteCols, ['sprite_image', 'sprite_frames', 'sprite_additive', 'sprite_fps']);
  assert.equal(alwaysLoops('status'), true);
  const c = approveColumns({ subject_kind: 'status', kind: 'aura', atlas: { frames: 8 }, imageKey: 'vfx/a.png', frames: 8, blend: 'alpha' });
  assert.deepEqual(Object.keys(c).sort(), [...k.spriteCols].sort());
});

test('STATUS_KEYS is amber_stance_1..10', () => {
  assert.deepEqual(STATUS_KEYS, Array.from({ length: 10 }, (_, i) => `amber_stance_${i + 1}`));
});

test('the Sprite tab gets a "Status visuals" group, listed and not skipped by select-all', () => {
  assert.ok(GROUP_ORDER.includes('Status visuals'));
  assert.ok(GROUP_ORDER.indexOf('Status visuals') < GROUP_ORDER.indexOf('Not used yet'));
  const s = statusSubject(rowOf(3));
  assert.equal(s.subject_kind, 'status');
  assert.equal(s.name, 'amber_stance_3');
  assert.equal(s.group, 'Status visuals');
  assert.equal(s.retired, false);
  assert.equal(s.kind, 'aura');
  assert.equal(s.loop, true);
  assert.equal(s.color, STATUS_COLOR);
});

test('the amber prompt is a figure-sized translucent block with smoke at the base, and varies by variant', () => {
  const p3 = subjectPrompt(statusSubject(rowOf(3)));
  const p4 = subjectPrompt(statusSubject(rowOf(4)));
  assert.match(p3, /amber/i);
  assert.match(p3, /translucent/i);
  assert.match(p3, /figure/i);
  assert.match(p3, /smoke/i);
  assert.notEqual(p3, p4);
  assert.equal(new Set(STATUS_KEYS.map((key) => subjectPrompt(statusSubject({ key, variant: Number(key.split('_').pop()) })))).size, 10);
});

test('the describer and prompt routes know the status kind', () => {
  assert.ok(PROMPT_KINDS.includes('status'));
  assert.equal(CONTRACTS.status, CONTRACTS.aura);
  assert.equal(subjectDefaults({ subject_kind: 'status', name: 'amber_stance_1', shape: null, color: STATUS_COLOR }).kind, 'aura');
});
