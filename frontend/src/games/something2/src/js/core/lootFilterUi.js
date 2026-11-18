// What a click, a key or the wheel does in the Loot Filter window. Pure state transitions over a
// `host` (the Game): host.lootFilterState.config is read, edits go out through host.saveLootFilter,
// host.lootUi is the window's own state. No canvas, no network: the panel module only draws.

import { activePreset } from './lootFilter.js';
import * as ed from './lootFilterEditor.js';

export function newLootUi() {
  return { ruleId: null, scroll: 0, picker: null, query: '', pickScroll: 0, focus: null, draft: '' };
}

const MAX_TEXT = 40;

function commit(host, config) {
  host.saveLootFilter(config);
}

function cfg(host) { return host.lootFilterState.config; }

// Pick the rule the editor shows: keep the current one if it still exists, else the top rule.
export function ensureSelection(host) {
  const ui = host.lootUi;
  const preset = activePreset(cfg(host));
  const rules = preset ? preset.rules : [];
  if (!rules.some((r) => r.id === ui.ruleId)) ui.ruleId = rules.length ? rules[0].id : null;
}

function endEdit(host, save) {
  const ui = host.lootUi;
  if (save && ui.focus === 'preset') {
    const preset = activePreset(cfg(host));
    if (preset) commit(host, ed.renamePreset(cfg(host), preset.id, ui.draft));
  } else if (save && ui.focus === 'rule' && ui.ruleId) {
    const name = String(ui.draft || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, MAX_TEXT);
    if (name) commit(host, ed.updateRule(cfg(host), ui.ruleId, (r) => ({ ...r, name })));
  }
  ui.focus = null;
  ui.draft = '';
}

