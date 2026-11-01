// Weapon enchanting: the rules for upgrading a weapon with an enchant scroll.
// PURE -- no database, no clock; the caller owns the dice (`rng`) and the state.
//
// THE RULES (the product brief):
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
  // The chance (percent, 0..100) that a scroll takes a weapon FROM level N-1 TO
  // level N, keyed by the TARGET level N. +4 starts at 60% and falls to 1% at +15.
  chances: Object.freeze({
    1: 100, 2: 100, 3: 100,
    4: 60, 5: 50, 6: 40, 7: 30, 8: 20, 9: 15, 10: 10, 11: 7, 12: 5, 13: 3, 14: 2, 15: 1,
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
  // Scrolls also DROP. Each source rolls `max` independent times at `chance`: ordinary
  // creatures rarely, a chest more often, a boss most of all (and up to twice).
  scrollDrops: Object.freeze({
    creature: Object.freeze({ chance: 0.005, max: 1 }),
    chest: Object.freeze({ chance: 0.03, max: 1 }),
    boss: Object.freeze({ chance: 0.125, max: 2 }),
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
  const drops = cfg.scrollDrops;
  if (!drops || typeof drops !== 'object') fail('scrollDrops must be an object keyed by source');
  for (const kind of ['creature', 'chest', 'boss']) {
    const d = drops[kind];
    if (!d || typeof d !== 'object') fail(`scrollDrops.${kind} must be { chance, max }`);
    if (typeof d.chance !== 'number' || !Number.isFinite(d.chance) || d.chance < 0 || d.chance > 1) fail(`scrollDrops.${kind}.chance must be a number in 0..1`);
    if (!Number.isInteger(d.max) || d.max < 0 || d.max > 10) fail(`scrollDrops.${kind}.max must be an integer in 0..10`);
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
  const od = overrides.scrollDrops || {};
  const scrollDrops = {};
  for (const kind of ['creature', 'chest', 'boss']) {
    scrollDrops[kind] = { ...DEFAULT_ENCHANT_CONFIG.scrollDrops[kind], ...(od[kind] || {}) };
  }
  const merged = {
    ...DEFAULT_ENCHANT_CONFIG,
    ...overrides,
    chances: { ...DEFAULT_ENCHANT_CONFIG.chances, ...(overrides.chances || {}) },
    scrollDrops,
  };
  validateEnchantConfig(merged);
  const frozenDrops = {};
  for (const kind of Object.keys(scrollDrops)) frozenDrops[kind] = Object.freeze({ ...scrollDrops[kind] });
  return Object.freeze({
    ...merged, chances: Object.freeze({ ...merged.chances }), scrollDrops: Object.freeze(frozenDrops),
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
// A weapon already at the cap is an error in the CALLER (checkEnchantable comes
// first), so it throws here rather than quietly returning something plausible.
function rollEnchant(level, rng = Math.random, cfg = ENCHANT_CONFIG) {
  const current = Math.max(0, Math.floor(Number(level) || 0));
  if (current >= cfg.maxLevel) throw new RangeError(`cannot enchant past +${cfg.maxLevel}`);
  const target = current + 1;
  const roll = rng();
  if (roll < successChance(target, cfg)) return { outcome: 'success', level: target };
  return target <= cfg.safeMaxLevel
    ? { outcome: 'safe_fail', level: current }
    : { outcome: 'destroyed', level: current };
}

// The aura tier for a level: 0 (none), 1 (blue/turquoise), 2 (fire). Shared by the
// snapshot and the client so the two cannot disagree about when the glow starts.
function glowTier(level, cfg = ENCHANT_CONFIG) {
  const n = Math.floor(Number(level) || 0);
  if (n < cfg.glowMinLevel) return 0;
  return n >= cfg.glowFireLevel ? 2 : 1;
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
    maxScrollPurchase: cfg.maxScrollPurchase,
  };
}

module.exports = {
  DEFAULT_ENCHANT_CONFIG, ENCHANT_CONFIG, EnchantConfigError,
  validateEnchantConfig, buildEnchantConfig, loadEnchantConfig,
  levelOf, successChance, damageMultiplier, checkEnchantable, rollEnchant, glowTier, publicEnchantConfig,
};
