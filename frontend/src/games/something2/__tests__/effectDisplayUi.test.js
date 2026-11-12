import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayNote, DISPLAY_LABEL } from '../effectDisplayUi.jsx';
import { emptyVfxForm, vfxToForm, vfxFormToPayload, displayOf, EFFECT_DISPLAYS } from '../vfxForm.js';
import { emptyAuraForm, auraToForm, auraFormToPayload } from '../auraForm.js';
import { buffToForm, buffFormToPayload } from '../buffVisualForm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');

// SOMET-769: the Code / Sprite display choice.
describe('display in the three forms', () => {
  it('reads sprite for an old or new row and code only when stored so', () => {
    expect(displayOf({})).toBe('sprite');
    expect(displayOf({ display: 'code' })).toBe('code');
    expect(displayOf({ display: 'both' })).toBe('sprite');
    expect(EFFECT_DISPLAYS).toEqual(['code', 'sprite']);
    expect(emptyVfxForm().display).toBe('sprite');
    expect(emptyAuraForm().display).toBe('sprite');
    expect(vfxToForm({ name: 'x', display: 'code' }).display).toBe('code');
    expect(auraToForm({ name: 'a', display: 'code' }).display).toBe('code');
    expect(buffToForm({ skill_id: 's', display: 'code' }).display).toBe('code');
  });

  it('every payload carries the choice, so a save never silently resets it', () => {
    expect(vfxFormToPayload({ ...emptyVfxForm(), name: 'x', display: 'code' }).display).toBe('code');
    expect(vfxFormToPayload({ ...emptyVfxForm(), name: 'x' }).display).toBe('sprite');
    expect(auraFormToPayload({ ...emptyAuraForm(), name: 'a', display: 'code' }).display).toBe('code');
    expect(buffFormToPayload({ ...buffToForm({ skill_id: 's' }), display: 'code' }).display).toBe('code');
  });

  it('the note tells the admin what each choice means for the player', () => {
    expect(DISPLAY_LABEL).toEqual({ code: 'Code', sprite: 'Sprite' });
    expect(displayNote('code')).toMatch(/code version only/);
    expect(displayNote('sprite')).toMatch(/Settings → Animations/);
  });
});

describe('the three tabs wire the controls', () => {
  it('each card shows the choice under its preview and each page has the for-all control', () => {
    for (const [file, hook] of [['VfxEffectsAdmin', 'useSetVfxDisplayAll'], ['AuraEffectsAdmin', 'useSetAuraDisplayAll'], ['BuffAurasAdmin', 'useSetBuffDisplayAll']]) {
      const src = read(`../${file}.jsx`);
      expect(src, file).toMatch(/<Preview [^\n]*\/>\n\s*<DisplayChoice /);
      expect(src, file).toContain('<DisplayForAll ');
      expect(src, file).toContain(`${hook}()`);
    }
  });

  it('the Aura Effects tab lists the status visuals with their own choice and for-all', () => {
    const src = read('../AuraEffectsAdmin.jsx');
    expect(src).toContain('<StatusVisualsSection />');
    expect(src).toContain('useStatusVisualsAdmin()');
    expect(src).toContain('useSetStatusDisplay()');
    expect(src).toContain('useSetStatusDisplayAll()');
  });

  it('the hooks hit the bulk and status endpoints and invalidate the keys the game reads', () => {
    const hooks = read('../useEffectDisplay.js');
    for (const p of ['/api/vfx-effects', '/api/aura-effects', '/api/buff-visuals', '/api/status-visuals']) expect(hooks).toContain(p);
    expect(hooks).toMatch(/\$\{API_URL\}\$\{path\}\/display/);
    for (const k of ['VFX_QUERY_KEY', 'AURA_QUERY_KEY', 'BUFF_VISUALS_QUERY_KEY', 'STATUS_VISUALS_QUERY_KEY']) expect(hooks).toContain(k);
  });
});
