// backend/scripts/bestiary/derive.js
//
// Pure derivation rules for per-rung resistance and level-band placement, per the
// "Resistances" and "Depth tiers and bands" sections of
// docs/superpowers/specs/2026-08-06-bestiary-program-design.md. The umbrella states shape
// and ranges ("primary element at .4-.7", "strong ... plus partial physical", a tier's
// [min, max] band) rather than exact per-rung numbers. The constants below are this file's
// documented judgment call within those stated ranges -- see comments on each constant, and
// task-2-report.md for the full writeup.
const { TIER_BANDS } = require('./template');

// Which resistance tier each rung falls into (umbrella "Resistances" section, bullet order).
const RESISTANCE_TIER = {
  Swarm: 'none',
  Skirmisher: 'weak',
  Line: 'primary',
  Ranged: 'primary',
  Caster: 'primary',
  Brute: 'strong',
  Heavy: 'strong',
  Champion: 'strong',
  Apex: 'strong',
};

// Skirmisher's single "weak" resistance. The umbrella doesn't give a range for "weak" (just
// the word), so this picks a value clearly below the primary-tier floor (.4) -- present
// enough to matter, low enough that Skirmisher still "dies to anything" as the spec intends.
const WEAK_VALUE = 0.2;

// Primary-tier (Line/Ranged/Caster) single-element resistance, within the umbrella's stated
// .4-.7 band. Split by each rung's *role* (from the rung table's mechanic column,
// template.js RUNGS), not by rung index order:
//   - Ranged ("projectile attack"): a kiting/positioning rung that leans on range rather than
//     tankiness -> sits at the range floor.
//   - Line ("core melee body"): the line's generic representative rung -> sits at the range
//     midpoint.
//   - Caster ("elemental ranged ability"): the rung whose kit is explicitly built around the
//     line's element -> sits at the range ceiling.
const PRIMARY_VALUE = { Ranged: 0.4, Line: 0.55, Caster: 0.7 };

// Strong-tier (Brute/Heavy/Champion/Apex) primary-element resistance. Unlike the primary
// tier (split by role, see above), this scales by rung index/toughness (Brute < Heavy <
// Champion < Apex), mirroring the rung table's own monotonic hp/def progression (48/60/85/130
// hp, 5/8/9/13 def). The umbrella's "strong" isn't a stated numeric range, so this picks a
// floor (.6) close to the primary tier's own values and a ceiling (.8) reserved for Apex
// alone, so the toughest boss rung reads as strictly the best-resisted creature in its line.
const STRONG_VALUE = { Brute: 0.6, Heavy: 0.65, Champion: 0.7, Apex: 0.8 };

// Strong-tier's "plus partial physical" figure: always below that rung's primary-element
// value (it's explicitly secondary), and rises gently with toughness. Champion and Apex share
// a .3 ceiling since "partial" means this isn't meant to keep climbing toward the primary
// value.
const STRONG_PHYSICAL_PARTIAL = { Brute: 0.2, Heavy: 0.25, Champion: 0.3, Apex: 0.3 };

// Void/Eldritch ("all four elements, partial" -- umbrella's special case, not one of the
// per-line primary elements). One flat value per resistance tier (strong tier still scales
// per rung, matching the strong-tier pattern above). Each figure sits below its single-element
// equivalent at the same tier: spreading resistance across all four elements instead of one
// is strictly more total coverage, so the discount per element is intentional, not an
// oversight.
const ALL_FOUR_VALUE = {
  none: 0,
  weak: 0.15,
  primary: 0.3,
  strong: { Brute: 0.35, Heavy: 0.4, Champion: 0.45, Apex: 0.5 },
};

function deriveResistances(rungName, element, opts = {}) {
  const tier = RESISTANCE_TIER[rungName];

  if (opts.allFourPartial) {
    const value = tier === 'strong' ? ALL_FOUR_VALUE.strong[rungName] : ALL_FOUR_VALUE[tier];
    if (!value) return {};
    return { physical: value, fire: value, ice: value, lightning: value };
  }

  if (element == null) return {};
  if (tier === 'none') return {};
  if (tier === 'weak') return { [element]: WEAK_VALUE };
  if (tier === 'primary') return { [element]: PRIMARY_VALUE[rungName] };
  // strong
  return { [element]: STRONG_VALUE[rungName], physical: STRONG_PHYSICAL_PARTIAL[rungName] };
}

function deriveLevelBand(tierToken, rungIndex) {
  // A tier token is either a single tier ("I") or a span ("I-II"). Combine the referenced
  // tiers' ranges into one [min, max], then place this rung within it -- Swarm (index 0) near
  // the floor, Apex (index 8) near the ceiling, linear across the 9 rungs. Each rung gets a
  // narrow slice (roughly span/9 wide, at least 1) rather than the full tier range, so a
  // creature's level is anchored near where its rung sits in the progression instead of
  // spanning the whole tier.
  const tiers = tierToken.split('-');
  const ranges = tiers.map((t) => TIER_BANDS[t]);
  const min = Math.min(...ranges.map((r) => r[0]));
  const max = Math.max(...ranges.map((r) => r[1]));
  const span = max - min;
  const bandFloor = Math.round(min + (span * rungIndex) / 8);
  const bandCeil = Math.min(max, bandFloor + Math.max(1, Math.round(span / 9)));
  return { min: bandFloor, max: bandCeil };
}

module.exports = { deriveResistances, deriveLevelBand };
