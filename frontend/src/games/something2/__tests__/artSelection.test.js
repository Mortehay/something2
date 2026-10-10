import { describe, it, expect } from 'vitest';
import {
  subjectId, sortSubjects, freezeOrder, clampPage, pageCount, toggle, selectPage, deselectPage,
  isPageFullySelected, selectAllMatching, selectAllLabel, byKind, applyFilters,
  enqueueSummary, coverage, selectionOutsideFilter, promptIneligibleCount, PAGE_SIZE, filtersFromParams,
  joinInFlight, paramsFromFilters, startBatchBlocker, startBatchBody, createUrlEcho,
} from '../artSelection.js';

const S = (kind, key, extra = {}) => ({ kind, key, name: key, has_art: false, ...extra });

describe('subject identity', () => {
  // 'Focus' is a real passive label AND a plausible skill id. A selection keyed
  // on the bare key would enqueue one and silently drop the other.
  it('is namespaced by kind, so the same key under two kinds is two subjects', () => {
    expect(subjectId(S('skill', 'Focus'))).not.toBe(subjectId(S('passive_label', 'Focus')));
    const sel = selectAllMatching([S('skill', 'Focus'), S('passive_label', 'Focus')]);
    expect(sel.size).toBe(2);
  });

  // Passive labels are free text and some contain punctuation.
  it('round-trips a key that itself contains a slash', () => {
    const id = subjectId(S('passive_label', 'Ward / Guard'));
    expect(byKind(new Set([id])).get('passive_label')).toEqual(['Ward / Guard']);
  });
});

describe('ordering', () => {
  // THE ACCEPTANCE CRITERION. Rows gain art while a batch runs; ordering by
  // has-art would move subjects between pages mid-batch, so the row an admin
  // ticked is no longer the row they thought.
  it('is stable as art lands, because it sorts on immutable columns', () => {
    const before = [S('skill', 'b'), S('skill', 'a'), S('item', 'c'), S('item', 'd')];
    const order = sortSubjects(before).map(subjectId);
    expect(order).toEqual(['item/c', 'item/d', 'skill/a', 'skill/b']);

    // Mid-batch, art lands on SOME subjects, not all. Flipping every row at
    // once would leave a has-art (or updated_at) sort giving the same order and
    // this test green; flipping one row in the middle moves it under any such
    // sort, in either direction.
    for (const landed of ['item/d', 'skill/a']) {
      const after = before.map((s) => (subjectId(s) === landed
        ? { ...s, has_art: true, updated_at: '2026-09-04' }
        : s));
      expect(sortSubjects(after).map(subjectId), `art landed on ${landed}`).toEqual(order);
    }
  });

  it('groups by kind then key', () => {
    const sorted = sortSubjects([S('tile', 'z'), S('item', 'b'), S('item', 'a')]);
    expect(sorted.map(subjectId)).toEqual(['item/a', 'item/b', 'tile/z']);
  });

  it('does not mutate its input', () => {
    const input = [S('tile', 'z'), S('item', 'a')];
    sortSubjects(input);
    expect(input.map((s) => s.key)).toEqual(['z', 'a']);
  });
});

describe('paging', () => {
  it('counts pages, and an empty result is still one page', () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(100)).toBe(1);
    expect(pageCount(101)).toBe(2);
    expect(pageCount(617)).toBe(7);
  });

  // Filtering down while on page 7 must not strand the admin on an empty table.
  it('clamps a page number that the current filter no longer has', () => {
    expect(clampPage(7, 617)).toBe(7);
    expect(clampPage(7, 12)).toBe(1);
    expect(clampPage(0, 617)).toBe(1);
    expect(clampPage(-3, 617)).toBe(1);
  });
});

