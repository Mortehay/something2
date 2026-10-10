import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SkillTreeAdmin from '../SkillTreeAdmin.jsx';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');
const admin = read('../SkillTreeAdmin.jsx');
const hook = read('../usePassiveTree.js');
const console_ = read('../ArtConsoleAdmin.jsx');

// SOMET-571. Source-text gates, like PassiveNodesAdmin.smoke.test.js and for
// the same reason: vitest runs in a plain node environment, so this is the
// render-free way to catch the page quietly not doing what the ticket says.
describe('SkillTreeAdmin', () => {
  it('is a component export named SkillTreeAdmin', () => {
    expect(typeof SkillTreeAdmin).toBe('function');
    expect(SkillTreeAdmin.name).toBe('SkillTreeAdmin');
  });

  it('draws the tree with the game\'s own sector colours and node radii, not a copy', () => {
    // passiveTreePanel.js is pure and already knows both. A second table here
    // is how the admin view and the in-game tree drift apart.
    expect(admin).toMatch(/import\s*\{[^}]*\bSECTOR_HUES\b[^}]*\}\s*from\s*'\.\/src\/js\/systems\/passiveTreePanel\.js'/);
    expect(admin).toMatch(/\bnodeRadius\(/);
  });

  it('joins the three existing sources and adds no endpoint of its own', () => {
    expect(admin).toMatch(/import\s*\{[^}]*\buseArtSubjects\b[^}]*\}\s*from\s*'\.\/useArtConsole\.js'/);
    expect(admin).toMatch(/import\s*\{[^}]*\busePassiveTree\b[^}]*\}\s*from\s*'\.\/usePassiveTree\.js'/);
    expect(admin).toMatch(/import\s*\{[^}]*\bSKILLS_BY_CLASS\b[^}]*\}\s*from\s*'\.\/src\/js\/core\/skillsData\.js'/);
    expect(hook).toMatch(/\/api\/passive-tree/);
    expect(hook).toMatch(/authHeaders\(\)/);
  });

  it('decides art lookup, coverage and links in skillTreeView.js, not inline', () => {
    for (const fn of ['indexArt', 'artFor', 'artCoverage', 'distinctLabels', 'treeBounds', 'zoomViewBox', 'panViewBox', 'artConsoleLink', 'onlyMissing', 'dragStart', 'dragMove', 'dragEnd', 'dragClick']) {
      expect(admin, `${fn} must be imported from skillTreeView.js`)
        .toMatch(new RegExp(`import\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from\\s*'\\./skillTreeView\\.js'`));
      expect(admin, `${fn} must actually be called`).toMatch(new RegExp(`\\b${fn}\\(`));
    }
  });

  it('shows skill icons at the size the skills panel draws them', () => {
    // skillsPanel.js: `const iconBoxS = 48`. A card at 64 px would judge fit
    // at a size the game never shows.
    const panel = read('../src/js/systems/skillsPanel.js');
    const size = panel.match(/const iconBoxS = (\d+);/)[1];
    expect(admin).toMatch(new RegExp(`SKILL_ICON_PX = ${size};`));
  });

  it('versions every image URL so an approval shows the new picture', () => {
    expect(admin).toMatch(/assetUrlVersioned\(/);
    expect(admin).not.toMatch(/assetUrl\(/);
  });

  it('is view-only: no mutation hooks, no POST', () => {
    expect(admin).not.toMatch(/useMutation|useStartArtBatch|useEnqueue|method:\s*['"]POST['"]/);
  });

  it('the console seeds its filters from the URL the tab links to', () => {
    expect(console_).toMatch(/import\s*\{[^}]*\bfiltersFromParams\b[^}]*\}\s*from\s*'\.\/artSelection\.js'/);
    expect(console_).toMatch(/useSearchParams/);
    expect(console_).toMatch(/filtersFromParams\(/);
  });

  it('passes the deep link\'s exact-key flag to every applyFilters call', () => {
    // filtersFromParams returns `exact` for a key= link; a call site that
    // drops it falls back to the substring search (q=Mage -> 8 rows).
    const calls = console_.match(/applyFilters\(subjects,\s*\{[^}]*\}/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toMatch(/\bexact\b/);
    // ...read from the URL-backed filters (SOMET-535 made the URL the state).
    expect(console_).toMatch(/const \{[^}]*\bexact\b[^}]*\} = filters;/);
  });

  it('typing in the search box leaves the exact-key match', () => {
    // setFilter merges the patch over the CURRENT params, so a patch without
    // exact: false would keep key= and match the typed text exactly.
    expect(console_).toMatch(/onChange=\{\(e\) => setFilter\(\{ search: e\.target\.value, exact: false \}\)\}/);
  });

  // SOMET-571 rework. Capturing the pointer on pointerdown made Chrome
  // retarget pointerup AND click to the <svg>, so no node's onClick ever ran:
  // a plain click on the tree navigated nowhere. Vitest has no DOM here, so
  // the wiring is pinned in source; the decision itself (capture on the move
  // that starts a drag, once) is unit-tested as dragMove's `capture`.
  it('never captures the pointer on press, only once dragMove says a drag began', () => {
    const body = (name) => {
      const m = admin.match(new RegExp(`const ${name} = \\(e\\) => \\{([\\s\\S]*?)\\n  \\};`));
      expect(m, `${name} handler`).not.toBeNull();
      return m[1];
    };
    expect(body('onPointerDown')).not.toMatch(/setPointerCapture/);
    const move = body('onPointerMove');
    expect(move).toMatch(/\bcapture\b[^;]*=\s*dragMove\(|\{[^}]*\bcapture\b[^}]*\}\s*=\s*dragMove\(/);
    expect(move).toMatch(/if\s*\(capture\)[^;]*setPointerCapture\(e\.pointerId\)/);
    // And nowhere else.
    expect(admin.match(/setPointerCapture\(/g)).toHaveLength(1);
  });

  it('says so when missing-only has nothing to show, instead of dimming every node', () => {
    // Validation: with nothing missing, missing-only dimmed all 1852 nodes to
    // 0.15 with no message, which reads as a broken tree.
    expect(admin).toMatch(/treeMissingOnly\s*&&\s*labelCoverage\.missing\s*===\s*0/);
  });
});
