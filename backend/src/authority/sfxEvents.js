// backend/src/authority/sfxEvents.js
//
// Game audio slice 3 (spec §3 "Wire change -- an sfx event channel"). The
// frame-level `sfx` event builders live here, together with attackKindOf, the
// single weapon -> melee/ranged/magic mapping. The subject registry
// (backend/src/services/audioSubjects.js) needs the EXACT same mapping to
// resolve an item's use/hit cue, so it requires this file rather than
// re-deriving the rule.
//
// PURE: no authority imports, no DB, no state. That is what lets a service
// file require it without pulling the whole authority module graph in.
//
// getWeaponCategory (seeds/data/skills.js) is the game's one existing
// weapon-family heuristic (skill-gem weapon-requirement gating) -- reused
// here, not copied, so this and that stay the same rule.
const { getWeaponCategory } = require('../../seeds/data/skills.js');

// Which attack sound family a weapon belongs to (spec §1 attack_type).
//
// Controller ruling 2026-09-29, replacing an earlier version that broke on
// the live catalog two ways:
//
// 1. It read `w.stone_mode` for truthiness. item_types_stone_mode_category_check
//    forces stone_mode to the literal string 'replace' -- truthy -- on EVERY
//    non-stone row (the column exists on the whole table, not only stones),
//    so any real weapon row/type object passed in would already carry a
//    truthy stone_mode and read as 'magic' regardless of its actual kind.
//    stone_mode is NOT read here at all now: a socketed spell/augment stone
//    is what actually signals magic, and that is already `stoneItemId`/
//    `augment` (both set by activeWeaponType only when a stone is socketed;
//    see authority/items.js). Checking stone_mode added nothing but the bug.
// 2. It used `ammo_type_id != null` as the ONLY ranged signal. The
//    gear-ladder generator (seeds/generateGearLadder.js) never sets
//    ammo_type_id on its bow/crossbow/dart rows (verified against the live
//    schema), so every one of those would fall to 'magic'. getWeaponCategory
//    is the fallback: it already classifies by NAME (bow/crossbow/arbalest/
//    sling/dart -> 'bow'), which is how the game itself already gates
//    skill-gem weapon requirements, so this reuses that rule rather than
//    inventing a second one that could drift from it.
//
// Ordering matters: the `kind === 'melee'` check runs BEFORE
// getWeaponCategory, because getWeaponCategory's name match would otherwise
// misread 'quarterstaff' as a staff (it contains the substring 'staff') --
// its real kind is 'melee', so the kind check must win first.
function attackKindOf(w) {
  if (!w) return 'melee';
  if (w.stoneItemId || w.augment) return 'magic'; // a socketed spell/augment stone (activeWeaponType runtime fields)
  if (w.kind === 'melee') return 'melee'; // before the name heuristic: 'quarterstaff' contains 'staff'
  if (w.ammo_type_id != null || getWeaponCategory(w) === 'bow') return 'ranged'; // bows, crossbows, arbalest, sling, darts
  return 'magic'; // wands, staves, scepters, magic-bolt
}

// A skill cast's sound family. Skills carry no weapon row; the skill catalog
// (seeds/data/skills.js) types each skill 'melee', 'magic', 'buff' or
// 'debuff', and castSkill resolves only 'melee' as a weapon arc -- every other
// type is a spell effect, so it sounds like magic.
function skillAttackKind(skill) {
  return skill && skill.type === 'melee' ? 'melee' : 'magic';
}

// -- The frame-level `sfx` event list (spec §3 "Wire change").
//
// Shape: { e, k?, s?, c?, a?, x, y }. Every builder below goes through
// sfxEvent(), which is the ONE place optional keys are dropped: a key whose
// value is null/undefined is omitted, never sent as null, so an event carries
// only what is known about it. Coordinates are rounded to whole world pixels
// -- sound placement needs no sub-pixel precision, and the list rides every
// frame.

const SFX_CAP = 64; // per world per frame; overflow drops the newest

const OPTIONAL_KEYS = ['k', 's', 'c', 'a'];

function sfxEvent(e, fields, x, y) {
  const ev = { e };
  for (const key of OPTIONAL_KEYS) {
    if (fields[key] != null) ev[key] = fields[key];
  }
  ev.x = Math.round(x);
  ev.y = Math.round(y);
  return ev;
}

// A player swings or fires the weapon `w`.
function weaponUse(w, userId, x, y) {
  return sfxEvent('use', { k: attackKindOf(w), s: w && w.name, a: `p:${userId}` }, x, y);
}

// A player's weapon (or a player-owned projectile) lands at x,y. `k`/`s` are
// passed in rather than derived: a projectile resolves them once at launch.
function weaponHit(k, s, x, y) {
  return sfxEvent('hit', { k, s }, x, y);
}

// A creature swings, bites or looses a shot.
function creatureUse(c, x, y) {
  return sfxEvent('use', { c: c.type, a: `c:${c.id}` }, x, y);
}

// A creature's blow or projectile lands at x,y.
function creatureHit(type, x, y) {
  return sfxEvent('hit', { c: type }, x, y);
}

// A creature of `type` takes a hit at x,y.
function creatureHurt(type, x, y) {
  return sfxEvent('hurt', { c: type }, x, y);
}

// A creature of `type` dies at x,y.
function creatureDeath(type, x, y) {
  return sfxEvent('death', { c: type }, x, y);
}

// A player casts `skill`.
function skillUse(skill, userId, x, y) {
  return sfxEvent('use', { k: skillAttackKind(skill), s: `skill:${skill.id}`, a: `p:${userId}` }, x, y);
}

// Bounded append: every buffer events pass through (each sim's, the world's,
// the server's per-world stash) is capped, so a world whose frames stop
// draining can never grow one without limit. An event without a finite
// position is dropped -- it has nowhere to be heard, and JSON would turn its
// NaN into null on the wire. Returns whether the event was kept.
function pushSfxEvent(list, ev) {
  if (!ev || list.length >= SFX_CAP) return false;
  if (!Number.isFinite(ev.x) || !Number.isFinite(ev.y)) return false;
  list.push(ev);
  return true;
}

module.exports = {
  attackKindOf,
  skillAttackKind,
  SFX_CAP,
  weaponUse,
  weaponHit,
  creatureUse,
  creatureHit,
  creatureHurt,
  creatureDeath,
  skillUse,
  pushSfxEvent,
};
