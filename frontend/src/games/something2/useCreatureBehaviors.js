import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101";

export function useCreatureBehaviors() {
  const { data, isLoading } = useQuery({
    queryKey: ["creature-behaviors"],
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/creature-behaviors`);
      if (!res.ok) throw new Error("Failed to fetch creature behaviors");
      return res.json();
    },
  });
  return { behaviors: data || [], isLoadingBehaviors: isLoading };
}

// Unlike biomes' PUT, no mutation here can return a `liveWarning` -- creature
// behaviours are cached by the authority at `loadWorld`, not re-read live, so
// there is no running-world staleness to surface.
function behaviorMutation({ method, url, successMessage, failMessage }) {
  return function useBehaviorMutation() {
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
        qc.invalidateQueries({ queryKey: ["creature-behaviors"] });
        toast.success(successMessage);
      },
      onError: (err) => toast.error(err.message),
    });
  };
}

export const useCreateCreatureBehavior = behaviorMutation({
  method: "POST", url: () => `${API_URL}/api/creature-behaviors`,
  successMessage: "Behavior created", failMessage: "Failed to create behavior",
});
export const useUpdateCreatureBehavior = behaviorMutation({
  method: "PUT", url: (a) => `${API_URL}/api/creature-behaviors/${a.id}`,
  successMessage: "Behavior saved", failMessage: "Failed to update behavior",
});
export const useDeleteCreatureBehavior = behaviorMutation({
  method: "DELETE", url: (a) => `${API_URL}/api/creature-behaviors/${a.id}`,
  successMessage: "Behavior deleted", failMessage: "Failed to delete behavior",
});
