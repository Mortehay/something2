import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { BoxCancelLines } from '../SpriteConsoleAdmin.jsx';

const lines = [
  { id: 1, text: 'Stopping on the GPU box… (cell 171/205)', retry: false },
  { id: 2, text: 'The GPU box is still drawing a cancelled job (Warrior:2, cell 176/205) — it ignored the cancel', retry: true },
];

describe('BoxCancelLines', () => {
  it('renders both lines and one Retry cancel button for a mixed array', () => {
    const html = renderToString(h(BoxCancelLines, { lines, onRetry: () => {} }));
    expect(html).toContain('Stopping on the GPU box… (cell 171/205)');
    expect(html).toContain('it ignored the cancel');
    expect(html.match(/Retry cancel/g)).toHaveLength(1);
  });
  it('renders nothing for an empty array', () => {
    expect(renderToString(h(BoxCancelLines, { lines: [], onRetry: () => {} }))).toBe('');
  });
});
