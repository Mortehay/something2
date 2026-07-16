import { useEffect, useRef, useState, useMemo } from 'react';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { HiOutlineTrash, HiOutlineSparkles, HiOutlinePuzzlePiece, HiOutlineWrenchScrewdriver, HiOutlineBeaker } from "react-icons/hi2";
import { Game } from "./src/js/main.js";
import { EngineClient, fetchDevToken } from "./src/js/net/EngineClient.js";
import { useMaps, useMapTiles, useGenerateMap, useDeleteMap, fetchMap, fetchMapEntities, useSaveEntities, useEntityTypes, useGenerateEntities } from "./useMaps.js";
import { useWorlds, useCreateWorld } from "./useWorlds";
import { MAP_TILE_SIZE } from "./src/js/core/constants.js";

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:13101';
const ENGINE_WS_URL = import.meta.env.VITE_ENGINE_WS_URL || 'ws://localhost:18080/ws';
import TileTypesAdmin from "./TileTypesAdmin";
import EntityTypesAdmin from "./EntityTypesAdmin";
import MapPreview from "./MapPreview.jsx";

const StyledGameContainer = styled.div`
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100%;
  background-color: #0f0f1a;
  overflow: hidden;
`;

const TabBar = styled.div`
  display: flex;
  background: #1a1a2e;
  border-bottom: 2px solid #2e2e3e;
  padding: 0 20px;
  z-index: 100;
`;

const TabButton = styled.button`
  background: ${props => props.$active ? 'rgba(74, 158, 255, 0.1)' : 'transparent'};
  color: ${props => props.$active ? (props.$adminType === 'entity' ? '#facc15' : '#4a9eff') : '#aaa'};
  border: none;
  border-bottom: 3px solid ${props => props.$active ? (props.$adminType === 'entity' ? '#facc15' : '#4a9eff') : 'transparent'};
  padding: 1.5rem 2rem;
  font-size: 1.3rem;
  font-weight: bold;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.8rem;
  transition: all 0.2s;
  
  &:hover {
    color: ${props => props.$active ? (props.$adminType === 'entity' ? '#facc15' : '#4a9eff') : '#eee'};
    background: rgba(255, 255, 255, 0.05);
  }
  
  svg {
    font-size: 1.6rem;
  }
`;

const ContentArea = styled.div`
  flex: 1;
  position: relative;
  overflow: hidden;
`;

const UIOverlay = styled.div`
  position: absolute;
  top: 20px;
  right: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  pointer-events: none;
  z-index: 10;
`;

const Panel = styled.div`
  background: rgba(26, 26, 46, 0.9);
  backdrop-filter: blur(8px);
  border: 1px solid #2e2e3e;
  border-radius: 12px;
  padding: 20px;
  width: 320px;
  pointer-events: auto;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
`;

const MapList = styled.div`
  max-height: 400px;
  overflow-y: auto;
  margin-top: 15px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  
  &::-webkit-scrollbar {
    width: 6px;
  }
  &::-webkit-scrollbar-thumb {
    background: #3a3a4e;
    border-radius: 3px;
  }
`;

const MapItem = styled.div`
  background: ${props => props.selected ? 'rgba(74, 158, 255, 0.15)' : '#161625'};
  border: 1px solid ${props => props.selected ? '#4a9eff' : '#2e2e3e'};
  padding: 12px 15px;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
  transition: all 0.2s;
  
  &:hover {
    background: ${props => props.selected ? 'rgba(74, 158, 255, 0.2)' : '#1f1f35'};
  }
`;

const Button = styled.button`
  background: ${props => props.danger ? '#ef4444' : '#3b82f6'};
  color: white;
  border: none;
  padding: 10px 18px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
  transition: filter 0.2s;
  
  &:hover {
    filter: brightness(1.1);
  }
  
  &:disabled {
    background: #4b5563;
    cursor: not-allowed;
  }
`;

