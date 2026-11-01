// Skill leveling prices by tier, and the per-kind haste share.
const test = require('node:test');
const assert = require('node:assert/strict');
const leveling = require('../src/services/skillLeveling.js');
const { upgradeSkill } = require('../src/authority/enchantOps.js');
const { skillCooldownMults } = require('../src/services/playerStats.js');
const C = require('../src/services/progressionConstants.js');
const { SKILLS } = require('../seeds/data/skills.js');

// ------------------------------------------------- stronger skills cost more to level
test('a stronger skill costs more at every level: the price curve scales by tier', () => {
  const m = leveling.SKILL_LEVELING_CONFIG.tierCostMultipliers;
  assert.deepEqual(Object.keys(m).map(Number), [1, 2, 3, 4, 5]);
  for (const tier of leveling.TIERS) {
    for (let n = 1; n <= 15; n += 1) {
      assert.equal(
        leveling.costForLevel(n, undefined, tier),
        Math.round(100 * m[tier] * 1.2 ** (n - 1)),
        `tier ${tier} level ${n}`,
      );
    }
  }
  for (let n = 1; n <= 15; n += 1) {
    for (let tier = 2; tier <= 5; tier += 1) {
      assert.ok(leveling.costForLevel(n, undefined, tier) > leveling.costForLevel(n, undefined, tier - 1), `level ${n} tier ${tier}`);
    }
  }
  assert.equal(leveling.costForLevel(1, undefined, 1), 100);
  assert.equal(leveling.costForLevel(1), 100, 'callers that predate tiers are unchanged');
  assert.equal(leveling.costForLevel(1, undefined, 99), 100);
  assert.equal(leveling.costForLevel(1, undefined, 'x'), 100);
});

test('the tier multipliers are configurable and validated', () => {
  const dear = leveling.buildSkillLevelingConfig({ tierCostMultipliers: { 5: 10 } });
  assert.equal(leveling.costForLevel(1, dear, 5), 1000);
  assert.equal(leveling.costForLevel(1, dear, 4), 350, 'the others keep their defaults');
  assert.throws(() => leveling.buildSkillLevelingConfig({ tierCostMultipliers: { 3: 0 } }), /tierCostMultipliers\[3\]/);
  assert.throws(() => leveling.buildSkillLevelingConfig({ tierCostMultipliers: { 2: 'big' } }), /tierCostMultipliers\[2\]/);
});

test('the public config carries one price table per tier, computed by the server', () => {
  const pub = leveling.publicSkillLevelingConfig();
  assert.deepEqual(Object.keys(pub.costsByTier).map(Number), [1, 2, 3, 4, 5]);
  for (const tier of leveling.TIERS) assert.deepEqual(pub.costsByTier[tier], leveling.costTable(undefined, tier));
  assert.deepEqual(pub.costs, pub.costsByTier[1], 'costs stays the tier-1 table for older clients');
});

test('checkUpgrade and nextCost price by tier', () => {
  const cost5 = leveling.costForLevel(1, undefined, 5);
  assert.equal(leveling.checkUpgrade(0, cost5 - 1, undefined, 5).ok, false);
  assert.equal(leveling.checkUpgrade(0, cost5, undefined, 5).cost, cost5);
  assert.equal(leveling.checkUpgrade(0, cost5 - 1, undefined, 1).ok, true, 'enough for tier 1, not for tier 5');
  assert.equal(leveling.nextCost(3, undefined, 5), leveling.costForLevel(4, undefined, 5));
});

test('every skill in the catalog carries a tier from 1 to 5', () => {
  for (const s of SKILLS) assert.ok([1, 2, 3, 4, 5].includes(s.tier), `${s.id}: tier ${s.tier}`);
  for (const t of [1, 2, 3, 4, 5]) assert.equal(SKILLS.filter((s) => s.tier === t).length, 60, `tier ${t}`);
});

