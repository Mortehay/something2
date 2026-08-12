import { describe, it, expect } from 'vitest';
import ItemTypesAdmin from '../ItemTypesAdmin.jsx';

// Vitest runs in a plain Node environment here (no jsdom/RTL), so this cannot
// render. It exists because SOMET-284 edits the JSX and nothing else in the
// suite so much as imports this file — a broken tag or a bad ternary would
// otherwise ship green.

describe('ItemTypesAdmin', () => {
  it('is a component export', () => {
    expect(typeof ItemTypesAdmin).toBe('function');
  });
});
