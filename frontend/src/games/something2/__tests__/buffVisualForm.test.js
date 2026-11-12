import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { touchSprite } from '../auraForm.js';
import {
  buffToForm, buffFormToPayload, validateBuffForm, clearedBuffSpriteForm, touchBuffSprite, afterSaveTouched, formAfterServerRow, buffClass, filterBuffVisuals, BUFF_PLACEMENTS,
} from '../buffVisualForm.js';

const require = createRequire(import.meta.url);
const backend = require('../../../../../backend/src/services/buffVisuals.js');
const SPRITE_KEYS = ['sprite_image', 'sprite_frames', 'sprite_additive', 'sprite_fps'];
const KEY = 'vfx/0123abcd-0123-4567-89ab-0123456789ab.png';
const row = (over = {}) => ({
  skill_id: 'war_battle_cry', placement: 'body', radius: 64, scale: 1.3, priority: null, color: '#ff8800',
  sprite_image: KEY, sprite_frames: 8, sprite_additive: true, sprite_fps: 12, name_en: 'Battle Cry', tier: 1, req_lvl: 1, ...over,
});

describe('buff visual form payload (omit-key save rule)', () => {
  it('an untouched form sends no sprite_* key at all', () => {
    const p = buffFormToPayload(buffToForm(row()));
    for (const k of SPRITE_KEYS) expect(k in p).toBe(false);
    // SOMET-769: `display` is a plain field, sent every save (sprite unless the row says code).
    expect(p).toEqual({ placement: 'body', radius: 64, scale: 1.3, priority: null, color: '#ff8800', display: 'sprite' });
  });
  it('a pick carries the sprite keys', () => {
    const f = touchSprite({ ...buffToForm(row({ sprite_image: null, sprite_frames: 1, sprite_fps: null })), sprite_image: KEY });
    expect(buffFormToPayload(f)).toMatchObject({ sprite_image: KEY, sprite_frames: 1, sprite_additive: true, sprite_fps: null });
  });
  it('a frames edit carries the sprite keys, with the stored image', () => {
    const p = buffFormToPayload(touchSprite(buffToForm(row()), { sprite_frames: '6' }));
    expect(p).toMatchObject({ sprite_image: KEY, sprite_frames: 6, sprite_fps: 12 });
  });
  it("a clear sends '' (never null) and the column defaults", () => {
    const p = buffFormToPayload(clearedBuffSpriteForm(buffToForm(row())));
    expect(p.sprite_image).toBe('');
    expect(p).toMatchObject({ sprite_frames: 1, sprite_additive: true, sprite_fps: null });
  });
  it('radius, scale and priority go out as JSON numbers (the API refuses strings)', () => {
    const p = buffFormToPayload({ ...buffToForm(row()), radius: '150', scale: '2', priority: '3' });
    expect(p.radius).toBe(150);
    expect(p.scale).toBe(2);
    expect(p.priority).toBe(3);
  });
});

describe('validateBuffForm', () => {
  const base = buffToForm(row());
  it('accepts a stored row', () => expect(validateBuffForm(base)).toBeNull());
  it('rejects scale 0 and radius 0', () => {
    expect(validateBuffForm({ ...base, scale: '0' })).toMatch(/Scale/);
    expect(validateBuffForm({ ...base, radius: '0' })).toMatch(/Radius/);
    expect(validateBuffForm({ ...base, radius: '' })).toMatch(/Radius/);
  });
  it("accepts priority '' as null, rejects a fraction", () => {
    expect(validateBuffForm({ ...base, priority: '' })).toBeNull();
    expect(buffFormToPayload({ ...base, priority: '' }).priority).toBeNull();
    expect(validateBuffForm({ ...base, priority: '1.5' })).toMatch(/Priority/);
  });
  it('rejects a bad colour and out-of-range sprite fields', () => {
    expect(validateBuffForm({ ...base, color: 'red' })).toMatch(/Colour/);
    expect(validateBuffForm(touchSprite(base, { sprite_frames: '65' }))).toMatch(/frames/);
    expect(validateBuffForm(touchSprite(base, { sprite_fps: '61' }))).toMatch(/fps/);
  });
  it('agrees with the API about what a payload may carry', async () => {
    const save = (f) => backend.saveBuffVisual({ query: async () => ({ rows: [{ skill_id: backend.VISUAL_BUFF_IDS[0] }] }) },
      backend.VISUAL_BUFF_IDS[0], buffFormToPayload(f));
    for (const [over, ok] of [[{}, true], [{ scale: '0' }, false], [{ radius: '0' }, false], [{ priority: '' }, true], [{ scale: '5' }, false]]) {
      const f = { ...base, ...over };
      expect(validateBuffForm(f) === null).toBe(ok);
      if (ok) await expect(save(f)).resolves.toBeTruthy();
      else await expect(save(f)).rejects.toMatchObject({ status: 400 });
    }
  });
  it('uses the API placement vocabulary', () => {
    expect(BUFF_PLACEMENTS).toEqual(['ground', 'body']);
    expect([...new Set(backend.VISUAL_BUFF_IDS.map((id) => backend.defaultVisual({ id }).placement))].sort()).toEqual(['body', 'ground']);
  });
});

