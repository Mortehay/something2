const test = require('node:test');
const assert = require('node:assert');
const { resolveEffectName } = require('../src/authority/vfx.js');

test('resolves the bound name for a moment', () => {
  const w = { name: 'halberd', kind: 'melee', vfx: { attack: 'sweep_arc', impact: 'spark_steel' } };
  assert.equal(resolveEffectName(w, 'attack'), 'sweep_arc');
  assert.equal(resolveEffectName(w, 'impact'), 'spark_steel');
});

// SLICE B (SOMET-159) made this edit, which slice A's own comment predicted:
// "Slice B replaces this with a kind-level default. Asserted explicitly so
// that change is a deliberate edit to a failing test, not a silent drift."
// This is that deliberate edit. The contract did not weaken -- it gained a
// second rung: binding -> kind default -> nothing.
test('an unbound moment falls to the kind default for that moment', () => {
  const w = { name: 'halberd', kind: 'melee', vfx: { attack: 'sweep_arc' } };
  assert.equal(resolveEffectName(w, 'miss'), 'generic_whiff',
    'the MISS default, never the bound attack effect -- a whiff must not draw a hit');
});

test('an unbound weapon falls to its kind default rather than rendering nothing', () => {
  assert.equal(resolveEffectName({ name: 'club', kind: 'melee', vfx: null }, 'attack'), 'generic_slash');
  assert.equal(resolveEffectName({ name: 'club', kind: 'melee' }, 'attack'), 'generic_slash');
  assert.equal(resolveEffectName({ name: 'bow', kind: 'projectile' }, 'attack'), 'generic_bolt');
});

test('a weapon with NO kind still resolves to null, not to a guessed default', () => {
  // The fallback is keyed on item_types.kind. Without one there is nothing to
  // key on, and inventing a default would draw a melee swing for something
  // that may not be melee.
  assert.equal(resolveEffectName({ name: 'mystery', vfx: null }, 'attack'), null);
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
