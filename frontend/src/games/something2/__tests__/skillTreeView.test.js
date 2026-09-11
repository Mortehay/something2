import { describe, it, expect } from 'vitest';
import {
  indexArt, artFor, artCoverage, distinctLabels, treeBounds, zoomViewBox, panViewBox,
  artConsoleLink, onlyMissing,
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

describe('panViewBox', () => {
  it('moves the box opposite to the drag, in world units', () => {
    // Dragging right by 50 screen px at 2 world-units-per-px moves the box
    // LEFT by 100 world units, so the content follows the cursor.
    expect(panViewBox({ x: 10, y: 10, w: 400, h: 200 }, 50, -25, 2))
      .toEqual({ x: -90, y: 60, w: 400, h: 200 });
  });
});

describe('artConsoleLink', () => {
  it('lands on the console filtered to exactly that subject, art filter widened', () => {
    // The console defaults to art=missing. A link to a subject that HAS art
    // must override that, or the click lands on an empty table.
    expect(artConsoleLink('skill', 'war_whirlwind'))
      .toBe('/game/art?kind=skill&art=all&q=war_whirlwind');
  });

  it('encodes a label with spaces and punctuation', () => {
    expect(artConsoleLink('passive_label', 'Arcane Conduit & more'))
      .toBe('/game/art?kind=passive_label&art=all&q=Arcane+Conduit+%26+more');
  });
});
