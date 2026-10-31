import { Component, useEffect, useMemo, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import styled from 'styled-components';
import CytoscapeComponent from 'react-cytoscapejs';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { authHeaders, apiFetch } from './src/js/net/auth.js';
import { toCytoscapeElements } from './playerWorldMap.js';
import { PULSE_PERIOD_MS } from './src/js/systems/landmarkRenderer.js';
import { API_URL } from '../../config.js';

// The player's read-only fog-of-war map (SOMET-263).
//
// IT IS A MAP, AND NOTHING ELSE (SOMET-293). It briefly also offered
// click-to-travel to any visited world flagged `allows_fast_travel`; travel is
// now the waypoint network, available only while standing on a waypoint you have
// lit, and the leg that authorized the old click has been deleted from
// services/joinPolicy.js. So this file registers no cytoscape event handler,
// asks nothing of the shell to put the player in a world, and routes nowhere --
// the capability is absent rather than disabled, for the same reason the editing
// capability below is. playerWorldMap.test.js asserts those absences by literal
// token against this file's source, which is why the names are spelled around
// rather than quoted here.
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

/* Fills its (position:relative) content area by absolute inset rather than
   `height: 100%`: a percentage height needs a definite parent height, and when
   the chain above this page had none the whole page collapsed to zero height
   and the tab rendered as an empty rectangle. The colour fallbacks keep the
   text readable if a theme token is missing. */
const Page = styled.div`
  position: absolute; inset: 0; box-sizing: border-box;
  padding: 2rem; color: var(--s2-text, #e5e7eb); overflow-y: auto;
  background-color: var(--s2-surface, #12121f);
`;
const Inner = styled.div`max-width: 1400px; margin: 0 auto;`;
const Header = styled.div`margin-bottom: 1rem;`;
const Title = styled.h2`margin: 0 0 0.25rem 0;`;
const Dim = styled.div`color: var(--s2-text-dim); font-size: 0.9em;`;
// Names the colour the canvas actually draws, so the legend cannot drift into
// describing a border the stylesheet stopped using.
// s2-theme-exempt(#facc15): matches the `current` node border below, which is a
// canvas literal for the reasons the CanvasCard comment gives.
const HereKey = styled.span`color: #facc15; font-weight: 600;`;
const CanvasCard = styled.div`
  /* A definite height of its own: cytoscape sizes its canvas to this box, and a
     box that is 0px tall draws nothing. */
  height: max(420px, calc(100vh - 260px)); min-height: 420px; position: relative;
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
const Retry = styled.button`
  margin-top: 0.75rem; padding: 6px 14px; border-radius: 6px; cursor: pointer;
  border: 1px solid #4a9eff; background: transparent; color: #4a9eff; font: inherit;
`;
const Spinner = styled.div`
  width: 28px; height: 28px; margin: 0 auto 0.75rem; border-radius: 50%;
  border: 3px solid #374151; border-top-color: #4a9eff;
  animation: pwm-spin 0.8s linear infinite;
  @keyframes pwm-spin { to { transform: rotate(360deg); } }
`;

export const PLAYER_MAP_ERROR_TOAST_ID = 'player-world-map-error';

// A throw while drawing the graph must not blank the tab: show what happened.
class MapBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error('[world map] render failed:', error); }
  render() {
    if (this.state.error) {
      return (
        <Empty>
          <div>
            <div>The map could not be drawn.</div>
            <Dim>{String(this.state.error && this.state.error.message || this.state.error)}</Dim>
            <Retry type="button" onClick={() => this.setState({ error: null })}>Try again</Retry>
          </div>
        </Empty>
      );
    }
    return this.props.children;
  }
}

function usePlayerWorldMap(characterId) {
  const { data, isLoading, error, refetch } = useQuery({
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
  return { data, isLoading, error, refetch };
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
  // SOMET-298: this world holds a waypoint or a portal. Presence only -- the
  // map is per-world granularity, so the badge says "there is one here", never
  // where. Listed BEFORE the `current` rule so "you are here" still wins the
  // border: knowing where you are outranks knowing a landmark is nearby, and
  // cytoscape resolves later matching rules over earlier ones.
  //
  // The pink is landmarkRenderer's portal colour; the two surfaces sharing a
  // hue is what makes the badge read as the same feature as the marker on the
  // ground. It cannot be imported here -- this stylesheet is a plain literal
  // and cytoscape draws to canvas -- so a drift between them is caught by the
  // spec, not by a type.
  {
    selector: 'node[landmarks = "true"]',
    style: { 'border-color': '#f472b6', 'border-width': 3 },
  },
  // The pulse. Cytoscape has no keyframes, so PlayerWorldMap toggles this class
  // on an interval; `pulse-off` is the dim half of the same beat.
  {
    selector: 'node[landmarks = "true"].pulse-off',
    style: { 'border-opacity': 0.3 },
  },
  // "You are here". The travel-offer border rule that used to sit above this one
  // went with click-to-travel (SOMET-293); nothing on this map is clickable now,
  // so there is no second border state to resolve against.
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
  const { activeCharacterId } = useOutletContext() || {};
  const { data, isLoading, error, refetch } = usePlayerWorldMap(activeCharacterId);
  const elements = useMemo(() => toCytoscapeElements(data), [data]);

  // Redraw hooks. Cytoscape measures its container once, when it is created;
  // opened on a tab that was laid out a moment later (or after a window resize)
  // it kept a 0x0 canvas and drew nothing. So: re-measure and fit the whole
  // graph when the data arrives, and again whenever the box changes size.
  const boxRef = useRef(null);
  const refit = () => {
    const cy = cyRef.current;
    if (!cy || cy.destroyed()) return;
    cy.resize();
    frameGraph(cy);
  };
  useEffect(() => {
    // After the card has its size (next frame), not during render.
    const id = requestAnimationFrame(refit);
    return () => cancelAnimationFrame(id);
  }, [elements]);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => refit());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // SOMET-298. Cytoscape has no keyframe animation, so the badge pulses by
  // toggling a class on a timer. Half of PULSE_PERIOD_MS, so this surface beats
  // at the same rate as the ground marker and the minimap -- one interval for
  // the whole graph, not one animation per node.
  //
  // Cleared on unmount: an interval holding a cy reference after the component
  // is gone keeps the whole graph alive and throws on a destroyed instance.
  const cyRef = useRef(null);
  useEffect(() => {
    const id = setInterval(() => {
      const cy = cyRef.current;
      if (!cy || cy.destroyed()) return;
      cy.nodes('[landmarks = "true"]').toggleClass('pulse-off');
    }, PULSE_PERIOD_MS / 2);
    return () => clearInterval(id);
  }, []);

  let body;
  if (activeCharacterId == null) {
    body = <Empty>Choose a character to see the places it has been.</Empty>;
  } else if (isLoading) {
    body = <Empty><div><Spinner />Loading the world map…</div></Empty>;
  } else if (error) {
    body = (
      <Empty>
        <div>
          <div>The world map could not be loaded.</div>
          <Retry type="button" onClick={() => refetch()}>Try again</Retry>
        </div>
      </Empty>
    );
  } else if (elements.length === 0) {
    body = <Empty>You have not been anywhere yet. Enter a world and it will appear here.</Empty>;
  } else {
    body = (
      <CytoscapeComponent
        elements={elements}
        stylesheet={STYLESHEET}
        style={{ width: '100%', height: '100%' }}
        layout={{ name: 'preset' }}
        userZoomingEnabled={true}
        userPanningEnabled={true}
        boxSelectionEnabled={false}
        // The switch that makes nodes immovable, and the reason this file needs
        // no drag-end listener to be safe. Verified against
        // react-cytoscapejs/src/patch.js, which lists autoungrabify among the
        // keys it patches straight onto the cy instance.
        autoungrabify={true}
        autounselectify={true}
        // The cy instance, for the badge pulse above. react-cytoscapejs calls
        // this once with the instance on mount.
        cy={(cy) => { cyRef.current = cy; requestAnimationFrame(() => { if (!cy.destroyed()) { cy.resize(); frameGraph(cy); } }); }}
      />
    );
  }

  return (
    <Page>
      <Inner>
      <Header>
        <Title>World Map</Title>
        <Dim>
          Only the worlds this character has entered. A dashed <code>?</code> is a
          way out you have not taken yet.
        </Dim>
        <Dim>
          The <HereKey>yellow</HereKey> world is where you are now. This map is a
          record, not a way to move: walk, take a doorway, or travel between
          portals you have lit (step onto one, or press <code>T</code>).
        </Dim>
      </Header>
      <CanvasCard ref={boxRef}><MapBoundary>{body}</MapBoundary></CanvasCard>
      </Inner>
    </Page>
  );
}

// The first view. Fitting EVERY visited world into the box is right while they
// are few and close together, but a character who has climbed the Spire has
// worlds thousands of units apart, and a whole-graph fit then shrinks the lot
// into unreadable specks. Below MIN_FIT_ZOOM we frame the world the character is
// standing in instead (the yellow one), at a zoom where labels can be read; the
// rest is a pan away.
export const MIN_FIT_ZOOM = 0.45;
export const FRAMED_ZOOM = 0.9;
function frameGraph(cy) {
  if (!cy || cy.destroyed() || cy.elements().length === 0) return;
  cy.fit(undefined, 40);
  if (cy.zoom() >= MIN_FIT_ZOOM) return;
  const here = cy.nodes('[current = "true"]');
  cy.zoom(FRAMED_ZOOM);
  cy.center(here.length ? here : cy.nodes().first());
}
