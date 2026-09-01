// backend/src/services/statComposition.js
//
// PURE. No database, no clock, no randomness (contract §2).
//
// The single place a composed stat total or an itemised breakdown is produced.
// derivePlayerStats() keeps its job -- it is still the only place a DERIVED
// number (maxHp, meleeMult, ...) is computed: the six keys this returns at the
// top level are exactly the six it already reads off a progression row
// (playerStats.js), so the composed bundle is a drop-in substitute for the raw
// row. SOMET-495 added four AGGREGATES alongside them (`pools`, `damageMult`,
// `resists`, `hitStatuses`); each is a fact this module composes and somebody
// else applies, exactly like `rules`, and each names its consumer below.
//
// `sources` and `modifiers` exist so the Character tab never recomputes the
// breakdown. Recomputing it client-side is the drift that killed xpCurve.js.

const STAT_KEYS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];

// Matches progressionConstants.BASE_STAT. Re-declared rather than imported so
// this module stays free of the tunables file (it is PURE and the tunables file
// is where a future balance pass lands); the DB CHECK on player_progression
// already pins the value at >= 5 independently.
const BASE_STAT = 5;

// How two copies of the same rule combine, and the identity value each mode
// starts from. Duplicated from seeds/data/passiveTree.js's RULE_KEYS on
// purpose: that file is seed data the admin UI can outgrow, this one is the
// runtime contract. passive_rules.test.js asserts the two agree.
const RULE_COMBINE = {
  lifeCostMultiplier: 'product',
  treeCharmBonus: 'sum',
  cooldownFloor: 'min',
  regenLifeShare: 'sum',
  // SOMET-519. Attack rate, split in two so a Warrior's attack-speed nodes
  // cannot accelerate a socketed spell stone and a Mage's cast-speed nodes
  // cannot speed up a sword. `product` because each node is authored as a
  // multiplier (1.10 = +10%), so four of them compound rather than adding to
  // +40% -- which is what makes a cluster's fourth satellite still feel worth
  // taking. Read by world.js's applyAttackCooldown.
  attackSpeedMult: 'product',
  castSpeedMult: 'product',
};
const RULE_IDENTITY = { product: 1, sum: 0, min: null };

// SOMET-513. The "no tree context" rules map: every rule at its identity.
//
// Built from RULE_COMBINE at module load rather than written out by hand, so a
// rule added above is automatically present here at the right identity. A
// hand-maintained second literal is how a new rule ends up reaching a consumer
// as `undefined` -- which multiplies to NaN for a `product` rule, and NaN
// damage is an immortal target (see damage.js's own note).
//
// Frozen and shared, for the same reason NO_DAMAGE_MULT / NO_RESISTS /
// NO_STATUSES in playerStats.js are: it is handed to every progression row
// that has no tree context, and a mutable shared default is a cross-player
// leak waiting to happen.
const RULE_IDENTITIES = Object.freeze(
  Object.fromEntries(Object.entries(RULE_COMBINE).map(([key, mode]) => [key, RULE_IDENTITY[mode]])),
);

// SOMET-495. The other four grant kinds, each with the ONE consumer that reads
// the aggregate this module produces. Re-declared here rather than imported
// from seeds/data/passiveTree.js or from the authority for the same reason
// RULE_COMBINE is: seed data is what the admin UI can outgrow, and requiring
// authority/damage.js would drag effects.js (and its charm dependency) into a
// module whose whole contract is purity. passive_rules.test.js asserts each
// list agrees with its real owner, so a fifth element or a fourth status
// cannot be added on one side only.
//
//   POOL_KEYS    -> `pools`, FLAT additions consumed by playerStats.js's
//                   derivePlayerStats (maxHp / maxMana / maxStamina).
//   ELEMENT_KEYS -> `damageMult` and `resists`, consumed by world.js's
//                   weaponDamage and by items.js's mitigation respectively.
//   STATUS_KEYS  -> `hitStatuses`, consumed by effects.js's applyHitStatuses
//                   at every player hit site.
const POOL_KEYS = ['hp', 'mana', 'stamina'];
const ELEMENT_KEYS = ['physical', 'arcane', 'fire', 'ice', 'lightning'];
const STATUS_KEYS = ['burn', 'chill', 'shock'];

// `damage` and `resist` grants are authored in PERCENTAGE POINTS (+35 = +35%),
// because that is what their labels say: "Pyromancy -- +35% fire damage".
// Armour, however, stores a resistance as a FRACTION -- item_types.resistances
// {"arcane":0.3} is 30% -- and mitigation() merges the two into one map.
//
// So the conversion happens HERE, once, at the boundary between the authored
// scale and the runtime scale. Percentage points are summed as authored first
// and divided at the end: (6 + 8)/100 has no float residue, 0.06 + 0.08 does.
//
// Mixing the two scales would not be a rounding bug, it would be a factor of
// one hundred: a single +6 tree node left unconverted is worth twenty full
// sets of 0.3-resist armour, and nothing about the number would look wrong.
const PERCENT = 100;

