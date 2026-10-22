import { describe, it, expect } from 'vitest';
import { resolveMove } from '../movement.js';
import { ChunkedMap } from '../../core/ChunkedMap.js';

// Client mirror of backend tests/scenery_trunk_collision.test.js. Spec
// verification: "blocked at the trunk". The corner-only face test let a trunk
// narrower than the 32px footprint face slip between the two corner samples;
// faceClear now also asks ChunkedMap.segmentHitsBlocker.
const TILE = 100;
const PLAYER = { width: 64, height: 64, speed: 200 };
const HALF = 16;
const ANCHOR = { x: 2 * TILE + 50, y: 2 * TILE + 50 };

function mapWithCircle(r) {
  const grid = Array.from({ length: 16 }, () => Array(16).fill('grass'));
  const map = new ChunkedMap(16, { grass: { walkable: true, speed: 1 } });
  map.setChunk(0, 0, grid, [{ name: 'Trunk', row: 2, col: 2, ox: 50, oy: 50, blocking: true, radius: r, layer: 'feature' }]);
  return map;
}

function walk(map, cx, cy, dx, dy, steps = 120) {
  let a = { ...PLAYER, x: cx - 32, y: cy - 32 };
  for (let i = 0; i < steps; i++) {
    const r = resolveMove(map, a, dx, dy, 1 / 60);
    a = { ...a, x: r.x, y: r.y };
  }
  return { cx: a.x + 32, cy: a.y + 32 };
}

const rectDist = (p) => Math.hypot(
  Math.max(Math.abs(ANCHOR.x - p.cx) - HALF, 0), Math.max(Math.abs(ANCHOR.y - p.cy) - HALF, 0));

const DIRS = [
  { name: 'east', dx: 1, dy: 0, start: { cx: ANCHOR.x - 60, cy: ANCHOR.y } },
  { name: 'west', dx: -1, dy: 0, start: { cx: ANCHOR.x + 60, cy: ANCHOR.y } },
  { name: 'south', dx: 0, dy: 1, start: { cx: ANCHOR.x, cy: ANCHOR.y - 60 } },
  { name: 'north', dx: 0, dy: -1, start: { cx: ANCHOR.x, cy: ANCHOR.y + 60 } },
];

describe('client trunk collision', () => {
  for (const r of [10, 14]) {
    for (const d of DIRS) {
      it(`head-on ${d.name} at a radius-${r} trunk stops before it`, () => {
        const gap = rectDist(walk(mapWithCircle(r), d.start.cx, d.start.cy, d.dx, d.dy));
        expect(gap).toBeGreaterThan(r);
        expect(gap).toBeLessThan(r + 0.5);
      });
    }
    it(`a sideways graze clearing a radius-${r} trunk by 1px still passes`, () => {
      for (const side of [-1, 1]) {
        const lateral = HALF + r + 1;
        const end = walk(mapWithCircle(r), ANCHOR.x - 60, ANCHOR.y + side * lateral, 1, 0);
        expect(end.cx).toBeGreaterThan(ANCHOR.x + 60);
        expect(end.cy).toBe(ANCHOR.y + side * lateral);
      }
    });
  }
});
