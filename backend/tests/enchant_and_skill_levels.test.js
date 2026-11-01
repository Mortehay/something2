// Weapon enchanting and paid skill levels: the pure rules, the transactional
// operations (against a small in-memory stand-in for Postgres, so the transaction
// behaviour -- rollback on refusal, one scroll per roll -- is checked without a
// database), and the places the numbers are read in play.
const test = require('node:test');
const assert = require('node:assert/strict');

const enchant = require('../src/services/enchant.js');
const leveling = require('../src/services/skillLeveling.js');
const { enchantItem, upgradeSkill } = require('../src/authority/enchantOps.js');
const { activeWeaponType } = require('../src/authority/items.js');
const { World } = require('../src/authority/world.js');
const sb = require('../src/authority/skillBalance.js');

// ---------------------------------------------------------------- enchant rules

test('the default odds are the brief\'s table, 100% through +3 then 60% falling to 1%', () => {
  const want = { 1: 100, 2: 100, 3: 100, 4: 60, 5: 50, 6: 40, 7: 30, 8: 20, 9: 15, 10: 10, 11: 7, 12: 5, 13: 3, 14: 2, 15: 1 };
  for (const [lvl, pct] of Object.entries(want)) assert.equal(enchant.successChance(Number(lvl)), pct / 100, `+${lvl}`);
  assert.equal(enchant.ENCHANT_CONFIG.maxLevel, 15);
  assert.equal(enchant.ENCHANT_CONFIG.safeMaxLevel, 3);
});

test('the safe zone always succeeds, even on the worst roll', () => {
  for (const lvl of [0, 1, 2]) {
    const r = enchant.rollEnchant(lvl, () => 0.999999);
    assert.deepEqual(r, { outcome: 'success', level: lvl + 1 });
  }
});

test('the danger zone burns the weapon on a miss and upgrades it on a hit', () => {
  for (let lvl = 3; lvl < 15; lvl += 1) {
    const chance = enchant.successChance(lvl + 1);
    assert.deepEqual(enchant.rollEnchant(lvl, () => chance - 1e-9), { outcome: 'success', level: lvl + 1 });
    assert.deepEqual(enchant.rollEnchant(lvl, () => chance), { outcome: 'destroyed', level: lvl });
  }
});

test('a miss inside the safe zone (a config that allows one) spares the weapon', () => {
  const cfg = enchant.buildEnchantConfig({ chances: { 2: 50 } });
  assert.deepEqual(enchant.rollEnchant(1, () => 0.9, cfg), { outcome: 'safe_fail', level: 1 });
});

test('a +15 weapon cannot take another scroll', () => {
  assert.throws(() => enchant.rollEnchant(15), RangeError);
  const check = enchant.checkEnchantable({ enchantLevel: 15 }, { category: 'weapon' });
  assert.equal(check.ok, false);
  assert.match(check.reason, /already \+15/);
  assert.equal(enchant.checkEnchantable({ enchantLevel: 14 }, { category: 'weapon' }).ok, true);
});

test('only weapons can be enchanted', () => {
  assert.equal(enchant.checkEnchantable({ enchantLevel: 0 }, { category: 'armor' }).ok, false);
  assert.equal(enchant.checkEnchantable(null, { category: 'weapon' }).ok, false);
});

test('each level adds a fixed share of the base damage', () => {
  assert.equal(enchant.damageMultiplier(0), 1);
  assert.equal(enchant.damageMultiplier(1), 1.24);
  assert.equal(enchant.damageMultiplier(15), 4.6);
  assert.equal(enchant.damageMultiplier(99), 4.6, 'clamped at the cap');
  assert.equal(enchant.damageMultiplier(-3), 1);
});

test('the aura starts at +4 and turns to fire at +10', () => {
  const tiers = [0, 1, 2, 3, 4, 9, 10, 15].map((n) => enchant.glowTier(n));
  assert.deepEqual(tiers, [0, 0, 0, 0, 1, 1, 2, 2]);
});

