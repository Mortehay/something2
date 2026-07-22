import { describe, it, expect } from 'vitest';
import * as hooks from '../useMapsAdmin.js';

describe('link hooks', () => {
  it('exports useWorldLinks/useSetLink/useClearLink', () => {
    expect(typeof hooks.useWorldLinks).toBe('function');
    expect(typeof hooks.useSetLink).toBe('function');
    expect(typeof hooks.useClearLink).toBe('function');
  });
});
