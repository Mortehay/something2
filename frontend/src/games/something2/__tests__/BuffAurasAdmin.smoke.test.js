// vitest runs in node (no DOM). Wiring guards in the style of AuraEffectsAdmin.smoke.test.js.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV_SECTIONS } from '../../../ui/navSections.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');
const admin = read('../BuffAurasAdmin.jsx');
const hooks = read('../useBuffVisuals.js');

describe('Buff Auras screen', () => {
  it('approving an effect on the Sprite tab refetches the buff visuals (a buff sheet lands there)', () => {
    const console_ = read('../useSpriteConsole.js');
    expect(console_).toMatch(/import \{ BUFF_VISUALS_QUERY_KEY \} from '\.\/useBuffVisuals\.js'/);
    expect(console_).toMatch(/export const useApproveEffect = mutation\([^\n]*'POST', \[EFFECTS_KEY, BUFF_VISUALS_QUERY_KEY\]\);/);
    expect(console_).toMatch(/for \(const queryKey of extraKeys\) qc\.invalidateQueries\(\{ queryKey \}\)/);
  });
  it('reads and writes /api/buff-visuals and shares the game client query key', () => {
    expect(hooks).toMatch(/BUFF_VISUALS_QUERY_KEY = \["buffVisuals"\]/);
    expect(hooks).toMatch(/\/api\/buff-visuals\/\$\{encodeURIComponent\(/);
    expect(hooks).toMatch(/method: "PUT"/);
    expect(hooks).toMatch(/invalidateQueries\(\{ queryKey: BUFF_VISUALS_QUERY_KEY \}\)/);
    expect(admin).toMatch(/useBuffVisualsAdmin\(\)/);
    expect(admin).toMatch(/useUpdateBuffVisual\(\)/);
  });
  it('reuses the project 1 sprite pieces instead of copying them', () => {
    expect(admin).toMatch(/import \{[^}]*useSpriteImage[^}]*PreviewPair[^}]*\} from '\.\/VfxEffectsAdmin\.jsx'/);
    expect(admin).toMatch(/import \{[^}]*validateSpriteFile[^}]*vfxSpriteFilter[^}]*\} from '\.\/vfxForm\.js'/);
    expect(admin).toMatch(/import \{ uploadVfxSprite \} from '\.\/useVfxEffects\.js'/);
    expect(admin).toMatch(/touchBuffSprite/);
    expect(admin).toMatch(/afterSaveTouched\(formAtSave, f\)/);
    expect(admin).toMatch(/setForm\(f => formAfterServerRow\(f, prev, visual\)\)/);
    expect(admin).toMatch(/\}, \[visual\]\);/);
    expect(admin).toMatch(/aura_radius: auraRadius/);
    expect(admin).toMatch(/clearedBuffSpriteForm/);
  });
  it('builds the PUT body from buffFormToPayload and validates first', () => {
    expect(admin).toMatch(/validateBuffForm\(/);
    expect(admin).toMatch(/buffFormToPayload\(form\)/);
  });
  it('Code and Sprite canvases run on one clock, re-armed on form or image change', () => {
    expect(admin).toMatch(/drawBuffAuraPreview\(codeCtx/);
    expect(admin).toMatch(/drawBuffAuraPreview\(spriteCtx[^)]*\{ reference: true \}\)/);
    expect(admin).toMatch(/\}, \[form, image, auraRadius\]\)/);
  });
  it('the Opacity bar writes both game_settings keys through the settings endpoint', () => {
    expect(admin).toMatch(/useUpdateGameSetting\(\)/);
    expect(admin).toContain("'buff_visual_main_opacity'");
    expect(admin).toContain("'buff_visual_other_opacity'");
    expect(admin).toContain('>Opacity<');
  });
  it('has search, class and sprite filters, and no create or delete', () => {
    expect(admin).toMatch(/aria-label="Class filter"/);
    expect(admin).toMatch(/aria-label="Sprite filter"/);
    expect(admin).toMatch(/placeholder="Search buffs/);
    expect(admin).not.toMatch(/method: "POST"|method: "DELETE"|Delete<|New buff/);
    expect(hooks).not.toMatch(/method: "POST"|method: "DELETE"/);
  });
  it('is registered in the sidebar right after Aura Effects, and routed', () => {
    const adminNav = NAV_SECTIONS.find((s) => s.title === 'Admin').items;
    const i = adminNav.findIndex((x) => x.id === 'auras');
    expect(adminNav[i + 1]).toMatchObject({ id: 'buffs', label: 'Buff Auras', path: '/game/buffs', adminType: 'entity' });
    expect(read('../../../App.jsx')).toMatch(/<Route path="buffs" element={<BuffAurasAdmin \/>} \/>/);
  });
});
