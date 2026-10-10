import {
  describe, it, expect, vi, afterEach,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  slotId, audioSlotRows, jobsBySlotFrom, missesSetFrom, applyFilters, filtersFromParams, paramsFromFilters,
  PAGE_SIZE, pageCount, clampPage, toggle, selectPage, deselectPage, isPageFullySelected,
  selectAllMatching, selectionOutsideFilter, queueItems, enqueueSummary, normalizeCause, failedByCause,
  soundText, MAX_JOB_ITEMS, chunkItems, queueInChunks, jobsForKnownSubjects, uploadOnlyCount, slotEntriesFor,
  DEFAULT_SFX_VARIANTS, SEARCH_DEBOUNCE_MS, createSearchSync, singleFlight, MAX_SFX_VARIANTS, parseVariants,
} from '../audioSelection.js';

// AudioSlotTable.jsx with comments removed, for the wiring gates below: a
// gate that a comment can satisfy proves nothing (rework 2 found one).
const tableCode = () => readFileSync(fileURLToPath(new URL('../AudioSlotTable.jsx', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

// A registry response shaped like GET /api/audio/admin/subjects.
const subjects = [
  {
    kind: 'world',
    label: 'Worlds',
    slots: { music: 'music', ambience: 'ambience' },
    subjects: ['Vale', 'Ash'],
    filled: { Vale: 1 },
    filledSlots: { Vale: { music: 2 } },
  },
  {
    kind: 'creature',
    label: 'Creatures',
    slots: { nearby: 'sfx', hurt: 'sfx' },
    subjects: ['Slime'],
    filled: {},
    filledSlots: {},
    cues: { Slime: { nearby: null, hurt: 'hit' } },
  },
];
const uploadOnly = new Set(['creature/Slime/nearby']);
const jobs = jobsBySlotFrom([
  {
    id: '7', subject_kind: 'world', subject_key: 'Ash', slot: 'music', status: 'failed', error: 'box said 500',
  },
  {
    id: '8', subject_kind: 'creature', subject_key: 'Slime', slot: 'hurt', status: 'queued', error: null,
  },
]);
const misses = missesSetFrom([{ subject_kind: 'world', subject_key: 'Ash', slot: 'ambience' }]);
const rows = audioSlotRows(subjects, jobs, misses, uploadOnly);
const byId = (id) => rows.find((r) => r.id === id);
const ids = (list) => list.map((r) => r.id);

describe('audioSlotRows', () => {
  it('builds one row per (kind, key, slot) in registry order', () => {
    expect(ids(rows)).toEqual([
      'world/Vale/music', 'world/Vale/ambience', 'world/Ash/music', 'world/Ash/ambience',
      'creature/Slime/nearby', 'creature/Slime/hurt',
    ]);
  });

  it('carries the kind label, clip kind and per-slot clip count', () => {
    expect(byId('world/Vale/music')).toMatchObject({
      kind: 'world', kindLabel: 'Worlds', key: 'Vale', slot: 'music', clipKind: 'music', clips: 2,
    });
    expect(byId('world/Vale/ambience').clips).toBe(0);
    expect(byId('creature/Slime/hurt').clipKind).toBe('sfx');
  });

  it('marks upload-only and reported rows', () => {
    expect(byId('creature/Slime/nearby').uploadOnly).toBe(true);
    expect(byId('creature/Slime/hurt').uploadOnly).toBe(false);
    expect(byId('world/Ash/ambience').reported).toBe(true);
    expect(byId('world/Ash/music').reported).toBe(false);
  });

  it('joins the slot job, or null', () => {
    expect(byId('world/Ash/music').job).toEqual({ id: '7', status: 'failed', error: 'box said 500' });
    expect(byId('creature/Slime/hurt').job).toEqual({ id: '8', status: 'queued', error: null });
    expect(byId('world/Vale/music').job).toBeNull();
  });

  it('keys ids by kind too, and tolerates a missing response', () => {
    expect(slotId('world', 'a/b', 'music')).toBe('world/a/b/music');
    expect(audioSlotRows(undefined, undefined, undefined, undefined)).toEqual([]);
  });

  it('says what the Sound column shows', () => {
    expect(soundText(byId('world/Vale/music'))).toBe('2 clips');
    expect(soundText({ clips: 1, uploadOnly: false })).toBe('1 clip');
    expect(soundText(byId('world/Vale/ambience'))).toBe('missing');
    expect(soundText(byId('creature/Slime/nearby'))).toBe('upload only');
  });
});

describe('filters', () => {
  it('sound: missing / has / reported / failed / all', () => {
    expect(ids(applyFilters(rows, { sound: 'missing' }))).toEqual([
      'world/Vale/ambience', 'world/Ash/music', 'world/Ash/ambience', 'creature/Slime/nearby', 'creature/Slime/hurt',
    ]);
    expect(ids(applyFilters(rows, { sound: 'has' }))).toEqual(['world/Vale/music']);
    expect(ids(applyFilters(rows, { sound: 'reported' }))).toEqual(['world/Ash/ambience']);
    expect(ids(applyFilters(rows, { sound: 'failed' }))).toEqual(['world/Ash/music']);
    expect(applyFilters(rows, { sound: 'all' })).toHaveLength(6);
  });

  it('kind narrows to one kind', () => {
    expect(ids(applyFilters(rows, { kind: 'creature' }))).toEqual(['creature/Slime/nearby', 'creature/Slime/hurt']);
  });

  it('search is case-insensitive over key and slot, not kind', () => {
    expect(ids(applyFilters(rows, { search: 'ASH' }))).toEqual(['world/Ash/music', 'world/Ash/ambience']);
    expect(ids(applyFilters(rows, { search: ' Hurt ' }))).toEqual(['creature/Slime/hurt']);
    expect(applyFilters(rows, { search: 'worlds' })).toEqual([]);
  });

  it('filters combine', () => {
    expect(ids(applyFilters(rows, { kind: 'world', sound: 'missing', search: 'vale' }))).toEqual(['world/Vale/ambience']);
  });

  it('reads filters from the URL, dropping an unknown sound value', () => {
    expect(filtersFromParams(new URLSearchParams('kind=creature&sound=failed&q=slime')))
      .toEqual({
        kind: 'creature', sound: 'failed', search: 'slime', prompt: 'all',
      });
    expect(filtersFromParams(new URLSearchParams('sound=bogus')))
      .toEqual({
        kind: 'all', sound: 'missing', search: '', prompt: 'all',
      });
    expect(filtersFromParams(new URLSearchParams(''))).toEqual({
      kind: 'all', sound: 'missing', search: '', prompt: 'all',
    });
  });

  // SOMET-596 rework: `?kind=nope` showed "All kinds" in the select over a
  // table of 0 rows, and choosing "All kinds" fired no change event, so no
  // control on screen could leave that state.
  it('drops a kind the registry does not list, once the kinds are known', () => {
    const known = ['world', 'creature'];
    expect(filtersFromParams(new URLSearchParams('kind=nope&sound=all'), known))
      .toEqual({
        kind: 'all', sound: 'all', search: '', prompt: 'all',
      });
    expect(filtersFromParams(new URLSearchParams('kind=creature'), known).kind).toBe('creature');
    // Before the subjects load there is nothing to check against, so the
    // deep link is kept rather than thrown away on the first render.
    expect(filtersFromParams(new URLSearchParams('kind=creature'), []).kind).toBe('creature');
    expect(filtersFromParams(new URLSearchParams('kind=creature')).kind).toBe('creature');
  });

  it('writes filters back to the URL, omitting defaults, and round-trips', () => {
    expect(paramsFromFilters({
      kind: 'all', sound: 'missing', search: '', prompt: 'all',
    }).toString()).toBe('');
    const p = paramsFromFilters({
      kind: 'world', sound: 'all', search: 'a b', prompt: 'all',
    });
    expect(filtersFromParams(p)).toEqual({
      kind: 'world', sound: 'all', search: 'a b', prompt: 'all',
    });
  });
});

describe('paging', () => {
  it('is 100 a page, at least one page, and clamps', () => {
    expect(PAGE_SIZE).toBe(100);
    expect(pageCount(0)).toBe(1);
    expect(pageCount(100)).toBe(1);
    expect(pageCount(101)).toBe(2);
    expect(clampPage(7, 150)).toBe(2);
    expect(clampPage(0, 150)).toBe(1);
    expect(clampPage(3, 0)).toBe(1);
  });
});

describe('selection', () => {
  it('toggles one id', () => {
    const s = toggle(new Set(), 'world/Vale/music');
    expect([...s]).toEqual(['world/Vale/music']);
    expect(toggle(s, 'world/Vale/music').size).toBe(0);
  });

  it('select page skips upload-only rows and keeps what was already selected', () => {
    const creature = applyFilters(rows, { kind: 'creature' });
    const s = selectPage(new Set(['world/Vale/music']), creature);
    expect([...s].sort()).toEqual(['creature/Slime/hurt', 'world/Vale/music']);
    expect(isPageFullySelected(s, creature)).toBe(true);
    expect([...deselectPage(s, creature)]).toEqual(['world/Vale/music']);
  });

  it('a page with only upload-only rows is never "fully selected"', () => {
    const only = [byId('creature/Slime/nearby')];
    expect(isPageFullySelected(new Set(), only)).toBe(false);
  });

  it('select all matching selects every selectable matching row', () => {
    const s = selectAllMatching(applyFilters(rows, { sound: 'missing' }));
    expect([...s]).toEqual(['world/Vale/ambience', 'world/Ash/music', 'world/Ash/ambience', 'creature/Slime/hurt']);
  });

  it('counts the selection the current filter hides', () => {
    const s = new Set(['world/Vale/music', 'world/Ash/music', 'creature/Slime/hurt']);
    expect(selectionOutsideFilter(s, applyFilters(rows, { kind: 'world' }))).toBe(1);
    expect(selectionOutsideFilter(s, rows)).toBe(0);
  });
});

describe('queueItems', () => {
  const index = new Map(rows.map((r) => [r.id, r]));
  const selected = new Set(['world/Ash/music', 'creature/Slime/hurt', 'creature/Slime/nearby', 'world/Gone/music']);

  it('builds exactly the selected slots, with engine on sfx and style on music/ambience', () => {
    const { items, skipped } = queueItems(selected, index, { style: 'village', engine: 'retro' });
    expect(items).toEqual([
      {
        subject_kind: 'creature', subject_key: 'Slime', slot: 'hurt', engine: 'retro',
      },
      {
        subject_kind: 'world', subject_key: 'Ash', slot: 'music', style: 'village',
      },
    ]);
    // Upload-only and no-longer-existing ids are counted, never sent.
    expect(skipped).toBe(2);
  });

  // Plan 2026-10-03: the queue bar's "Force regenerate prompt" checkbox.
  it('puts force_prompt: true on every item when Force is ticked, music and sfx alike', () => {
    const { items } = queueItems(new Set(['world/Ash/music', 'creature/Slime/hurt']), index, { forcePrompt: true });
    expect(items).toEqual([
      {
        subject_kind: 'creature', subject_key: 'Slime', slot: 'hurt', engine: 'realistic', force_prompt: true,
      },
      { subject_kind: 'world', subject_key: 'Ash', slot: 'music', force_prompt: true },
    ]);
  });

  it('sends no force_prompt field when Force is unticked', () => {
    const { items } = queueItems(new Set(['world/Ash/music']), index, { forcePrompt: false });
    expect(items).toEqual([{ subject_kind: 'world', subject_key: 'Ash', slot: 'music' }]);
  });

  it('leaves style off when none is chosen, and defaults engine to realistic', () => {
    const { items } = queueItems(new Set(['world/Ash/music', 'creature/Slime/hurt']), index, {});
    expect(items).toEqual([
      {
        subject_kind: 'creature', subject_key: 'Slime', slot: 'hurt', engine: 'realistic',
      },
      { subject_kind: 'world', subject_key: 'Ash', slot: 'music' },
    ]);
  });

  // SOMET-596 rework: the queue bar's Variants control. The route accepts
  // `variants` (an integer 1-5) on sfx items only and rejects it on a
  // music/ambience item, so it must never be put on one.
  it('puts the chosen variants on sfx items only', () => {
    const { items } = queueItems(new Set(['world/Ash/music', 'creature/Slime/hurt']), index, { variants: 5 });
    expect(items).toEqual([
      {
        subject_kind: 'creature', subject_key: 'Slime', slot: 'hurt', engine: 'realistic', variants: 5,
      },
      { subject_kind: 'world', subject_key: 'Ash', slot: 'music' },
    ]);
  });

  it('sends no variants for a value the route would reject', () => {
    for (const bad of [0, 6, 2.5, NaN, '3', null]) {
      const { items } = queueItems(new Set(['creature/Slime/hurt']), index, { variants: bad });
      expect(items[0]).not.toHaveProperty('variants');
    }
  });

  it('defaults the bar to the server\'s own pack size', () => {
    const gen = readFileSync(fileURLToPath(new URL('../../../../../backend/src/services/audioGeneration.js', import.meta.url)), 'utf8');
    const m = /const DEFAULT_SFX_VARIANTS = (\d+);/.exec(gen);
    expect(m).not.toBeNull();
    expect(DEFAULT_SFX_VARIANTS).toBe(Number(m[1]));
  });

  it('summarises the enqueue responses of every chunk', () => {
    const s = enqueueSummary([
      { queued: [{}, {}], already_live: [{}], rejected: [{ error: 'x' }] },
      { queued: [{}], already_live: [], rejected: [] },
    ], 2);
    expect(s).toMatchObject({ queued: 3, alreadyLive: 1, skipped: 3 });
    expect(s.message).toBe('Queued 3 — 1 already in flight — 3 skipped');
    expect(enqueueSummary([{ queued: [] }], 0).message).toBe('Queued 0');
    expect(enqueueSummary([], 0, new Error('boom')).message)
      .toBe('Stopped after an error: boom. Queued 0 before it; the rest stay selected.');
  });
});

describe('queueing in chunks', () => {
  const make = (n) => Array.from({ length: n }, (_, i) => ({ subject_kind: 'creature', subject_key: `c${i}`, slot: 'hurt' }));

  it('uses the route\'s own cap', () => {
    const route = readFileSync(fileURLToPath(new URL('../../../../../backend/src/api/audioRoutes.js', import.meta.url)), 'utf8');
    const m = /const MAX_JOB_ITEMS = (\d+);/.exec(route);
    expect(m).not.toBeNull();
    expect(MAX_JOB_ITEMS).toBe(Number(m[1]));
  });

  it('splits 1697 items into 500, 500, 500, 197 and exactly 500 into one chunk', () => {
    expect(chunkItems(make(1697)).map((c) => c.length)).toEqual([500, 500, 500, 197]);
    expect(chunkItems(make(500)).map((c) => c.length)).toEqual([500]);
    expect(chunkItems([])).toEqual([]);
    const all = chunkItems(make(1697)).flat();
    expect(all.map((it) => it.subject_key)).toEqual(make(1697).map((it) => it.subject_key));
  });

  it('sends the chunks in order and sums what the server queued', async () => {
    const sent = [];
    // Answers from its input: every item it was sent is queued.
    const send = async (chunk) => { sent.push(chunk.length); return { queued: chunk.map(() => ({})) }; };
    const out = await queueInChunks(make(1697), send);
    expect(sent).toEqual([500, 500, 500, 197]);
    expect(out.error).toBeNull();
    expect(out.unsent).toEqual([]);
    expect(enqueueSummary(out.results).queued).toBe(1697);
  });

  it('stops at the first failing chunk and returns what was not sent', async () => {
    let calls = 0;
    const send = async (chunk) => {
      calls += 1;
      if (calls === 2) throw new Error('HTTP 502');
      return { queued: chunk.map(() => ({})) };
    };
    const items = make(1697);
    const out = await queueInChunks(items, send);
    expect(calls).toBe(2);
    expect(out.error.message).toBe('HTTP 502');
    expect(enqueueSummary(out.results, 0, out.error).message)
      .toBe('Stopped after an error: HTTP 502. Queued 500 before it; the rest stay selected.');
    expect(out.unsent.map((it) => it.subject_key)).toEqual(items.slice(500).map((it) => it.subject_key));
  });
});

describe('failed by cause', () => {
  it('keeps HTTP status codes apart: a 404 and a 503 are different causes', () => {
    const a = normalizeCause('audio service answered 404 for POST /api/audio/sfx');
    const b = normalizeCause('audio service answered 503 for POST /api/audio/sfx');
    expect(a).toBe('audio service answered 404 for POST /api/audio/sfx');
    expect(a).not.toBe(b);
  });

  it('keeps different JSON details and ordinary prose apart', () => {
    expect(normalizeCause('{"detail": "CUDA out of memory"}')).not.toBe(normalizeCause('{"detail": "unknown cue"}'));
    expect(normalizeCause("can't reach the box, it isn't up")).toBe("can't reach the box, it isn't up");
  });

  it('blanks ids, uuids, hashes, paths, long numbers and quoted subject names', () => {
    expect(normalizeCause("unknown cue 'slash' for job 1234")).toBe('unknown cue … for job N');
    expect(normalizeCause("unknown subject 'Bat'")).toBe(normalizeCause("unknown subject 'Blight Apex'"));
    expect(normalizeCause('clip 1f0e3c9a-1111-4222-8333-444455556666 too long')).toBe('clip … too long');
    expect(normalizeCause('failed to store audio/sfx/1f0e3c9a-1111-4222-8333-444455556666.ogg (key 99887766)'))
      .toBe('failed to store … (key N)');
    expect(normalizeCause('blob deadbeef12 missing')).toBe('blob … missing');
    expect(normalizeCause('row #12 locked')).toBe('row #N locked');
    expect(normalizeCause('  box   said\n  busy ')).toBe('box said busy');
    expect(normalizeCause(null)).toBe('(no error text)');
  });

  it('groups failed jobs by cause, biggest first, with samples and ids', () => {
    const failing = [];
    for (let i = 0; i < 14; i += 1) {
      failing.push({
        id: String(100 + i), subject_kind: 'creature', subject_key: `c${i}`, slot: 'hurt', status: 'failed',
        error: `audio service answered 503 for POST /api/audio/sfx (job ${5000 + i})`,
      });
    }
    failing.push({
      id: '900', subject_kind: 'world', subject_key: 'Vale', slot: 'music', status: 'failed',
      error: 'audio service answered 404 for POST /api/audio/sfx (job 7777)',
    });
    failing.push({
      id: '901', subject_kind: 'world', subject_key: 'Ash', slot: 'music', status: 'queued', error: null,
    });
    const groups = failedByCause(failing);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      cause: 'audio service answered 503 for POST /api/audio/sfx (job N)', count: 14, more: 2,
    });
    expect(groups[0].text).toBe('audio service answered 503 for POST /api/audio/sfx (job 5000)');
    expect(groups[0].samples).toHaveLength(12);
    expect(groups[0].samples[0]).toBe('creature/c0/hurt');
    expect(groups[0].ids).toHaveLength(14);
    expect(groups[0].ids[13]).toBe('113');
    expect(groups[1]).toMatchObject({
      cause: 'audio service answered 404 for POST /api/audio/sfx (job N)', count: 1, more: 0, ids: ['900'], samples: ['world/Vale/music'],
    });
    expect(failedByCause([])).toEqual([]);
  });
});

describe('failed by cause: ordering', () => {
  const job = (id, error) => ({
    id: String(id), subject_kind: 'creature', subject_key: `c${id}`, slot: 'hurt', status: 'failed', error,
  });

  // SOMET-596 rework: the fixture above lists its biggest group first, so
  // the sort was untested -- removing it left the suite green.
  it('puts the biggest group first even when it appears last', () => {
    const groups = failedByCause([
      job(1, 'small cause'),
      job(2, 'big cause'), job(3, 'big cause'), job(4, 'big cause'),
      job(5, 'middle cause'), job(6, 'middle cause'),
    ]);
    expect(groups.map((g) => [g.cause, g.count])).toEqual([
      ['big cause', 3], ['middle cause', 2], ['small cause', 1],
    ]);
  });

  it('breaks a tie by cause text, so the order is stable across polls', () => {
    const groups = failedByCause([job(1, 'zeta'), job(2, 'alpha'), job(3, 'mu')]);
    expect(groups.map((g) => g.cause)).toEqual(['alpha', 'mu', 'zeta']);
  });
});

describe('search box: debounced URL sync', () => {
  // SOMET-596 rework: the Search input was bound straight to `?q=`, and a
  // URL commit takes 30-300 ms (every row is re-filtered), so the next key
  // was applied to the OLD value and typed characters were lost ("Titan" ->
  // "n"). The input now shows local text; the URL follows after a pause.
  afterEach(() => { vi.useRealTimers(); });
  const harness = () => {
    vi.useFakeTimers();
    const commits = [];
    const sync = createSearchSync((v) => commits.push(v));
    return { sync, commits };
  };

  it('commits the whole word once, after the pause, when typed faster than the URL commits', () => {
    const { sync, commits } = harness();
    let shown = '';
    for (const ch of 'Titan') {
      shown += ch;
      sync.type(shown);
      // The URL has not caught up, as in the browser: it still says ''.
      expect(sync.fromUrl('')).toBeNull();
      vi.advanceTimersByTime(60);
    }
    expect(commits).toEqual([]);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    expect(commits).toEqual(['Titan']);
  });

  it('keeps the typed text while a commit is still landing, then follows the URL again', () => {
    const { sync, commits } = harness();
    sync.type('Tit');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    expect(commits).toEqual(['Tit']);
    sync.type('Titan');
    // The 'Tit' commit lands while 'Titan' is pending: the box keeps 'Titan'.
    expect(sync.fromUrl('Tit')).toBeNull();
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    expect(commits).toEqual(['Tit', 'Titan']);
    // The URL reaches the last commit, then a later URL change
    // (back/forward, a shared link) wins.
    expect(sync.fromUrl('Titan')).toBe('Titan');
    expect(sync.fromUrl('Vale')).toBe('Vale');
  });

  it('ignores a stale URL value that lands after a later commit fired (rework 2)', () => {
    const { sync, commits } = harness();
    sync.type('Titan Br');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    expect(sync.fromUrl('Titan Br')).toBe('Titan Br');
    sync.type('Titan Bru');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    expect(commits).toEqual(['Titan Br', 'Titan Bru']);
    // Nothing is pending, but the URL has not reached 'Titan Bru' yet: a
    // late render of the earlier value (or the pre-typing '') must not
    // revert the box.
    expect(sync.fromUrl('Titan Br')).toBeNull();
    expect(sync.fromUrl('')).toBeNull();
    expect(sync.fromUrl('Titan Bru')).toBe('Titan Bru');
    // The URL caught up: a later change (back/forward) wins again.
    expect(sync.fromUrl('Titan Br')).toBe('Titan Br');
  });

  it('keeps typed text when the awaited URL lands while a newer commit is due', () => {
    const { sync } = harness();
    sync.type('Ti');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    sync.type('Tit');
    expect(sync.fromUrl('Ti')).toBeNull();
  });

  it('a commit of the value the URL already holds does not block a later URL change', () => {
    vi.useFakeTimers();
    const sync = createSearchSync(() => {}, SEARCH_DEBOUNCE_MS, 'Vale');
    sync.type('Val');
    sync.type('Vale');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    // setSearchParams with the same q changes nothing, so no URL value
    // 'Vale' arrives; back/forward to 'Ash' must still reach the box.
    expect(sync.fromUrl('Ash')).toBe('Ash');
  });

  it('the table copies ?q= into the box through fromUrl, and seeds it with the URL value', () => {
    const src = tableCode();
    expect(src).toMatch(/useEffect\(\(\) => \{\s*const v = searchSync\.fromUrl\(search\);\s*if \(v !== null\) setSearchText\(v\);\s*\}, \[search, searchSync\]\)/);
    expect(src).toMatch(/useState\(\(\) => createSearchSync\([\s\S]*?,\s*search,?\s*\)\)/);
  });

  it('cancel drops a pending commit (unmount)', () => {
    const { sync, commits } = harness();
    sync.type('Ti');
    sync.cancel();
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
    expect(commits).toEqual([]);
    expect(sync.fromUrl('x')).toBe('x');
  });

  it('the table binds its Search input to the local text, not to the URL param', () => {
    const src = tableCode();
    const input = /Search\s*<input([\s\S]*?)\/>/.exec(src);
    expect(input).not.toBeNull();
    expect(input[1]).not.toMatch(/value=\{search\}/);
    expect(input[1]).not.toMatch(/setFilter\(/);
    expect(input[1]).toMatch(/value=\{searchText\}/);
  });
});

describe('singleFlight (Retry these N)', () => {
  // SOMET-596 rework: a fast double-click sent two POSTs 2 ms apart, because
  // disabled={retry.isPending} lands a render too late.
  it('ignores a second call while the first is in flight, and allows one after it settles', async () => {
    let release;
    const fn = vi.fn(() => new Promise((r) => { release = r; }));
    const once = singleFlight(fn);
    const first = once('a');
    expect(once('b')).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
    release('done');
    await expect(first).resolves.toBe('done');
    once('c');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('releases after a failure too', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('ok');
    const once = singleFlight(fn);
    await expect(once()).rejects.toThrow('boom');
    await expect(once()).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('the table routes Retry these N through it', () => {
    const src = tableCode();
    expect(src).not.toMatch(/retry\.mutate\(/);
    expect(src).toMatch(/const \[retryOnce\] = useState\(\(\) => singleFlight\(/);
    expect(src).toMatch(/onClick=\{\(\) => retryOnce\(g\.ids\)\}/);
  });
});

describe('jobs for subjects that still exist', () => {
  it('drops job rows whose kind, key or slot is not in the registry', () => {
    const jobRows = [
      { id: '1', subject_kind: 'world', subject_key: 'Vale', slot: 'music', status: 'failed', error: 'x' },
      { id: '2', subject_kind: 'world', subject_key: 'Deleted', slot: 'music', status: 'failed', error: 'x' },
      { id: '3', subject_kind: 'world', subject_key: 'Vale', slot: 'gone', status: 'failed', error: 'x' },
      { id: '4', subject_kind: 'nokind', subject_key: 'Vale', slot: 'music', status: 'failed', error: 'x' },
    ];
    const kept = jobsForKnownSubjects(jobRows, subjects);
    expect(kept.map((j) => j.id)).toEqual(['1']);
    expect(failedByCause(kept)[0].count).toBe(1);
  });
});

describe('uploadOnlyCount', () => {
  it('counts the upload-only rows a filter matched', () => {
    expect(uploadOnlyCount(applyFilters(rows, { sound: 'missing' }))).toBe(1);
    expect(uploadOnlyCount(applyFilters(rows, { kind: 'world' }))).toBe(0);
  });
});

describe('per-subject slots (SOMET-605)', () => {
  const creatureGroup = {
    kind: 'creature', label: 'Creatures',
    slots: { nearby: 'sfx', attack: 'sfx', hurt: 'sfx', death: 'sfx', spawn: 'sfx', presence: 'sfx', phase: 'sfx', enrage: 'sfx' },
    subjects: ['Ignis', 'Slime'],
    subjectSlots: {
      Ignis: ['nearby', 'attack', 'hurt', 'death', 'spawn', 'presence', 'phase', 'enrage'],
      Slime: ['nearby', 'attack', 'hurt', 'death'],
    },
  };

  it('a boss row lists 8 slot rows, an ordinary creature 4', () => {
    const rows = audioSlotRows([creatureGroup]);
    expect(rows.filter((r) => r.key === 'Ignis').map((r) => r.slot)).toEqual(['nearby', 'attack', 'hurt', 'death', 'spawn', 'presence', 'phase', 'enrage']);
    expect(rows.filter((r) => r.key === 'Slime').map((r) => r.slot)).toEqual(['nearby', 'attack', 'hurt', 'death']);
  });

  it('a group without subjectSlots still lists every slot for every subject', () => {
    const rows = audioSlotRows([{ kind: 'world', slots: { music: 'music', ambience: 'ambience' }, subjects: ['Vale'] }]);
    expect(rows.map((r) => r.slot)).toEqual(['music', 'ambience']);
  });

  it('audioSlotRows: a key absent from subjectSlots yields zero rows', () => {
    const g = { ...creatureGroup, subjects: ['Ignis', 'Ghost'] };
    expect(audioSlotRows([g]).filter((r) => r.key === 'Ghost')).toEqual([]);
  });

  it('slotEntriesFor: a subject absent from subjectSlots gets nothing', () => {
    expect(slotEntriesFor(creatureGroup, 'Ghost')).toEqual([]);
  });

  it('a job for an ordinary creature boss slot is not a known subject (no retry offered)', () => {
    const jobs = [
      { id: 1, subject_kind: 'creature', subject_key: 'Slime', slot: 'presence', status: 'failed' },
      { id: 2, subject_kind: 'creature', subject_key: 'Ignis', slot: 'presence', status: 'failed' },
    ];
    expect(jobsForKnownSubjects(jobs, [creatureGroup]).map((j) => j.id)).toEqual([2]);
  });
});

describe('table wiring (rework 2 gates)', () => {
  it('Queue passes the Variants value into queueItems', () => {
    const src = tableCode();
    const call = /queueItems\(\s*selected,\s*rowsById,\s*\{([\s\S]*?)\}\s*\)/.exec(src);
    expect(call).not.toBeNull();
    expect(call[1]).toMatch(/\bvariants\s*:\s*variantsNow\b/);
    expect(src).toMatch(/const variantsNow = parseVariants\(variantsText\)/);
  });

  it('every filtersFromParams call passes the registry kinds', () => {
    const src = tableCode();
    const calls = [...src.matchAll(/filtersFromParams\(([^()]*)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const args of calls) expect(args).toMatch(/,\s*kindKeys\s*$/);
  });

  it('the Variants input shows its raw text and only restores it on blur', () => {
    const src = tableCode();
    const input = /Variants \(sfx\)\s*<input([\s\S]*?)\/>/.exec(src);
    expect(input).not.toBeNull();
    expect(input[1]).toMatch(/value=\{variantsText\}/);
    expect(input[1]).toMatch(/setVariantsText\(e\.target\.value\)/);
    expect(input[1]).toMatch(/onBlur=\{\(\) => setVariantsText\(String\(variants\)\)\}/);
  });
});

describe('parseVariants', () => {
  it('accepts 1..MAX and rejects the rest, including the empty text mid-edit', () => {
    expect(parseVariants('1')).toBe(1);
    expect(parseVariants(' 4 ')).toBe(4);
    expect(parseVariants(String(MAX_SFX_VARIANTS))).toBe(MAX_SFX_VARIANTS);
    for (const bad of ['', '0', '6', '35', '2.5', '-1', 'x', '1e0', null, undefined]) {
      expect(parseVariants(bad)).toBeNull();
    }
  });
});
