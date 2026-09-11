import { useQuery } from '@tanstack/react-query';
import { authHeaders, apiFetch } from './src/js/net/auth.js';
import { API_URL } from '../../config.js';

export const PASSIVE_TREE_KEY = ['passive-tree'];

// The whole graph -- ~1800 nodes and ~2400 edges -- for the Skill Tree admin
// tab (SOMET-571). The canvas overlay fetches the same route through
// passiveTreeClient.js; this is the React-query view of it, cached for the
// session because the graph changes only on a node edit or a reseed.
//
// authHeaders() is NOT optional: the route is requireAuth'd, and a 401 here
// fires noteAuthFailure and signs the admin out the moment they open the tab
// -- the trap usePassiveNodes.js documents at its own queryFn.
export function usePassiveTree() {
  const { data, isLoading, error } = useQuery({
    queryKey: PASSIVE_TREE_KEY,
    staleTime: Infinity,
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/passive-tree`, { headers: authHeaders() });
      if (!res.ok) throw new Error('Failed to load the passive tree');
      return res.json();
    },
  });
  return {
    nodes: (data && data.nodes) || [],
    edges: (data && data.edges) || [],
    isLoadingTree: isLoading,
    treeError: error || null,
  };
}
