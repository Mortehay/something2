// The REAL ArtConsoleAdmin routes "Queue N selected" through joinInFlight
// (SOMET-538 re-validation, mutant M8).
//
// artSelection.test.js proves joinInFlight is single-flight, but nothing
// clicked the console's button, so `const onEnqueue = () => submitEnqueue();`
// stayed green -- and a same-tick double click then sent two POSTs, the second
// reply overwriting "Queued 2 of 2" with "0 of 2 -- 2 already in flight". This
// renders the component function once and presses the button it returned.
import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';
import { createRuntime, elements, textOf } from './artConsoleWiring.helpers.js';

const rt = createRuntime();
const mutateAsync = vi.fn();
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
vi.mock('react-router-dom', () => ({ useSearchParams: () => [new URLSearchParams()] }));
vi.mock('../useAiProviders.js', () => ({ useAiProviders: () => ({ providers: [], activeProvider: null }) }));
vi.mock('../useArtConsole.js', () => ({
  useArtQueue: () => ({
    stats: { queued: 0, running: 0, failed: 0 },
    run: null,
    inFlight: [],
    queued: { rows: [], total: 0, backoff: 0 },
    failures: [],
  }),
  useArtSubjects: () => ({
    kinds: ['skill'],
    subjects: [
      { kind: 'skill', key: 'a', name: 'A', has_art: false },
      { kind: 'skill', key: 'b', name: 'B', has_art: false },
    ],
    isLoadingSubjects: false,
    subjectsError: null,
  }),
  useEnqueueArt: () => ({ mutateAsync, isPending: false }),
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

const render = () => rt.render(() => ArtConsoleAdmin(), { runEffects: false });

// The selection is the first Set held in state; seed it as if two rows were
// ticked, then render again so the button's closure sees it.
function renderWithSelection(ids) {
  render();
  const idx = rt.slots.findIndex((v) => v instanceof Set);
  expect(idx, 'precondition: the console holds its selection in state').toBeGreaterThanOrEqual(0);
  rt.slots[idx] = new Set(ids);
  return render();
}

function queueButton(tree) {
  const found = [...elements(tree)].filter(
    (el) => typeof el.props.onClick === 'function' && /^Queue \d+ selected$/.test(textOf(el).trim()),
  );
  expect(found, 'precondition: exactly one Queue button').toHaveLength(1);
  return found[0];
}

describe('ArtConsoleAdmin: Queue N selected is single-flight', () => {
  beforeEach(() => {
    rt.slots = [];
    mutateAsync.mockReset();
  });

  it('two clicks in one tick send ONE enqueue', async () => {
    let finish;
    mutateAsync.mockImplementation(() => new Promise((r) => { finish = r; }));
    const button = queueButton(renderWithSelection(['skill/a', 'skill/b']));
    expect(textOf(button).trim()).toBe('Queue 2 selected');

    const first = button.props.onClick();
    const second = button.props.onClick();
    await Promise.resolve();
    await Promise.resolve();
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].byKind.get('skill')).toEqual(['a', 'b']);

    finish([{ kind: 'skill', requested: 2, queued: 2, already_live: 0, unknown: [] }]);
    await Promise.all([first, second]);
  });

  it('a click in a LATER tick, after the first settles, is sent', async () => {
    mutateAsync.mockResolvedValue([{ kind: 'skill', requested: 1, queued: 1, already_live: 0, unknown: [] }]);
    const button = queueButton(renderWithSelection(['skill/a']));
    await button.props.onClick();
    await button.props.onClick();
    expect(mutateAsync).toHaveBeenCalledTimes(2);
  });
});
