import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EffectSpritesTable } from '../EffectSpritesSection.jsx';

const GROUPS = [['Auras', 'aura', 9], ['Elemental bolts', 'projectile', 4], ['Impacts', 'burst', 5], ['Beam / chain', 'beam', 3]];
const subjects = GROUPS.flatMap(([group, kind, n]) => Array.from({ length: n }, (_, i) => ({
  subject_kind: kind === 'aura' ? 'aura' : 'vfx', name: `${kind}_${i}`, group, kind, blend: 'additive', color: '#ff0000',
  default_prompt: 'p', sprite: null, job: null,
})));
const render = (rows, props = {}) => renderToString(h(
  QueryClientProvider, { client: new QueryClient() },
  h(EffectSpritesTable, { subjects: rows, selected: new Set(), prompts: {}, onToggle() {}, onPrompt() {}, onGenerate() {}, onApprove() {}, onPreview() {}, ...props }),
));

describe('effects table', () => {
  it('the section lists 21 rows in 4 groups with Generate buttons', () => {
    const html = render(subjects);
    expect((html.match(/>Generate</g) || []).length).toBe(21);
    for (const [g] of GROUPS) expect(html).toContain(g);
    expect((html.match(/data-group-row/g) || []).length).toBe(4);
  });
  it('a done job shows an enabled Approve and "ready to approve"', () => {
    const rows = [{ ...subjects[0], job: { id: 7, status: 'done', image_key: 'k', frames: 4 } }];
    const html = render(rows);
    expect(html).toContain('ready to approve');
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Approve</);
    expect(html).toContain('>Redraw<');
  });
  it('a failed job shows its error and a disabled Approve', () => {
    const html = render([{ ...subjects[0], job: { id: 8, status: 'failed', error: 'box timed out' } }]);
    expect(html).toContain('failed: box timed out');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Approve</);
  });
});
