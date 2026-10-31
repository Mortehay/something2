// The mechanics the last 24 buffs needed: stun, crits, dodge, reflect, stealth,
// traps, auras, revival, bigger max HP, standing-still ramp, attack stacks.
const test = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('../src/authority/world.js');
const { applyDamage, applyDamageWithEffects } = require('../src/authority/damage.js');
const balance = require('../src/authority/skillBalance.js');
const { getSkillById } = require('../seeds/data/skills.js');
const {
  applyStun, applyHitStatuses, isStunned, canAct, applyEffect, CHILL, BURN,
} = require('../src/authority/effects.js');

function makeWorld() {
  const map = { isWalkable: () => true, width: 2000, height: 2000, decorations: [] };
  const sword = { id: 'item_sword', name: 'sword', category: 'weapon', kind: 'melee' };
  return new World(map, new Map([[sword.id, sword]]), sword.id);
}

function addPlayer(world, userId = 'u1') {
  const stats = {
    meleeMult: 1, spellMult: 1, level: 100,
    strength: 100, dexterity: 100, constitution: 100, intelligence: 100, wisdom: 100, charisma: 100,
    damageMult: { physical: 1, arcane: 1, fire: 1, ice: 1, lightning: 1, shadow: 1, holy: 1 },
    resists: {}, rules: {}, sources: {},
  };
  world.addPlayer(userId, { x: 100, y: 100 }, { items: [], equipment: {} }, { x: 100, y: 100 }, 0, stats);
  const p = world.getPlayer(userId);
  p.maxHp = 1000; p.hp = 1000; p.maxMana = 200; p.mana = 200; p.stamina = 100; p.maxStamina = 100;
  return p;
}

function creature(world, id, x, y, hp = 500) {
  world.creatures.creatures.set(id, {
    id, name: 'Troll', x, y, width: 48, height: 48, hp, maxHp: hp, effects: new Map(), mit: { defense: 0, resists: {} },
  });
  return world.creatures.get(id);
}

test.afterEach(() => balance.setRng());

test('every buff skill has an entry in the BUFFS table', () => {
  const { SKILLS } = require('../seeds/data/skills.js');
  const buffs = SKILLS.filter((s) => s.type === 'buff');
  assert.ok(buffs.length > 60);
  assert.deepEqual(buffs.filter((s) => !balance.BUFFS[s.id]).map((s) => s.id), []);
});

test('a stun freezes the target, cannot be chained, and bosses shrug it off', () => {
  const c = { effects: new Map() };
  assert.equal(applyStun(c, 1000, 0), true);
  assert.equal(isStunned(c, 500), true);
  assert.equal(canAct(c, 500), false);
  assert.equal(isStunned(c, 1500), false);
  assert.equal(applyStun(c, 1000, 1500), false, 'inside the immunity window');
  assert.equal(applyStun({ effects: new Map(), damageTakenMult: 0.6 }, 1000, 0), false, 'world boss');
});

test('a mace hit may stun; the family comes from the item name', () => {
  assert.deepEqual(balance.weaponTraits({ name: 'iron-mace' }), { stun: { chance: 0.2, ms: 1000 } });
  assert.equal(balance.weaponTraits({ name: 'bow' }), null, 'a bare fixture name has no family');
  const statuses = balance.weaponHitStatuses({ name: 'iron-mace' }, ['burn']);
  assert.equal(statuses[0], 'burn');
  const hit = { effects: new Map() };
  balance.setRng(() => 0);
  applyHitStatuses(hit, statuses, 100, 'u1');
  assert.equal(isStunned(hit, 200), true);
  const miss = { effects: new Map() };
  balance.setRng(() => 0.99);
  applyHitStatuses(miss, statuses, 100, 'u1');
  assert.equal(isStunned(miss, 200), false);
});

test('Iron Will makes a player immune to stun and slows', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  w.castSkill('u1', 'war_iron_will', 100, 100, 0, 1);
  assert.equal(applyStun(p, 1000, w.now), false);
  applyEffect(p, CHILL, { durationMs: 3000, magnitude: 0.6, sourceId: null, now: w.now });
  assert.equal(p.effects.has(CHILL), false);
});

test('Dark Blessing blocks burning', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  w.castSkill('u1', 'cul_dark_blessing', 100, 100, 0, 1);
  applyEffect(p, BURN, { durationMs: 3000, magnitude: 2, sourceId: null, now: w.now });
  assert.equal(p.effects.has(BURN), false);
});

test('a dagger crits; Duelist Focus raises the crit damage', () => {
  const p = { buffs: new Map(), _buffMods: null };
  balance.setRng(() => 0);
  assert.equal(balance.rollCrit(p, { weapon: { name: 'iron-dagger' } }), 1.5);
  balance.setRng(() => 0.99);
  assert.equal(balance.rollCrit(p, { weapon: { name: 'iron-dagger' } }), 1);
  assert.equal(balance.rollCrit(p, { weapon: { name: 'iron-sword' } }), 1);
  const w = makeWorld();
  const q = addPlayer(w, 'u2');
  w.castSkill('u2', 'war_duelist_focus', 100, 100, 0, 1);
  balance.setRng(() => 0);
  assert.equal(balance.rollCrit(q, {}), 2);
});

