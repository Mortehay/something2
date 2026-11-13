// Image shrink Task 4: the GAME's effect hooks ask for web copies (?art=web) under
// keys that extend the admin keys, so an admin invalidateQueries([<key>]) still
// refreshes them by prefix; the admin hooks keep their keys and plain URLs.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured = [];
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts) => { captured.push(opts); return { data: undefined, isLoading: false, isError: false }; },
  useMutation: () => ({}),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));
vi.mock('react-hot-toast', () => ({ default: { success() {}, error() {} } }));

import { useVfxEffects, useAuraEffects, useBuffVisuals, useStatusVisuals } from '../useMaps.js';
import { useVfxEffectsAdmin, VFX_QUERY_KEY } from '../useVfxEffects.js';
import { useAuraEffectsAdmin, AURA_QUERY_KEY } from '../useAuraEffects.js';
import { useBuffVisualsAdmin, BUFF_VISUALS_QUERY_KEY } from '../useBuffVisuals.js';
import { useStatusVisualsAdmin } from '../useEffectDisplay.js';

async function run(hook) {
  captured.length = 0;
  hook();
  const opts = captured[0];
  const urls = [];
  vi.stubGlobal('fetch', vi.fn(async (url) => { urls.push(String(url)); return { ok: true, json: async () => ({}) }; }));
  await opts.queryFn();
  return { key: opts.queryKey, url: urls[0] };
}

beforeEach(() => { vi.unstubAllGlobals(); });

const GAME = [
  ['vfx', useVfxEffects, 'vfxEffects', '/api/vfx-effects'],
  ['aura', useAuraEffects, 'auraEffects', '/api/aura-effects'],
  ['buff', useBuffVisuals, 'buffVisuals', '/api/buff-visuals'],
  ['status', useStatusVisuals, 'statusVisuals', '/api/status-visuals'],
];
const ADMIN = [
  ['vfx', useVfxEffectsAdmin, ['vfxEffects'], '/api/vfx-effects'],
  ['aura', useAuraEffectsAdmin, ['auraEffects'], '/api/aura-effects'],
  ['buff', useBuffVisualsAdmin, ['buffVisuals'], '/api/buff-visuals'],
  ['status', useStatusVisualsAdmin, ['statusVisuals'], '/api/status-visuals'],
];

describe('game hooks', () => {
  for (const [name, hook, base, path] of GAME) {
    it(`${name}: key ends with 'web' under the admin key, url has art=web`, async () => {
      const { key, url } = await run(hook);
      expect(key).toEqual([base, 'web']);
      expect(url).toContain(path);
      expect(url).toContain('art=web');
    });
  }
});

describe('admin hooks', () => {
  for (const [name, hook, key, path] of ADMIN) {
    it(`${name}: keeps its original key and a plain url`, async () => {
      const r = await run(hook);
      expect(r.key).toEqual(key);
      expect(r.url).toContain(path);
      expect(r.url).not.toContain('art=web');
    });
  }
  it('exported admin keys are unchanged', () => {
    expect(VFX_QUERY_KEY).toEqual(['vfxEffects']);
    expect(AURA_QUERY_KEY).toEqual(['auraEffects']);
    expect(BUFF_VISUALS_QUERY_KEY).toEqual(['buffVisuals']);
  });
});
