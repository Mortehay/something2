'use strict';
// Loot filter: an ordered list of rules that decides how a ground item is shown. Pure, no I/O.
//
// The TOP rule that matches wins (rules below it are not consulted), so a player puts a narrow
// "show every Strength affix" above a broad "hide everything white". An item no rule matches is
// drawn as before.
//
// The same logic is mirrored on the client (frontend core/lootFilter.js) for drawing; the two are
// held together by tests/fixtures/lootFilterCases.json, which both test suites run. The SERVER
// copy is the one that matters for rules of the game: auto-loot never takes a hidden item.
//
// Config shape (one account, up to MAX_PRESETS named presets, one active):
//   { activeId, presets: [{ id, name, autolootSkipHidden, rules: [Rule] }] }
//   Rule = { id, name, enabled, action: 'hide'|'show'|'emphasize', conditions: {...}, style: {...} }
//   conditions (every present condition must hold; an empty / absent one never restricts):
//     rarities   ['white','blue','yellow','foxy']   any of
//     categories ['weapon', ...]                    item_types.category, any of
//     typeIds    [3, 9]                             a specific base item, any of
//     minLevel / maxLevel                           the item level, inclusive
//     affixIds   [12, 40]  + affixMode 'any'|'all'  affix_types ids the item carries
//   style (emphasize / show): textColor, bgColor (#rgb/#rrggbb/#rrggbbaa), fontSize px, beam, beamColor

const ACTIONS = ['hide', 'show', 'emphasize'];
const RARITIES = ['white', 'blue', 'yellow', 'foxy'];
const AFFIX_MODES = ['any', 'all'];

const MAX_PRESETS = 12;
const MAX_RULES = 60;
const MAX_LIST = 50;       // ids / categories per condition
const MAX_NAME = 40;
const FONT_MIN = 9;
const FONT_MAX = 32;
const LEVEL_MIN = 1;
const LEVEL_MAX = 150;     // world_items_item_level_check

const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

class FilterError extends Error {}

function fail(msg) { throw new FilterError(msg); }

function cleanName(v, fallback) {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, MAX_NAME) : '';
  return s || fallback;
}

function cleanColor(v) {
  return typeof v === 'string' && COLOR_RE.test(v) ? v.toLowerCase() : null;
}

function cleanLevel(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < LEVEL_MIN || n > LEVEL_MAX) fail(`level must be an integer ${LEVEL_MIN}-${LEVEL_MAX}`);
  return n;
}

