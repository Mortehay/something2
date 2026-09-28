// backend/src/services/audioSubjects.js
//
// The code registry of what can carry sound (spec §1 "Subject registry").
// Binding validation, the bindings bundle, the misses filter and the admin
// Audio tab all read THIS list, so they cannot disagree about what a legal
// slot is. Slice 1 has world + biome; slices 2-3 add creature, attack_type,
// item, skill and world_point here.
const SUBJECT_KINDS = {
  world: {
    label: 'Worlds',
    slots: { music: 'music', ambience: 'ambience' },
    list: async (db) => (await db.query('SELECT name FROM worlds ORDER BY name')).rows.map((r) => r.name),
  },
  biome: {
    label: 'Biomes',
    slots: { ambience: 'ambience' },
    list: async (db) => (await db.query('SELECT name FROM biomes ORDER BY name')).rows.map((r) => r.name),
  },
};

function slotKind(subjectKind, slot) {
  const k = SUBJECT_KINDS[subjectKind];
  return (k && Object.prototype.hasOwnProperty.call(k.slots, slot)) ? k.slots[slot] : null;
}

function isKnownSlot(subjectKind, slot) {
  return slotKind(subjectKind, slot) !== null;
}

module.exports = { SUBJECT_KINDS, slotKind, isKnownSlot };
