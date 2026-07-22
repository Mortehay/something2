import { describe, it, expect, vi } from 'vitest';
import { WorldAuthorityClient } from '../WorldAuthorityClient.js';

describe('WorldAuthorityClient transition frame', () => {
  it('routes a transition message to onTransition', () => {
    const onTransition = vi.fn();
    const c = new WorldAuthorityClient({ url: 'ws://x', token: 't', onTransition });
    const msg = { type: 'transition', toWorldId: 'B', arriveX: 1, arriveY: 2 };
    c._handleMessage(msg);
    expect(onTransition).toHaveBeenCalledWith(msg);
  });
});
