import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101";

// F-023: a caller that destructures only {worlds, isLoadingWorlds} and skips
// worldsError sees a failed fetch render as an indistinguishable-from-empty
// catalog (isLoadingWorlds -> false, worlds stays undefined, list becomes
// []). Rather than trust every call site to opt into toasting the error
// itself (Something2.jsx did; MapsAdmin.jsx didn't), the hook surfaces it
// for every caller. Exported standalone so the error->message mapping is
// unit-testable without a query/render harness.
//
// The fixed toast id is what makes "every caller gets it for free" safe. Since
// the sidebar-nav split, GameShell and GameView are BOTH mounted on /game and
// both call useWorlds(), so one failed fetch ran this twice and stacked two
// identical toasts. react-hot-toast treats a repeated id as an update to the
// live toast rather than a new one, so N callers still produce one message --
// and a retrying query can't build a tower of them either.
export const WORLDS_ERROR_TOAST_ID = "worlds-load-error";

export function toastWorldsError(worldsError) {
  if (worldsError) {
    toast.error(`Failed to load worlds: ${worldsError.message}`, { id: WORLDS_ERROR_TOAST_ID });
  }
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
      // The World Map tab reads worlds through ["worldGraph"]; without this a
      // world created here does not appear on the diagram for up to staleTime.
      queryClient.invalidateQueries({ queryKey: ["worldGraph"] });
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
      // The World Map tab reads worlds through ["worldGraph"]; without this a
      // deleted world keeps being drawn (and its links stay clickable) for up
      // to staleTime -- see useMapGraph.test.js's cross-tab invalidation
      // suite for the failure this produces.
      queryClient.invalidateQueries({ queryKey: ["worldGraph"] });
      toast.success("World deleted");
    },
    onError: (e) => toast.error(e.message),
  });
}