test('a bad config is rejected with a reason, and a bad override falls back loudly', () => {
  assert.throws(() => enchant.buildEnchantConfig({ chances: { 4: 140 } }), /chances\[4\]/);
  assert.throws(() => enchant.buildEnchantConfig({ maxLevel: 0 }), /maxLevel/);
  assert.throws(() => enchant.buildEnchantConfig({ safeMaxLevel: 99 }), /safeMaxLevel/);
  assert.throws(() => enchant.buildEnchantConfig({ damagePerLevel: -1 }), /damagePerLevel/);
  assert.throws(() => enchant.buildEnchantConfig({ glowFireLevel: 2 }), /glowFireLevel/);
  const logged = [];
  const cfg = enchant.loadEnchantConfig({ ENCHANT_CONFIG_JSON: '{"chances":{"4":-5}}' }, (m) => logged.push(m));
  assert.equal(cfg.chances[4], 60, 'defaults kept');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /ENCHANT_CONFIG_JSON ignored/);
  const garbage = enchant.loadEnchantConfig({ ENCHANT_CONFIG_JSON: 'not json' }, (m) => logged.push(m));
  assert.equal(garbage.maxLevel, 15);
  const tuned = enchant.loadEnchantConfig({ ENCHANT_CONFIG_JSON: '{"damagePerLevel":0.1,"chances":{"4":75}}' });
  assert.equal(tuned.damagePerLevel, 0.1);
  assert.equal(tuned.chances[4], 75);
  assert.equal(tuned.chances[5], 50, 'unspecified levels keep their default');
});

// --------------------------------------------------------- skill leveling rules

test('skill level prices grow x1.2 per level from the configured first price', () => {
  const costs = leveling.costTable();
  assert.equal(costs.length, 15);
  assert.equal(costs[0], leveling.SKILL_LEVELING_CONFIG.baseCost);
  for (let i = 1; i < costs.length; i += 1) {
    const exact = leveling.SKILL_LEVELING_CONFIG.baseCost * 1.2 ** i;
    assert.equal(costs[i], Math.round(exact), `level ${i + 1}`);
    assert.ok(costs[i] > costs[i - 1]);
  }
});

test('the first price is a config value: changing it rescales every level', () => {
  const cheap = leveling.buildSkillLevelingConfig({ baseCost: 10 });
  assert.equal(leveling.costForLevel(1, cheap), 10);
  assert.equal(leveling.costForLevel(2, cheap), 12);
  assert.equal(leveling.costForLevel(3, cheap), 14);
  const env = leveling.loadSkillLevelingConfig({ SKILL_LEVELING_CONFIG_JSON: '{"baseCost":250}' });
  assert.equal(env.baseCost, 250);
});

test('each level adds +1% power, +15% at the cap', () => {
  assert.equal(leveling.powerMultiplier(0), 1);
  assert.equal(leveling.powerMultiplier(1), 1.01);
  assert.equal(leveling.powerMultiplier(15), 1.15);
  assert.equal(leveling.powerMultiplier(40), 1.15, 'clamped at the cap');
});

test('an upgrade needs enough gold and stops at level 15', () => {
  const cost = leveling.costForLevel(1);
  assert.deepEqual(leveling.checkUpgrade(0, cost), { ok: true, cost, level: 1 });
  const poor = leveling.checkUpgrade(0, cost - 1);
  assert.equal(poor.ok, false);
  assert.equal(poor.reason, 'not enough gold');
  assert.equal(poor.cost, cost);
  const maxed = leveling.checkUpgrade(15, 1e12);
  assert.equal(maxed.ok, false);
  assert.match(maxed.reason, /already level 15/);
  assert.equal(leveling.nextCost(15), null);
  assert.equal(leveling.nextCost(14), leveling.costForLevel(15));
});

