import { useEffect, useRef, useState, useMemo } from 'react';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { HiOutlineTrash, HiOutlinePuzzlePiece, HiOutlineWrenchScrewdriver, HiOutlineBeaker, HiOutlineCube, HiArrowsPointingOut, HiArrowsPointingIn, HiOutlineMap } from "react-icons/hi2";
import { Game } from "./src/js/main.js";
import { getStoredToken, parseJwt, clearToken, authHeaders, AUTH_EXPIRED_EVENT } from "./src/js/net/EngineClient.js";
import Login from "../../pages/Login.jsx";
import { useMapTiles, useMapConfig } from "./useMaps.js";
import { useWorlds, useCreateWorld, useDeleteWorld } from "./useWorlds";
import { MAP_TILE_SIZE } from "./src/js/core/constants.js";

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:13101';
import TileTypesAdmin from "./TileTypesAdmin";
import EntityTypesAdmin from "./EntityTypesAdmin";
import ItemTypesAdmin from "./ItemTypesAdmin";
import MapsAdmin from "./MapsAdmin";
import WorldPreview from "./WorldPreview.jsx";

const StyledGameContainer = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100%;
  background-color: #0f0f1a;
  overflow: hidden;
`;

// Small circular "?" button pinned to the top-right corner, above everything.
const HelpButton = styled.button`
  position: absolute;
  top: 12px;
  right: 16px;
  z-index: 300;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid #4a9eff;
  background: rgba(26, 26, 46, 0.85);
  color: #4a9eff;
  font-size: 1.1rem;
  font-weight: bold;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  transition: all 0.15s;
  &:hover { background: #4a9eff; color: #fff; }
`;

// Full-screen dim backdrop; clicking it closes the panel.
const HelpBackdrop = styled.div`
  position: absolute;
  inset: 0;
  z-index: 400;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
`;

const HelpCard = styled.div`
  background: #1a1a2e;
  border: 1px solid #2e2e3e;
  border-radius: 10px;
  padding: 24px 28px;
  width: min(560px, 92vw);
  max-height: 86vh;
  overflow-y: auto;
  color: #ddd;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);

  h2 { margin: 0 0 4px; color: #fff; font-size: 1.5rem; }
  h3 { margin: 20px 0 8px; color: #4a9eff; font-size: 1.05rem; }
  p.sub { margin: 0 0 8px; color: #888; font-size: 0.9rem; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 5px 0; vertical-align: top; font-size: 0.95rem; }
  td.k { width: 130px; white-space: nowrap; }
  kbd {
    display: inline-block;
    min-width: 18px;
    padding: 2px 7px;
    margin: 0 2px 2px 0;
    background: #0f0f1a;
    border: 1px solid #3a3a4e;
    border-bottom-width: 2px;
    border-radius: 5px;
    color: #eee;
    font-size: 0.85rem;
    font-family: monospace;
    text-align: center;
  }
`;

const HelpCloseButton = styled.button`
  float: right;
  background: transparent;
  border: none;
  color: #888;
  font-size: 1.4rem;
  line-height: 1;
  cursor: pointer;
  &:hover { color: #fff; }
`;

// One place to describe the controls, so the panel can't drift from reality.
// Keyboard/mouse bindings mirror core/Game.js and entities/Player.js.
const HELP_SECTIONS = [
  {
    title: 'Movement & combat',
    rows: [
      { k: [['W'], ['A'], ['S'], ['D']], d: 'Move (arrow keys also work)' },
      { k: [['Left-click']], d: 'Attack — fires toward the cursor with your equipped weapon' },
    ],
  },
  {
    title: 'Items & loot',
    rows: [
      { k: [['G']], d: 'Pick up the nearest ground item you are standing near' },
      { k: [['Auto-loot']], d: 'Toggle in the HUD — walk over items to collect them without pressing G' },
      { k: [['I']], d: 'Open the inventory / paper-doll: click an item then a slot to equip, click an equipped slot to unequip, and drop from the panel' },
    ],
  },
  {
    title: 'Session',
    rows: [
      { k: [['Esc']], d: 'Pause / resume' },
      { k: [['Sign out']], d: 'Top-right of the tab bar — clears your session and returns to the login screen' },
    ],
  },
  {
    title: 'Worlds & admin (tabs at the top)',
    rows: [
      { k: [['Game View']], d: 'Select a world in the right-hand list, then "Enter World (chunked)" to play it' },
      { k: [['Admin tabs']], d: 'TILE_TYPES / Entity / Items editors — visible to admin accounts only' },
    ],
  },
];

const TabBar = styled.div`
  display: flex;
  background: #1a1a2e;
  border-bottom: 2px solid #2e2e3e;
  padding: 0 20px;
  z-index: 100;
`;

const ADMIN_TAB_COLORS = { entity: '#facc15', items: '#f472b6', maps: '#34d399' };

const TabButton = styled.button`
  background: ${props => props.$active ? 'rgba(74, 158, 255, 0.1)' : 'transparent'};
  color: ${props => props.$active ? (ADMIN_TAB_COLORS[props.$adminType] || '#4a9eff') : '#aaa'};
  border: none;
  border-bottom: 3px solid ${props => props.$active ? (ADMIN_TAB_COLORS[props.$adminType] || '#4a9eff') : 'transparent'};
  padding: 1.5rem 2rem;
  font-size: 1.3rem;
  font-weight: bold;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.8rem;
  transition: all 0.2s;
  
  &:hover {
    color: ${props => props.$active ? (ADMIN_TAB_COLORS[props.$adminType] || '#4a9eff') : '#eee'};
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
  border: 1px solid #2e2e3e;
  background: rgba(26, 26, 46, 0.8);
  backdrop-filter: blur(8px);
  color: #e6e6f0;
  cursor: pointer;
  font-size: 20px;
  transition: background 0.15s, color 0.15s;

  &:hover { background: rgba(46, 46, 74, 0.95); color: #4a9eff; }
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
  const contentRef = useRef(null); // fullscreen target (wraps the game canvas)
  const [activeTab, setActiveTab] = useState('game');
  const [helpOpen, setHelpOpen] = useState(false);
  const [selectedWorldId, setSelectedWorldId] = useState(null);
  const [newWorldName, setNewWorldName] = useState('');
  const [newWorldSeed, setNewWorldSeed] = useState('');
  const [newWorldChunkSize, setNewWorldChunkSize] = useState('64');
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Authed = there is a stored token that still parses as unexpired. Checked at
  // mount so a page reload keeps the session instead of minting a new anonymous
  // user (SOMET-97). getStoredToken() clears an expired/malformed token itself.
  const [authed, setAuthed] = useState(() => !!getStoredToken());
  // Admin-only tabs (tile/entity/item registries) are gated on the JWT role
  // claim so non-admin players don't see controls that only 403 when used. The
  // server's adminGuard remains the real enforcement — this is UX/defense-in-
  // depth. Recomputed when `authed` flips (sign in/out swaps the stored token).
  const isAdmin = useMemo(() => parseJwt(getStoredToken())?.role === 'admin', [authed]);

  // A token can be REVOKED while still being well-formed and unexpired: any
  // token_version bump (logout-everywhere, `make admin-password`) leaves the
  // stored JWT parsing fine, so the checks above happily report "signed in as
  // admin" while the server 401s every write. That zombie session looks like a
  // broken app — admin screens render, saving silently fails.
  // Ask the server once on mount; only the server knows about token_version.
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/auth/me`, { headers: authHeaders() });
        if (cancelled || res.status !== 401) return;   // network/5xx: keep the session
        clearToken();
        setAuthed(false);
        toast.error('Session expired — please sign in again');
      } catch { /* offline: leave the session alone rather than logging out */ }
    })();
    return () => { cancelled = true; };
  }, [authed]);

  // The mount check above only catches a token that was ALREADY dead. A session
  // revoked while this tab is open (someone rotates the admin password, or hits
  // logout-everywhere) is caught here instead: apiFetch clears the token on any
  // 401 and fires this event, so the UI stops pretending to be signed in the
  // moment a request is actually rejected.
  useEffect(() => {
    const onExpired = () => {
      setAuthed(false);
      toast.error('Session expired — please sign in again');
    };
    globalThis.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => globalThis.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const { mapTiles, isLoadingMapTiles } = useMapTiles();
  // Entity types keyed by name (same shape the legacy map path uses) — the
  // chunked renderer needs them to draw creatures with their approved sprite.
  const { mapConfig } = useMapConfig();
  const { worlds, isLoadingWorlds, worldsError } = useWorlds();
  const createWorldMutation = useCreateWorld();
  const deleteWorldMutation = useDeleteWorld();

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

  const handleResume = () => {
    if (gameRef.current) gameRef.current.resume();
  };

  // --- Fullscreen (game canvas) ---
  const enterGameFullscreen = () => {
    const el = contentRef.current;
    // requestFullscreen must run within the user gesture that started the game.
    // The auto-join path has no gesture, so the promise rejects harmlessly and
    // the game just plays windowed until the player clicks the toggle button.
    if (el?.requestFullscreen) el.requestFullscreen().catch(() => {});
  };

  const exitGameFullscreen = () => {
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) exitGameFullscreen();
    else enterGameFullscreen();
  };

  // Keep the toggle button in sync with the real fullscreen state — including the
  // user pressing Esc, which exits fullscreen without going through our button.
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Enter fullscreen when the game starts. Driven off the isPlaying transition so
  // the explicit "Enter World" click and the auto-join share one path; the click's
  // transient activation is still valid through the quick world join.
  useEffect(() => {
    if (isPlaying) enterGameFullscreen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  const handleExit = () => {
    exitGameFullscreen();
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

      // Server-driven map transition (e.g. walking through a portal tile):
      // the authority sends {type:'transition', toWorldId, arriveX, arriveY}
      // and Game surfaces it here. Re-running handleEnterChunkedWorld tears
      // down the old authority connection and reconnects to the destination
      // world; the server spawns the rejoining player at the pending arrival.
      // handleEnterChunkedWorld is a component-scope const defined later in
      // this same render — safe to reference here because this callback is
      // only invoked later (on a transition frame), long after the const is
      // assigned, not during this effect's synchronous execution.
      gameRef.current.setOnTransition((msg) => {
        if (msg?.toWorldId) handleEnterChunkedWorld(msg.toWorldId);
      });
    }
    return () => {
      if (engineRef.current) {
        engineRef.current.disconnect();
        engineRef.current = null;
      }
    };
  }, [activeTab]);

  // Mount-once effect whose cleanup only fires on true component unmount
  // (empty dep array), unlike the [activeTab] effect above whose cleanup
  // also runs on every tab switch. Tears down the chunked Game instance
  // (authority WebSocket + rAF loop) so leaving this component doesn't
  // leave a ghost player connected to the server world sim.
  useEffect(() => {
    return () => {
      gameRef.current?.destroy();
    };
  }, []);

  const handleEnterChunkedWorld = async (worldId = selectedWorldId) => {
    if (!worldId || !gameRef.current) return;

    try {
      const world = worlds?.find(w => w.id === worldId);
      const chunkSize = world?.chunk_size || 64;
      const spawn = (chunkSize * MAP_TILE_SIZE) / 2;

      await gameRef.current.initChunked({
        worldId,
        chunkSize,
        tileTypes: mapTiles,
        entityTypes: mapConfig?.entityTypes || null,
        spawnX: spawn,
        spawnY: spawn,
      });
      setSelectedWorldId(worldId);
      setIsPlaying(true);
    } catch (err) {
      toast.error(err.message);
    }
  };

  // MISMATCH fix: a logged-in player should spawn straight into the canonical
  // entry world, not a world-picker. Prefer the world flagged `is_entry`
  // (Linked Maps); fall back to the migration-seeded world named "Overworld"
  // (lowest id if test duplicates exist) for worlds without an entry flag set.
  // Fires once worlds + the Game instance are ready. Admins keep the picker
  // (they manage worlds). If the join throws, handleEnterChunkedWorld toasts
  // and isPlaying stays false, so the picker remains as a safe fallback.
  // autoJoinedRef guards against retries.
  const autoJoinedRef = useRef(false);
  useEffect(() => {
    if (isAdmin || isPlaying || autoJoinedRef.current) return;
    if (!gameRef.current || !worlds || worlds.length === 0) return;
    const entry = worlds.find(w => w.is_entry);
    const overworld = worlds
      .filter(w => w.name === 'Overworld')
      .sort((a, b) => a.id - b.id)[0];
    const target = entry || overworld;
    if (!target) return;
    autoJoinedRef.current = true;
    handleEnterChunkedWorld(target.id);
    // handleEnterChunkedWorld is stable enough for this one-shot; deps kept
    // minimal so it fires once when worlds/game become ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worlds, isAdmin, isPlaying, activeTab]);

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

  // No valid stored token → gate the whole surface behind the login screen.
  // On success we store the token and flip authed; the game then renders.
  if (!authed) {
    return (
      <Login
        apiUrl={API_URL}
        onAuthed={() => setAuthed(true)}
      />
    );
  }

  return (
    <StyledGameContainer>
      <HelpButton
        title="Help — controls & operations"
        aria-label="Help"
        onClick={() => setHelpOpen(true)}
      >
        ?
      </HelpButton>

      {helpOpen && (
        <HelpBackdrop onClick={() => setHelpOpen(false)}>
          <HelpCard onClick={(e) => e.stopPropagation()}>
            <HelpCloseButton aria-label="Close help" onClick={() => setHelpOpen(false)}>×</HelpCloseButton>
            <h2>Help</h2>
            <p className="sub">Controls and main operations.</p>
            {HELP_SECTIONS.map((section) => (
              <div key={section.title}>
                <h3>{section.title}</h3>
                <table>
                  <tbody>
                    {section.rows.map((row, i) => (
                      <tr key={i}>
                        <td className="k">
                          {row.k.map((keyGroup, gi) => (
                            <kbd key={gi}>{keyGroup[0]}</kbd>
                          ))}
                        </td>
                        <td>{row.d}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </HelpCard>
        </HelpBackdrop>
      )}

      <TabBar>
        <TabButton $active={activeTab === 'game'} onClick={() => setActiveTab('game')}>
          <HiOutlinePuzzlePiece /> Game View
        </TabButton>
        {isAdmin && (
          <>
            <TabButton $active={activeTab === 'tiles'} onClick={() => setActiveTab('tiles')}>
              <HiOutlineWrenchScrewdriver /> TILE_TYPES Admin
            </TabButton>
            <TabButton $active={activeTab === 'entity'} $adminType="entity" onClick={() => setActiveTab('entity')}>
              <HiOutlineBeaker /> Entity Admin
            </TabButton>
            <TabButton $active={activeTab === 'items'} $adminType="items" onClick={() => setActiveTab('items')}>
              <HiOutlineCube /> Items
            </TabButton>
            <TabButton $active={activeTab === 'maps'} $adminType="maps" onClick={() => setActiveTab('maps')}>
              <HiOutlineMap /> Maps
            </TabButton>
          </>
        )}
        <TabButton
          style={{ marginLeft: 'auto' }}
          onClick={() => {
            if (engineRef.current) { engineRef.current.disconnect(); engineRef.current = null; }
            clearToken();
            setAuthed(false);
          }}
        >
          Sign out
        </TabButton>
      </TabBar>

      <ContentArea ref={contentRef}>
        {activeTab === 'game' && (
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
                          <HiOutlineTrash
                            style={{ color: '#ef4444', cursor: 'pointer', flexShrink: 0 }}
                            title="Delete world"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (window.confirm(`Delete world "${world.name}"? This removes its chunks, creatures, and loot.`)) {
                                if (selectedWorldId === world.id) setSelectedWorldId(null);
                                deleteWorldMutation.mutate(world.id);
                              }
                            }}
                          />
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
                    onClick={() => handleEnterChunkedWorld()}
                    disabled={!selectedWorldId}
                    style={{ width: '100%', marginTop: '10px', background: '#10b981' }}
                  >
                    Enter World (chunked)
                  </Button>
                </Panel>
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

          {!isPlaying && selectedWorldId && (
            <WorldPreview worldId={selectedWorldId} tileColors={tileColors} />
          )}
          {!isPlaying && !selectedWorldId && (
            <div style={{
              width: '100%', height: '100%', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: 'rgba(255,255,255,0.35)', fontSize: '15px'
            }}>
              Select a world to preview it, then Enter World.
            </div>
          )}
          </>
        )}
        {isAdmin && activeTab === 'tiles' && <TileTypesAdmin />}
        {isAdmin && activeTab === 'entity' && <EntityTypesAdmin />}
        {isAdmin && activeTab === 'items' && <ItemTypesAdmin />}
        {isAdmin && activeTab === 'maps' && <MapsAdmin />}
        {/* Kept mounted across tab switches, NOT nested in the game tab's
            conditional. RenderSystem captures this element and its 2d context
            when the world is entered, so unmounting it on a tab switch left the
            running render loop drawing into a detached canvas while React
            mounted a fresh (blank) one — the game view came back empty.
            Hiding it is enough; the rAF loop and authority socket keep running,
            so returning to the tab resumes the live world instead of reloading. */}
        <canvas
          ref={canvasRef}
          style={{
            width: '100%',
            height: '100%',
            display: activeTab === 'game' && isPlaying ? 'block' : 'none',
          }}
        />
      </ContentArea>
    </StyledGameContainer>
  );
}