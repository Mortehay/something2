// Data for the Audio admin tab (SOMET-590, game audio slice 1).
//
// Every /api/audio/admin/* route is adminGuard'd -- same trap documented in
// useArtConsole.js and useAiProviders.js -- so authHeaders() is NOT optional
// on any call here, reads included.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { authHeaders, apiFetch } from './src/js/net/auth.js';
import { shouldPoll } from './audioBatch.js';
import { queueInChunks } from './audioSelection.js';
import { API_URL } from '../../config.js';

export const SUBJECTS_KEY = ['audio-subjects'];
export const MISSES_KEY = ['audio-misses'];
export const JOBS_KEY = ['audio-jobs'];
// The slot table's per-slot jobs (SOMET-596). Deliberately UNDER JOBS_KEY:
// invalidateQueries matches by prefix, so every mutation that already
// invalidates JOBS_KEY (enqueue, start, stop, retry, clear) refreshes the
// table's Job column too, with no second list of keys to keep in step.
export const SLOT_JOBS_KEY = [...JOBS_KEY, 'slots'];
// The clip library's cache prefix. Queried alone (no kind/unbound/page) so a
// mutation can invalidate every page/filter combo in one call --
// invalidateQueries matches by key PREFIX unless `exact: true`.
export const CLIPS_KEY_PREFIX = ['audio-clips'];
const clipsKey = (kind, unbound, page) => [...CLIPS_KEY_PREFIX, kind || null, Boolean(unbound), page || 1];
const slotsKey = (kind, key) => ['audio-slots', kind, key];
const promptsKey = (kind, key) => ['audio-prompts', kind, key];
// Every audio-slots query, regardless of subject -- a clip delete or a
// bind-from-library cannot know in advance which subjects it touched (a clip
// can be bound to more than one), so mutations that only learn "N bindings
// changed" invalidate the whole prefix rather than guessing subjects. Also
// used by AudioAdmin's post-drain refresh (a finished batch can have bound
// clips to ANY of the subjects it touched).
export const ALL_SLOTS_KEY = ['audio-slots'];
const CLIPS_PAGE_SIZE = 20;

async function getJson(url, what) {
  const res = await apiFetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Failed to load ${what}`);
  return res.json();
}

async function post(path, body) {
  const res = await apiFetch(`${API_URL}${path}`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

function fetchSlots(kind, key) {
  return getJson(
    `${API_URL}/api/audio/admin/slots/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`,
    `${kind}/${key}'s bound clips`,
  );
}

// The slot card's Generate, as ONE POST /admin/jobs item (plan 2026-10-03:
// a single click goes through the queue, so it runs the same prompt ->
// switch -> audio phases as a batch). Suggest's `slots` are the box's values
// FOR the style it suggested, so they are only sent while the style field
// still holds that style -- a hand-edited style sends none.
//
// `engine`/`variants` are sfx-only (game audio slice 3): AudioSlotCard omits
// them entirely for music/ambience slots, so they are undefined there and
// dropped from the JSON body the same way style/prompt/slots already are.
// `seed` is sent only when it is an integer (the card has no seed control
// today). `forcePrompt` is the card's "Force regenerate prompt" checkbox;
// unticked, the field is left off and the server's default (false) applies.
export function generateItem({
  subject, slot, style, prompt, proposal, engine, variants, seed, forcePrompt,
}) {
  return {
    subject_kind: subject.kind, subject_key: subject.key, slot,
    style: style || undefined,
    prompt: prompt || undefined,
    slots: (proposal && proposal.slots && proposal.style === style) ? proposal.slots : undefined,
    engine: engine || undefined,
    variants: Number.isInteger(variants) ? variants : undefined,
    seed: Number.isInteger(seed) ? seed : undefined,
    force_prompt: forcePrompt === true ? true : undefined,
  };
}

// The slot card's "Write with model", as ONE POST /admin/jobs item: a
// prompt-only job that always rewrites (force_prompt), carrying the card's
// optional hint. The queue's prompt phase writes it on the box's text model.
export function writeItem({ subject, slot, hint }) {
  const h = typeof hint === 'string' ? hint.trim() : '';
  return {
    subject_kind: subject.kind,
    subject_key: subject.key,
    slot,
    prompt_only: true,
    force_prompt: true,
    hint: h || undefined,
  };
}

