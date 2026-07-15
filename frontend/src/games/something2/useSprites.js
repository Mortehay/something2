import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";

const API = import.meta.env.VITE_API_URL || "http://localhost:13101";

export function useGenerateSprite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body) => {
      const res = await fetch(`${API}/api/sprite-jobs`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
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
      const res = await fetch(`${API}/api/sprite-capability`);
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
      const res = await fetch(`${API}/api/sprite-jobs/${jobId}`);
      if (!res.ok) throw new Error("failed to fetch sprite job");
      return res.json();
    },
  });
}

export function useApproveSprite() {
  return useMutation({
    mutationFn: async ({ entityTypeId, ...body }) => {
      const res = await fetch(`${API}/api/entity-types/${entityTypeId}/sprite`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("failed to approve sprite");
      return res.json();
    },
    onSuccess: () => toast.success("Sprite approved"),
    onError: (e) => toast.error(e.message),
  });
}
