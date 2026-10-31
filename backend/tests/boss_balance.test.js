const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const bal = require('../src/services/bossBalance.js');
const { applyDamage } = require('../src/authority/damage.js');
const { WorldBossManager } = require('../src/authority/worldBoss.js');

const ELEMENTS = ['physical', 'fire', 'ice', 'lightning', 'arcane'];

test('top-end gear needs at least five minutes, whatever element it uses', () => {
  for (const [name, boss] of Object.entries(bal.WORLD_BOSSES)) {
    for (const el of ELEMENTS) {
      const s = bal.expectedFightSeconds(boss, el);
      assert.ok(s >= bal.MIN_FIGHT_SECONDS, `${name} dies in ${s.toFixed(0)}s to ${el}`);
    }
  }
});

test('every boss keeps one weak element, and none is immune', () => {
  for (const [name, boss] of Object.entries(bal.WORLD_BOSSES)) {
    const values = ELEMENTS.map((e) => boss.resistances[e] ?? 0);
    assert.ok(values.some((v) => v === 0), `${name} has no weak element`);
    assert.ok(values.every((v) => v <= 0.8), `${name} exceeds the engine resistance cap`);
  }
});

test('the shipped seed data matches the tuning table', () => {
  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, '../seeds/sync/entities.json'), 'utf8'));
  const found = {};
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      if (n.boss_tier === 'world' && n.name) found[n.name] = n;
      Object.values(n).forEach(walk);
    }
  };
  walk(rows);
  for (const [name, t] of Object.entries(bal.WORLD_BOSSES)) {
    const row = found[name];
    assert.ok(row, `${name} missing from entities.json`);
    assert.strictEqual(row.max_hp, t.hp);
    assert.strictEqual(row.defense, t.defense);
    assert.strictEqual(row.base_damage, t.baseDamage);
    assert.deepStrictEqual(row.resistances, t.resistances);
  }
});

test('a shield soaks damage before HP, spills over, and is still credited to the attacker', () => {
  const boss = { hp: 1000, shield: 300 };
  applyDamage(boss, 200, 'physical', { defense: 0, resistances: {} }, 0, 'p:7');
  assert.strictEqual(boss.shield, 100);
  assert.strictEqual(boss.hp, 1000);
  applyDamage(boss, 250, 'physical', { defense: 0, resistances: {} }, 0, 'p:7');
  assert.strictEqual(boss.shield, 0);
  assert.strictEqual(boss.hp, 850, '150 spilled through');
  assert.strictEqual(boss._playerDamage.get('7'), 450);
});

test('creatures without a shield are untouched by the shield rule', () => {
  const c = { hp: 100 };
  applyDamage(c, 30, 'physical', { defense: 0, resistances: {} }, 0, null);
  assert.strictEqual(c.hp, 70);
  assert.strictEqual(c.shield, undefined);
});

function manager(boss) {
  const m = Object.create(WorldBossManager.prototype);
  m.currentBoss = { maxHp: boss.maxHp, phase: 2, lastWardAt: 0, ...boss.state };
  return m;
}

test('a phase shield is a share of max HP and never exceeds the cap', () => {
  const m = manager({ maxHp: 1000000 });
  const c = { maxHp: 1000000 };
  m._addShield(c, bal.PHASE_SHIELD[2]);
  assert.strictEqual(c.shield, 40000);
  m._addShield(c, 0.5);
  assert.strictEqual(c.shield, 1000000 * bal.SHIELD_CAP_FRACTION);
});

test('the ward refills the shield on a timer, only from phase 2', () => {
  const m = manager({ maxHp: 1000000 });
  const c = { maxHp: 1000000, shield: 0 };
  m._tickWard(c, bal.WARD_INTERVAL_MS - 1);
  assert.strictEqual(c.shield, 0, 'too early');
  m._tickWard(c, bal.WARD_INTERVAL_MS);
  assert.strictEqual(c.shield, 1000000 * bal.WARD_FRACTION);
  m._tickWard(c, bal.WARD_INTERVAL_MS + 1000);
  assert.strictEqual(c.shield, 1000000 * bal.WARD_FRACTION, 'not again until the next interval');

  const p1 = manager({ maxHp: 1000000, state: { phase: 1 } });
  const c1 = { maxHp: 1000000, shield: 0 };
  p1._tickWard(c1, bal.WARD_INTERVAL_MS * 5);
  assert.strictEqual(c1.shield, 0, 'no ward in phase 1');
});

test('post bosses get phase shields and the ward from the same rules and numbers', () => {
  const state = { phase: 1, lastWardAt: null };
  const c = { hp: 1000000, maxHp: 1000000 };
  assert.deepStrictEqual(bal.enduranceStep(state, c, 0), { phase: 1, phaseChanged: false, warded: false });
  assert.strictEqual(c.shield, undefined);
  c.hp = 700000; // below 75%
  const r = bal.enduranceStep(state, c, 1000);
  assert.strictEqual(r.phaseChanged, true);
  assert.strictEqual(c.shield, 1000000 * bal.PHASE_SHIELD[2]);
  assert.strictEqual(bal.enduranceStep(state, c, 1000 + bal.WARD_INTERVAL_MS - 1).warded, false);
  const w = bal.enduranceStep(state, c, 1000 + bal.WARD_INTERVAL_MS);
  assert.strictEqual(w.warded, true);
  assert.strictEqual(c.shield, 1000000 * (bal.PHASE_SHIELD[2] + bal.WARD_FRACTION));
});

test('the Floor 60 gate speaks of the World Boss; other gates keep the plain wording', () => {
  const g = require('../src/services/bossGate.js');
  const f60 = { name: 'Spire of Trials: Floor 60', dungeon_boss: {} };
  const f5 = { name: 'Spire of Trials: Floor 5', dungeon_boss: {} };
  assert.match(g.sealedMessage(f60), /World Boss.*Floor 61/);
  assert.match(g.openedMessage(f60), /passage to Floor 61/);
  assert.match(g.sealedMessage(f5), /floor boss/);
});

test('a Spire floor may post a world boss; no other map may', () => {
  const { validateMapSpec } = require('../seeds/mapSpec.js');
  const mk = (name) => ({
    name: 't', topology: 'x',
    worlds: [{ key: 'a', name, grid: [0, 0], seed: 1, width: 96, height: 96, chunk_size: 32, biomes: ['Meadow'], biome_cell: 16, is_entry: true, level_band: [1, 5], density: 'sparse', boss: { entity: 'Ignis, the Magma Colossus', x: 4950, y: 4850, respawn_s: 600 } }],
    links: [],
  });
  const tiers = new Map([['Ignis, the Magma Colossus', 'world']]);
  const spire = (validateMapSpec(mk('Spire of Trials: Floor 60'), { bossTiers: tiers }) || []).filter((e) => /not a dungeon boss/.test(e));
  const other = (validateMapSpec(mk('Some Other Place'), { bossTiers: tiers }) || []).filter((e) => /not a dungeon boss/.test(e));
  assert.strictEqual(spire.length, 0);
  assert.strictEqual(other.length, 1);
});
