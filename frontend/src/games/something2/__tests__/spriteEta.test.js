import { describe, it, expect } from 'vitest';
import { etaLabel, durationLabel } from '../spriteEta.js';

describe('etaLabel', () => {
  it('shows a single figure when low, typical and high agree', () => {
    expect(etaLabel({ low: 2919, typical: 2919, high: 2919 })).toBe('~49 min');
  });
  it('shows a range using the durationLabel style', () => {
    const low = 3900, high = 7080;
    expect(etaLabel({ low, typical: 5000, high })).toBe(`${durationLabel(low)} – ${durationLabel(high)}`);
    expect(etaLabel({ low, typical: 5000, high })).toBe('~1 h 5 min – ~1 h 58 min');
  });
});