test('bad skill-leveling config is rejected and an env typo falls back', () => {
  assert.throws(() => leveling.buildSkillLevelingConfig({ baseCost: 0 }), /baseCost/);
  assert.throws(() => leveling.buildSkillLevelingConfig({ costGrowth: 0.5 }), /costGrowth/);
  assert.throws(() => leveling.buildSkillLevelingConfig({ maxLevel: 200 }), /maxLevel/);
  const logged = [];
  const cfg = leveling.loadSkillLevelingConfig({ SKILL_LEVELING_CONFIG_JSON: '{"powerPerLevel":"lots"}' }, (m) => logged.push(m));
  assert.equal(cfg.powerPerLevel, 0.01);
  assert.equal(logged.length, 1);
});

// ------------------------------------------------- the operations, against a fake db

// Just enough Postgres for the statements enchantOps issues. State is snapshotted
// at BEGIN and restored on ROLLBACK, so a refusal that forgets to roll back shows up
// as a state change.
function fakeDb(state) {
  let snap = null;
  const client = {
    released: false,
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, ' ').trim();
      if (q === 'BEGIN') { snap = JSON.stringify({ items: [...state.items], gold: state.gold, levels: [...state.levels] }); return { rows: [], rowCount: 0 }; }
      if (q === 'COMMIT') { snap = null; return { rows: [], rowCount: 0 }; }
      if (q === 'ROLLBACK') {
        if (snap) {
          const s = JSON.parse(snap);
          state.items = new Map(s.items); state.gold = s.gold; state.levels = new Map(s.levels);
        }
        return { rows: [], rowCount: 0 };
      }
      if (q.startsWith('SELECT pi.id, pi.quantity, pi.enchant_level')) {
        const rows = params[0].map((id) => state.items.get(id) && { id, ...state.items.get(id) }).filter(Boolean)
          .filter((r) => r.character_id === params[1]);
        return { rows, rowCount: rows.length };
      }
      if (q.startsWith('UPDATE player_items SET quantity = quantity - 1')) { state.items.get(params[0]).quantity -= 1; return { rowCount: 1, rows: [] }; }
      if (q.startsWith('DELETE FROM player_items')) { state.items.delete(params[0]); return { rowCount: 1, rows: [] }; }
      if (q.startsWith('UPDATE player_items SET enchant_level')) { state.items.get(params[0]).enchant_level = params[1]; return { rowCount: 1, rows: [] }; }
      if (q.startsWith('SELECT level FROM character_skill_levels') && q.includes('FOR UPDATE')) {
        const lv = state.levels.get(params[1]);
        return lv ? { rows: [{ level: lv }], rowCount: 1 } : { rows: [], rowCount: 0 };
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
    release() { this.released = true; },
  };
  return { connect: async () => client, client };
}

const SCROLL_TYPE = 70;
const SWORD_TYPE = 71;
const ARMOR_TYPE = 72;
const CHAR = 5;

function enchantFixture({ level = 0, scrolls = 3, equipped = false } = {}) {
  const state = {
    gold: 10000,
    levels: new Map(),
    items: new Map([
      ['scroll', { character_id: CHAR, quantity: scrolls, enchant_level: 0, name: 'enchant_scroll', category: 'consumable' }],
      ['sword', { character_id: CHAR, quantity: 1, enchant_level: level, name: 'sword', category: 'weapon' }],
      ['vest', { character_id: CHAR, quantity: 1, enchant_level: 0, name: 'vest', category: 'armor' }],
    ]),
  };
  const weapons = new Map([
    [SCROLL_TYPE, { id: SCROLL_TYPE, name: 'enchant_scroll', category: 'consumable' }],
    [SWORD_TYPE, { id: SWORD_TYPE, name: 'sword', category: 'weapon', kind: 'melee', damage: 10, cooldown: 1 }],
    [ARMOR_TYPE, { id: ARMOR_TYPE, name: 'vest', category: 'armor' }],
  ]);
  const player = {
    gold: state.gold, className: 'Warrior', skillLevels: new Map(),
    inv: {
      items: [
        { id: 'scroll', typeId: SCROLL_TYPE, quantity: scrolls, enchantLevel: 0 },
        { id: 'sword', typeId: SWORD_TYPE, quantity: 1, enchantLevel: level },
        { id: 'vest', typeId: ARMOR_TYPE, quantity: 1, enchantLevel: 0 },
      ],
      equipment: equipped ? { main_hand: 'sword' } : {},
    },
  };
  const entry = { world: { weapons, getPlayer: () => player } };
  return { state, player, entry, db: fakeDb(state) };
}

