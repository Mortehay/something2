import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SkillTreeAdmin from '../SkillTreeAdmin.jsx';
import { SECTOR_HUES } from '../src/js/systems/passiveTreePanel.js';

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
    for (const fn of ['indexArt', 'artFor', 'artCoverage', 'distinctLabels', 'treeBounds', 'wheelZoom', 'panViewBox', 'artConsoleLink', 'onlyMissing', 'dragStart', 'dragMove', 'dragEnd', 'dragClick']) {
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

  it('typing in the console search box drops the deep link\'s exact match', () => {
    // A key= link seeds the box with the key and matches it exactly; once the
    // admin edits the box it is a substring search again ('Mag' -> 8 rows).
    const input = console_.match(/<input value=\{search\} onChange=\{\(e\) => \{([^}]*)\}/);
    expect(input, 'search input').not.toBeNull();
    expect(input[1]).toMatch(/setSearch\(e\.target\.value\)/);
    expect(input[1]).toMatch(/setExact\(false\)/);
  });

  it('passes the deep link\'s exact-key flag to every applyFilters call', () => {
    // filtersFromParams returns `exact` for a key= link; a call site that
    // drops it falls back to the substring search (q=Mage -> 8 rows).
    const calls = console_.match(/applyFilters\(subjects,\s*\{[^}]*\}/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toMatch(/\bexact\b/);
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

  // SOMET-571 re-validation: a press released outside the svg (before the
  // drag threshold, so before capture) never reached onPointerUp and stayed
  // pressed; hovering back with no button held panned the tree. The move
  // handler must hand dragMove the button state, and a release ANYWHERE must
  // end the press.
  it('ends a press whose pointerup happened outside the svg', () => {
    const move = admin.match(/const onPointerMove = \(e\) => \{([\s\S]*?)\n {2}\};/)[1];
    expect(move).toMatch(/dragMove\(drag\.current,\s*e\.clientX,\s*e\.clientY,\s*e\.buttons\)/);
    expect(admin).toMatch(/window\.addEventListener\('pointerup',/);
    expect(admin).toMatch(/window\.removeEventListener\('pointerup',/);
  });

  it('zooms inside the setBox updater, from the box being zoomed', () => {
    // A focus computed from the last-rendered box drifted under a wheel burst
    // (SOMET-571 validation); the updater must chain off its own argument.
    expect(admin).toMatch(/setBox\(\(b\) => wheelZoom\(b, bounds, rect, clientX, clientY, factor\)\)/);
  });

  it('says so when missing-only has nothing to show, instead of dimming every node', () => {
    // Validation: with nothing missing, missing-only dimmed all 1852 nodes to
    // 0.15 with no message, which reads as a broken tree.
    expect(admin).toMatch(/const treeNothingMissing = treeMissingOnly\s*&&\s*labelCoverage\.missing\s*===\s*0;/);
    // The message is actually rendered under that condition...
    expect(admin).toMatch(/\{treeNothingMissing\s*&&[^}]*<Hint>Every passive label has art/);
    // ...and the tree is NOT dimmed then.
    expect(admin).toMatch(/dimLabels=\{treeMissingOnly\s*&&\s*!treeNothingMissing\s*\?\s*missingLabels\s*:\s*null\}/);
  });

  // Validation: at whole-tree zoom a world-unit stroke is sub-pixel, so the
  // missing-art marker is drawn in screen pixels. And it must not share a
  // colour with a sector: amber was charisma's hue, so in the Druid sector a
  // missing ring was told apart only by thickness.
  it('marks missing art with a screen-pixel ring in a colour no sector uses', () => {
    const m = admin.match(/<circle\s+r=\{r\} fill="none" stroke=\{GAME_MISSING\}([^>]*)\/>/);
    expect(m, 'missing-art ring').not.toBeNull();
    expect(m[1]).toMatch(/vectorEffect="non-scaling-stroke"/);
    const colour = admin.match(/const GAME_MISSING = '([^']+)';/)[1].toLowerCase();
    const hues = Object.values(SECTOR_HUES).map((h) => h.toLowerCase());
    expect(hues).not.toContain(colour);
  });
});
