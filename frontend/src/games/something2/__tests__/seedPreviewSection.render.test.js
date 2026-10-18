import { describe, it, expect } from 'vitest';
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
