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

// vitest runs with environment: "node" here, so a hook body cannot be executed
// and these tests read source text instead. Two hazards come with that
// instrument, and these helpers exist to close them.

// Comments are not behaviour. The worldGraph invalidation is documented by a
// comment containing the literal word "worldGraph", so a bare substring check
// against the raw block would pass even if the CALL were deleted and only the
// comment survived.
// Caveat: this also eats "//" inside string literals. Safe here because every
// slice it is applied to is a handler body containing no URLs.
function withoutComments(block) {
  return block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// The success handler alone. An invalidation that landed in onError must not be
// able to satisfy an assertion about what happens on success.
function onSuccessOf(block) {
  const start = block.indexOf('onSuccess:');
  if (start === -1) throw new Error('no onSuccess handler found');
  const end = block.indexOf('onError:', start);
  return withoutComments(block.slice(start, end === -1 ? block.length : end));
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
  it('useSetLink invalidates the worldGraph query key on success', () => {
    const handler = onSuccessOf(exportedBlock(src('useMapsAdmin.js'), 'useSetLink'));
    expect(handler).toContain('queryKey: ["worldGraph"]');
  });

  it('useClearLink invalidates the worldGraph query key on success', () => {
    const handler = onSuccessOf(exportedBlock(src('useMapsAdmin.js'), 'useClearLink'));
    expect(handler).toContain('queryKey: ["worldGraph"]');
  });

  it('useSetLink still invalidates the keys the Maps tab depends on', () => {
    const handler = onSuccessOf(exportedBlock(src('useMapsAdmin.js'), 'useSetLink'));
    expect(handler).toContain('queryKey: ["worldLinks", v.id]');
    expect(handler).toContain('queryKey: ["worlds"]');
  });

  it('the position mutation invalidates only the graph, never the worlds list', () => {
    // Dragging a node is cosmetic; blowing away the shared ["worlds"] cache on
    // every drag would refetch the game's world picker for nothing.
    const handler = onSuccessOf(exportedBlock(src('useMapGraph.js'), 'useSaveGraphPosition'));
    expect(handler).toContain('queryKey: ["worldGraph"]');
    expect(handler).not.toContain('"worlds"');
  });

  it('the graph query targets the aggregate endpoint', () => {
    expect(exportedBlock(src('useMapGraph.js'), 'useWorldGraph')).toContain('/api/world-graph');
  });

  // Guards the instrument itself: if onSuccessOf ever stopped narrowing, every
  // test above would quietly go back to matching the whole function body.
  it('the onSuccess slice excludes the error handler', () => {
    const handler = onSuccessOf(exportedBlock(src('useMapsAdmin.js'), 'useSetLink'));
    expect(handler).not.toContain('onError');
    expect(handler).toContain('invalidateQueries');
  });
});