const always = (v) => () => v;

test('enchanting spends one scroll from the stack and raises the weapon', async () => {
  const f = enchantFixture();
  const r = await enchantItem(f.db, f.entry, 'u', CHAR, 'scroll', 'sword', { rng: always(0) });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'success');
  assert.equal(r.level, 1);
  assert.equal(r.scrollsLeft, 2);
  assert.equal(f.state.items.get('scroll').quantity, 2, 'the database lost one scroll');
  assert.equal(f.state.items.get('sword').enchant_level, 1);
  assert.equal(f.player.inv.items.find((i) => i.id === 'sword').enchantLevel, 1, 'the live inventory follows');
  assert.equal(f.player.inv.items.find((i) => i.id === 'scroll').quantity, 2);
  assert.equal(f.db.client.released, true);
});

test('the last scroll of a stack is deleted, not left at quantity 0', async () => {
  const f = enchantFixture({ scrolls: 1 });
  const r = await enchantItem(f.db, f.entry, 'u', CHAR, 'scroll', 'sword', { rng: always(0) });
  assert.equal(r.ok, true);
  assert.equal(r.scrollsLeft, 0);
  assert.equal(f.state.items.has('scroll'), false);
  assert.equal(f.player.inv.items.some((i) => i.id === 'scroll'), false);
});

test('a miss in the danger zone burns the weapon, spends the scroll, and unequips it', async () => {
  const f = enchantFixture({ level: 6, equipped: true });
  const r = await enchantItem(f.db, f.entry, 'u', CHAR, 'scroll', 'sword', { rng: always(0.999) });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'destroyed');
  assert.equal(r.destroyed, true);
  assert.equal(r.wasEquipped, true);
  assert.equal(f.state.items.has('sword'), false, 'gone from the database');
  assert.equal(f.state.items.get('scroll').quantity, 2, 'the scroll is still spent');
  assert.equal(f.player.inv.items.some((i) => i.id === 'sword'), false, 'gone from the inventory');
  assert.equal(f.player.inv.equipment.main_hand, undefined, 'and from the paper doll');
});

test('a safe-zone failure keeps the weapon and only costs the scroll', async () => {
  const f = enchantFixture({ level: 1 });
  const cfg = enchant.buildEnchantConfig({ chances: { 2: 0 } });
  const r = await enchantItem(f.db, f.entry, 'u', CHAR, 'scroll', 'sword', { rng: always(0.5), cfg });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'safe_fail');
  assert.equal(f.state.items.get('sword').enchant_level, 1);
  assert.equal(f.state.items.get('scroll').quantity, 2);
});

