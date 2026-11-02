process.env.TZ = 'UTC';
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DirectionsField, SpriteTable, ConceptButtons, confirmAndDelete, confirmAndClearConcepts } from '../SpriteConsoleAdmin.jsx';

const render = (rows) => renderToString(h(
  QueryClientProvider, { client: new QueryClient() },
  h(SpriteTable, { rows, selected: new Set(), run: null, onToggle() {}, onPreview() {}, onTogglePage() {} }),
));
const creature = (over = {}) => ({
  id: 'e1', name: 'Cultist', generation_kind: 'creature', is_creature: true, job_state: 'done',
  job_updated_at: '2026-10-23T01:12:00.000Z', ...over,
});

describe('sprite table directions', () => {
  it('has a Directions column between Actions and Frames', () => {
    expect(render([creature()])).toContain('<th>Actions</th><th>Directions</th><th>Frames</th>');
  });
  it('shows the directions of the latest job', () => {
    expect(render([creature({ directions: ['s', 'e'] })])).toContain('s · e');
    expect(render([creature({ directions: ['s', 'e', 'w'], real_western: true })])).toContain('s · e · w (real west)');
  });
});

describe('directions field', () => {
  const field = (directions) => renderToString(h(DirectionsField, { directions, onChange() {} }));
  it('offers 2/4/8-way presets and 8 checkboxes, marking the active preset', () => {
    const html = field(['s', 'e']);
    for (const l of ['2-way', '4-way', '8-way']) expect(html).toContain(l);
    expect(html).toContain('Directions (2 of 8)');
    expect(html.match(/type="checkbox"/g)).toHaveLength(8);
    expect(html).toMatch(/aria-pressed="true"[^>]*>2-way/);
  });
  it('says custom when no preset matches', () => {
    expect(field(['s', 'e', 'n'])).toContain('custom (3)');
  });
  it('warns about west only when a western direction is ticked', () => {
    const warn = 'West-facing rows from the box have looked wrong before — check them in the preview.';
    expect(field(['s', 'e', 'n'])).not.toContain(warn);
    expect(field(['s', 'w'])).toContain(warn);
  });
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
  it('a kept-concept row shows the thumbnail with the caption "Concept — reused"', () => {
    const html = render([creature({ kept_concept_key: 'sprites/Cultist/c.png' })]);
    expect(html).toContain('Preview concept: Cultist');
    expect(html).toMatch(/Preview concept: Cultist[\s\S]*Concept — reused/);
  });
  it('a used concept with no kept one (after New concept) shows the old thumbnail and "New concept will be drawn"', () => {
    const html = render([creature({ concept_key: 'sprites/Cultist/r1/concept.png' })]);
    expect(html).toContain('Preview concept: Cultist');
    expect(html).toContain('r1/concept.png');
    expect(html).toMatch(/Preview concept: Cultist[\s\S]*New concept will be drawn/);
    expect(html).not.toContain('Used concept');
  });
  it('a no-concept row shows only the hint', () => {
    const html = render([creature()]);
    expect(html.match(/New concept will be drawn/g)).toHaveLength(1);
    expect(html).not.toContain('<img');
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

describe('New concept confirm', () => {
  it('cancelling sends nothing; accepting sends targets and names; the text names the count', () => {
    const rows = [{ id: 'e1', name: 'Cultist' }];
    const asked = [];
    const sent = [];
    expect(confirmAndClearConcepts((t) => { asked.push(t); return false; }, (b) => sent.push(b), rows)).toBe(false);
    expect(sent).toEqual([]);
    expect(asked).toEqual(['Forget the kept concept for 1 subject? The next run draws a new one.']);
    expect(confirmAndClearConcepts(() => true, (b) => sent.push(b), rows)).toBe(true);
    expect(sent).toEqual([{ targets: [{ entity_id: 'e1', variant: undefined }], names: { e1: 'Cultist' } }]);
  });
});
