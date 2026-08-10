import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import styled from 'styled-components';
import CytoscapeComponent from 'react-cytoscapejs';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { authHeaders, apiFetch } from './src/js/net/auth.js';
import { toCytoscapeElements } from './playerWorldMap.js';

// The player's read-only fog-of-war map (SOMET-263).
//
// READ-ONLY BY CONSTRUCTION, not by a flag. The link-drawing plugin the admin
// graph registers is not imported here, and there is no mutation hook and no
// drag-end listener anywhere in this file -- a `readOnly` boolean can be true
// and still have an unguarded branch behind it, so the capability is absent
// rather than disabled. playerWorldMap.test.js asserts those absences against
// this file's source, by literal token, which is also why the names of the
// forbidden imports are spelled around rather than quoted in this comment.
//
// It reads the player endpoint below. The admin one returns every world
// unconditionally; pointing this component at it would render a complete map
// and defeat the whole feature while every other test still passed.

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:13101';

const Page = styled.div`
  padding: 2rem; color: var(--s2-text); max-width: 1400px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: var(--s2-surface);
`;
const Header = styled.div`margin-bottom: 1rem;`;
const Title = styled.h2`margin: 0 0 0.25rem 0;`;
const Dim = styled.div`color: var(--s2-text-dim); font-size: 0.9em;`;
// Names the colour the canvas actually draws, so the legend cannot drift into
// describing a border the stylesheet stopped using.
// s2-theme-exempt(#4ade80): matches the node border below, which is a canvas
// literal for the reasons the CanvasCard comment gives.
const TravelKey = styled.span`color: #4ade80; font-weight: 600;`;
const CanvasCard = styled.div`
  height: 600px;
  /* s2-theme-exempt(#12121f): the graph surface stays dark in both modes, like
     the game canvas. Cytoscape draws to a canvas and cannot read CSS custom
     properties, so its node label colour has to be a literal; against the light
     value of --s2-bg-sunken (rgb(236,236,243)) the light labels below were
     invisible and every visited world rendered as an unlabelled dot. Pinning
     the surface is the fix the theming spec left open for canvas widgets. */
  background: #12121f;
  border: 1px solid var(--s2-border); border-radius: 8px; overflow: hidden;
`;
const Empty = styled.div`
  display: flex; align-items: center; justify-content: center;
  /* Sits inside the pinned-dark CanvasCard, so it needs a light literal too --
     var(--s2-text-dim) is dark-on-dark there. */
  height: 100%; color: #9ca3af; /* s2-theme-exempt(#9ca3af): on the pinned-dark graph surface */
  text-align: center; padding: 2rem;
`;

// Same posture as the admin graph's own query hook: this one surfaces its error rather
// than trusting the call site to opt in, with a fixed toast id so a retrying
// query produces one message rather than a stack.
export const PLAYER_MAP_ERROR_TOAST_ID = 'player-world-map-error';

function usePlayerWorldMap(characterId) {
  const { data, isLoading, error } = useQuery({
    // Keyed by character: the fog is per character, so switching characters
    // must not show the previous one's map out of cache.
    queryKey: ['playerWorldMap', characterId],
    enabled: characterId != null,
    queryFn: async () => {
      const res = await apiFetch(
        `${API_URL}/api/player/world-map?character_id=${encodeURIComponent(characterId)}`,
        { headers: authHeaders() },
      );
      if (!res.ok) throw new Error('Failed to load the world map');
      return res.json();
    },
  });
  useEffect(() => {
    if (error) toast.error(error.message, { id: PLAYER_MAP_ERROR_TOAST_ID });
  }, [error]);
  return { data, isLoading, error };
}

/* s2-theme-exempt:start — cytoscape renders to canvas and cannot read CSS custom
   properties; theming it needs a getComputedStyle bridge plus forced re-render.
   Deliberately excluded, see docs/superpowers/specs/2026-07-31-something2-admin-light-mode-design.md */
