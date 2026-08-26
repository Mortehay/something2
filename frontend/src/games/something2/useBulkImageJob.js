// The admin's "Regenerate all tiles / all entities" buttons.
//
// One run at a time server-side, so this is a single query on a single
// endpoint rather than a job id per click: whatever is running (or ran last)
// is what /current returns. That also means a page reload re-attaches to a run
// in progress instead of losing it, which matters when the run takes hours.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { API_URL } from "../../config.js";

const KEY = ["bulk-image-run"];

// authHeaders() is NOT optional: every /api/bulk-image-jobs route is
// adminGuard'd, and a 401 here would sign the admin out mid-run. Same trap
// documented in useAiProviders.js.
export function useBulkImageRun() {
  const { data, isLoading } = useQuery({
    queryKey: KEY,
    // Polls only while something is actually running. A finished run is a
    // static object; re-fetching it every 2s for the rest of the session
    // would be pure noise.
    refetchInterval: (q) => (q.state.data?.status === "running" ? 2000 : false),
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/bulk-image-jobs/current`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to read the regeneration run");
      return res.json();
    },
  });
  return { run: data || null, isLoadingRun: isLoading };
}

export function useStartBulkImageRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body) => {
      const res = await apiFetch(`${API_URL}/api/bulk-image-jobs`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      // 409 is an admin clicking twice, or two admins clicking at once. It
      // carries the run that IS going, so say which one rather than "error".
      if (res.status === 409) {
        throw new Error(`A ${json.run?.kind || ""} regeneration is already running`.replace(/\s+/g, " "));
      }
      if (!res.ok) throw new Error(json.error || "Failed to start regeneration");
      return json;
    },
    onSuccess: (run) => {
      qc.setQueryData(KEY, run);
      if (run.total === 0) {
        // The "nothing happened" case that would otherwise look like a hung
        // spinner: every subject resolved to the local service.
        toast.error(`Nothing to generate — ${run.skipped.length} type(s) have no AI provider`);
      } else {
        toast.success(`Regenerating ${run.total} image${run.total === 1 ? "" : "s"}`);
      }
    },
    onError: (err) => toast.error(err.message),
  });
}

export function useCancelBulkImageRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiFetch(`${API_URL}/api/bulk-image-jobs/cancel`, {
        method: "POST", headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to cancel");
      return res.json();
    },
    onSuccess: ({ cancelled, run }) => {
      qc.setQueryData(KEY, run);
      // The image being drawn right now is allowed to finish; saying so stops
      // the admin from clicking Cancel repeatedly when nothing appears to
      // happen for the next minute.
      toast.success(cancelled ? "Stopping after the current image" : "Nothing is running");
    },
    onError: (err) => toast.error(err.message),
  });
}
