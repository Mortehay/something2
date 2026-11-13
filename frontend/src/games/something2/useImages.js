// Data hooks for the Images tab over /api/admin/images. Admin only. The run poll (1 s) is on only
// while a run is going, so an idle tab makes no steady traffic.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { authHeaders, apiFetch } from './src/js/net/auth.js';
import { API_URL } from '../../config.js';
import { runFinished } from './imagesModel.js';

const BASE = `${API_URL}/api/admin/images`;
export const IMAGES_KEY = ['images'];
export const KINDS_KEY = ['images-kinds'];
export const RUN_KEY = ['images-run'];
export const OPS_KEY = ['images-operations'];
export const RUN_POLL_MS = 1000;

async function call(path, method = 'GET', payload) {
  const res = await apiFetch(`${BASE}${path}`, payload === undefined
    ? { method, headers: authHeaders() }
    : { method, headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export function useImages({ kind, state, minBytes }) {
  const q = new URLSearchParams();
  if (kind) q.set('kind', kind);
  if (state) q.set('state', state);
  if (minBytes > 0) q.set('minBytes', String(minBytes));
  const qs = q.toString();
  return useQuery({ queryKey: [...IMAGES_KEY, kind || '', state || '', minBytes || 0], queryFn: () => call(qs ? `/?${qs}` : '/'), retry: false });
}

export const useImageKinds = () => useQuery({ queryKey: KINDS_KEY, queryFn: () => call('/kinds'), retry: false, staleTime: 60_000 });

export const useImageOperations = (batchId, enabled = true) => useQuery({
  queryKey: [...OPS_KEY, batchId || ''],
  queryFn: () => call(`/operations?limit=200${batchId ? `&batch_id=${encodeURIComponent(batchId)}` : ''}`),
  enabled, retry: false,
});

export function useImageRun() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: RUN_KEY,
    queryFn: async () => {
      const prev = qc.getQueryData(RUN_KEY);
      const v = await call('/runs/current');
      // A run that just ended moved rows between states: refresh the table and the log once,
      // not on every later refetch of the finished run (the list is heavy).
      if (runFinished(prev, v)) {
        qc.invalidateQueries({ queryKey: IMAGES_KEY });
        qc.invalidateQueries({ queryKey: OPS_KEY });
      }
      return v;
    },
    refetchInterval: (q) => (q.state.data?.status === 'running' ? RUN_POLL_MS : false),
    retry: false,
  });
}

export function useImageActions() {
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: IMAGES_KEY });
    qc.invalidateQueries({ queryKey: RUN_KEY });
    qc.invalidateQueries({ queryKey: OPS_KEY });
  };
  const onError = (err) => { toast.error(err.message); refresh(); };
  const startRun = useMutation({ mutationFn: (body) => call('/runs', 'POST', body), onSuccess: refresh, onError });
  const cancel = useMutation({ mutationFn: () => call('/runs/current/cancel', 'POST', {}), onSuccess: refresh, onError });
  const reactivate = useMutation({
    mutationFn: (subject) => call('/reactivate', 'POST', { subject }),
    onSuccess: refresh,
    onError: (err) => onError(err.message === 'stale' ? new Error('The original changed: use Re-shrink') : err),
  });
  return { startRun, cancel, reactivate };
}
