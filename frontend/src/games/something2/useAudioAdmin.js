// Data for the Audio admin tab (SOMET-590, game audio slice 1).
//
// Every /api/audio/admin/* route is adminGuard'd -- same trap documented in
// useArtConsole.js and useAiProviders.js -- so authHeaders() is NOT optional
// on any call here, reads included.
import { useMutation, useQuery, useQueries, useQueryClient } from '@tanstack/react-query';
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
export function slotRows(subjects) {
  const out = [];
  for (const group of subjects || []) {
    const slots = Object.entries(group.slots || {}).map(([slot, clipKind]) => ({ slot, clipKind }));
    for (const key of group.subjects || []) out.push({ kind: group.kind, label: group.label, key, slots });
  }
  return out;
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

// The filled/total badge in the left column's subject tree. There is no bulk
// coverage endpoint -- /admin/subjects lists subjects and slots but not
// bindings -- so this fans out one /admin/slots request per row via
// useQueries, sharing the exact query key useSubjectSlots uses. Selecting a
// subject in the right column is then a cache hit rather than a second fetch.
// Slice 1 has two subject kinds and a small catalogue (worlds, biomes), so the
// fan-out is a handful of requests, not hundreds.
export function useSubjectCoverage(rows) {
  const results = useQueries({
    queries: rows.map((r) => ({
      queryKey: slotsKey(r.kind, r.key),
      queryFn: () => fetchSlots(r.kind, r.key),
      staleTime: 30000,
    })),
  });
  const coverage = {};
  rows.forEach((r, i) => {
    const data = results[i]?.data;
    coverage[`${r.kind}/${r.key}`] = {
      filled: data ? r.slots.filter((s) => (data[s.slot] || []).length > 0).length : null,
      total: r.slots.length,
    };
  });
  return coverage;
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

// One toast id so a second Generate press (a different slot card) replaces
// the message rather than stacking a pile of "Generating..." toasts -- the
// wording itself is what the brief asks for: this can take a few minutes,
// music on the GPU box being the slow case.
const GENERATE_TOAST_ID = 'audio-generate';

export function useGenerateAudio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body) => {
      const { res, json } = await post('/api/audio/admin/generate', body);
      if (!res.ok) throw new Error(json.error || 'Failed to generate');
      return json;
    },
    onMutate: () => {
      toast.loading('Generating… this can take a few minutes', { id: GENERATE_TOAST_ID });
    },
    onSuccess: (json, vars) => {
      toast.success('Clip generated and bound', { id: GENERATE_TOAST_ID });
      qc.invalidateQueries({ queryKey: slotsKey(vars.subject_kind, vars.subject_key) });
      qc.invalidateQueries({ queryKey: MISSES_KEY });
    },
    onError: (err) => toast.error(err.message, { id: GENERATE_TOAST_ID }),
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
    },
    onError: (err) => toast.error(err.message),
  });
}