test('a +15 weapon refuses the scroll and nothing is spent', async () => {
  const f = enchantFixture({ level: 15 });
  const r = await enchantItem(f.db, f.entry, 'u', CHAR, 'scroll', 'sword', { rng: always(0) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /already \+15/);
  assert.equal(f.state.items.get('scroll').quantity, 3);
});

test('refusals: armor, a non-scroll, strangers\' items, bad ids -- none of them spend anything', async () => {
  const cases = [
    ['scroll', 'vest', /only weapons/],
    ['sword', 'sword', /choose a scroll and a weapon/],
    ['vest', 'sword', /not an enchant scroll/],
    ['scroll', 'nope', /do not own that weapon/],
    ['nope', 'sword', /do not own that scroll/],
  ];
  for (const [scrollId, itemId, pattern] of cases) {
    const f = enchantFixture();
    const r = await enchantItem(f.db, f.entry, 'u', CHAR, scrollId, itemId, { rng: always(0) });
    assert.equal(r.ok, false, `${scrollId} -> ${itemId}`);
    assert.match(r.reason, pattern);
    assert.equal(f.state.items.get('scroll').quantity, 3, 'no scroll spent');
  }
  const f = enchantFixture();
  const bad = await enchantItem(f.db, f.entry, 'u', CHAR, 42, null, { rng: always(0) });
  assert.equal(bad.ok, false);
});

test('a stale cache cannot get a bad enchant through: the database is the authority', async () => {
  // The cache says the weapon is +3 and the scroll exists; the database says the
  // weapon is already +15 (another session maxed it).
  const f = enchantFixture({ level: 3 });
  f.state.items.get('sword').enchant_level = 15;
  const r = await enchantItem(f.db, f.entry, 'u', CHAR, 'scroll', 'sword', { rng: always(0) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /already \+15/);
  assert.equal(f.state.items.get('scroll').quantity, 3, 'rolled back, scroll intact');
  assert.equal(f.player.inv.items.find((i) => i.id === 'sword').enchantLevel, 3, 'the cache was not touched');

  // And a scroll the database no longer has.
  const g = enchantFixture();
  g.state.items.delete('scroll');
  const r2 = await enchantItem(g.db, g.entry, 'u', CHAR, 'scroll', 'sword', { rng: always(0) });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /do not own that scroll/);
});

test('a database failure rolls back, releases the connection and propagates', async () => {
  const f = enchantFixture();
  const realQuery = f.db.client.query.bind(f.db.client);
  f.db.client.query = async (sql, params) => {
    if (sql.includes('SET enchant_level')) throw new Error('boom');
    return realQuery(sql, params);
  };
  await assert.rejects(() => enchantItem(f.db, f.entry, 'u', CHAR, 'scroll', 'sword', { rng: always(0) }), /boom/);
  assert.equal(f.state.items.get('scroll').quantity, 3, 'the scroll was restored');
  assert.equal(f.db.client.released, true);
});

test('the odds hold over many scrolls (+4 is 60%)', async () => {
  let wins = 0;
  const n = 2000;
  let seed = 12345;
  const rng = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let i = 0; i < n; i += 1) {
    const r = enchant.rollEnchant(3, rng);
    if (r.outcome === 'success') wins += 1;
  }
  assert.ok(Math.abs(wins / n - 0.6) < 0.04, `observed ${(wins / n).toFixed(3)}`);
});

// ------------------------------------------------------------- skill upgrade ops

function skillFixture({ gold = 10000, level = 0, className = 'Warrior' } = {}) {
  const state = { gold, levels: new Map(level ? [['war_crushing_blow', level]] : []), items: new Map() };
  const player = { gold, className, skillLevels: new Map(level ? [['war_crushing_blow', level]] : []) };
  const entry = { world: { getPlayer: () => player } };
  return { state, player, entry, db: fakeDb(state) };
}

test('buying a skill level debits the exact price and records the level', async () => {
  const f = skillFixture({ gold: 1000 });
  const r = await upgradeSkill(f.db, f.entry, 7, CHAR, 'war_crushing_blow');
  assert.equal(r.ok, true);
  assert.equal(r.level, 1);
  assert.equal(r.cost, leveling.costForLevel(1));
  assert.equal(f.state.gold, 1000 - leveling.costForLevel(1));
  assert.equal(r.gold, f.state.gold);
  assert.equal(f.player.gold, f.state.gold, 'the live wallet follows');
  assert.equal(f.player.skillLevels.get('war_crushing_blow'), 1);
  assert.equal(f.state.levels.get('war_crushing_blow'), 1);

  const second = await upgradeSkill(f.db, f.entry, 7, CHAR, 'war_crushing_blow');
  assert.equal(second.level, 2);
  assert.equal(second.cost, leveling.costForLevel(2));
});

