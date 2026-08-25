import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { API_URL } from "../../config.js";

export const PASSIVE_NODES_KEY = ["passive-nodes"];

// The filter object is part of the query key, so a sector/kind/search change is
// a new cached page rather than a refetch that blanks the table.
//
// authHeaders() is NOT optional: /api/passive-nodes is adminGuard'd, READS
// INCLUDED. Without it the request 401s, noteAuthFailure fires, and the admin
// is signed out the moment they open this tab -- the defect useGameSettings.js
// documents at its own queryFn.
export function usePassiveNodes({ search = "", sector = "", kind = "", offset = 0, limit = 50 } = {}) {
  const { data, isLoading, error } = useQuery({
    queryKey: [...PASSIVE_NODES_KEY, { search, sector, kind, offset, limit }],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (search) qs.set("search", search);
      if (sector) qs.set("sector", sector);
      if (kind) qs.set("kind", kind);
      qs.set("offset", String(offset));
      qs.set("limit", String(limit));
      const res = await apiFetch(`${API_URL}/api/passive-nodes?${qs.toString()}`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to fetch passive nodes");
      return res.json();
    },
    // Keeps the previous page on screen while the next one loads, so paging
    // through 36 pages does not flash an empty table each time.
    placeholderData: (prev) => prev,
  });
  return {
    nodes: (data && data.nodes) || [],
    total: (data && data.total) || 0,
    isLoadingNodes: isLoading,
    nodesError: error || null,
  };
}

export function useUpdatePassiveNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }) => {
      const res = await apiFetch(`${API_URL}/api/passive-nodes/${id}`, {
        method: "PUT",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // The server's message names the offending stat/pool/element; showing
        // "Failed to save" instead would throw away the only thing that tells
        // the admin what they typed wrong.
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to save passive node");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PASSIVE_NODES_KEY });
      toast.success("Passive node saved");
    },
    onError: (err) => toast.error(err.message, { duration: 8000 }),
  });
}
