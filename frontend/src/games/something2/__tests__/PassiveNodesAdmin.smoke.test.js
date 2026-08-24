import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PassiveNodesAdmin from '../PassiveNodesAdmin.jsx';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');
const shell = read('../ProgressionAdmin.jsx');
const admin = read('../PassiveNodesAdmin.jsx');
const hooks = read('../usePassiveNodes.js');

// A bare `typeof === 'function'` stays green even when the wrong component is
// exported or the mount point silently disappears -- both have shipped in this
// repo before (see the sidebar-nav routing incident). These assertions read the
// source, which is the only render-free way to catch either: vitest runs this
// project in a plain node environment (frontend/vitest.config.js), so there is
// no DOM to mount into.
describe('PassiveNodesAdmin', () => {
  it('is a component export named PassiveNodesAdmin', () => {
    expect(typeof PassiveNodesAdmin).toBe('function');
    expect(PassiveNodesAdmin.name).toBe('PassiveNodesAdmin');
  });

  it('is rendered by the progression admin page shell', () => {
    expect(shell).toMatch(/import\s+PassiveNodesAdmin\s+from\s+'\.\/PassiveNodesAdmin\.jsx'/);
    expect(shell).toMatch(/<PassiveNodesAdmin\s*\/>/);
    // Inside the labelled section T1 left for it, not floating somewhere else
    // on the page.
    expect(shell).toMatch(/id="passive-nodes-mount"[\s\S]{0,200}<PassiveNodesAdmin\s*\/>/);
  });

  it('no longer shows the T9 placeholder in that section', () => {
    expect(shell).not.toMatch(/passive-nodes-mount[\s\S]{0,300}Arrives with the passive-tree slice/);
  });

  it('builds its dropdowns from the shared vocabulary, not from inline literals', () => {
    expect(admin).toMatch(/import\s*\{[\s\S]*?\bKINDS\b[\s\S]*?\}\s*from\s*'\.\/passiveNodeForm\.js'/);
    expect(admin).toMatch(/\{KINDS\.map\(/);
    expect(admin).toMatch(/\{SECTORS\.map\(/);
    expect(admin).toMatch(/\{GRANT_TYPES\.map\(/);
    // A second, hardcoded copy of a vocabulary is how the dropdown and the
    // validator drift apart while both of the assertions above stay green.
    for (const literal of ["'strenght'", "'intelligence', 'wisdom'", "'burn', 'chill'"]) {
      expect(admin, `${literal} must not be spelled out in the JSX`).not.toContain(literal);
    }
  });

  it('validates before it saves, rather than relying on the 400', () => {
    expect(admin).toMatch(/validateNodeForm\(/);
    expect(admin).toMatch(/formToPayload\(/);
    // The submit handler must actually consult the result. `validation.ok` used
    // only to grey out a button, with a submit that fires anyway, is the shape
    // this catches.
    expect(admin).toMatch(/if\s*\(!form\s*\|\|[^)]*!validation\.ok\)\s*return;/);
  });

  it('pages the list rather than rendering all 1806 rows', () => {
    expect(admin).toMatch(/const PAGE = \d+;/);
    expect(Number(admin.match(/const PAGE = (\d+);/)[1])).toBeLessThanOrEqual(200);
    expect(admin).toMatch(/limit:\s*PAGE/);
    expect(admin).toMatch(/offset/);
    expect(hooks).toMatch(/qs\.set\("offset"/);
    expect(hooks).toMatch(/qs\.set\("limit"/);
  });

  it('sends the admin token on the READ as well as the write', () => {
    // /api/passive-nodes is adminGuard'd on both verbs. A GET without the
    // header 401s, noteAuthFailure fires and the admin is signed out the moment
    // they open the tab.
    const gets = hooks.match(/authHeaders\(\)/g) || [];
    expect(gets.length).toBeGreaterThanOrEqual(2);
  });

  it('uses --s2-* tokens only, per the admin styleguide', () => {
    // themeTokens.test.js enforces this across the admin surface; asserting it
    // here as well means a hardcoded hex fails in the file that introduced it.
    expect(admin).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(admin).toMatch(/var\(--s2-/);
  });

  it('never reads the API with a bare fetch()', () => {
    expect(admin).not.toContain('fetch(');
    expect(hooks).not.toMatch(/[^i]fetch\(/);
  });
});
