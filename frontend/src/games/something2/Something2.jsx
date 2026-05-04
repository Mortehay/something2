import { useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { HiOutlineTrash, HiOutlineSparkles, HiOutlinePuzzlePiece, HiOutlineWrenchScrewdriver, HiOutlineBeaker } from "react-icons/hi2";
import { Game } from "./src/js/main.js";
import { useMaps, useMapTiles, useGenerateMap, useDeleteMap, fetchMap, fetchMapEntities, useSaveEntities, useEntityTypes, useGenerateEntities } from "./useMaps.js";
import TileTypesAdmin from "./TileTypesAdmin";
import EntityTypesAdmin from "./EntityTypesAdmin";

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

export default function Something2() {
  const canvasRef = useRef(null);
  const gameRef = useRef(null);
  const [activeTab, setActiveTab] = useState('game');
  const [selectedMapId, setSelectedMapId] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  const { maps, isLoadingMaps } = useMaps();
  const { mapTiles, isLoadingMapTiles } = useMapTiles();
  const { entityTypes, isLoadingEntityTypes } = useEntityTypes();

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
    if (gameRef.current) gameRef.current.setState('menu');
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
            chance: t.chance
          };
        });
      }

      gameRef.current.init(tiles, mapTiles, entities, entityTypesMap);
      setIsPlaying(true);

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

          <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: isPlaying ? 'block' : 'none' }} />
          </>
        )}
        {activeTab === 'tiles' && <TileTypesAdmin />}
        {activeTab === 'entity' && <EntityTypesAdmin />}
      </ContentArea>
    </StyledGameContainer>
  );
}