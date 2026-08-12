import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101";

// Attack VFX slice E (SOMET-162). Same shape as useBiomes: one read hook plus
// three mutations that invalidate the shared key.
//
// The query key MUST be the one the GAME's own effect-library hook already
// uses -- ['vfxEffects'], read straight out of that hook rather than guessed.
// Retuning an effect here then invalidates the very cache entry the running
// game reads, which is what "tunable without a deploy" actually means. A
// near-miss key (['vfx-effects'], which is what this file had first) would
// look right, pass every test, and leave the editor and the canvas quietly
// disagreeing until a reload.
export const VFX_QUERY_KEY = ["vfxEffects"];

export function useVfxEffectsAdmin() {
  const { data, isLoading } = useQuery({
    queryKey: VFX_QUERY_KEY,
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/vfx-effects`);
      if (!res.ok) throw new Error("Failed to fetch vfx effects");
      return res.json();
    },
  });
  return { effects: data || [], isLoadingEffects: isLoading };
}

// A 409 from a rename or delete is the ORPHAN guard, not a generic failure:
// item_types.vfx and entity_types.vfx are jsonb with no FK, so the server
// refuses rather than silently breaking every binding. Surfacing the names it
// returns is the difference between "cannot delete" and an admin who can
// actually go and fix the bindings.
function orphanMessage(body, fallback) {
  const items = body.referencing_item_types || [];
  const entities = body.referencing_entity_types || [];
  if (items.length === 0 && entities.length === 0) return body.error || fallback;
  const names = [...items, ...entities].map((r) => r.name).join(", ");
  return `${body.error || fallback} — still bound by: ${names}`;
}

function vfxMutation({ method, url, successMessage, failMessage }) {
  return function useVfxMutation() {
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
          throw new Error(res.status === 409 ? orphanMessage(body, failMessage) : (body.error || failMessage));
        }
        return res.status === 204 ? true : res.json();
      },
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: VFX_QUERY_KEY });
        toast.success(successMessage);
      },
      // Longer than the default: an orphan message lists binding names the
      // admin has to act on, and a 2s toast is not enough to read them.
      onError: (e) => toast.error(e.message, { duration: 8000 }),
    });
  };
}

export const useCreateVfxEffect = vfxMutation({
  method: "POST",
  url: () => `${API_URL}/api/vfx-effects`,
  successMessage: "Effect created",
  failMessage: "Failed to create effect",
});

export const useUpdateVfxEffect = vfxMutation({
  method: "PUT",
  url: (arg) => `${API_URL}/api/vfx-effects/${arg.id}`,
  successMessage: "Effect updated",
  failMessage: "Failed to update effect",
});

export const useDeleteVfxEffect = vfxMutation({
  method: "DELETE",
  url: (arg) => `${API_URL}/api/vfx-effects/${arg.id ?? arg}`,
  successMessage: "Effect deleted",
  failMessage: "Failed to delete effect",
});
