import { useEffect, useRef, useState } from 'react';
import { Outlet, useMatch } from 'react-router-dom';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { Game } from "./src/js/main.js";
import { useMapTiles, useMapConfig, useVfxEffects } from "./useMaps.js";
import { useWorlds } from "./useWorlds";
import { autoJoinTarget } from "./autoJoin.js";
import CharacterSelect from "./CharacterSelect.jsx";
import { useCharacters } from "./useCharacters.js";
import {
  readActiveCharacterId, writeActiveCharacterId, clearActiveCharacterId, resolveActiveCharacter,
} from "./characterSession.js";
import { bindGameCanvas } from "./gameCanvasBinding.js";
import { MAP_TILE_SIZE } from "./src/js/core/constants.js";
import { useAuth } from "../../context/AuthContext";

// Root of the WHOLE layout route -- wraps the child-route Outlet and so every
// admin panel, not just the game canvas. Its background is the page backdrop
// showing in the gutters beside any centred, max-width admin panel (all six
// admin roots use max-width + margin: 0 auto), so this must tokenize like any
// other chrome surface, not stay dark.
const StyledGameContainer = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background-color: var(--s2-bg);
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
  border: 1px solid var(--s2-accent);
  background: var(--s2-panel-veil);
  color: var(--s2-accent);
  font-size: 1.1rem;
  font-weight: bold;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  transition: all 0.15s;
  &:hover { background: var(--s2-accent); color: var(--s2-on-accent); }
`;

// Full-screen dim backdrop; clicking it closes the panel.
const HelpBackdrop = styled.div`
  position: absolute;
  inset: 0;
  z-index: 400;
  background: var(--s2-scrim);
  display: flex;
  align-items: center;
  justify-content: center;
`;

const HelpCard = styled.div`
  background: var(--s2-surface);
  border: 1px solid var(--s2-border);
  border-radius: 10px;
  padding: 24px 28px;
  width: min(560px, 92vw);
  max-height: 86vh;
  overflow-y: auto;
  color: var(--s2-text-secondary);
  box-shadow: 0 10px 40px var(--s2-scrim-soft);

  h2 { margin: 0 0 4px; color: var(--s2-text-strong); font-size: 1.5rem; }
  h3 { margin: 20px 0 8px; color: var(--s2-accent); font-size: 1.05rem; }
  p.sub { margin: 0 0 8px; color: var(--s2-text-dim); font-size: 0.9rem; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 5px 0; vertical-align: top; font-size: 0.95rem; }
  td.k { width: 130px; white-space: nowrap; }
  kbd {
    display: inline-block;
    min-width: 18px;
    padding: 2px 7px;
    margin: 0 2px 2px 0;
    background: var(--s2-bg);
    border: 1px solid var(--s2-border-strong);
    border-bottom-width: 2px;
    border-radius: 5px;
    color: var(--s2-text);
    font-size: 0.85rem;
    font-family: monospace;
    text-align: center;
  }
`;

const HelpCloseButton = styled.button`
  float: right;
  background: transparent;
  border: none;
  color: var(--s2-text-dim);
  font-size: 1.4rem;
  line-height: 1;
  cursor: pointer;
  &:hover { color: var(--s2-text-strong); }
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
    title: 'Merchants, map & travel',
    rows: [
      { k: [['E']], d: 'Trade with a village merchant — stand next to the merchant and press E to open the market' },
      { k: [['M']], d: 'Toggle the minimap (top-right corner); click the minimap to expand it' },
      { k: [['T']], d: 'Travel — while standing on a waypoint you have lit, opens the list of other lit waypoints. Walk onto a waypoint once to light it; ones you have not found are shown but cannot be chosen' },
    ],
  },
  {
    title: 'Session',
    rows: [
      { k: [['Esc']], d: 'Pause / resume' },
      { k: [['Sign out']], d: 'Bottom of the left sidebar — clears your session and returns to the login screen' },
    ],
  },
  {
    title: 'Worlds & admin (left sidebar)',
    rows: [
      { k: [['Game View']], d: 'Select a world in the right-hand list, then "Enter World (chunked)" to play it' },
      { k: [['Admin']], d: 'Tile Types / Entities / Items / Maps / Biomes / World Map editors — visible to admin accounts only' },
    ],
  },
];

const ContentArea = styled.div`
  flex: 1;
  position: relative;
  overflow: hidden;
`;

