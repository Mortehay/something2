import { describe, it, expect, vi } from 'vitest';
import { RenderSystem } from '../RenderSystem.js';
import { worldToScreen } from '../../core/iso.js';

// The green-over-dead-feature guard (SOMET-468 x4): a bound name can reach
// the renderer and still never hit drawImage. These tests assert the
// drawImage call itself.
function ctxSpy() {
  const noop = () => {};
  return new Proxy({ drawImage: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), strokeText: vi.fn(),
    measureText: () => ({ width: 10 }), save: noop, restore: noop, beginPath: noop, moveTo: noop,
    lineTo: noop, closePath: noop, fill: noop, stroke: noop, arc: noop, ellipse: noop, globalAlpha: 1,
  }, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
}
const IMG = { width: 64, height: 64 };
const DEFS = {
  portal: { render_mode: 'static', image: 'portal.png', displayWidth: 110, displayHeight: 130 },
  // Resolvable per the catalog (SHAPE is drawable) but its image is not in
  // the ImageManager -- still loading, or 404'd. SOMET-584 review fix round 1
  // (#2): this must fall back to the placeholder, not drawEntity's colored
  // rect fallback.
  ghost: { render_mode: 'static', image: 'ghost.png', displayWidth: 60, displayHeight: 60 },
};

function rs() {
  const r = Object.create(RenderSystem.prototype);
  r.ctx = ctxSpy();
  r.imageManager = { get: (k) => (k === 'portal.png' ? IMG : null) };
  r.nowMs = 0;
  r._labelCache = { get: () => null };
  r.renderModeOverride = null;
  r.entityDefs = DEFS;
  return r;
}

