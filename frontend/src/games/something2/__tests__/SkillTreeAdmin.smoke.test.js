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
    for (const fn of ['indexArt', 'artFor', 'artCoverage', 'distinctLabels', 'treeBounds', 'zoomViewBox', 'panViewBox', 'artConsoleLink', 'onlyMissing']) {
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
});
