import { describe, it, expect } from 'vitest';
import { pointKindHidesWorldFields, pointKindPayload, defaultButtonState } from '../pointKindForm.js';

describe('pointKindHidesWorldFields', () => {
  it('hides walkable/spawn/creature fields for any point kind', () => {
    expect(pointKindHidesWorldFields('portal')).toBe(true);
    expect(pointKindHidesWorldFields('chest_field')).toBe(true);
  });
  it('shows them when the type is not a point kind', () => {
    expect(pointKindHidesWorldFields(null)).toBe(false);
    expect(pointKindHidesWorldFields('')).toBe(false);
    expect(pointKindHidesWorldFields(undefined)).toBe(false);
  });
});

describe('pointKindPayload', () => {
  it('always names point_kind so an omitted field cannot be mistaken for "keep"', () => {
    expect(pointKindPayload({ point_kind: 'portal' })).toEqual({ point_kind: 'portal' });
    expect(pointKindPayload({ point_kind: '' })).toEqual({ point_kind: null });
    expect(pointKindPayload({})).toEqual({ point_kind: null });
  });
});

describe('defaultButtonState', () => {
  const kinds = [
    { kind: 'portal', default_entity_type_id: 7, default_name: 'portal' },
    { kind: 'waypoint', default_entity_type_id: null, default_name: null },
  ];
  it('is hidden for a type with no point kind or for an unsaved type', () => {
    expect(defaultButtonState({ pointKind: null, entityId: 7, kinds }).visible).toBe(false);
    expect(defaultButtonState({ pointKind: 'portal', entityId: null, kinds }).visible).toBe(false);
  });
  it('is disabled when the type already is the default', () => {
    const s = defaultButtonState({ pointKind: 'portal', entityId: 7, kinds });
    expect(s).toEqual({ visible: true, disabled: true, label: 'Default for portal' });
  });
  it('offers to make a different type the default', () => {
    const s = defaultButtonState({ pointKind: 'portal', entityId: 9, kinds });
    expect(s).toEqual({ visible: true, disabled: false, label: 'Make default for portal (currently: portal)' });
  });
  it('names "none" when the kind has no default yet', () => {
    const s = defaultButtonState({ pointKind: 'waypoint', entityId: 9, kinds });
    expect(s.label).toBe('Make default for waypoint (currently: none)');
  });
});
