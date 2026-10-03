import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  slotId, audioSlotRows, jobsBySlotFrom, missesSetFrom, applyFilters, filtersFromParams, paramsFromFilters,
  PAGE_SIZE, pageCount, clampPage, toggle, selectPage, deselectPage, isPageFullySelected,
  selectAllMatching, selectionOutsideFilter, queueItems, enqueueSummary, normalizeCause, failedByCause,
  soundText, MAX_JOB_ITEMS, chunkItems, queueInChunks, jobsForKnownSubjects, uploadOnlyCount,
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
