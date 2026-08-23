// PURE affix rolling (SOMET-480, progression epic T12).
//
// No database, no clock, no Math.random -- `rng` is injected, exactly as
// rollDrops/rollGold already do, so a drop is reproducible under test.
//
// Rolls happen ONCE, at drop time, and are persisted per instance. Nothing
// re-rolls an item that already exists: a player who logs out and back in must
// not get a different item.

const RARITIES = ['white', 'blue', 'yellow', 'foxy'];
const FOXY_VALUE_MULT = 1.25;

// Grade -> affix count (spec §6.1). foxy is the only grade whose ceiling is
// above yellow's, and the only one that admits debuffs (see eligibleAffixes).
const AFFIX_COUNT_RANGE = {
  white: [0, 0],
  blue: [1, 1],
  yellow: [3, 6],
  foxy: [3, 9],
};

function rarityIndex(rarity) { return RARITIES.indexOf(rarity); }

function rarityAffixCount(rarity, rng = Math.random) {
  const range = AFFIX_COUNT_RANGE[rarity];
  if (!range) return 0;                 // an unknown grade grants nothing
  const [min, max] = range;
  if (max === min) return min;
  return min + Math.floor(rng() * (max - min + 1));
}

// Which catalog affixes may appear on THIS item.
//
// `allowed_slots` of [] means "any slot", matching the column's '{}' default --
// deliberately not "no slot", because an empty array is what an author who did
// not restrict the affix leaves behind.
//
// Debuffs are foxy-only. That is a rule about the GRADE, not about the pool, so
// it lives here rather than in the min_rarity column: an admin who sets a
// debuff's min_rarity to 'blue' must still not see it on blue items.
function eligibleAffixes(affixPool, { itemLevel, rarity, slot }) {
  const lvl = Number(itemLevel) || 1;
  const rIdx = rarityIndex(rarity);
  return (affixPool || []).filter((a) => {
    if (!a) return false;
    if (Number(a.min_item_level || 1) > lvl) return false;
    if (a.max_item_level != null && Number(a.max_item_level) < lvl) return false;
    const slots = a.allowed_slots || [];
    if (slots.length > 0 && !slots.includes(slot)) return false;
    if (rIdx < rarityIndex(a.min_rarity || 'blue')) return false;
    if (a.kind === 'debuff' && rarity !== 'foxy') return false;
    return true;
  });
}

// value = min + rng()*(max-min), scaled by item level, then x1.25 for foxy.
//
// The level scale is measured from the affix's OWN min_item_level, not from 1:
// an affix authored to appear at level 40+ should not arrive already carrying
// forty levels of inflation on its first roll.
function affixValue(a, itemLevel, rarity, rng) {
  const min = Number(a.min_value) || 0;
  const max = Number(a.max_value) || 0;
  const roll = min + rng() * (max - min);
  const scale = 1 + Math.max(0, (Number(itemLevel) || 1) - (Number(a.min_item_level) || 1)) / 100;
  const mult = rarity === 'foxy' ? FOXY_VALUE_MULT : 1;
  // Two decimals: player_item_affixes.value is `real`, and rounding here means
  // the rolled number and the stored number are the same number.
  return Math.round(roll * scale * mult * 100) / 100;
}

// Weighted sample WITHOUT replacement. One affix key cannot appear twice on one
// item, so a chosen entry is spliced out before the next draw and the cumulative
// total is recomputed from what remains.
function sampleAffixes(pool, count, rng) {
  const remaining = [...pool];
  const out = [];
  for (let i = 0; i < count && remaining.length > 0; i += 1) {
    const total = remaining.reduce((s, a) => s + (Number(a.weight) || 0), 0);
    if (total <= 0) break;              // a pool of zero-weight rows picks nothing
    let r = rng() * total;
    let idx = remaining.length - 1;     // the fallthrough for a float landing on the end
    for (let j = 0; j < remaining.length; j += 1) {
      r -= Number(remaining[j].weight) || 0;
      if (r < 0) { idx = j; break; }
    }
    out.push(remaining[idx]);
    remaining.splice(idx, 1);
  }
  return out;
}

function rollItemInstance({ itemType, itemLevel, rarity, affixPool }, rng = Math.random) {
  const lvl = Number(itemLevel) || 1;
  const grade = AFFIX_COUNT_RANGE[rarity] ? rarity : 'white';
  const count = rarityAffixCount(grade, rng);
  if (count === 0) return { rarity: grade, itemLevel: lvl, affixes: [] };

  const slot = itemType ? itemType.slot : null;
  const pool = eligibleAffixes(affixPool, { itemLevel: lvl, rarity: grade, slot });
  const chosen = sampleAffixes(pool, count, rng);
  return {
    rarity: grade,
    itemLevel: lvl,
    affixes: chosen.map((a) => ({
      affixTypeId: a.id,
      key: a.key,
      value: affixValue(a, lvl, grade, rng),
    })),
  };
}

module.exports = {
  rarityAffixCount, eligibleAffixes, rollItemInstance, FOXY_VALUE_MULT, RARITIES,
};
