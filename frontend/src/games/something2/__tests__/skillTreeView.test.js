import { describe, it, expect } from 'vitest';
import { applyFilters, filtersFromParams } from '../artSelection.js';
import { SKILLS_BY_CLASS } from '../src/js/core/skillsData.js';
import {
  indexArt, artFor, artCoverage, distinctLabels, treeBounds, zoomViewBox, panViewBox,
  artConsoleLink, clientToWorld, wheelZoom, onlyMissing, dragStart, dragMove, dragEnd, dragClick,
  endPressOnRelease, shouldNavigate,
} from '../skillTreeView.js';

// SOMET-571. The Skill Tree tab's rules, testable without an SVG.

const subjects = [
  { kind: 'skill', key: 'war_whirlwind', name: 'Whirlwind', has_art: true, image: 'art/skill/w.png', updated_at: '2026-09-10T00:00:00Z' },
  { kind: 'skill', key: 'war_shield_slam', name: 'Shield Slam', has_art: false, image: null },
  // "Focus" is BOTH a passive label and a plausible skill id: the index must
  // be namespaced by kind, exactly as catalog_art's primary key is.
  { kind: 'passive_label', key: 'Focus', name: 'Focus', has_art: true, image: 'art/label/focus.png', updated_at: '2026-09-09T00:00:00Z' },
  { kind: 'skill', key: 'Focus', name: 'Focus', has_art: false, image: null },
  { kind: 'item', key: 'crude-blade', name: 'crude-blade', has_art: true, image: 'items/cb.png' },
];

describe('indexArt / artFor', () => {
  it('finds a subject with art by kind and key', () => {
    const idx = indexArt(subjects);
    expect(artFor(idx, 'skill', 'war_whirlwind')).toMatchObject({ image: 'art/skill/w.png' });
  });

  it('answers null for a subject that exists but has no art', () => {
    const idx = indexArt(subjects);
    expect(artFor(idx, 'skill', 'war_shield_slam')).toBeNull();
  });

  it('answers null for a subject the console never listed', () => {
    expect(artFor(indexArt(subjects), 'skill', 'nope')).toBeNull();
  });

  it('keeps a passive label and a skill with the same key apart', () => {
    const idx = indexArt(subjects);
    expect(artFor(idx, 'passive_label', 'Focus')).toMatchObject({ image: 'art/label/focus.png' });
    expect(artFor(idx, 'skill', 'Focus')).toBeNull();
  });

  it('treats has_art without an image path as no art', () => {
    // The console's has_art comes from the catalog row; a row with a blank
    // image would render an empty <image>, which is worse than the dashed ring.
    const idx = indexArt([{ kind: 'skill', key: 'x', has_art: true, image: '' }]);
    expect(artFor(idx, 'skill', 'x')).toBeNull();
  });
});

describe('artCoverage', () => {
  it('counts total, with art and missing over the given keys', () => {
    const idx = indexArt(subjects);
    expect(artCoverage(idx, 'skill', ['war_whirlwind', 'war_shield_slam', 'Focus']))
      .toEqual({ total: 3, withArt: 1, missing: 2 });
  });

  it('is all-missing when the console has not loaded yet', () => {
    expect(artCoverage(indexArt([]), 'skill', ['a', 'b'])).toEqual({ total: 2, withArt: 0, missing: 2 });
  });
});

describe('distinctLabels', () => {
  it('lists each non-empty label once, in first-seen order', () => {
    const nodes = [
      { id: 1, label: 'Vigor' }, { id: 2, label: '' }, { id: 3, label: 'Focus' },
      { id: 4, label: 'Vigor' }, { id: 5, label: undefined },
    ];
    expect(distinctLabels(nodes)).toEqual(['Vigor', 'Focus']);
  });
});

describe('onlyMissing', () => {
  it('keeps only the items whose subject has no art', () => {
    const idx = indexArt(subjects);
    const items = [
      { key: 'war_whirlwind' }, { key: 'war_shield_slam' }, { key: 'Focus' },
    ];
    expect(onlyMissing(idx, 'skill', items, (i) => i.key).map((i) => i.key))
      .toEqual(['war_shield_slam', 'Focus']);
  });
});

