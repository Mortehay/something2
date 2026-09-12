import { describe, it, expect, vi } from 'vitest';
import { RenderSystem } from '../RenderSystem.js';

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
});

describe('_drawPointArtAt', () => {
  it('returns true and draws when the name resolves to art', () => {
    const r = rs();
    expect(r._drawPointArtAt('portal', 3250, 3450, { alpha: 1, ring: false, stateKey: null })).toBe(true);
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
    r.drawWorldChest({ x: 450, y: 450, kind: 'vault', state: 'opened', art: 'portal' }, null);
    expect(r.ctx.drawImage).toHaveBeenCalledTimes(1);
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
