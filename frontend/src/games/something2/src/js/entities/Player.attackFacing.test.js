import { describe, it, expect } from 'vitest';
import { Player } from './Player.js';

// SOMET-574 AC1 + AC2 (client prediction). While an attack is in flight the
// local player keeps walking at full rate (no stutter) but does NOT turn to
// the walk direction -- the facing the attack set toward the cursor is held.
// Once the attack window ends, movement steers facing again.
const openMap = { isWalkable: () => true, speedAt: () => 1 };

function player() {
  const p = new Player();
  p.x = 0; p.y = 0;
  return p;
}

describe('Player.update while attacking', () => {
  it('keeps the attack facing while moving, and still moves at the normal rate', () => {
    const idle = player();
    idle.update(0.05, { a: true }, openMap, false);
    const p = player();
    p.facing = 'e';
    p.update(0.05, { a: true }, openMap, true);
    expect(p.facing).toBe('e');
    // Same displacement as a non-attacking step: attacking does not slow or
    // freeze the predicted movement.
    expect(p.x).toBeCloseTo(idle.x, 9);
    expect(p.y).toBeCloseTo(idle.y, 9);
    expect(p.x).toBeLessThan(0);
  });

  it('turns to the movement direction once the attack window has ended', () => {
    const p = player();
    p.facing = 'e';
    p.update(0.05, { a: true }, openMap, false);
    expect(p.facing).toBe('sw');
  });
});