test('Elemental Focus: the next three spells always crit, then it is gone', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  w.castSkill('u1', 'mag_elemental_focus', 100, 100, 0, 1);
  balance.setRng(() => 0.99);
  for (let i = 0; i < 3; i++) assert.equal(balance.rollCrit(p, { spell: true }), 1.5);
  assert.equal(balance.rollCrit(p, { spell: true }), 1);
  assert.equal(p.buffs.has('mag_elemental_focus'), false);
});

test('Drunken Brawler dodges and counters', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  w.castSkill('u1', 'mnk_drunken_brawler_stance', 100, 100, 0, 1);
  balance.setRng(() => 0);
  applyDamage(p, 100, 'physical', {}, w.now, 'c:troll');
  assert.equal(p.hp, 1000, 'dodged');
  assert.deepEqual(p._pendingReflect, [{ source: 'c:troll', amount: 12, element: 'physical' }]);
});

test('Karma Redirection sends half of a hit back at the attacker', () => {
  const w = makeWorld();
  const q = addPlayer(w, 'u2');
  w.castSkill('u2', 'mnk_karma_redirection', 100, 100, 0, 1);
  const troll = creature(w, 'troll', 130, 100, 500);
  applyDamage(q, 100, 'physical', {}, w.now, 'c:troll');
  assert.equal(q.hp, 900, 'the hit still lands in full');
  w._tickBuffEffects(0.05);
  assert.equal(troll.hp, 450);
});

test('Thorns only reflects physical hits', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  w.castSkill('u1', 'dru_thorns_aura', 100, 100, 0, 1);
  applyDamage(p, 100, 'fire', {}, w.now, 'c:troll');
  assert.equal(p._pendingReflect, undefined);
  applyDamage(p, 100, 'physical', {}, w.now, 'c:troll');
  assert.equal(p._pendingReflect[0].amount, 20);
});

test('Camouflage: stealth until the first attack, which crits', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  w.castSkill('u1', 'arc_camouflage', 100, 100, 0, 1);
  assert.equal(p._stealthed, true);
  balance.setRng(() => 0.99);
  assert.equal(balance.rollCrit(p, {}), 1.5);
  assert.equal(p._stealthed, false);
  assert.equal(p.buffs.has('arc_camouflage'), false);
});

test('a stealthed player is not acquired by a distant creature', () => {
  const src = require('fs').readFileSync(require.resolve('../src/authority/creatures.js'), 'utf8');
  assert.match(src, /p\._stealthed && d2 > STEALTH_NOTICE \* STEALTH_NOTICE/);
});

test('Blood Rebirth brings you back once with 40% HP', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  w.castSkill('u1', 'cul_blood_rebirth', 100, 100, 0, 1);
  p.hp = 0;
  assert.deepEqual(w.resolveDeaths(), []);
  assert.equal(p.hp, 400);
  assert.equal(p.buffs.has('cul_blood_rebirth'), false);
  p.hp = 0;
  assert.deepEqual(w.resolveDeaths(), ['u1'], 'the second death is real');
});

test('Colossus Stance raises max HP and gives it back; a respec in between keeps the bonus', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  w.castSkill('u1', 'war_colossus_stance', 100, 100, 0, 1);
  assert.equal(p.maxHp, 1300);
  assert.equal(p._buffMods.reach, 1.25);
  w.applyDerivedStats('u1', { ...p.stats, maxHp: 1000, maxMana: p.maxMana, maxStamina: p.maxStamina });
  assert.equal(p.maxHp, 1300, 'derived stats keep the buffed pool');
  w.now += 16000;
  w.tick(0.05);
  assert.equal(p.maxHp, 1000);
  assert.ok(p.hp <= 1000);
});

test('Bear Form adds HP and Wolf swaps it; casting your own shape leaves it', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  w.castSkill('u1', 'dru_bear_form', 100, 100, 0, 1);
  assert.equal(p.maxHp, 1600);
  w.now += 3000;
  w.castSkill('u1', 'dru_wolf_form', 100, 100, 0, 1);
  assert.equal(p.maxHp, 1000, 'bear left');
  assert.equal(p.buffs.has('dru_bear_form'), false);
  assert.equal(p.buffs.has('dru_wolf_form'), true);
  w.now += 3000;
  w.castSkill('u1', 'dru_wolf_form', 100, 100, 0, 1);
  assert.equal(p.buffs.has('dru_wolf_form'), false);
});

