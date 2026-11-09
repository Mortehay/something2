// PURE affix rolling (SOMET-480, progression epic T12; expanded Path-of-Exile style).
//
// No database, no clock, no Math.random -- `rng` is injected, exactly as
// rollDrops/rollGold already do, so a drop is reproducible under test.
//
// Rolls happen ONCE, at drop time, and are persisted per instance. Nothing
// re-rolls an item that already exists: a player who logs out and back in must
// not get a different item.
//
// What an item may roll, in order:
//   1. rarity decides HOW MANY affixes (AFFIX_COUNT_RANGE);
//   2. the catalog is narrowed to what can appear on THIS item: its slot, its family tags (a bow's
//      "+projectiles" never lands on a sword), its level, its rarity (eligibleAffixes);
//   3. affixes are drawn by weight, but an item carries at most MAX_PER_PLACEMENT prefixes and as many
//      suffixes, and never two affixes of one group (sampleAffixes);
//   4. each draw rolls a TIER the item level unlocks, and a value inside it (affixValue).

const { MAX_PER_PLACEMENT } = require('../../seeds/data/affixTypes.js');

const RARITIES = ['white', 'blue', 'yellow', 'foxy'];
const FOXY_VALUE_MULT = 1.25;
// How strongly a better tier is rarer than the one below it, and how a foxy item leans the other way.
const TIER_RARITY = 1.8;

// Grade -> affix count (spec §6.1). Three prefixes plus three suffixes make six, so foxy is capped by the
// item, not by the range: it asks for the maximum and gets a full item. foxy is the only grade that admits
// debuffs (see eligibleAffixes).
const AFFIX_COUNT_RANGE = {
  white: [0, 0],
  blue: [1, 1],
  yellow: [3, 6],
  foxy: [3, 9],
};

// Every family itemTags can put an item in: what an affix's allowed_tags may name.
const ITEM_TAGS = [
  'weapon', 'melee_weapon', 'ranged_weapon', 'caster_weapon', 'one_handed', 'two_handed', 'armor', 'ring',
  'main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2',
];

function rarityIndex(rarity) { return RARITIES.indexOf(rarity); }

function rarityAffixCount(rarity, rng = Math.random) {
  const range = AFFIX_COUNT_RANGE[rarity];
  if (!range) return 0;                 // an unknown grade grants nothing
  const [min, max] = range;
  if (max === min) return min;
  return min + Math.floor(rng() * (max - min + 1));
}

// The families an item belongs to, for affixes that only suit some of them. Derived from the catalog row
// (category, slot, kind, two_handed, name), never stored, so a new weapon is classified the moment it exists.
//   weapons   melee_weapon | ranged_weapon (bows, crossbows, slings, darts) | caster_weapon (staves, wands, scepters)
//             plus one_handed / two_handed
//   armour    armor, plus its slot; rings add ring
function itemTags(itemType) {
  const tags = new Set();
  if (!itemType) return tags;
  const name = String(itemType.name || '').toLowerCase();
  if (itemType.category === 'weapon') {
    tags.add('weapon');
    if (itemType.kind === 'melee') tags.add('melee_weapon');
    else if (/staff|wand|scepter|magic-bolt/.test(name)) tags.add('caster_weapon');
    else if (itemType.kind === 'projectile' || /bow|arbalest|sling|dart/.test(name)) tags.add('ranged_weapon');
    tags.add(itemType.two_handed ? 'two_handed' : 'one_handed');
  } else if (itemType.category === 'armor') {
    tags.add('armor');
  }
  if (itemType.slot) {
    tags.add(itemType.slot);
    if (itemType.slot === 'ring1' || itemType.slot === 'ring2') tags.add('ring');
  }
  return tags;
}

// Which catalog affixes may appear on THIS item.
//
// `allowed_slots` of [] means "any slot", matching the column's '{}' default --
// deliberately not "no slot", because an empty array is what an author who did
// not restrict the affix leaves behind. `allowed_tags` works the same way: [] is every item, otherwise the
// item must belong to AT LEAST ONE of the families listed.
//
// Debuffs are foxy-only. That is a rule about the GRADE, not about the pool, so
// it lives here rather than in the min_rarity column: an admin who sets a
// debuff's min_rarity to 'blue' must still not see it on blue items.
function eligibleAffixes(affixPool, { itemLevel, rarity, slot, tags = null }) {
  const lvl = Number(itemLevel) || 1;
  const rIdx = rarityIndex(rarity);
  return (affixPool || []).filter((a) => {
    if (!a) return false;
    if (Number(a.min_item_level || 1) > lvl) return false;
    if (a.max_item_level != null && Number(a.max_item_level) < lvl) return false;
    const slots = a.allowed_slots || [];
    if (slots.length > 0 && !slots.includes(slot)) return false;
    const wanted = a.allowed_tags || [];
    // `tags` is null when the caller has no item (a bare test pool): tag rules then cannot be judged, and
    // are not applied, which keeps every pre-tag caller exactly as it was.
    if (wanted.length > 0 && tags && !wanted.some((t) => tags.has(t))) return false;
    if (rIdx < rarityIndex(a.min_rarity || 'blue')) return false;
    if (a.kind === 'debuff' && rarity !== 'foxy') return false;
    return true;
  });
}

