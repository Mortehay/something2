// Weapon enchanting: the rules for upgrading a weapon with an enchant scroll.
// PURE -- no database, no clock; the caller owns the dice (`rng`) and the state.
//
// THE RULES (after Lineage 2: sure safe zone, flat odds, a miss destroys the weapon):
//   * a weapon runs from +0 to +15;
//   * +1..+3 is the SAFE zone: it always succeeds, and a failure (should the
//     config ever allow one) costs the scroll and leaves the weapon untouched;
//   * +4..+15 is the DANGER zone: a failure BURNS the weapon and spends the scroll;
//   * each level adds a fixed share of the weapon's base damage;
//   * a +15 weapon cannot take another scroll.
//
// EVERYTHING TUNABLE IS IN DEFAULT_ENCHANT_CONFIG below, and `loadEnchantConfig`
// lets an operator override any of it with ENCHANT_CONFIG_JSON. A bad override is
// reported loudly and the defaults are used -- a typo in an env var must not take
// the enchanting screen down, and must not silently change the odds either, so the
// fallback is logged with the exact reason.

const DEFAULT_ENCHANT_CONFIG = Object.freeze({
  // The highest level a weapon can reach.
  maxLevel: 15,
  // Levels up to and including this one cannot destroy the weapon.
  safeMaxLevel: 3,
  // The chance (percent, 0..100) that a scroll takes a weapon FROM level N-1 TO level N, keyed by the
  // TARGET level N. Modelled on Lineage 2: a sure thing through the safe zone, then ONE flat chance
  // for every step (66%), so a long climb is a run of luck, not a wall that grows steeper each level.
  chances: Object.freeze({
    1: 100, 2: 100, 3: 100,
    4: 66, 5: 66, 6: 66, 7: 66, 8: 66, 9: 66, 10: 66, 11: 66, 12: 66, 13: 66, 14: 66, 15: 66,
  }),
  // Every level adds this fraction of the weapon's BASE damage (linear, not
  // compounding): +5 is +120%, +10 is +240%, +15 is +360% with the default of 0.24.
  damagePerLevel: 0.24,
  // The visual aura starts at this level (client + snapshot both read it).
  glowMinLevel: 4,
  // From +10 the aura turns from blue to fire red.
  glowFireLevel: 10,
  // The catalog item the scroll is, and what a merchant asks for it.
  scrollItemName: 'enchant_scroll',
  scrollPrice: 2000,
  // The BLESSED scroll (after Lineage 2): it can only be spent past the safe zone, and when it
  // fails the weapon is NOT burnt -- it falls back to the top of the safe zone instead.
  blessedScrollItemName: 'enchant_scroll_blessed',
  blessedScrollPrice: 6000,
  // A merchant pays back this share of the standard scroll price per enchant level, ON TOP
  // of the weapon's base value. Every level cost at least one scroll, so this stays far below
  // what was spent and enchanting cannot become a gold faucet.
  sellBackShare: 0.1,
  // Scrolls also DROP. Each source rolls `max` independent times at `chance`: ordinary
  // creatures rarely, a chest more often, a boss most of all (and up to twice).
  scrollDrops: Object.freeze({
    creature: Object.freeze({ chance: 0.005, max: 1 }),
    chest: Object.freeze({ chance: 0.03, max: 1 }),
    boss: Object.freeze({ chance: 0.125, max: 2 }),
  }),
  // Blessed scrolls drop far less often than standard ones, and never from ordinary creatures.
  blessedDrops: Object.freeze({
    creature: Object.freeze({ chance: 0, max: 0 }),
    chest: Object.freeze({ chance: 0.005, max: 1 }),
    boss: Object.freeze({ chance: 0.04, max: 1 }),
  }),
  // The most scrolls one purchase at the smith may buy.
  maxScrollPurchase: 20,
});

class EnchantConfigError extends Error {}

