import { describe, it, expect } from 'vitest';
import { inputVector } from './Player.js';

describe('inputVector', () => {
  it('maps WASD/arrows to a direction vector', () => {
    expect(inputVector({ w: true })).toEqual({ dx: 0, dy: -1 });
    expect(inputVector({ arrowdown: true })).toEqual({ dx: 0, dy: 1 });
    expect(inputVector({ a: true, d: true })).toEqual({ dx: 0, dy: 0 }); // cancel
    expect(inputVector({ d: true, s: true })).toEqual({ dx: 1, dy: 1 });
    expect(inputVector({})).toEqual({ dx: 0, dy: 0 });
  });
});
