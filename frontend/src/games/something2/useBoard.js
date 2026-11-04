// SOMET-718. Data hooks for the Orange Pi tab over /api/board. The routes are
// admin-only and proxy to the helper on this PC: authHeaders() is required
// (a 401 without it signs the admin out), and 404 means the backend does not
// mount them at all (the board's own backend never does).
import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { authHeaders, apiFetch } from './src/js/net/auth.js';
import { API_URL } from '../../config.js';
import { POLL_MS, jobPollMs, jobRunning, MID_ACTION_TEXT } from './boardModel.js';

const BASE = `${API_URL}/api/board`;
export const STATUS_KEY = ['board-status'];
export const METRICS_KEY = ['board-metrics'];
export const JOB_KEY = ['board-job'];

async function call(path, method = 'GET') {
  const res = await apiFetch(`${BASE}${path}`, { method, headers: authHeaders() });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.message || body?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = body?.error;
    err.hint = body?.hint;
    err.midAction = Boolean(body?.midAction);
    throw err;
  }
  return body;
}

export const useBoardStatus = () => useQuery({
  queryKey: STATUS_KEY,
  queryFn: async () => {
    try { return await call('/status'); } catch (err) {
      if (err.status === 404) return { available: false, reason: 'not_mounted' };
      throw err;
    }
  },
  refetchInterval: POLL_MS,
  retry: false,
});

export const useBoardMetrics = (range) => useQuery({
  queryKey: [...METRICS_KEY, range],
  queryFn: () => call(`/metrics?range=${encodeURIComponent(range)}`),
  refetchInterval: POLL_MS,
  placeholderData: (prev) => prev,
  retry: false,
});

// null or the helper's job. Every 2 s while one runs, else every 15 s; when it
// finishes the status is fetched again (the commit and tunnels have changed).
export function useBoardJob() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: JOB_KEY,
    queryFn: () => call('/job'),
    refetchInterval: (q) => jobPollMs(q.state.data),
    retry: false,
  });
  const job = query.data;
  const running = useRef(null);
  useEffect(() => {
    if (!job) return;
    if (jobRunning(job)) { running.current = job.id; return; }
    if (running.current === job.id) {
      running.current = null;
      qc.invalidateQueries({ queryKey: STATUS_KEY });
    }
  }, [job, qc]);
  return query;
}

// Fetched on demand when Seed from git is pressed, never automatically: a
// preview is a snapshot and the dialog shows it as of the press.
export const useBoardPreview = () => useMutation({ mutationFn: () => call('/seed/preview') });

const PATHS = {
  update: '/update',
  seed: '/seed/apply',
  restart: '/restart',
  'cloudflare-start': '/tunnel/cloudflare/start',
  'cloudflare-stop': '/tunnel/cloudflare/stop',
  'ngrok-start': '/tunnel/ngrok/start',
  'ngrok-stop': '/tunnel/ngrok/stop',
};

export function useBoardAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (kind) => call(PATHS[kind], 'POST'),
    onSuccess: (job) => { qc.setQueryData(JOB_KEY, job); },
    onError: (err) => {
      // 409 busy: a job is already running; 503: the helper is down, and with
      // midAction it stopped after the request was sent, so the outcome is unknown.
      toast.error(err.midAction ? MID_ACTION_TEXT : err.message);
      qc.invalidateQueries({ queryKey: JOB_KEY });
      qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
}
