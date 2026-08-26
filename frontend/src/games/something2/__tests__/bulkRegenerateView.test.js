import { describe, it, expect } from 'vitest';
import { runViewState, confirmMessage } from '../bulkRegenerateView.js';
import BulkRegenerateButton from '../BulkRegenerateButton.jsx';

const run = (over = {}) => ({
  id: 'bulk_1', kind: 'tiles', status: 'running', total: 50, done: 10, failed: 0,
  skipped: [], errors: [], current: { table: 'tile_types', name: 'grass' },
  error: null, cancelling: false, ...over,
});

describe('runViewState', () => {
  it('shows progress for a run of its own kind', () => {
    const s = runViewState(run(), 'tiles');
    expect(s.mode).toBe('running');
    expect(s.handled).toBe(10);
    expect(s.percent).toBe(20);
    expect(s.currentName).toBe('grass');
  });

  it('counts failures as handled so the bar reaches the end', () => {
    // Otherwise a run with failures stalls short of 100% and reads as hung.
    const s = runViewState(run({ done: 40, failed: 10 }), 'tiles');
    expect(s.handled).toBe(50);
    expect(s.percent).toBe(100);
  });

  it('reports the other registry as busy rather than offering its own button', () => {
    // There is one run server-side. Offering "Regenerate all tiles" during an
    // entities run would just produce a 409 on click.
    const s = runViewState(run({ kind: 'entities' }), 'tiles');
    expect(s.mode).toBe('busy-elsewhere');
    expect(s.otherKind).toBe('entities');
  });

  it('does not report a finished run belonging to the other registry', () => {
    const s = runViewState(run({ kind: 'entities', status: 'done', done: 308 }), 'tiles');
    expect(s.mode).toBe('idle');
  });

  it('summarises a finished run, including what was skipped', () => {
    const s = runViewState(run({
      status: 'done', done: 48, failed: 2, current: null,
      skipped: [{ table: 'tile_types', name: 'lava' }],
    }), 'tiles');
    expect(s).toMatchObject({ mode: 'finished', stopped: false, done: 48, failed: 2 });
    expect(s.skipped.map(x => x.name)).toEqual(['lava']);
  });

  it('distinguishes a stopped run from a completed one', () => {
    expect(runViewState(run({ status: 'cancelled', current: null }), 'tiles').stopped).toBe(true);
  });

  it('never divides by zero when everything was skipped', () => {
    const s = runViewState(run({ total: 0, done: 0 }), 'tiles');
    expect(s.percent).toBe(0);
  });

  it('is idle before anything has ever run', () => {
    expect(runViewState(null, 'tiles')).toEqual({ mode: 'idle' });
  });
});

describe('confirmMessage', () => {
  it('always states that sprites are untouched', () => {
    // "Regenerate all" is precisely the phrase that would make an admin fear
    // for their animation work, so the confirm has to answer it.
    expect(confirmMessage({ count: 50, noun: 'tiles', includeRect: false }))
      .toMatch(/Sprites and animations are not touched/);
  });

  it('says out loud when colour-box types are included', () => {
    expect(confirmMessage({
      count: 194, countIncludingRect: 308, noun: 'entities', includeRect: true,
    })).toMatch(/including colour-box types/);
    expect(confirmMessage({
      count: 194, countIncludingRect: 308, noun: 'entities', includeRect: false,
    })).not.toMatch(/colour-box/);
  });

  it('promises the number it will actually regenerate, not the catalog total', () => {
    // Caught in the browser: with the checkbox off the dialog said "308
    // entities" while the run would do 194.
    expect(confirmMessage({
      count: 194, countIncludingRect: 308, noun: 'entities', includeRect: false,
    })).toMatch(/Regenerate 194 entities/);
    expect(confirmMessage({
      count: 194, countIncludingRect: 308, noun: 'entities', includeRect: true,
    })).toMatch(/all 308 entities/);
    // Tiles pass one count; it must still read correctly either way.
    expect(confirmMessage({ count: 50, noun: 'tiles', includeRect: true }))
      .toMatch(/all 50 tiles/);
  });
});

describe('BulkRegenerateButton', () => {
  // No React test renderer in this project, so this only proves the module and
  // its import graph load -- which is what catches a bad import path in the
  // two admin pages that mount it.
  it('is a component export', () => {
    expect(typeof BulkRegenerateButton).toBe('function');
  });
});
