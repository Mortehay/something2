// backend/src/services/statComposition.js
//
// PURE. No database, no clock, no randomness (contract §2).
//
// The single place a composed stat total or an itemised breakdown is produced.
// derivePlayerStats() keeps its job -- it is still the only place a DERIVED
// number (maxHp, meleeMult, ...) is computed -- and it needs no change: the six
// keys this returns at the top level are exactly the six it already reads off a
// progression row (playerStats.js:41-60), so the composed bundle is a drop-in
// substitute for the raw row.
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
};
const RULE_IDENTITY = { product: 1, sum: 0, min: null };

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

function detailOf(m) {
  if (m.kind === 'stat') return m.stat;
  if (m.kind === 'resource') return m.pool;
  if (m.kind === 'damage' || m.kind === 'resist') return m.element;
  if (m.kind === 'status') return m.status;
  if (m.kind === 'rule') return m.rule;
  return null;
}

function composeStats({ base, passives = [], gear = [] } = {}) {
  // Built from STAT_KEYS, never from Object.keys(base): `base` is a raw
  // player_progression row at every real call site and carries level,
  // experience and passive_points alongside the six stats.
  const sources = {};
  for (const k of STAT_KEYS) sources[k] = { base: baseOf(base, k), tree: 0, gear: 0 };

  const rules = {};
  for (const [key, mode] of Object.entries(RULE_COMBINE)) rules[key] = RULE_IDENTITY[mode];

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
    }
    // Every entry becomes a modifier regardless of whether a total consumed it:
    // resource/damage/resist/status grants have no total in this module (they
    // are read by the item and combat code) and the Character tab must still
    // list them, itemised, rather than silently dropping them.
    modifiers.push({
      label: m.label, value: m.value, source: m.source, kind: m.kind, detail: detailOf(m),
    });
  }

  const out = { sources, modifiers, rules };
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

module.exports = { composeStats, STAT_KEYS, RULE_COMBINE, BASE_STAT };
