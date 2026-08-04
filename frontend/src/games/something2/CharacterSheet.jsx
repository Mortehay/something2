// frontend/src/games/something2/CharacterSheet.jsx
//
// In-game character sheet HUD (SOMET-242) -- follows Minimap.jsx's pattern:
// a styled.div overlay rendered from GameView when isPlaying, a keyboard
// toggle (C -- M is the minimap, confirmed unbound: see the task-10 report),
// visibility persisted to localStorage.
//
// Data has two sources, deliberately not one:
//  - GET /api/progression (progressionClient.fetchProgression) bootstraps the
//    panel the moment it opens -- the authoritative bundle Tasks 1-9 already
//    built, including the server's own xpFloor/xpToNext/respecCost for the
//    level the player is AT right then.
//  - Game.getProgressionSnapshot() (gameRef) is polled afterwards for live
//    updates: the websocket 'progression' push (kill XP, level-up, death)
//    updates Game's own this.progression, and this component reads it back
//    without another HTTP round trip. The server pushes a frame even when
//    awarded XP is 0 (a trivial kill can floor to nothing), so every poll
//    tick is compared field-by-field (progressionChanged) and state is only
//    replaced when something actually moved -- a stream of no-op pushes
//    causes zero re-renders, not a flicker.
//
// xpFloor/xpToNext/respec cost cannot be re-fetched on every live push
// (that's the refetch this file is required not to do), so live recomputation
// after a level-up uses xpCurve.js's deliberate frontend reimplementation of
// the backend's formulas instead -- see that file's header for why importing
// the real backend module isn't possible (CJS/ESM split) and why duplicating
// three one-line formulas is an acceptable tradeoff.
import { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { fetchProgression, allocateStat, respec as respecRequest } from './src/js/net/progressionClient.js';
import { xpFloor, xpToNext, respecCost as computeRespecCost } from './src/js/core/xpCurve.js';

const LS_KEY = 'something2:characterSheetVisible';
const POLL_MS = 500; // live-push poll cadence; see the module header above

export const STAT_KEYS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const STAT_LABELS = {
  strength: 'STR', dexterity: 'DEX', constitution: 'CON',
  intelligence: 'INT', wisdom: 'WIS', charisma: 'CHA',
};

// Position inside the current level. `progression` needs only { level,
// experience } (the API bundle and the live push both satisfy that shape --
// the extra fields on each are simply ignored).
//
// At MAX_LEVEL, xpToNext() returns Infinity (playerStats.js) -- dividing by
// that would yield NaN, so the max-level case is handled explicitly: the bar
// reads as full (pct 100) with nothing further needed (need 0), rather than
// propagating a non-finite number into the render.
export function xpProgress(progression) {
  const level = (progression && progression.level) || 1;
  const experience = (progression && progression.experience) || 0;
  const floor = xpFloor(level);
  const into = Math.max(0, experience - floor);
  const toNext = xpToNext(level);
  if (!Number.isFinite(toNext)) {
    return { into, need: 0, pct: 100 };
  }
  const need = toNext;
  const pct = need > 0 ? Math.round((into / need) * 100) : 0;
  return { into, need, pct };
}

// Pure predicate for the respec button: disabled whenever gold can't cover
// cost. Kept as a standalone export so it's testable at exact boundaries
// without mounting anything.
export function respecDisabled(gold, cost) {
  return !(Number(gold) >= Number(cost));
}

// The fields a 'progression' row can actually change across a poll tick.
// Anything else on the object (user_id, ...) is not display-relevant here.
const PROGRESSION_FIELDS = ['experience', 'level', 'stat_points', ...STAT_KEYS];

// True when `next` differs from `prev` in any field that matters to this
// panel. A fresh object with IDENTICAL values (the zero-XP no-op push) must
// compare equal here -- that's what keeps a stream of no-op pushes from
// causing a re-render.
export function progressionChanged(prev, next) {
  if (!next) return false;
  if (!prev) return true;
  return PROGRESSION_FIELDS.some((k) => prev[k] !== next[k]);
}

// SOMET-242 D1 fix. The allocate/respec POST response body already carries
// the new authoritative row -- this just picks it out. `response.progression`
// unconditionally wins over `prevProgression` (an HTTP 200 here IS the new
// truth; there is nothing to compare it against). Extracted as a pure
// function so the "does a successful mutation actually change what's
// displayed" half of D1 is directly testable without mounting the component.
//
// On its own this is not the whole fix: see Game.applyProgressionResult
// below for the other half (keeping Game's own cache in sync so the live
// poll doesn't echo the pre-mutation row straight back over this).
export function applyMutationResponse(prevProgression, response) {
  return (response && response.progression) ? response.progression : prevProgression;
}

// SOMET-242 D2 fix: this used to sit at top:20/left:20, directly on top of
// RenderSystem's canvas-drawn HUD block (HP/MP/SP/Gold/Weapon/[i] Inventory
// hint), which is ALSO pinned to the canvas's top-left corner -- opening the
// sheet hid the player's own HP bar, including mid-combat. Top-right is
// already claimed by the fullscreen toggle, Minimap and the How-to-play
// button (GameView.jsx, all right:16 at various `top`s). Bottom-left is the
// one corner nothing else -- canvas-drawn or DOM -- occupies: the toast is
// bottom-CENTER only, and the inventory/shop panels are centered and only
// visible while open.
const Frame = styled.div`
  position: absolute;
  bottom: 20px;
  left: 20px;
  z-index: 20;
  width: 260px;
  border-radius: 12px;
  border: 1px solid #2e2e3e;
  background: rgba(15, 15, 26, 0.85);
  backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
  color: #eee;
  padding: 14px;
  pointer-events: auto;
  font-size: 13px;
`;

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
`;

const Title = styled.div`
  font-weight: 700;
  color: #fff;
`;

const HideButton = styled.button`
  width: 20px;
  height: 20px;
  border-radius: 6px;
  border: 1px solid #2e2e3e;
  background: rgba(26, 26, 46, 0.85);
  color: #aaa;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  &:hover { color: #fff; }
`;

const ShowButton = styled.button`
  position: absolute;
  bottom: 20px;
  left: 20px;
  z-index: 20;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  border: 1px solid #2e2e3e;
  background: rgba(26, 26, 46, 0.8);
  backdrop-filter: blur(8px);
  color: #e6e6f0;
  cursor: pointer;
  pointer-events: auto;
  &:hover { color: #4a9eff; }
`;

const BarTrack = styled.div`
  width: 100%;
  height: 10px;
  border-radius: 5px;
  background: #1f1f35;
  border: 1px solid #2e2e3e;
  overflow: hidden;
  margin-bottom: 4px;
`;

const BarFill = styled.div`
  height: 100%;
  background: #4a9eff;
  width: ${(p) => p.$pct}%;
  transition: width 0.2s ease-out;
`;

const XpLabel = styled.div`
  color: #aaa;
  font-size: 11px;
  margin-bottom: 12px;
`;

const StatRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 0;
`;

const StatLabel = styled.span`
  color: #ccc;
  width: 40px;
`;

const StatValue = styled.span`
  color: #fff;
  font-weight: 600;
  width: 28px;
  text-align: right;
`;

const PlusButton = styled.button`
  width: 22px;
  height: 22px;
  border-radius: 6px;
  border: 1px solid #2e2e3e;
  background: #3b82f6;
  color: #fff;
  font-weight: 700;
  cursor: pointer;
  &:hover { filter: brightness(1.1); }
  &:disabled { background: #555; cursor: not-allowed; }
`;

const PointsLine = styled.div`
  margin: 10px 0 6px 0;
  color: #facc15;
  font-size: 12px;
`;

const RespecButton = styled.button`
  width: 100%;
  margin-top: 8px;
  padding: 8px;
  border-radius: 6px;
  border: none;
  background: #ef4444;
  color: #fff;
  font-weight: 600;
  cursor: pointer;
  &:hover { filter: brightness(1.1); }
  &:disabled { background: #555; cursor: not-allowed; }
`;

const ErrorLine = styled.div`
  margin-top: 8px;
  color: #f87171;
  font-size: 11px;
`;

export default function CharacterSheet({ gameRef }) {
  const [visible, setVisible] = useState(() => localStorage.getItem(LS_KEY) !== '0');
  const [progression, setProgression] = useState(null);
  const [gold, setGold] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const persistVisible = useCallback((v) => {
    setVisible(v);
    localStorage.setItem(LS_KEY, v ? '1' : '0');
  }, []);

  // C toggles the character sheet. Ignore when a modifier is held, or focus
  // is in a text field -- same guards Minimap.jsx uses for M.
  const visibleRef = useRef(visible);
  useEffect(() => { visibleRef.current = visible; });
  useEffect(() => {
    const onKey = (e) => {
      if (e.key.toLowerCase() !== 'c' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      persistVisible(!visibleRef.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [persistVisible]);

  // Bootstrap from the HTTP bundle the moment the sheet opens. This is the
  // "preferred: take it from the API response" path for xpFloor/xpToNext;
  // subsequent live pushes are handled by the poll effect below without
  // hitting this endpoint again.
  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    fetchProgression()
      .then((bundle) => { if (!cancelled && bundle && bundle.progression) setProgression(bundle.progression); })
      .catch((err) => { if (!cancelled) setError(err.message || 'failed to load progression'); });
    return () => { cancelled = true; };
  }, [visible]);

  // Poll the game's live snapshot for websocket-pushed updates (kill XP,
  // level-up, death). Deliberately NOT a refetch: Game already holds the
  // latest pushed row locally (see Game.js onProgression), so this just
  // reads it back. progressionChanged gates the setState so a stream of
  // no-op pushes (zero-XP kills still push a frame) causes no re-render.
  useEffect(() => {
    if (!visible) return undefined;
    const tick = () => {
      const snap = gameRef.current && gameRef.current.getProgressionSnapshot
        ? gameRef.current.getProgressionSnapshot() : null;
      if (!snap) return;
      setGold((g) => (g === snap.gold ? g : snap.gold));
      setProgression((prev) => (progressionChanged(prev, snap.progression) ? snap.progression : prev));
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [visible, gameRef]);

  // D1 fix: applying the response to React state alone is not enough. Game
  // keeps its own cached this.progression/this.gold (read by the poll effect
  // above via getProgressionSnapshot), and an HTTP-only mutation never told
  // Game about it -- so the very next poll tick compared this fresh state
  // against Game's still-stale cache, saw a "difference", and reverted the
  // panel right back to the pre-allocation numbers. gameRef.current is
  // written through here so Game's cache and the sheet's state agree from
  // this point on; the poll then sees no diff and leaves it alone.
  const applyMutation = (bundle) => {
    setProgression((prev) => applyMutationResponse(prev, bundle));
    if (bundle && typeof bundle.gold === 'number') setGold(bundle.gold);
    if (gameRef.current && gameRef.current.applyProgressionResult) {
      gameRef.current.applyProgressionResult(bundle);
    }
  };

  const handleAllocate = (statKey) => {
    if (busy || !progression || (progression.stat_points || 0) < 1) return;
    setBusy(true);
    setError(null);
    allocateStat(statKey, 1)
      .then((bundle) => applyMutation(bundle))
      .catch((err) => setError(err.message || 'allocate failed'))
      .finally(() => setBusy(false));
  };

  const handleRespec = () => {
    if (busy || !progression) return;
    const cost = computeRespecCost(progression.level);
    if (respecDisabled(gold, cost)) return;
    setBusy(true);
    setError(null);
    respecRequest()
      .then((bundle) => applyMutation(bundle))
      .catch((err) => setError(err.message || 'respec failed'))
      .finally(() => setBusy(false));
  };

  if (!visible) {
    return <ShowButton type="button" title="Show character sheet (C)" aria-label="Show character sheet" onClick={() => persistVisible(true)}>📜</ShowButton>;
  }

  const level = progression ? progression.level : 1;
  const { into, need, pct } = xpProgress(progression || { level: 1, experience: 0 });
  const cost = computeRespecCost(level);
  const points = progression ? (progression.stat_points || 0) : 0;

  return (
    <Frame>
      <Header>
        <Title>Level {level}</Title>
        <HideButton type="button" title="Hide character sheet (C)" aria-label="Hide character sheet"
          onClick={() => persistVisible(false)}>×</HideButton>
      </Header>

      <BarTrack><BarFill $pct={pct} /></BarTrack>
      <XpLabel>{need > 0 ? `${into} / ${need} XP` : 'MAX LEVEL'}</XpLabel>

      {STAT_KEYS.map((key) => (
        <StatRow key={key}>
          <StatLabel>{STAT_LABELS[key]}</StatLabel>
          <StatValue>{progression ? progression[key] : '-'}</StatValue>
          <PlusButton
            type="button"
            aria-label={`Allocate ${STAT_LABELS[key]}`}
            disabled={busy || points < 1}
            onClick={() => handleAllocate(key)}
          >+</PlusButton>
        </StatRow>
      ))}

      <PointsLine>Unspent points: {points}</PointsLine>

      <RespecButton
        type="button"
        disabled={busy || !progression || respecDisabled(gold, cost)}
        onClick={handleRespec}
      >
        Respec ({cost}g)
      </RespecButton>

      {error && <ErrorLine>{error}</ErrorLine>}
    </Frame>
  );
}
