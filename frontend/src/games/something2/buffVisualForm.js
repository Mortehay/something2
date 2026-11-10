// Form <-> payload for the Buff Auras admin. Pure, so it is testable under vitest's node env.
// The API (backend/src/services/buffVisuals.js) takes radius, scale and priority only as JSON
// numbers, so the payload converts; it re-validates everything, this copy gives an inline message.
import { touchSprite } from './auraForm.js';
import { SKILLS_BY_ID } from './src/js/core/skillsData.js';

export const BUFF_PLACEMENTS = ['ground', 'body'];
export const BUFF_LIMITS = { maxRadius: 2000, maxScale: 4, maxSpriteFrames: 64, maxSpriteFps: 60 };

// `sprite_touched` is form-only (the auraForm rule): the payload carries the sprite columns ONLY
// when it is true, because the API reads a missing sprite_image key as "leave the sprite alone"
// and '' as "clear it". Buff sheets default to additive (the column default).
const SPRITE_DEFAULTS = { sprite_image: '', sprite_frames: '1', sprite_additive: true, sprite_fps: '' };

export function buffToForm(r) {
  return {
    skill_id: r.skill_id,
    placement: r.placement === 'ground' ? 'ground' : 'body',
    radius: String(r.radius ?? 64),
    scale: String(r.scale ?? 1.3),
    priority: r.priority == null ? '' : String(r.priority),
    color: r.color || '#ffffff',
    sprite_image: r.sprite_image ?? '',
    sprite_frames: String(r.sprite_frames ?? 1),
    sprite_additive: r.sprite_additive !== false,
    sprite_fps: r.sprite_fps == null ? '' : String(r.sprite_fps),
    sprite_touched: false,
  };
}

// Removing the sprite: the API resets the sprite columns to their defaults, the form mirrors that.
export function clearedBuffSpriteForm(f) { return touchSprite(f, SPRITE_DEFAULTS); }

// Blank stays NaN (and is then rejected) -- never silently 0.
const n = (v) => (typeof v === 'string' && v.trim() === '' ? NaN : Number(v));

export function buffFormToPayload(f) {
  const p = {
    placement: f.placement,
    radius: n(f.radius),
    scale: n(f.scale),
    priority: String(f.priority ?? '').trim() === '' ? null : n(f.priority),
    color: f.color,
  };
  if (f.sprite_touched) {
    p.sprite_image = f.sprite_image ? String(f.sprite_image) : '';
    p.sprite_frames = n(f.sprite_frames);
    p.sprite_additive = !!f.sprite_additive;
    p.sprite_fps = f.sprite_fps === '' || f.sprite_fps == null ? null : n(f.sprite_fps);
  }
  return p;
}

export function validateBuffForm(f) {
  const p = buffFormToPayload(f);
  if (!BUFF_PLACEMENTS.includes(p.placement)) return "Placement must be 'ground' or 'body'";
  if (!(p.radius > 0 && p.radius <= BUFF_LIMITS.maxRadius)) return `Radius must be greater than 0 and at most ${BUFF_LIMITS.maxRadius}`;
  if (!(p.scale > 0 && p.scale <= BUFF_LIMITS.maxScale)) return `Scale must be greater than 0 and at most ${BUFF_LIMITS.maxScale}`;
  if (p.priority !== null && !Number.isInteger(p.priority)) return 'Priority must be a whole number or empty';
  if (!/^#[0-9a-fA-F]{6}$/.test(p.color || '')) return 'Colour must be #rrggbb';
  if (f.sprite_touched && p.sprite_image !== '') {
    if (!Number.isInteger(p.sprite_frames) || p.sprite_frames < 1 || p.sprite_frames > BUFF_LIMITS.maxSpriteFrames) {
      return `Sprite frames must be a whole number between 1 and ${BUFF_LIMITS.maxSpriteFrames}`;
    }
    if (p.sprite_fps != null && !(p.sprite_fps > 0 && p.sprite_fps <= BUFF_LIMITS.maxSpriteFps)) {
      return `Sprite fps must be empty or between 0 and ${BUFF_LIMITS.maxSpriteFps}`;
    }
  }
  return null;
}

// The class of a buff, from the skill catalog ('' for an id it does not know).
export function buffClass(skillId) {
  const s = SKILLS_BY_ID.get(skillId);
  return (s && s.class) || '';
}

// The search (name or skill id) and class filters. The with/without-sprite filter is vfxSpriteFilter.
export function filterBuffVisuals(rows, { search = '', cls = 'all' } = {}) {
  const q = search.trim().toLowerCase();
  return rows.filter((r) => {
    if (cls !== 'all' && buffClass(r.skill_id) !== cls) return false;
    if (!q) return true;
    return String(r.name_en || '').toLowerCase().includes(q) || String(r.skill_id || '').toLowerCase().includes(q);
  });
}
