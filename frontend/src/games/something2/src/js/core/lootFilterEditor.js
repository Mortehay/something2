// Editing operations for the loot filter panel. Every function takes a config and returns a NEW
// config (the panel keeps the old one for "unsaved changes" and the cache keys on identity), and
// none of them touches the network. The limits are the server's (backend authority/lootFilter.js),
// so a config built here is never refused for size.

import { activePreset } from './lootFilter.js';

export const MAX_PRESETS = 12;
export const MAX_RULES = 60;
export const FONT_MIN = 9;
export const FONT_MAX = 32;
export const LEVEL_MIN = 1;
export const LEVEL_MAX = 150;
export const DEFAULT_FONT = 13;

// The colours the panel offers (a click-only picker: no hex typing on a canvas). null = automatic
// (the grade's own colour for text, nothing for the background).
export const PALETTE = [
  '#ffffff', '#d6d9e0', '#4a9eff', '#f5c518', '#ff7a1a', '#ff4d4d',
  '#4ade80', '#22d3ee', '#c084fc', '#f472b6', '#000000', '#1f2937',
];

export function blankRule(id, name) {
  return {
    id,
    name,
    enabled: true,
    action: 'emphasize',
    conditions: { rarities: [], categories: [], typeIds: [], minLevel: null, maxLevel: null, affixIds: [], affixMode: 'any' },
    style: { textColor: null, bgColor: null, fontSize: null, beam: false, beamColor: null },
  };
}

function mapPreset(config, fn) {
  const active = activePreset(config);
  if (!active) return config;
  return { ...config, presets: config.presets.map((p) => (p.id === active.id ? fn(p) : p)) };
}

function uniqueId(prefix, taken) {
  for (let n = 1; ; n += 1) {
    const id = `${prefix}${n}`;
    if (!taken.includes(id)) return id;
  }
}