describe('treeBounds', () => {
  it('encloses every node with padding for the largest radius', () => {
    const nodes = [{ x: -100, y: 50 }, { x: 200, y: -30 }, { x: 0, y: 0 }];
    expect(treeBounds(nodes, 20)).toEqual({ x: -120, y: -50, w: 340, h: 120 });
  });

  it('falls back to a fixed box for an empty tree rather than NaN', () => {
    // Canvas and SVG both silently drop non-finite geometry (SOMET-488): an
    // empty tree while the query loads must still produce a drawable viewBox.
    const b = treeBounds([], 20);
    expect(Number.isFinite(b.w) && b.w > 0).toBe(true);
    expect(Number.isFinite(b.h) && b.h > 0).toBe(true);
  });
});

describe('zoomViewBox', () => {
  const box = { x: 0, y: 0, w: 400, h: 200 };

  it('zooming in halves the box around the focus point, keeping it fixed', () => {
    // Focus at the box centre: (200, 100) must still be the centre afterwards.
    expect(zoomViewBox(box, 2, 200, 100)).toEqual({ x: 100, y: 50, w: 200, h: 100 });
  });

  it('keeps an off-centre focus point under the cursor', () => {
    // Focus at (400, 200) -- the bottom-right corner. Zooming in 2x keeps that
    // corner fixed, so the box shrinks toward it.
    expect(zoomViewBox(box, 2, 400, 200)).toEqual({ x: 200, y: 100, w: 200, h: 100 });
  });

  it('clamps the zoom so the box can neither vanish nor grow unbounded', () => {
    const tiny = zoomViewBox(box, 1e9, 0, 0);
    expect(tiny.w).toBeGreaterThan(0);
    const huge = zoomViewBox(box, 1e-9, 0, 0);
    expect(huge.w).toBeLessThan(1e6);
  });
});

describe('clientToWorld', () => {
  // A 1000x500 element showing a square box: "meet" fits the height, so the
  // box is centred horizontally with slack on both sides.
  const rect = { left: 100, top: 50, width: 1000, height: 500 };
  const box = { x: 0, y: 0, w: 200, h: 200 };

  it('maps the element centre to the box centre and scales by the fitted axis', () => {
    expect(clientToWorld(box, rect, 600, 300)).toEqual({ x: 100, y: 100 });
    expect(clientToWorld(box, rect, 600 + 250, 300 + 250)).toEqual({ x: 200, y: 200 });
  });

  // SOMET-571 rework: the wheel handler took the focus from the last-RENDERED
  // box, so wheel events landing between renders zoomed about a stale point
  // and the spot under the cursor drifted. Zooming repeatedly about the point
  // computed from the box being zoomed keeps it fixed exactly.
  it('keeps the point under the cursor fixed across many chained zooms', () => {
    const cx = 333; const cy = 177;
    let b = box;
    const start = clientToWorld(b, rect, cx, cy);
    for (let i = 0; i < 12; i += 1) {
      const f = clientToWorld(b, rect, cx, cy);
      b = zoomViewBox(b, 1.2, f.x, f.y);
    }
    const end = clientToWorld(b, rect, cx, cy);
    expect(end.x).toBeCloseTo(start.x, 9);
    expect(end.y).toBeCloseTo(start.y, 9);
  });
});

