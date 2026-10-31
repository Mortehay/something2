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

// The project's own element rules (authority_elements_invariants.test.js), checked
// here against the TABLE so a bad tuning fails before it reaches the database.
test('no boss resists arcane, and every resistance still shows on a catalog-level hit', () => {
  const CATALOG_HIT = 15; // the weakest elemental weapon in the catalog
  for (const [name, boss] of Object.entries(bal.WORLD_BOSSES)) {
    assert.ok(!(boss.resistances.arcane > 0), `${name} resists arcane`);
    for (const [el, v] of Object.entries(boss.resistances)) {
      if (!(v > 0)) continue;
      const raw = el === 'physical' ? 116 : CATALOG_HIT;
      const unresisted = Math.max(1, raw - boss.defense);
      const resisted = Math.max(1, (raw - boss.defense) * (1 - v));
      assert.ok(unresisted - resisted >= 1, `${name}'s ${el} resistance is invisible against defense ${boss.defense}`);
    }
  }
});

test('the hide cuts every hit that gets through, only on the creature that carries it', () => {
  const mit = { defense: 0, resistances: {} };
  const boss = { hp: 1000, damageTakenMult: bal.DAMAGE_TAKEN };
  applyDamage(boss, 100, 'physical', mit, 0, null);
  assert.strictEqual(boss.hp, 1000 - 100 * bal.DAMAGE_TAKEN);
  const plain = { hp: 1000 };
  applyDamage(plain, 100, 'physical', mit, 0, null);
  assert.strictEqual(plain.hp, 900);
  const odd = { hp: 1000, damageTakenMult: 5 }; // a multiplier above 1 is ignored, never a heal-or-amplify hole
  applyDamage(odd, 100, 'physical', mit, 0, null);
  assert.strictEqual(odd.hp, 900);
});

// --- Element-locked shields and the second skills (item 9) ---------------------

test('a shield is brittle to the boss\'s weak element and tough against the rest', () => {
  assert.strictEqual(bal.shieldFactor('ice', 'ice'), bal.SHIELD_WEAK_MULT);
  assert.strictEqual(bal.shieldFactor('ice', 'fire'), bal.SHIELD_RESIST_MULT);
  assert.strictEqual(bal.shieldFactor(null, 'fire'), 1, 'an ordinary shield has no lock');
  assert.strictEqual(bal.shieldFactor(undefined, 'ice'), 1);
});

test('every world boss names a weak element, and it is one its body does not resist', () => {
  for (const [name, boss] of Object.entries(bal.WORLD_BOSSES)) {
    assert.ok(boss.shieldWeakTo, `${name} has no shieldWeakTo`);
    assert.ok(!(boss.resistances[boss.shieldWeakTo] > 0), `${name}'s shield is weak to an element its body resists`);
  }
  const weak = Object.values(bal.WORLD_BOSSES).map((b) => b.shieldWeakTo);
  assert.strictEqual(new Set(weak).size, weak.length, 'each boss wants a different element');
});

test('applyDamage breaks a locked shield 2x faster with its weak element, 2x slower with others', () => {
  const mit = { defense: 0, resistances: {} };
  const fresh = () => ({ hp: 1000, shield: 100, shieldWeakTo: 'ice' });
  const a = fresh(); applyDamage(a, 20, 'ice', mit, 0, null);
  assert.strictEqual(a.shield, 60, 'ice: 20 damage felt as 40');
  const b = fresh(); applyDamage(b, 20, 'fire', mit, 0, null);
  assert.strictEqual(b.shield, 90, 'fire: 20 damage felt as 10');
  assert.strictEqual(a.hp, 1000);
});

test('what a locked shield cannot absorb spills to HP in real, unscaled damage', () => {
  const mit = { defense: 0, resistances: {} };
  // 100 shield, weak element: it takes 50 real damage to break (felt x2). A 80 hit leaves 30 for HP.
  const c = { hp: 1000, shield: 100, shieldWeakTo: 'ice' };
  applyDamage(c, 80, 'ice', mit, 0, null);
  assert.strictEqual(c.shield, 0);
  assert.strictEqual(c.hp, 1000 - 30);
  // resisted element: 100 shield absorbs 200 real damage; a 250 hit spills 50.
  const d = { hp: 1000, shield: 100, shieldWeakTo: 'ice' };
  applyDamage(d, 250, 'fire', mit, 0, null);
  assert.strictEqual(d.shield, 0);
  assert.strictEqual(d.hp, 1000 - 50);
});

test('the four second skills are seeded and bound to the right bosses in slot 2', () => {
  const fs = require('fs'); const path = require('path');
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '../seeds/sync/attack_effects.json'), 'utf8')).tables.creature_skills;
  const bx = JSON.parse(fs.readFileSync(path.join(__dirname, '../seeds/sync/creature_behaviors.json'), 'utf8')).tables;
  const expected = { 'Cinder Brood': 'summon', 'Glacial Lance': 'projectile', 'Static Pulse': 'nova', 'Rift Collapse': 'slam' };
  for (const [name, kind] of Object.entries(expected)) {
    const s = fx.find((r) => r.name === name);
    assert.ok(s, `${name} is in the seed`);
    assert.strictEqual(s.kind, kind);
    const bound = bx.creature_behavior_skills.filter((r) => r.skill_id === s.sync_uuid);
    assert.strictEqual(bound.length, 1, `${name} is bound to exactly one boss`);
    assert.strictEqual(bound[0].slot, 2);
  }
  const brood = fx.find((r) => r.name === 'Cinder Brood');
  assert.ok(brood.summon_entity && brood.summon_count >= 2);
});