describe('class and search filters', () => {
  it('reads the class from the skill catalog', () => {
    expect(buffClass('mag_immolation_aura')).toBe('Mage');
    expect(buffClass('dru_thorns_aura')).toBe('Druid');
    expect(buffClass('nope')).toBe('');
  });
  it('filters by class and by name or id', () => {
    const rows = [row({ skill_id: 'mag_immolation_aura', name_en: 'Immolation' }), row({ skill_id: 'dru_thorns_aura', name_en: 'Thorns' })];
    expect(filterBuffVisuals(rows, { cls: 'Druid' }).map((r) => r.skill_id)).toEqual(['dru_thorns_aura']);
    expect(filterBuffVisuals(rows, { search: 'immol' }).map((r) => r.skill_id)).toEqual(['mag_immolation_aura']);
    expect(filterBuffVisuals(rows, { search: 'DRU_' }).map((r) => r.skill_id)).toEqual(['dru_thorns_aura']);
    expect(filterBuffVisuals(rows, {})).toHaveLength(2);
  });
});

describe('sprite_touched after a save', () => {
  const saved = touchBuffSprite(buffToForm(row()), { sprite_frames: '6' });
  it('no sprite edit during the save: the sprite is no longer touched', () => {
    expect(afterSaveTouched(saved, { ...saved, radius: '99' })).toBe(false);
  });
  it('a frames edit or a Remove during the save keeps it touched, so the next Save sends it', () => {
    expect(afterSaveTouched(saved, touchBuffSprite(saved, { sprite_frames: '4' }))).toBe(true);
    expect(afterSaveTouched(saved, clearedBuffSpriteForm(saved))).toBe(true);
  });
  it('every sprite edit counts, even one that restores the saved value', () => {
    const twice = touchBuffSprite(touchBuffSprite(saved, { sprite_frames: '4' }), { sprite_frames: '6' });
    expect(afterSaveTouched(saved, twice)).toBe(true);
  });
  it('the edit counter never reaches the payload', () => {
    expect(Object.keys(buffFormToPayload(saved)).some((k) => k.includes('edit'))).toBe(false);
  });
});

describe('formAfterServerRow (a sheet approved elsewhere reaches an open card)', () => {
  const before = row({ sprite_image: null, sprite_frames: 1, sprite_additive: true, sprite_fps: null });
  const approved = { ...before, sprite_image: KEY, sprite_frames: 8, sprite_additive: false, sprite_fps: 12 };
  it('an untouched sprite takes the new row; unsaved non-sprite edits stay', () => {
    const form = { ...buffToForm(before), radius: '99', color: '#123456' };
    const next = formAfterServerRow(form, before, approved);
    expect(SPRITE_KEYS.map((k) => next[k])).toEqual([KEY, '8', false, '12']);
    expect(next.radius).toBe('99');
    expect(next.color).toBe('#123456');
    expect(next.sprite_touched).toBe(false);
    // ...so the next Save leaves the approved sheet alone.
    expect(SPRITE_KEYS.some((k) => k in buffFormToPayload(next))).toBe(false);
  });
  it('a touched sprite is the admin\'s own edit and is kept', () => {
    const form = touchBuffSprite(buffToForm(before), { sprite_frames: '4' });
    expect(formAfterServerRow(form, before, approved)).toBe(form);
  });
  it('a row change that leaves the sprite columns alone keeps the form as is', () => {
    const form = { ...buffToForm(before), radius: '99' };
    expect(formAfterServerRow(form, before, { ...before, radius: 120, color: '#000000' })).toBe(form);
    expect(formAfterServerRow(form, null, approved)).toBe(form);
  });
});
