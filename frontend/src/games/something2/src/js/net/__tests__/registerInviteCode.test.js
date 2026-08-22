import { describe, it, expect, vi, afterEach } from 'vitest';
import { register, login } from '../auth.js';

// SOMET-381. The client must be able to talk to an invite-gated server without
// knowing that it is one: it sends a code when the user typed one, and sends
// nothing extra otherwise. An open server ignores the field either way.

function captureFetch(status = 200, body = { token: 't', user: {} }) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: status < 400, status, json: async () => body };
  });
  return calls;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('register() invite code', () => {
  it('sends the code when one is given', async () => {
    const calls = captureFetch();
    await register('http://api', 'alice', 'password123', 'ABCD-EFGH-JKLM');
    expect(calls[0].body).toEqual({
      inviteCode: 'ABCD-EFGH-JKLM', username: 'alice', password: 'password123',
    });
  });

  it('omits the field entirely when no code is given', async () => {
    const calls = captureFetch();
    await register('http://api', 'alice', 'password123');
    // Not `inviteCode: ""` -- an empty string is a value the server would have
    // to special-case, and an open server should see exactly what it saw before
    // this feature existed.
    expect(calls[0].body).toEqual({ username: 'alice', password: 'password123' });
    expect('inviteCode' in calls[0].body).toBe(false);
  });

  it('trims a pasted code and treats whitespace-only as absent', async () => {
    const calls = captureFetch();
    await register('http://api', 'alice', 'password123', '  ABCD-EFGH-JKLM \n');
    expect(calls[0].body.inviteCode).toBe('ABCD-EFGH-JKLM');

    await register('http://api', 'bob', 'password123', '   ');
    expect('inviteCode' in calls[1].body).toBe(false);
  });

  it('never lets the extra payload overwrite the credentials', async () => {
    // The spread is ordered so credentials win. If that ever flips, a crafted
    // "code" could change which account is created.
    const calls = captureFetch();
    await register('http://api', 'alice', 'password123', 'CODE');
    expect(calls[0].body.username).toBe('alice');
    expect(calls[0].body.password).toBe('password123');
  });

  it('login never sends an invite code', async () => {
    const calls = captureFetch();
    await login('http://api', 'alice', 'password123');
    expect(calls[0].body).toEqual({ username: 'alice', password: 'password123' });
  });

  it('surfaces the server error message so an invite failure is legible', async () => {
    captureFetch(403, { error: 'invalid or already-used invite code' });
    await expect(register('http://api', 'alice', 'password123', 'BAD'))
      .rejects.toThrow(/invalid or already-used invite code/);
  });
});
