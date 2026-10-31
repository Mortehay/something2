import { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { authHeaders, apiFetch } from './src/js/net/auth.js';
import { buildTravelList, splitTravelTabs, lastSpireCheckpoint, REASON } from './waypointTravel.js';
import { shouldAutoOpen, portalTileOf } from './portalAutoOpen.js';
import { API_URL } from '../../config.js';

// The waypoint travel popup (SOMET-293), opened with T while playing.
//
// A THIN RENDERER over waypointTravel.js. Every rule -- which waypoint the
// player is standing on, which rows are selectable, why a row is not -- lives in
// that module, because vitest runs in a node environment here and a rule written
// inline in this file could not be tested at all.
//
// Travel itself goes through Game.travelToWaypoint, i.e. the socket the player
// already holds. This component deliberately puts nobody into a world: the
// server answers a travel with the same `transition` frame a doorway sends, and
// GameShell already routes that onward. A second entry path here is the
// two-loader shape that has shipped inert features in this project before --
// WaypointTravel.smoke.test.js asserts the absence by literal token, which is
// why the names are spelled around rather than quoted here.

// How often the popup re-reads the player's position while it is open. The
// player can walk off a waypoint with the panel up, and the enabled/disabled
// state has to follow. 200ms rather than a rAF loop: this is a list of DOM rows,
// not a canvas, and re-rendering it 60 times a second would be waste.
const POSITION_POLL_MS = 200;

// How often the CLOSED popup checks whether the player has just arrived on the
// portal (SOMET-300). Coarser than the poll above because a tile transition is a
// coarse event and this one runs for the whole session rather than only while a
// panel is up -- 4 checks a second is well inside the reaction time a player
// experiences as "it opened when I stepped on it".
const ARRIVAL_POLL_MS = 250;

const Backdrop = styled.div`
  position: absolute;
  inset: 0;
  z-index: 400;
  background: var(--s2-scrim);
  display: flex;
  align-items: center;
  justify-content: center;
`;

const Card = styled.div`
  background: var(--s2-surface);
  border: 1px solid var(--s2-border);
  border-radius: 10px;
  padding: 20px 24px;
  width: min(460px, 92vw);
  max-height: 80vh;
  overflow-y: auto;
  color: var(--s2-text-secondary);
  box-shadow: 0 10px 40px var(--s2-scrim-soft);

  h2 { margin: 0 0 4px; color: var(--s2-text-strong); font-size: 1.35rem; }
  p.sub { margin: 0 0 12px; color: var(--s2-text-dim); font-size: 0.9rem; }
  h3 {
    margin: 16px 0 6px; font-size: 0.8rem; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--s2-text-dim);
  }
`;

const TabBar = styled.div`
  display: flex; gap: 6px; margin: 8px 0 4px;
`;

const TabButton = styled.button`
  flex: 1;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid ${(p) => (p.$active ? 'var(--s2-accent)' : 'var(--s2-border)')};
  background: ${(p) => (p.$active ? 'var(--s2-accent)' : 'transparent')};
  color: ${(p) => (p.$active ? 'var(--s2-on-accent)' : 'var(--s2-text-secondary)')};
  font: inherit;
  font-weight: 600;
  cursor: pointer;
`;

const LastButton = styled.button`
  display: block; width: 100%; margin: 8px 0 4px; padding: 9px 12px;
  border-radius: 6px; border: 1px solid var(--s2-accent);
  background: var(--s2-accent); color: var(--s2-on-accent);
  font: inherit; font-weight: 700; cursor: pointer;
  &:disabled { opacity: 0.45; cursor: default; }
`;

const CloseButton = styled.button`
  float: right;
  background: transparent;
  border: none;
  color: var(--s2-text-dim);
  font-size: 1.4rem;
  line-height: 1;
  cursor: pointer;
  &:hover { color: var(--s2-text-strong); }
`;

// One row per waypoint. `$selectable` and `$activated` are separate props, not
// one state: an activated waypoint the player cannot travel to right now (they
// are standing on it, or on open ground) must still read as a place they HAVE
// been. Collapsing the two would make "discovered" and "reachable" the same
// colour, which is the distinction the whole panel exists to draw.
const Row = styled.button`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  margin-bottom: 4px;
  border-radius: 6px;
  border: 1px solid ${(p) => (p.$selectable ? 'var(--s2-accent)' : 'var(--s2-border)')};
  background: ${(p) => (p.$selectable ? 'var(--s2-panel-veil)' : 'transparent')};
  color: ${(p) => {
    if (p.$selectable) return 'var(--s2-text-strong)';
    // Undiscovered is the dimmest state on the panel and carries a dashed
    // border below: it is a rumour of a place, not a place.
    return p.$activated ? 'var(--s2-text-secondary)' : 'var(--s2-text-dim)';
  }};
  border-style: ${(p) => (p.$activated ? 'solid' : 'dashed')};
  cursor: ${(p) => (p.$selectable ? 'pointer' : 'default')};
  font: inherit;
  &:hover { background: ${(p) => (p.$selectable ? 'var(--s2-accent)' : 'transparent')};
            color: ${(p) => (p.$selectable ? 'var(--s2-on-accent)' : 'inherit')}; }
`;

const Why = styled.span`
  font-size: 0.78rem;
  color: var(--s2-text-dim);
  white-space: nowrap;
`;

const BossBadge = styled.span`
  font-size: 0.75rem;
  font-weight: 700;
  color: #ff4757;
  background: rgba(255, 71, 87, 0.15);
  border: 1px solid rgba(255, 71, 87, 0.5);
  padding: 2px 6px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  animation: pulse-boss 1.2s infinite ease-in-out;

  @keyframes pulse-boss {
    0% { transform: scale(1); opacity: 0.9; }
    50% { transform: scale(1.05); opacity: 1; box-shadow: 0 0 10px rgba(255, 71, 87, 0.6); }
    100% { transform: scale(1); opacity: 0.9; }
  }
`;

const Empty = styled.div`
  padding: 12px 0; color: var(--s2-text-dim); font-size: 0.92rem;
`;

// The message beside a row that cannot be chosen. An inert row with no
// explanation reads as a broken panel -- the same lesson the World Map's legend
// comment records.
const WHY_TEXT = {
  [REASON.YOU_ARE_HERE]: 'you are here',
  [REASON.NOT_DISCOVERED]: 'not discovered',
  // The KEY keeps its name (SOMET-300 renames what a player reads, not the
  // code); only the sentence changes.
  [REASON.NOT_ON_A_WAYPOINT]: 'stand on a portal',
};

export const WAYPOINTS_ERROR_TOAST_ID = 'waypoint-travel-error';

function useWaypoints(characterId) {
  const { data, error } = useQuery({
    // Keyed by character: activation is per character, so switching characters
    // must not show the previous one's lit network out of cache.
    queryKey: ['playerWaypoints', characterId],
    enabled: characterId != null,
    queryFn: async () => {
      const res = await apiFetch(
        `${API_URL}/api/player/waypoints?character_id=${encodeURIComponent(characterId)}`,
        { headers: authHeaders() },
      );
      if (!res.ok) throw new Error('Failed to load your portals');
      return res.json();
    },
  });
  useEffect(() => {
    if (error) toast.error(error.message, { id: WAYPOINTS_ERROR_TOAST_ID });
  }, [error]);
  return data;
}

export default function WaypointTravel({ gameRef, characterId }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [tab, setTab] = useState('main'); // 'main' | 'spire'
  const data = useWaypoints(characterId);
  const queryClient = useQueryClient();

  // T no longer opens this panel: it starts the teleport cast (Game.js). The
  // panel opens when that cast COMPLETES (setOnTeleportReady below), or on
  // stepping onto a portal (auto-open further down).
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; });

  // After a completed cast the server lets one trip start from anywhere, so
  // every lit portal is selectable for a while. The client only mirrors that to
  // draw the rows; the server re-checks its own ticket on the travel frame.
  const [teleportUntil, setTeleportUntil] = useState(0);
  useEffect(() => {
    const g = gameRef.current;
    if (!g || !g.setOnTeleportReady) return undefined;
    g.setOnTeleportReady((msg) => {
      setTeleportUntil(Date.now() + (Number(msg && msg.ticketMs) || 60000));
      setPos(g.getWaypointSnapshot ? g.getWaypointSnapshot() : null);
      setOpen(true);
    });
    return () => g.setOnTeleportReady(null);
  }, [gameRef]);
  const teleportReady = teleportUntil > Date.now();

  // Esc closes the panel instead of pausing the game. Capture phase, so it wins
  // over Game's own window keydown handler (bubble) -- copied from Minimap.jsx's
  // modal, where the same collision was found.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); setOpen(false); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  // Where the player is, polled only while the panel is up. Reading it during
  // render instead would make this component's output depend on a mutable object
  // React does not know about, so it would go stale the moment nothing else
  // re-rendered.
  useEffect(() => {
    if (!open) return undefined;
    const read = () => {
      const g = gameRef.current;
      setPos(g && g.getWaypointSnapshot ? g.getWaypointSnapshot() : null);
    };
    read();
    const id = setInterval(read, POSITION_POLL_MS);
    return () => clearInterval(id);
  }, [open, gameRef]);

  // AUTO-OPEN ON ARRIVAL (SOMET-300). Stepping onto the portal opens the list
  // without pressing anything -- the discoverability half of the ticket, since a
  // landmark whose only affordance is an unlabelled key is one nobody finds.
  //
  // Runs while the popup is CLOSED, which the position poll above deliberately
  // does not: that one exists to keep an OPEN panel's rows accurate. Slower than
  // it (a tile transition is a coarse event) so the closed-state cost stays
  // small.
  //
  // The latch lives in a ref, not in state: it changes on almost every reading
  // and re-rendering the panel for it would be pure waste.
  const prevTileRef = useRef(null);
  const prevWorldRef = useRef(null);
  // Set when the player picks a destination: the arrival that follows is the
  // result of a teleport, not of stepping onto a portal, so it must not pop the
  // list open again at the other end.
  const suppressUntilRef = useRef(0);
  useEffect(() => {
    const read = () => {
      const g = gameRef.current;
      const snap = g && g.getWaypointSnapshot ? g.getWaypointSnapshot() : null;
      const tile = portalTileOf(snap ? { x: snap.playerX, y: snap.playerY } : null);
      // Arriving in a different world is never "stepping onto" its portal: the
      // old world's tile means nothing there, so forget it and relatch.
      const worldNow = snap ? snap.worldId : null;
      if (worldNow !== prevWorldRef.current) {
        prevWorldRef.current = worldNow;
        prevTileRef.current = null;
      }
      if (Date.now() < suppressUntilRef.current) {
        prevTileRef.current = tile;
        return;
      }
      // The portal of the world the player is standing in, from the list the
      // popup already fetches -- not a second source of truth.
      const portal = (data && Array.isArray(data.waypoints) && snap)
        ? data.waypoints.find((w) => w.worldId === snap.worldId) || null
        : null;

      if (shouldAutoOpen({
        portal, worldId: snap ? snap.worldId : null, prevTile: prevTileRef.current, tile,
        isOpen: openRef.current,
      })) {
        setOpen(true);
        setPos(snap);   // so the first render has a position and does not flash "stand on a portal"
      }
      prevTileRef.current = tile;
    };
    read();
    const id = setInterval(read, ARRIVAL_POLL_MS);
    return () => clearInterval(id);
  }, [gameRef, data]);

  // A waypoint lighting up changes this list, and the server is the only thing
  // that knows it happened. Without this the player walks onto a waypoint and
  // the panel keeps calling it undiscovered until a reload -- the feature would
  // look broken at exactly the moment it worked.
  useEffect(() => {
    const g = gameRef.current;
    if (!g || !g.setOnWaypointActivated) return undefined;
    g.setOnWaypointActivated((msg) => {
      queryClient.invalidateQueries({ queryKey: ['playerWaypoints'] });
      // Announced once per waypoint, on the server's own `firstTime` (the
      // INSERT's rowCount) rather than on anything this client remembers -- a
      // relog would otherwise re-announce every waypoint walked over.
      if (msg && msg.firstTime && msg.waypoint) {
        toast.success(`Portal discovered: ${msg.waypoint.name}`);
      }
    });
    return () => g.setOnWaypointActivated(null);
  }, [gameRef, queryClient]);

  const travel = useCallback((waypointId) => {
    const g = gameRef.current;
    if (!g || !g.travelToWaypoint) return;
    // Closed immediately, on the REQUEST rather than on the answer: the answer
    // is a `transition` that tears this world down and rebuilds it, and a panel
    // still open across that reads as having failed. A refusal arrives as the
    // authority's own error toast, which is visible with the panel shut.
    setOpen(false);
    setTeleportUntil(0); // the server spends its ticket on this trip
    suppressUntilRef.current = Date.now() + 8000;
    g.travelToWaypoint(waypointId);
  }, [gameRef]);

  const g = gameRef.current;
  const bossStatus = g && g.getWorldBossStatus ? g.getWorldBossStatus() : null;

  const { standingOnActivated, groups } = buildTravelList({
    waypoints: data && data.waypoints,
    currentWorldId: pos ? pos.worldId : null,
    playerX: pos ? pos.playerX : null,
    playerY: pos ? pos.playerY : null,
    bossNearbyWaypointId: bossStatus ? bossStatus.nearestWaypointId : null,
    bossName: bossStatus ? bossStatus.bossName : null,
    bossWorldId: bossStatus ? bossStatus.worldId : null,
    teleportReady,
  });

  if (!open) return null;

  // The Spire's checkpoints live on their own tab so they do not push every
  // other portal off the screen.
  const tabs = splitTravelTabs(groups);
  const hasSpire = tabs.spire.length > 0;
  const activeTab = hasSpire ? tab : 'main';
  const shown = activeTab === 'spire' ? tabs.spire : tabs.main;
  // One click to the highest lit Spire checkpoint, when it can be taken now.
  const lastCheckpoint = activeTab === 'spire' ? lastSpireCheckpoint(tabs.spire) : null;

  return (
    <Backdrop onClick={() => setOpen(false)}>
      <Card onClick={(e) => e.stopPropagation()}>
        <CloseButton aria-label="Close travel" onClick={() => setOpen(false)}>×</CloseButton>
        <h2>Portals</h2>
        <p className="sub">
          {teleportReady
            ? 'Teleport ready — choose where to go.'
            : standingOnActivated
              ? 'Choose a portal you have lit.'
              : 'Stand on a portal you have lit to travel from it, or press T to cast a teleport.'}
        </p>
        {hasSpire && (
          <TabBar role="tablist">
            <TabButton type="button" role="tab" aria-selected={activeTab === 'main'} $active={activeTab === 'main'} onClick={() => setTab('main')}>
              Portals
            </TabButton>
            <TabButton type="button" role="tab" aria-selected={activeTab === 'spire'} $active={activeTab === 'spire'} onClick={() => setTab('spire')}>
              Spire of Trials
            </TabButton>
          </TabBar>
        )}
        {lastCheckpoint && (
          <LastButton
            type="button"
            disabled={!lastCheckpoint.selectable}
            onClick={() => lastCheckpoint.selectable && travel(lastCheckpoint.id)}
            title={lastCheckpoint.selectable ? 'Go to your highest Spire checkpoint' : 'Cast a teleport (T) to use this'}
          >
            ⏎ Last checkpoint: Floor {lastCheckpoint.floor}
          </LastButton>
        )}
        {shown.length === 0 && (
          <Empty>
            {activeTab === 'spire'
              ? 'No Spire checkpoints lit yet.'
              : 'You have not found any portals yet. Walk onto one to light it.'}
          </Empty>
        )}
        {shown.map((g) => (
          <div key={g.worldId}>
            <h3>{g.worldName}</h3>
            {g.entries.map((e) => (
              <Row
                key={e.id}
                type="button"
                $selectable={e.selectable}
                $activated={e.activated}
                // Disabled rather than merely unstyled: the rule has to hold for
                // a keyboard and for a screen reader too, not only for a mouse
                // that reads the colour.
                disabled={!e.selectable}
                aria-disabled={!e.selectable}
                onClick={() => e.selectable && travel(e.id)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>{e.name}</span>
                  {e.bossNearby && (
                    <BossBadge title={`World Boss: ${e.bossName || 'Active'}`}>
                      ⚔️ BOSS NEARBY
                    </BossBadge>
                  )}
                </div>
                {e.reason && <Why>{WHY_TEXT[e.reason]}</Why>}
              </Row>
            ))}
          </div>
        ))}
      </Card>
    </Backdrop>
  );
}