// A just-enough stand-in for the statements upgradeSkill issues.
function fakeDb(state) {
  let snap = null;
  const client = {
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, ' ').trim();
      if (q === 'BEGIN') { snap = JSON.stringify({ gold: state.gold, levels: [...state.levels] }); return { rows: [], rowCount: 0 }; }
      if (q === 'COMMIT') { snap = null; return { rows: [], rowCount: 0 }; }
      if (q === 'ROLLBACK') {
        if (snap) { const s = JSON.parse(snap); state.gold = s.gold; state.levels = new Map(s.levels); }
        return { rows: [], rowCount: 0 };
      }
      if (q.startsWith('SELECT level FROM character_skill_levels')) {
        const lv = state.levels.get(params[1]);
        return lv ? { rows: [{ level: lv }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (q.startsWith('UPDATE users SET gold = gold - $2')) {
        if (state.gold < params[1]) return { rows: [], rowCount: 0 };
        state.gold -= params[1];
        return { rows: [{ gold: state.gold }], rowCount: 1 };
      }
      if (q.startsWith('INSERT INTO character_skill_levels')) {
        if (state.levels.has(params[1])) return { rows: [], rowCount: 0 };
        state.levels.set(params[1], 1);
        return { rows: [{ level: 1 }], rowCount: 1 };
      }
      if (q.startsWith('UPDATE character_skill_levels SET level')) {
        if (state.levels.get(params[1]) !== params[3]) return { rowCount: 0, rows: [] };
        state.levels.set(params[1], params[2]);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`fakeDb: unexpected SQL: ${q.slice(0, 80)}`);
    },
    release() {},
  };
  return { connect: async () => client };
}

function fixture(gold) {
  const state = { gold, levels: new Map() };
  const player = { gold, className: 'Warrior', skillLevels: new Map() };
  return { state, entry: { world: { getPlayer: () => player } }, db: fakeDb(state) };
}

test('buying a level of an ultimate charges the ultimate price', async () => {
  const ultimate = SKILLS.find((s) => s.class === 'Warrior' && s.tier === 5);
  const first = SKILLS.find((s) => s.class === 'Warrior' && s.tier === 1);
  assert.ok(ultimate && first, 'the catalog has both a tier 1 and a tier 5 Warrior skill');
  for (const [skill, tier] of [[first, 1], [ultimate, 5]]) {
    const f = fixture(100000);
    const r = await upgradeSkill(f.db, f.entry, 7, 5, skill.id);
    assert.equal(r.ok, true, skill.id);
    assert.equal(r.cost, leveling.costForLevel(1, undefined, tier), `${skill.id} (tier ${tier})`);
  }
  // a wallet that covers tier 1 but not tier 5 buys the first and refuses the second
  const poor = leveling.costForLevel(1, undefined, 5) - 1;
  const a = fixture(poor);
  assert.equal((await upgradeSkill(a.db, a.entry, 7, 5, first.id)).ok, true);
  const b = fixture(poor);
  const refused = await upgradeSkill(b.db, b.entry, 7, 5, ultimate.id);
  assert.equal(refused.reason, 'not enough gold');
  assert.equal(b.state.gold, poor, 'a refused purchase costs nothing');
});

test('walking an ultimate to level 15 costs exactly its own price table', async () => {
  const ultimate = SKILLS.find((s) => s.class === 'Warrior' && s.tier === 5);
  const total = leveling.costTable(undefined, 5).reduce((a, b) => a + b, 0);
  const f = fixture(total);
  for (let n = 1; n <= 15; n += 1) assert.equal((await upgradeSkill(f.db, f.entry, 7, 5, ultimate.id)).ok, true, `level ${n}`);
  assert.equal(f.state.gold, 0);
});

// ------------------------------------------------------ haste, set per kind of skill
test('melee and spell skills take their own share of the haste', () => {
  assert.deepEqual({ ...C.SKILL_HASTE_SHARE_BY_KIND }, { melee: 0.5, spell: 0.5 }, 'both start at the old single value');
  const floor = C.MIN_COOLDOWN_MULT;
  const dexMult = floor; // a DEX-capped build: full haste available
  assert.deepEqual(skillCooldownMults({}, dexMult, floor, { melee: 0, spell: 0 }), { melee: 1, spell: 1 }, 'a zero share is no haste');
  assert.deepEqual(skillCooldownMults({}, dexMult, floor, { melee: 1, spell: 1 }), { melee: floor, spell: floor }, 'a share of 1 is all of it');
  const split = skillCooldownMults({}, dexMult, floor, { melee: 1, spell: 0.25 });
  assert.equal(split.melee, floor);
  assert.equal(split.spell, Math.round((1 - (1 - floor) * 0.25) * 10000) / 10000);
  assert.ok(split.melee < split.spell, 'the kinds really are tuned independently');
});

test('changing one kind\'s share leaves the other kind alone', () => {
  const rules = { attackSpeedMult: 1.5, castSpeedMult: 1 };
  const a = skillCooldownMults({ rules }, 0.7, C.MIN_COOLDOWN_MULT, { melee: 0.5, spell: 0.5 });
  const b = skillCooldownMults({ rules }, 0.7, C.MIN_COOLDOWN_MULT, { melee: 0.5, spell: 0.9 });
  assert.equal(a.melee, b.melee);
  assert.ok(b.spell < a.spell);
});

test('derivePlayerStats uses the configured per-kind shares by default', () => {
  const { derivePlayerStats } = require('../src/services/playerStats.js');
  const fast = derivePlayerStats({ dexterity: 5 + 100 });
  const expected = Math.round((1 - (1 - C.MIN_COOLDOWN_MULT) * C.SKILL_HASTE_SHARE_BY_KIND.melee) * 10000) / 10000;
  assert.equal(fast.skillCooldownMult.melee, expected);
  assert.equal(fast.skillCooldownMult.spell, expected);
});
