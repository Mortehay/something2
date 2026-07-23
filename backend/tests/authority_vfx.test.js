const test = require('node:test');
const assert = require('node:assert');
const { resolveEffectName } = require('../src/authority/vfx.js');

test('resolves the bound name for a moment', () => {
  const w = { name: 'halberd', kind: 'melee', vfx: { attack: 'sweep_arc', impact: 'spark_steel' } };
  assert.equal(resolveEffectName(w, 'attack'), 'sweep_arc');
  assert.equal(resolveEffectName(w, 'impact'), 'spark_steel');
});

test('an unbound moment resolves to null', () => {
  const w = { name: 'halberd', kind: 'melee', vfx: { attack: 'sweep_arc' } };
  assert.equal(resolveEffectName(w, 'miss'), null);
});

test('an unbound weapon resolves to null in slice A', () => {
  // Slice B replaces this with a kind-level default. Asserted explicitly so
  // that change is a deliberate edit to a failing test, not a silent drift.
  assert.equal(resolveEffectName({ name: 'club', kind: 'melee', vfx: null }, 'attack'), null);
  assert.equal(resolveEffectName({ name: 'club', kind: 'melee' }, 'attack'), null);
});

test('junk in the jsonb never escapes as a name', () => {
  // vfx has no referential integrity and is admin-editable, so every
  // non-string shape has to degrade to "draw nothing", not reach the client.
  for (const bad of [{ attack: 42 }, { attack: '' }, { attack: null }, { attack: {} }, { attack: [] }]) {
    assert.equal(resolveEffectName({ vfx: bad }, 'attack'), null, JSON.stringify(bad));
  }
  for (const bad of ['sweep_arc', 42, [], true]) {
    assert.equal(resolveEffectName({ vfx: bad }, 'attack'), null, `vfx=${JSON.stringify(bad)}`);
  }
});

test('a missing weapon resolves to null rather than throwing', () => {
  assert.equal(resolveEffectName(null, 'attack'), null);
  assert.equal(resolveEffectName(undefined, 'attack'), null);
});
