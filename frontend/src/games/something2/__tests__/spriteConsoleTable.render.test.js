process.env.TZ = 'UTC';
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ColumnFilterFields, DirectionsField, SpriteTable, ConceptButtons, confirmAndDelete, confirmAndClearConcepts } from '../SpriteConsoleAdmin.jsx';
import { SpritePromptCell, submitPromptDraft, PROMPT_MAX_LENGTH } from '../SpritePromptCell.jsx';
import { EffectStripPreview, effectBackground, effectRedrawTarget } from '../EffectStripPreview.jsx';
import { effectRows } from '../effectSprites.js';
import { selectAllSpriteSubjects, setSpritePageSelected, isSpritePageSelected } from '../spriteSelection.js';

const render = (rows, props = {}) => renderToString(h(
  QueryClientProvider, { client: new QueryClient() },
  h(SpriteTable, { rows, selected: new Set(), run: null, onToggle() {}, onPreview() {}, onTogglePage() {}, ...props }),
));
const creature = (over = {}) => ({
  id: 'e1', name: 'Cultist', generation_kind: 'creature', is_creature: true, job_state: 'done',
  job_updated_at: '2026-10-23T01:12:00.000Z', ...over,
});

describe('sprite table directions', () => {
  it('has a Directions column between Actions and Frames', () => {
    const headers = [...render([creature()]).matchAll(/<th[^>]*>(?:<button[^>]*>)?([A-Z][A-Za-z /]*)/g)].map((m) => m[1]);
    expect(headers.slice(headers.indexOf('Actions'), headers.indexOf('Actions') + 3)).toEqual(['Actions', 'Directions', 'Frames']);
  });
  it('shows the directions of the latest job', () => {
    expect(render([creature({ directions: ['s', 'e'] })])).toContain('s · e');
    expect(render([creature({ directions: ['s', 'e', 'w'], real_western: true })])).toContain('s · e · w');
    expect(render([creature({ directions: ['s', 'e', 'w'], real_western: true })])).not.toContain('real west');
  });
});

describe('sprite table took/est', () => {
  it('a finished row shows "took … (est. …)"', () => {
    const html = render([creature({ sheet_seconds: 3120, predicted_seconds: 2950 })]);
    expect(html).toContain('took 52 min (est. 49 min)');
    expect(render([creature({ sheet_seconds: 3120 })])).toContain('took 52 min');
    expect(render([creature({ sheet_seconds: 3120 })])).not.toContain('est.');
    expect(render([creature()])).not.toContain('took');
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
    const warn = 'West rows add no new view: the game draws the east row flipped. With no east row ticked, it flips the west row to face east.';
    expect(field(['s', 'e', 'n'])).not.toContain(warn);
    expect(field(['s', 'w'])).toContain(warn);
  });
});