// Validates a COMPLETE config and returns it frozen. Throws EnchantConfigError
// naming the first thing wrong.
function validateEnchantConfig(cfg) {
  const fail = (why) => { throw new EnchantConfigError(why); };
  if (!cfg || typeof cfg !== 'object') fail('config must be an object');
  const { maxLevel, safeMaxLevel, chances, damagePerLevel, glowMinLevel, glowFireLevel, scrollItemName, scrollPrice } = cfg;
  if (!Number.isInteger(maxLevel) || maxLevel < 1 || maxLevel > 99) fail('maxLevel must be an integer in 1..99');
  if (!Number.isInteger(safeMaxLevel) || safeMaxLevel < 0 || safeMaxLevel > maxLevel) fail('safeMaxLevel must be an integer in 0..maxLevel');
  if (!chances || typeof chances !== 'object') fail('chances must be an object keyed by target level');
  for (let lvl = 1; lvl <= maxLevel; lvl += 1) {
    const c = chances[lvl];
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 100) fail(`chances[${lvl}] must be a number in 0..100`);
  }
  if (typeof damagePerLevel !== 'number' || !Number.isFinite(damagePerLevel) || damagePerLevel < 0) fail('damagePerLevel must be a number >= 0');
  if (!Number.isInteger(glowMinLevel) || glowMinLevel < 1 || glowMinLevel > maxLevel) fail('glowMinLevel must be an integer in 1..maxLevel');
  if (!Number.isInteger(glowFireLevel) || glowFireLevel < glowMinLevel || glowFireLevel > maxLevel) fail('glowFireLevel must be an integer in glowMinLevel..maxLevel');
  if (typeof scrollItemName !== 'string' || scrollItemName === '') fail('scrollItemName must be a non-empty string');
  if (!Number.isInteger(scrollPrice) || scrollPrice < 0) fail('scrollPrice must be an integer >= 0');
  if (typeof cfg.blessedScrollItemName !== 'string' || cfg.blessedScrollItemName === '' || cfg.blessedScrollItemName === scrollItemName) fail('blessedScrollItemName must be a non-empty string different from scrollItemName');
  if (!Number.isInteger(cfg.blessedScrollPrice) || cfg.blessedScrollPrice < scrollPrice) fail('blessedScrollPrice must be an integer >= scrollPrice');
  if (typeof cfg.sellBackShare !== 'number' || !Number.isFinite(cfg.sellBackShare) || cfg.sellBackShare < 0 || cfg.sellBackShare > 0.5) fail('sellBackShare must be a number in 0..0.5');
  for (const table of ['scrollDrops', 'blessedDrops']) {
    const drops = cfg[table];
    if (!drops || typeof drops !== 'object') fail(`${table} must be an object keyed by source`);
    for (const kind of ['creature', 'chest', 'boss']) {
      const d = drops[kind];
      if (!d || typeof d !== 'object') fail(`${table}.${kind} must be { chance, max }`);
      if (typeof d.chance !== 'number' || !Number.isFinite(d.chance) || d.chance < 0 || d.chance > 1) fail(`${table}.${kind}.chance must be a number in 0..1`);
      if (!Number.isInteger(d.max) || d.max < 0 || d.max > 10) fail(`${table}.${kind}.max must be an integer in 0..10`);
    }
  }
  if (!Number.isInteger(cfg.maxScrollPurchase) || cfg.maxScrollPurchase < 1 || cfg.maxScrollPurchase > 99) fail('maxScrollPurchase must be an integer in 1..99');
  return cfg;
}

// Merges a partial override over the defaults (chances merge per level) and
// validates the result.
function buildEnchantConfig(overrides = {}) {
  if (overrides == null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new EnchantConfigError('overrides must be an object');
  }
  const mergeDrops = (table) => {
    const od = overrides[table] || {};
    const out = {};
    for (const kind of ['creature', 'chest', 'boss']) {
      out[kind] = { ...DEFAULT_ENCHANT_CONFIG[table][kind], ...(od[kind] || {}) };
    }
    return out;
  };
  const scrollDrops = mergeDrops('scrollDrops');
  const blessedDrops = mergeDrops('blessedDrops');
  const merged = {
    ...DEFAULT_ENCHANT_CONFIG,
    ...overrides,
    chances: { ...DEFAULT_ENCHANT_CONFIG.chances, ...(overrides.chances || {}) },
    scrollDrops,
    blessedDrops,
  };
  validateEnchantConfig(merged);
  const freezeDrops = (drops) => {
    const out = {};
    for (const kind of Object.keys(drops)) out[kind] = Object.freeze({ ...drops[kind] });
    return Object.freeze(out);
  };
  return Object.freeze({
    ...merged,
    chances: Object.freeze({ ...merged.chances }),
    scrollDrops: freezeDrops(scrollDrops),
    blessedDrops: freezeDrops(blessedDrops),
  });
}

