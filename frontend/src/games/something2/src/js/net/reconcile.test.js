import { describe, it, expect } from 'vitest';
import { reconcile } from './reconcile.js';

// Stub map: walkable unless x >= wall.
function stubMap(wall = Infinity) {
  return { isWalkable: (wx) => wx < wall, speedAt: () => 1 };
}
const dims = { width: 0, height: 0, speed: 100 };

describe('reconcile', () => {
  it('drops acked inputs and replays the rest from the server position', () => {
    const buffer = [
      { seq: 1, dx: 1, dy: 0, dt: 0.1 },
      { seq: 2, dx: 1, dy: 0, dt: 0.1 },
      { seq: 3, dx: 1, dy: 0, dt: 0.1 },
    ];
    // Server acked seq 1 and reports the player at x=10 after that input.
    const out = reconcile({ x: 10, y: 0 }, 1, buffer, stubMap(), dims);
    // Replays seq 2 and 3: +10 each → x = 30.
    expect(out.x).toBeCloseTo(30, 5);
    expect(out.buffer.map((b) => b.seq)).toEqual([2, 3]);
  });

  it('a server-side block snaps the prediction back', () => {
    const buffer = [{ seq: 5, dx: 1, dy: 0, dt: 1 }]; // would move far east
    // Server says we're stuck at the wall (x=50) and acked seq 5.
    const out = reconcile({ x: 50, y: 0 }, 5, buffer, stubMap(50), dims);
    expect(out.x).toBe(50);        // no un-acked inputs to replay
    expect(out.buffer).toEqual([]);
  });

  it('replay respects walls (blocked axis does not advance)', () => {
    const buffer = [{ seq: 2, dx: 1, dy: 0, dt: 1 }];
    // base at x=45, wall at 50: center+step crosses wall → blocked.
    const out = reconcile({ x: 45, y: 0 }, 1, buffer, stubMap(50), dims);
    expect(out.x).toBe(45);
  });
});
