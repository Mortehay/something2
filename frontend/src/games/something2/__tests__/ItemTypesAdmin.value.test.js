import { describe, it, expect } from 'vitest';
import { emptyForm, formFromType, buildPayload, validateClient } from '../itemTypeForm.js';

// F-047/SOMET-227: the admin form had no input for item_types.value, so every
// item created through the UI landed at value 0 (worthless to sell, and
// excluded from the village base catalog's `value > 0` filter) even though
// the backend has accepted and stored a real value since F-003.

describe('ItemTypesAdmin value field', () => {
  it('includes a non-zero value entered by the admin in the create/update payload', () => {
    const form = { ...emptyForm(), name: 'shortsword', value: '250' };
    const payload = buildPayload(form);
    expect(payload.value).toBe(250);
  });

  it('defaults to 0, not undefined, when the admin leaves value blank', () => {
    const payload = buildPayload(emptyForm());
    expect(payload.value).toBe(0);
  });

  it('round-trips an existing item type\'s stored value back into the form', () => {
    const form = formFromType({ name: 'shortsword', category: 'weapon', value: 42 });
    expect(form.value).toBe(42);
    expect(buildPayload(form).value).toBe(42);
  });

  it('carries value across a category switch (weapon -> armor payload)', () => {
    const form = { ...emptyForm(), name: 'plate', category: 'armor', slot: 'chest', defense: 5, value: '99' };
    expect(buildPayload(form).value).toBe(99);
  });

  it('rejects a negative value client-side, mirroring the backend check', () => {
    const form = { ...emptyForm(), name: 'shortsword', value: '-5' };
    expect(validateClient(form)).toMatch(/value/i);
  });

  it('rejects a non-integer value client-side', () => {
    const form = { ...emptyForm(), name: 'shortsword', value: '4.5' };
    expect(validateClient(form)).toMatch(/value/i);
  });

  it('accepts a valid non-negative integer value', () => {
    const form = { ...emptyForm(), name: 'shortsword', value: '0' };
    expect(validateClient(form)).toBeNull();
  });
});
