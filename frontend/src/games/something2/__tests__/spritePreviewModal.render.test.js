import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SpritePreviewModal from '../SpritePreviewModal.jsx';

// Props v2: a GPU-box prop row is a raw concept + ONE edited image (no sheet).
const render = (subject) => renderToString(h(
  QueryClientProvider, { client: new QueryClient() },
  h(SpritePreviewModal, { subject, onClose: () => {} }),
));

const prop = (over = {}) => ({
  id: 12, name: 'Pine Tree', backend: 'gpu-box', generation_kind: 'object', is_creature: false,
  concept_key: 'sprites/Pine_Tree/r/concept.png', image_key: 'sprites/Pine_Tree/r/image.png',
  atlas_key: null, manifest_key: null, actions: ['idle', 'sway'], job_updated_at: 't1', ...over,
});

describe('SpritePreviewModal for a box prop', () => {
  it('shows the raw concept as Used image and the generated (trimmed) image', () => {
    const html = render(prop({ prop_fx: 'sway' }));
    expect(html).toContain('Used image');
    expect(html).toMatch(/<strong[^>]*>Generated \(trimmed\)<\/strong>/);
    expect(html).toContain('concept.png');
    expect(html).toMatch(/alt="Generated \(trimmed\)"[^>]*>|src="[^"]*image\.png[^"]*"[^>]*alt="Generated \(trimmed\)"/);
    expect(html).not.toContain('Sheet (×2)');
  });

  it('sway: labels the effect and previews it with the skew animation', () => {
    const html = render(prop({ prop_fx: 'sway' }));
    expect(html).toContain('Effect on approve: Sway');
    expect(html).toContain('data-fx="sway"');
  });

  it('shine: labels the effect and overlays a glint masked by the same image URL', () => {
    const html = render(prop({ prop_fx: 'shine' }));
    expect(html).toContain('Effect on approve: Shine');
    expect(html).toContain('data-fx="shine"');
    // The glint layer carries the result image as its CSS mask (inline style).
    const glint = /<span[^>]*data-glint="on"[^>]*>/.exec(html);
    expect(glint).not.toBeNull();
    expect(glint[0]).toMatch(/mask-image:\s*url\([^)]*image\.png/);
    expect(glint[0]).toMatch(/-webkit-mask-image:\s*url\([^)]*image\.png/);
  });

  it('none (or a row queued before prop_fx): says None and does not animate, even with sway in actions', () => {
    for (const over of [{ prop_fx: 'none' }, { prop_fx: null, actions: ['idle', 'sway'] }]) {
      const html = render(prop(over));
      expect(html).toContain('Effect on approve: None');
      expect(html).toContain('data-fx="none"');
      expect(html).not.toContain('data-glint="on"');
    }
  });
});

describe('SpritePreviewModal for a creature', () => {
  it('keeps the sheet view and no sway line', () => {
    const html = render({
      id: 4, name: 'Wolf', backend: 'gpu-box', generation_kind: 'creature', is_creature: true,
      concept_key: 'c.png', atlas_key: 'sheet.png', manifest_key: null, actions: ['idle'],
    });
    expect(html).toContain('Sheet (×2)');
    expect(html).not.toContain('Effect on approve');
  });
});

