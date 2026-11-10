// Character buff auras: which of a player's active buffs draw, which one is the
// main buff, and how big and opaque each one is. Pure functions -- Game keeps
// the state (player.buffs, remotePlayer.buffs, buffVisuals) and the renderer
// asks these.
//
// `visuals` is the buff-visuals library indexed by skill id (indexBuffVisuals).
// A skill id that is not in it -- a druid form, a trap, an unknown id -- has no
// visual and draws nothing.

const DEFAULT_GROUND_RADIUS = 64;
const DEFAULT_BODY_SCALE = 1.3;
const DEFAULT_SETTINGS = Object.freeze({ main_opacity: 0.85, other_opacity: 0.45 });

const positive = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const unitOr = (v, fallback) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
};

// The snapshot's buff list for one player. The server OMITS `buffs` for a player
// with none, so an absent field means "no buffs", never "unchanged": every frame
// REPLACES the previous list.
export function snapshotBuffs(buffs) {
  return Array.isArray(buffs) ? buffs.filter((b) => b && b.id) : [];
}

// GET /api/buff-visuals → { visuals: { [skill_id]: row }, settings }.
// A missing or failed response gives an empty library (nothing draws).
export function indexBuffVisuals(response) {
  const visuals = {};
  const rows = response && Array.isArray(response.visuals) ? response.visuals : [];
  for (const row of rows) {
    if (row && row.skill_id) visuals[row.skill_id] = row;
  }
  const s = (response && response.settings) || {};
  return {
    visuals,
    settings: {
      main_opacity: unitOr(s.main_opacity, DEFAULT_SETTINGS.main_opacity),
      other_opacity: unitOr(s.other_opacity, DEFAULT_SETTINGS.other_opacity),
    },
  };
}

// The buffs that have a visual. Forms, traps and unknown ids drop out.
export function visibleBuffs(buffs, visuals) {
  if (!Array.isArray(buffs) || !visuals) return [];
  return buffs.filter((b) => b && b.id && Object.prototype.hasOwnProperty.call(visuals, b.id));
}

const num = (v) => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
};

// Larger first; null sorts below any number.
const cmpDesc = (a, b) => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
};

// The main buff among `entries` (already visible), in this order:
// highest priority (null below any number), highest tier, highest reqLvl, most
// recent castAt. The skill id breaks a full tie so the answer never depends on
// the order the server listed the buffs in.
export function mainBuffId(entries, visuals, skillsById) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const keyOf = (e) => {
    const visual = (visuals && visuals[e.id]) || {};
    const skill = skillsById && typeof skillsById.get === 'function' ? skillsById.get(e.id) : null;
    return {
      id: String(e.id),
      priority: num(visual.priority),
      tier: num(skill && skill.tier !== undefined ? skill.tier : visual.tier),
      reqLvl: num(skill && skill.reqLvl !== undefined ? skill.reqLvl : visual.req_lvl),
      castAt: num(e.castAt),
    };
  };
  const keys = entries.filter((e) => e && e.id).map(keyOf);
  if (keys.length === 0) return null;
  keys.sort((a, b) => cmpDesc(a.priority, b.priority)
    || cmpDesc(a.tier, b.tier)
    || cmpDesc(a.reqLvl, b.reqLvl)
    || cmpDesc(a.castAt, b.castAt)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return keys[0].id;
}

// One visible buff draws fully opaque; with two or more the main one draws at
// main_opacity and every other at other_opacity.
export function buffOpacity(count, isMain, settings) {
  if (!(count > 1)) return 1;
  const s = settings || DEFAULT_SETTINGS;
  return isMain
    ? unitOr(s.main_opacity, DEFAULT_SETTINGS.main_opacity)
    : unitOr(s.other_opacity, DEFAULT_SETTINGS.other_opacity);
}

// Ground aura radius in world units: the snapshot's auraRadius (the skill's real
// effect radius) wins over the row's radius, which wins over the default.
export function groundRadius(entry, visual) {
  return positive(entry && entry.auraRadius)
    ?? positive(visual && visual.radius)
    ?? DEFAULT_GROUND_RADIUS;
}

// Body aura size as a multiple of the drawn character height.
export function bodyScale(visual) {
  return positive(visual && visual.scale) ?? DEFAULT_BODY_SCALE;
}
