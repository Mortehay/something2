import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { API_URL } from "../../config.js";

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
      // SOMET-555: the route is adminGuard'd now. apiFetch only adds 401
      // handling -- it does NOT attach the token, so the header has to be
      // passed explicitly or every load of this tab 401s.
      const res = await apiFetch(`${API_URL}/api/world-graph`, { headers: authHeaders() });
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

// SOMET-587/586: a portal doorway's art, set directly from the World Map
// tab's "Selected link" panel. `id` is the map_links row id — EITHER the
// departure row or its mirror arrival row, and which one determines which
// spec field the write lands on (`art` vs `to_art`): the backend resolves
// that purely from which physical row `id` addresses (see
// specFileLocator.js's findLinkInSpecs), so this hook's call shape never
// needs to say "which side" itself. Setting the other side of the same
// portal pair is a second, independent call with that row's own id. A 422
// means the locator could not find a single, unambiguous spec entry for
// this portal — that message is surfaced VERBATIM via toast, not swallowed
// or replaced with a generic "failed" string, since it is the one case the
// admin needs to actually read (the edit did NOT happen, in either the
// database or the spec file).
export function useSetPortalArt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, art_name }) => {
      const res = await apiFetch(`${API_URL}/api/map-links/${id}/art`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ art_name }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to save portal art");
      return res.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worldGraph"] }); },
    onError: (err) => toast.error(err.message),
  });
}
