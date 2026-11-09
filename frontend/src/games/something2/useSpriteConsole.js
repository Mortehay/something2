import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { API_URL } from '../../config.js';
import { apiFetch, authHeaders } from './src/js/net/auth.js';
import { goodFramesResult } from './frameRedraw.js';
import { queueIsLive, runJustEnded } from './spriteSelection.js';

export const SUBJECTS_KEY = ['sprite-admin-subjects'];
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

// SOMET-712: enabled sprite connectors (active first) with per-connector seconds per cell.
export function useSpriteConnectors() {
  const query = useQuery({
    queryKey: ['spriteAdmin', 'connectors'],
    staleTime: 60_000,
    queryFn: () => jsonRequest('/connectors'),
  });
  return query.data || [];
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

export function useBoxQueue() {
  const query = useQuery({
    queryKey: ['spriteAdmin', 'boxQueue'],
    staleTime: 15_000,
    refetchInterval: 15_000,
    retry: false,
    queryFn: () => jsonRequest('/box-queue'),
  });
  return { boxQueue: query.data || null };
}

export const EFFECTS_KEY = ['sprite-admin-effects'];

export function useEffectSprites() {
  const query = useQuery({
    queryKey: EFFECTS_KEY,
    refetchInterval: (q) => ((q.state.data?.subjects || []).some((s) => s.job && (s.job.status === 'queued' || s.job.status === 'running')) ? 5000 : false),
    queryFn: () => jsonRequest('/effects'),
  });
  return { subjects: query.data?.subjects || [], eta: query.data?.eta || {}, dispatcher: query.data?.dispatcher || null, ...query };
}

export function useSpriteQueue() {
  const query = useQuery({
    queryKey: JOBS_KEY,
    refetchInterval: (q) => {
      const data = q.state.data;
      return data?.run?.running || data?.stats?.queued || data?.stats?.running || data?.box_cancels?.length ? 1500 : false;
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
  return { stats, jobs: query.data?.jobs || [], run, boxCancels: query.data?.box_cancels || [] };
}

// `path` may be a function of the value; method defaults to POST (DELETE sends no body).
function mutation(path, success, body = (value) => value, method = 'POST', extraKeys = []) {
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
        qc.invalidateQueries({ queryKey: ['sprite-sheet-manifest'] });
        qc.invalidateQueries({ queryKey: ['entityTypes'] });
        qc.invalidateQueries({ queryKey: ['mapConfig'] });
        for (const queryKey of extraKeys) qc.invalidateQueries({ queryKey });
      },
      onError: (err) => toast.error(err.message),
    });
  };
}

// POST /jobs body. Whitelists the queue fields: prop_fx (Props v2) is only set
// when props are selected, directions and cell only for creatures. Undefined keys are
// dropped by JSON.stringify, so an absent option is omitted, never sent as null.
export function queueJobsBody({ targets, actions, frames, prop_fx, directions, cell, redraw_actions, provider_id, sampling, sheet_method, quality_checks }) {
  return { targets, actions, frames, prop_fx, directions, cell, redraw_actions, provider_id, sampling, sheet_method, quality_checks };
}

export const useSetBodyPlan = mutation((v) => `/body-plans/${v.id}`, null, (v) => ({ body_plan: v.body_plan }));

// One request per chunk, so progress shows and a failure keeps what was already saved.
export function useDetectBodies() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ chunks, onProgress }) => {
      let detected = 0;
      let undecided = 0;
      for (const [i, ids] of chunks.entries()) {
        const r = await jsonRequest('/body-plans/detect', { method: 'POST', body: JSON.stringify({ entity_ids: ids }) });
        detected += Object.keys(r.detected || {}).length;
        undecided += (r.undecided || []).length;
        onProgress?.(i + 1, chunks.length);
      }
      return { detected, undecided };
    },
    onSuccess: ({ detected, undecided }) => toast.success(`${detected} bodies detected${undecided ? `, ${undecided} left undecided` : ''}`),
    onError: (err) => toast.error(err.message),
    onSettled: () => qc.invalidateQueries({ queryKey: SUBJECTS_KEY }),
  });
}

export const useQueueSprites = mutation('/jobs',
  (data) => [
    data.queued || !data.updated ? `${data.queued} sprite job${data.queued === 1 ? '' : 's'} queued` : '',
    data.updated ? `${data.updated} queued job${data.updated === 1 ? '' : 's'} updated` : '',
    data.skipped ? `${data.skipped} running, unchanged` : '',
  ].filter(Boolean).join(' · '),
  queueJobsBody);
// Force regenerate (SOMET-698): same body as queue; refused subjects come back in the response.
export const useForceRegenerate = mutation('/jobs/force',
  (data) => `${data.queued} subject${data.queued === 1 ? '' : 's'} force-queued${data.refused?.length ? ` · ${data.refused.length} refused` : ''}`,
  queueJobsBody);
export const useStartSpriteBatch = mutation('/jobs/dispatch', 'Sprite batch started', () => ({}));
export const useStopSpriteBatch = mutation('/jobs/stop', 'Sprite batch stopping', () => ({}));
export const useHaltSpriteBatch = mutation('/jobs/halt', 'Sprite batch halting: the current sheet goes back to the queue', () => ({}));
export const useRetryBoxCancel = mutation((id) => `/jobs/box-cancels/${id}/retry`, 'Cancel re-sent to the GPU box', () => ({}));
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
// Use good frames (SOMET-701): the server edits the stored sheet in place.
export const useUseGoodFrames = mutation(({ jobId }) => `/jobs/${jobId}/use-good-frames`,
  (data) => goodFramesResult(data), () => ({}));
export const useDiscardRedraw = mutation((id) => `/jobs/${id}/redraw`, 'Redraw discarded', undefined, 'DELETE');

// `names` maps a skipped label (a selected row's id) to its display name; an unknown label is shown as is.
function skippedNote(data, names = {}) {
  const skipped = data.skipped_running || [];
  return skipped.length
    ? ` · skipped running: ${skipped.map((label) => names[label] || label).join(', ')} (Halt or Rescue stranded first)`
    : '';
}
export const useDeleteGenerated = mutation('/jobs/delete-generated',
  (data, { names } = {}) => `Deleted ${data.deleted_jobs} job${data.deleted_jobs === 1 ? '' : 's'} from ${data.subjects} subject${data.subjects === 1 ? '' : 's'}${skippedNote(data, names)}`,
  ({ targets }) => ({ targets }));
export const useClearConcepts = mutation('/concepts/clear',
  (data, { names } = {}) => `New concept for ${data.cleared} subject${data.cleared === 1 ? '' : 's'}${skippedNote(data, names)}`,
  ({ targets }) => ({ targets }));

export const useQueueEffects = mutation('/effects/jobs', (d) => `Queued ${d.queued.length} effect${d.queued.length === 1 ? '' : 's'}${d.skipped.length ? `, skipped ${d.skipped.length}` : ''}`, (v) => ({ targets: v.targets }), 'POST', [EFFECTS_KEY]);
export const useApproveEffect = mutation((v) => `/effects/jobs/${v.id}/approve`, 'Effect approved', () => ({}), 'POST', [EFFECTS_KEY]);
export const useResumeEffects = mutation('/effects/dispatch', 'Effect queue resumed', () => ({}), 'POST', [EFFECTS_KEY]);
