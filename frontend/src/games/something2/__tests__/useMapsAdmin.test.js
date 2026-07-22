import { describe, it, expect } from 'vitest';
import * as hooks from '../useMapsAdmin.js';

describe('useMapsAdmin exports', () => {
  it('exposes update/regenerate/reroll hooks', () => {
    expect(typeof hooks.useUpdateWorld).toBe('function');
    expect(typeof hooks.useRegenerateWorld).toBe('function');
    expect(typeof hooks.useRerollCreatures).toBe('function');
  });
});
