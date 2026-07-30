import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101";

// One snapshot of every world plus every link row (both directions).
export function useWorldGraph() {
  const { data, isLoading } = useQuery({
    queryKey: ["worldGraph"],
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/world-graph`);
      if (!res.ok) throw new Error("Failed to load the world graph");
      return res.json();
    },
  });
  return {
    worlds: data?.worlds || [],
    links: data?.links || [],
    isLoadingGraph: isLoading,
  };
}

// Node drags. Deliberately invalidates ONLY the graph query: a position is
// cosmetic, and busting the shared ["worlds"] cache on every drag would
// refetch the game's world picker for no reason. Silent on success — a toast
// per drag would be unbearable — but loud on failure, so a drag that did not
// persist never looks like it did.
export function useSaveGraphPosition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, x, y }) => {
      const res = await apiFetch(`${API_URL}/api/worlds/${id}/graph-position`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ x, y }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to save position");
      return res.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worldGraph"] }); },
    onError: (err) => toast.error(err.message),
  });
}
