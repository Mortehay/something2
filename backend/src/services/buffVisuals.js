// How a character's active buffs are drawn: one buff_visuals row per visual buff skill.
//
// A visual buff is a skill with type 'buff' that is neither a druid form nor a trap (decided by
// the effect data in skillBalance.BUFFS, not by retyped ids). The table holds every one of them
// (seeded by migration 1714440883000), but a missing row still reads as its default, so a skill
// added to the catalog later draws before anyone saves it.
const { SKILLS } = require('../../seeds/data/skills.js');
const { BUFFS } = require('../authority/skillBalance.js');
const { spriteFieldsError } = require('./vfxSprite.js');

const VISUAL_BUFF_IDS = SKILLS
  .filter((s) => s.type === 'buff' && !(BUFFS[s.id] && (BUFFS[s.id].form || BUFFS[s.id].trap)))
  .map((s) => s.id);
const VISUAL = new Set(VISUAL_BUFF_IDS);
const SKILL_OF = new Map(SKILLS.map((s) => [s.id, s]));

// Buffs whose effect is an area around the caster draw on the ground; everything else wraps the body.
const GROUND_DEFAULT = new Set(['mag_immolation_aura', 'dru_thorns_aura', 'arc_tailwind_aura', 'cul_martyrdom_aura',
  'mnk_fast_mana_aura', 'dru_tranquility', 'war_banner_of_victory']);

const DEFAULT_RADIUS = 64;
const DEFAULT_SCALE = 1.3;
const MAX_RADIUS = 2000;
const MAX_SCALE = 4;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const SPRITE_KEYS = ['sprite_image', 'sprite_frames', 'sprite_additive', 'sprite_fps'];
const SPRITE_DEFAULTS = { sprite_image: null, sprite_frames: 1, sprite_additive: true, sprite_fps: null };
const FIELDS = ['placement', 'radius', 'scale', 'priority', 'color'];

function defaultVisual(skill) {
  return {
    skill_id: skill.id,
    placement: GROUND_DEFAULT.has(skill.id) ? 'ground' : 'body',
    radius: DEFAULT_RADIUS,
    scale: DEFAULT_SCALE,
    priority: null,
    color: skill.iconColor || '#ffffff',
  };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// The PUT body as an error string or null. Only keys present are checked: an omitted field keeps
// its stored value.
function bodyError(b) {
  if ('placement' in b && b.placement !== 'ground' && b.placement !== 'body') return "placement must be 'ground' or 'body'";
  if ('radius' in b && !(isNum(b.radius) && b.radius > 0 && b.radius <= MAX_RADIUS)) {
    return `radius must be a number above 0 and at most ${MAX_RADIUS}`;
  }
  if ('scale' in b && !(isNum(b.scale) && b.scale > 0 && b.scale <= MAX_SCALE)) {
    return `scale must be a number above 0 and at most ${MAX_SCALE}`;
  }
  if ('priority' in b && b.priority !== null && !Number.isInteger(b.priority)) return 'priority must be a whole number or null';
  if ('color' in b && !(typeof b.color === 'string' && COLOR.test(b.color))) return 'color must be #rrggbb';
  if ('sprite_additive' in b && typeof b.sprite_additive !== 'boolean') return 'sprite_additive must be true or false';
  // One rule source with the vfx and aura routes, on a copy limited to the buff sprite fields.
  const sub = {};
  for (const k of SPRITE_KEYS) if (k in b) sub[k] = b[k];
  return spriteFieldsError(sub);
}

// Sprite columns to write. No sprite_image key writes nothing, so a form snapshot taken before an
// approve cannot revert the approved sheet. '' clears back to the column defaults.
function spriteWrite(b) {
  if (!('sprite_image' in b)) return {};
  if (!b.sprite_image) return { ...SPRITE_DEFAULTS };
  const fps = b.sprite_fps == null || b.sprite_fps === '' ? null : Number(b.sprite_fps);
  return {
    sprite_image: String(b.sprite_image),
    sprite_frames: Number(b.sprite_frames ?? 1),
    sprite_additive: b.sprite_additive !== false,
    sprite_fps: fps,
  };
}

// A buff whose effect is an area (fx.aura.radius, e.g. Immolation 150) is drawn in game at that
// radius (the snapshot's auraRadius), not the row's: the admin preview needs it to match.
function auraRadiusOf(skillId) {
  const r = Number(BUFFS[skillId] && BUFFS[skillId].aura && BUFFS[skillId].aura.radius);
  return Number.isFinite(r) && r > 0 ? r : null;
}

function withCatalog(row) {
  const s = SKILL_OF.get(row.skill_id);
  return { ...row, name_en: s.nameEn, tier: s.tier, req_lvl: s.reqLvl, aura_radius: auraRadiusOf(row.skill_id) };
}

// One row per visual buff in catalog order: the stored row merged over the default.
async function listBuffVisuals(db) {
  const { rows } = await db.query('SELECT * FROM buff_visuals WHERE skill_id = ANY($1::text[])', [VISUAL_BUFF_IDS]);
  const stored = new Map(rows.map((r) => [r.skill_id, r]));
  return VISUAL_BUFF_IDS.map((id) => withCatalog(
    { ...defaultVisual(SKILL_OF.get(id)), ...SPRITE_DEFAULTS, ...(stored.get(id) || {}) }));
}

// INSERT needs every NOT NULL field: omitted ones take the skill's default. ON CONFLICT updates
// only the columns in `changes`. The row as stored.
async function upsertRow(db, skillId, changes) {
  const insert = { ...defaultVisual(SKILL_OF.get(skillId)), ...changes };
  const cols = Object.keys(insert);
  const set = [...Object.keys(changes).map((c) => `${c} = EXCLUDED.${c}`), 'updated_at = now()'].join(', ');
  const { rows } = await db.query(
    `INSERT INTO buff_visuals (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (skill_id) DO UPDATE SET ${set} RETURNING *`,
    cols.map((c) => insert[c]));
  return rows[0];
}

async function saveBuffVisual(db, skillId, body) {
  if (!VISUAL.has(skillId)) throw httpError(404, 'Not a visual buff');
  const b = body && typeof body === 'object' ? body : {};
  const bad = bodyError(b);
  if (bad) throw httpError(400, bad);

  const fields = {};
  for (const k of FIELDS) if (k in b) fields[k] = b[k];
  return withCatalog(await upsertRow(db, skillId, { ...fields, ...spriteWrite(b) }));
}

// The Sprite tab's approve: the approved sheet's sprite columns (effectSprites.approveColumns),
// as given. A visual buff with no row yet (added to the catalog after the migration) gets one from
// its defaults. False when the skill is not a visual buff.
async function writeBuffSprite(db, skillId, spriteColumns) {
  if (!VISUAL.has(skillId)) return false;
  const sprite = {};
  for (const k of SPRITE_KEYS) if (k in spriteColumns) sprite[k] = spriteColumns[k];
  await upsertRow(db, skillId, sprite);
  return true;
}

module.exports = {
  VISUAL_BUFF_IDS, GROUND_DEFAULT, DEFAULT_RADIUS, DEFAULT_SCALE, defaultVisual, listBuffVisuals, saveBuffVisual, writeBuffSprite,
};
