// SOMET-606 Task 6B. No DB. The world-boss aura content lives twice on purpose:
// literals frozen in migration 1714440710000 (an existing DB) and
// seeds/data/auraEffects.js (a fresh one, via seed-catalogs). This pins them
// together, and pins every aura to the validator that guards the admin API.
const test = require('node:test');
const assert = require('node:assert');
const mig = require('../migrations/1714440710000_world_boss_enemy_auras.js');
const boss = require('../migrations/1714440671000_seed_world_boss_entities.js');
const { AURA_EFFECTS, WORLD_BOSS_DEFAULT_AURAS } = require('../seeds/data/auraEffects.js');
const { auraEffectError } = require('../src/services/auraEffects.js');

const FIELDS = ['name', 'target_side', 'radius', 'damage_mult', 'defense_mult', 'speed_mult',
  'dot_dps', 'dot_element', 'tick_ms', 'shape', 'color', 'pulse_ms'];
const DEFAULTS = { damage_mult: 1, defense_mult: 1, speed_mult: 1, dot_dps: 0, dot_element: 'physical',
  tick_ms: 1000, shape: 'ring', pulse_ms: 1200 };
const full = (a) => Object.fromEntries(FIELDS.map((f) => [f, a[f] ?? DEFAULTS[f]]));

test('the migration exports literals the seed data repeats field for field', () => {
  assert.strictEqual(mig.BOSS_AURAS.length, 4);
  const seeded = mig.BOSS_AURAS.map((m) => AURA_EFFECTS.find((a) => a.name === m.name));
  assert.ok(seeded.every(Boolean), 'every migration aura must be in AURA_EFFECTS');
  assert.deepStrictEqual(seeded.map(full), mig.BOSS_AURAS.map(full));
  assert.deepStrictEqual(WORLD_BOSS_DEFAULT_AURAS, mig.BOSS_AURA_BINDINGS);
});

test('every boss aura is an enemies aura that passes the admin validator', () => {
  for (const a of mig.BOSS_AURAS) {
    assert.strictEqual(a.target_side, 'enemies', a.name);
    assert.strictEqual(auraEffectError(a), null, a.name);
  }
});

test('the bindings name exactly the world bosses 1714440671000 creates, one aura each', () => {
  const bossNames = boss.BOSSES.map((b) => b.name);
  assert.strictEqual(bossNames.length, 4);
  assert.deepStrictEqual(Object.keys(mig.BOSS_AURA_BINDINGS).sort(), [...bossNames].sort());
  const bound = [];
  for (const [n, auras] of Object.entries(mig.BOSS_AURA_BINDINGS)) {
    assert.strictEqual(auras.length, 1, n);
    bound.push(...auras);
  }
  assert.deepStrictEqual([...bound].sort(), mig.BOSS_AURAS.map((a) => a.name).sort());
});

test('each aura debuffs on exactly one axis, and one of them burns', () => {
  for (const a of mig.BOSS_AURAS) {
    const axes = ['damage_mult', 'defense_mult', 'speed_mult'].filter((f) => a[f] !== 1 && a[f] != null);
    const burns = a.dot_dps > 0;
    assert.strictEqual(axes.length + (burns ? 1 : 0), 1, `${a.name} should do exactly one thing`);
  }
  assert.ok(mig.BOSS_AURAS.some((a) => a.dot_dps > 0), 'at least one boss aura burns');
});
