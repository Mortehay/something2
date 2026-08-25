// PURE rarity weighting (SOMET-481, progression epic T13).
//
// No database, no clock, no Math.random -- `rng` is injected, exactly as
// rollDrops/rollGold/rollItemInstance already do, so a drop is reproducible
// under test.
//
// The weight table is admin-editable (game_settings.rarity_weights), which is
// the whole reason normalisation is not optional: an admin who edits four
// numbers to something that does not sum to 100 must get a proportional
// distribution, not a broken roll that silently favours white because the
// cumulative never reaches 1.

const RARITIES = ['white', 'blue', 'yellow', 'foxy'];

// The identity result: everything is white. Returned for an empty, malformed
// or all-zero table -- a fallback that drops the whole rarity feature to "as
// before this epic" is strictly better than one that throws inside a drop, or
// one that returns a distribution summing to less than 1 and silently
// re-routes the missing mass to whichever grade the loop happens to end on.
function allWhite() { return { white: 1, blue: 0, yellow: 0, foxy: 0 }; }

function weightOf(row, grade) {
  const n = Number(row[grade]);
  // Negative weights are clamped to 0 rather than rejected: a negative entry
  // makes the distribution unrepresentable, and clamping keeps the other three
  // grades proportional instead of throwing inside a creature death.
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalise(raw) {
  let total = 0;
  for (const r of RARITIES) total += weightOf(raw, r);
  if (!(total > 0)) return allWhite();
  const out = {};
  for (const r of RARITIES) out[r] = weightOf(raw, r) / total;
  return out;
}

// Linear interpolation between the two anchors bracketing `itemLevel`, then
// normalisation. Below the first anchor and above the last, the nearest anchor
// is used unchanged -- extrapolating a linear fit past the table's ends
// produces negative weights, which is worse than clamping.
function interpolateWeights(itemLevel, anchors) {
  const rows = (Array.isArray(anchors) ? anchors : [])
    .filter((a) => a && typeof a === 'object' && Number.isFinite(Number(a.item_level)))
    .map((a) => ({ ...a, item_level: Number(a.item_level) }))
    .sort((a, b) => a.item_level - b.item_level);
  if (rows.length === 0) return allWhite();

  const lvl = Number(itemLevel);
  const l = Number.isFinite(lvl) ? lvl : rows[0].item_level;
  if (l <= rows[0].item_level) return normalise(rows[0]);
  if (l >= rows[rows.length - 1].item_level) return normalise(rows[rows.length - 1]);

  let lo = rows[0];
  let hi = rows[rows.length - 1];
  for (let i = 0; i < rows.length - 1; i += 1) {
    if (l >= rows[i].item_level && l <= rows[i + 1].item_level) {
      lo = rows[i]; hi = rows[i + 1]; break;
    }
  }
  const span = hi.item_level - lo.item_level;
  const t = span === 0 ? 0 : (l - lo.item_level) / span;
  const blended = {};
  for (const r of RARITIES) {
    const a = weightOf(lo, r);
    const b = weightOf(hi, r);
    blended[r] = a + (b - a) * t;
  }
  return normalise(blended);
}

// Walks the cumulative distribution in RARITIES order, so a higher rng never
// yields a worse grade -- the same monotonicity contract rollDrops/rollGold
// state. A grade with zero weight is unreachable at every rng value, including
// the very top of the range: the final fallback is the last grade that HAS
// weight, never simply "the last grade". That is what keeps criterion 4
// (a level-1 creature can never drop foxy, whose anchor weight is 0) true even
// when floating-point accumulation leaves the cumulative a hair under 1.
function rollRarity(itemLevel, anchors, rng = Math.random) {
  const w = interpolateWeights(itemLevel, anchors);
  const r = Number(rng());
  const roll = Number.isFinite(r) ? r : 0;
  let acc = 0;
  let last = 'white';
  for (const grade of RARITIES) {
    if (w[grade] > 0) last = grade;
    acc += w[grade];
    if (w[grade] > 0 && roll < acc) return grade;
  }
  return last;
}

module.exports = { interpolateWeights, rollRarity, RARITIES };
