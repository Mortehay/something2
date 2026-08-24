// "2 passive points — press P". Shown only while points are unspent.
//
// WHY THIS EXISTS. SOMET-476 shipped the passive tree behind the P key and
// SOMET-483 put the point count on the character sheet behind C -- and neither
// key was in the How to play panel, so a player who levelled up held points
// with nothing in the game telling them the tree existed. The help rows fix the
// "where do I look it up" half; this fixes the "I never thought to look" half.
//
// It is a NUDGE, not a control: clicking it opens the tree, but its real job is
// to be visible without being asked. It removes itself the moment the points
// are spent, so a player who knows the game never sees it.
//
// READS ONLY. Game.progression has exactly one writer -- the websocket
// `progression` frame (see the F1 reasoning that CharacterSheet.jsx carried
// before SOMET-483 deleted it). This polls that value the way Minimap and
// GameSettings poll theirs; it must never assign to it.

import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { HiOutlineSparkles } from 'react-icons/hi2';
import { nudgeLabel } from './passivePointsLabel.js';

// Same cadence as GameSettings. The count changes only on level-up, allocate
// and respec, so nothing here needs to be frame-accurate.
const POLL_MS = 500;

// Sits directly below "Change character" in the same right-hand HUD stack:
// How to play (252) -> Settings -> Change character (340) -> this.
const Nudge = styled.button`
  position: absolute;
  top: 388px;
  right: 16px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-radius: 10px;
  /* Accent-bordered rather than a plain veil: this one is asking to be
     noticed, unlike its neighbours which are always present. */
  border: 1px solid var(--s2-accent);
  background: var(--s2-panel-veil);
  backdrop-filter: blur(8px);
  color: var(--s2-accent);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  pointer-events: auto;
  transition: background 0.15s, color 0.15s;

  svg { font-size: 16px; }
  &:hover { background: var(--s2-panel-veil-solid); }
`;

export default function PassivePointsNudge({ gameRef }) {
  const [points, setPoints] = useState(0);
  // STATE, not a ref. A ref cannot drive rendering, and the bug is subtler than
  // that: setPoints(2) when points is already 2 makes React bail out of the
  // re-render entirely, so a ref written in the same tick would never reach the
  // screen. Caught in a browser -- the nudge stayed visible over an open tree.
  const [treeOpen, setTreeOpen] = useState(false);

  useEffect(() => {
    const tick = () => {
      const game = gameRef.current;
      // `passivePoints` rides the progression frame (contract §6.7). A missing
      // value means "not known yet", which reads as 0 and shows nothing --
      // never as "some", which would flash a nudge on every join.
      const p = game && game.progression ? game.progression.passivePoints : 0;
      setPoints(Number.isFinite(Number(p)) ? Number(p) : 0);
      // Hide while the tree is open: the tree shows the count itself, and a
      // nudge pointing at the thing already on screen is noise.
      setTreeOpen(!!(game && game.passiveTreeOpen));
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [gameRef]);

  const label = nudgeLabel(points);
  if (!label || treeOpen) return null;

  return (
    <Nudge
      type="button"
      title="Open the passive skill tree"
      aria-label={label}
      onClick={() => { const g = gameRef.current; if (g && g.openPassiveTree) g.openPassiveTree(); }}
    >
      <HiOutlineSparkles /> {label}
    </Nudge>
  );
}