describe('SpritePreviewModal frame redraw', () => {
  const manifest = { version: 1, cell: [96, 96], frames_per_action: 1, rows: [{ row: 0, action: 'idle', direction: 's', frames: 1 }], frames: { 'idle/s/0': [0, 0, 96, 96] } };
  const failed = (over = {}) => ({
    id: 4, name: 'Wolf', backend: 'gpu-box', generation_kind: 'creature', is_creature: true,
    concept_key: 'c.png', atlas_key: null, sheet_atlas_key: 'sheet.png', sheet_manifest_key: 'sheet.json',
    job_state: 'failed', redraw_of: 3, redraw_frames: [{ action: 'idle', direction: 's', frame: 0 }],
    last_error: 'box exploded', sheet_job_id: 3, job_id: 9, box_task_id: null, ...over,
  });
  const renderWith = (subject) => renderToString(h(
    QueryClientProvider, { client: (() => { const c = new QueryClient(); c.setQueryData(['sprite-sheet-manifest', subject.manifest_key || subject.sheet_manifest_key], manifest); return c; })() },
    h(SpritePreviewModal, { subject, onClose: () => {} }),
  ));
  it('failed redraw: banner, retry, discard when discardable', () => {
    const html = renderWith(failed());
    expect(html).toContain('box exploded');
    expect(html).toContain('Retry redraw');
    expect(html).toContain('Discard redraw');
    expect(html).toContain('aria-pressed="true"');
  });
  it('Retry sends the grid\'s marks: disabled when there are none', () => {
    const retryBtn = (html) => /<button[^>]*>Retry redraw<\/button>/.exec(html)[0];
    expect(retryBtn(renderWith(failed()))).not.toMatch(/disabled/);
    expect(retryBtn(renderWith(failed({ redraw_frames: [] })))).toMatch(/disabled/);
  });
  it('a failed redraw whose task never stored a sheet warns that the box state is unknown', () => {
    const unknown = 'The GPU box state is unknown. Queue the whole sheet again to be safe.';
    expect(renderWith(failed({ box_task_id: 't1', atlas_key: null }))).toContain(unknown);
    expect(renderWith(failed({ box_task_id: null }))).not.toContain(unknown);
    expect(renderWith(failed({ box_task_id: 't1', atlas_key: 'x.png', manifest_key: 'sheet.json' }))).not.toContain(unknown);
  });
  it('not discardable once the box task has a sheet', () => {
    const html = renderWith(failed({ box_task_id: 't1', atlas_key: 'x.png', manifest_key: 'sheet.json' }));
    expect(html).toContain('Retry redraw');
    expect(html).not.toContain('Discard redraw');
  });
  it('a queued or running new sheet shows the current sheet as a read-only frame grid', () => {
    const live = (job_state) => renderWith(failed({ job_state, redraw_of: null, redraw_frames: null, last_error: null }));
    for (const [state, line] of [
      ['queued', 'A new sheet is queued; marking is off until it finishes.'],
      ['running', 'A new sheet is being drawn; marking is off until it finishes.'],
    ]) {
      const html = live(state);
      expect(html).toContain('Frames (×2)');
      expect(html).toContain(line);
      expect(html).not.toContain('Sheet (×2)');
      expect(html).not.toMatch(/Redraw \d+ frame/);
      expect(html).not.toContain('Mark row');
      expect(html).toMatch(/aria-label="idle s frame 0"[^>]*disabled|disabled[^>]*aria-label="idle s frame 0"/);
    }
  });
  it('a queued redraw shows the current sheet as a read-only frame grid', () => {
    const html = renderWith(failed({ job_state: 'queued', last_error: null }));
    expect(html).toContain('Frames (×2)');
    expect(html).toContain('Redraw queued: showing the current sheet, read-only');
    expect(html).not.toContain('Retry redraw');
    expect(html).not.toMatch(/Redraw \d+ frame/);
  });
  it('a prop keeps the prop view', () => {
    const html = renderWith(prop());
    expect(html).not.toContain('Retry redraw');
    expect(html).toContain('Generated (trimmed)');
  });
  it('a done redraw offers Compare with previous only when the source sheet is known', () => {
    const done = failed({ job_state: 'done', last_error: null, atlas_key: 'new.png', manifest_key: 'sheet.json', redraw_source_atlas_key: 'old.png' });
    expect(renderWith(done)).toContain('Compare with previous');
    expect(renderWith({ ...done, redraw_source_atlas_key: null })).not.toContain('Compare with previous');
    expect(renderWith(failed({ redraw_source_atlas_key: 'old.png' }))).not.toContain('Compare with previous');
  });
});

describe('SpritePreviewModal concept label and note', () => {
  const creature = (over = {}) => ({
    id: 'e1', name: 'Cultist', generation_kind: 'creature', is_creature: true, backend: 'gpu-box',
    job_updated_at: 't1', ...over,
  });
  it('labels a reused concept and shows the note as a muted line', () => {
    const html = render(creature({
      kept_concept_key: 'sprites/Cultist/c.png', note: 'kept concept unavailable on the box; drew a new one',
    }));
    expect(html).toContain('Concept — reused');
    expect(html).toContain('kept concept unavailable on the box; drew a new one');
  });
  it('says a new concept will be drawn, without a note line', () => {
    const html = render(creature());
    expect(html).toContain('New concept will be drawn');
    expect(html).not.toContain('unavailable on the box');
  });
});
