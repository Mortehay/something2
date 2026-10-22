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
  it('not discardable once the box task has a sheet', () => {
    const html = renderWith(failed({ box_task_id: 't1', atlas_key: 'x.png', manifest_key: 'sheet.json' }));
    expect(html).toContain('Retry redraw');
    expect(html).not.toContain('Discard redraw');
  });
  it('a prop keeps the prop view', () => {
    const html = renderWith(prop());
    expect(html).not.toContain('Retry redraw');
    expect(html).toContain('Generated (trimmed)');
  });
});
