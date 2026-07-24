import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as useMapsHooks from '../useMaps.js';

// F-026/SOMET-206: MapPreview.jsx and the legacy flat-map hooks it depended
// on (useMaps, fetchMap, fetchMapEntities, useGenerateMap, useDeleteMap,
// useSaveEntities, useGenerateEntities) had zero call sites anywhere in the
// frontend -- the whole "maps" subsystem was superseded by the worlds/
// chunked system (useWorlds.js, MapsAdmin.jsx, WorldPreview.jsx) but was
// never removed. Deleting a component because one grep looked clean is the
// exact failure mode this audit called out, so this test does the same
// repo-wide scan the finding's own verification step describes and locks the
// result in as a regression guard: none of these should ever come back
// without a live call site accompanying them.
//
// Note: useMapTiles, useMapConfig, useTileTypes/useEntityTypes and their
// mutations are NOT in this list -- they're live (Something2.jsx,
// MapsAdmin.jsx) and must stay.

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const LEGACY_SYMBOLS = [
  'useMaps', 'fetchMap', 'fetchMapEntities', 'useGenerateMap',
  'useDeleteMap', 'useSaveEntities', 'useGenerateEntities',
];

describe('legacy flat-map subsystem removal', () => {
  it('MapPreview.jsx no longer exists', () => {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'MapPreview.jsx');
    expect(fs.existsSync(p)).toBe(false);
  });

  it('useMaps.js no longer exports any legacy flat-map hook', () => {
    for (const name of LEGACY_SYMBOLS) {
      expect(useMapsHooks[name], `useMaps.js should not export ${name}`).toBeUndefined();
    }
  });

  it('has zero references to MapPreview or the legacy hooks anywhere in frontend/src', () => {
    const thisFile = fileURLToPath(import.meta.url);
    const files = walk(srcDir).filter((f) => f !== thisFile);
    const offenders = [];
    for (const file of files) {
      // Strip import/require path string literals first: every consumer of
      // useMaps.js's *live* exports (e.g. useTileTypes) legitimately writes
      // `from './useMaps.js'`, and that path literally contains the
      // substring "useMaps" with word boundaries on both sides ('/' and '.'
      // are non-word chars) -- without stripping it, every such import would
      // false-positive as a reference to the removed useMaps() hook.
      const text = fs.readFileSync(file, 'utf8')
        .replace(/from\s+['"][^'"]*['"]/g, '')
        .replace(/require\(\s*['"][^'"]*['"]\s*\)/g, '');
      if (/\bMapPreview\b/.test(text)) offenders.push(`${file}: MapPreview`);
      for (const name of LEGACY_SYMBOLS) {
        // word-boundary match so e.g. "useMaps" doesn't false-positive on
        // "useMapsAdmin" or "useMapTiles"/"useMapConfig".
        const re = new RegExp(`\\b${name}\\b`);
        if (re.test(text)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
