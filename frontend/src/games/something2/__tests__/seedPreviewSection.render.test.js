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
