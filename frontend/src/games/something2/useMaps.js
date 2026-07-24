import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import toast from 'react-hot-toast';
import { authHeaders, apiFetch } from "./src/js/net/auth.js";

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:13101';

// F-024/SOMET-204: the entity-type and tile-type mutations used to throw a
// fixed generic string on a non-ok response and discard the backend's real
// {error: "..."} body, while the item-type mutations parsed it (so e.g. a
// 404 from a concurrent delete surfaced as "Entity type not found" for items
// but only the generic "Failed to update entity type" for entities). Shared
// here so all three catalogs use the same parse-and-throw path and can't
// drift again.
export async function throwApiError(res, fallback) {
  const error = await res.json().catch(() => ({}));
  throw new Error(error.error || fallback);
}

export function useMapTiles(){
  const { data: mapTiles, isLoading: isLoadingMapTiles } = useQuery({
    queryKey: ['mapTiles'],
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/map/tiles`);
      if (!res.ok) throw new Error('Failed to fetch map tiles');
      return res.json();
    }
  });
  return { mapTiles, isLoadingMapTiles };
}

export function useTileTypes() {
  const { data: tileTypes, isLoading: isLoadingTileTypes } = useQuery({
    queryKey: ['tileTypes'],
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/tile-types`);
      if (!res.ok) throw new Error('Failed to fetch tile types');
      return res.json();
    }
  });
  return { tileTypes, isLoadingTileTypes };
}

export function useCreateTileType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (newTileType) => {
      const res = await apiFetch(`${API_URL}/api/tile-types`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(newTileType)
      });
      if (!res.ok) await throwApiError(res, 'Failed to create tile type');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tileTypes'] });
      queryClient.invalidateQueries({ queryKey: ['mapTiles'] });
      toast.success('Tile type created!');
    },
    onError: (err) => toast.error(`Creation failed: ${err.message}`)
  });
}

export function useUpdateTileType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (updatedTileType) => {
      const { id, ...data } = updatedTileType;
      const res = await apiFetch(`${API_URL}/api/tile-types/${id}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(data)
      });
      if (!res.ok) await throwApiError(res, 'Failed to update tile type');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tileTypes'] });
      queryClient.invalidateQueries({ queryKey: ['mapTiles'] });
      toast.success('Tile type updated!');
    },
    onError: (err) => toast.error(`Update failed: ${err.message}`)
  });
}

export function useDeleteTileType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const res = await apiFetch(`${API_URL}/api/tile-types/${id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) await throwApiError(res, 'Failed to delete tile type');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tileTypes'] });
      queryClient.invalidateQueries({ queryKey: ['mapTiles'] });
      toast.success('Tile type deleted!');
    },
    onError: (err) => toast.error(`Deletion failed: ${err.message}`)
  });
}

export function useEntityTypes() {
  const { data: entityTypes, isLoading: isLoadingEntityTypes } = useQuery({
    queryKey: ['entityTypes'],
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/entity-types`);
      if (!res.ok) throw new Error('Failed to fetch entity types');
      return res.json();
    }
  });
  return { entityTypes, isLoadingEntityTypes };
}

export function useMapConfig() {
  const { data: mapConfig, isLoading: isLoadingMapConfig } = useQuery({
    queryKey: ['mapConfig'],
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/map/config`);
      if (!res.ok) throw new Error('Failed to fetch map configuration');
      return res.json();
    }
  });
  return { mapConfig, isLoadingMapConfig };
}

export function useCreateEntityType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (newEntityType) => {
      const res = await apiFetch(`${API_URL}/api/entity-types`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(newEntityType)
      });
      if (!res.ok) await throwApiError(res, 'Failed to create entity type');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entityTypes'] });
      queryClient.invalidateQueries({ queryKey: ['mapConfig'] });
      toast.success('Entity type created!');
    },
    onError: (err) => toast.error(`Creation failed: ${err.message}`)
  });
}

export function useUpdateEntityType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (updatedEntityType) => {
      const { id, ...data } = updatedEntityType;
      const res = await apiFetch(`${API_URL}/api/entity-types/${id}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(data)
      });
      if (!res.ok) await throwApiError(res, 'Failed to update entity type');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entityTypes'] });
      queryClient.invalidateQueries({ queryKey: ['mapConfig'] });
      toast.success('Entity type updated!');
    },
    onError: (err) => toast.error(`Update failed: ${err.message}`)
  });
}

export function useDeleteEntityType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const res = await apiFetch(`${API_URL}/api/entity-types/${id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) await throwApiError(res, 'Failed to delete entity type');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entityTypes'] });
      queryClient.invalidateQueries({ queryKey: ['mapConfig'] });
      toast.success('Entity type deleted!');
    },
    onError: (err) => toast.error(`Deletion failed: ${err.message}`)
  });
}

export function useItemTypes() {
  const { data: itemTypes, isLoading: isLoadingItemTypes } = useQuery({
    queryKey: ['itemTypes'],
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/item-types`);
      if (!res.ok) throw new Error('Failed to fetch item types');
      return res.json();
    }
  });
  return { itemTypes, isLoadingItemTypes };
}

export function useCreateItemType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (newItemType) => {
      const res = await apiFetch(`${API_URL}/api/item-types`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(newItemType)
      });
      if (!res.ok) await throwApiError(res, 'Failed to create item type');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['itemTypes'] });
      toast.success('Item type created!');
    },
    onError: (err) => toast.error(`Creation failed: ${err.message}`)
  });
}

export function useUpdateItemType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (updatedItemType) => {
      const { id, ...data } = updatedItemType;
      const res = await apiFetch(`${API_URL}/api/item-types/${id}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(data)
      });
      if (!res.ok) await throwApiError(res, 'Failed to update item type');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['itemTypes'] });
      toast.success('Item type updated!');
    },
    onError: (err) => toast.error(`Update failed: ${err.message}`)
  });
}

export function useDeleteItemType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const res = await apiFetch(`${API_URL}/api/item-types/${id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) await throwApiError(res, 'Failed to delete item type');
      return true;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['itemTypes'] });
      toast.success('Item type deleted!');
    },
    onError: (err) => toast.error(`Deletion failed: ${err.message}`)
  });
}

// The VFX effect library. Fetched once and cached: rows only change when an
// admin edits them (a later slice), and every attack frame looks up a name in it.
export function useVfxEffects() {
  const { data: vfxEffects } = useQuery({
    queryKey: ['vfxEffects'],
    staleTime: 60_000,
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/vfx-effects`);
      if (!res.ok) throw new Error('Failed to fetch vfx effects');
      return res.json();
    }
  });
  return { vfxEffects };
}