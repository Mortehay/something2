import { describe, it, expect } from 'vitest';
import { inputVector } from './Player.js';

// The world is isometric, so a key means a SCREEN direction, not a world axis
// (894fd21). W is "up the screen", which is up-and-left in world coordinates:
// dx -1, dy -1. This file asserted the old cartesian mapping and went red the
// moment that landed, because that commit changed Player.js and no test with
// it -- the assertions here are the ones that had to move.
describe('inputVector', () => {
  it('maps each key to its isometric screen direction', () => {
    expect(inputVector({ w: true })).toEqual({ dx: -1, dy: -1 });   // up-screen
    expect(inputVector({ s: true })).toEqual({ dx: 1, dy: 1 });     // down-screen
    expect(inputVector({ a: true })).toEqual({ dx: -1, dy: 1 });    // left-screen
    expect(inputVector({ d: true })).toEqual({ dx: 1, dy: -1 });    // right-screen
  });

  it('treats the arrow keys as the same four directions', () => {
    expect(inputVector({ arrowup: true })).toEqual(inputVector({ w: true }));
    expect(inputVector({ arrowdown: true })).toEqual(inputVector({ s: true }));
    expect(inputVector({ arrowleft: true })).toEqual(inputVector({ a: true }));
    expect(inputVector({ arrowright: true })).toEqual(inputVector({ d: true }));
  });

  it('cancels opposite keys and holds still for none', () => {
    expect(inputVector({ a: true, d: true })).toEqual({ dx: 0, dy: 0 });
    expect(inputVector({ w: true, s: true })).toEqual({ dx: 0, dy: 0 });
    expect(inputVector({})).toEqual({ dx: 0, dy: 0 });
  });

  it('combines two adjacent keys into a world axis', () => {
    // W and D are adjacent on screen; their sum is straight along -y in the
    // world, which is what makes the four diagonals reachable at all.
    expect(inputVector({ w: true, d: true })).toEqual({ dx: 0, dy: -2 });
    expect(inputVector({ s: true, a: true })).toEqual({ dx: 0, dy: 2 });
  });
});
