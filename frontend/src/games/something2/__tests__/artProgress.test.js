import { describe, it, expect } from 'vitest';
import {
  batchProgress, formatDuration, formatElapsed, elapsedSince, shouldPollQueue,
  partitionInFlight, claimedAgo, previewNames, blockedSummary, singleFlight, blockedPanel,
  IDLE, IDLE_QUEUED, RUNNING, FINISHED,
} from '../artProgress.js';

const ago = (ms) => new Date(Date.now() - ms).toISOString();

describe('the four phases', () => {
  // THE BUG THAT PROMPTED THIS. 530 rows queued, nothing draining them, and a
  // page that said only "queue: 530 queued, 0 running" -- which reads as
  // "working" to anyone who has just pressed a button. The phase is what lets
  // the console print the missing sentence.
  it('separates a queue nobody is draining from one that is being drained', () => {
    const idle = batchProgress(null, { queued: 530, running: 0 });
    expect(idle.phase).toBe(IDLE_QUEUED);
    expect(idle.remaining).toBe(530);

    const live = batchProgress(
      { running: true, done: 0, failed: 0, started_at: ago(1000) },
      { queued: 530, running: 1 },
    );
    expect(live.phase).toBe(RUNNING);
  });

  it('reports idle when there is nothing queued and nothing has ever run', () => {
    expect(batchProgress(null, { queued: 0, running: 0 }).phase).toBe(IDLE);
    expect(batchProgress({ running: false }, {}).phase).toBe(IDLE);
  });

  it('reports finished once a drain has resolved everything', () => {
    const p = batchProgress({ running: false, done: 97, failed: 5 }, { queued: 0, running: 0 });
    expect(p.phase).toBe(FINISHED);
    expect(p.pct).toBe(100);
  });
});

describe('the percentage', () => {
  // THE LIE THIS EXISTS TO PREVENT, and the reason an idle queue gets no bar.
  //
  // runStatus() keeps the LAST run after it ends, so a selection queued days
  // later would be divided against that run's completions. 530 fresh jobs
  // against 97 done last week is 15%, displayed before a single image of this
  // batch has been drawn.
  it('is withheld while idle, rather than crediting the previous run', () => {
    const stale = { running: false, done: 97, failed: 0, started_at: ago(86400000) };
    const p = batchProgress(stale, { queued: 530, running: 0 });
    expect(p.phase).toBe(IDLE_QUEUED);
    expect(p.pct).toBeNull();
    expect(p.completed).toBe(0);
  });

  it('divides this run\'s completions by everything the run must still resolve', () => {
    const p = batchProgress(
      { running: true, done: 140, failed: 2, started_at: ago(600000) },
      { queued: 388, running: 1 },
    );
    expect(p.completed).toBe(142);   // done AND failed
    expect(p.total).toBe(531);
    expect(p.pct).toBe(27);
  });

  // A batch that loses subjects to the attempt cap must still reach 100%, or
  // the admin watches a stalled bar waiting for work that will never be done.
  it('reaches 100% when every remaining subject failed rather than succeeded', () => {
    const p = batchProgress(
      { running: true, done: 10, failed: 5, started_at: ago(60000) },
      { queued: 0, running: 0 },
    );
    expect(p.pct).toBe(100);
  });

  it('does not divide by zero before the first claim', () => {
    const p = batchProgress({ running: true, done: 0, failed: 0, started_at: ago(10) }, {});
    expect(p.pct).toBe(0);
    expect(Number.isFinite(p.pct)).toBe(true);
  });
});

describe('the ETA', () => {
  // The first completion carries model load. Extrapolating 530 images from it
  // overstates the batch by hours, and an estimate that swings from 9h to 2h
  // in the first minute is one the admin learns to ignore.
  it('is withheld until enough completions to be worth printing', () => {
    const two = batchProgress(
      { running: true, done: 2, failed: 0, started_at: ago(60000) },
      { queued: 100, running: 0 },
    );
    expect(two.etaMs).toBeNull();

    const three = batchProgress(
      { running: true, done: 3, failed: 0, started_at: ago(60000) },
      { queued: 100, running: 0 },
    );
    expect(three.etaMs).not.toBeNull();
  });

  // 3 images in 60s is 20s each; 100 left is ~2000s. Asserted against the
  // arithmetic, not against a constant copied out of the implementation.
  it('extrapolates from the measured rate of this run', () => {
    const p = batchProgress(
      { running: true, done: 3, failed: 0, started_at: ago(60000) },
      { queued: 100, running: 0 },
    );
    expect(p.etaMs / 1000).toBeGreaterThan(1900);
    expect(p.etaMs / 1000).toBeLessThan(2100);
  });

  it('is withheld when the run carries no usable start time', () => {
    const p = batchProgress(
      { running: true, done: 30, failed: 0, started_at: null },
      { queued: 100, running: 0 },
    );
    expect(p.etaMs).toBeNull();
  });
});

