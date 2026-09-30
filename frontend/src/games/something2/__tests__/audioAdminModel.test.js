import { describe, it, expect } from 'vitest';
import {
  generateBody, generateResultMessage, loopEditable, uploadParams,
} from '../useAudioAdmin.js';

// Final review F7 (SOMET-590): Suggest returns a style AND the box's slot
// values for that style. If the admin then types a different style, those
// slots belong to the old style and must not be sent with the new one.
describe('generateBody', () => {
  const subject = { kind: 'world', key: 'vale' };
  const proposal = { style: 'village', slots: { tempo: 'slow' } };

  it('sends the suggested slots with the suggested style', () => {
    expect(generateBody({ subject, slot: 'music', style: 'village', prompt: 'p', proposal })).toEqual({
      subject_kind: 'world', subject_key: 'vale', slot: 'music', style: 'village', prompt: 'p', slots: { tempo: 'slow' },
    });
  });

  it('drops the suggested slots once the style was edited by hand', () => {
    const body = generateBody({ subject, slot: 'music', style: 'dungeon', prompt: '', proposal });
    expect(body.style).toBe('dungeon');
    expect(body.slots).toBeUndefined();
    expect(body.prompt).toBeUndefined();
  });

  it('sends no slots without a suggestion', () => {
    expect(generateBody({ subject, slot: 'music', style: '', prompt: '', proposal: null }).slots).toBeUndefined();
  });
});

// Review fix (SOMET-592, Task 8 fix round 1): the /admin/generate success
// toast used to always say 'Clip generated and bound', even when the
// backend's 201 carried `partial: true` (some sfx variants failed mid-store)
// -- the admin never learned a generation came back short.
describe('generateResultMessage', () => {
  it('a music/ambience success (single clip, no partial concept) keeps the plain message', () => {
    expect(generateResultMessage({ clip: { id: 'c1' }, binding: { id: 1 } }, undefined))
      .toBe('Clip generated and bound');
  });

  it('a full sfx success (every requested variant stored) keeps the plain message', () => {
    const json = { clips: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], bindings: [{}, {}, {}] };
    expect(generateResultMessage(json, 3)).toBe('Clip generated and bound');
  });

  it('a partial sfx store names how many arrived, how many were asked for, and why', () => {
    const json = {
      clips: [{ id: 'a' }], bindings: [{}], partial: true, error: 'box timeout on variant 2',
    };
    expect(generateResultMessage(json, 3)).toBe('Generated 1 of 3 variant(s) — box timeout on variant 2');
  });

  it('falls back to the stored count when the requested count is missing', () => {
    const json = {
      clips: [{ id: 'a' }, { id: 'b' }], bindings: [{}, {}], partial: true, error: 'x',
    };
    expect(generateResultMessage(json, undefined)).toBe('Generated 2 of 2 variant(s) — x');
  });

  it('treats a missing or falsy json as no message worth flagging', () => {
    expect(generateResultMessage(undefined, 3)).toBe('Clip generated and bound');
    expect(generateResultMessage(null, 3)).toBe('Clip generated and bound');
  });
});

// SOMET-592 (I2): only a world point's nearby slot offers Loop, and the
// upload sends the flag only when the checkbox exists.
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
