import { describe, it, expect } from 'vitest';
import { draftText, draftLength, isDirty } from '../artDescriptionDraft.js';

// SOMET-553. The distinction under test throughout is null (nobody typed)
// versus '' (someone cleared the field). They render identically and must
// never behave identically.
describe('draftText', () => {
  it('shows the stored description until someone types', () => {
    expect(draftText(null, { text: 'gnarled wand' })).toBe('gnarled wand');
    expect(draftText(null, null)).toBe('');
  });

  it('shows an EMPTIED field as empty, not as the stored text', () => {
    // The bug this guards: with '' as the "nothing typed" sentinel, clearing
    // the box re-displays the old description under the user's hands.
    expect(draftText('', { text: 'gnarled wand' })).toBe('');
  });

  it('prefers the local edit over the server value', () => {
    expect(draftText('my own words', { text: 'gnarled wand' })).toBe('my own words');
  });
});

describe('draftLength', () => {
  it('defaults to the length the description was written at', () => {
    expect(draftLength(null, { text: 'x', length: 'short' })).toBe('short');
  });

  it('falls back only when nothing has been chosen or stored', () => {
    expect(draftLength(null, { text: 'x', length: null })).toBe('medium');
    expect(draftLength(null, null)).toBe('medium');
  });

  it('respects an explicit choice over the stored one', () => {
    expect(draftLength('long', { text: 'x', length: 'short' })).toBe('long');
  });
});

describe('isDirty', () => {
  it('is false before anyone types, whatever is stored', () => {
    expect(isDirty(null, { text: 'gnarled wand' })).toBe(false);
    expect(isDirty(null, null)).toBe(false);
  });

  it('is false for a change that only adds whitespace', () => {
    // The store trims. Without this, Save is enabled, the write stores the
    // identical text, and the button never goes quiet again.
    expect(isDirty('gnarled wand  ', { text: 'gnarled wand' })).toBe(false);
  });

  it('is true for a real edit, including emptying the field', () => {
    expect(isDirty('something else', { text: 'gnarled wand' })).toBe(true);
    expect(isDirty('', { text: 'gnarled wand' })).toBe(true);
    expect(isDirty('first words', null)).toBe(true);
  });
});
