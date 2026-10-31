import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '../CharacterSelect.jsx'), 'utf8');
const panel = /const Panel = styled\.div`([\s\S]*?)`;/.exec(source)[1];
const card = /const Card = styled\.div`([\s\S]*?)`;/.exec(source)[1];

describe('character select layout', () => {
  it('scrolls, and does not centre with flex alignment (that hides the top of tall content)', () => {
    expect(panel).toMatch(/overflow-y:\s*auto/);
    // Strip comments first: the explanation mentions the properties on purpose.
    const css = panel.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/align-items:\s*center/);
    expect(css).not.toMatch(/justify-content:\s*center/);
  });

  it('centres the card with auto margins instead', () => {
    expect(card).toMatch(/margin:\s*auto/);
  });
});
