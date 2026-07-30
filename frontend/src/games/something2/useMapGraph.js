import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101";

// F-023 (see useWorlds.js): a caller that destructures only {worlds, links,
// isLoadingGraph} and skips the error sees a failed fetch render as an
// indistinguishable-from-empty graph (isLoadingGraph -> false, worlds/links
// stay []), which MapGraphAdmin's consistency panel then reports as "No
// problems found." -- a positive claim about state the client never received.
// Exported standalone so the error->message mapping is unit-testable without
// a query/render harness.
export function toastGraphError(graphError) {
  if (graphError) toast.error(`Failed to load the world graph: ${graphError.message}`);
}

// One snapshot of every world plus every link row (both directions).
export function useWorldGraph() {
  // TanStack Query v5 removed per-query `onError` from useQuery options, so
  // errors are surfaced via the returned `error`.
  const { data, isLoading, error: graphError } = useQuery({
    queryKey: ["worldGraph"],
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/world-graph`);
      if (!res.ok) throw new Error("Failed to load the world graph");
      return res.json();
    },
  });
  useEffect(() => { toastGraphError(graphError); }, [graphError]);
  return {
    worlds: data?.worlds || [],
    links: data?.links || [],
    isLoadingGraph: isLoading,
    graphError,
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
