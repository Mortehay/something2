// backend/src/services/gearAffixes.js
//
// SOMET-496. The rolled affixes on a character's EQUIPPED items, folded onto a
// composed progression row at the frame boundary.
//
// WHY AN OVERLAY AND NOT A COMPOSE ARGUMENT
// -----------------------------------------
// composeStats() has always accepted `gear`, and composeProgression() -- its
// only caller -- has always passed `gear: []`. So `sources.*.gear` was
// structurally zero, no `source:'gear'` modifier could exist, and because
// derivePlayerStats reads the SAME composed row, an equipped +6 INT affix
// moved neither max mana nor the spell multiplier. Rendered in the panel,
// inert in play.
//
// The obvious fix -- hand composeProgression the gear -- is wrong, and this
// module exists because of what it would break. That row is what
// progressionStore.loadProgression returns, and world.js#_requirementContext
// builds the equip gate's `base` out of its six top-level keys. Folding gear
// into it would reopen the bootstrap hole SOMET-478 exists to close: an
// equipped item's own +20 STR would sit inside the base that
// equipRequirements#illegalEquipped measures it against, so the item would
// satisfy its own requirement and never be stripped by a respec. The gate's
// base must stay gear-free.
//
// So gear rides the same seam socketed buff stones already ride:
// stoneBonuses.js#withStoneBonuses, applied inside server.js's one frame
// boundary. The persisted row and the gating row are untouched; the runtime
// row -- the one the world derives from and the one the client renders --
// carries the gear.
//
// ORDER IS LOAD-BEARING: withGearAffixes REBUILDS the six top-level keys from
// `sources` and the tree modifiers, so anything already added to those keys by
// another overlay is discarded. Gear folds in FIRST, stones on top. server.js
// does it in that order and gear_affix_composition_db.test.js pins it with a
// character carrying both.

// SLOTS is the same equipped-slot list mitigation(), socketedBuffStones() and
// equipRequirements#gearStatGrants walk -- imported rather than redeclared so
// no two of them can drift on which slots count as "equipped".
const { SLOTS } = require('../authority/items.js');
const {
  composeStats, withComposedStats, modifierToEntry, STAT_KEYS,
} = require('./statComposition.js');

// Every affix on every EQUIPPED item, in composeStats' gear-entry shape
// ({label, effect, value}).
//
// Walks inv.equipment, never inv.items, for exactly the reason
// socketedBuffStones does: an affixed item sitting loose in the backpack must
// contribute nothing, or a player stacks every affix they own by carrying the
// items rather than wearing them.
//
// Deliberately NOT filtered to `effect.type === 'stat'` -- unlike
// equipRequirements#gearStatGrants, whose six numbers are the only thing the
// gate can use. Here a `resource`/`damage`/`resist`/`status` affix has a real
// consumer (playerStats' pools, world.js's weaponDamage, items.js's
// mitigation, effects.js's applyHitStatuses), and composeStats routes each to
// its own accumulator. Dropping them here would ship SOMET-495's defect again
// one layer down.
function equippedAffixGrants(inv) {
  const out = [];
  if (!inv || !inv.equipment || !Array.isArray(inv.items)) return out;
  for (const slot of SLOTS) {
    const itemId = inv.equipment[slot];
    if (!itemId) continue;
    const item = inv.items.find((it) => it.id === itemId);
    if (!item || !Array.isArray(item.affixes)) continue;
    for (const a of item.affixes) {
      if (!a || !a.effect || !a.effect.type) continue;
      // `label` is the catalog's display string ("of Insight"); `key` is its
      // slug. The fallback matters because the Character tab lists every
      // modifier by label, and a blank one reads as an unexplained number.
      out.push({ label: a.label || a.key || 'affix', effect: a.effect, value: a.value });
    }
  }
  return out;
}

// Recompose an already-composed progression row with `gear` folded in.
//
// RECOMPOSED, not merged. The inputs are recovered off the row -- the raw
// class-base snapshot from `sources.<stat>.base`, the tree's grants from the
// `source:'tree'` modifiers -- and composeStats is run again over all three
// halves. Merging gear INTO the finished totals would need a second copy of
// every combination rule composeStats owns (stat sums floor at BASE_STAT,
// damage points are additive before the /100, resists may be negative, rules
// combine by product/sum/min, statuses are a set). That second copy is the
// drift; there isn't one.
//
// Idempotent by construction: only `source:'tree'` modifiers are replayed, so
// applying this twice replaces the gear half rather than doubling it.
//
// A row with no `sources` (DEFAULT_PROGRESSION, a hand-built fixture, a raw
// player_progression row read before composition) has its six columns taken as
// the base and no tree -- which is exactly what those six columns mean.
function withGearAffixes(progression, gear = []) {
  if (!progression || !Array.isArray(gear) || gear.length === 0) return progression;
  const src = progression.sources;
  let base = progression;
  let passives = [];
  if (src && typeof src === 'object') {
    base = {};
    for (const k of STAT_KEYS) base[k] = src[k] ? src[k].base : undefined;
    passives = (Array.isArray(progression.modifiers) ? progression.modifiers : [])
      .filter((m) => m && m.source === 'tree')
      .map(modifierToEntry);
  }
  return withComposedStats(progression, composeStats({ base, passives, gear }));
}

module.exports = { equippedAffixGrants, withGearAffixes };
