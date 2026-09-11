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

const TIER_ORDER = { I: 0, II: 1, III: 2, IV: 3 };

// Higher tiers of gear ladder weapons dropping from tough monsters
const RUNED_WEAPONS_BY_RUNG = [
  // Rung 0-1: Swarm, Skirmisher (Tier 1-2)
  [
    { item: 'crude-blade', chance: 0.22 }, { item: 'crude-spear', chance: 0.20 },
    { item: 'knife', chance: 0.22 }, { item: 'stick', chance: 0.22 }, { item: 'dagger', chance: 0.20 },
    { item: 'iron-blade', chance: 0.15 }, { item: 'iron-spear', chance: 0.15 },
  ],
  // Rung 2-3: Line, Heavy (Tier 2-3)
  [
    { item: 'iron-blade', chance: 0.20 }, { item: 'iron-spear', chance: 0.20 }, { item: 'iron-wand', chance: 0.20 },
    { item: 'steel-blade', chance: 0.15 }, { item: 'steel-spear', chance: 0.15 }, { item: 'steel-wand', chance: 0.15 },
  ],
  // Rung 4-5: Ranged, Caster (Tier 4-5)
  [
    { item: 'tempered-blade', chance: 0.15 }, { item: 'tempered-spear', chance: 0.15 }, { item: 'tempered-wand', chance: 0.15 },
    { item: 'runed-blade', chance: 0.12 }, { item: 'runed-spear', chance: 0.12 }, { item: 'runed-wand', chance: 0.12 },
  ],
  // Rung 6-7: Brute, Champion (Tier 6-8)
  [
    { item: 'obsidian-blade', chance: 0.12 }, { item: 'obsidian-spear', chance: 0.12 }, { item: 'obsidian-wand', chance: 0.12 },
    { item: 'astral-blade', chance: 0.10 }, { item: 'astral-spear', chance: 0.10 }, { item: 'astral-wand', chance: 0.10 },
    { item: 'void-blade', chance: 0.08 }, { item: 'void-spear', chance: 0.08 },
  ],
  // Rung 8: Apex / Boss (Tier 9-10)
  [
    { item: 'dragon-blade', chance: 0.09 }, { item: 'dragon-spear', chance: 0.09 }, { item: 'dragon-wand', chance: 0.09 },
    { item: 'mythic-blade', chance: 0.07 }, { item: 'mythic-spear', chance: 0.07 }, { item: 'mythic-wand', chance: 0.07 },
  ],
];

function tierIndex(tierToken) {
  const tiers = String(tierToken || 'I').split('-');
  return Math.max(...tiers.map((t) => TIER_ORDER[t] ?? 0));
}

function pickDropItem(element, tierToken, rungIndex = null) {
  // If rungIndex is explicitly supplied, scale weapon drops through the gear ladder
  if (rungIndex != null) {
    const r = Math.max(0, Math.min(8, Number(rungIndex) || 0));
    let bracket = 0;
    if (r <= 1) bracket = 0;
    else if (r <= 3) bracket = 1;
    else if (r <= 5) bracket = 2;
    else if (r <= 7) bracket = 3;
    else bracket = 4;

    const pool = RUNED_WEAPONS_BY_RUNG[bracket];
    // Deterministic selection based on element + rung
    const elemHash = (element ? String(element).charCodeAt(0) : 0) + r;
    const pick = pool[elemHash % pool.length];
    return { item: pick.item, chance: pick.chance, min_qty: 1, max_qty: 1 };
  }

  const idx = tierIndex(tierToken); // 0-3
  if (element && ELEMENT_STAFF[element]) {
    return { item: ELEMENT_STAFF[element], chance: 0.2, min_qty: 1, max_qty: 1 };
  }
  const bucketSize = Math.ceil(MELEE_BY_DAMAGE.length / 4);
  const bucket = MELEE_BY_DAMAGE.slice(idx * bucketSize, (idx + 1) * bucketSize);
  const pick = bucket[0] || MELEE_BY_DAMAGE[MELEE_BY_DAMAGE.length - 1];
  return { item: pick.item, chance: 0.2, min_qty: 1, max_qty: 1 };
}

module.exports = { pickDropItem };
