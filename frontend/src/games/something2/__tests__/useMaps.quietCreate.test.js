import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// vitest runs in node (no jsdom), so hooks cannot be rendered: read the source,
// like the other source-gate tests. SOMET-700.
const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const hook = readFileSync(join(dir, 'useMaps.js'), 'utf8').split('export function useCreateEntityType')[1].split('export function useUpdateEntityType')[0];

describe('useCreateEntityType quiet option', () => {
  it('gates both toasts behind quiet', () => {
    expect(hook).toMatch(/\{\s*quiet\s*=\s*false\s*\}/);
    expect(hook).toMatch(/if \(!quiet\) toast\.success/);
    expect(hook).toMatch(/if \(!quiet\) toast\.error/);
  });
  it('the sprite tab passes quiet, the Entities tab does not', () => {
    expect(readFileSync(join(dir, 'SpriteConsoleAdmin.jsx'), 'utf8')).toMatch(/useCreateEntityType\(\{ quiet: true \}\)/);
    expect(readFileSync(join(dir, 'EntityTypesAdmin.jsx'), 'utf8')).toMatch(/useCreateEntityType\(\)/);
  });
});
