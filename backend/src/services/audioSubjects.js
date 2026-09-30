// backend/src/services/audioSubjects.js
//
// The code registry of what can carry sound (spec §1 "Subject registry").
// Binding validation, the bindings bundle, the misses filter and the admin
// Audio tab all read THIS list, so they cannot disagree about what a legal
// slot is. Slice 1 has world + biome; slice 3 adds creature, world_point,
// attack_type, item and skill here.
//
// A kind entry MAY carry `subjectCues: (db) => Promise<{ [subjectKey]:
// { [slot]: cue|null } }>` -- one map per subject the kind lists, covering
// every one of its slots. GET /admin/subjects (audioRoutes.js) calls this
// generically for whichever kinds define it and emits the result as `cues`,
// with NO per-kind switch there: world and biome carry no sfx slots at all
// (music/ambience have no cue concept) and simply omit the method, so their
// groups get no `cues` field. This is the registry's own data, not the
// route's -- a kind added here without `subjectCues` just has no cues in the
// admin response, correctly, with no route change required.
const { attackKindOf } = require('../authority/sfxEvents');
const { SKILLS } = require('../../seeds/data/skills.js');

// Built once at module load: SKILLS is ~300 static rows, and every cue/phrase
// lookup below is by id.
const SKILLS_BY_ID = new Map(SKILLS.map((s) => [s.id, s]));

const ATTACK_KINDS = ['melee', 'ranged', 'magic'];

// spec §4's slot -> cue table for attack_type, keyed by attack kind because
// the cue genuinely differs per subject (melee `use` is not ranged `use`) --
// unlike creature/world_point below, where the same map applies to every
// subject of that kind. `hit` is `null` for whichever kind has no cue on the
// box today (spec §4: "Three slots have no cue... a bow/throw release").
const ATTACK_TYPE_CUES = {
  melee: { use: 'slash', hit: 'hit' },
  ranged: { use: null, hit: 'hit' },
  magic: { use: 'spell', hit: 'hit' },
};

// entityPhrase's text for the attack_type kind, per (kind, slot) -- the spec
// §4 table gives each slot its own phrase ("a steel sword" is a swing, "a
// blade on a creature" is a hit; a `hit` cue sent "a steel sword" tends
// toward a clang). ranged/use has no cue (upload only), so its phrase is
// never sent; it reuses the ranged/hit phrase rather than inventing one.
const ATTACK_TYPE_PHRASE = {
  melee: { use: 'a steel sword', hit: 'a blade on a creature' },
  ranged: { use: 'an arrow', hit: 'an arrow' },
  magic: { use: 'a magic spell', hit: 'a magic blast' },
};

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
  creature: {
    label: 'Creatures',
    slots: {
      nearby: 'sfx', attack: 'sfx', hurt: 'sfx', death: 'sfx',
    },
    // Fixed: the same cue applies to every creature (spec §4 table). `nearby`
    // and `attack` have no cue on the box today -- upload only. Still used by
    // cueFor directly; subjectCues below fans it out per listed creature.
    cues: {
      nearby: null, attack: null, hurt: 'hit', death: 'death',
    },
    list: async (db) => (await db.query(
      'SELECT name FROM entity_types WHERE is_creature ORDER BY name')).rows.map((r) => r.name),
    exists: async (db, keys) => new Set((await db.query(
      'SELECT name FROM entity_types WHERE is_creature AND name = ANY($1::text[])', [keys])).rows.map((r) => r.name)),
    // subjectCues(db) -> { [name]: { [slot]: cue|null } }, one entry per
    // listed creature -- see the module-level comment above SUBJECT_KINDS.
    subjectCues: async (db) => {
      const names = await SUBJECT_KINDS.creature.list(db);
      const out = {};
      for (const n of names) out[n] = { ...SUBJECT_KINDS.creature.cues };
      return out;
    },
  },
  world_point: {
    label: 'World points',
    slots: { nearby: 'sfx' },
    cues: { nearby: 'waypoint' },
    list: async (db) => (await db.query(
      'SELECT name FROM entity_types WHERE point_kind IS NOT NULL ORDER BY name')).rows.map((r) => r.name),
    exists: async (db, keys) => new Set((await db.query(
      'SELECT name FROM entity_types WHERE point_kind IS NOT NULL AND name = ANY($1::text[])',
      [keys])).rows.map((r) => r.name)),
    subjectCues: async (db) => {
      const names = await SUBJECT_KINDS.world_point.list(db);
      const out = {};
      for (const n of names) out[n] = { ...SUBJECT_KINDS.world_point.cues };
      return out;
    },
  },
  attack_type: {
    label: 'Attack types',
    slots: { use: 'sfx', hit: 'sfx' },
    list: async () => [...ATTACK_KINDS],
    exists: async (db, keys) => new Set(keys.filter((k) => ATTACK_KINDS.includes(k))),
    // The cue genuinely differs per subject key (melee `use` is not ranged
    // `use`) -- ATTACK_TYPE_CUES is already keyed exactly that way, by kind.
    subjectCues: async () => ({ ...ATTACK_TYPE_CUES }),
  },
  item: {
    label: 'Items',
    slots: { use: 'sfx', hit: 'sfx' },
    list: async (db) => (await db.query(
      "SELECT name FROM item_types WHERE category = 'weapon' ORDER BY name")).rows.map((r) => r.name),
    exists: async (db, keys) => new Set((await db.query(
      "SELECT name FROM item_types WHERE category = 'weapon' AND name = ANY($1::text[])",
      [keys])).rows.map((r) => r.name)),
    // Cue depends on the item's own attack kind -- see itemCues below
    // (defined further down, but a function DECLARATION so it is hoisted and
    // safe to reference here).
    subjectCues: async (db) => itemCues(db),
  },
  skill: {
    label: 'Skills',
    slots: { use: 'sfx', hit: 'sfx' },
    list: async () => SKILLS.map((s) => s.id),
    exists: async (db, keys) => new Set(keys.filter((k) => SKILLS_BY_ID.has(k))),
    // Cue depends on the skill's own type -- see skillCues below (also
    // hoisted).
    subjectCues: async () => skillCues(),
  },
};