// Round to 4dp without floating-point noise -- same reasoning as
// playerStats.js's round4: 0.75 * 0.8 is 0.6000000000000001, and an unrounded
// multiplier turns every life-cost assertion into a tolerance argument.
function round4(n) { return Math.round(n * 10000) / 10000; }

function baseOf(base, key) {
  const v = base == null ? undefined : base[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : BASE_STAT;
}

// A gear entry is { label, effect, value } where effect is an affix_types.effect
// row; a passive entry is a flattened passive_nodes.grants element that already
// carries its own type/value. Normalise both to one shape so the fold below has
// exactly one case to handle.
function normalise(entry, source) {
  const effect = entry.effect || entry;
  const value = Number(entry.value);
  return {
    source,
    label: String(entry.label == null ? '' : entry.label),
    kind: effect.type,
    stat: effect.stat,
    pool: effect.pool,
    element: effect.element,
    status: effect.status,
    rule: effect.rule,
    value: Number.isFinite(value) ? value : 0,
  };
}

// Which normalised field a grant kind's `detail` is read from. ONE table, read
// forwards by detailOf (compose) and backwards by modifierToEntry
// (recompose) -- two hand-written if-chains pointing opposite directions is
// how a `resource` grant survives a round trip as a pool-less modifier that
// silently stops adding to maxHp.
const DETAIL_KEY = {
  stat: 'stat',
  resource: 'pool',
  damage: 'element',
  resist: 'element',
  status: 'status',
  rule: 'rule',
};

function detailOf(m) {
  const key = DETAIL_KEY[m.kind];
  return key ? m[key] : null;
}

// The inverse of the `modifiers.push` below: a modifier back into the entry
// shape composeStats() accepts. Exists so a row that has ALREADY been composed
// can be recomposed with a new set of gear entries (gearAffixes.js's runtime
// overlay) without the caller having to re-read the passive tree from the
// database, and without a second, parallel fold that could drift from this
// module's.
//
// `detail` collapses stat/pool/element/status/rule into one field on the way
// out; DETAIL_KEY is what puts it back under the right name on the way in. A
// kind this module does not know keeps its label and value and lands as a
// caption-only modifier again, exactly as it did the first time.
function modifierToEntry(m) {
  const entry = { type: m.kind, value: m.value, label: m.label };
  const key = DETAIL_KEY[m.kind];
  if (key) entry[key] = m.detail;
  return entry;
}

function composeStats({ base, passives = [], gear = [] } = {}) {
  // Built from STAT_KEYS, never from Object.keys(base): `base` is a raw
  // player_progression row at every real call site and carries level,
  // experience and passive_points alongside the six stats.
  const sources = {};
  for (const k of STAT_KEYS) sources[k] = { base: baseOf(base, k), tree: 0, gear: 0 };

  const rules = {};
  for (const [key, mode] of Object.entries(RULE_COMBINE)) rules[key] = RULE_IDENTITY[mode];

  // SOMET-495 accumulators. Every element and pool key is present from the
  // start, at its identity, so a consumer reads `damageMult.fire` rather than
  // `(damageMult && damageMult.fire) || 1` at four call sites -- a missing key
  // read as `undefined` and multiplied is NaN damage, and damage.js's own NaN
  // note explains why NaN damage is an immortal target.
  const pools = {};
  for (const k of POOL_KEYS) pools[k] = 0;
  // Percentage POINTS while accumulating; converted to fractions/multipliers
  // once, at the end. See the PERCENT note above.
  const damagePct = {};
  const resistPct = {};
  for (const k of ELEMENT_KEYS) { damagePct[k] = 0; resistPct[k] = 0; }
  const statuses = new Set();

  const modifiers = [];
  const entries = [
    ...passives.map((p) => normalise(p, 'tree')),
    ...gear.map((g) => normalise(g, 'gear')),
  ];

  for (const m of entries) {
    if (m.kind === 'stat' && Object.prototype.hasOwnProperty.call(sources, m.stat)) {
      sources[m.stat][m.source] += m.value;
    } else if (m.kind === 'rule' && Object.prototype.hasOwnProperty.call(RULE_COMBINE, m.rule)) {
      const mode = RULE_COMBINE[m.rule];
      if (mode === 'product') rules[m.rule] = round4(rules[m.rule] * m.value);
      else if (mode === 'sum') rules[m.rule] += m.value;
      else rules[m.rule] = rules[m.rule] == null ? m.value : Math.min(rules[m.rule], m.value);
    } else if (m.kind === 'resource' && Object.prototype.hasOwnProperty.call(pools, m.pool)) {
      // FLAT, not percent: "+150 maximum life" is 150 hit points. Applied on
      // top of the class base AND the CON/INT scaling -- see derivePlayerStats.
      pools[m.pool] += m.value;
    } else if (m.kind === 'damage' && Object.prototype.hasOwnProperty.call(damagePct, m.element)) {
      // ADDITIVE between grants, multiplicative against the weapon: +35% and
      // +5% is x1.40, never x1.35 * 1.05. Summing the points HERE is what makes
      // that true by construction instead of by convention at the read site.
      damagePct[m.element] += m.value;
    } else if (m.kind === 'resist' && Object.prototype.hasOwnProperty.call(resistPct, m.element)) {
      // NEGATIVE VALUES ARE DELIBERATE. Keystone drawbacks author
      // `{element:'ice', value:-15}`; clamping them here would hand the player
      // the keystone's upside for free. The only floor is damage.js's
      // RESIST_FLOOR, which bounds the amplification rather than erasing it.
      resistPct[m.element] += m.value;
    } else if (m.kind === 'status' && STATUS_KEYS.includes(m.status)) {
      // A SET, not a count: "your hits burn" twice is still "your hits burn".
      // `value` is the authored 1 and means nothing beyond presence, which is
      // why nothing here reads it.
      statuses.add(m.status);
    }
    // Every entry becomes a modifier regardless of which total consumed it: the
    // Character tab lists them itemised and must not silently drop one.
    //
    // A modifier is a CAPTION, never the mechanism. Until SOMET-495 this list
    // was the only thing that read resource/damage/resist/status at all, while
    // the comment here claimed the item and combat code did -- 1419 of 2347
    // grants rendered a bonus the game never applied. If you add a grant kind:
    // the aggregate above is the wiring, this push is the caption.
    modifiers.push({
      label: m.label, value: m.value, source: m.source, kind: m.kind, detail: detailOf(m),
    });
  }

  const damageMult = {};
  const resists = {};
  for (const k of ELEMENT_KEYS) {
    damageMult[k] = round4(1 + damagePct[k] / PERCENT);
    resists[k] = round4(resistPct[k] / PERCENT);
  }
  // In STATUS_KEYS order, so two characters with the same allocation produce
  // byte-identical bundles regardless of the order their nodes were read in.
  const hitStatuses = STATUS_KEYS.filter((k) => statuses.has(k));

  const out = { sources, modifiers, rules, pools, damageMult, resists, hitStatuses };
  for (const k of STAT_KEYS) {
    const s = sources[k];
    // Floored at BASE_STAT because derivePlayerStats' own stat() guard already
    // treats anything below the base as "as if level 1" (playerStats.js:33-37).
    // Flooring here keeps the number the UI shows and the number the formulas
    // use identical; leaving it would show -15 STR and compute 5.
    out[k] = Math.max(BASE_STAT, Math.floor(s.base + s.tree + s.gear));
  }
  return out;
}

// Project a composeStats() bundle onto a progression-shaped row.
//
// THE ONE PLACE the composed row's shape is decided. passiveTreeStore's
// composeProgression builds the persisted/pushed row with it, and
// gearAffixes.js's runtime overlay rebuilds that same row with it -- so a
// gear-framed row and a bare composed row cannot differ in which fields they
// carry. Two hand-written projections is how the overlay ends up refreshing
// `pools` and forgetting `resists`, which nothing would notice until an
// affixed player took fire damage.
//
// The six TOP-LEVEL keys carry the effective totals, because that is what
// derivePlayerStats reads off a progression row (playerStats.js). `sources`
// keeps the raw class-base snapshot reachable as `sources.<stat>.base`.
function withComposedStats(row, composed) {
  const effective = {};
  for (const k of STAT_KEYS) effective[k] = composed[k];
  return {
    ...row,
    ...effective,
    effective,
    sources: composed.sources,
    modifiers: composed.modifiers,
    rules: composed.rules,
    pools: composed.pools,
    damageMult: composed.damageMult,
    resists: composed.resists,
    hitStatuses: composed.hitStatuses,
  };
}

module.exports = {
  composeStats, withComposedStats, modifierToEntry, detailOf,
  STAT_KEYS, RULE_COMBINE, RULE_IDENTITIES, BASE_STAT,
  POOL_KEYS, ELEMENT_KEYS, STATUS_KEYS, PERCENT, DETAIL_KEY,
};
