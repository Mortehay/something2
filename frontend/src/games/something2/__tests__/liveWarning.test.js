import { describe, it, expect } from 'vitest';
import { liveWarningFromBody, liveWarningFromHeader, DEFAULT_LIVE_WARNING } from '../liveWarning.js';

describe('liveWarningFromBody', () => {
  it('returns the message when the response body carries a liveWarning string', () => {
    const data = { id: 1, name: 'BoundedArena', liveWarning: 'a player is connected...' };
    expect(liveWarningFromBody(data)).toBe('a player is connected...');
  });

  it('returns undefined when the key is absent (the common case)', () => {
    expect(liveWarningFromBody({ id: 1, name: 'BoundedArena' })).toBeUndefined();
  });

  it('returns undefined for a falsy/malformed body instead of throwing', () => {
    expect(liveWarningFromBody(null)).toBeUndefined();
    expect(liveWarningFromBody(undefined)).toBeUndefined();
    expect(liveWarningFromBody({})).toBeUndefined();
    // Defends against a non-string liveWarning (e.g. `true`) reaching toast().
    expect(liveWarningFromBody({ liveWarning: true })).toBeUndefined();
  });
});

describe('liveWarningFromHeader', () => {
  it('maps the header value "true" to the standard message', () => {
    expect(liveWarningFromHeader('true')).toBe(DEFAULT_LIVE_WARNING);
  });

  it('returns undefined when the header is absent or anything else', () => {
    expect(liveWarningFromHeader(null)).toBeUndefined();
    expect(liveWarningFromHeader(undefined)).toBeUndefined();
    expect(liveWarningFromHeader('false')).toBeUndefined();
    expect(liveWarningFromHeader('')).toBeUndefined();
  });
});
