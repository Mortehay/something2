// Trigger affixes: modifiers that do something when a combat event happens, instead of adding a number to the
// character sheet. "Enemies you hit may ignite", "killing a creature restores mana", "when you are hit you may
// gain a ward".
//
// Three events are wired (the ones every kind of attack goes through):
//   hit    a landed hit. Not an event at all: an on-hit status is a RIDER, folded into stats.hitStatuses next to the
//          passive tree's own riders, so it already reaches melee swings, shots and skills through applyHitStatuses.
//   kill   the killer's player, from the one place a kill is credited (server.js).
//   hurt   a blow landing on the player, queued by skillBalance.mitigateIncoming and delivered by the world's tick.
//
// What an affix says (affix_types.effect, see seeds/data/affixTypes.js)
//   { type: 'trigger', on: 'kill' | 'hurt' | 'hit', action: 'restore' | 'heal' | 'buff' | 'status',
//     valueIs: 'chance' | 'magnitude',   what the rolled value means: the chance (percent), or the size (percent)
//     chance, magnitude,                 the fixed half, as fractions, when the roll is the other one
//     pool, status, buff: { id, nameEn, nameUk, icon, ms, fx }, cooldownMs }
//
// Everything here is plain data in and plain data out, so it is testable without a world.
const skillBalance = require('./skillBalance.js');
const { SLOTS, activeEquippedId } = require('./items.js');

const POOLS = { hp: 'maxHp', mana: 'maxMana', stamina: 'maxStamina' };
const TRIGGER_EVENTS = ['hit', 'kill', 'hurt'];
const TRIGGER_ACTIONS = ['status', 'restore', 'heal', 'buff'];
// Statuses an on-hit rider may apply: the ones effects.js stamps with refresh-not-stack (and, for shock, its
// non-refreshing immunity window), so a rider can never become a permanent lock.
const TRIGGER_STATUSES = ['burn', 'chill', 'shock'];

// One equipped affix as a trigger, or null when it is not one (or names something we cannot run).
function triggerOf(a) {
  const e = a && a.effect;
  if (!e || e.type !== 'trigger') return null;
  const value = Number(a.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  const roll = value / 100;
  const chance = e.valueIs === 'chance' ? roll : (Number.isFinite(Number(e.chance)) ? Number(e.chance) : 1);
  const magnitude = e.valueIs === 'magnitude' ? roll : (Number(e.magnitude) || 0);
  const t = {
    key: a.key || a.label || 'trigger', label: a.label || a.key || 'trigger',
    on: e.on, action: e.action, chance: Math.min(1, Math.max(0, chance)), magnitude,
    cooldownMs: Math.max(0, Number(e.cooldownMs) || 0),
  };
  if (e.action === 'status') { if (!e.status) return null; t.status = e.status; }
  else if (e.action === 'restore') { if (!POOLS[e.pool]) return null; t.pool = e.pool; }
  else if (e.action === 'heal') { /* life */ }
  else if (e.action === 'buff') { if (!e.buff || !e.buff.id || !(Number(e.buff.ms) > 0)) return null; t.buff = e.buff; }
  else return null;
  if (!['hit', 'kill', 'hurt'].includes(t.on)) return null;
  return t;
}

// Every trigger on the EQUIPPED gear. Like gearAffixes.equippedAffixGrants it walks inv.equipment, never inv.items:
// a trigger item in the backpack must do nothing, and dormant gear (one the character no longer qualifies for)
// gives nothing either.
function equippedTriggers(inv) {
  const out = [];
  if (!inv || !inv.equipment || !Array.isArray(inv.items)) return out;
  for (const slot of SLOTS) {
    const id = activeEquippedId(inv, slot);
    if (!id) continue;
    const item = inv.items.find((it) => it.id === id);
    if (!item || !Array.isArray(item.affixes)) continue;
    for (const a of item.affixes) {
      const t = triggerOf(a);
      if (t) out.push(t);
    }
  }
  return out;
}

// The derived stats with the triggers folded in: on-hit statuses become riders ({status, chance}) appended to
// hitStatuses, the event triggers go to `triggers`. A copy, never a mutation: stats rows are shared.
function withTriggerStats(stats, triggers) {
  if (!stats || !Array.isArray(triggers) || triggers.length === 0) return stats;
  const riders = triggers.filter((t) => t.on === 'hit' && t.action === 'status').map((t) => ({ status: t.status, chance: t.chance }));
  const events = triggers.filter((t) => t.on !== 'hit');
  return { ...stats, hitStatuses: [...(stats.hitStatuses || []), ...riders], triggers: events };
}

// Runs the player's triggers for one event. `rng` is injectable. Returns the keys that fired.
function fire(p, on, now, rng = skillBalance.roll) {
  const list = p && p.stats && p.stats.triggers;
  if (!Array.isArray(list) || list.length === 0 || !(p.hp > 0)) return [];
  const fired = [];
  for (const t of list) {
    if (t.on !== on) continue;
    const cd = p._trigCd && p._trigCd.get(t.key);
    if (cd != null && now < cd) continue;
    if (t.chance < 1 && rng() >= t.chance) continue;
    if (!apply(p, t, now)) continue;
    if (t.cooldownMs > 0) (p._trigCd || (p._trigCd = new Map())).set(t.key, now + t.cooldownMs);
    fired.push(t.key);
  }
  return fired;
}

function apply(p, t, now) {
  if (t.action === 'restore') {
    const max = Number(p[POOLS[t.pool]]) || 0;
    if (!(max > 0) || !(t.magnitude > 0)) return false;
    p[t.pool] = Math.min(max, (Number(p[t.pool]) || 0) + max * t.magnitude);
    return true;
  }
  if (t.action === 'heal') {
    const max = Number(p.maxHp) || 0;
    if (!(max > 0) || !(t.magnitude > 0)) return false;
    p.hp = Math.min(max, p.hp + max * t.magnitude);
    return true;
  }
  if (t.action === 'buff') {
    const b = t.buff;
    return skillBalance.grantTimedBuff(p, {
      id: b.id, nameEn: b.nameEn || b.id, nameUk: b.nameUk || b.nameEn || b.id, icon: b.icon, iconColor: b.iconColor,
    }, b.fx || {}, Number(b.ms), now);
  }
  return false;
}

// Delivers what skillBalance.mitigateIncoming queued in p._pendingHurt (it already queues reflects the same way,
// so every damage path that mitigates is covered by that one hook): at most one 'hurt' evaluation per tick,
// however many blows landed.
function drainHurt(p, now) {
  if (!p || !p._pendingHurt) return [];
  p._pendingHurt = 0;
  return fire(p, 'hurt', now);
}

module.exports = {
  triggerOf, equippedTriggers, withTriggerStats, fire, drainHurt, TRIGGER_EVENTS, TRIGGER_ACTIONS, TRIGGER_STATUSES, POOLS,
};
