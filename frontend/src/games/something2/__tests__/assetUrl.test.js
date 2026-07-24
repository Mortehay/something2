import { describe, it, expect } from 'vitest';
import { assetUrl, assetUrlVersioned } from '../useTileSprites.js';

const KEY = 'sprites/objects/Tree/static.png';

describe('assetUrl', () => {
  it('routes through the backend asset proxy, not MinIO', () => {
    expect(assetUrl(KEY)).toMatch(/\/api\/assets\/sprites\/objects\/Tree\/static\.png$/);
  });

  it('is null for a missing key', () => {
    expect(assetUrl(null)).toBeNull();
    expect(assetUrl(undefined)).toBeNull();
    expect(assetUrl('')).toBeNull();
  });
});

describe('assetUrlVersioned', () => {
  // The point of the helper: regenerating overwrites the SAME key, and
  // /api/assets sends max-age=300, so an unversioned URL shows the old art.
  it('appends the version so a regenerated asset is not served from cache', () => {
    const a = assetUrlVersioned(KEY, '2026-07-23T10:00:00Z');
    const b = assetUrlVersioned(KEY, '2026-07-24T10:00:00Z');
    expect(a).not.toBe(b);
    expect(a).toContain('?v=');
  });

  it('escapes a version containing URL-significant characters', () => {
    expect(assetUrlVersioned(KEY, 'a b&c')).toContain('?v=a%20b%26c');
  });

  it('falls back to the plain URL when no version is known', () => {
    expect(assetUrlVersioned(KEY, null)).toBe(assetUrl(KEY));
    expect(assetUrlVersioned(KEY, undefined)).toBe(assetUrl(KEY));
  });

  it('is null for a missing key regardless of version', () => {
    expect(assetUrlVersioned(null, 'v1')).toBeNull();
  });
});
