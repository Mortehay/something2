import { describe, it, expect } from 'vitest';
import SpriteConsoleAdmin from '../SpriteConsoleAdmin.jsx';

// Vitest runs in a plain Node environment here (no jsdom/RTL), so this cannot
// render. It exists because the appearance-variant rows change edits the JSX
// and nothing else in the suite so much as imports this file -- a broken tag
// or a bad ternary would otherwise ship green.

describe('SpriteConsoleAdmin', () => {
  it('is a component export', () => {
    expect(typeof SpriteConsoleAdmin).toBe('function');
  });
});
