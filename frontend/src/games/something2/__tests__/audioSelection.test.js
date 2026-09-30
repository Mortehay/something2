import { describe, it, expect } from 'vitest';
import {
  slotId, audioSlotRows, jobsBySlotFrom, missesSetFrom, applyFilters, filtersFromParams, paramsFromFilters,
  PAGE_SIZE, pageCount, clampPage, toggle, selectPage, deselectPage, isPageFullySelected,
  selectAllMatching, selectionOutsideFilter, queueItems, enqueueSummary, normalizeCause, failedByCause,
  soundText,
} from '../audioSelection.js';

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
      .toEqual({ kind: 'creature', sound: 'failed', search: 'slime' });
    expect(filtersFromParams(new URLSearchParams('sound=bogus')))
      .toEqual({ kind: 'all', sound: 'missing', search: '' });
    expect(filtersFromParams(new URLSearchParams(''))).toEqual({ kind: 'all', sound: 'missing', search: '' });
  });

  it('writes filters back to the URL, omitting defaults, and round-trips', () => {
    expect(paramsFromFilters({ kind: 'all', sound: 'missing', search: '' }).toString()).toBe('');
    const p = paramsFromFilters({ kind: 'world', sound: 'all', search: 'a b' });
    expect(filtersFromParams(p)).toEqual({ kind: 'world', sound: 'all', search: 'a b' });
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

  it('leaves style off when none is chosen, and defaults engine to realistic', () => {
    const { items } = queueItems(new Set(['world/Ash/music', 'creature/Slime/hurt']), index, {});
    expect(items).toEqual([
      {
        subject_kind: 'creature', subject_key: 'Slime', slot: 'hurt', engine: 'realistic',
      },
      { subject_kind: 'world', subject_key: 'Ash', slot: 'music' },
    ]);
  });

  it('summarises the enqueue response', () => {
    const s = enqueueSummary({
      queued: [{}, {}], already_live: [{}], rejected: [{ error: 'x' }],
    }, 2);
    expect(s).toMatchObject({
      queued: 2, alreadyLive: 1, skipped: 3,
    });
    expect(s.message).toBe('Queued 2 — 1 already in flight — 3 skipped');
    expect(enqueueSummary({ queued: [] }, 0).message).toBe('Queued 0');
  });
});

describe('failed by cause', () => {
  it('normalizes the varying parts of an error', () => {
    expect(normalizeCause("unknown cue 'slash' for job 1234")).toBe('unknown cue … for job N');
    expect(normalizeCause('clip 1f0e3c9a-1111-4222-8333-444455556666 too long (9.5s)'))
      .toBe('clip … too long (Ns)');
    expect(normalizeCause('  box   said\n"busy" ')).toBe('box said …');
    expect(normalizeCause(null)).toBe('(no error text)');
  });

  it('groups failed jobs by cause, biggest first, with samples and ids', () => {
    const failing = [];
    for (let i = 0; i < 14; i += 1) {
      failing.push({
        id: String(100 + i), subject_kind: 'creature', subject_key: `c${i}`, slot: 'hurt', status: 'failed',
        error: `HTTP 500 from box after ${i}ms`,
      });
    }
    failing.push({
      id: '900', subject_kind: 'world', subject_key: 'Vale', slot: 'music', status: 'failed', error: "no style 'x'",
    });
    failing.push({
      id: '901', subject_kind: 'world', subject_key: 'Ash', slot: 'music', status: 'queued', error: null,
    });
    const groups = failedByCause(failing);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ cause: 'HTTP N from box after Nms', count: 14, more: 2 });
    expect(groups[0].text).toBe('HTTP 500 from box after 0ms');
    expect(groups[0].samples).toHaveLength(12);
    expect(groups[0].samples[0]).toBe('creature/c0/hurt');
    expect(groups[0].ids).toHaveLength(14);
    expect(groups[0].ids[13]).toBe('113');
    expect(groups[1]).toMatchObject({
      cause: 'no style …', count: 1, more: 0, ids: ['900'], samples: ['world/Vale/music'],
    });
    expect(failedByCause([])).toEqual([]);
  });
});
