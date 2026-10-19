import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import PreviewSection, { warningText } from '../SeedPreviewSection.jsx';

// Preview warnings are objects ({ code, ... }) since plan 2: rendering them
// must not throw "Objects are not valid as a React child".
describe('SeedPreviewSection warnings', () => {
  const warnings = [
    { code: 'schema_older' },
    { code: 'dangling_name', table: 'entity_types', key: 'Goblin', column: 'auras', name: 'Frost Ring', target: 'aura_effects', syncUuid: 'u1' },
    { code: 'dangling_name', table: 'entity_types', key: 'Goblin', column: 'auras', name: 'Fire Ring', target: 'aura_effects', syncUuid: 'u1' },
  ];
  it('renders schema_older and dangling_name objects', () => {
    const html = renderToString(h(PreviewSection, { data: { rows: [], warnings }, decisions: {}, setDecisions: () => {} }));
    expect(html).toContain('older database schema');
    expect(html).toContain('Goblin: auras &#x27;Frost Ring&#x27; does not exist here');
    expect(html).toContain('Fire Ring');
  });
  it('warningText falls back to the code', () => {
    expect(warningText({ code: 'sx_unknown' })).toBe('sx_unknown');
  });
});

describe('SeedPreviewSection multi-table group (SOMET-639)', () => {
  const r = (syncUuid, table, key) => ({ syncUuid, table, key, kind: 'changed', defaultDecision: 'git', fields: [{ name: 'f', local: 1, git: 2 }], blockedReason: null });
  const data = {
    tables: [{ table: 'entity_types' }, { table: 'creature_drops' }],
    rows: [r('a', 'creature_drops', 'Goblin → Rusty Sword'), r('b', 'entity_types', 'Goblin')],
    warnings: [
      { code: 'schema_older' },
      { code: 'dangling_name', table: 'entity_types', key: 'Goblin', column: 'aura', name: 'Frost Ring', syncUuid: 'b' },
      { code: 'missing_ref', table: 'creature_drops', key: 'Goblin → Rusty Sword', column: 'item', target: 'item_types' },
      { code: 'invalid_value', key: 'xp_rate', error: 'must be > 0' },
    ],
  };
  it('renders table sub-headings in group order plus every warning', () => {
    const html = renderToString(h(PreviewSection, { data, decisions: {}, setDecisions: () => {} }));
    expect(html.indexOf('Entities')).toBeGreaterThan(-1);
    expect(html.indexOf('Entities')).toBeLessThan(html.indexOf('Drops'));
    expect(html).toContain('Goblin → Rusty Sword');
    expect(html).toContain('points to a missing Items row');
    expect(html).toContain('Setting xp_rate: must be &gt; 0');
    expect(html).toContain('older database schema');
  });
  it('shows no sub-heading for a single-table group', () => {
    const one = { tables: [{ table: 'quests' }], rows: [r('c', 'quests', 'Q1')], warnings: [] };
    const html = renderToString(h(PreviewSection, { data: one, decisions: {}, setDecisions: () => {} }));
    expect(html).not.toContain('<h4');
  });
});

describe('SeedPreviewSection rename notes (SOMET-639)', () => {
  const row = (syncUuid, table, key) => ({
    syncUuid, table, key, kind: 'changed', defaultDecision: 'git', blockedReason: null,
    fields: [{ name: 'name', local: `${key} old`, git: key }],
  });
  it('names where each renamed table\'s references live', () => {
    const data = { tables: [{ table: 'aura_effects' }], rows: [row('a', 'aura_effects', 'Frost Ring')], warnings: [] };
    const html = renderToString(h(PreviewSection, { data, decisions: {}, setDecisions: () => {} }));
    expect(html).toContain('rename — entities&#x27; aura lists will follow');
    expect(html).not.toContain('worlds/biomes');
    const ent = { tables: [{ table: 'entity_types' }], rows: [row('b', 'entity_types', 'Goblin')], warnings: [] };
    expect(renderToString(h(PreviewSection, { data: ent, decisions: {}, setDecisions: () => {} })))
      .toContain('rename — references in worlds/biomes will follow');
  });
});

// SOMET-640 (plan 3): Art previews run to ~1100 rows. A section renders 200
// rows at a time; bulk actions and filters act on every row of the section.
// vitest is node-env with no DOM library, so the click is exercised as its
// state step (nextShown) and the paging rendered at that state.
import { PAGE_ROWS, nextShown, filterRows, pickedRows, bulkSet as bulkSetM, applyGate as gateM } from '../seedExportModel.js';

