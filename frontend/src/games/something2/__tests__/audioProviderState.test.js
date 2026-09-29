import { describe, it, expect } from 'vitest';
import { audioProviderState } from '../useAiProviders.js';

// SOMET-591 (verification fix): the Audio admin tab used to return an early
// "no provider" page that hid the whole tab -- library, upload,
// bind-from-library, volume/weight/remove, the batch panel's Retry/Clear/Stop,
// and the misses list all work without a provider. Only the generation
// controls (Suggest/Generate/Queue/Start) need one. This is the pure rule
// AudioAdmin.jsx and SubjectSounds.jsx both apply.
describe('audioProviderState', () => {
  it('disables generation and shows the "none" banner once settled with no active audio provider', () => {
    expect(audioProviderState({ activeAudioProvider: null, isLoading: false, error: null }))
      .toEqual({ canGenerate: false, banner: 'none' });
  });

  it('leaves generation enabled with an active audio provider', () => {
    const provider = { id: 1, modality: 'audio', is_active: true };
    expect(audioProviderState({ activeAudioProvider: provider, isLoading: false, error: null }))
      .toEqual({ canGenerate: true, banner: null });
  });

  it('defaults to enabled while still loading, so it never flicker-disables', () => {
    expect(audioProviderState({ activeAudioProvider: null, isLoading: true, error: null }))
      .toEqual({ canGenerate: true, banner: null });
  });

  it('shows a distinct "could not load" banner on a query error, without disabling generation', () => {
    expect(audioProviderState({ activeAudioProvider: null, isLoading: false, error: new Error('boom') }))
      .toEqual({ canGenerate: true, banner: 'error' });
  });

  it('prefers the error banner even if loading somehow reads true alongside it', () => {
    expect(audioProviderState({ activeAudioProvider: null, isLoading: true, error: new Error('boom') }))
      .toEqual({ canGenerate: true, banner: 'error' });
  });
});
