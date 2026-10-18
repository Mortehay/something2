// SOMET-638. Data hooks for the Seed / Export tab over /api/seed-export.
// authHeaders() is NOT optional: every route is admin-only, and a 401 without
// it signs the admin out (same trap as useBulkImageJob.js).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { API_URL } from "../../config.js";

const BASE = `${API_URL}/api/seed-export`;
export const GROUPS_KEY = ["seed-groups"];
export const RUNS_KEY = ["seed-runs"];
export const RESTART_KEY = ["seed-restart"];

// The API's `error` text plus its `code`, so a refusal says which rule fired.
async function call(path, { method = "GET", body } = {}) {
  const res = await apiFetch(`${BASE}${path}`, {
    method,
    headers: authHeaders(),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const text = json.error || `Request failed (${res.status})`;
    const d = json.details || {};
    const n = Array.isArray(d.uuids) ? d.uuids.length : null;
    const extra = [json.code, n ? `${n} row${n === 1 ? '' : 's'}` : null].filter(Boolean).join(': ');
    const err = new Error(extra ? `${text} (${extra})` : text);
    err.code = json.code;
    err.file = json.file;
    err.status = res.status;
    throw err;
  }
  return json;
}

export const useSeedGroups = () => useQuery({
  queryKey: GROUPS_KEY,
  queryFn: () => call("/groups"),
});

// Fetched fresh each time it is opened: a preview is a snapshot of the diff
// and the apply refuses a stale one.
export const useSeedPreview = (groupId, enabled) => useQuery({
  queryKey: ["seed-preview", groupId],
  queryFn: () => call(`/groups/${encodeURIComponent(groupId)}/preview`),
  enabled: Boolean(groupId) && enabled,
  gcTime: 0,
  staleTime: 0,
  // A refetch under the open modal would be compared against the admin's
  // decisions; only an explicit refetch (stale_preview) reloads it.
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});

export const useSeedRuns = (group) => useQuery({
  queryKey: [...RUNS_KEY, group || "all"],
  queryFn: () => call(`/runs?limit=50${group ? `&group=${encodeURIComponent(group)}` : ""}`),
});

export const useRestartStatus = () => useQuery({
  queryKey: RESTART_KEY,
  queryFn: () => call("/restart"),
});

function useInvalidating(mutationFn, onSuccess) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (data, vars) => {
      qc.invalidateQueries({ queryKey: GROUPS_KEY });
      qc.invalidateQueries({ queryKey: RUNS_KEY });
      qc.invalidateQueries({ queryKey: RESTART_KEY });
      if (onSuccess) onSuccess(data, vars);
    },
    // A refusal can mean the state moved (stale_preview, busy): refresh too.
    onError: (err) => {
      qc.invalidateQueries({ queryKey: GROUPS_KEY });
      toast.error(err.message);
    },
  });
}

export const useExportGroup = () => useInvalidating(
  ({ groupId }) => call(`/groups/${encodeURIComponent(groupId)}/export`, { method: "POST" }),
  (r) => toast.success(`Exported ${r.rowCount} row${r.rowCount === 1 ? "" : "s"}`),
);

export const useSeedMeta = () => useQuery({
  queryKey: ["seed-meta"],
  queryFn: () => call("/meta"),
  staleTime: Infinity,
});

// `body` is seedRequestBody(decisions, preview): decisions + preview signature.
export const useApplySeed = () => useInvalidating(
  ({ groupId, body }) => call(`/groups/${encodeURIComponent(groupId)}/seed`, { method: "POST", body }),
  (r) => {
    const s = r.summary || {};
    toast.success(`Seeded: ${s.updated || 0} updated, ${s.created || 0} created, ${s.deleted || 0} deleted, ${s.kept || 0} kept, ${s.adopted || 0} adopted`);
  },
);

export const useRestartBackend = () => useInvalidating(
  () => call("/restart", { method: "POST" }),
  () => toast.success("Restart requested"),
);
