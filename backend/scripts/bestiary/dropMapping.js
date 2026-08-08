// backend/scripts/bestiary/dropMapping.js
//
// Pure line-element/tier -> drop-item mapping, used by Task 4 to generate one drop rule per
// creature. Draws from the existing item_types weapon catalog (melee/projectile kinds), using
// damage as a tier proxy since the catalog has no explicit tier column.
//
// Verified against the LIVE dev database on 2026-08-08 via:
//   SELECT name, kind, element, damage FROM item_types
//   WHERE kind IN ('melee','projectile') ORDER BY kind, damage;
// Result matched the plan's snapshot exactly -- same 12 melee items at the same damage values,
// and the same three elemental staves (flame/frost/storm). No drift to report for this task. If
// this ever runs against a database where a name below no longer exists in item_types, that's
// real catalog drift -- report it, don't silently substitute.
const MELEE_BY_DAMAGE = [
  { item: 'stick', damage: 7 }, { item: 'knife', damage: 6 }, { item: 'dagger', damage: 8 },
  { item: 'club', damage: 10 }, { item: 'short sword', damage: 11 }, { item: 'mid club', damage: 14 },
  { item: 'long sword', damage: 15 }, { item: 'morning star', damage: 17 }, { item: 'pike', damage: 19 },
  { item: 'scythe', damage: 20 }, { item: 'two-handed sword', damage: 22 }, { item: 'halberd', damage: 18 },
].sort((a, b) => a.damage - b.damage);

const ELEMENT_STAFF = { fire: 'flame staff', ice: 'frost staff', lightning: 'storm staff' };
// Arcane items (apprentice staff, archmage staff, magic-bolt) exist in the catalog but have no
// matching line element in the umbrella's four-element system -- they're not used by this
// mapping. A physical-element (or no-element) line never needs "arcane": pickDropItem only
// looks up ELEMENT_STAFF for fire/ice/lightning.

const TIER_ORDER = { I: 0, II: 1, III: 2, IV: 3 };

function tierIndex(tierToken) {
  // A span like "II-III" uses its HIGHER tier for drop-power purposes -- a line that reaches
  // into a deeper tier should be able to drop that tier's gear at its higher rungs.
  const tiers = tierToken.split('-');
  return Math.max(...tiers.map((t) => TIER_ORDER[t]));
}

function pickDropItem(element, tierToken) {
  const idx = tierIndex(tierToken); // 0-3
  if (element && ELEMENT_STAFF[element]) {
    // Element-themed lines always drop their matching staff -- a fire-line creature drops a
    // flame staff regardless of tier, since the theme match matters more than power scaling
    // for a per-type flavour drop (the rung-level gold/loot fallback from P2b already covers
    // power scaling).
    return { item: ELEMENT_STAFF[element], chance: 0.2, min_qty: 1, max_qty: 1 };
  }
  // Physical or null element: pick a melee weapon whose damage bucket matches the tier. 12
  // melee items split into 4 tier-sized buckets (3 items each, ascending by damage): tier I
  // gets the lowest-damage bucket (knife/stick/dagger), tier IV the highest
  // (pike/scythe/two-handed sword). Each bucket's cheapest/first item is the pick, keeping one
  // deterministic result per (element, tier) pair.
  const bucketSize = Math.ceil(MELEE_BY_DAMAGE.length / 4);
  const bucket = MELEE_BY_DAMAGE.slice(idx * bucketSize, (idx + 1) * bucketSize);
  const pick = bucket[0] || MELEE_BY_DAMAGE[MELEE_BY_DAMAGE.length - 1];
  return { item: pick.item, chance: 0.2, min_qty: 1, max_qty: 1 };
}

module.exports = { pickDropItem };
