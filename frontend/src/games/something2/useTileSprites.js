import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders } from "./src/js/net/EngineClient.js";

const API = import.meta.env.VITE_API_URL || "http://localhost:13101";

// Absolute URL for a stored asset served through the backend (not MinIO directly):
export function assetUrl(key) {
  return key ? `${API}/api/assets/${key}` : null;
}

export function useGenerateTileJob() {
  return useMutation({
    mutationFn: async (body) => {
      const res = await fetch(`${API}/api/tile-jobs`, {
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
      const res = await fetch(`${API}/api/tile-jobs/${jobId}`);
      if (!res.ok) throw new Error("failed to fetch tile job");
      return res.json();
    },
  });
}

export function useApproveTileImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ tileId, ...body }) => {
      const res = await fetch(`${API}/api/tile-types/${tileId}/image`, {
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
      const res = await fetch(`${API}/api/tile-types/${tileId}/sprite`, {
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
