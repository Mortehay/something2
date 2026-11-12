// SOMET-769: the display writes (Code / Sprite) for the effect catalogs -- one "for all"
// mutation per catalog, plus the status visuals' read and per-row write (their only admin
// writes). Each invalidates the key the game's own hook reads, so a change reaches the
// running game without a reload (the useVfxEffects rule).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { API_URL } from "../../config.js";
import { VFX_QUERY_KEY } from "./useVfxEffects.js";
import { AURA_QUERY_KEY } from "./useAuraEffects.js";
import { BUFF_VISUALS_QUERY_KEY } from "./useBuffVisuals.js";
import { STATUS_VISUALS_QUERY_KEY } from "./useMaps.js";

async function putJson(url, body, failMessage) {
  const res = await apiFetch(url, { method: "PUT", headers: authHeaders(), body: JSON.stringify(body) });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    const err = new Error(b.error || failMessage);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function displayAllHook({ path, queryKey, what }) {
  return function useSetDisplayAll() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (display) => putJson(`${API_URL}${path}/display`, { display }, `Failed to set ${what} display`),
      onSuccess: (r) => {
        qc.invalidateQueries({ queryKey });
        toast.success(`${r.updated} ${what} set to ${r.display}`);
      },
      onError: (err) => toast.error(err.message),
    });
  };
}

export const useSetVfxDisplayAll = displayAllHook({ path: "/api/vfx-effects", queryKey: VFX_QUERY_KEY, what: "effects" });
export const useSetAuraDisplayAll = displayAllHook({ path: "/api/aura-effects", queryKey: AURA_QUERY_KEY, what: "auras" });
export const useSetBuffDisplayAll = displayAllHook({ path: "/api/buff-visuals", queryKey: BUFF_VISUALS_QUERY_KEY, what: "buff auras" });
export const useSetStatusDisplayAll = displayAllHook({ path: "/api/status-visuals", queryKey: STATUS_VISUALS_QUERY_KEY, what: "status visuals" });

// The status rows (amber seal variants), the same list the game reads.
export function useStatusVisualsAdmin() {
  const { data, isLoading, isError } = useQuery({
    queryKey: STATUS_VISUALS_QUERY_KEY,
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/status-visuals`);
      if (!res.ok) throw new Error("Failed to fetch status visuals");
      return res.json();
    },
  });
  return { statusVisuals: data || [], isLoadingStatus: isLoading, isStatusError: isError };
}

export function useSetStatusDisplay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, display }) => putJson(`${API_URL}/api/status-visuals/${encodeURIComponent(key)}`, { display }, "Failed to save status visual"),
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: STATUS_VISUALS_QUERY_KEY });
      toast.success(`${row.key} draws as ${row.display}`);
    },
    onError: (err) => toast.error(err.message),
  });
}
