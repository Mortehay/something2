// vitest runs in node (no DOM). These are wiring guards for what would otherwise
// go inert silently, in the style of VfxEffectsAdmin.smoke.test.js.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV_SECTIONS } from '../../../ui/navSections.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');
const admin = read('../AuraEffectsAdmin.jsx');
const hooks = read('../useAuraEffects.js');
const preview = read('../auraPreview.js');

describe('Aura Effects screen', () => {
  it('uses all four hooks', () => {
    for (const h of ['useAuraEffectsAdmin()', 'useCreateAuraEffect', 'useUpdateAuraEffect', 'useDeleteAuraEffect']) expect(admin).toContain(h);
  });
  it('the data hook returns { auras, isLoadingAuras } (Task 9 destructures auras)', () => {
    expect(hooks).toMatch(/return \{ auras: data \|\| \[\], isLoadingAuras: isLoading \}/);
    expect(admin).toMatch(/const \{ auras, isLoadingAuras \} = useAuraEffectsAdmin\(\)/);
  });
  it('has the four spec sections', () => {
    for (const s of ['Target', 'Modifiers', 'Damage over time', 'Visual']) expect(admin).toContain(`>${s}<`);
  });
  it('shows Used by from the API field', () => {
    expect(admin).toMatch(/used_by/);
    expect(admin).toContain('Used by');
  });
  it('tells the author edits apply on the next chunk load (spec 3.2)', () => {
    expect(admin).toContain('Edits apply to creatures on their next chunk load.');
  });
  it('the preview is live and uses the shared maths', () => {
    expect(preview).toMatch(/from '\.\/src\/js\/core\/auraVisual\.js'/);
    expect(preview).toMatch(/particlesAt\(/);
    expect(admin).toMatch(/drawAuraPreview\(/);
    expect(admin).toMatch(/\}, \[form\]\)/);
  });
  it('surfaces the 409 binding names and hits the right endpoint', () => {
    expect(hooks).toMatch(/AURA_QUERY_KEY = \["auraEffects"\]/);
    expect(hooks).toMatch(/\/api\/aura-effects/);
    expect(hooks).toMatch(/referencing_entity_types/);
    expect(hooks).toMatch(/still bound by/);
  });
  it('is registered in the sidebar next to Attack Effects', () => {
    const adminNav = NAV_SECTIONS.find((s) => s.title === 'Admin').items;
    const i = adminNav.findIndex((x) => x.id === 'vfx');
    expect(adminNav[i + 1]).toMatchObject({ id: 'auras', label: 'Aura Effects', path: '/game/auras', adminType: 'entity' });
    expect(read('../../../App.jsx')).toMatch(/<Route path="auras" element={<AuraEffectsAdmin \/>} \/>/);
  });
});