// The config the server runs with: defaults, plus ENCHANT_CONFIG_JSON if set and
// valid. `log` receives the reason when an override is ignored.
function loadEnchantConfig(env = process.env, log = console.error) {
  const raw = env && env.ENCHANT_CONFIG_JSON;
  if (!raw) return buildEnchantConfig();
  try {
    return buildEnchantConfig(JSON.parse(raw));
  } catch (err) {
    log(`ENCHANT_CONFIG_JSON ignored, using the defaults: ${err.message}`);
    return buildEnchantConfig();
  }
}

const ENCHANT_CONFIG = loadEnchantConfig();

function levelOf(item) {
  const n = Number(item && item.enchantLevel);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// The chance (0..1) that a scroll takes a weapon to `targetLevel`.
function successChance(targetLevel, cfg = ENCHANT_CONFIG) {
  const c = cfg.chances[targetLevel];
  return typeof c === 'number' ? c / 100 : 0;
}

// The damage multiplier a weapon at `level` gets: 1 at +0.
function damageMultiplier(level, cfg = ENCHANT_CONFIG) {
  const n = Math.max(0, Math.min(cfg.maxLevel, Math.floor(Number(level) || 0)));
  return Math.round((1 + cfg.damagePerLevel * n) * 10000) / 10000;
}

// Can this instance take another scroll? Returns { ok: true } or { ok: false, reason }.
// `itemType` is the catalog row; `item` the owned instance.
function checkEnchantable(item, itemType, cfg = ENCHANT_CONFIG) {
  if (!item || !itemType) return { ok: false, reason: 'you do not own that item' };
  if (itemType.category !== 'weapon') return { ok: false, reason: 'only weapons can be enchanted' };
  if (levelOf(item) >= cfg.maxLevel) return { ok: false, reason: `this weapon is already +${cfg.maxLevel}` };
  return { ok: true };
}

// Resolves one scroll use against a weapon at `level`. `rng` is () => [0,1).
//   { outcome: 'success', level }   the weapon is now `level`
//   { outcome: 'safe_fail', level } the scroll is spent, the weapon is unchanged
//   { outcome: 'destroyed', level } the scroll is spent and the weapon is gone
//   { outcome: 'reset', level }     a BLESSED scroll failed: the weapon survives at the top of the safe zone
// A weapon already at the cap is an error in the CALLER (checkEnchantable comes
// first), so it throws here rather than quietly returning something plausible.
function rollEnchant(level, rng = Math.random, cfg = ENCHANT_CONFIG, { blessed = false } = {}) {
  const current = Math.max(0, Math.floor(Number(level) || 0));
  if (current >= cfg.maxLevel) throw new RangeError(`cannot enchant past +${cfg.maxLevel}`);
  const target = current + 1;
  const roll = rng();
  if (roll < successChance(target, cfg)) return { outcome: 'success', level: target };
  if (target <= cfg.safeMaxLevel) return { outcome: 'safe_fail', level: current };
  return blessed
    ? { outcome: 'reset', level: cfg.safeMaxLevel }
    : { outcome: 'destroyed', level: current };
}

// The aura tier for a level: 0 (none), 1 (blue/turquoise), 2 (fire). Shared by the
// snapshot and the client so the two cannot disagree about when the glow starts.
function glowTier(level, cfg = ENCHANT_CONFIG) {
  const n = Math.floor(Number(level) || 0);
  if (n < cfg.glowMinLevel) return 0;
  return n >= cfg.glowFireLevel ? 2 : 1;
}

// -- scrolls: which one fits which level, and what a sale is worth -------------------------

// 'standard' | 'blessed' | null for a catalog item name.
function scrollKindOf(name, cfg = ENCHANT_CONFIG) {
  if (name === cfg.scrollItemName) return 'standard';
  if (name === cfg.blessedScrollItemName) return 'blessed';
  return null;
}

// Can a scroll called `name` be spent on a weapon that is at `level` now? The standard scroll
// works everywhere; the blessed one only for a target level PAST the safe zone, where a miss would
// otherwise burn the weapon (inside the safe zone it could not do anything and would just be wasted).
function scrollFits(name, level, cfg = ENCHANT_CONFIG) {
  const kind = scrollKindOf(name, cfg);
  if (kind === 'standard') return true;
  if (kind === 'blessed') return levelOf({ enchantLevel: level }) + 1 > cfg.safeMaxLevel;
  return false;
}

// What a scroll of this kind costs at the smith.
function scrollPriceOf(kind, cfg = ENCHANT_CONFIG) {
  return kind === 'blessed' ? cfg.blessedScrollPrice : cfg.scrollPrice;
}

// Gold a merchant ADDS to the sale price of a weapon for its enchant level. A share of the
// standard scroll price per level, so it is a fixed sum no matter how strong the weapon is.
function sellBonus(level, cfg = ENCHANT_CONFIG) {
  const n = Math.max(0, Math.min(cfg.maxLevel, Math.floor(Number(level) || 0)));
  return Math.floor(n * cfg.scrollPrice * cfg.sellBackShare);
}

// The expected cost of taking a fresh +0 weapon to `target`. The replacement WEAPON itself is not priced in.
//   * default: a standard scroll for every step; a miss in the danger zone burns the weapon and the
//     climb starts again from +0;
//   * { blessed: true }: standard scrolls through the safe zone, a blessed scroll for every danger-zone
//     step; a miss drops the weapon to the top of the safe zone and the climb resumes from there.
//   { scrolls, standard, blessed, gold }   (expected counts; fractional; Infinity when a step can never succeed)
function expectedCost(target, cfg = ENCHANT_CONFIG, { blessed = false } = {}) {
  const goal = Math.max(0, Math.min(cfg.maxLevel, Math.floor(Number(target) || 0)));
  // Past the safe zone only: a goal inside it cannot fail, so both strategies cost the same.
  const useBlessed = blessed && goal > cfg.safeMaxLevel;
  const restart = useBlessed ? cfg.safeMaxLevel : 0;
  // T_k = expected cost from level k, written a_k + b_k * X where X = T_restart closes the loop of
  // "missed, go back to the restart level". Solved from the goal down to the restart level, then X is
  // known and the rest (a sure climb through the safe zone) is walked down numerically.
  const solve = (weight) => {
    let a = 0; let b = 0;                      // at the goal nothing is left to buy
    for (let k = goal - 1; k >= restart; k -= 1) {
      const p = successChance(k + 1, cfg);
      const w = weight(k + 1);
      if (p <= 0) return Infinity;
      if (k + 1 <= cfg.safeMaxLevel) { a = (w + p * a) / p; /* b unchanged: a safe miss stays put */ } else {
        const na = w + p * a;
        const nb = p * b + (1 - p);
        a = na; b = nb;
      }
    }
    if (b >= 1) return Infinity;
    let t = a / (1 - b);                       // T_restart
    for (let k = restart - 1; k >= 0; k -= 1) {
      const p = successChance(k + 1, cfg);
      if (p <= 0) return Infinity;
      t = (weight(k + 1) + p * t) / p;
    }
    return t;
  };
  const danger = (lvl) => lvl > cfg.safeMaxLevel;
  const blessedCount = useBlessed ? solve((lvl) => (danger(lvl) ? 1 : 0)) : 0;
  const standard = solve((lvl) => (useBlessed && danger(lvl) ? 0 : 1));
  return {
    scrolls: standard + blessedCount, standard, blessed: blessedCount,
    gold: standard * cfg.scrollPrice + blessedCount * cfg.blessedScrollPrice,
  };
}

// What the client needs to draw the enchant UI and the odds, nothing more.
function publicEnchantConfig(cfg = ENCHANT_CONFIG) {
  return {
    maxLevel: cfg.maxLevel,
    safeMaxLevel: cfg.safeMaxLevel,
    chances: { ...cfg.chances },
    damagePerLevel: cfg.damagePerLevel,
    glowMinLevel: cfg.glowMinLevel,
    glowFireLevel: cfg.glowFireLevel,
    scrollItemName: cfg.scrollItemName,
    scrollPrice: cfg.scrollPrice,
    blessedScrollItemName: cfg.blessedScrollItemName,
    blessedScrollPrice: cfg.blessedScrollPrice,
    sellBackShare: cfg.sellBackShare,
    maxScrollPurchase: cfg.maxScrollPurchase,
  };
}

module.exports = {
  DEFAULT_ENCHANT_CONFIG, ENCHANT_CONFIG, EnchantConfigError,
  validateEnchantConfig, buildEnchantConfig, loadEnchantConfig,
  levelOf, successChance, damageMultiplier, checkEnchantable, rollEnchant, glowTier, publicEnchantConfig,
  scrollKindOf, scrollFits, scrollPriceOf, sellBonus, expectedCost,
};
