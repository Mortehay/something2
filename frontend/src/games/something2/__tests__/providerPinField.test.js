import { describe, it, expect } from 'vitest';
import { pinToSelectValue, selectValueToPin } from '../ProviderPinField.jsx';

// SOMET-342. A <select> holds one string; the API takes two columns that must
// never disagree. This pair of functions is the whole conversion, and it is
// where a pin would silently save as something other than what was chosen.

describe('pinToSelectValue: stored columns -> the form', () => {
  it('shows Default for an unpinned type', () => {
    expect(pinToSelectValue('default', null)).toBe('');
    expect(pinToSelectValue(undefined, undefined)).toBe('');
  });

  it('shows the local service and a pinned provider', () => {
    expect(pinToSelectValue('local', null)).toBe('local');
    expect(pinToSelectValue('provider', 7)).toBe('7');
  });

  it('shows Default for a pin whose provider was deleted', () => {
    // ON DELETE SET NULL leaves mode 'provider' with a null id. The resolver
    // treats that as no pin, so the editor has to agree -- showing a blank
    // "provider" option would tell the admin a service is pinned when the
    // next generation will not use one.
    expect(pinToSelectValue('provider', null)).toBe('');
  });
});

describe('selectValueToPin: the form -> what gets sent', () => {
  it('sends a real mode for every option', () => {
    expect(selectValueToPin('')).toEqual({ ai_provider_mode: 'default', ai_provider_id: null });
    expect(selectValueToPin('local')).toEqual({ ai_provider_mode: 'local', ai_provider_id: null });
    expect(selectValueToPin('7')).toEqual({ ai_provider_mode: 'provider', ai_provider_id: 7 });
  });

  it('sends the id as a number, not the string the DOM gave it', () => {
    // The backend rejects a non-integer ai_provider_id with a 400, so a
    // forgotten Number() here is a save that fails for every pinned type.
    expect(typeof selectValueToPin('7').ai_provider_id).toBe('number');
  });

  it('unpinning clears the id, so mode and id cannot disagree', () => {
    expect(selectValueToPin('').ai_provider_id).toBeNull();
    expect(selectValueToPin('local').ai_provider_id).toBeNull();
  });

  it('round-trips every state it can be in', () => {
    for (const [mode, id] of [['default', null], ['local', null], ['provider', 3]]) {
      const back = selectValueToPin(pinToSelectValue(mode, id));
      expect(back).toEqual({ ai_provider_mode: mode, ai_provider_id: id });
    }
  });
});
