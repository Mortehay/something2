import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { deleteBehaviorErrorMessage } from "./behaviorForm.js";
import { API_URL } from "../../config.js";

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
        // `arg` (create/update) is `{ ...behaviorFormToPayload(...), abilities }`
        // from CreatureBehaviorsAdmin's handleSubmit -- the nested `abilities`
        // array (SOMET-253 Task 3) rides along inside it with nothing special
        // done here, straight into the same JSON body every other field goes
        // through. The API validates and replaces the whole set transactionally.
        const res = await apiFetch(url(arg), {
          method,
          headers: authHeaders(),
          body: method === "DELETE" ? undefined : JSON.stringify(arg.body ?? arg),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const err = new Error(body.error || failMessage);
          // Only DELETE's 409 sets this (a creature type still points at the
          // profile); the two 400 validation errors never do, so this is
          // undefined -- and therefore harmless -- for create/update.
          if (body.referencing_entity_types) err.referencingEntityTypes = body.referencing_entity_types;
          throw err;
        }
        return res.status === 204 ? true : res.json();
      },
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["creature-behaviors"] });
        toast.success(successMessage);
      },
      // `variables` is whatever was passed to .mutate(...). Only the delete
      // call site supplies `name` (the profile being deleted); when it's
      // absent, or when the error carries no referencingEntityTypes,
      // deleteBehaviorErrorMessage falls straight back to err.message.
      onError: (err, variables) =>
        toast.error(deleteBehaviorErrorMessage(variables?.name, err.referencingEntityTypes, err.message)),
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