// What one single-item enqueue did, as { ok, message }. The route answers
// 201 even when it queued nothing: the item can be `rejected` (with the
// reason) or `already_live` (the slot has a queued or running job already),
// and neither may be swallowed -- the admin pressed a button and nothing
// will happen. `started:false, reason:'no_provider'` means it is queued but
// no drain will run it until a provider exists.
export function singleEnqueueMessage(json, what = 'Generate') {
  const j = json || {};
  const rejected = Array.isArray(j.rejected) ? j.rejected : [];
  if (rejected.length) {
    return { ok: false, message: `${what} not queued: ${rejected[0].error || 'rejected'}` };
  }
  if (Array.isArray(j.already_live) && j.already_live.length) {
    return { ok: false, message: `${what} not queued: this slot already has a queued or running job` };
  }
  if (!(Array.isArray(j.queued) && j.queued.length)) {
    return { ok: false, message: `${what} not queued` };
  }
  if (j.started === false && j.reason === 'no_provider') {
    return { ok: true, message: `${what} queued — no audio provider, press Start once one is active` };
  }
  return { ok: true, message: `${what} queued` };
}

// This slot's row from GET /admin/jobs/slots (the latest queued, running or
// failed job), or null.
export function slotJobFor(slotJobs, kind, key, slot) {
  return (slotJobs || []).find((j) => j.subject_kind === kind && j.subject_key === key && j.slot === slot) || null;
}

export function isLiveJob(job) {
  return Boolean(job) && (job.status === 'queued' || job.status === 'running');
}

export function useAudioSubjects() {
  const { data, isLoading, error } = useQuery({
    queryKey: SUBJECTS_KEY,
    queryFn: () => getJson(`${API_URL}/api/audio/admin/subjects`, 'the audio subjects'),
  });
  return { subjects: data || [], isLoadingSubjects: isLoading, subjectsError: error || null };
}

export function useSubjectSlots(kind, key) {
  const { data, isLoading } = useQuery({
    queryKey: slotsKey(kind, key),
    enabled: Boolean(kind && key),
    queryFn: () => fetchSlots(kind, key),
  });
  return { slots: data || {}, isLoadingSlots: isLoading };
}

export function useAudioMisses() {
  const { data, isLoading } = useQuery({
    queryKey: MISSES_KEY,
    queryFn: () => getJson(`${API_URL}/api/audio/admin/misses`, 'the audio misses'),
  });
  return { misses: data || [], isLoadingMisses: isLoading };
}

export function useProposeAudio() {
  return useMutation({
    mutationFn: async (body) => {
      const { res, json } = await post('/api/audio/admin/propose', body);
      if (!res.ok) throw new Error(json.error || 'Failed to suggest a prompt');
      return json;
    },
    onError: (err) => toast.error(err.message),
  });
}

// SOMET-592 (I2): the one sfx slot whose clips may loop -- a world point's
// `nearby` (the backend enforces the same rule: audioLibrary.canSetLoopable).
// Its card shows a "Loop" checkbox on upload and a Loop toggle per clip row.
export function loopEditable(subjectKind, slot) {
  return subjectKind === 'world_point' && slot === 'nearby';
}

// The upload request's query string. `loopable` is only sent when it is a
// boolean (the Loop checkbox exists only where loopEditable is true).
export function uploadParams({
  subjectKind, subjectKey, slot, label, loopable,
}) {
  const params = new URLSearchParams({ subject_kind: subjectKind, subject_key: subjectKey, slot });
  if (label) params.set('label', label);
  if (typeof loopable === 'boolean') params.set('loopable', String(loopable));
  return params;
}

// Sends the raw file with Content-Type: audio/ogg, overriding authHeaders()'s
// default application/json -- the backend route parses the body with
// express.raw({ type: 'audio/ogg' }), so a JSON content type here would leave
// req.body empty and the upload would 400.
export function useUploadAudio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      subjectKind, subjectKey, slot, label, loopable, file,
    }) => {
      const params = uploadParams({
        subjectKind, subjectKey, slot, label, loopable,
      });
      const res = await apiFetch(`${API_URL}/api/audio/admin/upload?${params}`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'audio/ogg' },
        body: file,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to upload');
      return json;
    },
    onSuccess: (json, vars) => {
      toast.success('Uploaded and bound');
      qc.invalidateQueries({ queryKey: slotsKey(vars.subjectKind, vars.subjectKey) });
      qc.invalidateQueries({ queryKey: MISSES_KEY });
      qc.invalidateQueries({ queryKey: SUBJECTS_KEY });
    },
    onError: (err) => toast.error(err.message),
  });
}

