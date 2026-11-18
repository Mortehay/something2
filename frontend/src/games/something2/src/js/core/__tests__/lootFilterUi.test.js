import { describe, it, expect } from 'vitest';
import { defaultFilterConfig, activePreset } from '../lootFilter.js';
import { newLootUi, applyHit, handleKey, handleWheel, ensureSelection } from '../lootFilterUi.js';
import { layoutLootFilterPanel, drawLootFilterPanel, pickerEntries } from '../../systems/lootFilterPanel.js';

function makeHost() {
  const host = {
    lootFilterState: { config: defaultFilterConfig(), version: 0, affixes: [{ id: 1, key: 'of_might', label: 'of Might' }, { id: 2, key: 'of_grace', label: 'of Grace' }] },
    lootUi: newLootUi(),
    saves: [],
    closed: 0,
    saveLootFilter(config) { host.saves.push(config); host.lootFilterState.config = config; host.lootFilterState.version += 1; },
    closeLootFilter() { host.closed += 1; },
  };
  return host;
}
const rules = (h) => activePreset(h.lootFilterState.config).rules;
const click = (h, hit) => applyHit(h, hit);

const TYPES = new Map([
  [1, { id: 1, name: 'Iron Sword', category: 'weapon' }],
  [2, { id: 2, name: 'Leather Cap', category: 'armor' }],
  [3, { id: 3, name: 'Gold', category: 'currency' }],
]);

