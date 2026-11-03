import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { NewCreatureFormView } from '../SpriteConsoleAdmin.jsx';

const base = { open: false, name: '', prompt: '', shape: 'creature', error: null, pending: false };
const render = (props) => renderToString(h(NewCreatureFormView, { ...base, onToggle() {}, onChange() {}, onSubmit() {}, ...props }));

describe('NewCreatureFormView', () => {
  it('closed: only the toggle button, no fields', () => {
    const html = render({});
    expect(html).toContain('New creature');
    expect(html).not.toContain('<form');
    expect(html).toContain('aria-expanded="false"');
  });
  it('open: name, prompt, shape options and a Create button', () => {
    const html = render({ open: true });
    expect(html).toContain('<form');
    expect(html).toContain('<textarea');
    expect(html).toContain('>Kind<');
    expect(html).not.toContain('>Shape<');
    expect(html).toContain('>Creature<');
    expect(html).toContain('>Prop<');
    expect(html).toContain('>Create<');
  });
  it('shows the inline error and the pending state', () => {
    expect(render({ open: true, error: 'Name is required' })).toContain('Name is required');
    const pending = render({ open: true, pending: true });
    expect(pending).toContain('Creating…');
    expect(pending).toMatch(/<button[^>]*disabled=""[^>]*>Creating/);
  });
});
