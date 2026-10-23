process.env.TZ = 'UTC';
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SpriteTable, ConceptButtons, confirmAndDelete } from '../SpriteConsoleAdmin.jsx';

const render = (rows) => renderToString(h(
  QueryClientProvider, { client: new QueryClient() },
  h(SpriteTable, { rows, selected: new Set(), run: null, onToggle() {}, onPreview() {}, onTogglePage() {} }),
));
const creature = (over = {}) => ({
  id: 'e1', name: 'Cultist', generation_kind: 'creature', is_creature: true, job_state: 'done',
  job_updated_at: '2026-10-23T01:12:00.000Z', ...over,
});

describe('sprite table', () => {
  it('has a Last update column showing the local time', () => {
    const html = render([creature()]);
    expect(html).toContain('<th>Last update</th>');
    expect(html).toContain('23 Oct 01:12');
    expect(html).toContain('title="2026-10-23T01:12:00.000Z"');
  });
  it('a creature with no concept says a new one will be drawn, with no thumbnail button', () => {
    const html = render([creature()]);
    expect(html).toContain('New concept will be drawn');
    expect(html).not.toContain('Preview concept');
  });
  it('a creature with a kept concept keeps the thumbnail button', () => {
    const html = render([creature({ kept_concept_key: 'sprites/Cultist/c.png' })]);
    expect(html).toContain('Preview concept: Cultist');
    expect(html).not.toContain('New concept will be drawn');
  });
});

describe('concept buttons', () => {
  const buttons = (props) => renderToString(h(ConceptButtons, { count: 0, deletePending: false, clearPending: false, onDelete() {}, onClear() {}, ...props }));
  it('are disabled with nothing selected', () => {
    const html = buttons({});
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Delete generated</);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>New concept</);
  });
  it('are enabled with a selection, disabled while their own mutation is pending', () => {
    const on = buttons({ count: 2 });
    expect(on).not.toMatch(/disabled/);
    expect(buttons({ count: 2, deletePending: true })).toMatch(/<button[^>]*disabled[^>]*>Delete generated</);
    expect(buttons({ count: 2, deletePending: true })).not.toMatch(/<button[^>]*disabled[^>]*>New concept</);
    expect(buttons({ count: 2, clearPending: true })).toMatch(/<button[^>]*disabled[^>]*>New concept</);
  });
});

describe('flat prop and confirm', () => {
  it('a never-queued prop shows its thumbnail, not the hint', () => {
    const html = render([{ id: 'p1', name: 'Rock', is_creature: false, is_playable: false, image: 'art/rock.png' }]);
    expect(html).toContain('Preview concept: Rock');
    expect(html).not.toContain('New concept will be drawn');
  });
  it('cancelling the confirm sends no request; accepting sends targets and names', () => {
    const rows = [{ id: 'e1', name: 'Cultist' }];
    const sent = [];
    expect(confirmAndDelete(() => false, (b) => sent.push(b), rows)).toBe(false);
    expect(sent).toEqual([]);
    expect(confirmAndDelete(() => true, (b) => sent.push(b), rows)).toBe(true);
    expect(sent).toEqual([{ targets: [{ entity_id: 'e1', variant: undefined }], names: { e1: 'Cultist' } }]);
  });
});
