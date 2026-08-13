import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CreatureBehaviorsAdmin from '../CreatureBehaviorsAdmin.jsx';
import { CHASE_STYLES } from '../behaviorForm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.join(here, '../../../App.jsx'), 'utf8');
const admin = fs.readFileSync(path.join(here, '../CreatureBehaviorsAdmin.jsx'), 'utf8');

// SOMET-254: `typeof === 'function'` alone stays green even if this file
// exported the wrong component (a copy-paste from a sibling *Admin.jsx that
// also default-exports a bare function) or the route pointing at it silently
// went missing/renamed after a refactor -- neither is hypothetical, see the
// project's own "Sidebar nav routing" incident (two gating traps that
// shipped green behind an identical-looking smoke test). Strengthened to
// catch both without a DOM render.
describe('CreatureBehaviorsAdmin', () => {
  it('is a component export', () => {
    expect(typeof CreatureBehaviorsAdmin).toBe('function');
  });

  it('is named CreatureBehaviorsAdmin, not an anonymous or re-exported function', () => {
    expect(CreatureBehaviorsAdmin.name).toBe('CreatureBehaviorsAdmin');
  });

  it('takes no props (a page-level route component)', () => {
    expect(CreatureBehaviorsAdmin.length).toBe(0);
  });

  // vitest runs in a plain node environment for this project (no jsdom /
  // react-testing-library -- see frontend/vitest.config.js), so an actual DOM
  // render is not available here. frontend/src/ui/__tests__/navRoutes.test.js
  // hits the same constraint and takes the same way out: compare against
  // App.jsx's own source text instead of a rendered router. This is the part
  // of this smoke test that is actually meaningful -- it fails if the route
  // is deleted or repointed at a different component, which the bare typeof
  // check above cannot detect.
  it('is mounted at /game/creature-behaviors in App.jsx', () => {
    expect(app).toMatch(/<Route\s+path="creature-behaviors"\s+element=\{<CreatureBehaviorsAdmin\s*\/>\}\s*\/>/);
  });

  // SOMET-290. behaviorForm.test.js pins CHASE_STYLES against the BACKEND's
  // own list; these two close the remaining link -- that the Chase Style
  // dropdown is built from that array and from nothing else. Together they are
  // what proves `skittish` actually reaches the dropdown, which is the failure
  // that shipped: the profile opened with a blank <select> and the first touch
  // of it rewrote chase_style to a listed value.
  //
  // Source text rather than a render because vitest runs this project in a
  // plain node environment (see the note above, and navRoutes.test.js), and
  // this component is a page-level route that would need the whole provider
  // stack to mount.
  it('builds the Chase Style dropdown from the shared CHASE_STYLES list', () => {
    expect(admin).toMatch(/\{CHASE_STYLES\.map\(\s*c\s*=>\s*<option key=\{c\} value=\{c\}>\{c\}<\/option>\)\}/);
    expect(admin).toMatch(/import\s*\{[^}]*\bCHASE_STYLES\b[^}]*\}\s*from\s*'\.\/behaviorForm\.js'/);
  });

  it('hardcodes no chase style as an <option> of its own', () => {
    // A second, hardcoded copy of the list is exactly how the array and the
    // dropdown would drift apart again while both tests above stayed green.
    for (const style of CHASE_STYLES) {
      expect(admin).not.toContain(`<option value="${style}"`);
    }
  });
});