function cleanList(v, label, pick) {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) fail(`${label} must be a list`);
  if (v.length > MAX_LIST) fail(`${label} has more than ${MAX_LIST} entries`);
  const out = [];
  for (const x of v) {
    const c = pick(x);
    if (c === undefined) fail(`${label} has an invalid entry`);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

function sanitizeConditions(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const minLevel = cleanLevel(c.minLevel);
  const maxLevel = cleanLevel(c.maxLevel);
  if (minLevel !== null && maxLevel !== null && minLevel > maxLevel) fail('minLevel is above maxLevel');
  const affixMode = c.affixMode === undefined ? 'any' : c.affixMode;
  if (!AFFIX_MODES.includes(affixMode)) fail('affixMode must be any or all');
  return {
    rarities: cleanList(c.rarities, 'rarities', (x) => (RARITIES.includes(x) ? x : undefined)),
    categories: cleanList(c.categories, 'categories', (x) => (typeof x === 'string' && /^[a-z_]{1,30}$/.test(x) ? x : undefined)),
    typeIds: cleanList(c.typeIds, 'typeIds', (x) => (Number.isInteger(x) && x > 0 ? x : undefined)),
    minLevel,
    maxLevel,
    affixIds: cleanList(c.affixIds, 'affixIds', (x) => (Number.isInteger(x) && x > 0 ? x : undefined)),
    affixMode,
  };
}

function sanitizeStyle(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  let fontSize = null;
  if (s.fontSize !== null && s.fontSize !== undefined && s.fontSize !== '') {
    const n = Number(s.fontSize);
    if (!Number.isInteger(n) || n < FONT_MIN || n > FONT_MAX) fail(`fontSize must be an integer ${FONT_MIN}-${FONT_MAX}`);
    fontSize = n;
  }
  return {
    textColor: cleanColor(s.textColor),
    bgColor: cleanColor(s.bgColor),
    fontSize,
    beam: s.beam === true,
    beamColor: cleanColor(s.beamColor),
  };
}

function sanitizeRule(raw, index) {
  if (!raw || typeof raw !== 'object') fail('a rule must be an object');
  if (!ACTIONS.includes(raw.action)) fail('action must be hide, show or emphasize');
  const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : `r${index + 1}`;
  return {
    id,
    name: cleanName(raw.name, `Rule ${index + 1}`),
    enabled: raw.enabled !== false,
    action: raw.action,
    conditions: sanitizeConditions(raw.conditions),
    style: sanitizeStyle(raw.style),
  };
}

function sanitizePreset(raw, index) {
  if (!raw || typeof raw !== 'object') fail('a preset must be an object');
  const rules = raw.rules === undefined ? [] : raw.rules;
  if (!Array.isArray(rules)) fail('rules must be a list');
  if (rules.length > MAX_RULES) fail(`a preset holds at most ${MAX_RULES} rules`);
  const clean = rules.map(sanitizeRule);
  const seen = new Set();
  for (const r of clean) {
    // Two rules with one id would make "toggle this rule" ambiguous in the editor.
    let id = r.id;
    for (let n = 2; seen.has(id); n += 1) id = `${r.id}-${n}`;
    r.id = id;
    seen.add(id);
  }
  return {
    id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : `p${index + 1}`,
    name: cleanName(raw.name, `Preset ${index + 1}`),
    autolootSkipHidden: raw.autolootSkipHidden !== false,
    rules: clean,
  };
}

function defaultConfig() {
  return { activeId: 'default', presets: [{ id: 'default', name: 'Default', autolootSkipHidden: true, rules: [] }] };
}

// Validates and normalises a whole config from the wire or the database. Throws FilterError with
// a message fit to show the player; never returns a half-valid object.
function sanitizeConfig(raw) {
  if (!raw || typeof raw !== 'object') fail('the filter must be an object');
  if (!Array.isArray(raw.presets) || raw.presets.length === 0) fail('there must be at least one preset');
  if (raw.presets.length > MAX_PRESETS) fail(`at most ${MAX_PRESETS} presets`);
  const presets = raw.presets.map(sanitizePreset);
  const ids = new Set();
  for (const p of presets) {
    let id = p.id;
    for (let n = 2; ids.has(id); n += 1) id = `${p.id}-${n}`;
    p.id = id;
    ids.add(id);
  }
  const activeId = ids.has(raw.activeId) ? raw.activeId : presets[0].id;
  return { activeId, presets };
}

function activePreset(config) {
  if (!config || !Array.isArray(config.presets)) return null;
  return config.presets.find((p) => p.id === config.activeId) || config.presets[0] || null;
}

function sameAny(list, value) { return list.includes(value); }

// Does `rule` match `item`? item = { typeId, rarity, itemLevel, affixIds: [] }. `typeOf(typeId)`
// returns the catalog row ({ category }) or null; an unknown type fails a category condition
// (it cannot be proven to be in the category) but passes a rule that has none.
function ruleMatches(rule, item, typeOf) {
  const c = rule.conditions || {};
  if (c.rarities && c.rarities.length && !sameAny(c.rarities, item.rarity || 'white')) return false;
  if (c.typeIds && c.typeIds.length && !sameAny(c.typeIds, item.typeId)) return false;
  if (c.categories && c.categories.length) {
    const t = typeOf ? typeOf(item.typeId) : null;
    if (!t || !sameAny(c.categories, t.category)) return false;
  }
  const lvl = Number.isFinite(Number(item.itemLevel)) ? Number(item.itemLevel) : 1;
  if (c.minLevel !== null && c.minLevel !== undefined && lvl < c.minLevel) return false;
  if (c.maxLevel !== null && c.maxLevel !== undefined && lvl > c.maxLevel) return false;
  if (c.affixIds && c.affixIds.length) {
    const has = Array.isArray(item.affixIds) ? item.affixIds : [];
    const test = (id) => has.includes(id);
    if (c.affixMode === 'all' ? !c.affixIds.every(test) : !c.affixIds.some(test)) return false;
  }
  return true;
}

// The verdict for one item: { rule, action, style } from the first enabled matching rule, or null
// when no rule matches (draw as normal). `rules` is the active preset's rule list.
function evaluate(rules, item, typeOf) {
  if (!Array.isArray(rules)) return null;
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    if (ruleMatches(rule, item, typeOf)) return { rule, action: rule.action, style: rule.style || null };
  }
  return null;
}

function isHidden(rules, item, typeOf) {
  const v = evaluate(rules, item, typeOf);
  return !!v && v.action === 'hide';
}

module.exports = {
  ACTIONS, RARITIES, AFFIX_MODES, MAX_PRESETS, MAX_RULES, FONT_MIN, FONT_MAX,
  FilterError, defaultConfig, sanitizeConfig, activePreset, ruleMatches, evaluate, isHidden,
};
