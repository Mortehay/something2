import { useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { HiOutlineTrash } from "react-icons/hi2";
import { Game } from "./src/js/main.js";
import { useMaps, useMapTiles, useGenerateMap, useDeleteMap, fetchMap } from "./useMaps.js";

const StyledGameContainer = styled.div`
  display: flex;
  height: 100%;
  width: 100%;
  position: relative;
  justify-content: center;
  align-items: center;
  background-color: #1a1a2e;
  overflow: hidden;

  #gameCanvas {
    border: 4px solid #2e2e3e;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    background-color: #1a1a2e;
  }

  /* UI Panels */
  .ui-panel {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background-color: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(10px);
    border: 3px solid #4a9eff;
    padding: 30px;
    border-radius: 20px;
    text-align: center;
    box-shadow: 0 0 30px rgba(74, 158, 255, 0.2);
    z-index: 1000;
    display: none;
    color: #eee;
    font-family: 'Courier New', Courier, monospace;
    max-width: 600px;
    width: 90%;
  }

  .ui-panel.active {
    display: block;
  }

  .ui-panel h1 {
    font-size: 3rem;
    margin-bottom: 2rem;
    color: #4a9eff;
    text-shadow: 0 0 10px rgba(74, 158, 255, 0.5);
  }

  .map-list {
    max-height: 200px;
    overflow-y: auto;
    margin: 20px 0;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 8px;
    padding: 10px;
  }

  .map-item {
    padding: 10px;
    margin: 5px 0;
    background: rgba(74, 158, 255, 0.1);
    border: 1px solid #4a9eff;
    cursor: pointer;
    border-radius: 4px;
    transition: all 0.2s;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .map-item:hover, .map-item.selected {
    background: rgba(74, 158, 255, 0.3);
    box-shadow: 0 0 10px rgba(74, 158, 255, 0.3);
  }

  .ui-panel button {
    background: #3a7ed8;
    color: #fff;
    border: 2px solid #4a9eff;
    padding: 1rem 2rem;
    margin: 0.5rem;
    font-size: 1.4rem;
    cursor: pointer;
    font-family: 'Courier New', Courier, monospace;
    border-radius: 8px;
    transition: all 0.3s ease;
  }

  .ui-panel button:hover {
    background: #4a9eff;
    box-shadow: 0 0 20px rgba(74, 157, 255, 0.5);
  }

  .ui-panel button:disabled {
    background: #555;
    border-color: #777;
    cursor: not-allowed;
  }
`;

function Something2() {
  const gameRef = useRef(null);
  const [selectedMapId, setSelectedMapId] = useState(null);
  const [gameState, setGameState] = useState('menu'); // 'menu', 'loading', 'playing', 'paused'

  // Queries
  const { maps, isLoadingMaps } = useMaps();
  const { mapTiles, isLoadingMapTiles } = useMapTiles();

  // Mutations
  const generateMutation = useGenerateMap((newMap) => {
    setSelectedMapId(newMap.id);
  });

  const deleteMutation = useDeleteMap((deletedId) => {
    if (selectedMapId === deletedId) {
      setSelectedMapId(null);
    }
  });

  // Effect to generate first map if none exist
  useEffect(() => {
    if (!isLoadingMaps && maps && maps.length === 0 && !generateMutation.isPending) {
      console.log("No maps found, triggering initial generation...");
      generateMutation.mutate();
    }
  }, [maps, isLoadingMaps, generateMutation.isPending]);



  // Effect to pre-select first map
  useEffect(() => {
    if (maps && maps.length > 0 && !selectedMapId) {
      setSelectedMapId(maps[0].id);
    }
  }, [maps]);

  useEffect(() => {
    gameRef.current = new Game();
    gameRef.current.setOnStateChange((newState) => {
      setGameState(newState);
    });
    
    return () => {
      if (gameRef.current) {
        gameRef.current.destroy();
      }
    };
  }, []);

  const handlePlay = async () => {
    if (!selectedMapId) {
      toast.error("Please select a map first");
      return;
    }

    try {
      setGameState('loading');
      const mapData = await fetchMap(selectedMapId);
      
      const tiles = typeof mapData.data === 'string' ? JSON.parse(mapData.data) : mapData.data;
      
      if (!gameRef.current.canvas) {
        await gameRef.current.init(tiles, mapTiles);
      } else {
        gameRef.current.setMap(tiles, mapTiles);
      }
      
      gameRef.current.startGame();
    } catch (err) {
      console.error(err);
      toast.error("Failed to start game: " + err.message);
      setGameState('menu');
    }
  };

  return (
    <StyledGameContainer id="gameContainer">
      <canvas id="gameCanvas" width="720" height="480"></canvas>
      
      {/*main menu*/}
      <div id="mainMenu" className={`ui-panel ${gameState === 'menu' ? 'active' : ''}`}>
        <h1>Game World Manager</h1>
        
        {isLoadingMaps ? (
          <div>Scanning horizons...</div>
        ) : (
          <>
            <h2>Available Worlds</h2>
            <div className="map-list">
              {maps?.map(map => (
                <div 
                  key={map.id} 
                  className={`map-item ${selectedMapId === map.id ? 'selected' : ''}`}
                  onClick={() => setSelectedMapId(map.id)}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                    <span>{map.name}</span>
                    <small style={{ fontSize: '0.8rem', opacity: 0.7 }}>
                      {new Date(map.created_at).toLocaleDateString()}
                    </small>
                  </div>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      toast((t) => (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                          <span style={{ color: '#e9e7e7' }}>Are you sure you want to delete this map?</span>
                          <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                            <button 
                              onClick={() => {
                                deleteMutation.mutate(map.id);
                                toast.dismiss(t.id);
                              }}
                              style={{ padding: '6px 12px', background: '#e47d7d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '14px' }}
                            >
                              Yes, Delete
                            </button>
                            <button 
                              onClick={() => toast.dismiss(t.id)}
                              style={{ padding: '6px 12px', background: '#555', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '14px' }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ), { 
                        duration: Infinity,
                        position: 'top-center',
                        style: {
                          marginTop: '40vh',
                          background: '#1a1a2e',
                          border: '2px solid #4a9eff',
                          padding: '20px',
                          boxShadow: '0 0 20px rgba(74, 158, 255, 0.4)'
                        }
                      });
                    }}
                    disabled={deleteMutation.isPending}
                    style={{
                      padding: '5px 10px',
                      fontSize: '1rem',
                      border: 'none',
                      color: 'white',
                      margin: 0
                    }}
                    title="Delete Map"
                  >
                    <HiOutlineTrash/>
                  </button>
                </div>
              ))}
            </div>
            
            <button 
              onClick={() => generateMutation.mutate()} 
              disabled={generateMutation.isPending}
            >
              {generateMutation.isPending ? 'Generating...' : 'Regenerate World'}
            </button>
            <button 
              onClick={handlePlay}
              disabled={!selectedMapId || gameState === 'loading'}
            >
              Play Selected World
            </button>
          </>
        )}
        
        <div style={{ marginTop: "20px", fontSize: "12px", color: "#aaa" }}>
          WASD - Move | G - Toggle Grid | ESC - Pause
        </div>
      </div>

      {/*pause menu*/}
      <div id="pauseMenu" className={`ui-panel ${gameState === 'paused' ? 'active' : ''}`}>
        <h2>Paused</h2>
        <button onClick={() => gameRef.current?.resume()}>Resume</button>
        <button onClick={() => gameRef.current?.returnToMenu()}>Quit to Menu</button>
      </div>

      {/*loading screen*/}
      <div id="loadingScreen" className={`ui-panel ${gameState === 'loading' ? 'active' : ''}`}>
        <h2>Loading World...</h2>
        <p id="loadingText">Retrieving terrain data from HQ...</p>
      </div>
    </StyledGameContainer>
  )
}

export default Something2;