import { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { authHeaders, apiFetch } from './src/js/net/auth.js';
import { buildTravelList, REASON } from './waypointTravel.js';
import { shouldAutoOpen, portalTileOf } from './portalAutoOpen.js';

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

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:13101';

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
  const data = useWaypoints(characterId);
  const queryClient = useQueryClient();

  // T opens the panel. Same guards as the minimap's M: no modifiers (they belong
  // to other bindings) and never while focus is in a text field.
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; });
  useEffect(() => {
    const onKey = (e) => {
      if (e.key.toLowerCase() !== 't' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      setOpen(!openRef.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
  useEffect(() => {
    const read = () => {
      const g = gameRef.current;
      const snap = g && g.getWaypointSnapshot ? g.getWaypointSnapshot() : null;
      const tile = portalTileOf(snap ? { x: snap.playerX, y: snap.playerY } : null);
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
    g.travelToWaypoint(waypointId);
  }, [gameRef]);

  if (!open) return null;

  const { standingOnActivated, groups } = buildTravelList({
    waypoints: data && data.waypoints,
    currentWorldId: pos ? pos.worldId : null,
    playerX: pos ? pos.playerX : null,
    playerY: pos ? pos.playerY : null,
  });

  return (
    <Backdrop onClick={() => setOpen(false)}>
      <Card onClick={(e) => e.stopPropagation()}>
        <CloseButton aria-label="Close travel" onClick={() => setOpen(false)}>×</CloseButton>
        <h2>Portals</h2>
        <p className="sub">
          {standingOnActivated
            ? 'Choose a portal you have lit.'
            : 'Stand on a portal you have lit to travel from it.'}
        </p>
        {groups.length === 0 && (
          <Empty>You have not found any portals yet. Walk onto one to light it.</Empty>
        )}
        {groups.map((g) => (
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
                <span>{e.name}</span>
                {e.reason && <Why>{WHY_TEXT[e.reason]}</Why>}
              </Row>
            ))}
          </div>
        ))}
      </Card>
    </Backdrop>
  );
}
