import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// SOMET-725. The How to play panel sat over the trade, chest and merchant
// windows because it lived outside HiddenWhilePaired. vitest's node environment
// cannot mount GameShell, so this reads the source: the panel must be inside the
// wrapper the HUD already uses for every paired window.
describe('the Help panel beside a paired window', () => {
  const src = fs.readFileSync(path.join(here, '../GameShell.jsx'), 'utf8');

  it('imports the wrapper', () => {
    expect(src).toMatch(/import \{ HiddenWhilePaired \} from "\.\/pairedWindowHud\.jsx"/);
  });

  it('renders HelpBackdrop inside HiddenWhilePaired', () => {
    expect(src).toMatch(/\{helpOpen && \(\s*<HiddenWhilePaired gameRef=\{gameRef\}>\s*<HelpBackdrop[\s\S]*<\/HelpBackdrop>\s*<\/HiddenWhilePaired>/);
  });
});
