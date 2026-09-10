import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWorldPreview } from './worldPreviewClient.js';
import { storeToken, clearToken } from './auth.js';

// A syntactically real JWT whose exp is far in the future -- getStoredToken()
// parses and expiry-checks the token, so a placeholder string would be dropped
// as expired and the header would silently not be sent.
function futureToken() {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

afterEach(() => { vi.restoreAllMocks(); clearToken(); });

describe('fetchWorldPreview', () => {
  it('GETs the preview endpoint for the world and returns JSON', async () => {
    const body = { world_id: 'w1', data: [['grass', 'water']] };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    const res = await fetchWorldPreview('w1');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/worlds\/w1\/preview$/),
      expect.anything(),
    );
    expect(res).toEqual(body);
  });

  // SOMET-559: /preview is behind playerGuard. Without the Authorization
  // header every preview 401s, so this asserts the credential is actually on
  // the wire rather than trusting that the import exists.
  it('sends the stored bearer token', async () => {
    const token = futureToken();
    storeToken(token);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    await fetchWorldPreview('w1');
    const [, init] = global.fetch.mock.calls[0];
    expect(init.headers.Authorization).toBe(`Bearer ${token}`);
  });

  it('omits Authorization when signed out rather than sending "Bearer null"', async () => {
    clearToken();
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    await fetchWorldPreview('w1');
    const [, init] = global.fetch.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('throws on a non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchWorldPreview('nope')).rejects.toThrow(/HTTP 404/);
  });
});