const PauseOverlay = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(4px);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  z-index: 100;
`;

const PausePanel = styled(Panel)`
  min-width: 300px;
  text-align: center;
  animation: slideUp 0.3s ease-out;

  @keyframes slideUp {
    from { transform: translateY(20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }
`;

const Input = styled.input`
  background: #161625;
  border: 1px solid #2e2e3e;
  border-radius: 6px;
  color: white;
  padding: 8px 10px;
  font-size: 14px;
  width: 100%;
  box-sizing: border-box;

  &:focus {
    outline: none;
    border-color: #4a9eff;
  }

  &::placeholder {
    color: #666;
  }
`;

export default function Something2() {
  const canvasRef = useRef(null);
  const gameRef = useRef(null);
  const engineRef = useRef(null);
  const [activeTab, setActiveTab] = useState('game');
  const [selectedMapId, setSelectedMapId] = useState(null);
  const [selectedWorldId, setSelectedWorldId] = useState(null);
  const [newWorldName, setNewWorldName] = useState('');
  const [newWorldSeed, setNewWorldSeed] = useState('');
  const [newWorldChunkSize, setNewWorldChunkSize] = useState('64');
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  const { maps, isLoadingMaps } = useMaps();
  const { mapTiles, isLoadingMapTiles } = useMapTiles();
  const { entityTypes, isLoadingEntityTypes } = useEntityTypes();
  const { worlds, isLoadingWorlds, worldsError } = useWorlds();
  const createWorldMutation = useCreateWorld();

  useEffect(() => {
    if (worldsError) toast.error(`Failed to load worlds: ${worldsError.message}`);
  }, [worldsError]);

  // name -> color for the minimap preview (mapTiles is keyed by tile name).
  const tileColors = useMemo(() => {
    const m = {};
    if (mapTiles && typeof mapTiles === 'object') {
      for (const [name, def] of Object.entries(mapTiles)) {
        m[name] = (def && typeof def === 'object') ? def.color : def;
      }
    }
    return m;
  }, [mapTiles]);

  const generateMapMutation = useGenerateMap((newMap) => {
    setSelectedMapId(newMap.id);
  });
  const deleteMapMutation = useDeleteMap((deletedId) => {
    if (selectedMapId === deletedId) {
      setSelectedMapId(null);
      setIsPlaying(false);
    }
  });
  const saveEntitiesMutation = useSaveEntities(() => {
    toast.success('Entities saved successfully!');
  });

  const handleResume = () => {
    if (gameRef.current) gameRef.current.resume();
  };

  const handleExit = () => {
    setIsPlaying(false);
    setIsPaused(false);
    if (gameRef.current) {
      gameRef.current.setState('menu');
      gameRef.current.setEngineClient?.(null, null);
    }
    if (engineRef.current) {
      engineRef.current.disconnect();
      engineRef.current = null;
    }
  };

  useEffect(() => {
    if (activeTab === 'game' && canvasRef.current) {
      if (!gameRef.current) {
        gameRef.current = new Game(canvasRef.current);
      } else {
        gameRef.current.canvas = canvasRef.current;
        if (gameRef.current.init) {
          gameRef.current.ctx = canvasRef.current.getContext('2d');
        }
      }
      
      gameRef.current.setOnStateChange((newState) => {
        setIsPaused(newState === 'paused');
        if (newState === 'menu') {
          setIsPlaying(false);
          setIsPaused(false);
        }
      });
    }
    return () => {
      if (engineRef.current) {
        engineRef.current.disconnect();
        engineRef.current = null;
      }
    };
  }, [activeTab]);

  const handleEnterWorld = async (shouldGenerate = false) => {
    console.log("handleEnterWorld called", { selectedMapId, gameRef: !!gameRef.current });
    if (!selectedMapId || !gameRef.current) return;

    try {
      const mapData = await fetchMap(selectedMapId);
      const entities = await fetchMapEntities(selectedMapId);
      console.log("Map data loaded:", { tilesFound: !!mapData?.data, entitiesCount: entities?.length });

      const tiles = typeof mapData.data === 'string' ? JSON.parse(mapData.data) : mapData.data;

      // Convert entityTypes array to map for the engine
      const entityTypesMap = {};
      if (entityTypes) {
        entityTypes.forEach(t => {
          entityTypesMap[t.name] = {
            color: t.color,
            walkable: t.walkable,
            spawnTiles: t.spawn_tiles,
            chance: t.chance,
            render_mode: t.render_mode,
            image: t.image,
            sprite: t.sprite
          };
        });
      }

      gameRef.current.init(tiles, mapTiles, entities, entityTypesMap);
      setIsPlaying(true);

      // Connect to the Go engine. Dev path: pull a JWT from /api/dev-token,
      // open WS, send `join`. Game pushes moves and reconciles incoming ticks.
      try {
        if (engineRef.current) {
          engineRef.current.disconnect();
          engineRef.current = null;
        }
        const { token, user_id } = await fetchDevToken(API_URL);
        const client = new EngineClient({
          url: ENGINE_WS_URL,
          token,
          onJoined: (m) => console.log("engine joined:", m),
          onError: (err) => toast.error(`Engine: ${err.message}`),
          onClose: () => console.log("engine ws closed"),
        });
        gameRef.current.setEngineClient(client, user_id);
        client.connect(selectedMapId);
        engineRef.current = client;
      } catch (err) {
        toast.error(`Engine connect failed: ${err.message}`);
      }

      if (shouldGenerate) {
        if (Object.keys(entityTypesMap).length === 0) {
          toast.error("No entity types defined! Create some in Entity Admin first.");
          return;
        }
        gameRef.current.map.generateEntities(entityTypesMap);
        toast.success('Entities generated!');
      }
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handlePlay = () => handleEnterWorld(false);

  const handleEnterChunkedWorld = async () => {
    if (!selectedWorldId || !gameRef.current) return;

    try {
      const world = worlds?.find(w => w.id === selectedWorldId);
      const chunkSize = world?.chunk_size || 64;
      const spawn = (chunkSize * MAP_TILE_SIZE) / 2;

      await gameRef.current.initChunked({
        worldId: selectedWorldId,
        chunkSize,
        tileTypes: mapTiles,
        spawnX: spawn,
        spawnY: spawn,
      });
      setIsPlaying(true);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleCreateWorld = () => {
    if (!newWorldName.trim()) return;
    const cs = Number(newWorldChunkSize);
    const chunk_size = Number.isInteger(cs) && cs >= 1 && cs <= 256 ? cs : 64;
    createWorldMutation.mutate({
      name: newWorldName.trim(),
      seed: newWorldSeed ? Number(newWorldSeed) : undefined,
      chunk_size,
    }, {
      onSuccess: (world) => {
        setNewWorldName('');
        setNewWorldSeed('');
        if (world?.id) setSelectedWorldId(world.id);
      }
    });
  };

  const handleSaveEntities = () => {
    if (!selectedMapId || !gameRef.current) return;
    const entities = gameRef.current.map.entities.map(e => ({
      type: e.constructor.name,
      row: e.row,
      col: e.col,
      name: e.name || e.constructor.name
    }));
    saveEntitiesMutation.mutate({ id: selectedMapId, entities });
  };

  const generateEntitiesMutation = useGenerateEntities();

  const handleGenerateEntities = () => {
    if (!selectedMapId) return;

    if (isPlaying) {
      // Already in world, regenerate via backend
      generateEntitiesMutation.mutate(selectedMapId, {
        onSuccess: (data) => {
          // Re-load entities from DB to show in game
          fetchMapEntities(selectedMapId).then(loadedEntities => {
            // Re-initialize map with new entities but keep current tiles
            if (gameRef.current && gameRef.current.map) {
              // gameRef.current.map.init already exists but we just want to replace entities
              // We'll call init again with same tiles but new entities
              const tiles = gameRef.current.map.tiles;
              const mapTiles = gameRef.current.map.mapTiles;
              const entityTypesMap = gameRef.current.map.entityTypes;
              gameRef.current.init(tiles, mapTiles, loadedEntities, entityTypesMap);
            }
          });
        }
      });
    } else {
      // Not in world, generate and then enter
      generateEntitiesMutation.mutate(selectedMapId, {
        onSuccess: () => handleEnterWorld(false) // Don't shouldGenerate again
      });
    }
  };

  return (
    <StyledGameContainer>
      <TabBar>
        <TabButton $active={activeTab === 'game'} onClick={() => setActiveTab('game')}>
          <HiOutlinePuzzlePiece /> Game View
        </TabButton>
        <TabButton $active={activeTab === 'tiles'} onClick={() => setActiveTab('tiles')}>
          <HiOutlineWrenchScrewdriver /> TILE_TYPES Admin
        </TabButton>
        <TabButton $active={activeTab === 'entity'} $adminType="entity" onClick={() => setActiveTab('entity')}>
          <HiOutlineBeaker /> Entity Admin
        </TabButton>
      </TabBar>

      <ContentArea>
        {activeTab === 'game' && (
          <>
         
          {!isPlaying && (
            <UIOverlay>
                <Panel>
                  <h2 style={{ color: 'white', margin: '0 0 15px 0', fontSize: '20px' }}>Worlds</h2>

                  {isLoadingWorlds ? (
                    <p style={{ color: '#aaa' }}>Loading worlds...</p>
                  ) : (
                    <MapList style={{ marginTop: 0 }}>
                      {worlds?.map(world => (
                        <MapItem
                          key={world.id}
                          selected={selectedWorldId === world.id}
                          onClick={() => setSelectedWorldId(world.id)}
                        >
                          <div>
                            <div style={{ color: 'white', fontWeight: 'bold' }}>{world.name}</div>
                            <div style={{ color: '#888', fontSize: '12px' }}>
                              chunk_size {world.chunk_size || 64}{world.seed != null ? ` · seed ${world.seed}` : ''}
                            </div>
                          </div>
                        </MapItem>
                      ))}
                      {worlds?.length === 0 && (
                        <p style={{ color: '#666', fontSize: '13px', margin: 0 }}>No worlds yet.</p>
                      )}
                    </MapList>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '15px' }}>
                    <Input
                      placeholder="New world name"
                      value={newWorldName}
                      onChange={(e) => setNewWorldName(e.target.value)}
                    />
                    <Input
                      placeholder="Seed (optional)"
                      value={newWorldSeed}
                      onChange={(e) => setNewWorldSeed(e.target.value)}
                    />
                    <Input
                      type="number"
                      placeholder="Chunk size (1-256)"
                      value={newWorldChunkSize}
                      onChange={(e) => setNewWorldChunkSize(e.target.value)}
                    />
                    <Button
                      onClick={handleCreateWorld}
                      disabled={createWorldMutation.isPending || !newWorldName.trim()}
                      style={{ width: '100%' }}
                    >
                      Create World
                    </Button>
                  </div>

                  <Button
                    onClick={handleEnterChunkedWorld}
                    disabled={!selectedWorldId}
                    style={{ width: '100%', marginTop: '10px', background: '#10b981' }}
                  >
                    Enter World (chunked)
                  </Button>
                </Panel>

                <Panel>
                  <h2 style={{ color: 'white', margin: '0 0 15px 0', fontSize: '20px' }}>World Browser</h2>
                  <Button onClick={() => generateMapMutation.mutate()} disabled={generateMapMutation.isPending} style={{ width: '100%' }}>
                    Generate New World
                  </Button>

                  {isLoadingMaps ? (
                    <p style={{ color: '#aaa', marginTop: '15px' }}>Loading worlds...</p>
                  ) : (
                    <MapList>
                      {maps?.map(map => (
                        <MapItem
                          key={map.id}
                          selected={selectedMapId === map.id}
                          onClick={() => setSelectedMapId(map.id)}
                        >
                          <div>
                            <div style={{ color: 'white', fontWeight: 'bold' }}>{map.name}</div>
                            <div style={{ color: '#888', fontSize: '12px' }}>{new Date(map.created_at).toLocaleDateString()}</div>
                          </div>
                          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                            {map.has_entities && <HiOutlineSparkles style={{ color: '#facc15' }} title="Has entities" />}
                            <HiOutlineTrash
                              style={{ color: '#ef4444', cursor: 'pointer' }}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (window.confirm('Delete this world?')) deleteMapMutation.mutate(map.id);
                              }}
                            />
                          </div>
                        </MapItem>
                      ))}
                    </MapList>
                  )}
                </Panel>

              {selectedMapId && (
                <Panel>
                  <h3 style={{ color: 'white', margin: '0 0 15px 0', fontSize: '18px' }}>World Controls</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {!isPlaying ? (
                      <Button onClick={handlePlay} style={{ background: '#10b981' }}>Enter World</Button>
                    ) : (
                      <Button onClick={handlePlay} style={{ background: '#10b981' }}>Reset/Respawn</Button>
                    )}

                    <Button onClick={handleGenerateEntities} style={{ background: '#8b5cf6' }}>
                      {maps?.find(m => m.id === selectedMapId)?.has_entities ? 'Regenerate Entities' : 'Generate Entities'}
                    </Button>

                    {isPlaying && (
                      <Button onClick={handleSaveEntities} disabled={saveEntitiesMutation.isPending}>Save Entities</Button>
                    )}
                  </div>
                </Panel>
              )}
            </UIOverlay>
          )}

          {isPaused && (
            <PauseOverlay>
              <PausePanel>
                <h2 style={{ color: 'white', marginBottom: '20px' }}>Game Paused</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                  <Button onClick={handleResume} style={{ background: '#10b981', fontSize: '16px', padding: '12px' }}>
                    Resume Game
                  </Button>
                  <Button onClick={handleExit} style={{ background: '#ef4444', fontSize: '16px', padding: '12px' }}>
                    Exit to Main Menu
                  </Button>
                </div>
              </PausePanel>
            </PauseOverlay>
          )}

          {!isPlaying && selectedMapId && (
            <MapPreview mapId={selectedMapId} tileColors={tileColors} />
          )}
          {!isPlaying && !selectedMapId && (
            <div style={{
              width: '100%', height: '100%', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: 'rgba(255,255,255,0.35)', fontSize: '15px'
            }}>
              Select a world to preview it, then Enter World.
            </div>
          )}
          <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: isPlaying ? 'block' : 'none' }} />
          </>
        )}
        {activeTab === 'tiles' && <TileTypesAdmin />}
        {activeTab === 'entity' && <EntityTypesAdmin />}
      </ContentArea>
    </StyledGameContainer>
  );
}