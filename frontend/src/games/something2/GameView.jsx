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
import WaypointTravel from "./WaypointTravel.jsx";
import CharacterSheet from "./CharacterSheet.jsx";
import GameSettings from "./GameSettings.jsx";

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

// Sits in the same always-visible in-game control stack, below "How to play"
// and the Settings button that SOMET-493 inserted between them. NOT in the
// pause overlay: nothing in this app ever sets isPaused to true, so that
// overlay is unreachable and a control placed there would be as inert as the
// handler was before it had a caller at all.
const ChangeCharacterButton = styled(HowToButton)`
  top: 340px;
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

// Centred over the canvas area rather than in the top-right UIOverlay stack:
// this is the only thing on screen when it shows, and a player who has just
// been dropped out of their world should not have to hunt for the way back.
const RecoveryPanel = styled.div`
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 40;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 380px;
  padding: 20px;
  border-radius: 12px;
  border: 1px solid var(--s2-border);
  background: var(--s2-panel-veil-solid);
  color: var(--s2-text);
  box-shadow: 0 8px 32px var(--s2-shadow);
  pointer-events: auto;
  font-size: 14px;
  line-height: 1.5;
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
    enterWorld, retryJoin, resume, exitToMenu, changeCharacter, toggleFullscreen, openHelp,
    // The RESOLVED character, not the stored id: a stored id whose character
    // was deleted elsewhere resolves to null, and that is precisely the case
    // where entering a world must not be offered.
    activeCharacter,
  } = useOutletContext();

  const { isAdmin } = useAuth();
  const [newWorldName, setNewWorldName] = useState('');
  const [newWorldSeed, setNewWorldSeed] = useState('');
  const [newWorldChunkSize, setNewWorldChunkSize] = useState('64');

  // Same query key GameShell uses (same character id) so TanStack serves both
  // from one cache entry -- see the comment on GameShell's useWorlds() call.
  const { mapTiles } = useMapTiles();
  const { worlds, isLoadingWorlds } = useWorlds(activeCharacter?.id);
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
      {/* SOMET-293. Mounted beside the other HUD panels rather than inside
          the canvas: it is a list of rows, and the canvas cannot render one.
          Keyed on the character, because activation is per character. */}
      {isPlaying && <WaypointTravel gameRef={gameRef} characterId={activeCharacter?.id} />}
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
      {/* SOMET-493 -- directly below "How to play", and it owns the auto-loot
          toggle that used to live in the canvas inventory panel's footer. */}
      {isPlaying && <GameSettings gameRef={gameRef} />}
      {isPlaying && (
        <ChangeCharacterButton
          type="button"
          title="Leave this world and pick a different character"
          onClick={changeCharacter}
        >
          Change Character
        </ChangeCharacterButton>
      )}
      {/* SOMET-262: `isAdmin`, not just `!isPlaying`. The whole picker is an
          admin surface -- this item's own description says admins go through
          the character gate "then their existing world picker". Previously only
          the trash icon and the create form inside it were gated (SOMET-226,
          which framed this as destructive-controls-only), so a player-role
          account still had the full world list in its DOM: all 86 worlds with
          names, seeds and chunk sizes, including every dungeon interior, plus
          an enabled Enter World button.

          CharacterSelect's overlay happens to paint over this, so a sighted
          mouse user never saw it -- but it was in the accessibility tree and
          reachable by keyboard, and it directly contradicts SOMET-263, which
          goes to the trouble of hiding unvisited world NAMES behind anonymous
          "?" stubs on the World Map. Relying on one component covering another
          is not a gate. */}
      {!isPlaying && isAdmin && (
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

              {/* SOMET-262: also disabled without an ACTIVE CHARACTER, and it
                  says why. GameShell's enterWorld opens with
                  `if (!activeCharacter) return false;` -- a silent refusal --
                  and this picker is shown in exactly the state where that is
                  true (no active character is also what puts CharacterSelect
                  on screen). So the button was dead on arrival for admins too:
                  clicking it did nothing, printed nothing, and looked
                  identical to a click that worked. Better to refuse up front
                  with a reason than to toast after the fact. */}
              <Button
                onClick={() => enterWorld()}
                disabled={!selectedWorldId || !activeCharacter}
                style={{ width: '100%', marginTop: '10px', background: 'var(--s2-success-alt)' }}
              >
                Enter World (chunked)
              </Button>
              {!activeCharacter && (
                <p style={{ color: 'var(--s2-text-dim)', fontSize: '12px', margin: '8px 0 0 0' }}>
                  Choose a character first — a world is entered as a character.
                </p>
              )}
            </Panel>
        </UIOverlay>
      )}

      {/* SOMET-262: a player's way OUT of a failed join.
          The auto-join effect sets autoJoinedRef BEFORE awaiting enterWorld, so
          a join that fails never retries, and enterWorld's own comment leaned on
          the world picker being "a safe fallback". For an admin it still is.
          For a player the picker is now (correctly) gone, and without this they
          are stranded: active character set, isPlaying false, a static
          WorldPreview on screen and not one control to escape it.
          Reproduced live -- a second tab on the same account triggered
          "kicked: signed in elsewhere", isPlaying went false, and the session
          was a dead end.
          Both routes out are offered, because the right one depends on why the
          join failed: retry the same world (transient -- a kick, a dropped
          socket), or go back and pick a character (the character itself is the
          problem). */}
      {!isPlaying && !isAdmin && activeCharacter && (
        <RecoveryPanel role="alert">
          <strong>You are not in a world.</strong>
          <span>
            The connection to your last world did not complete. This usually
            means you signed in somewhere else, or the connection dropped.
          </span>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {/* retryJoin, NOT enterWorld(): enterWorld with no argument falls
                back to selectedWorldId, which nothing has set on a fresh page
                load -- the exact situation this panel exists for. The first
                version of this button was therefore permanently disabled
                precisely when it was needed. retryJoin re-runs the auto-join
                rule and clears the one-shot guard. */}
            <Button onClick={retryJoin}>
              Try again
            </Button>
            <Button onClick={changeCharacter} style={{ background: 'var(--s2-btn-grey)' }}>
              Choose a character
            </Button>
          </div>
        </RecoveryPanel>
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
          {/* Role-aware: a player no longer has a picker to select from, so
              the admin instruction would be describing a control that is not
              there. Mostly read by screen readers here -- CharacterSelect
              paints over this area -- which is the same reason it should not
              be lying. */}
          {isAdmin
            ? 'Select a world to preview it, then Enter World.'
            : 'Choose a character to enter the world.'}
        </div>
      )}
    </>
  );
}
