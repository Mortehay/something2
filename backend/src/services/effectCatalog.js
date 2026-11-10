// The Sprite tab's effect list, built from the live vfx_effects / aura_effects rows and the visual
// buffs (buff_visuals, merged over each buff's defaults): every row is one subject, grouped by what
// uses it, with box job settings derived from its shape and colour. The batch-1 settings
// (effectSprites.BATCH_1) override the derived ones name by name.
'use strict';
const { BATCH_1, defaultPrompt } = require('./effectSprites.js');
const { kindOf } = require('./effectKinds.js');
const { listBuffVisuals } = require('./buffVisuals.js');
const { listStatusVisuals, STATUS_COLOR } = require('./statusVisuals.js');
const { KIND_DEFAULTS } = require('../authority/vfx.js');
const { SKILLS, resolveSkillVfx } = require('../../seeds/data/skills.js');

const GROUP_ORDER = Object.freeze(['Weapon attacks', 'Creature & boss skills', 'Player skills', 'Fallbacks', 'Auras', 'Buff auras', 'Status visuals', 'Not used yet']);

// The names the player-skill resolver actually returns over the skill catalog.
const PLAYER_SKILL_EFFECTS = new Set(SKILLS.map(resolveSkillVfx).filter((n) => typeof n === 'string' && n));

// The server's kind-level defaults (authority/vfx.js), whatever the moment.
const FALLBACK_EFFECTS = new Set(Object.values(KIND_DEFAULTS).flatMap((byKind) => Object.values(byKind)));

// Referenced by nothing; listed, but select-all skips them.
const RETIRED_EFFECTS = new Set(['spark_fire', 'spark_ice', 'spark_lightning']);

// The box draws only projectile | burst | aura | beam. Arcs are beams until the box has a slash kind.
const SHAPE_KIND = { bolt: 'projectile', line: 'beam', burst: 'burst', ring: 'burst', arc: 'beam' };
const kindForShape = (shape) => SHAPE_KIND[shape] || 'burst';

const SHAPE_DEFAULTS = {
  bolt: { frames: 8, loop: true },
  line: { frames: 8, loop: true },
  burst: { frames: 6, loop: false },
  ring: { frames: 6, loop: false },
  arc: { frames: 6, loop: false },
};
const KIND_SIZE = { projectile: 96, beam: 96, burst: 128, aura: 128 };

// sRGB relative luminance below this reads as dark: additive blending would all but vanish, so it
// draws with alpha. 0.1 puts the deep purples (#6b21a8 0.07, #7722aa 0.08) on alpha and keeps
// every mid-tone (#7c3aed 0.13 and up) additive.
const DARK_LUMINANCE = 0.1;
function isDarkColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex == null ? '' : hex).trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l < DARK_LUMINANCE;
}

const OVERRIDE_KEYS = ['kind', 'frames', 'size', 'loop', 'blend'];
const overrideOf = (subject_kind, name) => BATCH_1.find((b) => b.subject_kind === subject_kind && b.name === name) || null;

function subjectDefaults({ subject_kind, name, shape, color }) {
  // Auras and buffs are box auras whatever their row says; a vfx draws by its shape.
  const fixed = kindOf(subject_kind) ? kindOf(subject_kind).boxKind : null;
  const kind = fixed || kindForShape(shape);
  const sd = fixed ? { frames: 8, loop: true } : (SHAPE_DEFAULTS[shape] || SHAPE_DEFAULTS.burst);
  const out = {
    kind, frames: sd.frames, size: KIND_SIZE[kind], loop: sd.loop,
    blend: isDarkColor(color) ? 'alpha' : 'additive',
    topDown: !fixed && shape === 'ring',
  };
  const o = overrideOf(subject_kind, name);
  if (o) for (const k of OVERRIDE_KEYS) out[k] = o[k];
  return out;
}

function groupOf(name, refs) {
  if (refs.weapon.has(name)) return 'Weapon attacks';
  if (refs.creatureSkill.has(name)) return 'Creature & boss skills';
  if (refs.playerSkill.has(name)) return 'Player skills';
  if (refs.fallback.has(name)) return 'Fallbacks';
  return 'Not used yet';
}

// Every effect name a jsonb vfx binding column references (any moment). Non-object values
// (null, strings, arrays) reference nothing.
const refsSql = (table) => `SELECT DISTINCT v.value AS name FROM ${table} t
  CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(t.vfx) = 'object' THEN t.vfx ELSE '{}'::jsonb END) v`;

async function loadRefs(db) {
  const [items, entities, skills] = await Promise.all([
    db.query(refsSql('item_types')), db.query(refsSql('entity_types')), db.query(refsSql('creature_skills')),
  ]);
  const names = (r) => r.rows.map((x) => x.name);
  return {
    // Weapon attacks are item bindings only; an entity_types.vfx binding is a creature's basic
    // attack, which belongs with the creature and boss skills.
    weapon: new Set(names(items)),
    creatureSkill: new Set([...names(entities), ...names(skills)]),
    playerSkill: PLAYER_SKILL_EFFECTS,
    fallback: FALLBACK_EFFECTS,
  };
}

