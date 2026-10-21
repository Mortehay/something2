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
  it('shows the raw concept as Used image and the edited image as Result, swaying', () => {
    const html = render(prop());
    expect(html).toContain('Used image');
    expect(html).toMatch(/<strong[^>]*>Result<\/strong>/);
    expect(html).toContain('concept.png');
    expect(html).toMatch(/alt="Result"[^>]*>|src="[^"]*image\.png[^"]*"[^>]*alt="Result"/);
    expect(html).toContain('Sways in game: yes');
    expect(html).toContain('data-sway="on"');
    expect(html).not.toContain('Sheet (×2)');
  });

  it('a prop without sway says so and does not animate', () => {
    const html = render(prop({ actions: ['idle'] }));
    expect(html).toContain('Sways in game: no');
    expect(html).not.toContain('data-sway="on"');
  });
});

describe('SpritePreviewModal for a creature', () => {
  it('keeps the sheet view and no sway line', () => {
    const html = render({
      id: 4, name: 'Wolf', backend: 'gpu-box', generation_kind: 'creature', is_creature: true,
      concept_key: 'c.png', atlas_key: 'sheet.png', manifest_key: null, actions: ['idle'],
    });
    expect(html).toContain('Sheet (×2)');
    expect(html).not.toContain('Sways in game');
  });
});
