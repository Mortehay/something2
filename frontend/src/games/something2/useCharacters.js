import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { API_URL } from "../../config.js";

// Same posture as useWorlds.js: the hook surfaces its own load error rather
// than trusting every call site to opt in, and uses a fixed toast id so N
// callers (or a retrying query) produce one message rather than a stack.
export const CHARACTERS_ERROR_TOAST_ID = "characters-load-error";

export function toastCharactersError(charactersError) {
  if (charactersError) {
    toast.error(`Failed to load characters: ${charactersError.message}`,
      { id: CHARACTERS_ERROR_TOAST_ID });
  }
}

// The server's error codes, mapped to something a player can act on. Falling
// back to the raw code is deliberate: an unmapped code should look wrong in the
// UI rather than be swallowed into a generic "something went wrong".
const CREATE_ERRORS = {
  name_taken: "That name is already taken.",
  no_free_slot: "All 8 character slots are in use. Delete one first.",
  bad_name: "Pick a name between 1 and 32 characters.",
  not_playable: "That class cannot be played.",
};

async function readError(res, fallback) {
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON body */ }
  const code = body && body.error;
  return new Error(CREATE_ERRORS[code] || code || fallback);
}

export function useCharacters() {
  const { data, isLoading: isLoadingCharacters, error: charactersError } = useQuery({
    queryKey: ["characters"],
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/characters`, { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch characters");
      return res.json();
    },
  });
  useEffect(() => { toastCharactersError(charactersError); }, [charactersError]);
  return {
    characters: data && data.characters,
    // Only ever the server's number. Defaulting to 8 here would put a second
    // copy of the cap in the client, free to drift from the schema constraint.
    maxCharacters: data && data.maxCharacters,
    isLoadingCharacters,
    charactersError,
  };
}

export function usePlayableClasses() {
  const { data, isLoading: isLoadingClasses } = useQuery({
    queryKey: ["playableClasses"],
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/characters/classes`, { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch classes");
      return res.json();
    },
  });
  return { classes: data && data.classes, isLoadingClasses };
}

export function useCreateCharacter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, entityTypeId }) => {
      const res = await apiFetch(`${API_URL}/api/characters`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ name, entity_type_id: entityTypeId }),
      });
      if (!res.ok) throw await readError(res, "Failed to create character");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["characters"] });
      toast.success("Character created");
    },
    onError: (e) => toast.error(e.message),
  });
}

export function useDeleteCharacter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const res = await apiFetch(`${API_URL}/api/characters/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) throw await readError(res, "Failed to delete character");
      return id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["characters"] });
      toast.success("Character deleted");
    },
    onError: (e) => toast.error(e.message),
  });
}