describe('selection', () => {
  const page = [S('item', 'a'), S('item', 'b'), S('item', 'c')];

  it('toggles one subject without touching the rest', () => {
    let sel = new Set(['item/a']);
    sel = toggle(sel, 'item/b');
    expect([...sel].sort()).toEqual(['item/a', 'item/b']);
    sel = toggle(sel, 'item/a');
    expect([...sel]).toEqual(['item/b']);
  });

  // "SELECT PAGE" MEANS THIS PAGE. An admin who ticks the header box expecting
  // 100 and gets 617 has started a batch six times the size they intended.
  it('select-page adds only the visible rows, leaving other pages alone', () => {
    const sel = selectPage(new Set(['skill/elsewhere']), page);
    expect(sel.size).toBe(4);
    expect(sel.has('skill/elsewhere')).toBe(true);
    expect(sel.has('item/a')).toBe(true);
  });

  it('deselect-page removes only the visible rows', () => {
    const sel = deselectPage(selectPage(new Set(['skill/elsewhere']), page), page);
    expect([...sel]).toEqual(['skill/elsewhere']);
  });

  it('reports whether the page is fully selected, and an empty page is not', () => {
    expect(isPageFullySelected(selectPage(new Set(), page), page)).toBe(true);
    expect(isPageFullySelected(new Set(['item/a']), page)).toBe(false);
    expect(isPageFullySelected(new Set(), [])).toBe(false);
  });

  // "Select all matching" is a DIFFERENT act with an explicit count.
  it('select-all-matching takes the filtered set, not everything that exists', () => {
    const matching = [S('item', 'a'), S('item', 'b')];
    expect(selectAllMatching(matching).size).toBe(2);
  });

  it('offers select-all only when there is more than the page shows, with the count', () => {
    expect(selectAllLabel(617, 100)).toBe('Select all 617 matching the filter');
    expect(selectAllLabel(100, 100)).toBe(null);
    expect(selectAllLabel(12, 100)).toBe(null);
  });

  it('groups a mixed selection per kind, because enqueue takes one kind at a time', () => {
    const sel = new Set(['item/a', 'skill/x', 'item/b']);
    const grouped = byKind(sel);
    expect(grouped.get('item').sort()).toEqual(['a', 'b']);
    expect(grouped.get('skill')).toEqual(['x']);
  });
});

describe('selection across a filter change', () => {
  // Found in the BROWSER, not by a test: after switching from "missing art" to
  // "has art" the button still read "Queue 100 selected" while none of the 100
  // were on screen. Queueing them would regenerate subjects the admin could not
  // see. The selection is kept -- filter, select, filter, select more is a real
  // workflow -- so the discrepancy has to be stated instead.
  it('counts selected subjects the current filter is not showing', () => {
    const selected = new Set(['item/a', 'item/b', 'skill/x']);
    expect(selectionOutsideFilter(selected, [S('item', 'a'), S('item', 'b')])).toBe(1);
    expect(selectionOutsideFilter(selected, [])).toBe(3);
    expect(selectionOutsideFilter(new Set(), [S('item', 'a')])).toBe(0);
  });

  it('is zero when everything selected is visible', () => {
    const rows = [S('item', 'a'), S('item', 'b')];
    expect(selectionOutsideFilter(selectAllMatching(rows), rows)).toBe(0);
  });
});

describe('forced prompt selection', () => {
  it('accepts description-backed subjects and rejects composed-prompt subjects', () => {
    const subjects = [
      S('character_appearance', 'Archer:1', { takes_description: true }),
      S('tile', 'grass', { takes_description: false }),
    ];
    expect(promptIneligibleCount(new Set(['character_appearance/Archer:1']), subjects)).toBe(0);
    expect(promptIneligibleCount(new Set(['character_appearance/Archer:1', 'tile/grass']), subjects)).toBe(1);
  });
});

