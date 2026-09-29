// backend/src/authority/sfxEvents.js
//
// Game audio slice 3 (spec §3 "Wire change -- an sfx event channel"). Task 5
// builds the frame-level `sfx` event list here; this task (Task 2, subject
// registry) only needs ONE piece of that ahead of time: attackKindOf, the
// single weapon -> melee/ranged/magic mapping. It is placed in the authority
// (not audioSubjects.js) because Task 5's combat sites are the canonical
// caller, but the subject registry (backend/src/services/audioSubjects.js)
// needs the EXACT same mapping to resolve an item's use/hit cue, so it
// requires this file rather than re-deriving the rule.
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

module.exports = { attackKindOf };
