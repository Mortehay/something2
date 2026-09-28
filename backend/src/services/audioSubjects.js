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
    exists: async (db, keys) => new Set((await db.query(
      'SELECT name FROM worlds WHERE name = ANY($1::text[])', [keys])).rows.map((r) => r.name)),
  },
  biome: {
    label: 'Biomes',
    slots: { ambience: 'ambience' },
    list: async (db) => (await db.query('SELECT name FROM biomes ORDER BY name')).rows.map((r) => r.name),
    exists: async (db, keys) => new Set((await db.query(
      'SELECT name FROM biomes WHERE name = ANY($1::text[])', [keys])).rows.map((r) => r.name)),
  },
};

// Own keys only: SUBJECT_KINDS['constructor'] / ['__proto__'] are truthy
// inherited values, and a non-string kind (['world']) would coerce to a key.
function isKnownKind(subjectKind) {
  return typeof subjectKind === 'string' && Object.hasOwn(SUBJECT_KINDS, subjectKind);
}

function slotKind(subjectKind, slot) {
  if (!isKnownKind(subjectKind) || typeof slot !== 'string') return null;
  const k = SUBJECT_KINDS[subjectKind];
  return Object.hasOwn(k.slots, slot) ? k.slots[slot] : null;
}

function isKnownSlot(subjectKind, slot) {
  return slotKind(subjectKind, slot) !== null;
}

const MAX_SUBJECT_KEY = 200;

// Does this subject exist in its catalogue (spec §3: unknown keys are
// dropped)? One query for the whole list; returns the Set of keys that exist.
async function existingSubjects(db, subjectKind, keys) {
  if (!isKnownKind(subjectKind) || !keys.length) return new Set();
  return SUBJECT_KINDS[subjectKind].exists(db, keys);
}

async function subjectExists(db, subjectKind, key) {
  if (typeof key !== 'string' || !key || key.length > MAX_SUBJECT_KEY) return false;
  return (await existingSubjects(db, subjectKind, [key])).has(key);
}

module.exports = {
  SUBJECT_KINDS, MAX_SUBJECT_KEY, isKnownKind, slotKind, isKnownSlot, existingSubjects, subjectExists,
};
