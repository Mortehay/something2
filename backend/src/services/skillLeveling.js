// Paid skill leveling: spend gold to make a skill hit (and heal, and shield) harder.
// PURE -- no database; the caller owns the wallet and the stored levels.
//
// THE RULES (the product brief):
//   * a skill can be levelled 15 times;
//   * every level adds +1% to the skill's power (so +15% at the cap);
//   * the price grows exponentially: Cost_N = Cost_(N-1) x 1.2, and the first
//     level's price is a config value so balancing is a one-line edit;
//   * a STRONGER skill costs more to level: the whole price curve is scaled by a
//     per-tier multiplier (tier 1..5 is the skill's place in its class, the same
//     tier the gem shop prices by), so levelling an ultimate is not as cheap as
//     levelling the first strike.
//
// "Grows by 120% of the previous level" in the brief is read as the formula it
// gives, x1.2 (a +20% step). A literal x2.2 would make the last level cost ~10,000x
// the first, which cannot be what the formula next to it describes.
//
// TUNING: DEFAULT_SKILL_LEVELING_CONFIG below; SKILL_LEVELING_CONFIG_JSON overrides
// any key. A bad override is logged with its reason and the defaults are used.

const DEFAULT_SKILL_LEVELING_CONFIG = Object.freeze({
  maxLevel: 15,
  // The gold price of the FIRST level. Every later level multiplies this.
  baseCost: 100,
  // Cost_N = Cost_(N-1) x costGrowth.
  costGrowth: 1.2,
  // Each level adds this fraction to the skill's power (0.01 = +1%).
  powerPerLevel: 0.01,
  // Each EXTRA spell level from gear (a +N to Level of all Spells affix) adds this fraction on top of the paid level.
  // A bought level is +1%; a level from an item is a rare gift and worth more.
  bonusLevelPower: 0.05,
  // The whole price curve of a skill is multiplied by its tier's entry. Tier 1 is the
  // baseline (x1); the ultimates (tier 5) cost five times as much at every level.
  tierCostMultipliers: Object.freeze({ 1: 1, 2: 1.5, 3: 2.25, 4: 3.5, 5: 5 }),
});

const TIERS = [1, 2, 3, 4, 5];

class SkillLevelingConfigError extends Error {}

function validateSkillLevelingConfig(cfg) {
  const fail = (why) => { throw new SkillLevelingConfigError(why); };
  if (!cfg || typeof cfg !== 'object') fail('config must be an object');
  if (!Number.isInteger(cfg.maxLevel) || cfg.maxLevel < 1 || cfg.maxLevel > 99) fail('maxLevel must be an integer in 1..99');
  if (!Number.isInteger(cfg.baseCost) || cfg.baseCost < 1) fail('baseCost must be an integer >= 1');
  if (typeof cfg.costGrowth !== 'number' || !Number.isFinite(cfg.costGrowth) || cfg.costGrowth < 1) fail('costGrowth must be a number >= 1');
  if (typeof cfg.powerPerLevel !== 'number' || !Number.isFinite(cfg.powerPerLevel) || cfg.powerPerLevel < 0) fail('powerPerLevel must be a number >= 0');
  if (typeof cfg.bonusLevelPower !== 'number' || !Number.isFinite(cfg.bonusLevelPower) || cfg.bonusLevelPower < 0) fail('bonusLevelPower must be a number >= 0');
  const m = cfg.tierCostMultipliers;
  if (!m || typeof m !== 'object') fail('tierCostMultipliers must be an object keyed by tier 1..5');
  for (const tier of TIERS) {
    if (typeof m[tier] !== 'number' || !Number.isFinite(m[tier]) || m[tier] <= 0) fail(`tierCostMultipliers[${tier}] must be a number > 0`);
  }
  return cfg;
}

function buildSkillLevelingConfig(overrides = {}) {
  if (overrides == null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new SkillLevelingConfigError('overrides must be an object');
  }
  const merged = {
    ...DEFAULT_SKILL_LEVELING_CONFIG,
    ...overrides,
    tierCostMultipliers: { ...DEFAULT_SKILL_LEVELING_CONFIG.tierCostMultipliers, ...(overrides.tierCostMultipliers || {}) },
  };
  validateSkillLevelingConfig(merged);
  return Object.freeze({ ...merged, tierCostMultipliers: Object.freeze({ ...merged.tierCostMultipliers }) });
}

