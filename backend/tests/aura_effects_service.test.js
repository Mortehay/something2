// backend/tests/aura_effects_service.test.js
const test = require('node:test');
const assert = require('node:assert');
const {
  AURA_SIDES, AURA_SHAPES, auraEffectError, resolveAuraDef, resolveInstanceAuras,
  __resetAuraWarnings, AURAS_LATERAL,
} = require('../src/services/auraEffects.js');

const VALID = { name: 'pack_leader', target_side: 'allies', radius: 260, damage_mult: 1.25,
  defense_mult: 1.2, speed_mult: 1.1, dot_dps: 0, dot_element: 'physical', tick_ms: 1000,
  shape: 'ring', color: '#d4a017', pulse_ms: 1200, particle_count: 0, particle_lifetime_ms: 300, particle_size: 2 };

test('vocabulary matches the migration CHECKs, written literally', () => {
  assert.deepStrictEqual(AURA_SIDES, ['allies', 'enemies']);
  assert.deepStrictEqual(AURA_SHAPES, ['ring', 'disc', 'particles']);
});

test('a valid body passes (so every rejection below is meaningful)', () => {
  assert.strictEqual(auraEffectError(VALID), null);
});

for (const [field, value, re] of [
  ['name', '  ', /name is required/],
  ['radius', 0, /radius must be greater than 0 and at most 2000/],
  ['radius', -1, /radius/],
  ['radius', 26000, /radius/],
  ['radius', '260px', /radius/],
  ['damage_mult', 0, /damage_mult must be greater than 0/],
  ['speed_mult', -0.5, /speed_mult/],
  ['tick_ms', 50, /tick_ms must be a whole number between 100 and 5000/],
  ['tick_ms', 250.5, /tick_ms/],
  ['target_side', 'neutral', /target_side must be one of allies, enemies/],
  ['shape', 'cone', /shape must be one of ring, disc, particles/],
  ['color', 'gold', /color must be a #rrggbb hex colour/],
  ['particle_count', 65, /particle_count must be a whole number between 0 and 64/],
  ['pulse_ms', -1, /pulse_ms/],
  ['dot_dps', -2, /dot_dps must be 0 or greater/],
]) {
  test(`rejects ${field}=${JSON.stringify(value)}`, () => {
    assert.match(auraEffectError({ ...VALID, [field]: value }) || '', re);
  });
}

test('an allies aura may not carry a DoT', () => {
  assert.match(auraEffectError({ ...VALID, dot_dps: 3 }), /only an enemies aura can deal damage over time/);
  assert.strictEqual(auraEffectError({ ...VALID, target_side: 'enemies', dot_dps: 3 }), null);
});

test('resolveAuraDef maps a json_build_object row to camelCase', () => {
  assert.deepStrictEqual(resolveAuraDef({ name: 'pack_leader', target_side: 'allies', radius: 260,
    damage_mult: 1.25, defense_mult: 1.2, speed_mult: 1.1, dot_dps: 0, dot_element: 'physical', tick_ms: 1000 }),
  { name: 'pack_leader', targetSide: 'allies', radius: 260, damageMult: 1.25, defenseMult: 1.2,
    speedMult: 1.1, dotDps: 0, dotElement: 'physical', tickMs: 1000 });
});

test('resolveAuraDef drops a row that would be inert or poisonous', () => {
  assert.strictEqual(resolveAuraDef({ name: 'x', target_side: 'allies', radius: 0 }), null);
  assert.strictEqual(resolveAuraDef({ name: 'x', target_side: 'sideways', radius: 10 }), null);
  // NULL multiplier must NOT become Number(null) = 0 (a follower that deals nothing).
  assert.strictEqual(resolveAuraDef({ name: 'x', target_side: 'allies', radius: 10, damage_mult: null }).damageMult, 1);
});

test('loader row: unknown bound name is skipped and logged ONCE per name', () => {
  __resetAuraWarnings();
  const logs = [];
  const warn = (m) => logs.push(m);
  const row = { type: 'Beast Champion', aura_names: ['pack_leader', 'ghost_aura'],
    aura_defs: [{ name: 'pack_leader', target_side: 'allies', radius: 260, damage_mult: 1.25,
      defense_mult: 1.2, speed_mult: 1.1 }] };
  const a = resolveInstanceAuras(row, warn);
  resolveInstanceAuras({ ...row, type: 'Cave Champion' }, warn);
  assert.deepStrictEqual(a.map((d) => d.name), ['pack_leader']);
  assert.strictEqual(logs.length, 1, 'one log line per unknown name, not one per creature');
  assert.match(logs[0], /ghost_aura/);
});

test('NULL and [] both resolve to no auras, without logging', () => {
  __resetAuraWarnings();
  const logs = [];
  assert.deepStrictEqual(resolveInstanceAuras({ aura_names: null, aura_defs: [] }, (m) => logs.push(m)), []);
  assert.deepStrictEqual(resolveInstanceAuras({ aura_names: [], aura_defs: [] }, (m) => logs.push(m)), []);
  assert.deepStrictEqual(resolveInstanceAuras({}, (m) => logs.push(m)), []);
  assert.strictEqual(logs.length, 0);
});

test('an already-resolved fixture array is copied, not shared', () => {
  const src = [{ name: 'a', targetSide: 'allies', radius: 10, damageMult: 2, defenseMult: 1, speedMult: 1 }];
  const out = resolveInstanceAuras({ auras: src });
  assert.notStrictEqual(out[0], src[0]);
  assert.strictEqual(out[0].damageMult, 2);
});

// A parallel branch (S1) may store bare aura NAMES in an instance's `auras`
// (entity_types.auras is a jsonb array of strings). Without a loader row
// (aura_defs) there is nothing to resolve them against, so they must be inert:
// skipped, never spread into a half-built def with radius undefined.
test('string entries in an already-resolved auras array are ignored, not half-resolved', () => {
  assert.deepStrictEqual(resolveInstanceAuras({ auras: ['pack_leader', 'war_drum'] }), []);
  const mixed = resolveInstanceAuras({ auras: ['pack_leader',
    { name: 'a', targetSide: 'allies', radius: 10, damageMult: 2, defenseMult: 1, speedMult: 1 }] });
  assert.strictEqual(mixed.length, 1);
  assert.strictEqual(mixed[0].name, 'a');
});

test('AURAS_LATERAL resolves names through the jsonb ? operator and orders by name', () => {
  assert.match(AURAS_LATERAL, /LEFT JOIN LATERAL/);
  assert.match(AURAS_LATERAL, /FROM aura_effects ae/);
  assert.match(AURAS_LATERAL, /et\.auras \? ae\.name/);
  assert.match(AURAS_LATERAL, /ORDER BY ae\.name/);
  assert.match(AURAS_LATERAL, /AS aura_defs/);
});