function toggled(list, value) {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

// ---- rules -------------------------------------------------------------------------------------

// A new rule goes on TOP: the usual reason to add one is an exception to what is already there.
export function addRule(config) {
  return mapPreset(config, (p) => {
    if (p.rules.length >= MAX_RULES) return p;
    const id = uniqueId('r', p.rules.map((r) => r.id));
    return { ...p, rules: [blankRule(id, `Rule ${p.rules.length + 1}`), ...p.rules] };
  });
}

export function removeRule(config, ruleId) {
  return mapPreset(config, (p) => ({ ...p, rules: p.rules.filter((r) => r.id !== ruleId) }));
}

// dir -1 = up (higher priority), +1 = down. At an end it is a no-op.
export function moveRule(config, ruleId, dir) {
  return mapPreset(config, (p) => {
    const i = p.rules.findIndex((r) => r.id === ruleId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= p.rules.length) return p;
    const rules = p.rules.slice();
    [rules[i], rules[j]] = [rules[j], rules[i]];
    return { ...p, rules };
  });
}

export function updateRule(config, ruleId, fn) {
  return mapPreset(config, (p) => ({ ...p, rules: p.rules.map((r) => (r.id === ruleId ? fn(r) : r)) }));
}

export function toggleRule(config, ruleId) {
  return updateRule(config, ruleId, (r) => ({ ...r, enabled: !r.enabled }));
}

export function setAction(config, ruleId, action) {
  return updateRule(config, ruleId, (r) => ({ ...r, action }));
}

// ---- conditions --------------------------------------------------------------------------------

function setCond(config, ruleId, patch) {
  return updateRule(config, ruleId, (r) => ({ ...r, conditions: { ...r.conditions, ...patch } }));
}

export function toggleRarity(config, ruleId, rarity) {
  return updateRule(config, ruleId, (r) => ({ ...r, conditions: { ...r.conditions, rarities: toggled(r.conditions.rarities, rarity) } }));
}

export function toggleCategory(config, ruleId, category) {
  return updateRule(config, ruleId, (r) => ({ ...r, conditions: { ...r.conditions, categories: toggled(r.conditions.categories, category) } }));
}

export function toggleTypeId(config, ruleId, typeId) {
  return updateRule(config, ruleId, (r) => ({ ...r, conditions: { ...r.conditions, typeIds: toggled(r.conditions.typeIds, typeId) } }));
}

export function toggleAffix(config, ruleId, affixId) {
  return updateRule(config, ruleId, (r) => ({ ...r, conditions: { ...r.conditions, affixIds: toggled(r.conditions.affixIds, affixId) } }));
}

export function setAffixMode(config, ruleId, mode) {
  return setCond(config, ruleId, { affixMode: mode === 'all' ? 'all' : 'any' });
}

// `which` is 'minLevel' | 'maxLevel'. A step off the end of the range clears the bound ("any").
// The other bound is pushed along so the pair never inverts (the server refuses min > max).
export function stepLevel(config, ruleId, which, delta) {
  return updateRule(config, ruleId, (r) => {
    const c = r.conditions;
    const cur = c[which];
    let next = (cur === null || cur === undefined) ? (delta > 0 ? LEVEL_MIN : null) : cur + delta;
    if (next !== null && next < LEVEL_MIN) next = null;
    if (next !== null && next > LEVEL_MAX) next = LEVEL_MAX;
    const out = { ...c, [which]: next };
    if (out.minLevel !== null && out.maxLevel !== null && out.minLevel > out.maxLevel) {
      if (which === 'minLevel') out.maxLevel = out.minLevel; else out.minLevel = out.maxLevel;
    }
    return { ...r, conditions: out };
  });
}

// ---- style -------------------------------------------------------------------------------------

export function setStyle(config, ruleId, patch) {
  return updateRule(config, ruleId, (r) => ({ ...r, style: { ...r.style, ...patch } }));
}

export function stepFont(config, ruleId, delta) {
  return updateRule(config, ruleId, (r) => {
    const cur = r.style.fontSize;
    let next = (cur === null || cur === undefined) ? DEFAULT_FONT + delta : cur + delta;
    next = Math.max(FONT_MIN, Math.min(FONT_MAX, next));
    return { ...r, style: { ...r.style, fontSize: next } };
  });
}

// ---- presets -----------------------------------------------------------------------------------

export function setActivePreset(config, presetId) {
  return config.presets.some((p) => p.id === presetId) ? { ...config, activeId: presetId } : config;
}

// A copy of the active preset (so a tweak never destroys the one you came from), made active.
export function duplicatePreset(config) {
  if (config.presets.length >= MAX_PRESETS) return config;
  const src = activePreset(config);
  if (!src) return config;
  const id = uniqueId('p', config.presets.map((p) => p.id));
  const copy = { ...JSON.parse(JSON.stringify(src)), id, name: `${src.name} ${config.presets.length + 1}`.slice(0, 40) };
  return { ...config, presets: [...config.presets, copy], activeId: id };
}

// Never removes the last preset: the filter always has one to evaluate.
export function removePreset(config, presetId) {
  if (config.presets.length <= 1) return config;
  const presets = config.presets.filter((p) => p.id !== presetId);
  if (presets.length === config.presets.length) return config;
  return { ...config, presets, activeId: config.activeId === presetId ? presets[0].id : config.activeId };
}

export function renamePreset(config, presetId, name) {
  const clean = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
  if (!clean) return config;
  return { ...config, presets: config.presets.map((p) => (p.id === presetId ? { ...p, name: clean } : p)) };
}

export function toggleAutolootSkip(config) {
  return mapPreset(config, (p) => ({ ...p, autolootSkipHidden: !p.autolootSkipHidden }));
}

// A ready-made starting point for people who have never written a rule: hide the grey clutter,
// light up the rest. Added as a new preset so it replaces nothing.
export function addStarterPreset(config) {
  if (config.presets.length >= MAX_PRESETS) return config;
  const id = uniqueId('p', config.presets.map((p) => p.id));
  const rule = (rid, name, action, rarities, style) => ({
    ...blankRule(rid, name), action, conditions: { ...blankRule(rid, name).conditions, rarities },
    style: { ...blankRule(rid, name).style, ...style },
  });
  const preset = {
    id, name: 'Starter', autolootSkipHidden: true,
    rules: [
      rule('s1', 'Unique drops', 'emphasize', ['foxy'], { textColor: '#ff7a1a', fontSize: 16, beam: true, beamColor: '#ff7a1a' }),
      rule('s2', 'Rare drops', 'emphasize', ['yellow'], { textColor: '#f5c518', fontSize: 14, beam: true, beamColor: '#f5c518' }),
      rule('s3', 'Magic drops', 'show', ['blue'], { textColor: '#4a9eff' }),
      rule('s4', 'Hide ordinary gear', 'hide', ['white'], {}),
    ],
  };
  return { ...config, presets: [...config.presets, preset], activeId: id };
}
