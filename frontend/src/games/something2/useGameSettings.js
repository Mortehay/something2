import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { API_URL } from "../../config.js";

// Same shape as useVfxEffects.js: one read hook plus a mutation that
// invalidates the shared key.
//
// authHeaders() is NOT optional: every /api/settings route is adminGuard'd,
// READS INCLUDED. Without it the request 401s, noteAuthFailure fires, and the
// admin is signed out the moment they open this tab -- the exact defect
// useAiProviders.js documents at its own queryFn.
export const GAME_SETTINGS_KEY = ["game-settings"];

export function useGameSettings() {
  const { data, isLoading, error } = useQuery({
    queryKey: GAME_SETTINGS_KEY,
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/settings`, { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch game settings");
      return res.json();
    },
  });
  return { settings: data || [], isLoadingSettings: isLoading, settingsError: error || null };
}

export function useUpdateGameSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, value }) => {
      const res = await apiFetch(`${API_URL}/api/settings/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to update setting");
      }
      return res.json();
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: GAME_SETTINGS_KEY });
      toast.success(`${row.key} saved`);
    },
    onError: (e) => toast.error(e.message, { duration: 8000 }),
  });
}
