// The REAL ArtConsoleAdmin's preview dialog and date sort (SOMET-546 rework).
//
// artSelection.test.js proves sortSubjects and freezeOrder, but nothing drove
// the component, so two things went unguarded:
//   - Escape was wired to the backdrop's onKeyDown. The backdrop is not
//     focusable and opening the preview leaves focus on the row's button, so
//     after a mouse open Escape never reached it -- the shipped defect.
//   - the freeze lives in a memo with a deliberately narrow dependency list.
//     Adding `subjects` to it re-captures on every landed generation and
//     defeats the freeze, and no test noticed.
// This renders the component function with the hook runtime and presses what
// it returns.
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { createRuntime, elements, textOf } from './artConsoleWiring.helpers.js';

const rt = createRuntime();
const state = { subjects: [], run: null };
const idle = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null });

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    useState: (...a) => rt.hooks.useState(...a),
    useRef: (...a) => rt.hooks.useRef(...a),
    useMemo: (...a) => rt.hooks.useMemo(...a),
    useCallback: (...a) => rt.hooks.useCallback(...a),
    useEffect: (...a) => rt.hooks.useEffect(...a),
  };
});
// One params object for the whole test, as the router would hand back: a new
// one per render would read as outside navigation.
const params = new URLSearchParams('art=all');
vi.mock('react-router-dom', () => ({ useSearchParams: () => [params, () => {}] }));
vi.mock('../useAiProviders.js', () => ({ useAiProviders: () => ({ providers: [], activeProvider: null }) }));
vi.mock('../useArtConsole.js', () => ({
  useArtQueue: () => ({
    stats: { queued: 0, running: 0, failed: 0 },
    run: state.run,
    inFlight: [],
    queued: { rows: [], total: 0, backoff: 0 },
    failures: [],
  }),
  useArtSubjects: () => ({
    kinds: ['tile'],
    subjects: state.subjects,
    isLoadingSubjects: false,
    subjectsError: null,
  }),
  useEnqueueArt: idle,
  useStartArtBatch: idle,
  useStopArtBatch: idle,
  useRequeueStale: idle,
  useRequeueFailures: idle,
  useClearArtQueue: idle,
  useClearArtGroups: idle,
  useArtHistory: () => ({ history: [], isLoadingHistory: false }),
  useArtNotes: () => ({ notes: [] }),
  useAddArtNote: idle,
  useRemoveArtNote: idle,
  useArtDescription: () => ({}),
  useWriteDescription: idle,
  useClearDescription: idle,
}));

const { default: ArtConsoleAdmin } = await import('../ArtConsoleAdmin.jsx');

const render = () => rt.render(() => ArtConsoleAdmin());

const tile = (key, updated) => ({
  kind: 'tile', key, name: key, has_art: Boolean(updated), image: updated ? `tiles/${key}.png` : null, updated_at: updated,
});

// The row order on the page, read off the rows' React keys.
const rowOrder = (tree) => [...elements(tree)]
  .filter((el) => el.type === 'tr' && typeof el.key === 'string' && el.key.includes('/'))
  .map((el) => el.key);

const byLabel = (tree, label) => [...elements(tree)].filter((el) => el.props['aria-label'] === label);

function clickHeader(tree, name) {
  const found = [...elements(tree)].filter(
    (el) => typeof el.props.onClick === 'function' && textOf(el).replace(/[↑↓]/g, '') === name,
  );
  expect(found, `precondition: exactly one "${name}" header`).toHaveLength(1);
  found[0].props.onClick();
  return render();
}

// No DOM in this suite: a window that records its CAPTURE-phase keydown
// listeners, and events that record whether a listener stopped them.
function fakeWindow() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener: (type, fn, capture) => { if (type === 'keydown' && capture === true) listeners.add(fn); },
    removeEventListener: (type, fn, capture) => { if (type === 'keydown' && capture === true) listeners.delete(fn); },
    press: (key) => {
      const e = {
        key, stopped: false, prevented: false,
        stopImmediatePropagation() { this.stopped = true; },
        preventDefault() { this.prevented = true; },
      };
      for (const fn of [...listeners]) fn(e);
      return e;
    },
  };
}

