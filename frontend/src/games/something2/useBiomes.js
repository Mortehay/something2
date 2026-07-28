import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";

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

function biomeMutation({ method, url, successMessage, failMessage }) {
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
      onSuccess: () => { qc.invalidateQueries({ queryKey: ["biomes"] }); toast.success(successMessage); },
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
});
export const useDeleteBiome = biomeMutation({
  method: "DELETE", url: (a) => `${API_URL}/api/biomes/${a.id}`,
  successMessage: "Biome deleted", failMessage: "Failed to delete biome",
});