describe('SeedPreviewSection large previews (SOMET-640)', () => {
  const rows = Array.from({ length: 450 }, (_, i) => ({
    syncUuid: `u${i}`, table: 'item_types', key: `row${i}`, kind: 'changed', defaultDecision: null, fields: [], blockedReason: null,
  }));
  const data = { tables: [{ table: 'item_types' }], rows, warnings: [] };
  const count = (html) => (html.match(/aria-label="select row\d+"/g) || []).length;

  it('renders 200 rows, then 400 after one Show 200 more', () => {
    const first = renderToString(h(PreviewSection, { data, decisions: {}, setDecisions: () => {} }));
    expect(count(first)).toBe(200);
    expect(first).toContain('Show 200 more');
    expect(first).toContain('select all 450 listed rows');
    const after = renderToString(h(PreviewSection, { data, decisions: {}, setDecisions: () => {}, initialShown: nextShown(PAGE_ROWS) }));
    expect(count(after)).toBe(400);
    expect(after).toContain('Show 200 more');
    const all = renderToString(h(PreviewSection, { data, decisions: {}, setDecisions: () => {}, initialShown: nextShown(nextShown(PAGE_ROWS)) }));
    expect(count(all)).toBe(450);
    expect(all).not.toContain('Show 200 more');
  });

  it('a bulk Take git over "select all" decides all 450, not only the rendered ones', () => {
    const visible = filterRows(rows, new Set(), '');
    expect(visible).toHaveLength(450);
    const picked = new Set(visible.map((r) => r.syncUuid)); // what select-all sets
    const decided = bulkSetM({}, pickedRows(visible, picked), 'git', rows);
    expect(Object.keys(decided)).toHaveLength(450);
    expect(gateM(rows, decided).canApply).toBe(true);
  });

  it('wires the button to nextShown and select-all / bulk to every listed row', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'SeedPreviewSection.jsx'), 'utf8');
    expect(src).toContain('setShown((n) => nextShown(n))');
    expect(src).toContain('pickedRows(visible, picked)');
    expect(src).toContain('new Set(visible.map((r) => r.syncUuid))');
  });

  it('shows asset values and blocked reasons readably', () => {
    const one = {
      tables: [{ table: 'item_types' }], warnings: [],
      rows: [{
        syncUuid: 'a', table: 'item_types', key: 'Sword', kind: 'changed', defaultDecision: null,
        allowedDecisions: ['local'], blockedReason: 'asset_file_missing', blockedMessage: 'raw',
        fields: [{ name: 'icon', local: { unhashed: 'items/sword.png' }, git: { file: 'textures/items/sword.png', sha256: 'abcdef0123' } }],
      }],
    };
    const html = renderToString(h(PreviewSection, { data: one, decisions: {}, setDecisions: () => {} }));
    expect(html).toContain('local art not exported yet');
    expect(html).toContain('textures/items/sword.png · abcdef01');
    expect(html).toContain('File missing in git checkout — pull again or re-export on the other PC');
  });
});

// SOMET-641 final review I2: Keep local (row button or bulk) on a no-baseline
// row asks window.confirm with the loss list first (node-env: source gate).
describe('SeedPreviewSection Keep local on a no-baseline row', () => {
  it('confirms before both the row button and the bulk Keep local', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'SeedPreviewSection.jsx'), 'utf8');
    expect(src).toContain('keepLocalConfirmText');
    expect(src).toContain('const decide = (uuids, d) => {');
    expect(src).toContain("if (d === 'local') {");
    expect(src).toContain('if (msg && !window.confirm(msg)) return;');
    expect(src).toContain("onClick={() => decide(pickedVisible, 'local')}");
    expect(src).toContain('onClick={() => decide([r.syncUuid], d)}');
  });
});

// SOMET-641 final review E2: a baseline row (no blockedReason) shows its
// blockedMessage under the row.
describe('SeedPreviewSection baseline row message', () => {
  it('renders the message of a row with no blockedReason', () => {
    const data = {
      tables: [{ table: 'map_specs' }], warnings: [],
      rows: [{
        syncUuid: 'b1', table: 'map_specs', key: 'vale-region', kind: 'baseline', defaultDecision: 'local',
        allowedDecisions: ['local'], blockedReason: null, fields: [],
        blockedMessage: 'Seed Maps once to record this PC baseline — sx row message',
      }],
    };
    const html = renderToString(h(PreviewSection, { data, decisions: {}, setDecisions: () => {} }));
    expect(html).toContain('sx row message');
  });
});
