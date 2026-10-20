import { describe, it, expect, vi, beforeEach } from 'vitest';

// SOMET-642 Review Focus 5: the helper going down mid-click is a clear toast
// and a status refetch (the strip flips to unavailable), not a crash.
const apiFetch = vi.fn();
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('./../src/js/net/auth.js', () => ({ apiFetch: (...a) => apiFetch(...a), authHeaders: () => ({}) }));
vi.mock('../../../config.js', () => ({ API_URL: '' }));
vi.mock('react-hot-toast', () => ({ default: toast }));
const { gitRequest, gitActionHandlers, GIT_KEY } = await import('../useSeedExport.js');

const reply = (status, json) => apiFetch.mockResolvedValue({ ok: status < 400, status, json: async () => json });
beforeEach(() => { apiFetch.mockReset(); toast.error.mockReset(); toast.success.mockReset(); });

describe('git actions when the helper is down', () => {
  it('a 503 rejects with the make git-helper copy', async () => {
    reply(503, { error: 'helper_unavailable', message: 'unreachable', hint: 'Run make git-helper on this PC' });
    await expect(gitRequest('push')).rejects.toMatchObject({
      message: 'Git buttons need the git helper: run `make git-helper`', code: 'helper_unavailable', status: 503,
    });
  });
  it('a 409 refusal surfaces the backend message', async () => {
    reply(409, { error: 'behind', message: 'Behind origin: pull first' });
    await expect(gitRequest('push')).rejects.toMatchObject({ message: 'Behind origin: pull first', code: 'behind' });
  });
  it('a 502 git failure carries the op and git output', async () => {
    reply(502, { ok: false, op: 'pull', output: 'fatal: Not possible to fast-forward, aborting.', status: {} });
    await expect(gitRequest('pull')).rejects.toMatchObject({
      message: 'git pull failed: fatal: Not possible to fast-forward, aborting.', code: 'git_failed', status: 502,
    });
  });
  it('commit sends the message as the body', async () => {
    reply(200, { ok: true });
    await gitRequest('commit', 'seed export: a');
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ message: 'seed export: a' });
  });
  it('onError toasts and refetches the git status', () => {
    const qc = { invalidateQueries: vi.fn() };
    gitActionHandlers(qc).onError(new Error('Git buttons need the git helper: run `make git-helper`'));
    expect(toast.error).toHaveBeenCalledWith('Git buttons need the git helper: run `make git-helper`', expect.objectContaining({ style: { whiteSpace: 'pre-line' } }));
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: GIT_KEY });
  });
});
