'use strict';

// Village reputation and what it buys at that village's merchant.
//
// Standing is earned by completing the village's quests (questsService writes
// character_reputation). Here it is turned into the shop's perks:
//   - premium wares: stock rows with min_reputation > 0 are shown locked until
//     the player's standing reaches that number, then become buyable;
//   - a better sell price: `sellBonusPct` extra points on the fraction the
//     merchant pays, still clamped by SELL_FRACTION_MAX so it can never reach
//     the price the item is bought at (no buy-and-resell loop).
// There is deliberately NO purchase discount: with a discount a player could
// buy cheaper than the merchant buys back and print gold.
//
// The thresholds mirror questsService.REPUTATION_TIERS (a test pins that).

const TIERS = [
  { name: 'Stranger', at: 0, sellBonusPct: 0 },
  { name: 'Friend', at: 30, sellBonusPct: 5 },
  { name: 'Honored', at: 100, sellBonusPct: 10 },
  { name: 'Revered', at: 250, sellBonusPct: 15 },
];

// The premium wares: gear tier -> standing needed. Tier 1 stays open to all.
const PREMIUM_TIER_REPUTATION = { 2: 30, 3: 100, 4: 250 };

function tierFor(points) {
  const p = Number(points) || 0;
  let t = TIERS[0];
  for (const x of TIERS) if (p >= x.at) t = x;
  return t;
}

// The first tier above `points`, or null at the top.
function nextTierFor(points) {
  const p = Number(points) || 0;
  const t = TIERS.find((x) => x.at > p);
  return t ? { name: t.name, at: t.at } : null;
}

// The name of the lowest tier that reaches `minReputation`.
function tierNameFor(minReputation) {
  const m = Number(minReputation) || 0;
  const t = TIERS.find((x) => x.at >= m);
  return t ? t.name : TIERS[TIERS.length - 1].name;
}

// What the shop frame says about this player's standing here.
function shopReputation(villageKey, points) {
  const pts = Number(points) || 0;
  const tier = tierFor(pts);
  return {
    villageKey: villageKey || null,
    points: pts,
    tier: tier.name,
    discountPct: 0,
    sellBonusPct: tier.sellBonusPct,
    nextTier: nextTierFor(pts),
  };
}

// Standing with one village (by spec_key). A village with no key can never be
// earned, so it is always 0.
async function loadVillagePoints(db, characterId, villageKey) {
  if (characterId == null || !villageKey) return 0;
  const r = await db.query(
    'SELECT points FROM character_reputation WHERE character_id = $1 AND village_key = $2',
    [characterId, villageKey],
  );
  return r.rows.length ? Number(r.rows[0].points) || 0 : 0;
}

// The sell fraction with the reputation bonus added (percentage POINTS), never
// above `maxFraction`.
function boostedSellFraction(priceMult, points, maxFraction) {
  const m = Number(priceMult);
  const base = Number.isFinite(m) ? m : 0.5;
  return Math.min(maxFraction, base + tierFor(points).sellBonusPct / 100);
}

module.exports = {
  TIERS, PREMIUM_TIER_REPUTATION,
  tierFor, nextTierFor, tierNameFor, shopReputation, loadVillagePoints, boostedSellFraction,
};
