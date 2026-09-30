// backend/src/services/audioPromptContext.js
//
// What the prompt-writing model is told about one audio slot (spec
// 2026-09-30 §5). The returned string is ALSO what gets stored as
// audio_prompts.source_input, so "stale" is simply "today's string differs".
//
// LOAD ONCE, BUILD MANY. The slot table flags staleness for ~2,300 rows; one
// query per row would be ~2,300 round-trips. loadPromptCatalog reads every
// table once, and buildContext is pure over that snapshot -- which is also
// what makes every branch testable without a database.
//
// THE ART-DESCRIPTION BRANCH IS THE ONE THAT MATTERS. It is preferred over
// entity_types.prompt, which carries image styling ("pixel art, ... solid
// transparent background") that is noise to a sound prompt. In the art epic a
// branch like this was dead for months because only a fixture reached it --
// the DB test for this file checks it against a real row.
const { SKILLS } = require('../../seeds/data/skills.js');
const { ATTACK_TYPE_PHRASE } = require('./audioSubjects');

const STYLING = /^(pixel art|isometric|single object|.*background|.*sprite|game asset|centered|high detail)$/i;

function stripImageStyling(prompt) {
  return String(prompt || '').split(',').map((s) => s.trim()).filter((s) => s && !STYLING.test(s)).join(', ');
}

const ART_KIND = { creature: 'entity', world_point: 'entity', item: 'item', skill: 'skill' };

async function loadPromptCatalog(db) {
  const [worlds, biomes, entities, items, art] = await Promise.all([
    db.query('SELECT name, biomes, level_min, level_max FROM worlds'),
    db.query('SELECT name, art_style FROM biomes'),
    db.query('SELECT name, prompt FROM entity_types WHERE is_creature OR point_kind IS NOT NULL'),
    db.query("SELECT name, category, req_level FROM item_types WHERE category = 'weapon'"),
    db.query("SELECT subject_kind, subject_key, text FROM art_prompt_descriptions WHERE active AND subject_kind IN ('entity', 'item', 'skill')"),
  ]);
  return {
    worlds: new Map(worlds.rows.map((r) => [r.name, r])),
    biomes: new Map(biomes.rows.map((r) => [r.name, r])),
    entities: new Map(entities.rows.map((r) => [r.name, r])),
    items: new Map(items.rows.map((r) => [r.name, r])),
    skills: new Map(SKILLS.map((s) => [s.id, s])),
    artDescriptions: new Map(art.rows.filter((r) => r.text).map((r) => [`${r.subject_kind}/${r.subject_key}`, r.text])),
  };
}

function looks(catalog, kind, key, fallback) {
  const art = catalog.artDescriptions.get(`${ART_KIND[kind]}/${key}`);
  const text = art || fallback;
  return text ? `; looks like: ${text}` : '';
}

function tail(slot, cue) {
  return `; slot: ${slot}${cue ? `; sound cue: ${cue}` : ''}`;
}

function buildContext(catalog, kind, key, slot, { cue = null } = {}) {
  switch (kind) {
    case 'world': {
      const w = catalog.worlds.get(key);
      if (!w) return null;
      const regions = Array.isArray(w.biomes) && w.biomes.length ? `; regions: ${w.biomes.join(', ')}` : '';
      const levels = w.level_min != null && w.level_max != null ? `; levels ${w.level_min}-${w.level_max}` : '';
      return `world "${key}"${regions}${levels}${tail(slot, cue)}`;
    }
    case 'biome': {
      const b = catalog.biomes.get(key);
      if (!b) return null;
      return `biome "${key}"${b.art_style ? `; looks like: ${b.art_style}` : ''}${tail(slot, cue)}`;
    }
    case 'creature':
    case 'world_point': {
      const e = catalog.entities.get(key);
      if (!e) return null;
      const label = kind === 'creature' ? 'creature' : 'world point';
      return `${label} "${key}"${looks(catalog, kind, key, stripImageStyling(e.prompt))}${tail(slot, cue)}`;
    }
    case 'item': {
      const it = catalog.items.get(key);
      if (!it) return null;
      const lvl = it.req_level != null ? `; required level ${it.req_level}` : '';
      return `${it.category || 'item'} "${key}"${lvl}${looks(catalog, kind, key, '')}${tail(slot, cue)}`;
    }
    case 'skill': {
      const s = catalog.skills.get(key);
      if (!s) return null;
      return `${s.class} ${s.type} skill "${s.nameEn}"${looks(catalog, kind, key, '')}${tail(slot, cue)}`;
    }
    case 'attack_type': {
      const phrases = Object.hasOwn(ATTACK_TYPE_PHRASE, key) ? ATTACK_TYPE_PHRASE[key] : null;
      if (!phrases) return null;
      const phrase = Object.hasOwn(phrases, slot) ? phrases[slot] : phrases.use;
      return `${key} attack: ${phrase}${tail(slot, cue)}`;
    }
    default: return null;
  }
}

async function contextFor(db, kind, key, slot, opts) {
  return buildContext(await loadPromptCatalog(db), kind, key, slot, opts);
}

function isStale(row, current) {
  if (!row || !row.source_input || current == null) return false;
  return row.source_input.trim() !== String(current).trim();
}

module.exports = {
  loadPromptCatalog, buildContext, contextFor, isStale, stripImageStyling,
};
