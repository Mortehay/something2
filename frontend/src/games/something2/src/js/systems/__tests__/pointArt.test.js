import { describe, it, expect } from 'vitest';
import { pointArtDef, pointBodyRef, pointStateTreatment, planLandmarkBodies } from '../pointArt.js';
import { RenderSystem } from '../RenderSystem.js';

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
  });
  it('tolerates a missing catalog', () => {
    const plan = planLandmarkBodies([portal], null);
    expect(plan.bodies).toEqual([]);
    expect(plan.skipBody.size).toBe(0);
  });
});

describe('resolveSprite stateKey seam', () => {
  const manifest = { frames: { 'S/0': [0, 0, 8, 8], opened: [8, 0, 8, 8] } };
  const img = { width: 16, height: 8 };
  const imageManager = { get: (k) => (k === 'atlas' ? img : null) };
  const entity = { sprite: { atlas_key: 'atlas', manifest } };
  it('uses the state frame when present', () => {
    expect(RenderSystem.resolveSprite({ ...entity, stateKey: 'opened' }, imageManager, 'static', 0).crop).toEqual([8, 0, 8, 8]);
  });
  it('falls back to the static frame when the state frame is absent', () => {
    expect(RenderSystem.resolveSprite({ ...entity, stateKey: 'locked' }, imageManager, 'static', 0).crop).toEqual([0, 0, 8, 8]);
    expect(RenderSystem.resolveSprite(entity, imageManager, 'static', 0).crop).toEqual([0, 0, 8, 8]);
  });
});