describe('sprite table', () => {
  it('has a Last update column showing the local time', () => {
    const html = render([creature()]);
    expect(html).toMatch(/<th[^>]*><button[^>]*>Last update/);
    expect(html).toContain('23 Oct 01:12');
    expect(html).toContain('title="2026-10-23T01:12:00.000Z"');
  });
  const headerCell = (label, sort) => render([creature()], { sort })
    .match(new RegExp(`<th[^>]*><button[^>]*>${label}.*?</th>`))[0];
  it.each(['Shape', 'Actions', 'Directions', 'Backend', 'Status', 'Last update'])('%s is a sort button with a description', (label) => {
    const cell = headerCell(label, null);
    expect(cell).toContain('aria-sort="none"');
    expect(cell).toMatch(/title="[^"]{10,}"/);
    expect(cell).not.toMatch(/[▼▲]/);
  });
  it('only the sorted column announces its direction', () => {
    const sort = { column: 'status', dir: 'desc' };
    expect(headerCell('Status', sort)).toContain('aria-sort="descending"');
    expect(headerCell('Status', sort)).toContain('▼');
    expect(headerCell('Shape', sort)).toContain('aria-sort="none"');
    const asc = headerCell('Last update', { column: 'updated', dir: 'asc' });
    expect(asc).toContain('aria-sort="ascending"');
    expect(asc).toContain('▲');
  });
  it('columns with no sort stay plain headers', () => {
    const html = render([creature()]);
    for (const label of ['Concept', 'Entity', 'Frames', 'Prompt']) expect(html).toContain(`<th>${label}</th>`);
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

describe('column filter fields', () => {
  const fields = (filters = {}, subjects = []) => renderToString(h(ColumnFilterFields, {
    subjects, filters: { actions: 'all', directions: 'all', backend: 'all', updated: 'all', ...filters }, onChange() {},
  }));
  it('offers Actions, Directions, Backend and Last update, each with Any', () => {
    const html = fields();
    for (const label of ['Actions', 'Directions', 'Backend', 'Last update']) expect(html).toContain(label);
    expect(html.match(/<select/g)).toHaveLength(4);
  });
  it('lists what the rows actually hold', () => {
    const html = fields({}, [{ actions: ['idle'], directions: ['s'], backend: 'gpu-box', sheet_method: 'turnaround3d' }]);
    for (const value of ['idle', 's', 'gpu-box', '3D']) expect(html).toContain(`value="${value}"`);
  });
  it('offers None only where a row can lack the value', () => {
    const html = fields();
    expect(html.match(/value="none"/g)).toHaveLength(2);
    expect(html).toContain('value="never"');
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

describe('effect rows in the sprite table', () => {
  const item = (name, group, kind, over = {}) => ({
    subject_kind: kind === 'aura' ? 'aura' : 'vfx', name, group, kind, blend: 'additive', color: '#ff0000',
    default_prompt: `${name} default`, default_frames: 8, default_loop: kind !== 'burst', max_frames: 64,
    prompt: `${name} default`, prompt_source: 'template', prompt_origin: null, prompt_kind: kind === 'aura' ? 'aura' : 'vfx', prompt_key: name,
    missing: false, sprite: null, job: null, ...over,
  });
  const fx = (items) => effectRows({ subjects: items });
  it('an effect row shows "one direction" greyed with the tooltip, its frames and loop, and no Body select', () => {
    const html = render(fx([item('bolt_fire', 'Bolts', 'projectile', { job: { id: 3, status: 'queued', frames: 12, loop: true } })]));
    expect(html).toMatch(/<span[^>]*title="effects have one direction"[^>]*>one direction<\/span>/);
    expect(html).toContain('<td>12</td>');
    expect(html).toContain('<td>loop</td>');
    expect(html).toContain('<td>gpu-box</td>');
    expect(html).toContain('>effect<');
    expect(html).not.toContain('Body of bolt_fire');
    const burst = render(fx([item('spark_hit', 'Impacts', 'burst')]));
    expect(burst).toContain('<td>one-shot</td>');
    expect(burst).toContain('<td>8</td>');
  });
  it('an effect row shows its status, "prompt pending" while the prompt is being written, and its error in red', () => {
    expect(render(fx([item('bolt_fire', 'Bolts', 'projectile', { job: { id: 3, status: 'queued', needs_prompt: true } })]))).toContain('prompt pending');
    expect(render(fx([item('bolt_fire', 'Bolts', 'projectile', { job: { id: 3, status: 'done', image_key: 'k.png', frames: 8 } })]))).toContain('ready to approve');
    expect(render(fx([item('bolt_fire', 'Bolts', 'projectile', { job: { id: 3, status: 'failed', error: 'box timed out' } })])))
      .toMatch(/title="box timed out"[^>]*>failed: box timed out/);
  });
  it('the prompt cell offers Regenerate prompt for creatures, appearances and effects but not props; Revert only for a Sprite-tab prompt', () => {
    const cell = (subject, props = {}) => renderToString(h(SpritePromptCell, { subject, onRegenerate() {}, onSave() {}, onRevert() {}, ...props }));
    const wolf = { id: 1, name: 'Wolf', prompt: 'grey wolf', prompt_kind: 'entity', prompt_key: 'Wolf', sprite_prompt: 'grey wolf', sprite_prompt_source: 'template' };
    const skin = { id: '4:1', name: 'Mage skin', prompt_kind: 'character_appearance', prompt_key: 'Mage:1', sprite_prompt: 'a mage', sprite_prompt_source: 'template' };
    const rock = { id: 2, name: 'Rock', prompt: 'a rock', prompt_kind: null, prompt_key: null, sprite_prompt: null, sprite_prompt_source: null };
    for (const s of [wolf, skin, fx([item('bolt_fire', 'Bolts', 'projectile')])[0]]) {
      const html = cell(s);
      expect(html).toContain('Regenerate prompt');
      expect(html).toContain('>Edit<');
      expect(html).toContain('>template<');
      expect(html).not.toContain('>Revert<');
    }
    const prop = cell(rock);
    expect(prop).toContain('a rock');
    expect(prop).not.toContain('Regenerate prompt');
    expect(prop).not.toContain('>Edit<');
    const sprite = cell({ ...wolf, sprite_prompt: 'a lean grey wolf', sprite_prompt_source: 'description', sprite_prompt_origin: 'sprite' });
    expect(sprite).toContain('a lean grey wolf');
    expect(sprite).toContain('>Sprite tab<');
    expect(sprite).toContain('>Revert<');
    const art = cell({ ...wolf, sprite_prompt: 'from the art console', sprite_prompt_source: 'description', sprite_prompt_origin: null });
    expect(art).toContain('>art console<');
    expect(art).toContain('>Revert<');
  });
  it('Revert says the regenerated concept is kept, only for a creature row with one', () => {
    const base = { id: 1, name: 'Wolf', prompt_kind: 'entity', prompt_key: 'Wolf', sprite_prompt: 'a wolf', sprite_prompt_source: 'description', sprite_prompt_origin: 'sprite' };
    const cell = (s) => renderToString(h(SpritePromptCell, { subject: s, onRevert() {} }));
    const hint = 'The regenerated concept image is kept — use New concept to go back to the approved art.';
    const withConcept = cell({ ...base, kept_concept_key: 'k.png', kept_concept_regenerated: true });
    expect(withConcept).toContain('>Revert<');
    expect(withConcept).toContain(hint);
    expect(cell({ ...base, kept_concept_key: 'k.png', kept_concept_regenerated: false })).not.toContain('concept image is kept');
    expect(cell(base)).not.toContain('concept image is kept');
    const effect = cell({ ...base, effect: true, kept_concept_key: 'k.png', kept_concept_regenerated: true });
    expect(effect).toContain('>Revert<');
    expect(effect).not.toContain('concept image is kept');
  });
  it('a pending prompt cell shows it is working and disables its buttons', () => {
    const wolf = { id: 1, name: 'Wolf', prompt_kind: 'entity', prompt_key: 'Wolf', sprite_prompt: 'grey wolf', sprite_prompt_source: 'description', sprite_prompt_origin: 'sprite' };
    const html = renderToString(h(SpritePromptCell, { subject: wolf, pending: true }));
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Regenerating…</);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Edit</);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Revert</);
  });
  it('the table wires the prompt cell for every row', () => {
    const html = render([creature({ prompt_kind: 'entity', prompt_key: 'Cultist', sprite_prompt: 'robed cultist', sprite_prompt_source: 'template' })]);
    expect(html).toContain('robed cultist');
    expect(html).toContain('Regenerate prompt');
  });
  it('group headers appear above the first effect row of each group', () => {
    const rows = fx([item('a1', 'Auras', 'aura'), item('a2', 'Auras', 'aura'), item('b1', 'Bolts', 'projectile'), item('i1', 'Impacts', 'burst'), item('m1', 'Beams', 'beam')]);
    const html = render([creature(), ...rows]);
    expect((html.match(/data-group-row/g) || []).length).toBe(4);
    for (const g of ['Auras', 'Bolts', 'Impacts', 'Beams']) expect(html).toMatch(new RegExp(`data-group-row[^>]*><td[^>]*colSpan="13"[^>]*>${g}<`, 'i'));
    expect(html.indexOf('>Auras<')).toBeLessThan(html.indexOf('>a1<'));
    expect(html.indexOf('>a1<')).toBeLessThan(html.indexOf('>Bolts<'));
    expect(render([creature()])).not.toContain('data-group-row');
  });
  it('a regenerated kept concept captions "Concept — regenerated"', () => {
    const html = render([creature({ kept_concept_key: 'sprites/Cultist/c.png', kept_concept_regenerated: true })]);
    expect(html).toContain('Concept — regenerated');
    expect(html).not.toContain('Concept — reused');
  });
  it('effect thumbnails use mid-grey for alpha effects and dark for additive; a done candidate plays its own job image', () => {
    expect(effectBackground('alpha')).toBe('#808080');
    expect(effectBackground('additive')).toBe('#101018');
    const done = (blend) => fx([item('bolt_fire', 'Bolts', 'projectile', { blend, job: { id: 1, status: 'done', image_key: 'cand.png', frames: 4 } })]);
    expect(render(done('alpha'))).toMatch(/background-color:\s*(#808080|rgb\(128, ?128, ?128\))/i);
    expect(render(done('additive'))).toMatch(/background-color:\s*#101018/);
    expect(render(done('additive'))).toContain('cand.png');
    expect(render(done('additive'))).toContain('Preview strip: bolt_fire');
  });
  it('the strip preview offers Approve for a done candidate and Redraw; Redraw re-queues with the job frames, loop only for bolts and beams', () => {
    const bolt = item('bolt_fire', 'Bolts', 'projectile', { job: { id: 1, status: 'done', image_key: 'k.png', frames: 12, loop: false } });
    const html = renderToString(h(EffectStripPreview, { subject: bolt, onClose() {}, onRedraw() {}, onApprove() {} }));
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Approve</);
    expect(html).toContain('>Redraw<');
    expect(effectRedrawTarget(bolt)).toEqual({ subject_kind: 'vfx', name: 'bolt_fire', frames: 12, loop: false });
    const aura = item('fire_sparks', 'Auras', 'aura', { job: { id: 2, status: 'approved', frames: 8, loop: true } });
    expect(effectRedrawTarget(aura)).toEqual({ subject_kind: 'aura', name: 'fire_sparks', frames: 8 });
    expect(renderToString(h(EffectStripPreview, { subject: aura, onClose() {}, onRedraw() {}, onApprove() {} }))).toMatch(/<button[^>]*disabled[^>]*>Approve</);
  });
});

describe('directions field gating', () => {
  it('greys every facing control with the reason as the title', () => {
    const html = renderToString(h(DirectionsField, { directions: ['s'], onChange() {}, disabled: true, title: 'effects have one direction' }));
    expect(html).toContain('title="effects have one direction"');
    expect((html.match(/disabled=""/g) || []).length).toBe(11);
  });
});

describe('review fixes: prompt save keeps the draft, effect swatch', () => {
  const fakes = () => {
    const log = { draft: 'unchanged', error: 'unset', saving: [] };
    return { log, setters: { setDraft: (v) => { log.draft = v; }, setError: (v) => { log.error = v; }, setSaving: (v) => { log.saving.push(v); } } };
  };
  it('a save closes the editor only after onSave resolves', async () => {
    const { log, setters } = fakes();
    let resolve;
    const pending = submitPromptDraft(() => new Promise((r) => { resolve = r; }), 'new text', setters);
    expect(log.draft).toBe('unchanged');
    expect(log.saving).toEqual([true]);
    resolve();
    expect(await pending).toBe(true);
    expect(log.draft).toBe(null);
    expect(log.error).toBe(null);
    expect(log.saving).toEqual([true, false]);
  });
  it('a refused save keeps the typed text and shows the error', async () => {
    const { log, setters } = fakes();
    expect(await submitPromptDraft(() => Promise.reject(new Error('text model busy: held')), 'typed', setters)).toBe(false);
    expect(log.draft).toBe('unchanged');
    expect(log.error).toBe('text model busy: held');
    expect(log.saving).toEqual([true, false]);
    const html = renderToString(h(SpritePromptCell, {
      subject: { id: 1, name: 'Wolf', prompt_kind: 'entity', prompt_key: 'Wolf', sprite_prompt: 'old', sprite_prompt_source: 'template' },
      initialDraft: 'typed', initialError: 'text model busy: held',
    }));
    expect(html).toContain('>typed</textarea>');
    // The server refuses more than 400 characters (MAX_TEXT); the editor stops there.
    expect(PROMPT_MAX_LENGTH).toBe(400);
    expect(html).toMatch(/<textarea[^>]*maxLength="400"/i);
    expect(html).toMatch(/role="alert"[^>]*>text model busy: held/);
  });
  it('an effect row shows its colour swatch', () => {
    const [row] = effectRows({ subjects: [{ subject_kind: 'vfx', name: 'bolt_fire', group: 'Bolts', kind: 'projectile', blend: 'additive', color: '#ff7a1a', default_frames: 8, default_loop: true, prompt_kind: 'vfx', prompt_key: 'bolt_fire', sprite: null, job: null }] });
    expect(render([row])).toMatch(/title="#ff7a1a"/);
  });
});

describe('effects missing from this database', () => {
  const item = (name, missing) => ({
    subject_kind: 'aura', name, group: 'Auras', kind: 'aura', blend: 'additive', color: '#ff0000',
    default_prompt: `${name} p`, default_frames: 8, default_loop: true, max_frames: 64,
    prompt: `${name} p`, prompt_source: 'template', prompt_origin: null, prompt_kind: 'aura', prompt_key: name,
    missing, sprite: null, job: null,
  });
  const [absent, present] = effectRows({ subjects: [item('fire_sparks', true), item('glow', false)] });
  const tag = (html, re) => html.match(re)?.[0] || '';

  it('select-all and page-select skip a missing row; a present one is kept', () => {
    expect([...selectAllSpriteSubjects([absent, present])]).toEqual([present.id]);
    expect([...setSpritePageSelected(new Set(), [absent, present], true)]).toEqual([present.id]);
    expect(isSpritePageSelected(new Set([present.id]), [absent, present])).toBe(true);
  });
  it('renders it greyed with the hint, checkbox and actions disabled', () => {
    const html = render([absent]);
    expect(html).toContain('not in this database — seed it first');
    expect(tag(html, /<input[^>]*aria-label="Select fire_sparks"[^>]*>/)).toContain('disabled');
    for (const label of ['Regenerate prompt', 'Edit']) {
      expect(tag(html, new RegExp(`<button[^>]*>${label}</button>`))).toContain('disabled');
    }
  });
  it('a present effect row is unaffected', () => {
    const html = render([present]);
    expect(html).not.toContain('seed it first');
    expect(tag(html, /<input[^>]*aria-label="Select glow"[^>]*>/)).not.toContain('disabled');
    expect(tag(html, /<button[^>]*>Edit<\/button>/)).not.toContain('disabled');
  });
  it('a creature checkbox has an accessible name', () => {
    expect(render([creature()])).toContain('aria-label="Select Cultist"');
  });
});
