import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// These are source-text regression tests, not rendered-DOM tests: vitest in this
// project runs in a plain node environment (no jsdom, no React Testing Library),
// so nothing under frontend/src/ui actually renders here. Each assertion below
// is not tautological busywork -- it corresponds to a specific mutation a
// whole-branch review made by hand, and the full 552-test suite still passed
// with the mutation in place. That is the gap these tests close:
//
//   (a) RequireAdmin.jsx: `to ? <Navigate .../> : <Outlet />` mutated to
//       `to ? <Outlet /> : <Outlet />` opens every admin screen to every
//       signed-in non-admin -- and every existing test still passed.
//   (b) RequireAuth.jsx: the identical mutation on the identical shape --
//       same result, same silent pass.
//   (c) MainNav.jsx: `visibleSections(isAdmin).map(...)` mutated to
//       `NAV_SECTIONS.map(...)` shows every non-admin all six admin links in
//       the sidebar -- and every existing test still passed.
//   (d) GameShell.jsx: `useMatch('/game')` (an END match) mutated to a prefix
//       match (`useMatch('/game/*')`) paints the game canvas over every admin
//       panel, since /game/tiles, /game/entities, etc. would then also count
//       as "the game route". The canvas-bind effect's dependency array is
//       pinned too, so a regression back to the old `[isGameRoute, authed]`
//       shape (the remount bug F-045's comment above the effect documents)
//       fails here instead of shipping silently again.
//
// Each regex below is written to match the CORRECT branch/shape, so it FAILS
// against the mutated source -- verified by hand-applying each mutation, running
// this file, watching it fail, then reverting.

const uiDir = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(uiDir, rel), 'utf8');

describe('RequireAdmin redirects non-admins instead of always rendering the Outlet', () => {
  it('returns the Navigate branch when a redirect target exists', () => {
    const source = read('../RequireAdmin.jsx');
    expect(source).toMatch(/return to \? <Navigate to=\{to\} replace \/> : <Outlet \/>;/);
  });
});

describe('RequireAuth redirects signed-out visitors instead of always rendering the Outlet', () => {
  it('returns the Navigate branch when a redirect target exists', () => {
    const source = read('../RequireAuth.jsx');
    expect(source).toMatch(/return to \? <Navigate to=\{to\} replace \/> : <Outlet \/>;/);
  });
});

describe('MainNav hides admin-only sections from non-admins', () => {
  const source = read('../MainNav.jsx');

  it('maps over visibleSections(isAdmin), not the raw section table', () => {
    expect(source).toMatch(/visibleSections\(isAdmin\)\.map\(/);
  });

  it('never iterates NAV_SECTIONS directly', () => {
    expect(source).not.toMatch(/NAV_SECTIONS\.map\(/);
  });
});

describe('GameShell only shows the canvas on the exact /game route', () => {
  const source = read('../../games/something2/GameShell.jsx');

  it('uses an END match on /game, not a prefix match', () => {
    expect(source).toMatch(/useMatch\('\/game'\)/);
    expect(source).not.toMatch(/useMatch\('\/game\/\*'\)/);
  });

  it('closes the canvas-bind effect on [isGameRoute] only', () => {
    expect(source).toMatch(/\}, \[isGameRoute\]\);/);
  });
});
