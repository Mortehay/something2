import { describe, it, expect } from 'vitest';
import { deriveAuth } from '../authState.js';

// Mirrors what backend/src/auth/tokens.js signs: { user_id, username, role, tv }.
// Padding is stripped, exactly as jsonwebtoken emits it.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const makeToken = (payload) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;

describe('deriveAuth', () => {
  it('reports signed out for a null token', () => {
    expect(deriveAuth(null)).toEqual({ authed: false, isAdmin: false, username: null });
  });

  it('reports signed out for a malformed token rather than throwing', () => {
    expect(deriveAuth('not-a-jwt')).toEqual({ authed: false, isAdmin: false, username: null });
  });

  it('reports a non-admin player as authed but not admin', () => {
    const t = makeToken({ user_id: 3, username: 'player1', role: 'user', tv: 1 });
    expect(deriveAuth(t)).toEqual({ authed: true, isAdmin: false, username: 'player1' });
  });

  it('reports an admin as authed and admin', () => {
    const t = makeToken({ user_id: 1, username: 'admin', role: 'admin', tv: 4 });
    expect(deriveAuth(t)).toEqual({ authed: true, isAdmin: true, username: 'admin' });
  });

  it('does not treat a role that merely contains "admin" as admin', () => {
    const t = makeToken({ user_id: 9, username: 'x', role: 'not-admin', tv: 1 });
    expect(deriveAuth(t).isAdmin).toBe(false);
  });
});