export function useUpdateBinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id, volume, weight, subjectKind, subjectKey,
    }) => {
      const res = await apiFetch(`${API_URL}/api/audio/admin/bindings/${id}`, {
        method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ volume, weight }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to update the clip');
      return { json, subjectKind, subjectKey };
    },
    onSuccess: ({ subjectKind, subjectKey }) => {
      qc.invalidateQueries({ queryKey: slotsKey(subjectKind, subjectKey) });
    },
    onError: (err) => toast.error(err.message),
  });
}

// SOMET-592 (I2): PATCH /api/audio/admin/clips/:id {loopable}. The flag lives
// on the CLIP, so every slot showing it and every library page may be stale.
export function useSetClipLoopable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ clipId, loopable }) => {
      const res = await apiFetch(`${API_URL}/api/audio/admin/clips/${clipId}`, {
        method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ loopable }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to change the loop setting');
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ALL_SLOTS_KEY });
      qc.invalidateQueries({ queryKey: CLIPS_KEY_PREFIX });
    },
    onError: (err) => toast.error(err.message),
  });
}

export function useUnbind() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }) => {
      const res = await apiFetch(`${API_URL}/api/audio/admin/bindings/${id}`, {
        method: 'DELETE', headers: authHeaders(),
      });
      if (!res.ok) throw new Error('Failed to remove the clip');
      return true;
    },
    onSuccess: (_result, { subjectKind, subjectKey }) => {
      toast.success('Removed');
      qc.invalidateQueries({ queryKey: slotsKey(subjectKind, subjectKey) });
      qc.invalidateQueries({ queryKey: MISSES_KEY });
      qc.invalidateQueries({ queryKey: SUBJECTS_KEY });
    },
    onError: (err) => toast.error(err.message),
  });
}

// --- Batch jobs (SOMET-591, game audio slice 2) ---------------------------
//
// GET /api/audio/admin/jobs returns { run, stats, recent } in one shot --
// audioBatch.js's shouldPoll/batchProgress both take exactly that shape, so
// it is handed through untouched rather than reassembled here.
export function useAudioJobs() {
  const { data, isLoading, error } = useQuery({
    queryKey: JOBS_KEY,
    // `q.state.data` IS the { run, stats, recent } the last successful fetch
    // returned -- shouldPoll reads run/stats straight off it. Undefined
    // before the first fetch resolves to `false` inside shouldPoll (both
    // destructured fields are undefined), so the first render polls once and
    // then waits for that response before deciding whether to continue.
    refetchInterval: (q) => (shouldPoll(q.state.data || {}) ? 2000 : false),
    queryFn: () => getJson(`${API_URL}/api/audio/admin/jobs`, 'the audio batch queue'),
  });
  return {
    run: data?.run || null,
    stats: data?.stats || { groups: {}, backoff: 0 },
    recent: data?.recent || [],
    isLoadingJobs: isLoading,
    jobsError: error || null,
  };
}

// GET /admin/jobs/slots: the latest live-or-failed job per slot. `poll` is
// the caller's shouldPoll({run, stats}) over useAudioJobs' data, so this
// refetches on exactly the batch panel's cadence and stops when it stops.
export function useAudioSlotJobs({ poll = false } = {}) {
  const { data, isLoading, error } = useQuery({
    queryKey: SLOT_JOBS_KEY,
    refetchInterval: poll ? 2000 : false,
    queryFn: () => getJson(`${API_URL}/api/audio/admin/jobs/slots`, 'the slot jobs'),
  });
  return { slotJobs: data || [], isLoadingSlotJobs: isLoading, slotJobsError: error || null };
}

// Queues a selection of any size (SOMET-596): POST /admin/jobs caps a request
// at MAX_JOB_ITEMS, so the items go in chunks, one request after another,
// stopping at the first failure (audioSelection.queueInChunks). Resolves to
// { results, error, unsent } rather than rejecting on a failed chunk: the
// chunks before it DID queue, and the caller reports both halves.
//
// The request body is jobsRequestBody's, so a test can see exactly what one
// chunk sends (items untouched -- force_prompt/prompt_only ride on them).
export function jobsRequestBody(items, providerId) {
  return { items, start: true, provider_id: Number.isInteger(providerId) ? providerId : undefined };
}

// One slot card's Generate or Write with model: a single-item enqueue with
// start:true. Resolves to the route's JSON; the card reads
// singleEnqueueMessage(json) to report a rejected or already-live item.
export async function enqueueSlotJob(item) {
  const { res, json } = await post('/api/audio/admin/jobs', jobsRequestBody([item]));
  if (!res.ok) throw new Error(json.error || 'Failed to queue the job');
  return json;
}

export function useEnqueueSlotJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: enqueueSlotJob,
    onSettled: () => qc.invalidateQueries({ queryKey: JOBS_KEY }),
    onError: (err) => toast.error(err.message),
  });
}

