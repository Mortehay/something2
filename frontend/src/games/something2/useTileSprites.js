import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/EngineClient.js";

const API = import.meta.env.VITE_API_URL || "http://localhost:13101";

// Absolute URL for a stored asset served through the backend (not MinIO directly):
export function assetUrl(key) {
  return key ? `${API}/api/assets/${key}` : null;
}

// Same, with a cache-busting version. Asset keys are stable across regenerations
// (sprites/objects/Tree/static.png is overwritten in place) and /api/assets sends
// `max-age=300`, so without this the browser keeps serving the PREVIOUS art for
// five minutes after an approval. Callers pass the row's updated_at, which the
// approval bumps.
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
