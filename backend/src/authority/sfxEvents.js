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

// Which attack sound family a weapon belongs to (spec §1 attack_type).
// melee weapons -> melee; projectile weapons that use ammo (bows,
// crossbows, thrown) -> ranged; projectile weapons without ammo (wands,
// staves, scepters) or anything carrying a spell stone -> magic.
function attackKindOf(w) {
  if (!w) return 'melee';
  if (w.stoneItemId || w.augment || w.stone_mode) return 'magic';
  if (w.kind === 'melee') return 'melee';
  return w.ammo_type_id != null ? 'ranged' : 'magic';
}

module.exports = { attackKindOf };