// When a slot card's own job leaves the queue, what it changed must show:
// a new prompt version (prompt phase) and a new bound clip (audio phase).
// AudioAdmin's doneRose refresh covers the slot table but not the prompts,
// and SubjectSounds (the world/biome editors) has no AudioAdmin at all.
export function useSubjectRefresh(kind, key) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: promptsKey(kind, key) });
    qc.invalidateQueries({ queryKey: slotsKey(kind, key) });
    qc.invalidateQueries({ queryKey: SUBJECTS_KEY });
    qc.invalidateQueries({ queryKey: MISSES_KEY });
  };
}

export function useEnqueueAudioJobs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ items, providerId }) => queueInChunks(items, async (chunk) => {
      const { res, json } = await post('/api/audio/admin/jobs', jobsRequestBody(chunk, providerId));
      if (!res.ok) throw new Error(json.error || 'Failed to queue the batch');
      return json;
    }),
    onSettled: () => qc.invalidateQueries({ queryKey: JOBS_KEY }),
    onError: (err) => toast.error(err.message),
  });
}

export function useStartAudioDrain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { res, json } = await post('/api/audio/admin/jobs/dispatch', {});
      // 409 is an admin pressing Start twice (or another tab already did) --
      // not a fault, same reading useStartArtBatch gives it.
      if (res.status === 409) throw new Error(json.error || 'A batch is already running');
      if (res.status === 503) throw new Error(json.error || 'No active audio provider');
      if (!res.ok) throw new Error(json.error || 'Failed to start the batch');
      return json;
    },
    onSuccess: () => {
      toast.success('Batch started');
      qc.invalidateQueries({ queryKey: JOBS_KEY });
    },
    onError: (err) => toast.error(err.message),
  });
}

export function useStopAudioDrain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await post('/api/audio/admin/jobs/stop', {})).json,
    onSuccess: (run) => {
      // The job in flight is allowed to finish; saying so stops an admin
      // pressing Stop again while nothing visibly changes yet.
      toast.success(run.stopping ? 'Stopping after the current job' : 'Nothing is running');
      qc.invalidateQueries({ queryKey: JOBS_KEY });
    },
    onError: (err) => toast.error(err.message),
  });
}

export function useRetryAudioFailures() {
  const qc = useQueryClient();
  return useMutation({
    // `ids` (SOMET-596): the by-cause panel's "Retry these N". Omitted, it
    // retries every failed job, as the batch panel's "Retry failed" does.
    mutationFn: async (ids) => {
      const { res, json } = await post('/api/audio/admin/jobs/retry-failed', Array.isArray(ids) ? { ids } : {});
      if (!res.ok) throw new Error(json.error || 'Failed to retry the failed jobs');
      return json;
    },
    onSuccess: ({ requeued }) => {
      toast.success(requeued ? `${requeued} job(s) returned to the queue` : 'Nothing to retry');
      qc.invalidateQueries({ queryKey: JOBS_KEY });
    },
    onError: (err) => toast.error(err.message),
  });
}

// `states` defaults to undefined -- the server's own default clears
// queued+failed+done, which the route already refuses (409) while a drain is
// running. The panel's "Clear finished" button passes ['done', 'failed']
// explicitly so it never touches a still-queued job.
export function useClearAudioJobs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (states) => {
      const { res, json } = await post('/api/audio/admin/jobs/clear', states ? { states } : {});
      if (res.status === 409) throw new Error(json.error || 'A batch is running -- stop it first');
      if (!res.ok) throw new Error(json.error || 'Failed to clear the queue');
      return json;
    },
    onSuccess: ({ cleared }) => {
      toast.success(cleared ? `Cleared ${cleared} job(s)` : 'Nothing to clear');
      qc.invalidateQueries({ queryKey: JOBS_KEY });
    },
    onError: (err) => toast.error(err.message),
  });
}

// --- Clip library (SOMET-591) ----------------------------------------------

export function useAudioClips({ kind, unbound, page = 1 } = {}) {
  const { data, isLoading, error } = useQuery({
    queryKey: clipsKey(kind, unbound, page),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (kind) params.set('kind', kind);
      if (unbound) params.set('unbound', '1');
      params.set('limit', String(CLIPS_PAGE_SIZE));
      params.set('offset', String((Math.max(page, 1) - 1) * CLIPS_PAGE_SIZE));
      return getJson(`${API_URL}/api/audio/admin/clips?${params}`, 'the clip library');
    },
  });
  return {
    clips: data?.rows || [],
    total: data?.total || 0,
    pageSize: CLIPS_PAGE_SIZE,
    isLoadingClips: isLoading,
    clipsError: error || null,
  };
}

