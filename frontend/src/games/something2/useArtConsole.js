// Data for the mass-generation console (SOMET-538).
//
// EVERY SUBJECT IS FETCHED, not a server page at a time. The catalogue is ~1000
// rows across five kinds and each row is a handful of short fields, so the
// whole thing is a small payload -- and holding it makes "select all 617
// matching the filter" an exact set rather than a promise the server has to
// re-derive from filter parameters. A server-paged table cannot honestly tell
// the admin how many they just selected, which is one of this ticket's
// acceptance criteria.
//
// authHeaders() is NOT optional: every /api/art-* route is adminGuard'd, and a
// 401 here would sign the admin out mid-batch. Same trap documented in
// useAiProviders.js.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { authHeaders, apiFetch } from './src/js/net/auth.js';
import { API_URL } from '../../config.js';

const SUBJECTS_KEY = ['art-subjects'];
const QUEUE_KEY = ['art-queue'];

async function getJson(url, what) {
  const res = await apiFetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to load ${what}`);
  return res.json();
}

export function useArtSubjects() {
  const { data, isLoading, error } = useQuery({
    queryKey: SUBJECTS_KEY,
    queryFn: async () => {
      const { kinds } = await getJson(`${API_URL}/api/art-subjects`, 'the subject kinds');
      // per_page is above every kind's row count, so one request each.
      const pages = await Promise.all(kinds.map(({ kind }) => (
        getJson(`${API_URL}/api/art-subjects/${encodeURIComponent(kind)}?per_page=500`, kind)
      )));
      return {
        kinds: kinds.map((k) => k.kind),
        subjects: pages.flatMap((p) => p.subjects),
      };
    },
  });
  return {
    kinds: data?.kinds || [],
    subjects: data?.subjects || [],
    isLoadingSubjects: isLoading,
    subjectsError: error,
  };
}

// The queue and the running drain. Polled only while something is running -- a
// finished run is a static object and re-fetching it every 2s for the rest of
// the session would be pure noise.
export function useArtQueue() {
  const { data } = useQuery({
    queryKey: QUEUE_KEY,
    refetchInterval: (q) => (q.state.data?.run?.running ? 2000 : false),
    queryFn: () => getJson(`${API_URL}/api/art-jobs`, 'the art queue'),
  });
  // `failures` arrives already GROUPED AND CLASSIFIED by the server. The rule
  // that decides whether a failure is the provider's fault or the subject's
  // lives in backend/src/services/artFailures.js and is not duplicated here --
  // this repo already carries one rule copied across the front/back split and
  // that is a standing hazard. The page renders what it is told.
  return { stats: data?.stats || null, run: data?.run || null, failures: data?.failures || [] };
}

// Return every failed subject of ONE cause to the queue.
//
// `reseed` is not a UI nicety: the backend REFUSES a plain requeue for a
// content failure with 409, because the seed is derived from the subject and
// the retry would regenerate the identical image. The button that sends it is
// therefore a different button, not the same one with a flag.
export function useRequeueFailures() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ kind, reseed }) => {
      const { res, json } = await post('/api/art-jobs/requeue', { kind, reseed: !!reseed });
      // 409 is the server enforcing the rule. Surfaced verbatim -- it explains
      // WHY a retry cannot work, which is the thing the admin needs to know.
      if (!res.ok) throw new Error(json.error || 'Failed to requeue');
      return json;
    },
    onSuccess: (json) => {
      toast.success(json.reseeded
        ? `${json.requeued} queued again with a new seed`
        : `${json.requeued} returned to the queue`);
      qc.invalidateQueries({ queryKey: QUEUE_KEY });
      qc.invalidateQueries({ queryKey: SUBJECTS_KEY });
    },
    onError: (err) => toast.error(err.message),
  });
}

// SOMET-547. One subject's generation history -- every ATTEMPT, not every
// image, so three rows against a faulted GPU stay distinguishable from one.
//
// Fetched only while a preview is open (`enabled`), because this is ~1000
// subjects and pre-loading a history for each would be a thousand requests for
// data nobody has asked to see.
export function useArtHistory(subject) {
  const { data, isLoading } = useQuery({
    queryKey: ['art-history', subject?.kind, subject?.key],
    enabled: Boolean(subject),
    queryFn: () => getJson(
      `${API_URL}/api/art-subjects/${encodeURIComponent(subject.kind)}`
      + `/${encodeURIComponent(subject.key)}/history`,
      'the generation history',
    ),
  });
  return { history: data?.history || [], isLoadingHistory: isLoading };
}

async function post(path, body) {
  const res = await apiFetch(`${API_URL}${path}`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

// One request per kind, because the endpoint takes one kind at a time. Run
// SEQUENTIALLY rather than in parallel: each call ends by reading the queue
// stats, and firing five at once would have them race to report a total that
// is already stale.
export function useEnqueueArt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ byKind, backend, providerId }) => {
      const results = [];
      for (const [kind, keys] of byKind) {
        const { res, json } = await post('/api/art-jobs', {
          kind, keys, backend, provider_id: providerId,
        });
        if (!res.ok) throw new Error(json.error || `Failed to queue ${kind}`);
        results.push(json);
      }
      return results;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUEUE_KEY });
      qc.invalidateQueries({ queryKey: SUBJECTS_KEY });
    },
    onError: (err) => toast.error(err.message),
  });
}

export function useStartArtBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body) => {
      const { res, json } = await post('/api/art-jobs/dispatch', body);
      // 409 is an admin clicking twice, or two admins at once -- not a fault.
      if (res.status === 409) throw new Error('A batch is already running');
      // 400 here is usually the resolution precondition, whose message says
      // exactly which provider is misconfigured and how to fix it. Passing it
      // through verbatim is the whole point of writing it that way.
      if (!res.ok) throw new Error(json.error || 'Failed to start the batch');
      return json;
    },
    onSuccess: () => {
      toast.success('Batch started');
      qc.invalidateQueries({ queryKey: QUEUE_KEY });
    },
    onError: (err) => toast.error(err.message),
  });
}

export function useStopArtBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await post('/api/art-jobs/stop')).json,
    onSuccess: ({ stopping }) => {
      // The subject being drawn right now is allowed to finish; saying so stops
      // the admin clicking Stop repeatedly while nothing appears to happen.
      toast.success(stopping ? 'Stopping after the subjects in flight' : 'Nothing is running');
      qc.invalidateQueries({ queryKey: QUEUE_KEY });
    },
    onError: (err) => toast.error(err.message),
  });
}

export function useRequeueStale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await post('/api/art-jobs/requeue-stale', {})).json,
    onSuccess: ({ requeued }) => {
      toast.success(requeued ? `Returned ${requeued} stranded job(s) to the queue`
        : 'No stranded jobs');
      qc.invalidateQueries({ queryKey: QUEUE_KEY });
      qc.invalidateQueries({ queryKey: SUBJECTS_KEY });
    },
    onError: (err) => toast.error(err.message),
  });
}
