import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { API_URL } from "../../config.js";

// Aura library admin (SOMET-604). Same shape as useVfxEffects: one read hook
// plus three mutations that invalidate the shared key.
export const AURA_QUERY_KEY = ["auraEffects"];

// The list carries used_by (entity types binding each aura) for the Used by line.
export function useAuraEffectsAdmin() {
  const { data, isLoading, isError } = useQuery({
    queryKey: AURA_QUERY_KEY,
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/aura-effects`);
      if (!res.ok) throw new Error("Failed to fetch aura effects");
      return res.json();
    },
  });
  return { auras: data || [], isLoadingAuras: isLoading, isAuraError: isError };
}

// A 409 is the ORPHAN guard (entity bindings are by name, no FK): surface the
// names the server returns so the admin can go and unbind them.
function orphanMessage(body, fallback) {
  const entities = body.referencing_entity_types || [];
  if (entities.length === 0) return body.error || fallback;
  return `${body.error || fallback} — still bound by: ${entities.map((r) => r.name).join(", ")}`;
}

function auraMutation({ method, url, successMessage, failMessage }) {
  return function useAuraMutation() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: async (arg) => {
        const res = await apiFetch(url(arg), {
          method,
          headers: authHeaders(),
          body: method === "DELETE" ? undefined : JSON.stringify(arg.body ?? arg),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const err = new Error(res.status === 409 ? orphanMessage(body, failMessage) : (body.error || failMessage));
          err.status = res.status;
          throw err;
        }
        return res.status === 204 ? true : res.json();
      },
      onSuccess: (result) => {
        qc.invalidateQueries({ queryKey: AURA_QUERY_KEY });
        const renamed = result && typeof result === "object" ? Number(result.renamedBindings) || 0 : 0;
        if (method === "PUT") {
          // A cascade rename rewrites entity rows.
          qc.invalidateQueries({ queryKey: ["entityTypes"] });
          if (renamed > 0) {
            toast.success(`Aura renamed — ${renamed} entity binding(s) updated`);
            return;
          }
        }
        toast.success(successMessage);
      },
      // Longer than the default: an orphan message lists names to act on.
      onError: (e) => {
        toast.error(e.message, { duration: 8000 });
        // A refused delete (409) means our Used-by list was stale: refetch so the card corrects itself.
        if (e.status === 409) qc.invalidateQueries({ queryKey: AURA_QUERY_KEY });
      },
    });
  };
}

export const useCreateAuraEffect = auraMutation({
  method: "POST",
  url: () => `${API_URL}/api/aura-effects`,
  successMessage: "Aura created",
  failMessage: "Failed to create aura",
});

export const useUpdateAuraEffect = auraMutation({
  method: "PUT",
  url: (arg) => `${API_URL}/api/aura-effects/${arg.id}`,
  successMessage: "Aura updated",
  failMessage: "Failed to update aura",
});

export const useDeleteAuraEffect = auraMutation({
  method: "DELETE",
  url: (arg) => `${API_URL}/api/aura-effects/${arg.id ?? arg}`,
  successMessage: "Aura deleted",
  failMessage: "Failed to delete aura",
});
