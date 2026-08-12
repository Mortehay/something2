import { describe, it, expect } from 'vitest';
import { validateClient, buildPayload, emptyForm } from '../itemTypeForm.js';

// SOMET-79: the resistances editor accepted two rows naming the same element.
// buildPayload writes them into an object keyed by element, so the LATER row
// silently overwrote the earlier one -- the author's first value vanished on
// save with nothing said. This pins the refusal, and the reason it has to be a
// refusal rather than a merge: the form cannot know which value was meant.
const armor = (rows) => ({
  ...emptyForm(),
  name: 'test-vest',
  category: 'armor',
  slot: 'chest',
  defense: '2',
  resistanceRows: rows,
});

describe('resistance rows', () => {
  it('rejects two rows for the same element', () => {
    const err = validateClient(armor([
      { element: 'fire', value: '0.3' },
      { element: 'fire', value: '0.5' },
    ]));
    expect(err).toMatch(/fire/);
    expect(err).toMatch(/twice/);
  });

  it('allows distinct elements', () => {
    expect(validateClient(armor([
      { element: 'fire', value: '0.3' },
      { element: 'ice', value: '0.2' },
    ]))).toBe(null);
  });

  it('ignores blank rows rather than treating them as duplicates', () => {
    // An empty row is how the editor renders "add another" before a choice is
    // made; two of them are not a conflict and must not block saving.
    expect(validateClient(armor([
      { element: '', value: '' },
      { element: '', value: '' },
      { element: 'fire', value: '0.3' },
    ]))).toBe(null);
  });

  it('documents the silent overwrite that made this a defect', () => {
    // buildPayload is unchanged -- it still collapses by key. That is exactly
    // why validation has to catch the duplicate first: if this ever stops
    // being true the guard above is the only thing standing between an author
    // and quietly losing a value.
    const payload = buildPayload(armor([
      { element: 'fire', value: '0.3' },
      { element: 'fire', value: '0.5' },
    ]));
    expect(payload.resistances).toEqual({ fire: 0.5 });
  });
});
