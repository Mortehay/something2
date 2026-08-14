import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101";
const KEY = ["ai-providers"];

// SOMET-330. Follows useBiomes.js: one query hook plus a mutation factory.
//
// The list is admin-only server-side, so this hook is only mounted from the
// admin Settings route. Rows never carry auth_token -- they carry has_token --
// so nothing here needs to be careful about logging or caching them.
export function useAiProviders() {
  const { data, isLoading, error } = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/ai-providers`);
      if (!res.ok) throw new Error("Failed to fetch AI providers");
      return res.json();
    },
  });
  return {
    providers: data || [],
    isLoadingProviders: isLoading,
    providersError: error || null,
    // The one the generation path will use by default. Disabled profiles are
    // excluded here for the same reason the backend excludes them: an
    // active-but-disabled provider is not the effective default.
    activeProvider: (data || []).find((p) => p.is_active && p.enabled !== false) || null,
  };
}

function providerMutation({ method, url, successMessage, failMessage }) {
  return function useProviderMutation() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: async (arg) => {
        const res = await apiFetch(url(arg), {
          method,
          headers: authHeaders(),
          body: method === "DELETE" ? undefined : JSON.stringify(arg.body ?? arg),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || failMessage);
        return res.status === 204 ? true : res.json();
      },
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: KEY });
        if (successMessage) toast.success(successMessage);
      },
      onError: (err) => toast.error(err.message),
    });
  };
}

export const useCreateProvider = providerMutation({
  method: "POST", url: () => `${API_URL}/api/ai-providers`,
  successMessage: "Provider created", failMessage: "Failed to create provider",
});
export const useUpdateProvider = providerMutation({
  method: "PATCH", url: (a) => `${API_URL}/api/ai-providers/${a.id}`,
  successMessage: "Provider saved", failMessage: "Failed to update provider",
});
export const useDeleteProvider = providerMutation({
  method: "DELETE", url: (a) => `${API_URL}/api/ai-providers/${a.id}`,
  successMessage: "Provider deleted", failMessage: "Failed to delete provider",
});
export const useActivateProvider = providerMutation({
  method: "POST", url: (a) => `${API_URL}/api/ai-providers/${a.id}/activate`,
  successMessage: "Provider activated", failMessage: "Failed to activate provider",
});

// Refresh and Test both answer 200 with { ok: false, error } when the remote
// box is simply switched off, so success/failure is read from the BODY rather
// than from the HTTP status. Treating a reachable-but-off provider as a failed
// request would be wrong: the request worked, the box did not.
export function useRefreshModels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }) => {
      const res = await apiFetch(`${API_URL}/api/ai-providers/${id}/refresh-models`, {
        method: "POST", headers: authHeaders(),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to refresh models");
      return res.json();
    },
    onSuccess: (data) => {
      if (data.ok) {
        // Refetch so the dropdown reads models_cache from the stored row
        // rather than from this response -- one source of truth.
        qc.invalidateQueries({ queryKey: KEY });
        toast.success(`Found ${data.models.length} model${data.models.length === 1 ? "" : "s"}`);
      } else {
        // The previously cached list is left alone by the backend, so the
        // admin does not lose the names they already had.
        toast.error(data.error || "Could not reach the provider");
      }
    },
    onError: (err) => toast.error(err.message),
  });
}

export function useTestProvider() {
  return useMutation({
    mutationFn: async ({ id }) => {
      const res = await apiFetch(`${API_URL}/api/ai-providers/${id}/test`, {
        method: "POST", headers: authHeaders(),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to test provider");
      return res.json();
    },
    onSuccess: (data) => {
      if (data.ok) toast.success(`Reachable (${data.latency_ms}ms)`);
      else toast.error(data.error || "Not reachable");
    },
    onError: (err) => toast.error(err.message),
  });
}