describe('wheelZoom', () => {
  const rect = { left: 100, top: 50, width: 1000, height: 500 };
  const bounds = { x: 0, y: 0, w: 200, h: 200 };

  it('starts from the tree bounds when the user has not zoomed yet', () => {
    expect(wheelZoom(null, bounds, rect, 600, 300, 2)).toEqual(zoomViewBox(bounds, 2, 100, 100));
  });

  // Each step chained off the previous RESULT, exactly as setBox's updater
  // feeds it. A focus taken from a stale box (the bounds, or the box from
  // before the burst) drifts.
  it('keeps the point under the cursor fixed over a burst of chained steps', () => {
    const cx = 333; const cy = 177;
    const start = clientToWorld(bounds, rect, cx, cy);
    let b = null;
    for (let i = 0; i < 12; i += 1) b = wheelZoom(b, bounds, rect, cx, cy, 1.2);
    const end = clientToWorld(b, rect, cx, cy);
    expect(end.x).toBeCloseTo(start.x, 9);
    expect(end.y).toBeCloseTo(start.y, 9);
  });

  // A step that zoomed the bounds every time keeps the focus fixed too, but
  // never gets past one step's 1.2x. (A tree big enough that 12 steps stay
  // clear of the MIN_W clamp.)
  it('accumulates the zoom over a burst of chained steps', () => {
    const big = { x: 0, y: 0, w: 2000, h: 2000 };
    let b = null;
    for (let i = 0; i < 12; i += 1) b = wheelZoom(b, big, rect, 333, 177, 1.2);
    expect(b.w).toBeCloseTo(big.w / 1.2 ** 12, 9);
  });

  it('zooms the box it is given once the user has zoomed, not the bounds', () => {
    const box = { x: 50, y: 20, w: 80, h: 40 };
    const focus = clientToWorld(box, rect, 600, 300);
    expect(wheelZoom(box, bounds, rect, 600, 300, 2)).toEqual(zoomViewBox(box, 2, focus.x, focus.y));
  });
});

// SOMET-571 re-validation: a press released outside the svg before it became
// a drag never reaches the svg's onPointerUp; the window must end it, on
// pointerup AND pointercancel, and stop listening on unmount.
describe('endPressOnRelease', () => {
  const pressed = () => dragStart(10, 10);

  for (const type of ['pointerup', 'pointercancel']) {
    it(`a window ${type} ends the press`, () => {
      const win = new EventTarget();
      const ref = { current: pressed() };
      endPressOnRelease(win, ref);
      win.dispatchEvent(new Event(type));
      expect(ref.current.pressed).toBe(false);
      // A later move pans nothing, even one that reports a button held.
      const { dx, dy } = dragMove(ref.current, 200, 200, 1);
      expect([dx, dy]).toEqual([0, 0]);
    });
  }

  it('keeps the moved record, so the click after a pan is still swallowed', () => {
    const win = new EventTarget();
    let s = pressed();
    ({ state: s } = dragMove(s, 60, 10, 1));
    const ref = { current: s };
    endPressOnRelease(win, ref);
    win.dispatchEvent(new Event('pointerup'));
    expect(dragClick(ref.current).allow).toBe(false);
  });

  it('stops listening once the returned cleanup runs', () => {
    const win = new EventTarget();
    const ref = { current: pressed() };
    endPressOnRelease(win, ref)();
    win.dispatchEvent(new Event('pointerup'));
    win.dispatchEvent(new Event('pointercancel'));
    expect(ref.current.pressed).toBe(true);
  });
});

describe('panViewBox', () => {
  it('moves the box opposite to the drag, in world units', () => {
    // Dragging right by 50 screen px at 2 world-units-per-px moves the box
    // LEFT by 100 world units, so the content follows the cursor.
    expect(panViewBox({ x: 10, y: 10, w: 400, h: 200 }, 50, -25, 2))
      .toEqual({ x: -90, y: 60, w: 400, h: 200 });
  });
});