describe('drawPointBody', () => {
  it('draws the bound image through drawEntity with the treatment alpha', () => {
    const r = rs();
    r.drawPointBody(DEFS.portal, 3250, 3450, { alpha: 0.45, ring: true, stateKey: 'unlit' });
    expect(r.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(r.ctx.drawImage.mock.calls[0][0]).toBe(IMG);
  });

  // SOMET-588: the ring and the alpha were set (lines next to each other in
  // the source) but never actually asserted -- only drawImage was. Record
  // globalAlpha live at each call, same technique drawSkillMerchant's
  // textAlign test above uses for textAlign.
  it('draws the unlit ring via ellipse at its own fixed alpha, then the body at pointStateTreatment\'s DIM (0.45)', () => {
    const r = rs();
    const seen = [];
    r.ctx.ellipse = (...args) => seen.push({ name: 'ellipse', args, alpha: r.ctx.globalAlpha });
    r.ctx.drawImage = () => seen.push({ name: 'drawImage', alpha: r.ctx.globalAlpha });
    r.drawPointBody(DEFS.portal, 3250, 3450, { alpha: 0.45, ring: true, stateKey: 'unlit' });
    const s = worldToScreen(3250, 3450);
    const ring = seen.find((c) => c.name === 'ellipse');
    expect(ring).toBeTruthy();
    expect(ring.args).toEqual([s.x, s.y, 28, 14, 0, 0, Math.PI * 2]);
    expect(ring.alpha).toBeCloseTo(0.9, 6);
    const body = seen.find((c) => c.name === 'drawImage');
    expect(body).toBeTruthy();
    expect(body.alpha).toBeCloseTo(0.45, 6);
  });
});

describe('_drawPointArtAt', () => {
  it('returns the drawn body height (truthy, > 0) when the name resolves to art', () => {
    // SOMET-584 review round 2 (T9 finding B): the return value is now the
    // drawn body's height, not a bare boolean, so callers can lift a caption
    // above it -- assert the shape of that contract, not a specific number.
    const r = rs();
    expect(r._drawPointArtAt('portal', 3250, 3450, { alpha: 1, ring: false, stateKey: null })).toBeGreaterThan(0);
    expect(r.ctx.drawImage).toHaveBeenCalledTimes(1);
  });
  it('returns false and draws nothing when the name has no art, so the placeholder runs', () => {
    const r = rs();
    expect(r._drawPointArtAt('nothing', 1, 1, { alpha: 1, ring: false, stateKey: null })).toBe(false);
    expect(r._drawPointArtAt(null, 1, 1, { alpha: 1, ring: false, stateKey: null })).toBe(false);
    expect(r.ctx.drawImage).not.toHaveBeenCalled();
  });
});

describe('placeholder fallbacks keep drawing', () => {
  it('drawMerchant with no art still draws its caption', () => {
    const r = rs();
    r.drawMerchant({ x: 450, y: 450, art: null });
    expect(r.ctx.fillText).toHaveBeenCalledWith('Merchant', expect.any(Number), expect.any(Number));
    expect(r.ctx.drawImage).not.toHaveBeenCalled();
  });
  it('drawMerchant with art draws the image and still the caption', () => {
    const r = rs();
    r.drawMerchant({ x: 450, y: 450, art: 'portal' });
    expect(r.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(r.ctx.fillText).toHaveBeenCalledWith('Merchant', expect.any(Number), expect.any(Number));
  });
  it('drawWorldChest with art dims an opened chest and keeps the label', () => {
    const r = rs();
    const seen = [];
    r.ctx.drawImage = () => seen.push({ alpha: r.ctx.globalAlpha });
    r.drawWorldChest({ x: 450, y: 450, kind: 'vault', state: 'opened', art: 'portal' }, null);
    expect(seen.length).toBe(1);
    // pointStateTreatment's DIM (0.45) -- "opened" is the chest half of the
    // "0.45 unlit/opened" pair the waypoint ring test above covers.
    expect(seen[0].alpha).toBeCloseTo(0.45, 6);
    expect(r.ctx.fillText).toHaveBeenCalledWith('Looted', expect.any(Number), expect.any(Number));
  });
});

// SOMET-584 review fix round 1 (#1). textAlign was only ever set inside the
// star-icon block, which the art gate now skips entirely; drawPointBody's own
// save/restore discards whatever drawEntity happened to leave set. Record the
// live textAlign at the moment of each fillText call, the same way the
// landmarkRenderer stub records live alpha/fill state.
describe('drawSkillMerchant text alignment', () => {
  it('centers the caption even when its art drew, not just in the placeholder path', () => {
    const r = rs();
    const seen = [];
    r.ctx.fillText = (text) => seen.push({ text, textAlign: r.ctx.textAlign });
    r.drawSkillMerchant({ x: 450, y: 450, art: 'portal' });
    const caption = seen.find((c) => c.text === 'Skill Trainer');
    expect(caption).toBeTruthy();
    expect(caption.textAlign).toBe('center');
  });
});

// SOMET-584 review fix round 1 (#2). A def resolving per the catalog SHAPE is
// not the same as art the ImageManager can actually hand back pixels for
// right now. These assert the old placeholder still runs -- not a new
// colored box from drawEntity's own fallback -- when the image is missing.
describe('readiness gating for a resolvable-but-unloaded image', () => {
  it('_drawPointArtAt returns false and draws nothing', () => {
    const r = rs();
    expect(r._drawPointArtAt('ghost', 1, 1, { alpha: 1, ring: false, stateKey: null })).toBe(false);
    expect(r.ctx.drawImage).not.toHaveBeenCalled();
  });
  it('drawMerchant keeps its own placeholder diamond and caption, not drawEntity\'s color-fill fallback', () => {
    const r = rs();
    r.drawMerchant({ x: 450, y: 450, art: 'ghost' });
    expect(r.ctx.drawImage).not.toHaveBeenCalled();
    expect(r.ctx.fillText).toHaveBeenCalledWith('Merchant', expect.any(Number), expect.any(Number));
  });
  it('_readyLandmarkPlan demotes the body and leaves the landmark OUT of skipBody, so its diamond still draws', () => {
    const r = rs();
    const landmark = { kind: 'portal', x: 3150, y: 3450, name: 'To X', art: 'ghost' };
    const plan = r._readyLandmarkPlan([landmark]);
    expect(plan.bodies).toEqual([]);
    expect(plan.skipBody.has(landmark)).toBe(false);
  });
  it('_readyLandmarkPlan keeps a body whose art HAS loaded, and skips its diamond', () => {
    const r = rs();
    const landmark = { kind: 'portal', x: 3150, y: 3450, name: 'To X', art: 'portal' };
    const plan = r._readyLandmarkPlan([landmark]);
    expect(plan.bodies.length).toBe(1);
    expect(plan.skipBody.has(landmark)).toBe(true);
  });
});

// SOMET-584 review round 2 (T9 finding B). Live verification found the
// caption sitting in the middle of a 100px arch body: it was positioned off
// the placeholder's fixed radius `r` (11px) regardless of what actually drew.
// Record the real (x, y) each fillText call used, the same technique the
// textAlign test above uses, and check the caption cleared the body.
describe('caption lifts above the drawn body, not the placeholder radius', () => {
  it('drawMerchant with art positions "Merchant" well above the body, not at r=11', () => {
    const r = rs();
    const seen = [];
    r.ctx.fillText = (text, x, y) => seen.push({ text, x, y });
    r.drawMerchant({ x: 450, y: 450, art: 'portal' });
    const { y: dy } = worldToScreen(450, 450);
    const caption = seen.find((c) => c.text === 'Merchant');
    expect(caption).toBeTruthy();
    // The portal def is 110x130 and IMG is a 64x64 square, so the fit is
    // WIDTH-constrained: scale = 110/64, giving a drawn height of 110, not
    // the catalog's 130. The old (box-height) lift placed the caption at
    // dy - 130 - 6; pin the exact value so a regression back to the catalog
    // height (over-lifting into the empty space above a narrower body) fails
    // this test instead of only the loose bound below.
    expect(caption.y).toBeCloseTo(dy - 110 - 6, 6);
    expect(caption.y).toBeLessThan(dy - 40);
  });

  // SOMET-588: the previous fix (T9 finding B) used the catalog box height
  // (130 here) as the lift for EVERY body, including one whose fit is
  // width-constrained and therefore draws shorter than that box -- the
  // caption floated 20px above where the art visually ends.
  it('a width-constrained body lifts the caption to its REAL drawn height, not the catalog box', () => {
    const r = rs();
    const seen = [];
    r.ctx.fillText = (text, x, y) => seen.push({ text, x, y });
    r.drawMerchant({ x: 450, y: 450, art: 'portal' });
    const { y: dy } = worldToScreen(450, 450);
    const caption = seen.find((c) => c.text === 'Merchant');
    const catalogHeight = DEFS.portal.displayHeight; // 130
    const realDrawnHeight = (IMG.height) * (DEFS.portal.displayWidth / IMG.width); // fit by width: 110
    expect(realDrawnHeight).toBeLessThan(catalogHeight);
    expect(caption.y).toBeCloseTo(dy - realDrawnHeight - 6, 6);
  });
});
