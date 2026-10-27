import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { API_URL } from "../../config.js";

// SOMET-608 (S6). The creature SKILL catalog -- same shape useCreatureBehaviors
// already uses. Open read (CreatureBehaviorsAdmin's kit-editor dropdown and
// this catalog's own table both need it), admin-guarded writes.
export function useCreatureSkills() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["creature-skills"],
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/creature-skills`);
      if (!res.ok) throw new Error("Failed to fetch creature skills");
      return res.json();
    },
  });
  return { creatureSkills: data || [], isLoadingSkills: isLoading, isSkillsError: isError };
}

// A 409 (DELETE blocked) names which behaviours still bind it -- surfaced so
// the admin can go unbind them rather than being told only "cannot delete".
function orphanMessage(body, fallback) {
  const behaviors = body.referencing_behaviors || [];
  if (behaviors.length === 0) return body.error || fallback;
  return `${body.error || fallback} — still bound by: ${behaviors.map((b) => b.name).join(", ")}`;
}

function skillMutation({ method, url, successMessage, failMessage }) {
  return function useSkillMutation() {
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
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["creature-skills"] });
        toast.success(successMessage);
      },
      onError: (e) => {
        toast.error(e.message, { duration: 8000 });
        // A refused delete (409) means the kit editor's dropdown may already
        // be stale (it still listed this skill as unbound) -- refetch so it
        // corrects itself rather than offering a delete that will fail again.
        if (e.status === 409) qc.invalidateQueries({ queryKey: ["creature-skills"] });
      },
    });
  };
}

export const useCreateCreatureSkill = skillMutation({
  method: "POST", url: () => `${API_URL}/api/creature-skills`,
  successMessage: "Creature skill created", failMessage: "Failed to create creature skill",
});
export const useUpdateCreatureSkill = skillMutation({
  method: "PUT", url: (a) => `${API_URL}/api/creature-skills/${a.id}`,
  successMessage: "Creature skill saved", failMessage: "Failed to update creature skill",
});
export const useDeleteCreatureSkill = skillMutation({
  method: "DELETE", url: (a) => `${API_URL}/api/creature-skills/${a.id}`,
  successMessage: "Creature skill deleted", failMessage: "Failed to delete creature skill",
});