describe('formatting', () => {
  it('coarsens with scale rather than claiming false precision', () => {
    expect(formatDuration(45000)).toBe('45s');
    expect(formatDuration(600000)).toBe('10m');
    expect(formatDuration(8100000)).toBe('2h 15m');
  });

  it('returns null for a non-duration, so a caller omits the field', () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(NaN)).toBeNull();
  });
});

describe('the elapsed counter', () => {
  // CAUGHT IN THE BROWSER, not by the suite. The line first reused
  // formatDuration, which coarsens with scale -- so a generation past 60s
  // printed "1m" and stayed there for a full minute. A liveness counter that
  // does not move is indistinguishable from a hung page, which is the exact
  // impression this panel exists to remove.
  it('always moves, because the seconds field is the liveness signal', () => {
    expect(formatElapsed(61)).not.toBe(formatElapsed(62));
    expect(formatElapsed(200)).not.toBe(formatElapsed(201));
    expect(formatElapsed(3700)).not.toBe(formatElapsed(3701));
    // The contrast with the ETA's formatter, which is coarse ON PURPOSE.
    expect(formatDuration(61000)).toBe(formatDuration(62000));
  });

  it('reads as a stopwatch', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(47)).toBe('47s');
    expect(formatElapsed(67)).toBe('1m 07s');
    expect(formatElapsed(3667)).toBe('1h 01m 07s');
  });

  // Zero-padded so the text keeps its width and does not jitter the layout
  // beside it once a second. Asserted across the whole ten-second boundary,
  // where an unpadded seconds field would shrink from "1m 10s" to "1m 9s".
  it('holds a steady width across the boundary that would shrink it', () => {
    const widths = new Set();
    for (let s = 60; s < 120; s++) widths.add(formatElapsed(s).length);
    expect([...widths]).toEqual([6]);
  });

  it('returns null for a non-duration', () => {
    expect(formatElapsed(null)).toBeNull();
    expect(formatElapsed(-1)).toBeNull();
  });
});

describe('elapsedSince', () => {
  it('counts seconds since the claim', () => {
    expect(elapsedSince(ago(18000))).toBeGreaterThanOrEqual(17);
    expect(elapsedSince(ago(18000))).toBeLessThanOrEqual(19);
  });

  // null, not 0: a zero would assert the generation began this instant, which
  // is a claim we cannot make about a timestamp we could not read.
  it('returns null for a timestamp it cannot parse', () => {
    expect(elapsedSince(undefined)).toBeNull();
    expect(elapsedSince('not a date')).toBeNull();
  });
});

describe('polling', () => {
  // The original condition. It made the one state worth watching -- a full
  // queue with nothing pulling it -- the one state that never refreshed.
  it('polls a standing queue even though no drain is running', () => {
    expect(shouldPollQueue(null, { queued: 530, running: 0 })).toBe(true);
    expect(shouldPollQueue({ running: false }, { queued: 0, running: 2 })).toBe(true);
  });

  it('stops polling once nothing is outstanding', () => {
    expect(shouldPollQueue({ running: false, done: 97 }, { queued: 0, running: 0 })).toBe(false);
    expect(shouldPollQueue(null, null)).toBe(false);
  });
});

