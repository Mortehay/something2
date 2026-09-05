import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { API_URL } from "../../config.js";

const KEY = ["world-gen", "worlds"];

// Every /api/world-gen route is adminGuard'd, reads included -- so authHeaders()
// is not optional on ANY call here. useAiProviders.js records what happens when
// it is forgotten on an admin-only GET: the request 401s, noteAuthFailure
// fires, and the admin is signed out the moment they open the tab.
async function readError(res, fallback) {
  const body = await res.json().catch(() => ({}));
  return new Error(body.error || fallback);
}

// The region list.
//
// `error` is returned rather than swallowed, and the component is expected to
// RENDER it. That is the acceptance criterion this surface was asked for: an
// auth failure and an unreachable generator must read as a message, not as an
// empty list -- the two are otherwise indistinguishable from "nothing has been
// generated yet", which is exactly the bug that shipped on the generator's own
// side.
export function useGeneratedWorlds() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/world-gen/worlds`, { headers: authHeaders() });
      if (!res.ok) throw await readError(res, "Failed to list generated regions");
      return res.json();
    },
    // A generator on the far side of a LAN link that goes stale silently is
    // not worth three automatic retries before the person is told anything.
    retry: false,
  });
  return {
    regions: data?.items || [],
    total: data?.total ?? 0,
    provider: data?.provider || null,
    isLoadingRegions: isLoading,
    isRefetchingRegions: isFetching,
    regionsError: error || null,
    refetchRegions: refetch,
  };
}

// The spec, plus this database's verdict on it. The backend validates on the
// way through so the UI can say "this will not seed" BEFORE anyone writes it
// into seeds/maps/.
export function useRegionSpec(name, { enabled = true } = {}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["world-gen", "spec", name],
    enabled: Boolean(name) && enabled,
    retry: false,
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/world-gen/worlds/${encodeURIComponent(name)}`,
        { headers: authHeaders() });
      if (!res.ok) throw await readError(res, "Failed to fetch region spec");
      return res.json();
    },
  });
  return { spec: data?.spec || null, valid: data?.valid ?? null, specErrors: data?.errors || [], isLoadingSpec: isLoading, specError: error || null };
}

// The GENERATOR's own verdict on a region, as opposed to this database's.
//
// Two different questions, and the tab shows both: `useRegionSpec` answers
// "will this seed here", `useRegionReport` answers "does the machine that made
// it think it came out well". A spec can validate perfectly and still carry a
// caveat saying it missed the density that was asked for -- which is exactly
// the case today, and there was previously nowhere in this UI for it to appear.
export function useRegionReport(name, version = null) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["world-gen", "report", name, version],
    enabled: Boolean(name),
    retry: false,
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/world-gen/worlds/${encodeURIComponent(name)}/report`,
        { headers: authHeaders() });
      if (!res.ok) throw await readError(res, "Failed to fetch region report");
      return res.json();
    },
  });
  return {
    report: data || null,
    caveats: data?.caveats || [],
    problems: data?.problems || [],
    notes: data?.notes || [],
    isLoadingReport: isLoading,
    reportError: error || null,
  };
}

// The preview PNG, fetched as a BLOB rather than pointed at with <img src>.
//
// The route is adminGuard'd, and an <img> element cannot send an Authorization
// header -- so a plain src would 401, and the alternative (a token in the query
// string) puts a credential in browser history and in every access log. Fetch
// it, keep an object URL, and revoke it on unmount.
// `version` is not decoration. A PATCH rewrites the region IN PLACE and keeps
// the same URL, so `name` alone never changes and an effect keyed only on it
// would keep showing the pre-edit picture next to a post-edit report -- with
// the two disagreeing on screen, which is precisely what the edit flow asks a
// person to look at. Callers pass something that moves when the region does.
export function useRegionPreview(name, version = null) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(Boolean(name));

  useEffect(() => {
    if (!name) { setUrl(null); setError(null); setLoading(false); return undefined; }
    let objectUrl = null;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await apiFetch(
          `${API_URL}/api/world-gen/worlds/${encodeURIComponent(name)}/preview.png`,
          { headers: authHeaders() },
        );
        if (!res.ok) throw await readError(res, "Failed to load preview");
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (err) {
        if (!cancelled) { setError(err); setUrl(null); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      // Revoked on unmount AND on every name change: an admin clicking through
      // eight regions would otherwise leak eight decoded PNGs for the life of
      // the page.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [name, version]);

  return { previewUrl: url, previewError: error, isLoadingPreview: loading };
}

function worldGenMutation({ method, url, body, successMessage, failMessage, invalidateSpec = false }) {
  return function useWorldGenMutation() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: async (arg) => {
        const res = await apiFetch(url(arg), {
          method,
          headers: authHeaders(),
          body: body ? JSON.stringify(body(arg)) : undefined,
        });
        if (!res.ok) throw await readError(res, failMessage);
        return res.json();
      },
      onSuccess: (data, arg) => {
        qc.invalidateQueries({ queryKey: KEY });
        if (invalidateSpec) {
          qc.invalidateQueries({ queryKey: ["world-gen", "spec", arg?.name] });
        }
        if (successMessage) toast.success(successMessage(data, arg));
      },
      onError: (err) => toast.error(err.message),
    });
  };
}

export const useCreateRegion = worldGenMutation({
  method: "POST",
  url: () => `${API_URL}/api/world-gen/worlds`,
  body: (arg) => arg,
  successMessage: (data) => `Generated "${data?.name || "region"}"`,
  failMessage: "Failed to create region",
});

// PATCH sends ONLY the changed field. The generator carries over everything it
// is not given, including the biome plan -- which is what makes "raise the
// target without redrawing the region's character" possible at all.
export const useEditRegion = worldGenMutation({
  method: "PATCH",
  url: (arg) => `${API_URL}/api/world-gen/worlds/${encodeURIComponent(arg.name)}`,
  body: (arg) => arg.patch,
  successMessage: (_d, arg) => `Updated "${arg.name}"`,
  failMessage: "Failed to edit region",
  invalidateSpec: true,
});

export const useDeleteRegion = worldGenMutation({
  method: "DELETE",
  url: (arg) => `${API_URL}/api/world-gen/worlds/${encodeURIComponent(arg.name)}`,
  successMessage: (_d, arg) => `Deleted "${arg.name}"`,
  failMessage: "Failed to delete region",
});

export const useDownloadRegion = worldGenMutation({
  method: "POST",
  url: (arg) => `${API_URL}/api/world-gen/worlds/${encodeURIComponent(arg.name)}/download`,
  successMessage: (data) => `Wrote ${data.written}`,
  failMessage: "Failed to download region spec",
});

// The confirm value is the region's own NAME, echoed back -- not a boolean.
// Seeding rewrites the world graph players navigate and drops any live doorway
// the spec does not declare, and one spec per database means seeding a second
// region strands the first one's worlds.
export const useSeedRegion = worldGenMutation({
  method: "POST",
  url: (arg) => `${API_URL}/api/world-gen/worlds/${encodeURIComponent(arg.name)}/seed`,
  body: (arg) => ({ confirm: arg.name }),
  successMessage: (_d, arg) => `Seeded "${arg.name}" — restart the backend`,
  failMessage: "Failed to seed region",
});
