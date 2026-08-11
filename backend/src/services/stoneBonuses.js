// Buff-stone stat overlay (SOMET-245 Task 6). Overlays socketed buff-stone
// bonuses onto a progression-shaped object before derivePlayerStats runs.
// Never touches the persisted player_progression row -- this is a runtime
// overlay, recomputed on every derive, not a permanent stat change.

// SLOTS is the same equipped-slot list mitigation() (authority/items.js)
// walks -- imported rather than redeclared so the two can never drift apart
// on which slots count as "equipped".
const { SLOTS } = require('../authority/items.js');

// `buffStones` is Array<{stat_bonus_stat, stat_bonus_amount}>. Returns a
// shallow-copied progression-shaped object; never mutates the input.
function withStoneBonuses(progression, buffStones = []) {
  const result = { ...progression };
  for (const b of buffStones) {
    result[b.stat_bonus_stat] = (result[b.stat_bonus_stat] || 0) + b.stat_bonus_amount;
  }
  return result;
}

// Reads socketed buff stones off the SAME in-memory inv.items cache Task 4/5
// wrote (socketedStoneTypeId on each host item record) -- no DB query. A buff
// stone is any socketed stone whose type has stat_bonus_stat set (the
// complement of the spell-stone check in stones.js's stoneKind: a stone's
// element is set XOR its stat_bonus_stat is set, enforced by the
// item_types_stone_shape_check DB constraint from Task 1).
//
// Important #4 fix (SOMET-245 final review): this used to walk ALL of
// inv.items with no check against inv.equipment, unlike mitigation()
// (authority/items.js -- its own equipped-only walk, read in full before
// writing this fix) -- so a buff stone socketed into a weapon/armor piece
// sitting loose in the backpack contributed its bonus regardless of whether
// that item was ever equipped. With one socket per item and no cap on
// carried items, that let a player stack every buff stone they owned by
// socketing each into a spare item and never equipping any of them. Mirrors
// mitigation()'s own equipped-slots walk exactly: iterate SLOTS, resolve
// inv.equipment[slot] to the actual item, and only look at ITS socketed
// stone -- an item is counted at most once (one item can occupy at most one
// slot) and an item in the backpack (equipped nowhere) is never counted at
// all.
//
// Deliberately named differently from withStoneBonuses's `buffStones`
// parameter -- both live in this module and a shared name would shadow.
function socketedBuffStones(inv, itemTypes) {
  const out = [];
  for (const slot of SLOTS) {
    const itemId = inv.equipment[slot];
    if (!itemId) continue;
    // Inline equivalent of items.js's findItem(inv, itemId) -- that helper
    // is private to items.js (not exported: SLOTS is the only piece of its
    // equipped-slot logic meant to be shared), so this mirrors its one-line
    // body rather than reaching into another module's internals.
    const item = inv.items.find((it) => it.id === itemId);
    if (!item || item.socketedStoneTypeId == null) continue;
    const stoneType = itemTypes.get(item.socketedStoneTypeId);
    if (stoneType && stoneType.stat_bonus_stat != null) {
      out.push({ stat_bonus_stat: stoneType.stat_bonus_stat, stat_bonus_amount: stoneType.stat_bonus_amount });
    }
  }
  return out;
}

module.exports = { withStoneBonuses, socketedBuffStones };
