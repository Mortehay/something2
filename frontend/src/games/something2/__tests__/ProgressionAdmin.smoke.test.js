import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ProgressionAdmin from '../ProgressionAdmin.jsx';
import { SETTING_FIELDS } from '../gameSettingsForm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.join(here, '../../../App.jsx'), 'utf8');
const page = fs.readFileSync(path.join(here, '../ProgressionAdmin.jsx'), 'utf8');

describe('ProgressionAdmin', () => {
  it('is a component export named ProgressionAdmin, taking no props', () => {
    expect(typeof ProgressionAdmin).toBe('function');
    expect(ProgressionAdmin.name).toBe('ProgressionAdmin');
    expect(ProgressionAdmin.length).toBe(0);
  });

  // Source text, not a render: vitest runs this project in a plain node env
  // (frontend/vitest.config.js), the same constraint navRoutes.test.js and
  // CreatureBehaviorsAdmin.smoke.test.js work around the same way. This is
  // the part that is actually meaningful -- it fails if the route is deleted
  // or repointed at a different component.
  it('is mounted at /game/admin/progression in App.jsx', () => {
    expect(app).toMatch(/<Route\s+path="admin\/progression"\s+element=\{<ProgressionAdmin\s*\/>\}\s*\/>/);
  });

  it('builds its editor rows from SETTING_FIELDS and hardcodes no key of its own', () => {
    expect(page).toMatch(/import\s*\{[^}]*\bSETTING_FIELDS\b[^}]*\}\s*from\s*'\.\/gameSettingsForm\.js'/);
    expect(page).toContain('SETTING_FIELDS.map(');
    // A second, hardcoded copy of the list is how the array and the form drift
    // apart while both tests above stay green.
    for (const f of SETTING_FIELDS) {
      expect(page, `${f.key} must not be spelled out in the JSX`).not.toContain(`"${f.key}"`);
    }
  });

  // The affix catalog (T12) still belongs to another group, so it must be a
  // visible, labelled mount point rather than silently absent -- the next
  // implementer edits the right file and the admin is not left wondering
  // whether the page is broken.
  it('still carries a labelled, empty mount point for the affix section', () => {
    expect(page).toContain('MOUNT POINT: affix catalog');
    expect(page).toContain('id="affix-catalog-mount"');
    expect(page).toContain('Arrives with the item-rarity slice');
  });

  // The passive-node section is FILLED as of SOMET-477. Asserting the section
  // survived and that the placeholder is gone is what stops this landing as a
  // page that still says "arrives later" next to a working editor -- and stops
  // a later edit quietly deleting the mount.
  it('renders the passive-node editor in its own section, placeholder removed', () => {
    expect(page).toContain('id="passive-nodes-mount"');
    expect(page).toMatch(/<PassiveNodesAdmin\s*\/>/);
    expect(page).not.toContain('Arrives with the passive-tree slice');
  });

  it('reads its data through the hook, never fetch() directly', () => {
    expect(page).toMatch(/from\s*'\.\/useGameSettings\.js'/);
    expect(page).not.toContain('fetch(');
  });
});
