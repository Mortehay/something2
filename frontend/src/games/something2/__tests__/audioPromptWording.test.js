// Admin copy for the audio prompt writer (final review M9 + the text-provider
// hint). A SOURCE-TEXT test: vitest runs in a node environment here, so these
// components cannot be rendered, and the wording is the whole change.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, '..', p), 'utf8');

describe('audio prompt admin wording', () => {
  it("the 'written' filter says it excludes stale rows (a stale prompt IS a prompt)", () => {
    const src = read('AudioSlotTable.jsx');
    expect(src).toMatch(/<option value="written">Written \(current\)<\/option>/);
    expect(src).not.toMatch(/>Has prompt</);
  });

  it('the text-provider hint says it must be the GPU box, with no CPU fallback otherwise', () => {
    const src = read('SettingsAdmin.jsx');
    expect(src).toMatch(/GPU box's \/api\/text/);
    expect(src).toMatch(/4xx/);
    expect(src).toMatch(/leave Text providers inactive/i);
  });
});