describe('drag gate', () => {
  // The browser fires `click` AFTER `pointerup`. A guard that clears its drag
  // state on pointerup therefore sees no drag by the time the click arrives,
  // and the release of a pan navigates away (observed live, 2026-09-11).
  it('a press-move-release swallows the click that follows it', () => {
    let s = dragStart(10, 10);
    ({ state: s } = dragMove(s, 30, 10));
    s = dragEnd(s);
    const { state: afterClick, allow } = dragClick(s);
    expect(allow).toBe(false);
    // Only that one click is swallowed; the next is a real click.
    expect(dragClick(afterClick).allow).toBe(true);
  });

  it('a press-release with no movement lets the click through', () => {
    let s = dragStart(10, 10);
    ({ state: s } = dragMove(s, 11, 10)); // sub-threshold jitter
    s = dragEnd(s);
    expect(dragClick(s).allow).toBe(true);
  });

  it('reports each move as a delta from the previous position', () => {
    let s = dragStart(0, 0);
    let r = dragMove(s, 5, -3);
    expect([r.dx, r.dy]).toEqual([5, -3]);
    r = dragMove(r.state, 7, -3);
    expect([r.dx, r.dy]).toEqual([2, 0]);
  });

  // SOMET-571 rework. The svg used to setPointerCapture on EVERY press. Chrome
  // then retargets pointerup and click to the svg, so a node's onClick never
  // fired and a plain click on the tree navigated nowhere (logged live:
  // pointerdown:image, gotpointercapture:svg, pointerup:svg, click:svg). The
  // gate now says WHEN to capture: on the one move where the press becomes a
  // drag, never on the press itself, so a click without a drag keeps its target.
  it('asks for pointer capture only on the move that turns a press into a drag', () => {
    let s = dragStart(10, 10);
    let r = dragMove(s, 11, 10); // sub-threshold: still a click candidate
    expect(r.capture).toBe(false);
    r = dragMove(r.state, 30, 10); // crosses the threshold
    expect(r.capture).toBe(true);
    r = dragMove(r.state, 50, 10); // already dragging: capture once, not per move
    expect(r.capture).toBe(false);
  });

  it('a plain press-release never asks for capture', () => {
    const s = dragStart(10, 10);
    expect(s.capture).toBeUndefined();
    const r = dragMove(s, 10, 10);
    expect(r.capture).toBe(false);
    expect(dragClick(dragEnd(r.state)).allow).toBe(true);
  });

  it('measures the threshold from the press, so a slow drag still counts as a drag', () => {
    // Per-move deltas of 1 px never reach a 3 px threshold on their own; a
    // slow pan must still swallow its trailing click and still capture.
    let s = dragStart(0, 0);
    const captures = [];
    for (let x = 1; x <= 10; x += 1) {
      const r = dragMove(s, x, 0);
      captures.push(r.capture);
      s = r.state;
    }
    expect(captures.filter(Boolean).length).toBe(1);
    expect(dragClick(dragEnd(s)).allow).toBe(false);
  });

  // SOMET-571 re-validation. Capture is taken only once a press becomes a drag,
  // so a press that leaves the svg before the threshold (or jumps straight out
  // of it) is released outside, the svg never sees pointerup, and the press
  // stayed `pressed`. Hovering back over the tree with NO button held then
  // panned it (viewBox x -925 -> -459). A move whose `buttons` is 0 is proof
  // the button is up: it ends the press and pans nothing.
  it('a move with no button held ends a press whose release was missed', () => {
    let s = dragStart(100, 100);
    let r = dragMove(s, 101, 100, 1); // still held, sub-threshold
    expect(r.state.pressed).toBe(true);
    r = dragMove(r.state, 40, 60, 0); // released outside, hovering back
    expect([r.dx, r.dy]).toEqual([0, 0]);
    expect(r.capture).toBe(false);
    expect(r.state.pressed).toBe(false);
    // ...and stays ended: later button-less moves pan nothing either.
    r = dragMove(r.state, 10, 10, 0);
    expect([r.dx, r.dy]).toEqual([0, 0]);
    r = dragMove(r.state, 300, 10, 0);
    expect([r.dx, r.dy]).toEqual([0, 0]);
  });

  it('a missed release after a real drag ends it too, and pans nothing more', () => {
    // The press had become a drag before it left; its release was missed. The
    // button-less move ends it without capturing, and the next press starts fresh.
    let r = dragMove(dragStart(0, 0), 20, 0, 1);
    expect(r.capture).toBe(true);
    r = dragMove(r.state, 25, 0, 0);
    expect(r.state.pressed).toBe(false);
    expect([r.dx, r.dy]).toEqual([0, 0]);
    const fresh = dragStart(5, 5);
    expect(dragClick(dragEnd(fresh)).allow).toBe(true);
  });

  it('a held button keeps panning (buttons !== 0)', () => {
    const r = dragMove(dragStart(0, 0), 20, 5, 1);
    expect([r.dx, r.dy]).toEqual([20, 5]);
    expect(r.state.pressed).toBe(true);
  });

  it('ignores moves when no press is in progress', () => {
    const r = dragMove(null, 5, 5);
    expect(r.state).toBeNull();
    expect([r.dx, r.dy]).toEqual([0, 0]);
  });
});

