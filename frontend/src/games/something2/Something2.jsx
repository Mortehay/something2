import { useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { HiOutlineTrash, HiOutlineSparkles, HiOutlinePuzzlePiece, HiOutlineWrenchScrewdriver, HiOutlineBeaker } from "react-icons/hi2";
import { Game } from "./src/js/main.js";
import { useMaps, useMapTiles, useGenerateMap, useDeleteMap, fetchMap, fetchMapEntities, useSaveEntities, useEntityTypes } from "./useMaps.js";
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
  background: ${props => props.active ? 'rgba(74, 158, 255, 0.1)' : 'transparent'};
  color: ${props => props.active ? (props.adminType === 'entity' ? '#facc15' : '#4a9eff') : '#aaa'};
  border: none;
  border-bottom: 3px solid ${props => props.active ? (props.adminType === 'entity' ? '#facc15' : '#4a9eff') : 'transparent'};
  padding: 1.5rem 2rem;
  font-size: 1.3rem;
  font-weight: bold;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.8rem;
  transition: all 0.2s;
  
  &:hover {
    color: ${props => props.active ? (props.adminType === 'entity' ? '#facc15' : '#4a9eff') : '#eee'};
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

export default function Something2() {
  const canvasRef = useRef(null);
  const gameRef = useRef(null);
  const [activeTab, setActiveTab] = useState('game');
  const [selectedMapId, setSelectedMapId] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);

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

  useEffect(() => {
    if (activeTab === 'game' && canvasRef.current && !gameRef.current) {
      gameRef.current = new Game(canvasRef.current);
    }
  }, [activeTab]);

  const handlePlay = async () => {
    if (!selectedMapId) return;
    try {
      const mapData = await fetchMap(selectedMapId);
      const entities = await fetchMapEntities(selectedMapId);
      
      const tiles = JSON.parse(mapData.data);
      
      // Convert entityTypes array to map for the engine if needed
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
    } catch (err) {
      toast.error(err.message);
    }
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

  const handleGenerateEntities = () => {
    if (!gameRef.current || !gameRef.current.map) return;
    gameRef.current.map.generateEntities();
    toast.success('Entities generated!');
  };

  return (
    <StyledGameContainer>
      <TabBar>
        <TabButton active={activeTab === 'game'} onClick={() => setActiveTab('game')}>
          <HiOutlinePuzzlePiece /> Game View
        </TabButton>
        <TabButton active={activeTab === 'tiles'} onClick={() => setActiveTab('tiles')}>
          <HiOutlineWrenchScrewdriver /> TILE_TYPES Admin
        </TabButton>
        <TabButton active={activeTab === 'entity'} adminType="entity" onClick={() => setActiveTab('entity')}>
          <HiOutlineBeaker /> Entity Admin
        </TabButton>
      </TabBar>

      <ContentArea>
        {activeTab === 'game' && (
          <>
            <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
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
                              if(window.confirm('Delete this world?')) deleteMapMutation.mutate(map.id);
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
                      <>
                        <Button onClick={handleGenerateEntities} style={{ background: '#8b5cf6' }}>Re-generate Entities</Button>
                        <Button onClick={handleSaveEntities} disabled={saveEntitiesMutation.isPending}>Save Entities</Button>
                      </>
                    )}
                  </div>
                </Panel>
              )}
            </UIOverlay>
          </>
        )}
        {activeTab === 'tiles' && <TileTypesAdmin />}
        {activeTab === 'entity' && <EntityTypesAdmin />}
      </ContentArea>
    </StyledGameContainer>
  );
}