describe('claimed vs drawing', () => {
  // THE DEFECT THIS FIXES, seen live: ten rows in state='running' listed as
  // ten simultaneous generations. dispatch() claims `limit` (10) jobs in ONE
  // update and feeds them to `concurrency` (1) workers, so ten are claimed and
  // exactly one is on the provider. The panel read as a batch fired off all at
  // once rather than chained, which is not what the dispatcher does.
  const claimedAt = '2026-09-10T09:25:45.961Z';
  const rows = [244, 235, 240, 238].map((id) => ({
    id, subject_kind: 'item', subject_key: `k${id}`, attempts: 1, claimed_at: claimedAt,
  }));

  it('treats only `concurrency` of the claimed jobs as drawing', () => {
    const p = partitionInFlight(rows, 1);
    expect(p.drawing).toHaveLength(1);
    expect(p.waiting).toHaveLength(3);
  });

  // ORDERED BY id, and this is the whole reason the helper exists rather than
  // a slice at the call site. One UPDATE stamps every claimed row with the
  // IDENTICAL claimed_at, so the server's `ORDER BY claimed_at` is a tie across
  // the batch and may return any of them first. claim() orders by id and the
  // worker cursor walks that array in order, so the lowest id still running is
  // the one actually on the provider.
  it('names the lowest id, because ties on claimed_at cannot order them', () => {
    expect(new Set(rows.map((r) => r.claimed_at)).size).toBe(1);   // the tie is real
    expect(partitionInFlight(rows, 1).drawing[0].id).toBe(235);
    // Input order must not matter: the same set reversed gives the same answer.
    expect(partitionInFlight([...rows].reverse(), 1).drawing[0].id).toBe(235);
  });

  it('follows a higher concurrency when the drain reports one', () => {
    const p = partitionInFlight(rows, 3);
    expect(p.drawing.map((r) => r.id)).toEqual([235, 238, 240]);
    expect(p.waiting.map((r) => r.id)).toEqual([244]);
  });

  it('never reports zero drawing while rows are claimed', () => {
    expect(partitionInFlight(rows, 0).drawing).toHaveLength(1);
    expect(partitionInFlight([], 1).drawing).toHaveLength(0);
    expect(partitionInFlight(null, 1).waiting).toHaveLength(0);
  });

  // "claimed Xs ago", not "drawing for Xs": for every job after the first,
  // claimed_at precedes the provider reaching it by however long the ones
  // ahead took, so "drawing for" would add the queue-ahead time to it.
  it('phrases the elapsed time as time since the claim, and keeps it moving', () => {
    const t = Date.parse(claimedAt);
    expect(claimedAgo(claimedAt, t + 47000)).toBe('47s');
    expect(claimedAgo(claimedAt, t + 67000)).toBe('1m 07s');
    expect(claimedAgo(claimedAt, t + 68000)).not.toBe(claimedAgo(claimedAt, t + 67000));
    expect(claimedAgo('nonsense')).toBeNull();
  });
});


// The queued list. "17 queued" says a batch exists and nothing about whether
// it holds the rows the admin meant -- a mis-set filter queues the wrong
// subjects and prints the same sentence.
describe('naming the subjects that are waiting', () => {
  const job = (n) => ({ id: n, subject_kind: 'item', subject_key: `obsidian-${n}` });
  const rows = [1, 2, 3].map(job);

  it('names them as kind/key, in the order they arrived', () => {
    const { names, more } = previewNames(rows, 3);
    expect(names).toEqual(['item/obsidian-1', 'item/obsidian-2', 'item/obsidian-3']);
    expect(more).toBe(0);
  });

  // THE TRAP THIS GUARDS. The rows are a SERVER-SIDE PREVIEW of a longer
  // queue, so counting what arrived would print "12 queued" over a backlog of
  // 512 -- a confident wrong number, which is the failure the whole panel
  // exists to remove. The total is the server's count over the whole queue.
  it('reports the real backlog, not the size of the preview it was given', () => {
    const { names, more } = previewNames(rows, 512, 2);
    expect(names).toHaveLength(2);
    expect(more).toBe(510);
  });

  // A job claimed between the server's two reads leaves the total one behind
  // the rows. "+-1 more" would be worse than saying nothing.
  it('never reports a negative remainder when the total lags the rows', () => {
    expect(previewNames(rows, 1).more).toBe(0);
    expect(previewNames(rows, null).more).toBe(0);
  });

  it('survives an absent queue', () => {
    expect(previewNames(undefined, 0)).toEqual({ names: [], more: 0 });
    expect(previewNames(null, 5).names).toEqual([]);
  });
});

describe('blockedSummary', () => {
  const blocked = [
    { kind: 'item', provider_id: 4, provider_name: 'desktop gpu', width: 512, height: 512, count: 279 },
    { kind: 'skill', provider_id: null, provider_name: null, width: 512, height: null, count: 3 },
  ];

  it('totals the rows and names each group with its size', () => {
    const s = blockedSummary(blocked);
    expect(s.total).toBe(282);
    expect(s.lines).toEqual([
      '279 queued item on "desktop gpu" (512×512)',
      '3 queued skill on provider (batch) (512×?)',
    ]);
  });

  // The clear body must carry the NULL through: an unpinned group is matched
  // with IS NOT DISTINCT FROM, and dropping the key would be a 400.
  it('builds the clear body from the same list, keeping null provider ids', () => {
    expect(blockedSummary(blocked).groups).toEqual([
      { kind: 'item', provider_id: 4 }, { kind: 'skill', provider_id: null },
    ]);
  });

  it('is empty for a refusal without groups', () => {
    expect(blockedSummary(undefined)).toEqual({ total: 0, lines: [], groups: [] });
  });
});