// A visual buff: the skill id is the subject name; the prompt is the skill's English name.
function buffSubject(row) {
  return {
    subject_kind: 'buff', name: row.skill_id, group: 'Buff auras',
    ...subjectDefaults({ subject_kind: 'buff', name: row.skill_id, shape: null, color: row.color }),
    color: row.color, shape: null, retired: false,
    nameEn: row.name_en, placement: row.placement,
  };
}

// A status row: the subject key is the name. Its prompt is the amber block, varied by variant.
function statusSubject(row) {
  return {
    subject_kind: 'status', name: row.key, group: 'Status visuals',
    ...subjectDefaults({ subject_kind: 'status', name: row.key, shape: null, color: STATUS_COLOR }),
    color: STATUS_COLOR, shape: null, retired: false, variant: row.variant,
  };
}

// Per-variant looks of the amber block (variant 1..10): shade, cracks, smoke density. Cycled when
// a variant falls outside the list.
const AMBER_LOOKS = Object.freeze([
  'pale honey amber, a few hairline cracks, thin wisps of smoke',
  'warm golden amber, fine cracks near the shoulders, light smoke',
  'deep orange amber, a web of cracks across the chest, steady smoke',
  'clear yellow amber, one long diagonal crack, sparse smoke',
  'dark reddish amber, crazed all over with cracks, thick smoke',
  'bright lemon amber, tiny bubbles and no cracks, faint smoke',
  'smoky brown amber, deep cracks at the base, heavy smoke',
  'rich copper amber, glowing cracks, curling smoke',
  'cloudy pale amber, cracks along the top, drifting smoke',
  'molten dark amber, glowing veins of cracks, dense rolling smoke',
]);
const statusLook = (variant) => AMBER_LOOKS[(((Number(variant) || 1) - 1) % AMBER_LOOKS.length + AMBER_LOOKS.length) % AMBER_LOOKS.length];

// The colour-word default prompt of a subject. A buff says where it draws: wrapped around the
// character, or on the ground beneath it.
function subjectPrompt(s) {
  if (s.subject_kind === 'buff') {
    return `${defaultPrompt(s.nameEn || s.name, s.color)}${s.placement === 'ground' ? ', seen from above' : ', shell around a figure'}`;
  }
  if (s.subject_kind === 'status') {
    return `translucent amber block the size of a standing figure, ${statusLook(s.variant)}, smoke rising from the base`;
  }
  return defaultPrompt(s.name, s.color, { topDown: s.topDown });
}

function toSubject(subject_kind, row, refs) {
  const shape = subject_kind === 'aura' ? null : row.shape;
  return {
    subject_kind, name: row.name,
    group: subject_kind === 'aura' ? 'Auras' : groupOf(row.name, refs),
    ...subjectDefaults({ subject_kind, name: row.name, shape, color: row.color }),
    color: row.color, shape,
    retired: subject_kind === 'vfx' && RETIRED_EFFECTS.has(row.name),
  };
}

const bySortOrder = (a, b) => (GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
  || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  || (a.subject_kind < b.subject_kind ? -1 : a.subject_kind > b.subject_kind ? 1 : 0);

async function loadEffectCatalog(db) {
  const [vfx, auras, buffs, statuses, refs] = await Promise.all([
    db.query('SELECT name, shape, color FROM vfx_effects'),
    db.query('SELECT name, color FROM aura_effects'),
    listBuffVisuals(db),
    listStatusVisuals(db),
    loadRefs(db),
  ]);
  return [
    ...vfx.rows.map((r) => toSubject('vfx', r, refs)),
    ...auras.rows.map((r) => toSubject('aura', r, refs)),
    ...buffs.map(buffSubject),
    ...statuses.map(statusSubject),
  ].sort(bySortOrder);
}

async function findEffectSubject(db, subject_kind, name) {
  const k = kindOf(subject_kind);
  if (!k) return null;
  if (subject_kind === 'buff') {
    const row = (await listBuffVisuals(db)).find((r) => r.skill_id === name);
    return row ? buffSubject(row) : null;
  }
  if (subject_kind === 'status') {
    const row = (await listStatusVisuals(db)).find((r) => r.key === name);
    return row ? statusSubject(row) : null;
  }
  // Only a vfx row has a shape (and is grouped by what references it).
  const isVfx = subject_kind === 'vfx';
  const { rows: [row] } = await db.query(
    `SELECT ${k.keyCol} AS name, ${isVfx ? 'shape, ' : ''}color FROM ${k.table} WHERE ${k.keyCol} = $1`, [name]);
  if (!row) return null;
  return toSubject(subject_kind, row, isVfx ? await loadRefs(db) : null);
}

module.exports = {
  kindForShape, isDarkColor, subjectDefaults, subjectPrompt, groupOf, loadEffectCatalog, findEffectSubject, statusSubject,
  PLAYER_SKILL_EFFECTS, RETIRED_EFFECTS, GROUP_ORDER,
};
