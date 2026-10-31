import { describe, it, expect } from 'vitest';
import { trapsFromFrame, TRAP_STYLE } from '../worldTraps.js';

describe('trapsFromFrame', () => {
  it('maps the wire shape to renderer fields', () => {
    const out = trapsFromFrame({ traps: [{ k: 'bear', x: 10, y: 20, r: 60, ms: 5000 }] });
    expect(out).toEqual([{ kind: 'bear', x: 10, y: 20, radius: 60, ms: 5000 }]);
  });

  it('is empty when the frame has no traps (the frame replaces the list)', () => {
    expect(trapsFromFrame({})).toEqual([]);
    expect(trapsFromFrame(null)).toEqual([]);
  });

  it('drops unknown kinds and non-finite or empty geometry', () => {
    const out = trapsFromFrame({
      traps: [
        { k: 'laser', x: 1, y: 1, r: 5, ms: 1 },
        { k: 'tar', x: NaN, y: 1, r: 5, ms: 1 },
        { k: 'tar', x: 1, y: 1, r: 0, ms: 1 },
        null,
        { k: 'tar', x: 1, y: 1, r: 120, ms: -4 },
      ],
    });
    expect(out).toEqual([{ kind: 'tar', x: 1, y: 1, radius: 120, ms: 0 }]);
  });

  it('has a style for every kind', () => {
    for (const k of ['bear', 'explosive', 'tar']) expect(TRAP_STYLE[k].color).toMatch(/^#/);
  });
});
