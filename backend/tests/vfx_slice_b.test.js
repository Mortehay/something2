const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { resolveEffectName, momentForAttack, KIND_DEFAULTS } = require('../src/authority/vfx.js');
const { EFFECTS, BINDINGS } = require('../migrations/1714440168000_vfx_slice_b_effects.js');

// ---------------------------------------------------------------------------
// Slice B (SOMET-159): fallback resolution order, miss feedback, and the
// data actually covering every weapon.
// ---------------------------------------------------------------------------

test('resolution order: binding wins over the kind default', () => {
  const w = { kind: 'melee', vfx: { attack: 'slash_heavy' } };
  assert.equal(resolveEffectName(w, 'attack'), 'slash_heavy');
});

test('an UNBOUND weapon falls back to its kind default rather than nothing', () => {
  // The whole reason the fallback exists: a weapon added later in the Items
  // admin with no binding must render plain-but-visible. Invisible would look
  // exactly like the bug this epic was filed to fix.
  assert.equal(resolveEffectName({ kind: 'melee' }, 'attack'), 'generic_slash');
  assert.equal(resolveEffectName({ kind: 'projectile' }, 'attack'), 'generic_bolt');
});

test('a junk vfx value degrades to the kind default, not a crash', () => {
  // item_types.vfx is admin-editable jsonb with no FK, so anything can be in
  // there -- including an array or a number.
  for (const junk of [null, 42, 'nope', [], { attack: '' }, { attack: 7 }]) {
    assert.equal(resolveEffectName({ kind: 'melee', vfx: junk }, 'attack'), 'generic_slash');
  }
});

test('an unresolvable moment on a kind with no default is null, not a wrong effect', () => {
  // 'trail' has no kind default: slice D binds it explicitly. Inventing one
  // here would draw a trail on weapons that were never authored to have one.
  assert.equal(resolveEffectName({ kind: 'melee' }, 'trail'), null);
  assert.equal(resolveEffectName(null, 'attack'), null);
});

test('a MISS resolves the miss binding, never the attack one', () => {
  // The distinction is the entire point of miss feedback: falling back from a
  // missing `miss` to `attack` would draw a hit on a whiff.
  const w = { kind: 'melee', vfx: { attack: 'slash_heavy' } };
  assert.equal(momentForAttack(false), 'miss');
  assert.equal(resolveEffectName(w, momentForAttack(false)), 'generic_whiff',
    'falls to the kind MISS default, not to the bound attack effect');
  assert.equal(resolveEffectName(w, momentForAttack(true)), 'slash_heavy');
});

test('every kind default names an effect this migration actually seeds', () => {
  // A default pointing at a row that does not exist is silently invisible --
  // the client drops an event whose name it cannot look up.
  const seeded = new Set(EFFECTS.map(([n]) => n));
  for (const [moment, byKind] of Object.entries(KIND_DEFAULTS)) {
    for (const [kind, name] of Object.entries(byKind)) {
      assert.ok(seeded.has(name), `KIND_DEFAULTS.${moment}.${kind} -> "${name}" is not seeded`);
    }
  }
});

test('every binding names an effect that is seeded (or slice A\'s sweep_arc)', () => {
  const seeded = new Set([...EFFECTS.map(([n]) => n), 'sweep_arc']);
  for (const [weapon, bindings] of Object.entries(BINDINGS)) {
    for (const [moment, name] of Object.entries(bindings)) {
      assert.ok(seeded.has(name), `${weapon}.${moment} -> "${name}" is not seeded anywhere`);
    }
  }
});

test('every seeded effect uses a shape the schema permits AND the renderer draws', () => {
  // The CHECK constraint admits five shapes; slice A drew one. Seeding a shape
  // the renderer skips would pass the database and render nothing.
  const SHAPES = new Set(['arc', 'line', 'ring', 'burst', 'bolt']);
  for (const [name, shape] of EFFECTS) {
    assert.ok(SHAPES.has(shape), `${name} uses unknown shape ${shape}`);
  }
  const render = fs.readFileSync(
    path.resolve(__dirname, '../../frontend/src/games/something2/src/js/systems/RenderSystem.js'), 'utf8',
  );
  for (const shape of new Set(EFFECTS.map(([, s]) => s))) {
    assert.ok(render.includes(`"${shape}"`), `RenderSystem never mentions the "${shape}" shape`);
  }
});

test('all 22 weapons are bound, and melee carries a miss', () => {
  // Pinned as a COUNT as well as per-weapon: a weapon added to the catalog
  // later shows up here as a gap rather than quietly taking the default.
  assert.equal(Object.keys(BINDINGS).length, 22, 'the catalog has 12 melee + 10 projectile weapons');
  const melee = Object.entries(BINDINGS).filter(([, b]) => b.miss);
  assert.equal(melee.length, 12, 'every melee weapon binds a miss effect');
  for (const [weapon, b] of Object.entries(BINDINGS)) {
    assert.ok(b.attack, `${weapon} has no attack binding`);
  }
  // A projectile cannot whiff at the moment of firing -- the shot leaves
  // regardless -- so binding one would be dead data.
  const projectiles = Object.entries(BINDINGS).filter(([, b]) => b.trail);
  assert.equal(projectiles.length, 10);
  for (const [weapon, b] of projectiles) {
    assert.ok(!b.miss, `${weapon} is a projectile and must not bind a miss`);
  }
});
