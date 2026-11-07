// backend/src/services/legacyEffects.js
//
// The Act IV permanent legacy choice (player_progression.legacy_choice) and
// what it does. One place, so the price a shop DISPLAYS and the price a
// purchase CHARGES cannot drift apart.
//
// Implemented:  city_restoration -> -15% on merchant purchases, sell fraction capped at 0.80.
// Not implemented: elemental_surge (+15% magic find / +20% yield). The game has
// no magic-find or mining mechanic to attach it to yet.

const { SELL_FRACTION_MAX } = require('./progressionConstants');

const CITY_RESTORATION_PRICE_MULT = 0.85;
// The most a merchant pays a City Restoration character, as a fraction of value.
// SOMET-755: it must stay below CITY_RESTORATION_PRICE_MULT, because the catalog never
// runs out and the 0.9 cap everyone else has made buy-then-sell print gold.
const CITY_RESTORATION_SELL_FRACTION_MAX = 0.8;

function vendorBuyPrice(price, legacyChoice) {
  const p = Number(price) || 0;
  if (p <= 0 || legacyChoice !== 'city_restoration') return p;
  return Math.max(1, Math.floor(p * CITY_RESTORATION_PRICE_MULT));
}

function sellFractionCap(legacyChoice) {
  return legacyChoice === 'city_restoration' ? CITY_RESTORATION_SELL_FRACTION_MAX : SELL_FRACTION_MAX;
}

async function loadLegacyChoice(db, characterId) {
  if (characterId == null) return null;
  const r = await db.query(
    'SELECT legacy_choice FROM player_progression WHERE character_id = $1',
    [characterId],
  );
  return r.rows[0] ? r.rows[0].legacy_choice : null;
}

module.exports = { vendorBuyPrice, sellFractionCap, loadLegacyChoice, CITY_RESTORATION_PRICE_MULT };

// Elemental Surge. The game has no mining, so the "yield" half of the bonus is
// gold dropped by creatures; the other half is magic find, applied to the
// rarity roll of every item the character's kills drop.
const ELEMENTAL_SURGE_MAGIC_FIND = 0.15;
const ELEMENTAL_SURGE_GOLD_MULT = 1.2;

function legacyMagicFind(legacyChoice) {
  return legacyChoice === 'elemental_surge' ? ELEMENTAL_SURGE_MAGIC_FIND : 0;
}

function legacyGoldAmount(amount, legacyChoice) {
  const a = Number(amount) || 0;
  return legacyChoice === 'elemental_surge' ? Math.round(a * ELEMENTAL_SURGE_GOLD_MULT) : a;
}

module.exports.legacyMagicFind = legacyMagicFind;
module.exports.legacyGoldAmount = legacyGoldAmount;
