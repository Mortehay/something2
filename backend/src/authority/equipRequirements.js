// PURE requirement evaluation for equipment (SOMET-478, progression epic T10).
// No database, no clock, no rng -- the caller supplies the character's base
// stats and level.
//
// The one rule that makes this module necessary rather than a two-line check:
// requirements are evaluated against effective stats EXCLUDING the candidate
// item's own grants. Without that, an item granting +20 STR satisfies its own
// 20-STR requirement and a chain of stat-granting items bootstraps a level-1
// character into endgame gear.

const { SLOTS } = require('./items.js');

const REQ_STATS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];

function zeroStats() {
  return {
    strength: 0, dexterity: 0, constitution: 0, intelligence: 0, wisdom: 0, charisma: 0,
  };
}

// What EQUIPPED gear currently grants, optionally ignoring one instance.
//
// Walks inv.equipment (never inv.items) for the same reason
// stoneBonuses.js#socketedBuffStones does: an item sitting loose in the
// backpack must contribute nothing, or a player stacks every buff stone they
// own by socketing each into a spare item and equipping none of them.
//
// Gear-borne stat grants come from TWO sources: a socketed buff stone, and
// (SOMET-480 / T12) the instance's rolled affixes. Both are read HERE, in the
// one function that answers "what do my items give me" -- a second
// implementation is how the requirement gate and the character sheet end up
// disagreeing about a player's strength.
function gearStatGrants(inv, itemTypes, excludeItemId = null) {
  const out = zeroStats();
  if (!inv || !inv.equipment || !Array.isArray(inv.items)) return out;
  for (const slot of SLOTS) {
    const itemId = inv.equipment[slot];
    if (!itemId || itemId === excludeItemId) continue;
    const item = inv.items.find((it) => it.id === itemId);
    if (!item) continue;
    if (item.socketedStoneTypeId != null) {
      const stoneType = itemTypes.get(item.socketedStoneTypeId);
      if (stoneType && stoneType.stat_bonus_stat != null
          && Object.prototype.hasOwnProperty.call(out, stoneType.stat_bonus_stat)) {
        out[stoneType.stat_bonus_stat] += Number(stoneType.stat_bonus_amount) || 0;
      }
    }
    // SOMET-480: rolled affixes. Only {type:'stat'} affixes move these six
    // numbers; a resource/damage/resist/status affix is read elsewhere and
    // must NOT silently land on a stat here.
    for (const a of item.affixes || []) {
      const eff = a && a.effect;
      if (!eff || eff.type !== 'stat') continue;
      if (!Object.prototype.hasOwnProperty.call(out, eff.stat)) continue;
      out[eff.stat] += Number(a.value) || 0;
    }
  }
  return out;
}

// base + gear. `base` is whatever the caller considers the character's
// non-gear total: today player_progression's six columns, and after Group C's
// T7 the composeStats() total of class base + passive tree. This module does
// not care which, which is exactly why it takes it as a parameter.
function effectiveStatsFor(inv, itemTypes, base, { excludeItemId = null } = {}) {
  const gear = gearStatGrants(inv, itemTypes, excludeItemId);
  const out = zeroStats();
  for (const s of REQ_STATS) out[s] = (Number(base && base[s]) || 0) + gear[s];
  return out;
}

// {ok:true} or {ok:false, reason}. A type with no requirement columns (a test
// fixture, or a catalog snapshot predating the migration) reads as no
// requirement -- the columns are NOT NULL in the schema, so a missing value
// here can only mean "not a real catalog row".
function meetsRequirements(type, level, stats) {
  if (!type) return { ok: false, reason: 'unknown item type' };
  const reqLevel = Number(type.req_level) || 0;
  if (reqLevel > (Number(level) || 0)) {
    return { ok: false, reason: `requires level ${reqLevel}` };
  }
  for (const s of REQ_STATS) {
    const need = Number(type[`req_${s}`]) || 0;
    if (need > (Number(stats && stats[s]) || 0)) {
      return { ok: false, reason: `requires ${need} ${s}` };
    }
  }
  return { ok: true };
}

// Every equipped item that fails its own requirements under `base`/`level`.
// Each item is judged with ITSELF excluded, which is the same circularity rule
// canEquip applies -- otherwise a set of two items that only qualify because
// of each other would both read as legal.
function illegalEquipped(inv, itemTypes, base, level) {
  const out = [];
  if (!inv || !inv.equipment || !Array.isArray(inv.items)) return out;
  for (const slot of SLOTS) {
    const itemId = inv.equipment[slot];
    if (!itemId) continue;
    const item = inv.items.find((it) => it.id === itemId);
    if (!item) continue;
    const type = itemTypes.get(item.typeId);
    if (!type) continue;
    const stats = effectiveStatsFor(inv, itemTypes, base, { excludeItemId: itemId });
    const r = meetsRequirements(type, level, stats);
    if (!r.ok) out.push({ slot, itemId, name: type.name, reason: r.reason });
  }
  return out;
}

// Which OTHER equipped items would become illegal if `slot` were emptied.
// Returns [] when the unequip is safe. The candidate slot's own item is not
// reported -- it is the one leaving.
//
// Only items that are legal NOW and illegal AFTER are reported. Without that
// difference, unequipping any item at all would be refused the moment some
// unrelated slot already held illegal gear (a respec leaves exactly that
// state behind), which would deadlock the player out of ever fixing it.
function unequipBlockers(inv, itemTypes, base, level, slot) {
  const leavingId = inv && inv.equipment ? inv.equipment[slot] : null;
  if (!leavingId) return [];
  const alreadyIllegal = new Set(illegalEquipped(inv, itemTypes, base, level).map((b) => b.itemId));
  const after = { ...inv, equipment: { ...inv.equipment } };
  delete after.equipment[slot];
  return illegalEquipped(after, itemTypes, base, level)
    .filter((b) => b.itemId !== leavingId && !alreadyIllegal.has(b.itemId))
    .map((b) => ({ slot: b.slot, name: b.name }));
}

module.exports = {
  REQ_STATS, gearStatGrants, effectiveStatsFor, meetsRequirements, illegalEquipped, unequipBlockers,
};
