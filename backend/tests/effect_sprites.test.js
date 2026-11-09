const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('../src/services/effectSprites.js');
test('batch 1 is exactly the spec table: 21 effects, 9 auras', () => {
  assert.equal(fx.BATCH_1.length, 21);
  assert.equal(fx.BATCH_1.filter((s) => s.subject_kind === 'aura').length, 9);
  assert.deepEqual(fx.BATCH_1.filter((s) => s.kind === 'beam').map((s) => s.name), ['arcane_beam', 'chain_lightning', 'boss_chain_lightning']);
});
test('dark effects blend alpha, the rest additive', () => {
  assert.deepEqual(fx.BATCH_1.filter((s) => s.blend === 'alpha').map((s) => s.name).sort(),
    ['abyssor_void_rend', 'curse_blast', 'ossuary_dread', 'shade_veil']);
});
test('default prompt is name + colour words, nothing else', () => {
  assert.equal(fx.defaultPrompt('pack_leader', '#d4a017'), 'pack leader, gold');
  assert.equal(fx.defaultPrompt('fire_sparks', '#d31769'), 'fire sparks, magenta');
  assert.equal(fx.defaultPrompt('bolt_ice', '#8fdcff'), 'bolt ice, ice blue');
  assert.doesNotMatch(fx.defaultPrompt('spark_hit', '#ffffff'), /pixel|background|transparent|right/i);
});
test('every strip fits the vfxSprite limits', () => {
  for (const s of fx.BATCH_1) assert.ok(s.frames <= 64 && s.frames * s.size <= 8192 && s.size <= 2048, s.name);
});
test('approve columns: beam stretches, burst keeps duration timing, alpha blend is not additive', () => {
  const beam = fx.approveColumns({ subject_kind: 'vfx', kind: 'beam', imageKey: 'vfx/k.png', atlas: { frames: 4, fps_hint: 14, loop: true, blend: 'additive', pivot: [0, 0.5] } });
  assert.deepEqual(beam, { sprite_image: 'vfx/k.png', sprite_frames: 4, sprite_additive: true, sprite_loop: true, sprite_fps: 14, sprite_stretch: true });
  const burst = fx.approveColumns({ subject_kind: 'vfx', kind: 'burst', imageKey: 'vfx/k.png', atlas: { frames: 6, fps_hint: 12, loop: false, blend: 'alpha' } });
  assert.equal(burst.sprite_fps, null); assert.equal(burst.sprite_additive, false);
  const aura = fx.approveColumns({ subject_kind: 'aura', kind: 'aura', imageKey: 'vfx/k.png', atlas: { frames: 8, blend: 'additive' } });
  assert.deepEqual(Object.keys(aura).sort(), ['sprite_additive', 'sprite_fps', 'sprite_frames', 'sprite_image']);
  assert.equal(aura.sprite_fps, 10);
});
test('readAtlas: tail pivot in pixels or normalised; centre pivot is not a tail', () => {
  assert.equal(fx.readAtlas({ pivot: [0, 48], cell: [96, 96] }, { kind: 'projectile', frames: 4 }).tailPivot, true);
  assert.equal(fx.readAtlas({ pivot: { x: 0.5, y: 0.5 } }, { kind: 'beam', frames: 4 }).tailPivot, false);
});
test('estimate is a placeholder until measured', () => {
  assert.deepEqual(fx.effectEstimate('aura', null), { low: 69, typical: 69, high: 125, placeholder: true });
  assert.deepEqual(fx.effectEstimate('aura', 80), { low: 80, typical: 80, high: 80, placeholder: false });
});
test('readAtlas falls back to the job values and pixel/string cells work', () => {
  const a = fx.readAtlas({}, { kind: 'burst', frames: 6 });
  assert.deepEqual(a, { frames: 6, fpsHint: null, loop: false, blend: null, tailPivot: false });
  assert.equal(fx.readAtlas({ pivot: [48, 48], cell: '96x96' }, { kind: 'beam', frames: 4 }).tailPivot, false);
});
test('approveColumns falls back to the job frames/blend and throws without them', () => {
  assert.equal(fx.approveColumns({ subject_kind: 'aura', kind: 'aura', imageKey: 'k', atlas: {}, frames: 8, blend: 'additive' }).sprite_frames, 8);
  assert.throws(() => fx.approveColumns({ subject_kind: 'aura', kind: 'aura', imageKey: 'k', atlas: {}, blend: 'additive' }), /no frame count/);
  assert.throws(() => fx.approveColumns({ subject_kind: 'aura', kind: 'aura', imageKey: 'k', atlas: { frames: 0 }, frames: 99, blend: 'additive' }), /no frame count/);
  const dark = fx.approveColumns({ subject_kind: 'aura', kind: 'aura', imageKey: 'k', atlas: { frames: 8 }, frames: 8, blend: 'alpha' });
  assert.equal(dark.sprite_additive, false);
  assert.throws(() => fx.approveColumns({ subject_kind: 'aura', kind: 'aura', imageKey: 'k', atlas: { frames: 8, blend: 'x' } }), /no blend/);
});
test('readAtlas: absent pivot uses the kind default, present-invalid is null', () => {
  assert.equal(fx.readAtlas({}, { kind: 'beam' }).tailPivot, true);
  assert.equal(fx.readAtlas({}, { kind: 'aura' }).tailPivot, false);
  assert.equal(fx.readAtlas({}, { kind: 'burst' }).tailPivot, false);
  assert.equal(fx.readAtlas({ pivot: 'bad' }, { kind: 'beam' }).tailPivot, null);
  assert.equal(fx.readAtlas({ pivot: [0, 48], cell: 'junk' }, { kind: 'beam' }).tailPivot, null);
  assert.equal(fx.readAtlas({ pivot: [48, 48] }, { kind: 'beam' }).tailPivot, null);
});

test('boxRequestFor sends the seed as a number even when pg returns the bigint as a string', () => {
  const req = fx.boxRequestFor({ id: 1, prompt: 'p', kind: 'burst', frames: 4, size: 64, loop: false, blend: 'alpha', seed: '959603229' });
  assert.strictEqual(req.seed, 959603229);
  assert.throws(() => fx.boxRequestFor({ id: 2, seed: '99999999999999999999' }), /safe integer/);
});