// The tiers of an affix, from its effect (where the catalog keeps them so they travel to the client with the
// rest of the effect), or null for an affix that has none.
function tiersOf(a) {
  const t = a && a.effect && a.effect.tiers;
  return Array.isArray(t) && t.length > 0 ? t : null;
}

// Picks one tier the item level unlocks. Better tiers are rarer; a foxy item leans toward them instead.
function rollTier(tiers, itemLevel, rarity, rng) {
  const lvl = Number(itemLevel) || 1;
  const open = [];
  tiers.forEach((t, i) => { if (Number(t.ilvl || 1) <= lvl) open.push(i); });
  if (open.length === 0) open.push(0);
  const weights = open.map((_, k) => (rarity === 'foxy' ? TIER_RARITY ** k : TIER_RARITY ** (open.length - 1 - k)));
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let k = 0; k < open.length; k += 1) {
    r -= weights[k];
    if (r < 0) return tiers[open[k]];
  }
  return tiers[open[open.length - 1]];
}

// A TIERED affix: a tier the item level unlocks, then min + rng()*(max-min) inside it (whole numbers when the
// effect says `int`). An UNTIERED one (the original twelve): value = min + rng()*(max-min), scaled by item level,
// then x1.25 for foxy.
//
// The level scale is measured from the affix's OWN min_item_level, not from 1:
// an affix authored to appear at level 40+ should not arrive already carrying
// forty levels of inflation on its first roll.
function affixValue(a, itemLevel, rarity, rng) {
  const tiers = tiersOf(a);
  if (tiers) {
    const tier = rollTier(tiers, itemLevel, rarity, rng);
    const raw = Number(tier.min) + rng() * (Number(tier.max) - Number(tier.min));
    if (a.effect && a.effect.int) return Math.round(raw);
    return Math.round(raw * 100) / 100;
  }
  const min = Number(a.min_value) || 0;
  const max = Number(a.max_value) || 0;
  const roll = min + rng() * (max - min);
  const scale = 1 + Math.max(0, (Number(itemLevel) || 1) - (Number(a.min_item_level) || 1)) / 100;
  const mult = rarity === 'foxy' ? FOXY_VALUE_MULT : 1;
  // Two decimals: player_item_affixes.value is `real`, and rounding here means
  // the rolled number and the stored number are the same number.
  return Math.round(roll * scale * mult * 100) / 100;
}

// Weighted sample WITHOUT replacement. One affix key cannot appear twice on one item; neither can two of a
// group; and once an item holds MAX_PER_PLACEMENT prefixes (or suffixes) no more of that kind are drawn.
// A chosen entry is removed before the next draw and the cumulative total is recomputed from what remains.
// Rows with no placement (a bare test pool, or a row from before the column) are not capped, only unique.
function sampleAffixes(pool, count, rng) {
  let remaining = [...pool];
  const out = [];
  const taken = { prefix: 0, suffix: 0 };
  for (let i = 0; i < count && remaining.length > 0; i += 1) {
    const total = remaining.reduce((s, a) => s + (Number(a.weight) || 0), 0);
    if (total <= 0) break;              // a pool of zero-weight rows picks nothing
    let r = rng() * total;
    let idx = remaining.length - 1;     // the fallthrough for a float landing on the end
    for (let j = 0; j < remaining.length; j += 1) {
      r -= Number(remaining[j].weight) || 0;
      if (r < 0) { idx = j; break; }
    }
    const pick = remaining[idx];
    out.push(pick);
    if (pick.placement === 'prefix' || pick.placement === 'suffix') taken[pick.placement] += 1;
    remaining = remaining.filter((a, j) => {
      if (j === idx) return false;
      if (pick.group_key && a.group_key === pick.group_key) return false;
      if ((a.placement === 'prefix' || a.placement === 'suffix') && taken[a.placement] >= MAX_PER_PLACEMENT) return false;
      return true;
    });
  }
  return out;
}

function rollItemInstance({ itemType, itemLevel, rarity, affixPool }, rng = Math.random) {
  const lvl = Number(itemLevel) || 1;
  const grade = AFFIX_COUNT_RANGE[rarity] ? rarity : 'white';
  const count = rarityAffixCount(grade, rng);
  if (count === 0) return { rarity: grade, itemLevel: lvl, affixes: [] };

  const slot = itemType ? itemType.slot : null;
  const tags = itemType ? itemTags(itemType) : null;
  const pool = eligibleAffixes(affixPool, { itemLevel: lvl, rarity: grade, slot, tags });
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
  rarityAffixCount, eligibleAffixes, rollItemInstance, itemTags, sampleAffixes, affixValue, rollTier,
  FOXY_VALUE_MULT, RARITIES, MAX_PER_PLACEMENT, AFFIX_COUNT_RANGE, ITEM_TAGS,
};
