import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { API_URL as API } from "../../config.js";

// Absolute URL for a stored asset served through the backend (not MinIO directly):
export function assetUrl(key) {
  return key ? `${API}/api/assets/${key}` : null;
}

// Same, with a cache-busting version. SOMET-235: asset keys are now job-id-scoped
// and never reused across regenerations (e.g. sprites/objects/Tree/<job_id>/static.png
// -- a new generation never overwrites a previous one), so this `?v=` is now
// redundant-but-harmless rather than load-bearing: a fresh key is already a
// fresh URL. Kept as cheap insurance since /api/assets sends `max-age=300`.
// Callers pass the row's updated_at, which the approval bumps.
export function assetUrlVersioned(key, version) {
  const url = assetUrl(key);
  if (!url) return null;
  return version ? `${url}?v=${encodeURIComponent(version)}` : url;
}

export function useGenerateTileJob() {
  return useMutation({
    mutationFn: async (body) => {
      const res = await apiFetch(`${API}/api/tile-jobs`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("failed to start tile job");
      return res.json();
    },
    onSuccess: () => toast.success("Tile generation started"),
    onError: (e) => toast.error(`Tile job failed: ${e.message}`),
  });
}

export function useTileJob(jobId) {
  return useQuery({
    queryKey: ["tile-jobs", jobId],
    enabled: !!jobId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "done" || s === "error" ? false : 1000;
    },
    queryFn: async () => {
      const res = await apiFetch(`${API}/api/tile-jobs/${jobId}`);
      if (!res.ok) throw new Error("failed to fetch tile job");
      return res.json();
    },
  });
}

export function useApproveTileImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ tileId, ...body }) => {
      const res = await apiFetch(`${API}/api/tile-types/${tileId}/image`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("failed to approve tile texture");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tileTypes"] });
      qc.invalidateQueries({ queryKey: ["mapTiles"] });
      toast.success("Texture approved");
    },
    onError: (e) => toast.error(e.message),
  });
}

export function useApproveTileSprite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ tileId, ...body }) => {
      const res = await apiFetch(`${API}/api/tile-types/${tileId}/sprite`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("failed to approve tile animation");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tileTypes"] });
      qc.invalidateQueries({ queryKey: ["mapTiles"] });
      toast.success("Animation approved");
    },
    onError: (e) => toast.error(e.message),
  });
}
