import { describe, it, expect } from 'vitest';
import {
  generateItem, loopEditable, uploadParams,
} from '../useAudioAdmin.js';

// Final review F7 (SOMET-590): Suggest returns a style AND the box's slot
// values for that style. If the admin then types a different style, those
// slots belong to the old style and must not be sent with the new one.
describe('generateItem', () => {
  const subject = { kind: 'world', key: 'vale' };
  const proposal = { style: 'village', slots: { tempo: 'slow' } };

  it('sends the suggested slots with the suggested style', () => {
    expect(generateItem({ subject, slot: 'music', style: 'village', prompt: 'p', proposal })).toEqual({
      subject_kind: 'world', subject_key: 'vale', slot: 'music', style: 'village', prompt: 'p', slots: { tempo: 'slow' },
    });
  });

  it('drops the suggested slots once the style was edited by hand', () => {
    const body = generateItem({ subject, slot: 'music', style: 'dungeon', prompt: '', proposal });
    expect(body.style).toBe('dungeon');
    expect(body.slots).toBeUndefined();
    expect(body.prompt).toBeUndefined();
  });

  it('sends no slots without a suggestion', () => {
    expect(generateItem({ subject, slot: 'music', style: '', prompt: '', proposal: null }).slots).toBeUndefined();
  });
});

describe('loop controls', () => {
  it('loopEditable is true for world_point/nearby only', () => {
    expect(loopEditable('world_point', 'nearby')).toBe(true);
    expect(loopEditable('creature', 'nearby')).toBe(false);
    expect(loopEditable('world_point', 'use')).toBe(false);
    expect(loopEditable('world', 'music')).toBe(false);
  });
  it('uploadParams carries loopable only when it is a boolean', () => {
    const base = { subjectKind: 'world_point', subjectKey: 'merchant_post', slot: 'nearby' };
    expect(uploadParams({ ...base, loopable: true }).get('loopable')).toBe('true');
    expect(uploadParams({ ...base, loopable: false }).get('loopable')).toBe('false');
    expect(uploadParams(base).has('loopable')).toBe(false);
    expect(uploadParams({ ...base, label: 'hum' }).get('label')).toBe('hum');
  });
});