// SOMET-593 D4. A rapid double-click on "Remove N blocked job(s) & start" sent
// two /clear requests 3ms apart: the mutation's isPending is not true yet when
// the second click lands, so the button's disabled prop cannot stop it.
describe('singleFlight', () => {
  it('admits one caller until the first one ends', () => {
    const flight = singleFlight();
    expect(flight.tryBegin()).toBe(true);
    expect(flight.tryBegin()).toBe(false);
    flight.end();
    expect(flight.tryBegin()).toBe(true);
  });

  it('is what the Remove-blocked handler gates on, released when the request settles', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, '../ArtConsoleAdmin.jsx'), 'utf8');
    const handler = src.slice(src.indexOf('const onDropBlocked'), src.indexOf('const onEnqueue'));
    expect(handler).toMatch(/if \(!dropFlight\.tryBegin\(\)\) return;/);
    expect(handler).toMatch(/onSettled: \(\) => dropFlight\.end\(\)/);
    // A cancelled confirm must release the gate, or the button is dead.
    expect(handler).toMatch(/\{\s*dropFlight\.end\(\);\s*return;\s*\}/);
  });
});

// SOMET-594 rework. The Remove panel has two sources and they must not share an
// action: a /dispatch REFUSAL means "drop these, then start what I asked for";
// a drain's run.blocked means "drop these" and nothing else -- the admin may
// have just pressed Stop, and the old label read "& start" whenever the run was
// not running, restarting the batch they stopped.
describe('blockedPanel', () => {
  const group = { kind: 'item', provider_id: 4, provider_name: 'desktop gpu', count: 2 };

  it('never starts a batch for a stopped drain\'s run.blocked', () => {
    const p = blockedPanel({ run: { running: false, blocked: [group] }, startError: null });
    expect(p.show).toBe(true);
    expect(p.fromRun).toBe(true);
    expect(p.startAfter).toBe(false);
    expect(p.label).toBe('Remove 2 blocked job(s)');
    expect(p.dismissable).toBe(false);
  });

  it('does not start for run.blocked while running either', () => {
    const p = blockedPanel({ run: { running: true, blocked: [group] }, startError: null });
    expect(p.startAfter).toBe(false);
    expect(p.label).toBe('Remove 2 blocked job(s)');
  });

  it('keeps "& start" for a Start refusal -- starting is what was asked for', () => {
    const p = blockedPanel({ run: { running: false, blocked: [] }, startError: { blocked: [group] } });
    expect(p.show).toBe(true);
    expect(p.fromRun).toBe(false);
    expect(p.startAfter).toBe(true);
    expect(p.label).toBe('Remove 2 blocked job(s) & start');
    expect(p.dismissable).toBe(true);
  });

  it('prefers the live run.blocked over a stale Start refusal', () => {
    const p = blockedPanel({
      run: { running: false, blocked: [{ ...group, count: 1 }] },
      startError: { blocked: [group] },
    });
    expect(p.fromRun).toBe(true);
    expect(p.startAfter).toBe(false);
    expect(p.total).toBe(1);
  });

  // The browser pass caught "the rest of the batch was drawn" after a manual
  // Stop with 0 done and 12 skills still queued. The sentence now reads the
  // live queue; blocked rows are queued rows, so they are subtracted.
  it('a stopped drain with other jobs queued says so, not "was drawn"', () => {
    const p = blockedPanel({
      run: { running: false, done: 0, blocked: [group] },
      startError: null,
      stats: { queued: 14, running: 0 },
    });
    expect(p.message).toBe('Skipped 2 queued job(s) that would render below 1024px -- '
      + 'the batch stopped; 12 other job(s) are still queued. '
      + 'Remove them, or re-queue those subjects on a 1024 provider.');
    expect(p.message).not.toMatch(/was drawn/);
  });

  it('a stopped drain with only the blocked jobs left says nothing else is queued', () => {
    const p = blockedPanel({
      run: { running: false, done: 12, blocked: [group] },
      startError: null,
      stats: { queued: 2, running: 0 },
    });
    expect(p.message).toMatch(/-- nothing else is queued\. /);
  });

  it('a running drain says the rest is drawing; a refusal carries no message', () => {
    const p = blockedPanel({
      run: { running: true, blocked: [group] }, startError: null, stats: { queued: 10, running: 1 },
    });
    expect(p.message).toMatch(/^Skipping 2 .* -- the rest of the batch is drawing\. /);
    expect(blockedPanel({ run: { running: false, blocked: [] }, startError: { blocked: [group] } }).message)
      .toBe(null);
  });

  it('hides a Start refusal once a batch is running, and hides when nothing is blocked', () => {
    expect(blockedPanel({ run: { running: true, blocked: [] }, startError: { blocked: [group] } }).show)
      .toBe(false);
    expect(blockedPanel({ run: { running: false, blocked: [] }, startError: null }).show).toBe(false);
    expect(blockedPanel({ run: null, startError: null }).show).toBe(false);
  });
});
