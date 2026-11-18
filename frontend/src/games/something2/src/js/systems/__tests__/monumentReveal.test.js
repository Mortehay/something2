// SOMET-781. A monument goes translucent when it hides an actor standing behind it.
import { describe, it, expect } from 'vitest';
import { monumentHides, MONUMENT_REVEAL_ALPHA } from '../monumentReveal.js';
import { RenderSystem } from '../RenderSystem.js';
import { depthKey, worldToScreen } from '../../core/iso.js';

// Sprite drawn bottom-centre on screen point (0, 0): 300 wide, 400 tall.
const rect = { left: -150, right: 150, top: -400, bottom: 0 };
const DEPTH = 1000;

describe('monumentHides', () => {
  it('an actor behind the monument and inside its drawn rectangle is hidden', () => {
    expect(monumentHides(rect, DEPTH, [{ sx: 20, sy: -120, depth: 900 }])).toBe(true);
  });
  it('an actor in front of the monument is never hidden, even inside the rectangle', () => {
    expect(monumentHides(rect, DEPTH, [{ sx: 20, sy: -10, depth: 1100 }])).toBe(false);
  });
  it('an actor behind but outside the rectangle is not hidden', () => {
    expect(monumentHides(rect, DEPTH, [{ sx: 400, sy: -120, depth: 900 }, { sx: 0, sy: -900, depth: 100 }])).toBe(false);
  });
  it('any one hidden actor is enough; none at all means opaque', () => {
    expect(monumentHides(rect, DEPTH, [{ sx: 400, sy: 0, depth: 900 }, { sx: -100, sy: -300, depth: 10 }])).toBe(true);
    expect(monumentHides(rect, DEPTH, [])).toBe(false);
    expect(MONUMENT_REVEAL_ALPHA).toBeGreaterThan(0);
    expect(MONUMENT_REVEAL_ALPHA).toBeLessThan(1);
  });
});

describe('wiring: collectDecorations gives a monument its screen rectangle, actors carry screen points', () => {
  const N = 32;
  const map = {
    chunkSize: N,
    loadedKeys: () => ['0,0'],
    decorationsInChunk: () => [
      { name: 'collapsed_tower', row: 12, col: 11, blocking: true, solid: true, monument: { w: 3, h: 3 } },
      { name: 'Tree', row: 5, col: 5, blocking: true },
    ],
  };
  const types = new Map([['collapsed_tower', { displayWidth: 360, displayHeight: 420 }], ['Tree', { displayWidth: 100, displayHeight: 140 }]]);

  it('only the monument drawable carries a reveal rectangle matching its drawn sprite', () => {
    const out = RenderSystem.collectDecorations(map, null, types);
    const tower = out.find((d) => d.ref.name === 'collapsed_tower');
    const tree = out.find((d) => d.ref.name === 'Tree');
    expect(tree.reveal).toBeUndefined();
    const s = worldToScreen(tower.ref.x + 50, tower.ref.y + 50);
    expect(tower.reveal).toEqual({ left: s.x - 180, right: s.x + 180, top: s.y - 420, bottom: s.y });
  });

  it('collectActors reports each actor centre in screen space too', () => {
    const [a] = RenderSystem.collectActors({ x: 1000, y: 1200, width: 64, height: 64 }, null, []);
    const s = worldToScreen(1032, 1232);
    expect(a).toEqual({ x: 1032, y: 1232, depth: depthKey(1032, 1232), sx: s.x, sy: s.y });
  });
});
