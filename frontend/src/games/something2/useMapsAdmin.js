import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { liveWarningFromBody, liveWarningFromHeader, LIVE_WARNING_TOAST_OPTS } from "./liveWarning.js";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101";

// A plain toast.success would tell the admin an edit fully landed when a
// connected player kept it from reaching the live simulation -- surface
// `liveWarning` (see liveWarning.js) as a separate, longer-lived warning
// toast alongside the success toast.
function warnIfLive(data) {
  const msg = liveWarningFromBody(data);
  if (msg) toast(msg, LIVE_WARNING_TOAST_OPTS);
}

export function useUpdateWorld() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }) => {
      const res = await apiFetch(`${API_URL}/api/worlds/${id}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to update map");
      return res.json();
    },
    onSuccess: (data) => { qc.invalidateQueries({ queryKey: ["worlds"] }); toast.success("Map saved"); warnIfLive(data); },
    onError: (err) => toast.error(err.message),
  });
}

export function useRegenerateWorld() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const res = await apiFetch(`${API_URL}/api/worlds/${id}/regenerate`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to regenerate");
      return res.json();
    },
    onSuccess: (data) => { qc.invalidateQueries({ queryKey: ["worlds"] }); toast.success("Terrain regenerated"); warnIfLive(data); },
    onError: (err) => toast.error(err.message),
  });
}

export function useRerollCreatures() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const res = await apiFetch(`${API_URL}/api/worlds/${id}/creatures`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to re-roll creatures");
      return res.json();
    },
    onSuccess: (data) => { qc.invalidateQueries({ queryKey: ["worlds"] }); toast.success(`Placed ${data.placed} creatures`); warnIfLive(data); },
    onError: (err) => toast.error(err.message),
  });
}

export function useWorldLinks(worldId) {
  const { data: links } = useQuery({
    queryKey: ["worldLinks", worldId],
    enabled: !!worldId,
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/worlds/${worldId}/links`);
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
      const res = await apiFetch(`${API_URL}/api/worlds/${id}/links`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify({ edge, to_world_id }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to set link");
      return res.json();
    },
    onSuccess: (data, v) => {
      qc.invalidateQueries({ queryKey: ["worldLinks", v.id] });
      qc.invalidateQueries({ queryKey: ["worlds"] });
      // The World Map tab reads links through ["worldGraph"]; without this it
      // keeps drawing a link the Maps tab just changed.
      qc.invalidateQueries({ queryKey: ["worldGraph"] });
      toast.success("Link saved");
      warnIfLive(data);
    },
    onError: (err) => toast.error(err.message),
  });
}

export function useClearLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, edge }) => {
      const res = await apiFetch(`${API_URL}/api/worlds/${id}/links/${edge}`, { method: "DELETE", headers: authHeaders() });
      if (!res.ok && res.status !== 204) throw new Error("Failed to clear link");
      // 204 carries no body -- the live-connection warning travels as a
      // header instead (see the matching backend comment on this route).
      return { liveWarning: liveWarningFromHeader(res.headers.get("X-Live-World-Pending")) };
    },
    onSuccess: (data, v) => {
      qc.invalidateQueries({ queryKey: ["worldLinks", v.id] });
      qc.invalidateQueries({ queryKey: ["worlds"] });
      qc.invalidateQueries({ queryKey: ["worldGraph"] });
      toast.success("Link cleared");
      warnIfLive(data);
    },
    onError: (err) => toast.error(err.message),
  });
}

export function useWorldVillages(worldId) {
  const { data } = useQuery({
    queryKey: ["worldVillages", worldId],
    enabled: !!worldId,
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/worlds/${worldId}/villages`, { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to load villages");
      return res.json();
    },
  });
  return data || [];
}

export function useAddVillage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }) => {
      const res = await apiFetch(`${API_URL}/api/worlds/${id}/villages`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to add village");
      return res.json();
    },
    onSuccess: (data, v) => { qc.invalidateQueries({ queryKey: ["worldVillages", v.id] }); toast.success("Village added"); warnIfLive(data); },
    onError: (err) => toast.error(err.message),
  });
}

export function useDeleteVillage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, villageId }) => {
      const res = await apiFetch(`${API_URL}/api/worlds/${id}/villages/${villageId}`, {
        method: "DELETE", headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to delete village");
      // See useClearLink above: 204 carries no body, the warning is a header.
      return { liveWarning: liveWarningFromHeader(res.headers.get("X-Live-World-Pending")) };
    },
    onSuccess: (data, v) => { qc.invalidateQueries({ queryKey: ["worldVillages", v.id] }); toast.success("Village deleted"); warnIfLive(data); },
    onError: (err) => toast.error(err.message),
  });
}
