import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import toast from 'react-hot-toast';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:13001';

export function useMaps(){
  const { data: maps, isLoading: isLoadingMaps } = useQuery({
    queryKey: ['maps'],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/maps`);
      if (!res.ok) throw new Error('Failed to fetch maps');
      return res.json();
    }
  });
  return { maps, isLoadingMaps };
}

export function useMapTiles(){
  const { data: mapTiles, isLoading: isLoadingMapTiles } = useQuery({
    queryKey: ['mapTiles'],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/map/tiles`);
      if (!res.ok) throw new Error('Failed to fetch map tiles');
      return res.json();
    }
  });
  return { mapTiles, isLoadingMapTiles };
}

export function useGenerateMap(onSuccessCallback) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_URL}/api/maps/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `World ${new Date().toLocaleTimeString()}` })
      });
      if (!res.ok) throw new Error('Failed to generate map');
      return res.json();
    },
    onSuccess: (newMap) => {
      queryClient.invalidateQueries({ queryKey: ['maps'] });
      if (onSuccessCallback) {
        onSuccessCallback(newMap);
      }
      toast.success('New map generated!');
    },
    onError: (err) => toast.error(`Generation failed: ${err.message}`)
  });
}

export async function fetchMap(selectedMapId) {
  const res = await fetch(`${API_URL}/api/maps/${selectedMapId}`);
  if (!res.ok) throw new Error("Failed to load map data");
  return res.json();
}

export async function fetchMapEntities(selectedMapId) {
  const res = await fetch(`${API_URL}/api/maps/${selectedMapId}/entities`);
  if (!res.ok) throw new Error("Failed to load map entities");
  return res.json();
}

export function useSaveEntities(onSuccessCallback) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, entities }) => {
      const res = await fetch(`${API_URL}/api/maps/${id}/entities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entities })
      });
      if (!res.ok) throw new Error('Failed to save entities');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['maps'] });
      if (onSuccessCallback) onSuccessCallback();
    },
    onError: (err) => toast.error(`Save entities failed: ${err.message}`)
  });
}

export function useDeleteMap(onSuccessCallback) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const res = await fetch(`${API_URL}/api/maps/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete map');
      return res.json();
    },
    onSuccess: (data, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['maps'] });
      if (onSuccessCallback) {
        onSuccessCallback(deletedId);
      }
      toast.success('Map deleted!');
    },
    onError: (err) => toast.error(`Deletion failed: ${err.message}`)
  });
}

export function useTileTypes() {
  const { data: tileTypes, isLoading: isLoadingTileTypes } = useQuery({
    queryKey: ['tileTypes'],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/tile-types`);
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
      const res = await fetch(`${API_URL}/api/tile-types`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTileType)
      });
      if (!res.ok) throw new Error('Failed to create tile type');
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
      const res = await fetch(`${API_URL}/api/tile-types/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!res.ok) throw new Error('Failed to update tile type');
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
      const res = await fetch(`${API_URL}/api/tile-types/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete tile type');
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
      const res = await fetch(`${API_URL}/api/entity-types`);
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
      const res = await fetch(`${API_URL}/api/map/config`);
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
      const res = await fetch(`${API_URL}/api/entity-types`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newEntityType)
      });
      if (!res.ok) throw new Error('Failed to create entity type');
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
      const res = await fetch(`${API_URL}/api/entity-types/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!res.ok) throw new Error('Failed to update entity type');
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
      const res = await fetch(`${API_URL}/api/entity-types/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete entity type');
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