import { describe, it, expect } from 'vitest';
import { pointArtDef, pointBodyRef, pointStateTreatment, planLandmarkBodies } from '../pointArt.js';

const DEFS = {
  portal: { id: 1, render_mode: 'static', image: 'sprites/portal.png', displayWidth: 110, displayHeight: 130 },
  bare: { id: 2, render_mode: 'rect', image: null, sprite: null },
  rect_with_image: { id: 3, render_mode: 'rect', image: 'x.png' },
  sheet: { id: 4, render_mode: 'animated', sprite: { atlas_key: 'a', manifest: { frames: { '0': [0, 0, 8, 8] } } } },
};

describe('pointArtDef', () => {
  it('returns the def only when it has drawable art', () => {
    expect(pointArtDef('portal', DEFS)).toBe(DEFS.portal);
    expect(pointArtDef('sheet', DEFS)).toBe(DEFS.sheet);
    expect(pointArtDef('bare', DEFS)).toBeNull();
    expect(pointArtDef('rect_with_image', DEFS)).toBeNull();
    expect(pointArtDef('missing', DEFS)).toBeNull();
    expect(pointArtDef(null, DEFS)).toBeNull();
    expect(pointArtDef('portal', null)).toBeNull();
  });
});

describe('pointBodyRef', () => {
  it('anchors the body like a decoration: tile top-left with a full-tile box', () => {
    const r = pointBodyRef(DEFS.portal, 3250, 3450, { stateKey: 'lit' });
    expect(r).toMatchObject({ x: 3200, y: 3400, width: 100, height: 100, displayWidth: 110, displayHeight: 130, stateKey: 'lit' });
  });
});

describe('pointStateTreatment', () => {
  it('dims an unlit waypoint and rings it', () => {
    expect(pointStateTreatment('waypoint', { activated: false })).toEqual({ alpha: 0.45, ring: true, stateKey: 'unlit' });
    expect(pointStateTreatment('waypoint', { activated: true })).toEqual({ alpha: 1, ring: false, stateKey: 'lit' });
  });
  it('dims an opened chest only', () => {
    expect(pointStateTreatment('chest', { state: 'opened' })).toEqual({ alpha: 0.45, ring: false, stateKey: 'opened' });
    expect(pointStateTreatment('chest', { state: 'locked' })).toEqual({ alpha: 1, ring: false, stateKey: 'locked' });
  });
  it('is neutral for everything else', () => {
    expect(pointStateTreatment('merchant', {})).toEqual({ alpha: 1, ring: false, stateKey: null });
  });

  // SOMET-588: the two defaulting expressions (`point && point.activated ===
  // true`, `(point && point.state) || "locked"`) were only ever exercised
  // with a fully-formed point -- a missing point, or a chest row with no
  // `state` key at all, never hit the actual default branch.
  it('defaults a missing waypoint point to unlit, not a thrown error', () => {
    expect(pointStateTreatment('waypoint', null)).toEqual({ alpha: 0.45, ring: true, stateKey: 'unlit' });
    expect(pointStateTreatment('waypoint', undefined)).toEqual({ alpha: 0.45, ring: true, stateKey: 'unlit' });
  });
  it('defaults a chest with no state key, or no point at all, to locked', () => {
    expect(pointStateTreatment('chest', {})).toEqual({ alpha: 1, ring: false, stateKey: 'locked' });
    expect(pointStateTreatment('chest', null)).toEqual({ alpha: 1, ring: false, stateKey: 'locked' });
  });
});

describe('planLandmarkBodies', () => {
  const portal = { kind: 'portal', x: 3150, y: 3450, name: 'To X', activated: false, art: 'portal' };
  const wpSame = { kind: 'waypoint', x: 3150, y: 3450, name: 'Gate', activated: false, art: 'portal' };
  const wpElse = { kind: 'waypoint', x: 1050, y: 1050, name: 'Stone', activated: true, art: 'portal' };
  const wpNoArt = { kind: 'waypoint', x: 2050, y: 2050, name: 'Plain', activated: true, art: null };
  it('gives every landmark with drawable art a body and skips its diamond', () => {
    const plan = planLandmarkBodies([portal, wpElse, wpNoArt], DEFS);
    expect(plan.bodies.map((b) => b.landmark)).toEqual([portal, wpElse]);
    expect(plan.bodies[1].treatment).toEqual({ alpha: 1, ring: false, stateKey: 'lit' });
    expect(plan.skipBody.has(portal)).toBe(true);
    expect(plan.skipBody.has(wpNoArt)).toBe(false);
  });
  it('a waypoint sharing a portal tile draws no body of its own, but keeps its diamond', () => {
    // SOMET-584 review fix round 1 (#3): skipBody would otherwise erase the
    // waypoint's only on-screen activation signal.
    const plan = planLandmarkBodies([portal, wpSame], DEFS);
    expect(plan.bodies.map((b) => b.landmark)).toEqual([portal]);
    expect(plan.skipBody.has(wpSame)).toBe(false);
    // SOMET-588: its beam/label still move to the overlay pass, so they land
    // on top of the gate's body instead of underneath it in the flat pass.
    expect(plan.beamOverlay.has(wpSame)).toBe(true);
    expect(plan.beamOverlay.has(portal)).toBe(false);
  });
  it('tolerates a missing catalog', () => {
    const plan = planLandmarkBodies([portal], null);
    expect(plan.bodies).toEqual([]);
    expect(plan.skipBody.size).toBe(0);
  });
  it('skips a landmark with a non-finite coordinate entirely (SOMET-576)', () => {
    // Mirrors drawLandmarks' own Number.isFinite guard: a NaN x/y must yield
    // neither a body nor a skipBody entry, since a NaN depthKey would scramble
    // the depth sort for every other body in the same pass.
    const nanLandmark = { kind: 'portal', x: NaN, y: 3450, name: 'Broken', art: 'portal' };
    const plan = planLandmarkBodies([nanLandmark, portal], DEFS);
    expect(plan.bodies.map((b) => b.landmark)).toEqual([portal]);
    expect(plan.skipBody.has(nanLandmark)).toBe(false);
    expect(plan.skipBody.has(portal)).toBe(true);
  });
});

// The resolveSprite stateKey seam tests moved to spriteAtlas.test.js's
// "RenderSystem.resolveSprite" describe (SOMET-588) -- that is resolveSprite's
// own test home; this file only ever imported RenderSystem for them.
