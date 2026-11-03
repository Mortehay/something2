#!/usr/bin/env node
// Prints what it costs, on average, to take a fresh weapon to each enchant level -- so the odds,
// the scroll prices and the damage per level can be tuned against each other with numbers instead of
// by feel. Uses the live config (ENCHANT_CONFIG_JSON is honoured).
//
//   node scripts/enchant-cost.js          (or `make enchant-cost`)
//
// Two strategies are shown. PLAIN: standard scrolls only, and a miss past the safe zone burns the
// weapon so the climb starts over from +0. BLESSED: standard scrolls through the safe zone, blessed
// scrolls beyond it, and a miss only drops the weapon back to the top of the safe zone. The
// replacement weapon itself is not priced in, and neither are scroll drops -- both only lower the real cost.
const enchant = require('../src/services/enchant.js');

const cfg = enchant.ENCHANT_CONFIG;
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : 'never');
const one = (n) => (Number.isFinite(n) ? n.toFixed(1) : 'inf');
const rows = [['level', 'chance', 'damage', 'plain scrolls', 'plain gold', 'blessed: std', 'blessed: bless', 'blessed gold', 'sells for +']];
for (let lvl = 1; lvl <= cfg.maxLevel; lvl += 1) {
  const plain = enchant.expectedCost(lvl, cfg);
  const bl = enchant.expectedCost(lvl, cfg, { blessed: true });
  rows.push([
    `+${lvl}`, `${cfg.chances[lvl]}%`, `x${enchant.damageMultiplier(lvl, cfg)}`,
    one(plain.standard), fmt(plain.gold), one(bl.standard), one(bl.blessed), fmt(bl.gold), fmt(enchant.sellBonus(lvl, cfg)),
  ]);
}
const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
for (const r of rows) console.log(r.map((v, i) => String(v).padStart(widths[i])).join('  '));
console.log(`\nscroll prices: standard ${cfg.scrollPrice}g, blessed ${cfg.blessedScrollPrice}g (safe zone up to +${cfg.safeMaxLevel})`);