test('Primal Metamorphosis only boosts you while you wear a shape', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  w.castSkill('u1', 'dru_primal_metamorphosis', 100, 100, 0, 1);
  assert.equal(p.buffs.has('dru_primal_metamorphosis'), false);
  w.castSkill('u1', 'dru_hawk_form', 100, 100, 0, 1);
  w.now += 20000;
  w.castSkill('u1', 'dru_primal_metamorphosis', 100, 100, 0, 1);
  assert.equal(p.buffs.has('dru_primal_metamorphosis'), true);
});

test('Sniper Stance ramps damage while you stand still and resets when you move', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  balance.castBuff(p, getSkillById('arc_sniper_stance'), w.now);
  for (let i = 0; i < 7; i++) { w.now += 1000; balance.tickBuffs(p, 1000, w.now); }
  assert.ok(Math.abs(p._buffMods.dealt - 1.5) < 1e-9, 'capped at +50%');
  p.x += 10;
  w.now += 1000;
  balance.tickBuffs(p, 1000, w.now);
  assert.equal(p._buffMods.dealt, 1);
});

test('Bloodlust Stance stacks attack speed per action and drops after idling', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  w.castSkill('u1', 'war_bloodlust_stance', 100, 100, 0, 1);
  for (let i = 0; i < 12; i++) balance.noteAction(p, w.now);
  assert.ok(Math.abs(p._buffMods.atk - 1.3) < 1e-9, 'ten stacks at +3%');
  w.now += 5000;
  balance.tickBuffs(p, 50, w.now);
  assert.equal(p._buffMods.atk, 1);
});

test('Natures Swiftness doubles the next spell once', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  w.castSkill('u1', 'dru_natures_swiftness', 100, 100, 0, 1);
  assert.equal(balance.takeSpellMult(p), 2);
  assert.equal(balance.takeSpellMult(p), 1);
});

test('Immolation Aura burns what stands near you each second', () => {
  const w = makeWorld();
  addPlayer(w);
  const near = creature(w, 'near', 130, 100, 500);
  const far = creature(w, 'far', 900, 900, 500);
  w.castSkill('u1', 'mag_immolation_aura', 100, 100, 0, 1);
  w._tickBuffEffects(1);
  assert.ok(near.hp < 500);
  assert.equal(far.hp, 500);
});

test('a Bear Trap stuns and hurts the first creature to step on it; the trap is spent', () => {
  const w = makeWorld();
  addPlayer(w);
  const prey = creature(w, 'prey', 300, 300, 500);
  w.castSkill('u1', 'arc_bear_trap', 312, 312, 1, 0);
  assert.equal(w.traps.length, 1);
  w._tickTraps();
  assert.equal(w.traps.length, 0);
  assert.equal(isStunned(prey, w.now + 10), true);
  assert.ok(prey.hp < 500);
});

test('an Explosive Trap blasts everything near it; a Tar Trap slows without damage', () => {
  const w = makeWorld();
  addPlayer(w);
  const a = creature(w, 'a', 300, 300, 500);
  const b = creature(w, 'b', 360, 300, 500);
  w.castSkill('u1', 'arc_explosive_trap', 324, 324, 1, 0);
  w._tickTraps();
  assert.ok(a.hp < 500 && b.hp < 500);

  const w2 = makeWorld();
  addPlayer(w2);
  const c = creature(w2, 'c', 300, 300, 500);
  w2.castSkill('u1', 'arc_tar_trap', 324, 324, 1, 0);
  w2._tickTraps();
  assert.equal(c.hp, 500);
  assert.equal(w2.traps.length, 1, 'tar stays down until it dries');
  assert.ok(c.effects.has('chill'));
});

test('Hunters Instinct marks creatures so they take 15% more damage', () => {
  const w = makeWorld();
  addPlayer(w);
  const near = creature(w, 'near', 200, 100, 500);
  const far = creature(w, 'far', 1500, 1500, 500);
  w.castSkill('u1', 'arc_hunters_instinct', 100, 100, 0, 1);
  assert.ok(near.effects.has('marked'));
  assert.equal(far.effects.has('marked'), false);
  applyDamageWithEffects(near, 100, 'physical', { defense: 0, resists: {} }, w.now, 'p:u1');
  assert.equal(near.hp, 385);
});

test('Life Transfusion pays 20% of your life to fully heal the nearest ally', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  const ally = addPlayer(w, 'u2');
  ally.x = 150; ally.y = 100;
  ally.maxHp = 400; ally.hp = 10;
  w.castSkill('u1', 'cul_life_transfusion', 100, 100, 0, 1);
  assert.equal(ally.hp, 400);
  assert.equal(p.hp, 1000 - 50 - 200, 'the skill cost 50 life plus the 20% transfused');
});

test('a stunned player cannot move', () => {
  const w = makeWorld();
  const p = addPlayer(w);
  applyStun(p, 1000, w.now);
  p.pendingInputs = [{ dx: 1, dy: 0, dt: 0.05, seq: 7 }];
  const x = p.x;
  w.tick(0.05);
  assert.equal(p.x, x);
  assert.equal(p.ackSeq, 7);
});