describe('rules', () => {
  it('adding a rule selects it, on top', () => {
    const h = makeHost();
    click(h, { kind: 'lfrule-add' });
    click(h, { kind: 'lfrule-add' });
    expect(rules(h).map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(h.lootUi.ruleId).toBe('r2');
  });

  it('deleting the selected rule moves the selection to the one that is left', () => {
    const h = makeHost();
    click(h, { kind: 'lfrule-add' });
    click(h, { kind: 'lfrule-add' });
    click(h, { kind: 'lfrule-del', id: 'r2' });
    expect(rules(h).map((r) => r.id)).toEqual(['r1']);
    expect(h.lootUi.ruleId).toBe('r1');
    click(h, { kind: 'lfrule-del', id: 'r1' });
    expect(h.lootUi.ruleId).toBeNull();
  });

  it('edits go to the SELECTED rule', () => {
    const h = makeHost();
    click(h, { kind: 'lfrule-add' });
    click(h, { kind: 'lfrule-add' });
    click(h, { kind: 'lfrule-select', id: 'r1' });
    click(h, { kind: 'lfaction', action: 'hide' });
    click(h, { kind: 'lfrarity', rarity: 'white' });
    click(h, { kind: 'lflevel', which: 'minLevel', delta: 1 });
    click(h, { kind: 'lftextcolor', color: '#ff0000' });
    click(h, { kind: 'lfbeam' });
    const r1 = rules(h).find((r) => r.id === 'r1');
    const r2 = rules(h).find((r) => r.id === 'r2');
    expect(r1.action).toBe('hide');
    expect(r1.conditions.rarities).toEqual(['white']);
    expect(r1.conditions.minLevel).toBe(1);
    expect(r1.style).toMatchObject({ textColor: '#ff0000', beam: true });
    expect(r2.action).toBe('emphasize');
    expect(r2.conditions.rarities).toEqual([]);
  });

  it('an edit with nothing selected does nothing', () => {
    const h = makeHost();
    click(h, { kind: 'lfaction', action: 'hide' });
    expect(h.saves).toHaveLength(0);
  });
});

describe('presets', () => {
  it('copy, starter and cycling', () => {
    const h = makeHost();
    click(h, { kind: 'lfpreset-starter' });
    expect(h.lootFilterState.config.presets).toHaveLength(2);
    expect(activePreset(h.lootFilterState.config).name).toBe('Starter');
    expect(h.lootUi.ruleId).toBe('s1');
    click(h, { kind: 'lfpreset', dir: 1 });
    expect(activePreset(h.lootFilterState.config).id).toBe('default');
    click(h, { kind: 'lfpreset', dir: -1 });
    expect(activePreset(h.lootFilterState.config).name).toBe('Starter');
    click(h, { kind: 'lfpreset-copy' });
    expect(h.lootFilterState.config.presets).toHaveLength(3);
  });

  it('delete keeps at least one preset', () => {
    const h = makeHost();
    click(h, { kind: 'lfpreset-del' });
    expect(h.lootFilterState.config.presets).toHaveLength(1);
  });

  it('the auto-loot switch flips the flag', () => {
    const h = makeHost();
    click(h, { kind: 'lfautoloot' });
    expect(activePreset(h.lootFilterState.config).autolootSkipHidden).toBe(false);
  });
});

describe('text fields', () => {
  const type = (h, s) => { for (const ch of s) handleKey(h, { key: ch }); };

  it('renames a preset: typing builds a draft, Enter saves it', () => {
    const h = makeHost();
    click(h, { kind: 'lfpreset-rename' });
    expect(h.lootUi.focus).toBe('preset');
    for (let i = 0; i < 10; i += 1) handleKey(h, { key: 'Backspace' });
    type(h, 'Мій фільтр');
    expect(h.saves).toHaveLength(0);
    handleKey(h, { key: 'Enter' });
    expect(activePreset(h.lootFilterState.config).name).toBe('Мій фільтр');
    expect(h.lootUi.focus).toBeNull();
  });

  it('Escape abandons a rename', () => {
    const h = makeHost();
    click(h, { kind: 'lfpreset-rename' });
    type(h, 'zzz');
    handleKey(h, { key: 'Escape' });
    expect(activePreset(h.lootFilterState.config).name).toBe('Default');
    expect(h.saves).toHaveLength(0);
  });

  it('clicking elsewhere while renaming saves the draft', () => {
    const h = makeHost();
    click(h, { kind: 'lfrule-add' });
    click(h, { kind: 'lfrule-rename' });
    for (let i = 0; i < 10; i += 1) handleKey(h, { key: 'Backspace' });
    type(h, 'Boss gear');
    click(h, { kind: 'lfrule-add' });
    expect(rules(h).some((r) => r.name === 'Boss gear')).toBe(true);
  });

  it('a name that ends up empty is not saved', () => {
    const h = makeHost();
    click(h, { kind: 'lfrule-add' });
    click(h, { kind: 'lfrule-rename' });
    for (let i = 0; i < 20; i += 1) handleKey(h, { key: 'Backspace' });
    handleKey(h, { key: 'Enter' });
    expect(rules(h)[0].name).toBe('Rule 1');
  });

  it('while a field has focus every key is swallowed; with none, nothing is', () => {
    const h = makeHost();
    expect(handleKey(h, { key: 'a' })).toBe(false);
    click(h, { kind: 'lfpreset-rename' });
    expect(handleKey(h, { key: 'ArrowLeft' })).toBe(true);
    expect(handleKey(h, { key: 'l' })).toBe(true);
  });
});

describe('picker', () => {
  it('opens focused on search, lists base items without currency, filters by category and text', () => {
    const h = makeHost();
    click(h, { kind: 'lfrule-add' });
    click(h, { kind: 'lfpick-open', pick: 'type' });
    expect(h.lootUi).toMatchObject({ picker: 'type', focus: 'search' });
    const rule = rules(h)[0];
    expect(pickerEntries('type', { types: TYPES, affixes: [], rule, query: '' }).map((e) => e.id).sort()).toEqual([1, 2]);
    click(h, { kind: 'lfcat', category: 'weapon' });
    expect(pickerEntries('type', { types: TYPES, affixes: [], rule: rules(h)[0], query: '' }).map((e) => e.id)).toEqual([1]);
    expect(pickerEntries('type', { types: TYPES, affixes: [], rule: { conditions: { categories: [] } }, query: 'cap' }).map((e) => e.id)).toEqual([2]);
  });

  it('picks and removes a base item and an affix', () => {
    const h = makeHost();
    click(h, { kind: 'lfrule-add' });
    click(h, { kind: 'lfpick-item', pick: 'type', id: 1 });
    click(h, { kind: 'lfpick-item', pick: 'affix', id: 2 });
    expect(rules(h)[0].conditions).toMatchObject({ typeIds: [1], affixIds: [2] });
    click(h, { kind: 'lfchip-remove', what: 'type', id: 1 });
    click(h, { kind: 'lfchip-remove', what: 'affix', id: 2 });
    expect(rules(h)[0].conditions).toMatchObject({ typeIds: [], affixIds: [] });
  });

  it('typing in the search box edits the query, not the preset', () => {
    const h = makeHost();
    click(h, { kind: 'lfrule-add' });
    click(h, { kind: 'lfpick-open', pick: 'affix' });
    for (const ch of 'mig') handleKey(h, { key: ch });
    expect(h.lootUi.query).toBe('mig');
    expect(activePreset(h.lootFilterState.config).name).toBe('Default');
    handleKey(h, { key: 'Escape' });
    expect(h.lootUi.focus).toBeNull();
    expect(h.lootUi.picker).toBe('affix');
  });

  it('Done closes the picker', () => {
    const h = makeHost();
    click(h, { kind: 'lfrule-add' });
    click(h, { kind: 'lfpick-open', pick: 'type' });
    click(h, { kind: 'lfpick-done' });
    expect(h.lootUi.picker).toBeNull();
  });
});

describe('layout and drawing', () => {
  function layoutFor(h, extra = {}) {
    return layoutLootFilterPanel({ config: h.lootFilterState.config, ui: h.lootUi, types: TYPES, affixes: h.lootFilterState.affixes, ...extra });
  }

  it('every hit area is on the panel and the kinds the handler knows', () => {
    const h = makeHost();
    click(h, { kind: 'lfpreset-starter' });
    const L = layoutFor(h);
    expect(L.hitAreas.length).toBeGreaterThan(40);
    for (const a of L.hitAreas) {
      expect(a.x).toBeGreaterThanOrEqual(L.panel.x);
      expect(a.y).toBeGreaterThanOrEqual(L.panel.y);
      expect(a.x + a.w).toBeLessThanOrEqual(L.panel.x + L.panel.w);
      expect(a.y + a.h).toBeLessThanOrEqual(L.panel.y + L.panel.h);
      expect(a.kind).toMatch(/^lf/);
    }
  });

  it('with no rule selected the editor is empty; with one it offers the controls', () => {
    const h = makeHost();
    expect(layoutFor(h).selected).toBeNull();
    click(h, { kind: 'lfrule-add' });
    const kinds = new Set(layoutFor(h).hitAreas.map((a) => a.kind));
    for (const k of ['lfaction', 'lfrarity', 'lfcat', 'lflevel', 'lfaffixmode', 'lftextcolor', 'lfbgcolor', 'lffont', 'lfbeam', 'lfbeamcolor', 'lfpick-open']) {
      expect(kinds.has(k), k).toBe(true);
    }
  });

  it('a long rule list scrolls and its hit areas stay inside the list', () => {
    const h = makeHost();
    for (let i = 0; i < 40; i += 1) click(h, { kind: 'lfrule-add' });
    const L = layoutFor(h);
    expect(L.maxScroll).toBeGreaterThan(0);
    for (const a of L.hitAreas.filter((x) => ['lfrule-select', 'lfrule-toggle', 'lfrule-up', 'lfrule-down', 'lfrule-del'].includes(x.kind))) {
      expect(a.y).toBeGreaterThanOrEqual(L.listArea.y);
      expect(a.y + a.h).toBeLessThanOrEqual(L.listArea.y + L.listArea.h + 0.001);
    }
    handleWheel(h, L, L.listArea.x + 5, L.listArea.y + 5, 100);
    expect(h.lootUi.scroll).toBeGreaterThan(0);
    handleWheel(h, L, L.listArea.x + 5, L.listArea.y + 5, -10000);
    expect(h.lootUi.scroll).toBe(0);
  });

  it('the picker lays out its items, and its wheel scrolls the picker not the rules', () => {
    const h = makeHost();
    click(h, { kind: 'lfrule-add' });
    const many = new Map();
    for (let i = 1; i <= 120; i += 1) many.set(i, { id: i, name: `Item ${i}`, category: 'weapon' });
    click(h, { kind: 'lfpick-open', pick: 'type' });
    const L = layoutFor(h, { types: many });
    expect(L.picker.items.length).toBeGreaterThan(5);
    expect(L.picker.pMax).toBeGreaterThan(0);
    handleWheel(h, L, L.picker.list.x + 5, L.picker.list.y + 5, 100);
    expect(h.lootUi.pickScroll).toBeGreaterThan(0);
    expect(h.lootUi.scroll).toBe(0);
  });

  it('draws every state without throwing', () => {
    const calls = [];
    const ctx = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'measureText') return (s) => ({ width: String(s).length * 6 });
        if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
        return (...args) => { calls.push(prop); return undefined; };
      },
      set() { return true; },
    });
    const h = makeHost();
    drawLootFilterPanel(ctx, layoutFor(h)); // empty
    click(h, { kind: 'lfpreset-starter' });
    drawLootFilterPanel(ctx, layoutFor(h)); // starter rules, first selected
    for (const id of ['s1', 's4']) {
      click(h, { kind: 'lfrule-select', id });
      click(h, { kind: 'lfbeam' });
      drawLootFilterPanel(ctx, layoutFor(h)); // emphasize with beam / hide preview
    }
    click(h, { kind: 'lfpick-open', pick: 'affix' });
    drawLootFilterPanel(ctx, layoutFor(h)); // picker open
    click(h, { kind: 'lfpreset-rename' });
    drawLootFilterPanel(ctx, layoutFor(h)); // editing
    expect(calls.length).toBeGreaterThan(100);
  });
});

describe('selection', () => {
  it('ensureSelection falls back to the top rule, or none', () => {
    const h = makeHost();
    ensureSelection(h);
    expect(h.lootUi.ruleId).toBeNull();
    click(h, { kind: 'lfrule-add' });
    h.lootUi.ruleId = 'gone';
    ensureSelection(h);
    expect(h.lootUi.ruleId).toBe('r1');
  });
});