export function useDeleteClip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const res = await apiFetch(`${API_URL}/api/audio/admin/clips/${id}`, {
        method: 'DELETE', headers: authHeaders(),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to delete the clip');
      return json;
    },
    onSuccess: ({ bindings }) => {
      toast.success(bindings ? `Deleted — removed from ${bindings} slot(s)` : 'Deleted');
      qc.invalidateQueries({ queryKey: CLIPS_KEY_PREFIX });
      // A clip with zero bindings changed nothing else; only bother the
      // subject-facing caches when this delete actually unbound something.
      if (bindings) {
        qc.invalidateQueries({ queryKey: ALL_SLOTS_KEY });
        qc.invalidateQueries({ queryKey: SUBJECTS_KEY });
        qc.invalidateQueries({ queryKey: MISSES_KEY });
      }
    },
    onError: (err) => toast.error(err.message),
  });
}

// Bulk delete of clips with ZERO bindings -- deleteUnboundClips only ever
// touches such clips (spec: never a bound one), so no binding, subject or
// miss cache can have changed and only the library list is invalidated.
export function useDeleteUnboundClips() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (kind) => {
      const { res, json } = await post('/api/audio/admin/clips/delete-unbound', kind ? { kind } : {});
      if (!res.ok) throw new Error(json.error || 'Failed to delete the unbound clips');
      return json;
    },
    onSuccess: ({ deleted }) => {
      toast.success(deleted ? `Deleted ${deleted} unbound clip(s)` : 'Nothing unbound to delete');
      qc.invalidateQueries({ queryKey: CLIPS_KEY_PREFIX });
    },
    onError: (err) => toast.error(err.message),
  });
}

// --- Prompts (Task 12, spec 2026-09-30 §9) ---------------------------------

export function usePrompts(kind, key) {
  const { data, isLoading } = useQuery({
    queryKey: promptsKey(kind, key),
    enabled: Boolean(kind && key),
    queryFn: () => getJson(
      `${API_URL}/api/audio/admin/prompts/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`,
      `${kind}/${key}'s prompts`,
    ),
  });
  return { prompts: data || {}, isLoadingPrompts: isLoading };
}

// Save and Restore refresh the subject's prompts and the table's prompt column
// (SUBJECTS_KEY carries promptStates).
function usePromptInvalidation(kind, key) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: promptsKey(kind, key) });
    qc.invalidateQueries({ queryKey: SUBJECTS_KEY });
  };
}

// PUT /admin/prompts/:kind/:key/:slot -- one new active version. Save and
// the history list's Restore both send through here; a 409 (the active row is
// no longer `expectActiveId`) rejects with the server's own "reload it" text.
export async function putPrompt(kind, key, {
  slot, style, text, expectActiveId,
}) {
  const res = await apiFetch(
    `${API_URL}/api/audio/admin/prompts/${encodeURIComponent(kind)}/${encodeURIComponent(key)}/${encodeURIComponent(slot)}`,
    {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ style, text, expect_active_id: expectActiveId ?? null }),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Failed to save the prompt');
  return json;
}

export function useSavePrompt(kind, key) {
  const invalidate = usePromptInvalidation(kind, key);
  return useMutation({
    mutationFn: (vars) => putPrompt(kind, key, vars),
    onSuccess: invalidate,
    onError: (err) => toast.error(err.message),
  });
}

// Bind-from-library: attach an existing (maybe already-bound-elsewhere) clip
// to another subject/slot without generating or uploading. Used by both
// AudioSlotCard's "+ From library" picker and (indirectly) nothing else yet.
export function useBindFromLibrary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      subjectKind, subjectKey, slot, clipId,
    }) => {
      const { res, json } = await post('/api/audio/admin/bindings', {
        subject_kind: subjectKind, subject_key: subjectKey, slot, clip_id: clipId,
      });
      if (!res.ok) throw new Error(json.error || 'Failed to bind the clip');
      return json;
    },
    onSuccess: (_json, { subjectKind, subjectKey }) => {
      toast.success('Bound from the library');
      qc.invalidateQueries({ queryKey: slotsKey(subjectKind, subjectKey) });
      qc.invalidateQueries({ queryKey: SUBJECTS_KEY });
      qc.invalidateQueries({ queryKey: MISSES_KEY });
      qc.invalidateQueries({ queryKey: CLIPS_KEY_PREFIX });
    },
    onError: (err) => toast.error(err.message),
  });
}