test('not enough gold buys nothing and charges nothing', async () => {
  const f = skillFixture({ gold: leveling.costForLevel(1) - 1 });
  const r = await upgradeSkill(f.db, f.entry, 7, CHAR, 'war_crushing_blow');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not enough gold');
  assert.equal(f.state.levels.size, 0);
  assert.equal(f.state.gold, leveling.costForLevel(1) - 1);
});

test('a database that disagrees about gold is rolled back without a level', async () => {
  // The live wallet says rich; the database (the truth) says poor.
  const f = skillFixture({ gold: 1000 });
  f.state.gold = 1;
  const r = await upgradeSkill(f.db, f.entry, 7, CHAR, 'war_crushing_blow');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not enough gold');
  assert.equal(f.state.levels.size, 0);
  assert.equal(f.state.gold, 1);
});

test('level 15 is the cap: the button is refused and no gold moves', async () => {
  const f = skillFixture({ gold: 1e9, level: 15 });
  const r = await upgradeSkill(f.db, f.entry, 7, CHAR, 'war_crushing_blow');
  assert.equal(r.ok, false);
  assert.match(r.reason, /already level 15/);
  assert.equal(f.state.gold, 1e9);
  assert.equal(f.state.levels.get('war_crushing_blow'), 15);
});

test('walking a skill all the way up costs exactly the price table', async () => {
  const total = leveling.costTable().reduce((a, b) => a + b, 0);
  const f = skillFixture({ gold: total });
  for (let n = 1; n <= 15; n += 1) {
    const r = await upgradeSkill(f.db, f.entry, 7, CHAR, 'war_crushing_blow');
    assert.equal(r.ok, true, `level ${n}`);
  }
  assert.equal(f.state.gold, 0);
  assert.equal(f.player.skillLevels.get('war_crushing_blow'), 15);
  const over = await upgradeSkill(f.db, f.entry, 7, CHAR, 'war_crushing_blow');
  assert.equal(over.ok, false);
});

test('another class\'s skill, an unknown skill and a junk id are refused', async () => {
  const f = skillFixture();
  assert.match((await upgradeSkill(f.db, f.entry, 7, CHAR, 'mag_fireball')).reason, /not for your class/);
  assert.match((await upgradeSkill(f.db, f.entry, 7, CHAR, 'war_nope')).reason, /unknown skill/);
  assert.match((await upgradeSkill(f.db, f.entry, 7, CHAR, 42)).reason, /unknown skill/);
  assert.equal(f.state.gold, 10000);
});

test('two racing purchases of the same level cannot both succeed', async () => {
  const f = skillFixture({ gold: 100000 });
  // The second request priced level 1, but the first already took it.
  const first = await upgradeSkill(f.db, f.entry, 7, CHAR, 'war_crushing_blow');
  assert.equal(first.ok, true);
  f.player.skillLevels.set('war_crushing_blow', 0); // the stale cache of the loser
  const second = await upgradeSkill(f.db, f.entry, 7, CHAR, 'war_crushing_blow');
  // The authoritative level (1) is re-read under the lock, so this buys level 2 --
  // at level 2's price, never twice at level 1's.
  assert.equal(second.ok, true);
  assert.equal(second.level, 2);
  assert.equal(second.cost, leveling.costForLevel(2));
  assert.equal(f.state.levels.get('war_crushing_blow'), 2);
});

// ------------------------------------------------------------ where it is read in play

