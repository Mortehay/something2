import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/EngineClient.js";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101";

// F-023: a caller that destructures only {worlds, isLoadingWorlds} and skips
// worldsError sees a failed fetch render as an indistinguishable-from-empty
// catalog (isLoadingWorlds -> false, worlds stays undefined, list becomes
// []). Rather than trust every call site to opt into toasting the error
// itself (Something2.jsx did; MapsAdmin.jsx didn't), the hook surfaces it
// for every caller. Exported standalone so the error->message mapping is
// unit-testable without a query/render harness.
export function toastWorldsError(worldsError) {
  if (worldsError) toast.error(`Failed to load worlds: ${worldsError.message}`);
}

export function useWorlds() {
  // TanStack Query v5 removed per-query `onError` from useQuery options, so
  // errors are surfaced via the returned `error`.
  const { data: worlds, isLoading: isLoadingWorlds, error: worldsError } = useQuery({
    queryKey: ["worlds"],
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/worlds`);
      if (!res.ok) throw new Error("Failed to fetch worlds");
      return res.json();
    },
  });
  useEffect(() => { toastWorldsError(worldsError); }, [worldsError]);
  return { worlds, isLoadingWorlds, worldsError };
}

export function useCreateWorld() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body) => {
      const res = await apiFetch(`${API_URL}/api/worlds`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to create world");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["worlds"] });
      toast.success("World created");
    },
    onError: (e) => toast.error(e.message),
  });
}

export function useDeleteWorld() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const res = await apiFetch(`${API_URL}/api/worlds/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to delete world");
      return id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["worlds"] });
      toast.success("World deleted");
    },
    onError: (e) => toast.error(e.message),
  });
}
