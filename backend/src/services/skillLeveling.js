// Paid skill leveling: spend gold to make a skill hit (and heal, and shield) harder.
// PURE -- no database; the caller owns the wallet and the stored levels.
//
// THE RULES (the product brief):
//   * a skill can be levelled 15 times;
//   * every level adds +1% to the skill's power (so +15% at the cap);
//   * the price grows exponentially: Cost_N = Cost_(N-1) x 1.2, and the first
//     level's price is a config value so balancing is a one-line edit.
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
});

class SkillLevelingConfigError extends Error {}

function validateSkillLevelingConfig(cfg) {
  const fail = (why) => { throw new SkillLevelingConfigError(why); };
  if (!cfg || typeof cfg !== 'object') fail('config must be an object');
  if (!Number.isInteger(cfg.maxLevel) || cfg.maxLevel < 1 || cfg.maxLevel > 99) fail('maxLevel must be an integer in 1..99');
  if (!Number.isInteger(cfg.baseCost) || cfg.baseCost < 1) fail('baseCost must be an integer >= 1');
  if (typeof cfg.costGrowth !== 'number' || !Number.isFinite(cfg.costGrowth) || cfg.costGrowth < 1) fail('costGrowth must be a number >= 1');
  if (typeof cfg.powerPerLevel !== 'number' || !Number.isFinite(cfg.powerPerLevel) || cfg.powerPerLevel < 0) fail('powerPerLevel must be a number >= 0');
  return cfg;
}

function buildSkillLevelingConfig(overrides = {}) {
  if (overrides == null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new SkillLevelingConfigError('overrides must be an object');
  }
  const merged = { ...DEFAULT_SKILL_LEVELING_CONFIG, ...overrides };
  validateSkillLevelingConfig(merged);
  return Object.freeze(merged);
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

// The gold price of reaching `level` (1-based): baseCost x costGrowth^(level-1),
// rounded once at the end so rounding never compounds. 0 for a level outside 1..max.
function costForLevel(level, cfg = SKILL_LEVELING_CONFIG) {
  const n = Math.floor(Number(level));
  if (!Number.isInteger(n) || n < 1 || n > cfg.maxLevel) return 0;
  return Math.round(cfg.baseCost * Math.pow(cfg.costGrowth, n - 1));
}

// The price of the NEXT level for a skill at `currentLevel`, or null at the cap.
function nextCost(currentLevel, cfg = SKILL_LEVELING_CONFIG) {
  const cur = clampLevel(currentLevel, cfg);
  return cur >= cfg.maxLevel ? null : costForLevel(cur + 1, cfg);
}

// The power multiplier of a skill at `level`: 1 at level 0, 1.15 at level 15.
function powerMultiplier(level, cfg = SKILL_LEVELING_CONFIG) {
  return Math.round((1 + cfg.powerPerLevel * clampLevel(level, cfg)) * 10000) / 10000;
}

// Can a player at `currentLevel` with `gold` buy the next level?
//   { ok: true, cost, level }  or  { ok: false, reason, cost? }
function checkUpgrade(currentLevel, gold, cfg = SKILL_LEVELING_CONFIG) {
  const cur = clampLevel(currentLevel, cfg);
  if (cur >= cfg.maxLevel) return { ok: false, reason: `this skill is already level ${cfg.maxLevel}` };
  const cost = costForLevel(cur + 1, cfg);
  const have = Number(gold);
  if (!Number.isFinite(have) || have < cost) return { ok: false, reason: 'not enough gold', cost };
  return { ok: true, cost, level: cur + 1 };
}

// The whole price list, for the client's tooltip and for tests.
function costTable(cfg = SKILL_LEVELING_CONFIG) {
  const out = [];
  for (let n = 1; n <= cfg.maxLevel; n += 1) out.push(costForLevel(n, cfg));
  return out;
}

function publicSkillLevelingConfig(cfg = SKILL_LEVELING_CONFIG) {
  return { maxLevel: cfg.maxLevel, powerPerLevel: cfg.powerPerLevel, costs: costTable(cfg) };
}

module.exports = {
  DEFAULT_SKILL_LEVELING_CONFIG, SKILL_LEVELING_CONFIG, SkillLevelingConfigError,
  validateSkillLevelingConfig, buildSkillLevelingConfig, loadSkillLevelingConfig,
  costForLevel, nextCost, powerMultiplier, checkUpgrade, costTable, publicSkillLevelingConfig,
};
