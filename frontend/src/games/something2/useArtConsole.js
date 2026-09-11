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
import { shouldPollQueue } from './artProgress.js';
import { API_URL } from '../../config.js';

const SUBJECTS_KEY = ['art-subjects'];
const QUEUE_KEY = ['art-queue'];

async function getJson(url, what) {
  const res = await apiFetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to load ${what}`);
  return res.json();
}

// `live` polls the catalogue while a batch is draining (SOMET-558).
//
// Without it the table is FROZEN for the whole run: this query had no
// refetchInterval at all, so Status pills and thumbnails kept whatever they
// said when the page loaded, and an admin watching a two-hour batch saw
// nothing land until they reloaded by hand. The queue counters ticked while
// the rows they described did not, which is worse than either alone.
//
// 15s, not the queue's 2s. This is one request per kind over ~1000 rows, and
// at the default concurrency of one image per ~20s at most a handful of rows
// can have changed; polling it at the counters' rate would spend the API
// budget re-fetching an unchanged catalogue. Off entirely when idle.
export function useArtSubjects({ live = false } = {}) {
  const { data, isLoading, error } = useQuery({
    queryKey: SUBJECTS_KEY,
    refetchInterval: live ? 15000 : false,
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

// The queue and the running drain. Polled while anything is OUTSTANDING, which
// is deliberately wider than "a drain is running" (SOMET-558).
//
// The original condition was `run.running`, and it made the single state an
// admin most needs to watch invisible: 530 rows queued with nothing draining
// them refreshed never, so the page showed one frozen count and no hint that
// pressing Queue had not started anything. A finished run with an empty queue
// is still static and still stops polling -- that part was right.
//
// The predicate lives in artProgress.js so it is testable without a fake
// query client; this only supplies the data.
export function useArtQueue() {
  const { data } = useQuery({
    queryKey: QUEUE_KEY,
    refetchInterval: (q) => (
      shouldPollQueue(q.state.data?.run, q.state.data?.stats) ? 2000 : false
    ),
    queryFn: () => getJson(`${API_URL}/api/art-jobs`, 'the art queue'),
  });
  // `failures` arrives already GROUPED AND CLASSIFIED by the server. The rule
  // that decides whether a failure is the provider's fault or the subject's
  // lives in backend/src/services/artFailures.js and is not duplicated here --
  // this repo already carries one rule copied across the front/back split and
  // that is a standing hazard. The page renders what it is told.
  return {
    stats: data?.stats || null,
    run: data?.run || null,
    // The subjects on the provider RIGHT NOW, from art_jobs rather than from
    // the dispatcher's memory -- a backend restarted mid-batch has no run
    // object, and the claimed rows still answer "what is being drawn".
    inFlight: data?.in_flight || [],
    // WHAT is waiting, in claim order -- a capped preview plus the true total,
    // both from the server's one query so the list and its count cannot
    // disagree. The shape is always present so the component never branches on
    // undefined during the first poll.
    queued: data?.queued || { rows: [], total: 0, backoff: 0 },
    failures: data?.failures || [],
  };
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

// SOMET-548. A subject's prompt corrections. Returns EVERY note, active or
// not: the history records prompts that contained notes since revoked, and a
// prompt nobody can explain afterwards is not much of a record.
const notesKey = (s) => ['art-notes', s?.kind, s?.key];

export function useArtNotes(subject) {
  const { data } = useQuery({
    queryKey: notesKey(subject),
    enabled: Boolean(subject),
    queryFn: () => getJson(
      `${API_URL}/api/art-subjects/${encodeURIComponent(subject.kind)}`
      + `/${encodeURIComponent(subject.key)}/notes`,
      'the prompt notes',
    ),
  });
  return { notes: data?.notes || [] };
}

function noteMutation(run, successMessage) {
  return function useNoteMutation(subject) {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (arg) => run(subject, arg),
      onSuccess: () => {
        toast.success(successMessage);
        qc.invalidateQueries({ queryKey: notesKey(subject) });
      },
      onError: (err) => toast.error(err.message),
    });
  };
}

export const useAddArtNote = noteMutation(async (subject, body) => {
  const { res, json } = await post(
    `/api/art-subjects/${encodeURIComponent(subject.kind)}`
    + `/${encodeURIComponent(subject.key)}/notes`, body,
  );
  if (!res.ok) throw new Error(json.error || 'Failed to save the note');
  return json;
}, 'Note saved -- it applies to the next generation');

export const useRemoveArtNote = noteMutation(async (subject, id) => {
  const res = await apiFetch(
    `${API_URL}/api/art-subjects/${encodeURIComponent(subject.kind)}`
    + `/${encodeURIComponent(subject.key)}/notes/${id}`,
    { method: 'DELETE', headers: authHeaders() },
  );
  if (!res.ok) throw new Error('Failed to remove the note');
  return res.json().catch(() => ({}));
}, 'Note removed');

// SOMET-553. The written description that replaces the catalogue template.
//
// Returns every version, not only the active one: art_generations records
// prompts built from descriptions since replaced, and the console is where
// someone asks "why did it draw that" about an image made weeks ago.
const descriptionKey = (s) => ['art-description', s?.kind, s?.key];

export function useArtDescription(subject) {
  const { data, isLoading } = useQuery({
    queryKey: descriptionKey(subject),
    enabled: Boolean(subject),
    queryFn: () => getJson(
      `${API_URL}/api/art-subjects/${encodeURIComponent(subject.kind)}`
      + `/${encodeURIComponent(subject.key)}/description`,
      'the subject description',
    ),
  });
  return {
    description: data?.active || null,
    descriptionHistory: data?.history || [],
    // Whether the catalogue has moved since the description was written. It is
    // still the description in force -- see the migration header for why
    // dropping a stale one would be the more damaging half of the mistake.
    isStale: Boolean(data?.stale),
    catalogPrompt: data?.catalogPrompt || null,
    isLoadingDescription: isLoading,
  };
}

function descriptionMutation(run, successMessage) {
  return function useDescriptionMutation(subject) {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (arg) => run(subject, arg),
      onSuccess: () => {
        toast.success(successMessage);
        qc.invalidateQueries({ queryKey: descriptionKey(subject) });
      },
      onError: (err) => toast.error(err.message),
    });
  };
}

// `text` given writes it verbatim (a human edit); omitted asks the local model
// for one, which takes 10-100s on CPU -- the caller must show that it is
// working or the button reads as broken.
export const useWriteDescription = descriptionMutation(async (subject, body) => {
  const { res, json } = await post(
    `/api/art-subjects/${encodeURIComponent(subject.kind)}`
    + `/${encodeURIComponent(subject.key)}/description`, body,
  );
  if (!res.ok) throw new Error(json.error || 'Failed to write the description');
  return json;
}, 'Description saved -- it applies to the next generation');

export const useClearDescription = descriptionMutation(async (subject) => {
  const res = await apiFetch(
    `${API_URL}/api/art-subjects/${encodeURIComponent(subject.kind)}`
    + `/${encodeURIComponent(subject.key)}/description`,
    { method: 'DELETE', headers: authHeaders() },
  );
  if (!res.ok) throw new Error('Failed to clear the description');
  return res.json().catch(() => ({}));
}, 'Description cleared -- back to the catalogue phrase');

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
    // "No stranded jobs" was the same sentence for two opposite situations,
    // and the page had just told the admin to press this button. When a live
    // drain still owns the claimed rows, saying so is the whole answer --
    // otherwise the button looks broken. See SOMET-558.
    onSuccess: ({ requeued, drain_running: draining, claimed }) => {
      if (requeued) toast.success(`Returned ${requeued} stranded job(s) to the queue`);
      else if (claimed && draining) {
        toast(`${claimed} claimed, but the batch is still running -- press Stop first`);
      } else if (claimed) toast(`${claimed} claimed less than a minute ago; try again shortly`);
      else toast.success('No stranded jobs');
      qc.invalidateQueries({ queryKey: QUEUE_KEY });
      qc.invalidateQueries({ queryKey: SUBJECTS_KEY });
    },
    onError: (err) => toast.error(err.message),
  });
}

// Throw away the pending queue. `done` and `failed` rows are NOT touched --
// they are the record the failures panel is built from.
export function useClearArtQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { res, json } = await post('/api/art-jobs/clear', {});
      // 409 is the server refusing to delete rows a worker is mid-generation
      // on. Surfaced verbatim: it names the fix (press Stop first).
      if (!res.ok) throw new Error(json.error || 'Failed to clear the queue');
      return json;
    },
    onSuccess: ({ cleared, claimed }) => {
      toast.success(cleared
        ? `Cleared ${cleared} pending job(s)${claimed ? `, ${claimed} of them claimed` : ''}`
        : 'Nothing pending to clear');
      qc.invalidateQueries({ queryKey: QUEUE_KEY });
      qc.invalidateQueries({ queryKey: SUBJECTS_KEY });
    },
    onError: (err) => toast.error(err.message),
  });
}
