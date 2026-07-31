import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// F-046/SOMET-226: the Worlds picker's delete-world trash icon and the
// world-creation form were rendered unconditionally, so a non-admin player
// saw a destructive-looking, admin-only control that the backend correctly
// rejects with 403 -- a UI gating bug, not a security hole, but a real UX
// defect (a control that looks available and then silently fails).
//
// Something2.jsx has since been split; the Worlds picker now lives in
// GameView.jsx. The guarded JSX moved verbatim, so both assertions still apply.
//
// GameView.jsx isn't rendered in tests (vitest here runs in a plain node
// environment, no jsdom/RTL), so this is a source-structure regression test:
// it asserts the destructive controls are lexically wrapped in the same
// `isAdmin &&` guard already used for the admin-only nav entries, rather than a
// rendered-DOM assertion.
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '../GameView.jsx'), 'utf8');

describe('Worlds picker admin gating', () => {
  it('gates the delete-world trash icon behind isAdmin', () => {
    expect(source).toMatch(/\{isAdmin\s*&&\s*\(\s*<HiOutlineTrash/);
  });

  it('gates the world-creation form behind isAdmin', () => {
    expect(source).toMatch(/\{isAdmin\s*&&\s*\(\s*<div style=\{\{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '15px' \}\}>/);
  });
});
