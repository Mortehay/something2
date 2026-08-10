import { useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import styled from 'styled-components';
import {
  HiOutlineTrash, HiArrowsPointingOut, HiArrowsPointingIn, HiOutlineQuestionMarkCircle,
} from "react-icons/hi2";
import { useMapTiles } from "./useMaps.js";
import { useWorlds, useCreateWorld, useDeleteWorld } from "./useWorlds";
import { useAuth } from "../../context/AuthContext";
import WorldPreview from "./WorldPreview.jsx";
import Minimap from "./Minimap.jsx";
import CharacterSheet from "./CharacterSheet.jsx";

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

const FullscreenToggle = styled.button`
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  border: 1px solid var(--s2-border);
  background: var(--s2-panel-veil);
  backdrop-filter: blur(8px);
  color: var(--s2-text);
  cursor: pointer;
  font-size: 20px;
  transition: background 0.15s, color 0.15s;

  &:hover { background: var(--s2-panel-veil-solid); color: var(--s2-accent); }
`;

// "How to play" affordance pinned directly under the minimap (minimap is
// top:64 + 180px tall). Opens the same Help panel as the top-right "?" — added
// because the controls (trading with a merchant especially) weren't discoverable.
const HowToButton = styled.button`
  position: absolute;
  top: 252px;
  right: 16px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid var(--s2-border);
  background: var(--s2-panel-veil);
  backdrop-filter: blur(8px);
  color: var(--s2-text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  pointer-events: auto;
  transition: background 0.15s, color 0.15s;

  svg { font-size: 16px; }
  &:hover { background: var(--s2-panel-veil-solid); color: var(--s2-accent); }
`;

// Sits directly under "How to play", in the same always-visible in-game
// control stack. NOT in the pause overlay: nothing in this app ever sets
// isPaused to true, so that overlay is unreachable and a control placed there
// would be as inert as the handler was before it had a caller at all.
const ChangeCharacterButton = styled(HowToButton)`
  top: 296px;
`;

const Panel = styled.div`
  background: var(--s2-panel-veil);
  backdrop-filter: blur(8px);
  border: 1px solid var(--s2-border);
  border-radius: 12px;
  padding: 20px;
  width: 320px;
  pointer-events: auto;
  box-shadow: 0 8px 32px var(--s2-shadow);
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
    background: var(--s2-border-strong);
    border-radius: 3px;
  }
`;

const MapItem = styled.div`
  background: ${props => props.selected ? 'var(--s2-accent-tint)' : 'var(--s2-surface-subtle)'};
  border: 1px solid ${props => props.selected ? 'var(--s2-accent)' : 'var(--s2-border)'};
  padding: 12px 15px;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
  transition: all 0.2s;

  &:hover {
    background: ${props => props.selected ? 'var(--s2-accent-tint-strong)' : 'var(--s2-row)'};
  }
`;

const Button = styled.button`
  background: ${props => props.danger ? 'var(--s2-danger)' : 'var(--s2-btn-info)'};
  color: var(--s2-on-accent);
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
    background: var(--s2-btn-grey);
    cursor: not-allowed;
  }
`;

const PauseOverlay = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: var(--s2-scrim);
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
  background: var(--s2-surface-subtle);
  border: 1px solid var(--s2-border-strong);
  border-radius: 6px;
  color: var(--s2-text-strong);
  padding: 8px 10px;
  font-size: 14px;
  width: 100%;
  box-sizing: border-box;

  &:focus {
    outline: none;
    border-color: var(--s2-accent);
  }

  &::placeholder {
    color: var(--s2-text-dim);
  }
`;

export default function GameView() {
  const {
    gameRef, isPlaying, isPaused, isFullscreen,
    selectedWorldId, setSelectedWorldId,
    enterWorld, resume, exitToMenu, changeCharacter, toggleFullscreen, openHelp,
  } = useOutletContext();

  const { isAdmin } = useAuth();
  const [newWorldName, setNewWorldName] = useState('');
  const [newWorldSeed, setNewWorldSeed] = useState('');
  const [newWorldChunkSize, setNewWorldChunkSize] = useState('64');

  // Same query keys GameShell uses; TanStack serves both from one cache entry.
  const { mapTiles } = useMapTiles();
  const { worlds, isLoadingWorlds } = useWorlds();
  const createWorldMutation = useCreateWorld();
  const deleteWorldMutation = useDeleteWorld();

  // name -> color for the minimap and world preview (mapTiles is keyed by tile name).
  const tileColors = useMemo(() => {
    const m = {};
    if (mapTiles && typeof mapTiles === 'object') {
      for (const [name, def] of Object.entries(mapTiles)) {
        m[name] = (def && typeof def === 'object') ? def.color : def;
      }
    }
    return m;
  }, [mapTiles]);

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

  return (
    <>
      {isPlaying && (
        <FullscreenToggle
          type="button"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Enter fullscreen'}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
          {isFullscreen ? <HiArrowsPointingIn /> : <HiArrowsPointingOut />}
        </FullscreenToggle>
      )}
      {isPlaying && <Minimap gameRef={gameRef} tileColors={tileColors} />}
      {isPlaying && <CharacterSheet gameRef={gameRef} />}
      {isPlaying && (
        <HowToButton
          type="button"
          title="How to play — controls, trading & the minimap"
          aria-label="How to play"
          onClick={() => openHelp()}
        >
          <HiOutlineQuestionMarkCircle /> How to play
        </HowToButton>
      )}
      {/* SOMET-262: GameShell defined changeCharacter and referenced it
          nowhere, so switching characters was impossible without hand-clearing
          localStorage -- an acceptance criterion that shipped unreachable. */}
      {isPlaying && (
        <ChangeCharacterButton
          type="button"
          title="Leave this world and pick a different character"
          onClick={changeCharacter}
        >
          Change Character
        </ChangeCharacterButton>
      )}
      {!isPlaying && (
        <UIOverlay>
            <Panel>
              <h2 style={{ color: 'var(--s2-text-strong)', margin: '0 0 15px 0', fontSize: '20px' }}>Worlds</h2>

              {isLoadingWorlds ? (
                <p style={{ color: 'var(--s2-text-muted)' }}>Loading worlds...</p>
              ) : (
                <MapList style={{ marginTop: 0 }}>
                  {worlds?.map(world => (
                    <MapItem
                      key={world.id}
                      selected={selectedWorldId === world.id}
                      onClick={() => setSelectedWorldId(world.id)}
                    >
                      <div>
                        <div style={{ color: 'var(--s2-text-strong)', fontWeight: 'bold' }}>{world.name}</div>
                        <div style={{ color: 'var(--s2-text-dim)', fontSize: '12px' }}>
                          chunk_size {world.chunk_size || 64}{world.seed != null ? ` · seed ${world.seed}` : ''}
                        </div>
                      </div>
                      {isAdmin && (
                        <HiOutlineTrash
                          style={{ color: 'var(--s2-danger)', cursor: 'pointer', flexShrink: 0 }}
                          title="Delete world"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (window.confirm(`Delete world "${world.name}"? This removes its chunks, creatures, and loot.`)) {
                              if (selectedWorldId === world.id) setSelectedWorldId(null);
                              deleteWorldMutation.mutate(world.id);
                            }
                          }}
                        />
                      )}
                    </MapItem>
                  ))}
                  {worlds?.length === 0 && (
                    <p style={{ color: 'var(--s2-text-dim)', fontSize: '13px', margin: 0 }}>No worlds yet.</p>
                  )}
                </MapList>
              )}

              {isAdmin && (
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
              )}

              <Button
                onClick={() => enterWorld()}
                disabled={!selectedWorldId}
                style={{ width: '100%', marginTop: '10px', background: 'var(--s2-success-alt)' }}
              >
                Enter World (chunked)
              </Button>
            </Panel>
        </UIOverlay>
      )}

      {isPaused && (
        <PauseOverlay>
          <PausePanel>
            <h2 style={{ color: 'var(--s2-text-strong)', marginBottom: '20px' }}>Game Paused</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <Button onClick={resume} style={{ background: 'var(--s2-success-alt)', fontSize: '16px', padding: '12px' }}>
                Resume Game
              </Button>
              <Button onClick={exitToMenu} style={{ background: 'var(--s2-danger)', fontSize: '16px', padding: '12px' }}>
                Exit to Main Menu
              </Button>
            </div>
          </PausePanel>
        </PauseOverlay>
      )}

      {!isPlaying && selectedWorldId && (
        <WorldPreview worldId={selectedWorldId} tileColors={tileColors} />
      )}
      {!isPlaying && !selectedWorldId && (
        <div style={{
          width: '100%', height: '100%', display: 'flex', alignItems: 'center',
          justifyContent: 'center',
          // This div fills the game route's content area when nothing is being
          // rendered by the (unconditionally-mounted, but display:none here)
          // <canvas> in GameShell -- it IS the canvas surface in this state, not
          // page chrome, so it stays dark in both modes like the canvas itself does.
          background: '#0f0f1a', // s2-theme-exempt(#0f0f1a): game canvas viewport placeholder stays dark in both modes
          // Placeholder text painted directly over that always-dark backdrop --
          // it never lightens, so this can't be a token without going illegible.
          color: 'rgba(255,255,255,0.35)', // s2-theme-exempt(rgba(255,255,255,0.35)): text over the always-dark canvas viewport
          fontSize: '15px'
        }}>
          Select a world to preview it, then Enter World.
        </div>
      )}
    </>
  );
}