export default function GameShell() {
  const canvasRef = useRef(null);
  const gameRef = useRef(null);
  const contentRef = useRef(null); // fullscreen target (wraps the game canvas)
  // Always holds the LATEST enterWorld. The doorway-transition callback is
  // registered once (in the [isGameRoute] effect) and would otherwise capture a
  // stale closure -- one built before the async map-tiles/worlds/vfx queries
  // resolved -- making a mid-session transition re-init the world with empty
  // tile defs (terrain then renders as the invisible fallback colour).
  const handleEnterRef = useRef(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [selectedWorldId, setSelectedWorldId] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Bumped whenever the Game instance is thrown away, to make the bind effect
  // below build a new one. A ref cannot be an effect dependency, so nulling
  // gameRef on its own is invisible to React -- see changeCharacter.
  const [gameEpoch, setGameEpoch] = useState(0);
  const { isAdmin } = useAuth();

  // Replaces the old `activeTab === 'game'`. useMatch is an exact match, so this
  // is false on /game/biomes and friends -- which is what hides the canvas
  // without unmounting it.
  const isGameRoute = !!useMatch('/game');

  const { mapTiles } = useMapTiles();
  const { vfxEffects } = useVfxEffects();
  // Entity types keyed by name (same shape the legacy map path uses) — the
  // chunked renderer needs them to draw creatures with their approved sprite.
  const { mapConfig } = useMapConfig();

  // SOMET-262: the authority refuses a join with no character, so the canvas is
  // gated behind a choice. `characters` undefined means "still loading" -- a
  // THIRD state, distinct from "no character": treating it as the latter
  // flashes the picker for a frame before the canvas on every reload.
  const { characters, maxCharacters, isLoadingCharacters } = useCharacters();
  const [activeCharacterId, setActiveCharacterId] = useState(() => readActiveCharacterId());
  const activeCharacter = resolveActiveCharacter(activeCharacterId, characters);

  // worldsError is toasted inside useWorlds() itself (F-023), so every caller
  // gets the signal without opting in. GameView calls useWorlds() with the
  // same character id too; TanStack dedupes them by query key, so this is one
  // request, not two. SOMET-276: threading activeCharacter's id is what lets
  // a player-role token get the visited/unvisited projection instead of the
  // minimal-only default -- read before activeCharacter is known (still
  // undefined here on first render), so this naturally starts minimal-only
  // and re-fetches once a character is resolved.
  const { worlds } = useWorlds(activeCharacter?.id);

  // A stored id whose character no longer exists (deleted from another device)
  // resolves to null. Drop it rather than letting it reach a join the server
  // will reject -- that surfaces as an error the player has to dismiss instead
  // of simply landing on the picker.
  useEffect(() => {
    if (!isLoadingCharacters && Array.isArray(characters)
        && activeCharacterId != null && !activeCharacter) {
      clearActiveCharacterId();
      setActiveCharacterId(null);
    }
  }, [isLoadingCharacters, characters, activeCharacterId, activeCharacter]);

  const playCharacter = (id) => { writeActiveCharacterId(id); setActiveCharacterId(id); };

  const resume = () => {
    if (gameRef.current) gameRef.current.resume();
  };

  // --- Fullscreen (game canvas) ---
  const enterGameFullscreen = () => {
    const el = contentRef.current;
    // requestFullscreen must run within the user gesture that started the game.
    // The auto-join path has no gesture, so the promise rejects harmlessly and
    // the game just plays windowed until the player clicks the toggle button.
    if (el?.requestFullscreen) {
      el.requestFullscreen()
        .then(() => {
          if (navigator.keyboard?.lock) {
            navigator.keyboard.lock(['Escape']).catch(() => {});
          }
        })
        .catch(() => {});
    }
  };

  const exitGameFullscreen = () => {
    if (navigator.keyboard?.unlock) {
      navigator.keyboard.unlock();
    }
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
    const onChange = () => {
      const inFs = !!document.fullscreenElement;
      setIsFullscreen(inFs);
      if (inFs) {
        if (navigator.keyboard?.lock) {
          navigator.keyboard.lock(['Escape']).catch(() => {});
        }
      } else {
        if (navigator.keyboard?.unlock) {
          navigator.keyboard.unlock();
        }
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (navigator.keyboard?.unlock) {
        navigator.keyboard.unlock();
      }
    };
  }, []);

  // Enter fullscreen when the game starts. Driven off the isPlaying transition so
  // the explicit "Enter World" click and the auto-join share one path; the click's
  // transient activation is still valid through the quick world join.
  useEffect(() => {
    if (isPlaying) enterGameFullscreen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  // Leaves the world and returns to the picker. autoJoinedRef is reset so the
  // next choice can auto-join again; without that a non-admin would land on a
  // dead canvas after switching.
  const changeCharacter = () => {
    exitToMenu();
    gameRef.current?.destroy?.();
    gameRef.current = null;
    clearActiveCharacterId();
    setActiveCharacterId(null);
    autoJoinedRef.current = false;
    // REQUIRED, and its absence was a hard dead end. The two lines above
    // destroy the Game and null the ref, but the effect that builds one is
    // keyed on [isGameRoute] -- and switching characters never leaves /game,
    // so nothing rebuilt it. Every downstream path then refused, silently:
    // autoJoinTarget returns null on `hasGame: false`, so the next character
    // never auto-joined, and enterWorld opens with
    // `if (!worldId || !gameRef.current) return false`, so the recovery
    // panel's "Try again" did nothing at all. Only a full page reload
    // recovered. Reported from the game: "logout of game, selected another
    // character, then i stuck at map page" and "when i click try again
    // nothing happens".
    setGameEpoch((n) => n + 1);
  };

  const exitToMenu = () => {
    exitGameFullscreen();
    setIsPlaying(false);
    setIsPaused(false);
    if (gameRef.current) {
      gameRef.current.setState('menu');
      gameRef.current.setEngineClient?.(null, null);
    }
  };

  // F-045: this used to only rerun on an activeTab change, so an authed
  // false->true cycle (sign out, sign back in — same mechanism a
  // token_version revocation mid-session routes through) tore down and
  // remounted the whole <canvas> node without ever telling the still-alive
  // Game instance about it: Game.canvas kept pointing at the old, detached
  // node while the authority socket and rAF loop kept running underneath, so
  // the screen went blank while the player kept taking live damage.
  // Rebinding *was* keyed on `authed` too, and bindGameCanvas (unlike the old
  // inline `new Game(canvasRef.current)`, which silently discarded that
  // argument — see its own docs) always assigns canvas/ctx/size explicitly
  // rather than leaning on construction.
  //
  // The old `authed` dependency is gone: sign-out now unmounts this whole
  // component via RequireAuth, so a sign-in always produces a fresh mount
  // rather than an in-place canvas swap. bindGameCanvas stays because
  // re-running it against the same node is idempotent and it is the tested path.
  //
  // Deliberately NOT gated on isGameRoute (SOMET-271). The canvas element is
  // rendered unconditionally and only display-toggled, so binding it does not
  // need the game route to be active -- and requiring it meant that loading
  // /game/map DIRECTLY (a reload, a bookmark, a deep link) left gameRef null
  // forever, because this effect's condition was false on mount and nothing
  // re-ran it until the player navigated to /game. The visible symptom was the
  // World Map's click-to-travel silently doing nothing: enterWorld bails on
  // `!gameRef.current` before it can even raise a toast. Found in the browser;
  // both suites were green, because neither can mount this component.
  useEffect(() => {
    if (canvasRef.current) {
      gameRef.current = bindGameCanvas(gameRef.current, canvasRef.current, () => new Game());

      gameRef.current.setOnStateChange((newState) => {
        setIsPaused(newState === 'paused');
        if (newState === 'menu') {
          setIsPlaying(false);
          setIsPaused(false);
        }
      });

      // Server-driven map transition (e.g. walking through a portal tile):
      // the authority sends {type:'transition', toWorldId, arriveX, arriveY}
      // and Game surfaces it here. Re-running enterWorld tears down the old
      // authority connection and reconnects to the destination world; the
      // server spawns the rejoining player at the pending arrival. Call through
      // handleEnterRef (updated every render) rather than closing over
      // enterWorld directly -- see the handleEnterRef declaration above.
      gameRef.current.setOnTransition((msg) => {
        if (msg?.toWorldId) handleEnterRef.current?.(msg.toWorldId);
      });
    }
    // NOTE: no engine teardown on cleanup. The old cleanup disconnected
    // `engineRef`, which was never assigned -- dead code. Real teardown is the
    // mount-once destroy effect below.
    //
    // gameEpoch is a dependency because changeCharacter destroys the Game and
    // nulls the ref while staying on /game: without it this effect never
    // re-ran and the ref stayed null for the rest of the session.
  }, [isGameRoute, gameEpoch]);

  // Mount-once effect whose cleanup only fires on true component unmount
  // (empty dep array), unlike the [isGameRoute] effect above, which reruns on
  // every navigation between /game and its children. Tears down the chunked Game instance
  // (authority WebSocket + rAF loop) so leaving this component doesn't
  // leave a ghost player connected to the server world sim.
  useEffect(() => {
    return () => {
      gameRef.current?.destroy();
    };
  }, []);

  // Returns whether the player actually ended up in the world. The World Map's
  // click-to-travel needs to know: it navigates to the canvas afterwards, and a
  // refused join (the authority's join policy can say no) must leave the player
  // looking at the map with the toast this function raises, not at a blank
  // canvas that never received `joined`. Every other caller ignores the value.
  // "This session has already put the player in a world." Set by auto-join AND
  // by enterWorld; read by the auto-join effect below as `alreadyJoined`.
  const autoJoinedRef = useRef(false);

  const enterWorld = async (worldId = selectedWorldId) => {
    if (!worldId || !gameRef.current) return false;
    // Read through the ref-free closure: enterWorld is re-created every render,
    // and handleEnterRef below always points at the latest one, so this sees
    // the current character rather than the one active at mount.
    if (!activeCharacter) return false;

    try {
      const world = worlds?.find(w => w.id === worldId);
      const chunkSize = world?.chunk_size || 64;
      const spawn = (chunkSize * MAP_TILE_SIZE) / 2;

      await gameRef.current.initChunked({
        worldId,
        characterId: activeCharacter.id,
        chunkSize,
        tileTypes: mapTiles,
        vfxEffects: vfxEffects || null,
        entityTypes: mapConfig?.entityTypes || null,
        spawnX: spawn,
        spawnY: spawn,
      });
      setSelectedWorldId(worldId);
      setIsPlaying(true);
      // This session has put the player in a world, so auto-join is done --
      // however it happened (auto-join itself, the admin picker, or a click on
      // the World Map). Previously only the auto-join path set this, so a map
      // travel left auto-join still armed: any later re-evaluation where
      // isPlaying read false sent the character straight back to
      // activeCharacter.lastWorldId, which is the world it travelled AWAY from
      // and is stale the moment travel succeeds. Observed live -- the click
      // entered Old Trailhead and the character ended up in Windwatch Pass.
      autoJoinedRef.current = true;
      return true;
    } catch (err) {
      toast.error(err.message);
      return false;
    }
  };
  // Keep the transition callback pointed at the current closure (fresh
  // mapTiles/worlds/vfxEffects/mapConfig) — see handleEnterRef declaration above.
  handleEnterRef.current = enterWorld;

  // MISMATCH fix: a logged-in player should spawn straight into the canonical
  // entry world, not a world-picker. Target selection and the readiness rule
  // live in autoJoin.js so they can be unit-tested. Fires once the Game
  // instance, the world list AND the map assets are ready — see
  // worldAssetsReady() for why joining early is not self-healing. Admins keep
  // the picker (they manage worlds). If the join throws, enterWorld toasts and
  // isPlaying stays false, so the picker remains as a safe fallback.
  // autoJoinedRef guards against retries. Declared above enterWorld, which
  // also sets it -- a `const` referenced from a closure defined earlier works
  // only because the closure runs after render, which is a footgun nobody
  // should have to re-derive.
  // One place builds autoJoinTarget's arguments, because there are now TWO
  // callers -- the effect below and the player's manual retry. A second
  // hand-written argument list is exactly how `hasCharacter` came to be
  // omitted at this call site and silently disabled auto-join for everyone.
  const joinTargetArgs = () => ({
    isAdmin, isPlaying, alreadyJoined: autoJoinedRef.current,
    hasGame: !!gameRef.current, worlds, mapTiles, mapConfig,
    // Was implicit in `hasGame` until SOMET-271; now passed explicitly,
    // because the Game instance is no longer route-gated. See autoJoin.js.
    isGameRoute,
    // SOMET-260 added `hasCharacter` to autoJoinTarget and this call site did
    // not supply it, so it arrived `undefined` and the guard returned null
    // every time -- auto-join was dead for EVERY player, not just for one
    // without a character. autoJoin.test.js passed the flag explicitly and
    // stayed green throughout. Caught in the browser.
    hasCharacter: !!activeCharacter,
    // Where this character logged out. Read off activeCharacter, which is
    // also the effect's dependency, so a character switch re-evaluates the
    // target rather than resuming the previous character's world.
    lastWorldId: activeCharacter ? activeCharacter.lastWorldId : null,
  });

  // The player's way back after a failed or kicked join. Forces the two
  // "already handled" guards off: `alreadyJoined` is set BEFORE the await in
  // the effect, so after a failure it is stuck true and the effect will never
  // try again on its own. Deliberately re-uses autoJoinTarget rather than
  // retrying `selectedWorldId` -- on a fresh page load nothing has set that,
  // which is precisely the case where the retry is needed and the first
  // version of this button sat there disabled.
  const retryJoin = () => {
    const targetId = autoJoinTarget({ ...joinTargetArgs(), isPlaying: false, alreadyJoined: false });
    autoJoinedRef.current = true;
    return enterWorld(targetId == null ? selectedWorldId : targetId);
  };

  useEffect(() => {
    const targetId = autoJoinTarget(joinTargetArgs());
    if (targetId == null) return;
    autoJoinedRef.current = true;
    enterWorld(targetId);
    // enterWorld is stable enough for this one-shot; deps kept
    // minimal so it fires once the inputs become ready. activeCharacter is a
    // real dependency, not bookkeeping: choosing a character is the LAST input
    // to become ready, and without it here the effect never re-runs after the
    // picker closes -- the player sits on the world list forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worlds, mapTiles, mapConfig, isAdmin, isPlaying, isGameRoute, activeCharacter]);

  return (
    <StyledGameContainer>
      {!isPlaying && (
        <HelpButton
          title="Help — controls & operations"
          aria-label="Help"
          onClick={() => setHelpOpen(true)}
        >
          ?
        </HelpButton>
      )}

      <ContentArea ref={contentRef}>
        {/* Rendered INSIDE contentRef (the fullscreen element) so the panel is
            part of the fullscreen top layer. Rendered at the top level it was
            painted behind the fullscreen game canvas — invisible while playing. */}
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

        <Outlet context={{
          gameRef, isPlaying, isPaused, isFullscreen,
          // The player map route reads this rather than re-reading
          // localStorage, so there is one source of truth for which character
          // is active and it cannot disagree with the one the canvas is using.
          activeCharacterId,
          // The RESOLVED character too, not just the id. GameView needs to know
          // whether entering a world is possible at all, and that is exactly
          // the question enterWorld answers with `if (!activeCharacter)`.
          // Deriving it again from the id in the consumer would be a second
          // copy of resolveActiveCharacter's rule, free to disagree with this
          // one.
          activeCharacter,
          selectedWorldId, setSelectedWorldId,
          enterWorld, retryJoin, resume, exitToMenu, changeCharacter, toggleFullscreen,
          openHelp: () => setHelpOpen(true),
        }} />

        {/* The character gate. Rendered BESIDE the Outlet and the canvas, not
            instead of them: CharacterSelect's own Panel is `position:absolute;
            inset:0` with a z-index above the world picker, so it covers the
            content area while leaving the canvas element mounted underneath.
            Swapping it in for the canvas would recreate the element
            RenderSystem captured -- the bug the comment below this describes.

            AFTER the Outlet, so DOM order matches paint order and tab order
            lands in the picker rather than in the world list behind it.

            Gated on `activeCharacter`, the RESOLVED character, not on
            activeCharacterId: a stored id whose character was deleted
            elsewhere resolves to null, and the player belongs on the picker
            rather than at a join the server will refuse. While the query is in
            flight `characters` is undefined and resolveActiveCharacter returns
            null, so the picker shows its own loading state rather than the
            world list flashing past. */}
        {isGameRoute && !isPlaying && !activeCharacter && (
          <CharacterSelect
            characters={characters}
            maxCharacters={maxCharacters}
            onPlay={playCharacter}
          />
        )}

        {/* Kept mounted across route changes, NOT nested in the game route's
            element. RenderSystem captures this element and its 2d context when
            the world is entered, so unmounting it on a navigation left the
            running render loop drawing into a detached canvas while React
            mounted a fresh (blank) one — the game view came back empty.
            Hiding it is enough; the rAF loop and authority socket keep running,
            so returning to /game resumes the live world instead of reloading. */}
        {/* Geometry is owned by Game.resizeCanvas(), which letterboxes the fixed
            1280x720 backing store into THIS element's container and centres it
            with absolute offsets. What is declared here is only the pre-fit
            fallback: absolute + inset 0 keeps the element inside the content
            area (which clips) instead of overflowing it, the way a
            window-sized box did until SOMET-489 and cut the HUD orbs off. */}
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            display: isGameRoute && isPlaying ? 'block' : 'none',
            background: '#0f0f1a', // s2-theme-exempt(#0f0f1a): game canvas surface stays dark in both modes
          }}
        />
      </ContentArea>
    </StyledGameContainer>
  );
}