function worldWithWeapon(enchantLevel) {
  const map = { isWalkable: () => true, width: 4000, height: 4000, decorations: [] };
  const sword = { id: 9, name: 'sword', category: 'weapon', kind: 'melee', damage: 10, cooldown: 0.5, reach: 90, arc_width: 1.5 };
  const unarmed = { id: 1, name: 'unarmed', category: 'weapon', kind: 'melee', damage: 3, cooldown: 0.6, reach: 60, arc_width: 1 };
  const world = new World(map, new Map([[1, unarmed], [9, sword]]), 1);
  const stats = {
    meleeMult: 1, spellMult: 1, level: 100, strength: 30, dexterity: 30, constitution: 30,
    intelligence: 30, wisdom: 30, charisma: 30,
    damageMult: { physical: 1, arcane: 1, fire: 1, ice: 1, lightning: 1, shadow: 1, holy: 1 },
    resists: {}, rules: {}, sources: {},
  };
  const inv = { items: [{ id: 'w1', typeId: 9, quantity: 1, enchantLevel }], equipment: { main_hand: 'w1' } };
  world.addPlayer('u', { x: 1000, y: 1000 }, inv, { x: 1000, y: 1000 }, 0, stats);
  const p = world.getPlayer('u');
  p.className = 'Warrior';
  p.stamina = 100; p.mana = 100; p.maxMana = 100; p.hp = 500; p.maxHp = 500;
  return { world, p };
}

test('the equipped weapon\'s damage is scaled by its enchant level', () => {
  const type = (lvl) => {
    const { world, p } = worldWithWeapon(lvl);
    return activeWeaponType(p.inv, world.weapons, world.defaultWeaponId);
  };
  assert.equal(type(0).damage, 10);
  assert.equal(type(0).enchantLevel, undefined, 'an unenchanted weapon is returned as is');
  assert.equal(type(5).damage, 10 * enchant.damageMultiplier(5));
  assert.equal(type(15).damage, 10 * enchant.damageMultiplier(15));
  assert.equal(type(15).enchantLevel, 15);
});

test('the snapshot carries the held weapon\'s +N only when there is one', () => {
  const plain = worldWithWeapon(0).world.snapshot().players[0];
  assert.equal('enchant' in plain, false);
  const strong = worldWithWeapon(11).world.snapshot().players[0];
  assert.equal(strong.enchant, 11);
});

test('skill levels raise skill damage by 1% each', () => {
  const dmg = (level) => {
    const { world, p } = worldWithWeapon(0);
    p.skillLevels = new Map(level ? [['war_crushing_blow', level]] : []);
    world.creatures.creatures.set('c', {
      id: 'c', name: 'Goblin', x: p.x + 40, y: p.y, width: 48, height: 48, hp: 1e6, maxHp: 1e6,
      effects: new Map(), mit: { defense: 0, resists: {} },
    });
    const res = world.castSkill('u', 'war_crushing_blow', p.x + 60, p.y, 1, 0);
    assert.equal(res.ok, true, `${res.reason} ${res.error}`);
    return 1e6 - world.creatures.get('c').hp;
  };
  const base = dmg(0);
  assert.ok(base > 20);
  assert.ok(Math.abs(dmg(15) - base * 1.15) <= 1.5, `${dmg(15)} vs ${base * 1.15}`);
  assert.ok(dmg(15) > dmg(5) && dmg(5) > base);
});

test('a skill level strengthens the potency of a buff, not its duration or cost', () => {
  const spec = { heal: 0.2, dur: 20, dealt: 1.2, taken: 0.8, hot: 0.01, absorbPts: 100, cost: 5 };
  assert.equal(sb.withPotency(spec, 1), spec, 'level 0 returns the spec untouched');
  const up = sb.withPotency(spec, 1.15);
  assert.ok(Math.abs(up.heal - 0.23) < 1e-9);
  assert.ok(Math.abs(up.hot - 0.0115) < 1e-9);
  assert.ok(Math.abs(up.absorbPts - 115) < 1e-9);
  assert.ok(Math.abs(up.dealt - 1.23) < 1e-9, 'a x1.2 buff scales its EXCESS: 1 + 0.2 x 1.15');
  assert.ok(Math.abs(up.taken - 0.77) < 1e-9, 'damage reduction scales the same way');
  assert.equal(up.dur, 20, 'duration is not power');
  assert.equal(up.cost, 5);
  assert.equal(sb.withPotency({ taken: 0.25 }, 99).taken, 0.2, 'reduction is bounded short of immunity');

  const heal = (potency) => {
    const p = { hp: 1, maxHp: 100000, mana: 50, maxMana: 100, buffs: new Map(), stats: { rules: {} } };
    sb.castBuff(p, { id: 'mnk_touch_of_life', nameEn: 'x', nameUk: 'x' }, 0, potency);
    return p.hp - 1;
  };
  assert.ok(heal(1.15) > heal(1) * 1.14 && heal(1.15) < heal(1) * 1.16, 'a +15% skill heals ~15% more');
});

