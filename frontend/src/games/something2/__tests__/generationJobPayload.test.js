import { describe, it, expect } from 'vitest';
import { withOptionalBiome } from '../generationJobPayload.js';

describe('withOptionalBiome', () => {
  it('omits the biome key entirely when none is chosen', () => {
    const body = { tile_type: 'sand', base_prompt: 'sand', frames: 1 };
    const result = withOptionalBiome(body, '');
    expect(result).toEqual(body);
    expect('biome' in result).toBe(false);
  });

  it('omits the key for null/undefined too, not biome: null', () => {
    const body = { entity_type: 'Tree', base_prompt: 'a tree', frames: 4 };
    expect('biome' in withOptionalBiome(body, null)).toBe(false);
    expect('biome' in withOptionalBiome(body, undefined)).toBe(false);
  });

  it('includes biome as the chosen name when one is selected', () => {
    const body = { tile_type: 'sand', base_prompt: 'sand', frames: 1 };
    expect(withOptionalBiome(body, 'Arid Dunes')).toEqual({ ...body, biome: 'Arid Dunes' });
  });

  it('does not mutate the input body', () => {
    const body = { tile_type: 'sand', base_prompt: 'sand', frames: 1 };
    withOptionalBiome(body, 'Arid Dunes');
    expect(body).toEqual({ tile_type: 'sand', base_prompt: 'sand', frames: 1 });
    expect('biome' in body).toBe(false);
  });
});
