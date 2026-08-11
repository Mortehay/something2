// Buff-stone stat overlay (SOMET-245 Task 6). Overlays socketed buff-stone
// bonuses onto a progression-shaped object before derivePlayerStats runs.
// Never touches the persisted player_progression row -- this is a runtime
// overlay, recomputed on every derive, not a permanent stat change.

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
// Deliberately named differently from withStoneBonuses's `buffStones`
// parameter -- both live in this module and a shared name would shadow.
function socketedBuffStones(inv, itemTypes) {
  const out = [];
  for (const item of inv.items) {
    if (item.socketedStoneTypeId == null) continue;
    const stoneType = itemTypes.get(item.socketedStoneTypeId);
    if (stoneType && stoneType.stat_bonus_stat != null) {
      out.push({ stat_bonus_stat: stoneType.stat_bonus_stat, stat_bonus_amount: stoneType.stat_bonus_amount });
    }
  }
  return out;
}

module.exports = { withStoneBonuses, socketedBuffStones };