function loadSkillLevelingConfig(env = process.env, log = console.error) {
  const raw = env && env.SKILL_LEVELING_CONFIG_JSON;
  if (!raw) return buildSkillLevelingConfig();
  try {
    return buildSkillLevelingConfig(JSON.parse(raw));
  } catch (err) {
    log(`SKILL_LEVELING_CONFIG_JSON ignored, using the defaults: ${err.message}`);
    return buildSkillLevelingConfig();
  }
}

const SKILL_LEVELING_CONFIG = loadSkillLevelingConfig();

function clampLevel(level, cfg) {
  const n = Math.floor(Number(level) || 0);
  return Math.max(0, Math.min(cfg.maxLevel, n));
}

// A skill's tier as the price table sees it: an integer 1..5, anything else is tier 1.
function tierOf(tier) {
  const t = Math.floor(Number(tier));
  return TIERS.includes(t) ? t : 1;
}

// The gold price of reaching `level` (1-based) for a skill of `tier`:
// baseCost x tierMultiplier x costGrowth^(level-1), rounded once at the end so
// rounding never compounds. 0 for a level outside 1..max. Tier defaults to 1, the
// baseline, so every caller that predates tiers prices exactly as it did.
function costForLevel(level, cfg = SKILL_LEVELING_CONFIG, tier = 1) {
  const n = Math.floor(Number(level));
  if (!Number.isInteger(n) || n < 1 || n > cfg.maxLevel) return 0;
  return Math.round(cfg.baseCost * cfg.tierCostMultipliers[tierOf(tier)] * Math.pow(cfg.costGrowth, n - 1));
}

// The price of the NEXT level for a skill at `currentLevel`, or null at the cap.
function nextCost(currentLevel, cfg = SKILL_LEVELING_CONFIG, tier = 1) {
  const cur = clampLevel(currentLevel, cfg);
  return cur >= cfg.maxLevel ? null : costForLevel(cur + 1, cfg, tier);
}

// The power multiplier of a skill at `level`: 1 at level 0, 1.15 at level 15.
function powerMultiplier(level, cfg = SKILL_LEVELING_CONFIG) {
  return Math.round((1 + cfg.powerPerLevel * clampLevel(level, cfg)) * 10000) / 10000;
}

// The multiplier gear's extra spell levels give: 1 for none, 1.15 for +3 at the default 5% each.
function bonusLevelMultiplier(levels, cfg = SKILL_LEVELING_CONFIG) {
  const n = Math.max(0, Math.floor(Number(levels) || 0));
  return Math.round((1 + cfg.bonusLevelPower * n) * 10000) / 10000;
}

// Can a player at `currentLevel` with `gold` buy the next level?
//   { ok: true, cost, level }  or  { ok: false, reason, cost? }
function checkUpgrade(currentLevel, gold, cfg = SKILL_LEVELING_CONFIG, tier = 1) {
  const cur = clampLevel(currentLevel, cfg);
  if (cur >= cfg.maxLevel) return { ok: false, reason: `this skill is already level ${cfg.maxLevel}` };
  const cost = costForLevel(cur + 1, cfg, tier);
  const have = Number(gold);
  if (!Number.isFinite(have) || have < cost) return { ok: false, reason: 'not enough gold', cost };
  return { ok: true, cost, level: cur + 1 };
}

// The whole price list for one tier, for the client's tooltip and for tests.
function costTable(cfg = SKILL_LEVELING_CONFIG, tier = 1) {
  const out = [];
  for (let n = 1; n <= cfg.maxLevel; n += 1) out.push(costForLevel(n, cfg, tier));
  return out;
}

// What the client needs. The price tables are computed HERE, one per tier, so the
// client never re-derives a price (and cannot round it differently from the server).
// `costs` is the tier-1 table, kept for clients that predate tiers.
function publicSkillLevelingConfig(cfg = SKILL_LEVELING_CONFIG) {
  const costsByTier = {};
  for (const t of TIERS) costsByTier[t] = costTable(cfg, t);
  return {
    maxLevel: cfg.maxLevel, powerPerLevel: cfg.powerPerLevel,
    costs: costsByTier[1], costsByTier,
  };
}

module.exports = {
  DEFAULT_SKILL_LEVELING_CONFIG, SKILL_LEVELING_CONFIG, SkillLevelingConfigError,
  validateSkillLevelingConfig, buildSkillLevelingConfig, loadSkillLevelingConfig,
  costForLevel, nextCost, powerMultiplier, bonusLevelMultiplier, checkUpgrade, costTable, publicSkillLevelingConfig, tierOf, TIERS,
};
