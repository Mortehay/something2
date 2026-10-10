import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { API_URL } from '../../config.js';
import { apiFetch, authHeaders } from './src/js/net/auth.js';

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

export function useSpriteQueue() {
  const query = useQuery({
    queryKey: JOBS_KEY,
    refetchInterval: (q) => {
      const data = q.state.data;
      return data?.run?.running || data?.stats?.queued || data?.stats?.running ? 1500 : false;
    },
    queryFn: () => jsonRequest('/jobs'),
  });
  return { stats: query.data?.stats || {}, jobs: query.data?.jobs || [], run: query.data?.run || null };
}

function mutation(path, success, body = (value) => value) {
  return function useSpriteMutation() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (value) => jsonRequest(path, {
        method: 'POST',
        body: JSON.stringify(body(value)),
      }),
      onSuccess: (data) => {
        if (success) toast.success(typeof success === 'function' ? success(data) : success);
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
  (data) => `${data.queued} sprite job${data.queued === 1 ? '' : 's'} queued`,
  (entityIds) => ({ entity_ids: entityIds }));
export const useStartSpriteBatch = mutation('/jobs/dispatch', 'Sprite batch started', () => ({}));
export const useStopSpriteBatch = mutation('/jobs/stop', 'Sprite batch stopping', () => ({}));
export const useRescueSpriteJobs = mutation('/jobs/requeue-stale',
  (data) => `${data.requeued} stranded job${data.requeued === 1 ? '' : 's'} rescued`, () => ({}));
export const useClearSpriteJobs = mutation('/jobs/clear',
  (data) => `${data.cleared} queued job${data.cleared === 1 ? '' : 's'} cleared`, () => ({}));
export const useApproveSpriteJobs = mutation('/jobs/approve',
  (data) => `${data.approved.length} sprite${data.approved.length === 1 ? '' : 's'} approved`,
  (jobIds) => ({ job_ids: jobIds }));

