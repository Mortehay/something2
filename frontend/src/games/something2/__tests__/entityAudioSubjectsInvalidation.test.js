import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// SOMET-605: Boss tier (and a new/removed creature) changes which audio
// subjects/slots exist. App.jsx staleTime is 60s, so every entity mutation
// must invalidate the audio subjects list itself. The node-env suite cannot
// render hooks, so this reads the hook source like entityAuras.test.js does.
const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, '../useMaps.js'), 'utf8');

function hookBody(name) {
  const start = src.indexOf(`export function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf('\nexport function ', start + 1);
  // Comments dropped: a commented-out call must not satisfy the pin.
  return src.slice(start, next === -1 ? undefined : next).replace(/\/\/.*$/gm, '');
}

describe('entity mutations refresh the audio subjects list (SOMET-605)', () => {
  for (const name of ['useCreateEntityType', 'useUpdateEntityType', 'useDeleteEntityType']) {
    it(`${name} invalidates ['audio-subjects']`, () => {
      expect(hookBody(name)).toMatch(/invalidateQueries\(\{ queryKey: \['audio-subjects'\] \}\)/);
    });
  }
  it("the literal matches useAudioAdmin's SUBJECTS_KEY", () => {
    const audio = fs.readFileSync(path.join(dir, '../useAudioAdmin.js'), 'utf8');
    expect(audio).toMatch(/SUBJECTS_KEY = \['audio-subjects'\]/);
  });
});
