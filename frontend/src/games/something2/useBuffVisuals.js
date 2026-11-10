import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { API_URL } from "../../config.js";

// Buff Auras admin. The same open GET and query key the game client reads (the map hooks'
// useBuffVisuals), so a save here reaches a running game on the refetch. Rows are fixed by the
// skill catalog: no create, no delete -- only a PUT per visual buff.
export const BUFF_VISUALS_QUERY_KEY = ["buffVisuals"];

export function useBuffVisualsAdmin() {
  const { data, isLoading, isError } = useQuery({
    queryKey: BUFF_VISUALS_QUERY_KEY,
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/buff-visuals`);
      if (!res.ok) throw new Error("Failed to fetch buff visuals");
      return res.json();
    },
  });
  return {
    visuals: (data && data.visuals) || [],
    settings: (data && data.settings) || null,
    isLoadingVisuals: isLoading,
    isVisualsError: isError,
  };
}

// arg = { skillId, body }. The body comes from buffFormToPayload: numbers as numbers, and no
// sprite_* key unless the sprite was edited (the API's omit-key rule).
export function useUpdateBuffVisual() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ skillId, body }) => {
      const res = await apiFetch(`${API_URL}/api/buff-visuals/${encodeURIComponent(skillId)}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to save buff visual");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: BUFF_VISUALS_QUERY_KEY });
      toast.success("Buff aura saved");
    },
    onError: (e) => toast.error(e.message, { duration: 8000 }),
  });
}
