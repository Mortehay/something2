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
const DEFS = { portal: { render_mode: 'static', image: 'portal.png', displayWidth: 110, displayHeight: 130 } };

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
