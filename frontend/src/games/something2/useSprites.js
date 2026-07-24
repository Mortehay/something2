import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/EngineClient.js";

const API = import.meta.env.VITE_API_URL || "http://localhost:13101";

export function useGenerateSprite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body) => {
      const res = await apiFetch(`${API}/api/sprite-jobs`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("failed to start sprite job");
      return res.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sprite-jobs"] }); toast.success("Sprite job started"); },
    onError: (e) => toast.error(`Sprite job failed: ${e.message}`),
  });
}

export function useSpriteCapability() {
  return useQuery({
    queryKey: ["sprite-capability"],
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await apiFetch(`${API}/api/sprite-capability`);
      if (!res.ok) throw new Error("sprite service unavailable");
      return res.json();
    },
  });
}

export function useSpriteJob(jobId) {
  return useQuery({
    queryKey: ["sprite-jobs", jobId],
    enabled: !!jobId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "done" || s === "error" ? false : 1000;
    },
    queryFn: async () => {
      const res = await apiFetch(`${API}/api/sprite-jobs/${jobId}`);
      if (!res.ok) throw new Error("failed to fetch sprite job");
      return res.json();
    },
  });
}

export function useApproveSprite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ entityTypeId, ...body }) => {
      const res = await apiFetch(`${API}/api/entity-types/${entityTypeId}/sprite`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("failed to approve sprite");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["entityTypes"] });
      qc.invalidateQueries({ queryKey: ["mapConfig"] });
      toast.success("Sprite approved");
    },
    onError: (e) => toast.error(e.message),
  });
}

// --- Object-image path (kind:'object' — the tile pipeline, not directional) ---
// Same shape as useTileSprites' tile-job hooks, against /api/entity-jobs.

export function useGenerateEntityJob() {
  return useMutation({
    mutationFn: async (body) => {
      const res = await apiFetch(`${API}/api/entity-jobs`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("failed to start entity job");
      return res.json();
    },
    onSuccess: () => toast.success("Entity generation started"),
    onError: (e) => toast.error(`Entity job failed: ${e.message}`),
  });
}

export function useEntityJob(jobId) {
  return useQuery({
    queryKey: ["entity-jobs", jobId],
    enabled: !!jobId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "done" || s === "error" ? false : 1000;
    },
    queryFn: async () => {
      const res = await apiFetch(`${API}/api/entity-jobs/${jobId}`);
      if (!res.ok) throw new Error("failed to fetch entity job");
      return res.json();
    },
  });
}

// The atlas manifest ({ cell: [w,h], frames: { "0": [x,y,w,h], … } }) for a
// generated sprite. Needed to show a single FRAME of an animated entity — the
// atlas is a sprite sheet, so drawing it whole shows every frame at once.
// Cached indefinitely: a manifest only changes when a new atlas is approved
// under a new job, and the key is versioned by the caller.
export function useSpriteManifest(manifestKey) {
  return useQuery({
    queryKey: ["sprite-manifest", manifestKey],
    enabled: !!manifestKey,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const res = await apiFetch(`${API}/api/assets/${manifestKey}`);
      if (!res.ok) throw new Error("failed to fetch sprite manifest");
      return res.json();
    },
  });
}

export function useApproveEntityImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ entityTypeId, ...body }) => {
      const res = await apiFetch(`${API}/api/entity-types/${entityTypeId}/image`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("failed to approve entity image");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["entityTypes"] });
      qc.invalidateQueries({ queryKey: ["mapConfig"] });
      toast.success("Image approved");
    },
    onError: (e) => toast.error(e.message),
  });
}
