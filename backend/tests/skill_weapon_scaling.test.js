const test = require('node:test');
const assert = require('node:assert');
const sb = require('../src/authority/skillBalance.js');

const SKILL = { id: 'x_test', type: 'melee', reqLvl: 1, cooldown: 1 }; // baseDamageOf -> 6

test('total = skill base + weapon damage x scaling (the 10 + 50 x 10% = 15 example)', () => {
  const skill = { ...SKILL, id: 'arc_barrage' }; // multi-hit, base 4 per hit
  assert.strictEqual(sb.skillHitDamage(skill, 0).base, 4);
  const plain = sb.baseDamageOf(SKILL).base;
  const r = sb.skillHitDamage({ ...SKILL, weaponScaling: 0.1 }, 50);
  assert.strictEqual(r.base, plain + 5);
  assert.strictEqual(r.bonus, 5);
});

test('a multi-hit skill spreads the weapon share across its hits', () => {
  const barrage = { ...SKILL, id: 'arc_barrage', weaponScaling: 0.1 }; // 4 x 5 hits
  const r = sb.skillHitDamage(barrage, 100);
  assert.strictEqual(r.hits, 5);
  assert.strictEqual(r.bonus, 10);
  assert.ok(Math.abs(r.base * r.hits - (4 * 5 + 10)) < 1e-9, 'the whole cast gets the bonus once');
});

test('no weapon (or damage 0 / junk) adds nothing', () => {
  const plain = sb.baseDamageOf(SKILL).base;
  for (const w of [0, null, undefined, -5, NaN, 'abc']) assert.strictEqual(sb.skillHitDamage(SKILL, w).base, plain);
});

test('scaling depends on the skill type, with an optional per-skill override', () => {
  assert.strictEqual(sb.DEFAULT_WEAPON_SCALING, 0.1);
  assert.strictEqual(sb.weaponScalingOf({ type: 'melee' }), 0.15);
  assert.strictEqual(sb.weaponScalingOf({ type: 'magic' }), 0.1);
  assert.strictEqual(sb.weaponScalingOf({ type: 'debuff' }), 0.05);
  assert.strictEqual(sb.weaponScalingOf({ type: 'whatever' }), 0.1);
  assert.strictEqual(sb.weaponScalingOf({ weaponScaling: 0.25 }), 0.25);
  assert.strictEqual(sb.weaponScalingOf({ weaponScaling: 0 }), 0);
  assert.strictEqual(sb.weaponScalingOf({ weaponScaling: -1, type: 'magic' }), 0.1);
  assert.strictEqual(sb.skillHitDamage({ ...SKILL, weaponScaling: 0 }, 80).bonus, 0);
});

test('hit counts are unchanged by the weapon', () => {
  assert.strictEqual(sb.skillHitDamage({ ...SKILL, id: 'arc_barrage' }, 100).hits, 5);
});

// --- through World.castSkill: the weapon is read at cast time ----------------
const { World } = require('../src/authority/world.js');

function setup(weaponDamage, equipped) {
  const map = { isWalkable: () => true, width: 2000, height: 2000, decorations: [] };
  const sword = { id: 7, name: 'sword', category: 'weapon', kind: 'melee', damage: weaponDamage, cooldown: 0.5, reach: 90 };
  const world = new World(map, new Map([[7, sword]]), 7);
  const stats = {
    meleeMult: 1, spellMult: 1, level: 100, strength: 100, dexterity: 100, constitution: 100,
    intelligence: 100, wisdom: 100, charisma: 100,
    damageMult: { physical: 1, arcane: 1, fire: 1, ice: 1, lightning: 1, shadow: 1, holy: 1 },
    resists: {}, rules: {},
    sources: {},
  };
  const inv = equipped ? { items: [{ id: 'w1', typeId: 7 }], equipment: { main_hand: 'w1' } } : { items: [], equipment: {} };
  world.addPlayer('u', { x: 100, y: 100 }, inv, { x: 100, y: 100 }, 0, stats);
  const player = world.getPlayer('u');
  player.stamina = 100; player.mana = 100; player.maxMana = 100;
  world.creatures.creatures.set('c', {
    id: 'c', name: 'Goblin', x: 140, y: 100, width: 48, height: 48, hp: 100000, maxHp: 100000,
    effects: new Map(), mit: { defense: 0, resists: {} },
  });
  return { world, player };
}

function hit(weaponDamage, equipped) {
  const { world } = setup(weaponDamage, equipped);
  const res = world.castSkill('u', 'war_crushing_blow', 140, 100, 1, 0);
  assert.strictEqual(res.ok, true);
  return 100000 - world.creatures.get('c').hp;
}

test('a stronger equipped weapon makes the same skill hit harder; no weapon adds nothing', () => {
  const bare = hit(0, false);
  const weak = hit(20, true);
  const strong = hit(400, true);
  assert.ok(bare > 0);
  assert.ok(weak >= bare, 'a weapon never reduces the hit');
  assert.ok(strong > weak, 'more weapon damage, more skill damage');
  // 400 * 10% = 40 extra before the shared multipliers.
  assert.ok(strong - bare >= 30, `expected a clear bonus, got ${strong - bare}`);
});

test('unequipping the weapon drops the bonus on the very next cast', () => {
  const { world, player } = setup(400, true);
  assert.strictEqual(world.castSkill('u', 'war_crushing_blow', 140, 100, 1, 0).ok, true);
  const first = 100000 - world.creatures.get('c').hp;
  player.inv.equipment.main_hand = null;
  player._skillReadyAt = new Map();
  world.creatures.get('c').hp = 100000;
  assert.strictEqual(world.castSkill('u', 'war_crushing_blow', 140, 100, 1, 0).ok, true);
  const second = 100000 - world.creatures.get('c').hp;
  assert.ok(second < first, `unarmed (${second}) should hit softer than armed (${first})`);
});
