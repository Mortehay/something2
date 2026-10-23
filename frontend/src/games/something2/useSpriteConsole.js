import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { API_URL } from '../../config.js';
import { apiFetch, authHeaders } from './src/js/net/auth.js';
import { queueIsLive, runJustEnded } from './spriteSelection.js';

const SUBJECTS_KEY = ['sprite-admin-subjects'];
const JOBS_KEY = ['sprite-admin-jobs'];

async function jsonRequest(path, init = {}) {
  const res = await apiFetch(`${API_URL}/api/sprite-admin${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Sprite request failed');
  return json;
}

export function useSpriteSubjects({ live = false } = {}) {
  const query = useQuery({
    queryKey: SUBJECTS_KEY,
    refetchInterval: live ? 5000 : false,
    queryFn: () => jsonRequest('/subjects'),
  });
  return { subjects: query.data?.subjects || [], ...query };
}

export function useActionCatalog() {
  const query = useQuery({
    queryKey: ['spriteAdmin', 'actionCatalog'],
    staleTime: 60_000,
    retry: false,
    queryFn: () => jsonRequest('/action-catalog'),
  });
  return { catalog: query.data || null, isLoading: query.isLoading, error: query.error };
}

export function useSpriteQueue() {
  const query = useQuery({
    queryKey: JOBS_KEY,
    refetchInterval: (q) => {
      const data = q.state.data;
      return data?.run?.running || data?.stats?.queued || data?.stats?.running ? 1500 : false;
    },
    queryFn: () => jsonRequest('/jobs'),
  });
  const stats = query.data?.stats || {};
  const run = query.data?.run || null;
  // Subjects stop polling once the queue is idle; refresh them once when a run
  // ends so the last row's pill and popup show its final state.
  const qc = useQueryClient();
  const live = queueIsLive({ run, stats });
  const wasLive = useRef(live);
  useEffect(() => {
    if (runJustEnded(wasLive.current, live)) qc.invalidateQueries({ queryKey: SUBJECTS_KEY });
    wasLive.current = live;
  }, [live, qc]);
  return { stats, jobs: query.data?.jobs || [], run };
}

// `path` may be a function of the value; method defaults to POST (DELETE sends no body).
function mutation(path, success, body = (value) => value, method = 'POST') {
  return function useSpriteMutation() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (value) => jsonRequest(typeof path === 'function' ? path(value) : path, {
        method,
        ...(method === 'POST' ? { body: JSON.stringify(body(value)) } : {}),
      }),
      onSuccess: (data, value) => {
        if (success) toast.success(typeof success === 'function' ? success(data, value) : success);
        qc.invalidateQueries({ queryKey: SUBJECTS_KEY });
        qc.invalidateQueries({ queryKey: JOBS_KEY });
        qc.invalidateQueries({ queryKey: ['entityTypes'] });
        qc.invalidateQueries({ queryKey: ['mapConfig'] });
      },
      onError: (err) => toast.error(err.message),
    });
  };
}

export const useQueueSprites = mutation('/jobs',
  (data) => [
    data.queued || !data.updated ? `${data.queued} sprite job${data.queued === 1 ? '' : 's'} queued` : '',
    data.updated ? `${data.updated} queued job${data.updated === 1 ? '' : 's'} updated` : '',
    data.skipped ? `${data.skipped} running, unchanged` : '',
  ].filter(Boolean).join(' · '),
  // prop_fx (Props v2) is only present when props are selected.
  ({ targets, actions, frames, prop_fx }) => ({ targets, actions, frames, prop_fx }));
export const useStartSpriteBatch = mutation('/jobs/dispatch', 'Sprite batch started', () => ({}));
export const useStopSpriteBatch = mutation('/jobs/stop', 'Sprite batch stopping', () => ({}));
export const useHaltSpriteBatch = mutation('/jobs/halt', 'Sprite batch halting: the current sheet goes back to the queue', () => ({}));
export const useRescueSpriteJobs = mutation('/jobs/requeue-stale',
  (data) => `${data.requeued} stranded job${data.requeued === 1 ? '' : 's'} rescued`, () => ({}));
export const useClearSpriteJobs = mutation('/jobs/clear',
  (data) => `${data.cleared} queued job${data.cleared === 1 ? '' : 's'} cleared`, () => ({}));
export const useApproveSpriteJobs = mutation('/jobs/approve',
  (data) => `${data.approved.length} sprite${data.approved.length === 1 ? '' : 's'} approved`,
  (jobIds) => ({ job_ids: jobIds }));

export const useRedrawFrames = mutation('/jobs/redraw',
  (_data, { frames }) => `${frames.length} frame${frames.length === 1 ? '' : 's'} queued for redraw`,
  ({ jobId, frames }) => ({ job_id: jobId, frames }));
export const useDiscardRedraw = mutation((id) => `/jobs/${id}/redraw`, 'Redraw discarded', undefined, 'DELETE');

// `names` maps a skipped label (a selected row's id) to its display name; an unknown label is shown as is.
export const useDeleteGenerated = mutation('/jobs/delete-generated',
  (data, { names = {} } = {}) => {
    const skipped = data.skipped_running || [];
    const head = `Deleted ${data.deleted_jobs} job${data.deleted_jobs === 1 ? '' : 's'} from ${data.subjects} subject${data.subjects === 1 ? '' : 's'}`;
    return skipped.length
      ? `${head} · skipped running: ${skipped.map((label) => names[label] || label).join(', ')} (Halt or Rescue stranded first)`
      : head;
  },
  ({ targets }) => ({ targets }));
export const useClearConcepts = mutation('/concepts/clear',
  (data) => `New concept for ${data.cleared} subject${data.cleared === 1 ? '' : 's'}`,
  ({ targets }) => ({ targets }));
