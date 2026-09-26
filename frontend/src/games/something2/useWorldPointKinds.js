import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { API_URL } from "../../config.js";

export function useWorldPointKinds() {
  const { data, isLoading } = useQuery({
    queryKey: ["world-point-kinds"],
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/world-point-kinds`);
      if (!res.ok) throw new Error("Failed to fetch world point kinds");
      return res.json();
    },
  });
  return { kinds: data || [], isLoadingKinds: isLoading };
}

// Defaults are read by the authority at loadWorld, so a change reaches a
// running world on its next activation, not live -- same as behaviours.
export function useSetPointKindDefault() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ kind, default_entity_type_id }) => {
      const res = await apiFetch(`${API_URL}/api/world-point-kinds/${encodeURIComponent(kind)}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ default_entity_type_id }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to set default");
      }
      return res.json();
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["world-point-kinds"] });
      toast.success(`${row.default_name || 'none'} is now the default for ${row.kind}`);
    },
    onError: (err) => toast.error(err.message),
  });
}