describe('ArtConsoleAdmin: the preview closes on Escape after a MOUSE open', () => {
  let win;
  beforeEach(() => {
    rt.slots = [];
    state.run = null;
    state.subjects = [tile('grass', '2026-10-01T00:00:00Z')];
    win = fakeWindow();
    vi.stubGlobal('window', win);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function openPreview() {
    const [thumb] = byLabel(render(), 'Preview tile/grass');
    expect(thumb, 'precondition: the row has a Preview button').toBeTruthy();
    // A click: nothing is focused inside the dialog afterwards.
    thumb.props.onClick();
    const tree = render();
    expect(byLabel(tree, 'Close preview'), 'precondition: the preview opened').toHaveLength(1);
    return tree;
  }

  it('Escape closes it with no element in the dialog focused', () => {
    openPreview();
    const e = win.press('Escape');
    expect(byLabel(render(), 'Close preview')).toHaveLength(0);
    // Stopped, so the Game's own window Escape handler does not also act.
    expect(e.stopped).toBe(true);
  });

  it('other keys leave it open', () => {
    openPreview();
    expect(win.press('Enter').stopped).toBe(false);
    expect(win.press('a').stopped).toBe(false);
    expect(byLabel(render(), 'Close preview')).toHaveLength(1);
  });

  it('listens only while a preview is open', () => {
    render();
    expect(win.listeners.size).toBe(0);
    openPreview();
    expect(win.listeners.size).toBe(1);
    win.press('Escape');
    render();
    expect(win.listeners.size).toBe(0);
  });
});

describe('ArtConsoleAdmin: sorting by Updated during a live batch holds the order', () => {
  beforeEach(() => {
    rt.slots = [];
    state.run = null;
    state.subjects = [
      tile('a', '2026-10-01T00:00:00Z'),
      tile('never', null),
      tile('b', '2026-10-02T00:00:00Z'),
    ];
    // A running batch starts the console's 1s clock; keep it off the real timers.
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('default order is kind+key (anti-vacuity: rows are read at all)', () => {
    expect(rowOrder(render())).toEqual(['tile/a', 'tile/b', 'tile/never']);
  });

  it('never-generated subjects sort last in BOTH directions', () => {
    let tree = clickHeader(render(), 'Updated');
    expect(rowOrder(tree)).toEqual(['tile/b', 'tile/a', 'tile/never']);
    tree = clickHeader(tree, 'Updated');
    expect(rowOrder(tree)).toEqual(['tile/a', 'tile/b', 'tile/never']);
  });

  it('a generation landing mid-batch does not reshuffle the page; the batch ending does', () => {
    const tree = clickHeader(render(), 'Updated');
    expect(rowOrder(tree)).toEqual(['tile/b', 'tile/a', 'tile/never']);

    state.run = { running: true };
    expect(rowOrder(render())).toEqual(['tile/b', 'tile/a', 'tile/never']);

    // `a` and `never` land, newer than `b`. A live sort would put them first.
    state.subjects = [
      tile('a', '2026-10-03T00:00:00Z'),
      tile('never', '2026-10-04T00:00:00Z'),
      tile('b', '2026-10-02T00:00:00Z'),
    ];
    expect(rowOrder(render())).toEqual(['tile/b', 'tile/a', 'tile/never']);

    state.run = { running: false };
    expect(rowOrder(render())).toEqual(['tile/never', 'tile/a', 'tile/b']);
  });

  it('the default order is not frozen: it never moves anyway', () => {
    state.run = { running: true };
    render();
    state.subjects = [...state.subjects, tile('aa', '2026-10-05T00:00:00Z')];
    expect(rowOrder(render())).toEqual(['tile/a', 'tile/aa', 'tile/b', 'tile/never']);
  });
});