describe('artConsoleLink', () => {
  it('lands on the console filtered to exactly that subject, art filter widened', () => {
    // The console defaults to art=missing. A link to a subject that HAS art
    // must override that, or the click lands on an empty table. The subject
    // goes in `key=` (exact), not `q=` (substring): q=Mage matched 8 labels.
    expect(artConsoleLink('skill', 'war_whirlwind'))
      .toBe('/game/art?kind=skill&art=all&key=war_whirlwind');
  });

  it('encodes a label with spaces and punctuation', () => {
    expect(artConsoleLink('passive_label', 'Arcane Conduit & more'))
      .toBe('/game/art?kind=passive_label&art=all&key=Arcane+Conduit+%26+more');
  });
});

// SOMET-571 rework. The round trip the click actually takes: link -> URL ->
// the console's filtersFromParams -> applyFilters. Validation found q=Mage
// landing on 8 rows (Afterimage, Pyromancy, ...): 8 of 128 labels opened on
// the wrong set. Every link must select exactly its own subject.
describe('artConsoleLink lands on exactly one subject', () => {
  const land = (subjects, link) => {
    const params = new URL(link, 'http://x').searchParams;
    return applyFilters(subjects, filtersFromParams(params));
  };

  it('holds for labels that are substrings of other labels', () => {
    // Real collisions reported by validation, plus case-only and key/name overlap.
    const keys = ['Mage', 'Afterimage', 'Pyromancy', 'Storm Caller', 'Wind', 'Windwalker',
      'Second Wind', 'Ward', 'Warden', 'Edge', 'Hedge', 'Stamina', 'Stamina Reserve', 'Reserve'];
    const subjects = keys.map((key) => ({ kind: 'passive_label', key, name: key, has_art: true }));
    for (const key of keys) {
      const rows = land(subjects, artConsoleLink('passive_label', key));
      expect(rows.map((s) => s.key), key).toEqual([key]);
    }
  });

  it('holds for every class skill the Skill Tree tab can link to', () => {
    // A skill's display name may contain another skill's key, so the name is
    // part of the haystack; all 300 must still land on one row.
    const all = Object.values(SKILLS_BY_CLASS).flat();
    const subjects = all.map((s) => ({ kind: 'skill', key: s.id, name: s.nameEn, has_art: true }));
    for (const s of all) {
      const rows = land(subjects, artConsoleLink('skill', s.id));
      expect(rows.map((r) => r.key), s.id).toEqual([s.id]);
    }
  });
});

// SOMET-571 rework 4. A fast double-click fires two click handlers before
// react-router's location has updated between them, so openLabel/openSkill
// each called navigate() and pushed two history entries for the SAME
// destination -- one Back press then landed back on the page it just left.
// Gated on TIME rather than "have we ever gone here": a deliberate second
// visit (go back, click the same node again) happens well outside a double
// click's span and must still navigate.
describe('shouldNavigate', () => {
  it('blocks an immediate repeat of the same link', () => {
    const last = { link: '/game/art?key=Mage', at: 1000 };
    expect(shouldNavigate(last, '/game/art?key=Mage', 1000)).toBe(false);
    expect(shouldNavigate(last, '/game/art?key=Mage', 1300)).toBe(false);
  });

  it('allows a different link immediately', () => {
    const last = { link: '/game/art?key=Mage', at: 1000 };
    expect(shouldNavigate(last, '/game/art?key=Focus', 1000)).toBe(true);
  });

  it('allows the same link again once the double-click window has passed', () => {
    const last = { link: '/game/art?key=Mage', at: 1000 };
    expect(shouldNavigate(last, '/game/art?key=Mage', 1501)).toBe(true);
  });

  it('allows the first navigation ever (no last click recorded)', () => {
    expect(shouldNavigate(null, '/game/art?key=Mage', 1000)).toBe(true);
  });
});
