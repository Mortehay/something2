// Data hooks for the Tunnels tab over /api/admin/tunnels. Admin-only; the status poll runs
// only while a component using useTunnels is mounted (react-query stops it on unmount).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { authHeaders, apiFetch } from './src/js/net/auth.js';
import { API_URL } from '../../config.js';
import { POLL_MS } from './tunnelsModel.js';

const BASE = `${API_URL}/api/admin/tunnels`;
export const TUNNELS_KEY = ['tunnels'];
export const HISTORY_KEY = ['tunnels-history'];

async function call(path, method = 'GET', payload) {
  const res = await apiFetch(`${BASE}${path}`, payload === undefined
    ? { method, headers: authHeaders() }
    : { method, headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.hint || body?.message || body?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export const useTunnels = () => useQuery({
  queryKey: TUNNELS_KEY, queryFn: () => call(''), refetchInterval: POLL_MS, retry: false,
});

export const useTunnelHistory = (enabled = true) => useQuery({
  queryKey: HISTORY_KEY, queryFn: () => call('/history?days=30'), enabled, retry: false,
});

export function useTunnelToggle() {
  const qc = useQueryClient();
  const done = () => {
    qc.invalidateQueries({ queryKey: TUNNELS_KEY });
    qc.invalidateQueries({ queryKey: HISTORY_KEY });
  };
  const opts = { onSuccess: done, onError: (err) => { toast.error(err.message); done(); } };
  const start = useMutation({ mutationFn: ({ provider, mode }) => call(`/${provider}/start`, 'POST', { mode }), ...opts });
  const stop = useMutation({ mutationFn: ({ provider }) => call(`/${provider}/stop`, 'POST', {}), ...opts });
  return { start, stop };
}
