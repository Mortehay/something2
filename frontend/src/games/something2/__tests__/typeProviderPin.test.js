import { describe, it, expect } from 'vitest';
import { resolveProviderPinChoice, providerPinToState } from '../ProviderChoice.jsx';

const PROVIDERS = [
  { id: 1, name: 'Local Desktop', enabled: true },
  { id: 2, name: 'Cloud GPU', enabled: true },
];

describe('resolveProviderPinChoice (SOMET-342)', () => {
  it('resolves default mode to "default"', () => {
    expect(resolveProviderPinChoice('default', null, PROVIDERS)).toBe('default');
    expect(resolveProviderPinChoice(null, null, PROVIDERS)).toBe('default');
    expect(resolveProviderPinChoice(undefined, undefined, PROVIDERS)).toBe('default');
  });

  it('resolves local mode to "local"', () => {
    expect(resolveProviderPinChoice('local', null, PROVIDERS)).toBe('local');
    expect(resolveProviderPinChoice('local', 1, PROVIDERS)).toBe('local');
  });

  it('resolves valid provider pin to string ID', () => {
    expect(resolveProviderPinChoice('provider', 1, PROVIDERS)).toBe('1');
    expect(resolveProviderPinChoice('provider', 2, PROVIDERS)).toBe('2');
  });

  it('degrades a deleted provider pin to "default"', () => {
    // If pinned provider id (e.g. 99) is not in registered providers list,
    // it falls back to 'default' rather than showing a dangling reference.
    expect(resolveProviderPinChoice('provider', 99, PROVIDERS)).toBe('default');
    expect(resolveProviderPinChoice('provider', null, PROVIDERS)).toBe('default');
  });
});

describe('providerPinToState (SOMET-342)', () => {
  it('maps "default" or empty string to mode=default, id=null', () => {
    expect(providerPinToState('default')).toEqual({ ai_provider_mode: 'default', ai_provider_id: null });
    expect(providerPinToState('')).toEqual({ ai_provider_mode: 'default', ai_provider_id: null });
    expect(providerPinToState(null)).toEqual({ ai_provider_mode: 'default', ai_provider_id: null });
  });

  it('maps "local" to mode=local, id=null', () => {
    expect(providerPinToState('local')).toEqual({ ai_provider_mode: 'local', ai_provider_id: null });
  });

  it('maps provider ID string to mode=provider, id=number', () => {
    expect(providerPinToState('1')).toEqual({ ai_provider_mode: 'provider', ai_provider_id: 1 });
    expect(providerPinToState('42')).toEqual({ ai_provider_mode: 'provider', ai_provider_id: 42 });
  });
});
