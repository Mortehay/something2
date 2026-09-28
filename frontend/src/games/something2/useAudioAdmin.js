// Data for the Audio admin tab (SOMET-590, game audio slice 1).
//
// Every /api/audio/admin/* route is adminGuard'd -- same trap documented in
// useArtConsole.js and useAiProviders.js -- so authHeaders() is NOT optional
// on any call here, reads included.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { authHeaders, apiFetch } from './src/js/net/auth.js';
import { API_URL } from '../../config.js';

const SUBJECTS_KEY = ['audio-subjects'];
const MISSES_KEY = ['audio-misses'];
const slotsKey = (kind, key) => ['audio-slots', kind, key];

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

// Flattens the subject registry response (GET /api/audio/admin/subjects) into
// one row per subject, each carrying its own slot list -- the shape both the
// left column's subject tree and the right column's slot cards want. Pure and
// exported so it is unit-testable without mounting the query hook.
//
// `filled` (the count of DISTINCT slots with >=1 clip bound) comes straight
// from the server's one aggregate query rather than a per-subject fetch --
// see the backend's filledCounts(). A subject absent from `group.filled`
// simply has none bound yet, hence the `|| 0`.
export function slotRows(subjects) {
  const out = [];
  for (const group of subjects || []) {
    const slots = Object.entries(group.slots || {}).map(([slot, clipKind]) => ({ slot, clipKind }));
    for (const key of group.subjects || []) {
      out.push({
        kind: group.kind, label: group.label, key, slots, filled: (group.filled && group.filled[key]) || 0,
      });
    }
  }
  return out;
}

// The /admin/generate body for one slot card. Suggest's `slots` are the box's
// values FOR the style it suggested, so they are only sent while the style
// field still holds that style -- a hand-edited style sends none.
export function generateBody({ subject, slot, style, prompt, proposal }) {
  return {
    subject_kind: subject.kind, subject_key: subject.key, slot,
    style: style || undefined,
    prompt: prompt || undefined,
    slots: (proposal && proposal.slots && proposal.style === style) ? proposal.slots : undefined,
  };
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

// A per-(subject,slot) mutation key, not a bare hook-local mutation.
//
// Two things this buys over a plain useMutation():
//   1. A toast id scoped to this exact slot (`audio-generate:world/vale/music`)
//      so generating for two different subjects/slots shows two toasts
//      instead of one clobbering the other.
//   2. The mutation is findable in the GLOBAL mutation cache by this key via
//      useIsMutating(), which survives a component UNMOUNT. Slot cards are
//      keyed by subject -- switching subjects or navigating away and back
//      remounts them, and a fresh useMutation() instance always starts
//      isPending=false. Without this, a still-running generation (minutes,
//      for music) looked finished the moment its card remounted, and a
//      second press could fire a duplicate request at the GPU box.
export function generateMutationKey(subjectKind, subjectKey, slot) {
  return ['audio-generate', subjectKind, subjectKey, slot];
}

export function useGenerateAudio(subjectKind, subjectKey, slot) {
  const qc = useQueryClient();
  const toastId = `audio-generate:${subjectKind}/${subjectKey}/${slot}`;
  return useMutation({
    mutationKey: generateMutationKey(subjectKind, subjectKey, slot),
    mutationFn: async (body) => {
      const { res, json } = await post('/api/audio/admin/generate', body);
      if (!res.ok) throw new Error(json.error || 'Failed to generate');
      return json;
    },
    onMutate: () => {
      toast.loading('Generating… this can take a few minutes', { id: toastId });
    },
    onSuccess: () => {
      toast.success('Clip generated and bound', { id: toastId });
      qc.invalidateQueries({ queryKey: slotsKey(subjectKind, subjectKey) });
      qc.invalidateQueries({ queryKey: MISSES_KEY });
      qc.invalidateQueries({ queryKey: SUBJECTS_KEY });
    },
    onError: (err) => toast.error(err.message, { id: toastId }),
  });
}

// Sends the raw file with Content-Type: audio/ogg, overriding authHeaders()'s
// default application/json -- the backend route parses the body with
// express.raw({ type: 'audio/ogg' }), so a JSON content type here would leave
// req.body empty and the upload would 400.
export function useUploadAudio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      subjectKind, subjectKey, slot, label, file,
    }) => {
      const params = new URLSearchParams({ subject_kind: subjectKind, subject_key: subjectKey, slot });
      if (label) params.set('label', label);
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
