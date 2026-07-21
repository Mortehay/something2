import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders } from "./src/js/net/EngineClient.js";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101";

export function useWorlds() {
  // TanStack Query v5 removed per-query `onError` from useQuery options, so
  // errors are surfaced via the returned `error` and toasted by the caller.
  const { data: worlds, isLoading: isLoadingWorlds, error: worldsError } = useQuery({
    queryKey: ["worlds"],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/worlds`);
      if (!res.ok) throw new Error("Failed to fetch worlds");
      return res.json();
    },
  });
  return { worlds, isLoadingWorlds, worldsError };
}

export function useCreateWorld() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, seed, chunk_size }) => {
      const res = await fetch(`${API_URL}/api/worlds`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ name, seed, chunk_size }),
      });
      if (!res.ok) throw new Error("Failed to create world");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["worlds"] });
      toast.success("World created");
    },
    onError: (e) => toast.error(e.message),
  });
}