describe('filters', () => {
  const all = [
    S('item', 'sword', { has_art: true }),
    S('item', 'shield'),
    S('skill', 'fireball', { job_state: 'failed' }),
    S('tile', 'grass', { has_art: true }),
  ];

  // THE LOAD-BEARING FILTER: it is how a 617-subject batch is resumed.
  it('missing-art keeps only subjects with no art', () => {
    expect(applyFilters(all, { art: 'missing' }).map((s) => s.key).sort())
      .toEqual(['fireball', 'shield']);
  });

  it('has-art is the complement', () => {
    expect(applyFilters(all, { art: 'has' }).map((s) => s.key).sort())
      .toEqual(['grass', 'sword']);
  });

  // A failed subject must be findable and re-selectable, not merely absent.
  it('failed shows subjects whose last job failed', () => {
    expect(applyFilters(all, { art: 'failed' }).map((s) => s.key)).toEqual(['fireball']);
  });

  it('kind and search narrow further, and combine with the art filter', () => {
    expect(applyFilters(all, { kind: 'item' }).length).toBe(2);
    expect(applyFilters(all, { search: 'SWO' }).map((s) => s.key)).toEqual(['sword']);
    // exact: the key itself, case-sensitive, and the name is not searched.
    expect(applyFilters([...all, { kind: 'item', key: 'swordfish', has_art: true }], { search: 'sword', exact: true })
      .map((s) => s.key)).toEqual(['sword']);
    expect(applyFilters(all, { search: 'SWORD', exact: true })).toEqual([]);
    expect(applyFilters(all, { kind: 'item', art: 'missing' }).map((s) => s.key))
      .toEqual(['shield']);
  });

  it('no filter means everything', () => {
    expect(applyFilters(all, {}).length).toBe(4);
    expect(applyFilters(all).length).toBe(4);
  });
});

describe('reporting', () => {
  // Enqueue is idempotent server-side, so "100 selected, 3 queued" is normal --
  // and baffling without the breakdown.
  it('explains every subject that was not queued', () => {
    const s = enqueueSummary([
      { requested: 60, queued: 40, already_live: 18, unknown: ['gone', 'also-gone'] },
      { requested: 40, queued: 40, already_live: 0, unknown: [] },
    ]);
    expect(s.requested).toBe(100);
    expect(s.queued).toBe(80);
    expect(s.message).toBe('Queued 80 of 100 — 18 already in flight — 2 no longer in the catalogue');
  });

  it('says nothing extra when everything queued cleanly', () => {
    expect(enqueueSummary([{ requested: 5, queued: 5, already_live: 0, unknown: [] }]).message)
      .toBe('Queued 5 of 5');
  });

  // Progress comes from the catalog, never a counter that can drift.
  it('coverage counts art and failures from the rows themselves', () => {
    const c = coverage([
      S('item', 'a', { has_art: true }), S('item', 'b'),
      S('item', 'c', { job_state: 'failed' }),
    ]);
    expect(c).toEqual({ total: 3, withArt: 1, missing: 2, failed: 1 });
  });
});

describe('page size', () => {
  it('is the 100 the ticket asks for', () => {
    expect(PAGE_SIZE).toBe(100);
  });
});


