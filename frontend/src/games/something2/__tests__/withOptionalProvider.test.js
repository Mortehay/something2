import { describe, it, expect } from 'vitest';
import { withOptionalBiome, withOptionalProvider } from '../generationJobPayload.js';

const BASE = { tile_type: 'grass', base_prompt: 'lush grass', frames: 1 };

describe('withOptionalProvider', () => {
  it('sends NO provider key when the selector is on Default', () => {
    // The property that keeps today's behaviour byte-identical for anyone who
    // never opens the Settings tab. An explicit null would still read as an
    // override to the backend's Number.isInteger check today, but it would
    // also make "unset" and "deliberately nothing" indistinguishable in
    // devtools -- the same reasoning as withOptionalBiome.
    const out = withOptionalProvider(BASE, '');
    expect(out).toEqual(BASE);
    expect('ai_provider_id' in out).toBe(false);
    expect('ai_provider_local' in out).toBe(false);
  });

  it('sends ai_provider_local for an explicit local pin', () => {
    expect(withOptionalProvider(BASE, 'local')).toEqual({ ...BASE, ai_provider_local: true });
  });

  it('sends an integer ai_provider_id for a specific provider', () => {
    const out = withOptionalProvider(BASE, '3');
    expect(out.ai_provider_id).toBe(3);
    expect(typeof out.ai_provider_id).toBe('number');
    expect('ai_provider_local' in out).toBe(false);
  });

  it('treats null and undefined as Default rather than as a pin', () => {
    expect(withOptionalProvider(BASE, null)).toEqual(BASE);
    expect(withOptionalProvider(BASE, undefined)).toEqual(BASE);
  });

  it('ignores a non-numeric value rather than sending NaN', () => {
    // A NaN id would reach the backend as null in JSON and be silently
    // ignored; better to never construct it.
    const out = withOptionalProvider(BASE, 'garbage');
    expect(out).toEqual(BASE);
  });

  it('never mutates the body it was given', () => {
    const body = { ...BASE };
    withOptionalProvider(body, '3');
    expect(body).toEqual(BASE);
  });

  it('composes with withOptionalBiome without either clobbering the other', () => {
    // Both wrappers are applied at the call sites; this pins that the two
    // optional keys coexist and that neither drops the other's.
    const out = withOptionalProvider(withOptionalBiome(BASE, 'Forest'), '3');
    expect(out).toEqual({ ...BASE, biome: 'Forest', ai_provider_id: 3 });

    // And the both-unset case is still exactly the original body.
    expect(withOptionalProvider(withOptionalBiome(BASE, ''), '')).toEqual(BASE);
  });
});
