import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { API_URL } from "../../config.js";
const KEY = ["ai-providers"];

// SOMET-590 game audio slice 1: one active provider PER MODALITY (the backend
// enforces this with a non-deferrable per-modality unique index), so picking
// "the" active provider is meaningless without saying which modality wants
// it. A row without `modality` predates the column and counts as 'image' --
// the only kind that existed before audio providers did.
//
// Exported (not just used inline) so it is unit-testable without mounting
// the query hook, and so the one rule -- an image picker must never receive
// the audio provider -- has a single place it can be checked.
export function pickActive(providers, modality) {
  return (providers || []).find((p) => p.is_active && p.enabled !== false
    && (p.modality || 'image') === modality) || null;
}

// SOMET-591 (verification fix): the Audio admin's generation controls (Suggest,
// Generate, Queue N jobs, Start) need an active audio provider; everything else
// (upload, library, bind-from-library, remove, volume/weight, retry/clear/stop,
// the misses list) works without one and must stay usable on a box with no GPU
// provider configured yet.
//
// Pure so it's testable without mounting useAiProviders(), and so AudioAdmin
// and SubjectSounds (which derives this independently for MapsAdmin/BiomesAdmin,
// see SubjectSounds.jsx) apply the exact same rule:
// - a query error is its own banner ("could not load", not "none exists") and
//   never disables generation -- we don't actually know there isn't one
// - still loading defaults to enabled, so a slow fetch doesn't flash every
//   button disabled for a moment before re-enabling them
// - only a settled fetch with no active audio provider disables generation
export function audioProviderState({ activeAudioProvider, isLoading, error }) {
  if (error) {
    return { canGenerate: true, banner: 'error' };
  }
  if (!isLoading && !activeAudioProvider) {
    return { canGenerate: false, banner: 'none' };
  }
  return { canGenerate: true, banner: null };
}

// SOMET-330. Follows useBiomes.js: one query hook plus a mutation factory.
//
// The list is admin-only server-side, so this hook is only mounted from the
// admin Settings route. Rows never carry auth_token -- they carry has_token --
// so nothing here needs to be careful about logging or caching them.
export function useAiProviders() {
  const { data, isLoading, error } = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      // authHeaders() is NOT optional here, and this is the one place it is
      // easy to forget: apiFetch does not attach the token itself, it only
      // notices auth failures. The sibling catalog GETs (useBiomes and the
      // other catalog hooks) omit it safely because those routes are public
      // -- but every
      // /api/ai-providers route is adminGuard'd, including the reads.
      //
      // Without it the request 401s, noteAuthFailure fires, and the admin is
      // signed out the moment they open the AI Providers tab. Caught in the
      // browser; no unit test sees it, because none of them run the guard.
      const res = await apiFetch(`${API_URL}/api/ai-providers`, { headers: authHeaders() });
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
    //
    // Image-only: every image picker in this codebase (ProviderChoice,
    // ProviderPinField, TypeProviderPinChoice, the Art console) reads
    // `activeProvider` and must never be handed an audio profile. Audio
    // consumers read `activeAudioProvider` instead.
    activeProvider: pickActive(data, 'image'),
    activeAudioProvider: pickActive(data, 'audio'),
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