// --- Sorting by date (SOMET-546) -------------------------------------------
//
// The default order is deliberately immutable (kind, then key) so a live batch
// cannot reshuffle the table. These cases pin the added behaviour AND that the
// default is unchanged -- the second is the one that would catch a careless
// edit, because every existing caller passes no options at all.
describe('sortSubjects by date', () => {
  const S = (key, updated_at) => ({ kind: 'item', key, updated_at });

  it('leaves the default order exactly as it was', () => {
    const rows = [S('b', '2026-01-02'), S('a', '2026-09-09')];
    // No options: must still be kind+key, NOT the newest first.
    expect(sortSubjects(rows).map((r) => r.key)).toEqual(['a', 'b']);
  });

  it('newest first when descending', () => {
    const rows = [S('old', '2026-01-01'), S('new', '2026-09-05'), S('mid', '2026-05-05')];
    expect(sortSubjects(rows, { by: 'updated', dir: 'desc' }).map((r) => r.key))
      .toEqual(['new', 'mid', 'old']);
  });

  it('oldest first when ascending', () => {
    const rows = [S('new', '2026-09-05'), S('old', '2026-01-01')];
    expect(sortSubjects(rows, { by: 'updated', dir: 'asc' }).map((r) => r.key))
      .toEqual(['old', 'new']);
  });

  it('puts never-generated subjects LAST in BOTH directions', () => {
    const rows = [S('none', null), S('dated', '2026-05-05')];
    // Ascending is the case that matters: treating "no date" as the epoch would
    // bury every real result under hundreds of blank rows.
    expect(sortSubjects(rows, { by: 'updated', dir: 'asc' }).map((r) => r.key))
      .toEqual(['dated', 'none']);
    expect(sortSubjects(rows, { by: 'updated', dir: 'desc' }).map((r) => r.key))
      .toEqual(['dated', 'none']);
  });

  it('never drops or duplicates a row', () => {
    const rows = [S('a', '2026-01-01'), S('b', null), S('c', '2026-02-02')];
    const out = sortSubjects(rows, { by: 'updated', dir: 'desc' });
    expect(out).toHaveLength(3);
    expect(new Set(out.map((r) => r.key))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('does not mutate its input', () => {
    const rows = [S('z', '2026-01-01'), S('a', '2026-09-09')];
    const before = rows.map((r) => r.key);
    sortSubjects(rows, { by: 'updated', dir: 'desc' });
    expect(rows.map((r) => r.key)).toEqual(before);
  });
});

describe('freezeOrder', () => {
  const S = (key) => ({ kind: 'item', key });

  it('holds a captured order even as the underlying data changes', () => {
    const order = ['item/c', 'item/a', 'item/b'];
    // Same subjects, arriving in a different order (a generation landed).
    const out = freezeOrder([S('a'), S('b'), S('c')], order);
    expect(out.map((r) => r.key)).toEqual(['c', 'a', 'b']);
  });

  it('appends subjects the snapshot has never seen instead of dropping them', () => {
    // A filter widening while the freeze is held must not hide rows -- showing
    // them late is a nuisance, omitting them is a correctness bug.
    const out = freezeOrder([S('a'), S('new')], ['item/a']);
    expect(out.map((r) => r.key)).toEqual(['a', 'new']);
  });

  it('falls back to the given order when there is no snapshot', () => {
    expect(freezeOrder([S('b'), S('a')], []).map((r) => r.key)).toEqual(['b', 'a']);
  });
});

describe('filtersFromParams', () => {
  // SOMET-571. The Skill Tree tab links to one subject; the console must open
  // ALREADY filtered to it, art filter widened past the resume default.
  it('seeds kind, art and search from the URL', () => {
    expect(filtersFromParams(new URLSearchParams('kind=skill&art=all&q=war_whirlwind')))
      .toEqual({ kind: 'skill', art: 'all', search: 'war_whirlwind', exact: false });
  });

  it('seeds an EXACT key match from key=, which wins over q=', () => {
    // SOMET-571 rework: q is a substring search, so q=Mage opened 8 rows.
    expect(filtersFromParams(new URLSearchParams('kind=passive_label&art=all&key=Mage&q=x')))
      .toEqual({ kind: 'passive_label', art: 'all', search: 'Mage', exact: true });
  });

  it('keeps the console defaults when the URL says nothing', () => {
    expect(filtersFromParams(new URLSearchParams('')))
      .toEqual({ kind: 'all', art: 'missing', search: '', exact: false });
  });

  it('ignores an art value the console has no filter for', () => {
    // A hand-edited or stale link must not put the table into a state no
    // control can get it out of.
    expect(filtersFromParams(new URLSearchParams('art=bogus')).art).toBe('missing');
  });
});

describe('joinInFlight', () => {
  // SOMET-538 rework: two clicks in one tick sent two POSTs; isPending had not
  // flipped yet. The second response ("0 of 2 -- 2 already in flight")
  // overwrote the first. A second call while one is pending must JOIN it.
  it('runs once for two same-tick calls, and both get the same result', async () => {
    const slot = { current: null };
    let runs = 0;
    const start = async () => { runs += 1; return `run ${runs}`; };
    const a = joinInFlight(slot, start);
    const b = joinInFlight(slot, start);
    expect(await Promise.all([a, b])).toEqual(['run 1', 'run 1']);
    expect(runs).toBe(1);
  });

  it('starts again once the previous call settled, including after a failure', async () => {
    const slot = { current: null };
    await expect(joinInFlight(slot, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(slot.current).toBe(null);
    expect(await joinInFlight(slot, async () => 'again')).toBe('again');
    expect(slot.current).toBe(null);
  });
});

// SOMET-535 validation, minor UX: the filters were read from the URL at mount
// and never written back, so browser back reset them. The console now writes
// them back; this is the inverse it uses.
describe('paramsFromFilters', () => {
  it('round-trips through filtersFromParams', () => {
    const f = { kind: 'skill', art: 'failed', search: 'whirl', exact: false };
    expect(filtersFromParams(paramsFromFilters(f))).toEqual(f);
  });

  // SOMET-571 x SOMET-535: the console writes its filters back to the URL on
  // every change, so a key= deep link must come back out as key= -- written
  // as q=, the first unrelated change (kind, art) silently turned the exact
  // match into a substring one (key=Mage -> q=Mage, eight labels).
  it('keeps an exact key search exact across the write-back', () => {
    const f = { kind: 'passive_label', art: 'all', search: 'Mage', exact: true };
    expect(paramsFromFilters(f).toString()).toBe('kind=passive_label&art=all&key=Mage');
    expect(filtersFromParams(paramsFromFilters(f))).toEqual(f);
    expect(filtersFromParams(paramsFromFilters({ ...f, art: 'has' }))).toMatchObject({ exact: true });
  });

  it('omits the defaults so the plain tab URL stays plain', () => {
    expect(paramsFromFilters({ kind: 'all', art: 'missing', search: '' }).toString()).toBe('');
  });

  it('writes the same names the Skill Tree deep link uses', () => {
    expect(paramsFromFilters({ kind: 'skill', art: 'all', search: 'war_whirlwind' }).toString())
      .toBe('kind=skill&art=all&q=war_whirlwind');
  });
});

// SOMET-535 rework: under Local the batch is drawn by sprite-gen, so a missing
// remote provider must not disable Start.
describe('startBatchBlocker', () => {
  it('needs a provider for a connector batch', () => {
    expect(startBatchBlocker({ backend: 'connector', providerId: '', activeProvider: null }))
      .toMatch(/provider/i);
  });

  it('is satisfied by the active provider or a chosen one', () => {
    expect(startBatchBlocker({ backend: 'connector', providerId: '', activeProvider: { id: 1 } }))
      .toBeNull();
    expect(startBatchBlocker({ backend: 'connector', providerId: '3', activeProvider: null }))
      .toBeNull();
  });

  it('does not need a provider for a local batch', () => {
    expect(startBatchBlocker({ backend: 'local', providerId: '', activeProvider: null })).toBeNull();
  });
});

describe('startBatchBody', () => {
  it('sends no provider under Local, even one left in the hidden select', () => {
    expect(startBatchBody({ backend: 'local', providerId: '5', activeProvider: { id: 9 } }))
      .toEqual({ concurrency: 1 });
  });
  it('sends the chosen provider under Connector, else the active one', () => {
    expect(startBatchBody({ backend: 'connector', providerId: '5', activeProvider: { id: 9 } }))
      .toEqual({ provider_id: 5, concurrency: 1 });
    expect(startBatchBody({ backend: 'connector', providerId: '', activeProvider: { id: 9 } }))
      .toEqual({ provider_id: 9, concurrency: 1 });
  });
});

describe('createUrlEcho', () => {
  const q = (s) => new URLSearchParams(s);
  it('ignores a late commit of a value the console wrote itself, even a stale one', () => {
    const echo = createUrlEcho();
    for (const v of ['q=w', 'q=wa', 'q=war']) echo.wrote(q(v));
    // the router commits 'wa' after the user has typed 'war': adopting it
    // would snap the input back and lose the 'r'
    expect(echo.adopt(q('q=wa'))).toBe(false);
    expect(echo.adopt(q('q=war'))).toBe(false);
  });
  it('adopts navigation from outside (back, a deep link), then forgets old writes', () => {
    const echo = createUrlEcho();
    echo.wrote(q('q=w'));
    expect(echo.adopt(q('kind=skill&q=war_whirlwind'))).toBe(true);
    expect(echo.adopt(q('q=w'))).toBe(true);
  });
});
