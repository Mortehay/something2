import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as graphHooks from '../useMapGraph.js';
import * as adminHooks from '../useMapsAdmin.js';

const src = (name) => readFileSync(
  fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8',
);

// Slice out ONE exported function's body, so a test for useSetLink cannot be
// satisfied by useClearLink happening to contain the string. (A slice spanning
// both would pass with only one of them fixed — the exact shape of vacuous test
// this repo keeps catching.)
function exportedBlock(source, name) {
  const start = source.indexOf(`export function ${name}`);
  if (start === -1) throw new Error(`${name} not found`);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

describe('useMapGraph', () => {
  it('exports the graph query and the position mutation', () => {
    expect(typeof graphHooks.useWorldGraph).toBe('function');
    expect(typeof graphHooks.useSaveGraphPosition).toBe('function');
  });

  it('still exports the link mutations it reuses', () => {
    expect(typeof adminHooks.useSetLink).toBe('function');
    expect(typeof adminHooks.useClearLink).toBe('function');
  });
});

describe('cross-tab invalidation', () => {
  // Both the Maps tab and the World Map tab edit map_links. If a link mutation
  // does not invalidate the graph query, the diagram silently keeps showing a
  // link that no longer exists.
  it('useSetLink invalidates the worldGraph query key', () => {
    expect(exportedBlock(src('useMapsAdmin.js'), 'useSetLink')).toContain('worldGraph');
  });

  it('useClearLink invalidates the worldGraph query key', () => {
    expect(exportedBlock(src('useMapsAdmin.js'), 'useClearLink')).toContain('worldGraph');
  });

  it('useSetLink still invalidates the keys the Maps tab depends on', () => {
    const block = exportedBlock(src('useMapsAdmin.js'), 'useSetLink');
    expect(block).toContain('worldLinks');
    expect(block).toContain('"worlds"');
  });

  it('the position mutation does NOT invalidate the whole worlds list', () => {
    // Dragging a node is cosmetic; blowing away the shared ["worlds"] cache on
    // every drag would refetch the game's world picker for nothing.
    const block = exportedBlock(src('useMapGraph.js'), 'useSaveGraphPosition');
    expect(block).toContain('worldGraph');
    expect(block).not.toContain('"worlds"');
  });

  it('the graph query targets the aggregate endpoint', () => {
    expect(src('useMapGraph.js')).toContain('/api/world-graph');
  });
});