// Every kind whose bindings are global rather than scoped to one world/biome
// (worldAudioBundle reads this so a new kind added here is picked up there
// automatically -- see its own comment).
const GLOBAL_SUBJECT_KINDS = Object.keys(SUBJECT_KINDS).filter((k) => k !== 'world' && k !== 'biome');

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

// An item's own attack kind (melee/ranged/magic), via the ONE definition
// shared with the authority (attackKindOf, backend/src/authority/sfxEvents.js).
//
// `name` is passed through: attackKindOf's ranged branch falls back to
// getWeaponCategory(w), which classifies by NAME when kind/ammo_type_id
// cannot -- the gear-ladder generator never wires ammo_type_id onto its
// bow/crossbow/dart rows, so name is the only signal that gets them to
// 'ranged' instead of 'magic'. stone_mode is deliberately never selected
// here: attackKindOf does not read it (a real weapon row's own stone_mode is
// always the literal string 'replace' -- item_types_stone_mode_category_check
// -- which would be a lie about socket state a catalog-level TYPE has no way
// to know; only `stoneItemId`/`augment`, both runtime-only fields this bare
// catalog lookup never sets, signal an actual socketed stone).
async function weaponAttackKind(db, name) {
  const row = (await db.query(
    "SELECT name, kind, ammo_type_id FROM item_types WHERE category = 'weapon' AND name = $1", [name],
  )).rows[0];
  if (!row) return null;
  return attackKindOf({ name: row.name, kind: row.kind, ammo_type_id: row.ammo_type_id });
}

// The cue to send the box for one (kind, key, slot) -- null means "no cue on
// the box today", i.e. upload-only (spec §4). Never throws on an unknown
// kind/slot/key; callers that need to distinguish "no cue" from "not a real
// subject" already validated with isKnownSlot/subjectExists first.
async function cueFor(db, kind, key, slot) {
  if (!isKnownSlot(kind, slot)) return null;
  switch (kind) {
    case 'creature': return SUBJECT_KINDS.creature.cues[slot] ?? null;
    case 'world_point': return SUBJECT_KINDS.world_point.cues[slot] ?? null;
    case 'attack_type': {
      const c = ATTACK_TYPE_CUES[key];
      return c ? (c[slot] ?? null) : null;
    }
    case 'item': {
      const attackKind = await weaponAttackKind(db, key);
      return attackKind ? (ATTACK_TYPE_CUES[attackKind][slot] ?? null) : null;
    }
    case 'skill': {
      const s = SKILLS_BY_ID.get(key);
      if (!s) return null;
      // spec §4: "spell/hit for magic skills, else as its attack type" --
      // `hit` is always 'hit'; `use` is the melee cue for a melee skill and
      // the magic cue for everything else (magic/buff/debuff).
      if (slot === 'hit') return 'hit';
      return s.type === 'melee' ? 'slash' : 'spell';
    }
    default: return null; // world/biome: music/ambience slots carry no cue.
  }
}

// The `entity` text sent alongside a cue (spec §4 table). Subjects are keyed
// by name already, so most kinds need no lookup at all; skill is the one
// exception (its key is an id, not a display name). `slot` matters only for
// attack_type, whose phrase differs per slot; without one it falls back to
// the `use` phrase.
function entityPhrase(db, kind, key, slot) {
  switch (kind) {
    case 'creature': return String(key).toLowerCase();
    case 'item': return key;
    case 'world_point': return key;
    case 'attack_type': {
      const phrases = Object.hasOwn(ATTACK_TYPE_PHRASE, key) ? ATTACK_TYPE_PHRASE[key] : null;
      if (!phrases) return key;
      return Object.hasOwn(phrases, slot) ? phrases[slot] : phrases.use;
    }
    case 'skill': {
      const s = SKILLS_BY_ID.get(key);
      return s ? s.nameEn : key;
    }
    default: return key;
  }
}

// item's subjectCues: { [name]: { use, hit } } for every weapon. One query
// for every weapon rather than one per name (same reasoning as slotClipCounts
// in audioLibrary.js): the Audio tab's item group can hold the whole
// gear-ladder catalog (144 rows today).
async function itemCues(db) {
  const rows = (await db.query("SELECT name, kind, ammo_type_id FROM item_types WHERE category = 'weapon'")).rows;
  const out = {};
  for (const row of rows) {
    // `name` matters here -- see weaponAttackKind's comment (getWeaponCategory
    // fallback for the gear-ladder rows that carry no ammo_type_id).
    const k = ATTACK_TYPE_CUES[attackKindOf({ name: row.name, kind: row.kind, ammo_type_id: row.ammo_type_id })];
    out[row.name] = { use: k.use, hit: k.hit };
  }
  return out;
}

function skillCues() {
  const out = {};
  for (const s of SKILLS) out[s.id] = { use: s.type === 'melee' ? 'slash' : 'spell', hit: 'hit' };
  return out;
}

module.exports = {
  SUBJECT_KINDS,
  GLOBAL_SUBJECT_KINDS,
  MAX_SUBJECT_KEY,
  isKnownKind,
  slotKind,
  isKnownSlot,
  existingSubjects,
  subjectExists,
  cueFor,
  entityPhrase,
  itemCues,
  skillCues,
  ATTACK_TYPE_CUES,
};
