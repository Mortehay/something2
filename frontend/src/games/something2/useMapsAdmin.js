import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders } from "./src/js/net/EngineClient.js";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101";

export function useUpdateWorld() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }) => {
      const res = await fetch(`${API_URL}/api/worlds/${id}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to update map");
      return res.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worlds"] }); toast.success("Map saved"); },
    onError: (err) => toast.error(err.message),
  });
}

export function useRegenerateWorld() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const res = await fetch(`${API_URL}/api/worlds/${id}/regenerate`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to regenerate");
      return res.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worlds"] }); toast.success("Terrain regenerated"); },
    onError: (err) => toast.error(err.message),
  });
}

export function useRerollCreatures() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const res = await fetch(`${API_URL}/api/worlds/${id}/creatures`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to re-roll creatures");
      return res.json();
    },
    onSuccess: (data) => { qc.invalidateQueries({ queryKey: ["worlds"] }); toast.success(`Placed ${data.placed} creatures`); },
    onError: (err) => toast.error(err.message),
  });
}

export function useWorldLinks(worldId) {
  const { data: links } = useQuery({
    queryKey: ["worldLinks", worldId],
    enabled: !!worldId,
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/worlds/${worldId}/links`);
      if (!res.ok) throw new Error("Failed to fetch links");
      return res.json();
    },
  });
  return links || [];
}

export function useSetLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, edge, to_world_id }) => {
      const res = await fetch(`${API_URL}/api/worlds/${id}/links`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify({ edge, to_world_id }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to set link");
      return res.json();
    },
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ["worldLinks", v.id] }); qc.invalidateQueries({ queryKey: ["worlds"] }); toast.success("Link saved"); },
    onError: (err) => toast.error(err.message),
  });
}

export function useClearLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, edge }) => {
      const res = await fetch(`${API_URL}/api/worlds/${id}/links/${edge}`, { method: "DELETE", headers: authHeaders() });
      if (!res.ok && res.status !== 204) throw new Error("Failed to clear link");
      return true;
    },
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ["worldLinks", v.id] }); qc.invalidateQueries({ queryKey: ["worlds"] }); toast.success("Link cleared"); },
    onError: (err) => toast.error(err.message),
  });
}