const STYLESHEET = [
  {
    selector: 'node',
    style: {
      'background-color': '#23233f',
      'border-width': 1,
      'border-color': '#444',
      width: 56, height: 56,
      color: '#eee',
      'font-size': 11,
      'text-valign': 'bottom',
      'text-margin-y': 6,
      label: 'data(label)',
    },
  },
  // A stub is a world the character has never entered. Drawn hollow and dashed
  // so it reads as "there is a door here and you have not been through it"
  // rather than as a place with a missing label.
  {
    selector: 'node[unvisited = "true"]',
    style: {
      'background-color': '#1a1a2a',
      'border-color': '#6b7280',
      'border-style': 'dashed',
      color: '#9ca3af',
      width: 40, height: 40,
    },
  },
  // A world you can travel to. Visibly distinct from a visited world you
  // cannot, which is an acceptance criterion in its own right: an inert click
  // with no explanation reads as a broken map.
  {
    selector: 'node[travelable = "true"]',
    style: { 'border-color': '#4ade80', 'border-width': 3 },
  },
  // AFTER the travelable rule. The two cannot both be true today -- the
  // transform marks the current world un-travelable, since re-joining the world
  // you are standing in tears down a live session for nothing -- but cytoscape
  // resolves conflicts by declaration order, last one wins, and "you are here"
  // is the marker that must survive if that ever changes.
  {
    selector: 'node[current = "true"]',
    style: { 'border-color': '#facc15', 'border-width': 4 },
  },
  {
    selector: 'edge',
    style: { 'curve-style': 'straight', 'line-color': '#4a9eff', width: 2 },
  },
  {
    selector: 'edge[unvisited = "true"]',
    style: { 'line-color': '#6b7280', 'line-style': 'dashed' },
  },
];
/* s2-theme-exempt:end */

export default function PlayerWorldMap() {
  // The active character comes from GameShell, which owns it -- rather than
  // being re-read from localStorage here, which would be a second source of
  // truth free to disagree with the one the game canvas is using.
  const { activeCharacterId, enterWorld } = useOutletContext() || {};
  const { data, isLoading } = usePlayerWorldMap(activeCharacterId);
  const elements = useMemo(() => toCytoscapeElements(data), [data]);
  const navigate = useNavigate();

  // Travel is NAVIGATION, not editing. The read-only guards this component is
  // built on stay exactly as they are: no link-drawing plugin, no mutation
  // hook, no drag-end persist. Clicking a node asks GameShell to enter a world,
  // which is the same call the auto-join and the doorway transition already
  // make -- a second entry path that opened its own socket here is the
  // two-loader shape that has shipped inert features in this project before.
  const travelRef = useRef(null);
  const inFlight = useRef(false);
  travelRef.current = async (worldId) => {
    // Guarded by a ref, not by state: the cytoscape handler is registered once
    // against the instance and would close over the state value from the render
    // that registered it, so a `useState` flag would read stale forever.
    if (!enterWorld || inFlight.current) return;
    inFlight.current = true;
    try {
      // Only navigate on success. The authority's join policy can refuse
      // (unreachable world, character not yours), in which case enterWorld
      // returns false having already raised the server's message as a toast --
      // navigating anyway would land the player on a canvas that never
      // received `joined` and looks frozen.
      if (await enterWorld(worldId)) navigate('/game');
    } finally {
      inFlight.current = false;
    }
  };

  // Registered on the cy instance once. Delegated by selector, so it keeps
  // working across data refetches: cytoscape matches the selector at event
  // time, against whatever elements are present then.
  const cyRef = useRef(null);
  const registerCy = useCallback((cy) => {
    if (!cy || cyRef.current === cy) return;
    cyRef.current = cy;
    // The selector IS the gate on the client side: an unflagged or unvisited
    // world carries travelable:'false' and no handler ever fires for it. The
    // real gate is the server's -- see services/joinPolicy.js.
    cy.on('tap', 'node[travelable = "true"]', (evt) => {
      travelRef.current?.(evt.target.id());
    });
  }, []);

  let body;
  if (activeCharacterId == null) {
    body = <Empty>Choose a character to see the places it has been.</Empty>;
  } else if (isLoading) {
    body = <Empty>Loading…</Empty>;
  } else if (elements.length === 0) {
    body = <Empty>You have not been anywhere yet. Enter a world and it will appear here.</Empty>;
  } else {
    body = (
      <CytoscapeComponent
        elements={elements}
        stylesheet={STYLESHEET}
        style={{ width: '100%', height: '100%' }}
        layout={{ name: 'preset' }}
        cy={registerCy}
        userZoomingEnabled={true}
        userPanningEnabled={true}
        boxSelectionEnabled={false}
        // The switch that makes nodes immovable, and the reason this file needs
        // no drag-end listener to be safe. Verified against
        // react-cytoscapejs/src/patch.js, which lists autoungrabify among the
        // keys it patches straight onto the cy instance.
        autoungrabify={true}
        autounselectify={true}
      />
    );
  }

  return (
    <Page>
      <Header>
        <Title>World Map</Title>
        <Dim>
          Only the worlds this character has entered. A dashed <code>?</code> is a
          way out you have not taken yet.
        </Dim>
        <Dim>
          A <TravelKey>green</TravelKey> world is somewhere you can travel to —
          click it. Anywhere else you have to walk.
        </Dim>
      </Header>
      <CanvasCard>{body}</CanvasCard>
    </Page>
  );
}
