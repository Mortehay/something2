import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

// SOMET-535 rework 3. The CONSOLE itself, not just the component, must print a
// refused Start. Rendered with the data hooks stubbed, so a console that drops
// <ArtStartError> -- or prints the message only inside the size-refusal panel,
// which is the shipped defect -- goes RED here.
const state = { startError: null, run: null };

const mutation = (extra = {}) => ({
  mutate: () => {}, reset: () => {}, isPending: false, error: null, ...extra,
});

vi.mock('../useArtConsole.js', () => ({
  useArtSubjects: () => ({ kinds: [], subjects: [], isLoadingSubjects: false, subjectsError: null }),
  useArtQueue: () => ({
    stats: { queued: 1, running: 0, failed: 0 },
    run: state.run,
    inFlight: [],
    queued: { rows: [], total: 1, backoff: 0 },
    failures: [],
  }),
  useEnqueueArt: () => mutation(),
  useStartArtBatch: () => mutation({ error: state.startError }),
  useStopArtBatch: () => mutation(),
  useRequeueStale: () => mutation(),
  useRequeueFailures: () => mutation(),
  useClearArtQueue: () => mutation(),
  useClearArtGroups: () => mutation(),
  useArtHistory: () => ({ history: [], isLoadingHistory: false }),
  useArtNotes: () => ({ notes: [] }),
  useAddArtNote: () => mutation(),
  useRemoveArtNote: () => mutation(),
  useArtDescription: () => ({}),
  useWriteDescription: () => mutation(),
  useClearDescription: () => mutation(),
}));
vi.mock('../useAiProviders.js', () => ({
  useAiProviders: () => ({ providers: [], activeProvider: null }),
}));

const { default: ArtConsoleAdmin } = await import('../ArtConsoleAdmin.jsx');

function render() {
  return renderToStaticMarkup(
    h(MemoryRouter, { initialEntries: ['/game/art?art=all'] }, h(ArtConsoleAdmin)),
  );
}

function refusal(message, blocked = []) {
  const err = new Error(message);
  err.blocked = blocked;
  return err;
}

const MIXED = 'provider_id is required -- the queue holds 1 connector job(s); only a queue of local jobs can start without one';
const EMPTY = 'nothing is queued -- queue subjects first';

describe('Art console shows a refused Start', () => {
  beforeEach(() => { state.startError = null; state.run = null; });

  it('renders the console at all (anti-vacuity)', () => {
    expect(render()).toContain('Start batch');
  });

  for (const msg of [MIXED, EMPTY]) {
    it(`prints "${msg.slice(0, 30)}…" in an alert`, () => {
      state.startError = refusal(msg);
      const html = render();
      expect(html).toContain(msg);
      const alertAt = html.indexOf('role="alert"');
      expect(alertAt).toBeGreaterThan(-1);
      expect(html.indexOf(msg)).toBeGreaterThan(alertAt);
    });
  }

  it('still shows a size refusal in the Blocked panel, exactly once', () => {
    state.startError = refusal('PROVIDER_TOO_SMALL: 2 queued jobs', [{ kind: 'skill', provider_id: 3, count: 2 }]);
    const html = render();
    expect(html.split('PROVIDER_TOO_SMALL: 2 queued jobs').length - 1).toBe(1);
    expect(html).toContain('Remove 2 blocked job(s)');
  });

  it('prints nothing when Start was not refused', () => {
    expect(render()).not.toContain('Not started:');
  });
});
