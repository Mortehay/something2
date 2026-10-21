import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";
import { API_URL } from "../../config.js";
const KEY = ["ai-provider-templates"];

function templateMutation({ method, url, successMessage, failMessage }) {
  return function useTemplateMutation() {
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

const useCreateTemplate = templateMutation({
  method: "POST", url: () => `${API_URL}/api/ai-provider-templates`,
  successMessage: "Template created", failMessage: "Failed to create template",
});
const useUpdateTemplate = templateMutation({
  method: "PATCH", url: (a) => `${API_URL}/api/ai-provider-templates/${a.id}`,
  successMessage: "Template saved", failMessage: "Failed to update template",
});
const useDeleteTemplate = templateMutation({
  method: "DELETE", url: (a) => `${API_URL}/api/ai-provider-templates/${a.id}`,
  successMessage: "Template deleted", failMessage: "Failed to delete template",
});
// Invalidates the TEMPLATES query (not the providers one): the provider row
// is unchanged, a new template appears.
const useSaveAsTemplate = templateMutation({
  method: "POST", url: (a) => `${API_URL}/api/ai-providers/${a.id}/save-as-template`,
  successMessage: "Saved as template", failMessage: "Failed to save template",
});

// Admin-managed provider presets (built-in + saved). Follows useAiProviders.js:
// every route is adminGuard'd, reads included, so authHeaders() is required on
// the GET too -- without it the request 401s and the admin is signed out.
export function useAiProviderTemplates() {
  const { data, isLoading, error } = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/ai-provider-templates`, { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch provider templates");
      return res.json();
    },
  });

  const create = useCreateTemplate();
  const update = useUpdateTemplate();
  const remove = useDeleteTemplate();
  const saveAs = useSaveAsTemplate();

  return {
    templates: data || [],
    isLoadingTemplates: isLoading,
    templatesError: error || null,
    create,
    update,
    remove,
    // Creates a template from an existing provider's config (server strips
    // the token); the success handler refreshes the templates list.
    saveProviderAsTemplate: (id, name) => saveAs.mutateAsync({ id, body: { name } }),
  };
}
