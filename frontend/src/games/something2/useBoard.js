// SOMET-718. Data hooks for the Orange Pi tab over /api/board. The routes are
// admin-only and proxy to the helper on this PC: authHeaders() is required
// (a 401 without it signs the admin out), and 404 means the backend does not
// mount them at all (the board's own backend never does).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { authHeaders, apiFetch } from './src/js/net/auth.js';
import { API_URL } from '../../config.js';
import { POLL_MS, jobPollMs, jobRunning, latestGate } from './boardModel.js';

const BASE = `${API_URL}/api/board`;
export const STATUS_KEY = ['board-status'];
export const METRICS_KEY = ['board-metrics'];
export const JOB_KEY = ['board-job'];
export const HISTORY_KEY = ['board-history'];
export const RELEASES_KEY = ['board-releases'];

export async function call(path, method = 'GET', payload) {
  const res = await apiFetch(`${BASE}${path}`, payload === undefined
    ? { method, headers: authHeaders() }
    : { method, headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
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

// The last finished actions (no logs); one entry, with its log, is fetched when a row is opened.
export const useBoardHistory = () => useQuery({
  queryKey: HISTORY_KEY, queryFn: () => call('/history'), refetchInterval: POLL_MS * 4, retry: false,
});
export const useBoardHistoryEntry = (id) => useQuery({
  queryKey: [...HISTORY_KEY, id], queryFn: () => call(`/history/${encodeURIComponent(id)}`), enabled: Boolean(id), retry: false,
});

// Newest first: { source: 'board' | 'laptop', releases }. The helper reads the board over ssh, so this is slow-polled.
export const useBoardReleases = () => useQuery({
  queryKey: RELEASES_KEY, queryFn: () => call('/releases'), refetchInterval: POLL_MS * 4, retry: false,
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
      qc.invalidateQueries({ queryKey: HISTORY_KEY });
      qc.invalidateQueries({ queryKey: RELEASES_KEY });
    }
  }, [job, qc]);
  return query;
}

// Fetched on demand when Seed from git is pressed (and again by "Preview
// again"), never automatically. A snapshot: loadedAt lets the dialog expire it.
// Only the reply to the newest request is kept, so a slow older one cannot
// overwrite a newer preview.
export function useBoardPreview() {
  const [preview, setPreview] = useState(null);
  const gate = useRef(latestGate());
  const load = useCallback(async () => {
    const id = gate.current.next();
    setPreview({ state: 'loading', startedAt: Date.now() });
    let next;
    try {
      next = { state: 'ready', data: await call('/seed/preview'), loadedAt: Date.now() };
    } catch (err) {
      next = { state: 'error', message: err.message };
    }
    if (gate.current.isCurrent(id)) setPreview(next);
  }, []);
  return { preview, load };
}

// A coarse clock (10 s steps) for the chart's time axis and the preview's age.
const subscribeClock = (cb) => { const t = setInterval(cb, 10000); return () => clearInterval(t); };
const clockNow = () => Math.floor(Date.now() / 10000) * 10000;
export const useClock = () => useSyncExternalStore(subscribeClock, clockNow, () => 0);

const PATHS = {
  update: '/update',
  seed: '/seed/apply',
  restart: '/restart',
  maps: '/maps/apply',
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
      // 409 busy: a job is already running; 503: the helper is down. A midAction
      // 503 (outcome unknown) is not toasted: the tab shows it inline, from this
      // mutation's error, until the next action starts.
      if (!err.midAction) toast.error(err.message);
      qc.invalidateQueries({ queryKey: JOB_KEY });
      qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
}