test('the migration is well-formed: it adds the columns, the scroll and the skill table, and undoes them', () => {
  const m = require('../migrations/1714440850000_weapon_enchant_and_skill_levels.js');
  const calls = [];
  const pgm = new Proxy({}, {
    get: (_t, name) => (name === 'func' ? (x) => ({ func: x }) : (...args) => calls.push([name, ...args])),
  });
  m.up(pgm);
  const names = calls.map((c) => c[0]);
  assert.ok(names.includes('addColumns'));
  assert.ok(names.includes('createTable'));
  const sql = calls.filter((c) => c[0] === 'sql').map((c) => c[1]).join('\n');
  assert.match(sql, /enchant_scroll/);
  assert.match(sql, /merchant_stock/);
  const tables = calls.filter((c) => c[0] === 'addColumns').map((c) => c[1]);
  assert.deepEqual(tables.sort(), ['player_items', 'world_items']);
  calls.length = 0;
  m.down(pgm);
  assert.ok(calls.some((c) => c[0] === 'dropTable' && c[1] === 'character_skill_levels'));
});

// --------------------------------------------------------------- wiring guards
// Text checks on the places a feature can be "live in the schema and dead in play":
// a handler nobody registered, a payload field nobody sends, a column nobody selects.
const fs = require('node:fs');
const path = require('node:path');
const SRC = path.resolve(__dirname, '../src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

test('the server registers both handlers and sends the config and levels on join', () => {
  const server = read('authority/server.js');
  assert.match(server, /^\s+enchant\(ws, msg\) \{/m);
  assert.match(server, /^\s+upgradeSkill\(ws, msg\) \{/m);
  assert.match(server, /enchant: publicEnchantConfig\(\)/);
  assert.match(server, /skillLeveling: publicSkillLevelingConfig\(\)/);
  assert.match(server, /skillLevels: Object\.fromEntries\(joinedSkillLevels\)/);
  assert.match(server, /type: 'enchanted'/);
  assert.match(server, /type: 'skillUpgraded'/);
});

test('every path that moves a weapon between tables carries its enchant level', () => {
  assert.match(read('authority/items.js'), /pi\.enchant_level/, 'loadInventory selects it');
  const loot = read('authority/loot.js');
  assert.ok((loot.match(/enchant_level/g) || []).length >= 8, 'dropItem and claimItem both write and read it');
  assert.match(read('authority/trade.js'), /enchant_level/, 'buying back an enchanted weapon');
  assert.match(read('services/accountChest.js'), /enchant_level/, 'withdrawing an enchanted weapon');
});

test('merchants sell the scroll', () => {
  assert.match(read('services/merchantStock.js'), /name = 'enchant_scroll'/);
});

test('an enchanted weapon scales skills through the weapon share, not just basic attacks', () => {
  // castSkill reads the equipped weapon's damage via activeWeaponType, which now carries the multiplier.
  const f = enchantFixture({ level: 10, equipped: true });
  const w = activeWeaponType(f.player.inv, f.entry.world.weapons, SWORD_TYPE);
  assert.equal(w.damage, 10 * enchant.damageMultiplier(10));
});
