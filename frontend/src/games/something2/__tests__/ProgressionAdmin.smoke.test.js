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

  // The affix catalog (T12) and the passive-node browser (T9) belong to other
  // groups. They must be visible, labelled mount points rather than silently
  // absent, so the next implementer edits the right file and the admin is not
  // left wondering whether the page is broken.
  it('carries labelled, empty mount points for the affix and passive-node sections', () => {
    expect(page).toContain('MOUNT POINT: affix catalog');
    expect(page).toContain('MOUNT POINT: passive node browser');
    expect(page).toContain('id="affix-catalog-mount"');
    expect(page).toContain('id="passive-nodes-mount"');
  });

  it('reads its data through the hook, never fetch() directly', () => {
    expect(page).toMatch(/from\s*'\.\/useGameSettings\.js'/);
    expect(page).not.toContain('fetch(');
  });
});
