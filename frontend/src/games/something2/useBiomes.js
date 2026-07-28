import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { liveWarningFromBody, LIVE_WARNING_TOAST_OPTS } from "./liveWarning.js";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101";

export function useBiomes() {
  const { data, isLoading } = useQuery({
    queryKey: ["biomes"],
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/biomes`);
      if (!res.ok) throw new Error("Failed to fetch biomes");
      return res.json();
    },
  });
  return { biomes: data || [], isLoadingBiomes: isLoading };
}

// Only PUT /api/biomes/:id can return `liveWarning` (F-017/SOMET-197): a
// biome's terrain_tiles/flora_types/creature_types changed and a world using
// it has a connected player that could not be evicted, so the live
// simulation is still serving the pre-edit definition. POST (a brand new
// biome, unused by any world yet) and DELETE (refused outright when any
// world still lists the biome -- a 409, not a 200) can't produce it -- see
// backend/src/index.js's PUT /api/biomes/:id handler, the only one that
// calls invalidateWorld/evictOrWarn.
function biomeMutation({ method, url, successMessage, failMessage, surfaceLiveWarning = false }) {
  return function useBiomeMutation() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: async (arg) => {
        const res = await apiFetch(url(arg), {
          method,
          headers: authHeaders(),
          body: method === "DELETE" ? undefined : JSON.stringify(arg.body ?? arg),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || failMessage);
        return res.status === 204 ? true : res.json();
      },
      onSuccess: (data) => {
        qc.invalidateQueries({ queryKey: ["biomes"] });
        toast.success(successMessage);
        const warning = surfaceLiveWarning && liveWarningFromBody(data);
        if (warning) toast(warning, LIVE_WARNING_TOAST_OPTS);
      },
      onError: (err) => toast.error(err.message),
    });
  };
}

export const useCreateBiome = biomeMutation({
  method: "POST", url: () => `${API_URL}/api/biomes`,
  successMessage: "Biome created", failMessage: "Failed to create biome",
});
export const useUpdateBiome = biomeMutation({
  method: "PUT", url: (a) => `${API_URL}/api/biomes/${a.id}`,
  successMessage: "Biome saved", failMessage: "Failed to update biome",
  surfaceLiveWarning: true,
});
export const useDeleteBiome = biomeMutation({
  method: "DELETE", url: (a) => `${API_URL}/api/biomes/${a.id}`,
  successMessage: "Biome deleted", failMessage: "Failed to delete biome",
});