// A click on a hit area (kinds are produced by systems/lootFilterPanel.js).
export function applyHit(host, hit) {
  const ui = host.lootUi;

  // Any click that is not on the field being typed in ends that edit first. This must happen BEFORE
  // the config is read below: finishing a rename saves it, and an edit made from the config read
  // earlier would overwrite that rename.
  if (ui.focus && !(hit.kind === 'lfpick-search' || hit.kind === 'lfpreset-rename' || hit.kind === 'lfrule-rename')) {
    if (ui.focus === 'search') ui.focus = null; else endEdit(host, true);
  }

  const config = cfg(host);
  const preset = activePreset(config);
  const id = ui.ruleId;

  switch (hit.kind) {
    case 'lfclose': host.closeLootFilter(); return;

    case 'lfpreset': {
      const list = config.presets;
      const i = list.findIndex((p) => preset && p.id === preset.id);
      const next = list[(i + hit.dir + list.length) % list.length];
      ui.ruleId = null; ui.picker = null;
      commit(host, ed.setActivePreset(config, next.id));
      ensureSelection(host);
      return;
    }
    case 'lfpreset-rename': ui.focus = 'preset'; ui.draft = preset ? preset.name : ''; return;
    case 'lfpreset-copy': ui.ruleId = null; commit(host, ed.duplicatePreset(config)); ensureSelection(host); return;
    case 'lfpreset-del': if (preset) { ui.ruleId = null; commit(host, ed.removePreset(config, preset.id)); ensureSelection(host); } return;
    case 'lfpreset-starter': ui.ruleId = null; commit(host, ed.addStarterPreset(config)); ensureSelection(host); return;
    case 'lfautoloot': commit(host, ed.toggleAutolootSkip(config)); return;

    case 'lfrule-add': {
      const before = preset ? preset.rules.length : 0;
      const next = ed.addRule(config);
      const p = activePreset(next);
      if (p && p.rules.length > before) { ui.ruleId = p.rules[0].id; ui.scroll = 0; }
      ui.picker = null;
      commit(host, next);
      return;
    }
    case 'lfrule-select': ui.ruleId = hit.id; ui.picker = null; return;
    case 'lfrule-toggle': commit(host, ed.toggleRule(config, hit.id)); return;
    case 'lfrule-up': commit(host, ed.moveRule(config, hit.id, -1)); return;
    case 'lfrule-down': commit(host, ed.moveRule(config, hit.id, 1)); return;
    case 'lfrule-del': {
      commit(host, ed.removeRule(config, hit.id));
      if (ui.ruleId === hit.id) { ui.ruleId = null; ui.picker = null; }
      ensureSelection(host);
      return;
    }
    case 'lfrule-rename': {
      const rule = preset && preset.rules.find((r) => r.id === id);
      if (rule) { ui.focus = 'rule'; ui.draft = rule.name; }
      return;
    }
    default: break;
  }

  // Everything below edits the selected rule.
  if (!id) return;
  switch (hit.kind) {
    case 'lfaction': commit(host, ed.setAction(config, id, hit.action)); return;
    case 'lfrarity': commit(host, ed.toggleRarity(config, id, hit.rarity)); return;
    case 'lfcat': commit(host, ed.toggleCategory(config, id, hit.category)); return;
    case 'lflevel': commit(host, ed.stepLevel(config, id, hit.which, hit.delta)); return;
    case 'lfaffixmode': commit(host, ed.setAffixMode(config, id, hit.mode)); return;
    case 'lftextcolor': commit(host, ed.setStyle(config, id, { textColor: hit.color })); return;
    case 'lfbgcolor': commit(host, ed.setStyle(config, id, { bgColor: hit.color })); return;
    case 'lfbeamcolor': commit(host, ed.setStyle(config, id, { beamColor: hit.color })); return;
    case 'lffont': commit(host, ed.stepFont(config, id, hit.delta)); return;
    case 'lfbeam': {
      const rule = preset && preset.rules.find((r) => r.id === id);
      if (rule) commit(host, ed.setStyle(config, id, { beam: !rule.style.beam }));
      return;
    }
    case 'lfchip-remove':
      commit(host, hit.what === 'type' ? ed.toggleTypeId(config, id, hit.id) : ed.toggleAffix(config, id, hit.id));
      return;
    case 'lfpick-open':
      if (ui.picker === hit.pick) { ui.picker = null; ui.focus = null; }
      else { ui.picker = hit.pick; ui.query = ''; ui.pickScroll = 0; ui.focus = 'search'; }
      return;
    case 'lfpick-item':
      commit(host, hit.pick === 'type' ? ed.toggleTypeId(config, id, hit.id) : ed.toggleAffix(config, id, hit.id));
      return;
    case 'lfpick-search': ui.focus = 'search'; return;
    case 'lfpick-done': ui.picker = null; ui.focus = null; return;
    default: break;
  }
}

// Keyboard while a text field has focus. Returns true when the key was consumed (the caller then
// stops: no movement, no hotkeys). `e` is a KeyboardEvent-like { key, ctrlKey, metaKey, altKey }.
export function handleKey(host, e) {
  const ui = host.lootUi;
  if (!ui.focus) return false;
  const searching = ui.focus === 'search';
  if (e.key === 'Escape') {
    if (searching) ui.focus = null; else endEdit(host, false);
    return true;
  }
  if (e.key === 'Enter') {
    if (searching) ui.focus = null; else endEdit(host, true);
    return true;
  }
  const text = searching ? 'query' : 'draft';
  if (e.key === 'Backspace') {
    ui[text] = ui[text].slice(0, -1);
    if (searching) ui.pickScroll = 0;
    return true;
  }
  if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (ui[text].length < MAX_TEXT) ui[text] += e.key;
    if (searching) ui.pickScroll = 0;
    return true;
  }
  return true; // swallow everything else while typing
}

// The wheel over the picker list scrolls it; over the rule list it scrolls that.
export function handleWheel(host, layout, x, y, deltaY) {
  if (!layout) return;
  const ui = host.lootUi;
  const step = deltaY < 0 ? -40 : 40;
  const inside = (r) => r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  if (layout.picker && inside(layout.picker.list)) {
    ui.pickScroll = Math.max(0, Math.min(layout.picker.pMax, (ui.pickScroll || 0) + step));
  } else {
    ui.scroll = Math.max(0, Math.min(layout.maxScroll, (ui.scroll || 0) + step));
  }
}
