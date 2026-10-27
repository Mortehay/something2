// backend/tests/creature_skills_resolve.test.js
// SOMET-608 (S6). Pure normalisation -- no database. Mirrors how
// resolveAbility/resolveAbilities would be pinned if they had their own file;
// these are the one place power_scale's scaling math lives, so it is worth
// testing directly rather than only through a live tick.
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSkill, resolveSkills } = require('../src/services/creatureSkills');

function row(over = {}) {
  return {
    slot: 1, skill_id: 7, name: 'Ground Slam', kind: 'slam',
    telegraph_ms: 800, cooldown_ms: 6000, radius: 100, range: 150,
    damage_mult: 1.5, element: null, summon_entity: null, summon_count: 1,
    vfx: null, power_scale: 1,
    ...over,
  };
}

test('resolveSkill at power_scale 1 passes radius/damage_mult/summon_count through unscaled', () => {
  const s = resolveSkill(row());
  assert.equal(s.radius, 100);
  assert.equal(s.damageMult, 1.5);
  assert.equal(s.summonCount, 1);
  assert.equal(s.range, 150); // range is NEVER scaled (spec §3.4: radius, damage_mult, summon_count only)
  assert.equal(s.telegraphMs, 800);
  assert.equal(s.cooldownMs, 6000);
  assert.equal(s.id, 7);
  assert.equal(s.name, 'Ground Slam');
  assert.equal(s.kind, 'slam');
});

test('power_scale multiplies radius and damage_mult', () => {
  const s = resolveSkill(row({ power_scale: 0.5 }));
  assert.equal(s.radius, 50);
  assert.equal(s.damageMult, 0.75);
});

test('summon_count scales, rounds, and never drops below 1 even at the floor of the slider', () => {
  assert.equal(resolveSkill(row({ kind: 'summon', summon_count: 4, power_scale: 1.5 })).summonCount, 6);
  assert.equal(resolveSkill(row({ kind: 'summon', summon_count: 3, power_scale: 0.4 })).summonCount, 1); // round(1.2) = 1
  assert.equal(resolveSkill(row({ kind: 'summon', summon_count: 2, power_scale: 0.1 })).summonCount, 1); // round(0.2) = 0 -> floored to 1
});

test('element null means inherit the caster element; an unrecognised value is dropped to null too', () => {
  assert.equal(resolveSkill(row({ element: null })).element, null);
  assert.equal(resolveSkill(row({ element: 'fire' })).element, 'fire');
  assert.equal(resolveSkill(row({ element: 'not-a-real-element' })).element, null);
});

test('an unrecognised kind falls back to slam rather than crashing selection later', () => {
  assert.equal(resolveSkill(row({ kind: 'not-a-kind' })).kind, 'slam');
});

test('a missing/malformed name falls back to a generic label, never undefined', () => {
  assert.equal(resolveSkill(row({ name: null })).name, 'Skill');
  assert.equal(resolveSkill(row({ name: '' })).name, 'Skill');
});

test('summon_entity passes through only when it is a real non-empty string', () => {
  assert.equal(resolveSkill(row({ summon_entity: 'Fire Elemental Guard' })).summonEntity, 'Fire Elemental Guard');
  assert.equal(resolveSkill(row({ summon_entity: null })).summonEntity, null);
  assert.equal(resolveSkill(row({ summon_entity: '' })).summonEntity, null);
});

test('vfx passes through only as a real object, not a string or null', () => {
  assert.deepEqual(resolveSkill(row({ vfx: { telegraph: 'x', cast: 'y', impact: 'z' } })).vfx,
    { telegraph: 'x', cast: 'y', impact: 'z' });
  assert.equal(resolveSkill(row({ vfx: null })).vfx, null);
});

test('resolveSkills sorts by slot regardless of input order, and empty/missing -> []', () => {
  const out = resolveSkills([row({ slot: 3, name: 'C' }), row({ slot: 1, name: 'A' }), row({ slot: 2, name: 'B' })]);
  assert.deepEqual(out.map((s) => s.name), ['A', 'B', 'C']);
  assert.deepEqual(resolveSkills([]), []);
  assert.deepEqual(resolveSkills(null), []);
  assert.deepEqual(resolveSkills(undefined), []);
});

test('malformed numeric fields fall back rather than producing NaN', () => {
  const s = resolveSkill(row({ cooldown_ms: 'not-a-number', telegraph_ms: null, radius: undefined }));
  assert.equal(Number.isFinite(s.cooldownMs), true);
  assert.equal(s.telegraphMs, 0);
  assert.equal(s.radius, 0);
});
