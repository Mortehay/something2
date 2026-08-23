// frontend/src/games/something2/CharacterSheet.jsx
//
// In-game character sheet HUD (SOMET-242) -- follows Minimap.jsx's pattern:
// a styled.div overlay rendered from GameView when isPlaying, a keyboard
// toggle (C -- M is the minimap, confirmed unbound: see the task-10 report),
// visibility persisted to localStorage.
//
// F1/F2 (this revision) rewrote how progression/level-dependent numbers flow
// through this component; read the two header blocks below before touching
// either.
//
// --- F1: progression has exactly ONE writer now (Game's WS 'progression'
// handler); the HTTP allocate/respec response is no longer applied to it ---
//
// The original design (Task 10 + the D1 fix) wrote BOTH the HTTP allocate/
// respec response AND the websocket 'progression' push into Game.progression
// (the poll's source of truth). That is racy: the HTTP response travels over
// a brand-new per-request connection with NO ordering guarantee relative to
// a WS push sent moments earlier or later on the already-open socket. The
// browser pass reproduced it: click +CON, then (before the response lands) a
// kill's XP push arrives first and advances the player to level 2 -- the
// late, now-stale allocate response then overwrote Game.progression right
// back to the pre-kill level-1 snapshot, and nothing about the poll's own
// logic would ever self-heal that (F1).
//
// Fixed by removing the second writer, not by guessing an ordering predicate.
// A naive "only apply if experience increased" guard looks appealing but is
// actually wrong here: death LOWERS experience (the XP penalty), so a stale
// pre-death HTTP response could satisfy "experience >= cached" and clobber a
// correct post-death state instead -- same bug, inverted trigger. There is no
// single column on the row that is monotonic in general.
//
// What IS a true total order: server.js's refreshPlayerStats (wired by
// e77d929, actually reaching the live session as of bbab966) now pushes a
// `{type:'progression', progression, stats}` frame after EVERY successful
// allocate/respec, same message type, same single WebSocket connection kill
// XP and death already push through. One TCP connection preserves send
// order, so Game.onProgression (already an unconditional overwrite, already
// the only thing that touches this.progression) now sees every progression-
// affecting event in true causal order, with zero cross-channel races.
//
// The tradeoff, made explicit rather than hidden: the sheet's own display
// only updates once that WS push round-trips back, not directly from the
// HTTP response the click awaited (the `busy`-disabled state already covers
// the gap, and the WS push is issued server-side before the HTTP response is
// even sent, so in practice this lands within about one 500ms poll tick).
// `gold` has NO equivalent WS echo for a respec (refreshPlayerStats does not
// carry gold; only `wallet` messages do, and a respec never sends one), so it
// keeps being applied directly from the HTTP response below -- a residual,
// out-of-scope race against a concurrent item-pickup `wallet` push is called
// out in the task report rather than silently left undocumented.
//
// --- F2: xpFloor/xpToNext/respecCost come from the API, not a local copy ---
//
// A prior revision (xpCurve.js, now deleted) re-declared XP_BASE/MAX_LEVEL/
// RESPEC_BASE and re-implemented the backend's formulas. RESPEC_BASE was the
// one that actually bites: raise it on the backend and the button computes
// the OLD (lower) cost locally, shows itself as affordable/enabled, and every
// click 402s. GET /api/progression already returns xpFloor/xpToNext/
// respecCost for the caller's current level -- there is no reason to
// reimplement any of it.
//
// The wrinkle: those three numbers are a function of LEVEL, and progression
// (per F1 above) now only changes via the live poll/WS channel, not a
// refetch. So `levelInfo` is fetched once on open and again ONLY when
// `progression.level` actually changes -- a targeted, semantically-real
// refetch (a level-up is an event, not a no-op), not the no-op-push refetch
// Task 10 was required to avoid. That refetch's own `progression` field is
// deliberately discarded (see the effect below) so it can never become a
// third writer of Game's progression state.
//
// xpToNext is `Infinity` at max level on the backend (playerStats.js) but
// JSON has no `Infinity` -- it serialises as `null`. xpProgress() checks
// `Number.isFinite(toNext)` directly against whatever levelInfo.xpToNext
// holds (a number, or `null`), never coercing it through `Number(...)` first
// (that would turn `null` into `0` and silently divide by it).
import { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { fetchProgression, allocateStat, respec as respecRequest } from './src/js/net/progressionClient.js';

const LS_KEY = 'something2:characterSheetVisible';
const POLL_MS = 500; // live-push poll cadence; see the module header above

export const STAT_KEYS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const STAT_LABELS = {
  strength: 'STR', dexterity: 'DEX', constitution: 'CON',
  intelligence: 'INT', wisdom: 'WIS', charisma: 'CHA',
};

// Position inside the current level. `progression` needs only { experience }
// (the level itself doesn't matter to the arithmetic once `levelInfo` -- the
// API's own xpFloor/xpToNext for whatever level `progression` is currently
// at -- is supplied alongside it; see the F2 header block above for why this
// is no longer computed from a local xpFloor/xpToNext reimplementation).
//
// Two distinct "nothing to show yet" cases, deliberately not conflated:
//  - no `levelInfo` at all (still loading) -> an empty bar (into/need/pct
//    all 0), NOT "MAX LEVEL".
//  - `levelInfo` present but `xpToNext` is non-finite (a real `null` from
//    JSON, or an actual `Infinity` if ever called with an unserialised
//    value) -> genuinely max level: a full bar, nothing further needed.
export function xpProgress(progression, levelInfo) {
  const experience = (progression && progression.experience) || 0;
  if (!levelInfo) return { into: 0, need: 0, pct: 0 };
  const floor = typeof levelInfo.xpFloor === 'number' ? levelInfo.xpFloor : 0;
  const into = Math.max(0, experience - floor);
  const toNext = levelInfo.xpToNext; // a number, or null (JSON's encoding of Infinity)
  if (!Number.isFinite(toNext)) {
    return { into, need: 0, pct: 100 };
  }
  const need = toNext;
  const pct = need > 0 ? Math.round((into / need) * 100) : 0;
  return { into, need, pct };
}

// Pure predicate for the respec button: disabled whenever gold can't cover
// cost. Kept as a standalone export so it's testable at exact boundaries
// without mounting anything. `cost` must come from levelInfo.respecCost (the
// API's number) -- see F2 above; this function itself doesn't know or care
// where its `cost` argument came from, which is exactly why the bug was in
// the CALLER (a local RESPEC_BASE formula), not here.
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
  top: 20px;
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
  top: 20px;
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
  // { xpFloor, xpToNext, respecCost } for whatever level `progression` is
  // CURRENTLY at -- see the F2 header block. null until the first fetch
  // resolves.
  const [levelInfo, setLevelInfo] = useState(null);
  const [gold, setGold] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Which level `levelInfo` was fetched for, so the level-change effect
  // below only refetches when it's actually stale, not on every render.
  const levelInfoLevelRef = useRef(null);

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
      const isC = (e.key || '').toLowerCase() === 'c' || e.code === 'KeyC';
      if (!isC || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      persistVisible(!visibleRef.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [persistVisible]);

  // Bootstrap from the HTTP bundle the moment the sheet opens: seeds BOTH
  // `progression` (the only time this component fetches it directly -- from
  // here on `progression` is driven exclusively by the live-poll effect
  // below, per F1) and `levelInfo` (the API's own xpFloor/xpToNext/
  // respecCost for that level, per F2).
  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    fetchProgression()
      .then((bundle) => {
        if (cancelled || !bundle) return;
        if (bundle.progression) {
          setProgression(bundle.progression);
          levelInfoLevelRef.current = bundle.progression.level;
        }
        setLevelInfo({ xpFloor: bundle.xpFloor, xpToNext: bundle.xpToNext, respecCost: bundle.respecCost });
      })
      .catch((err) => { if (!cancelled) setError(err.message || 'failed to load progression'); });
    return () => { cancelled = true; };
  }, [visible]);

  // A live level-up (from a kill/death WS push, picked up by the poll below)
  // moves `progression.level` without refreshing the level-dependent
  // xpFloor/xpToNext/respecCost the bootstrap fetch above captured -- those
  // are now stale for the new level. This refetches ONLY when the level
  // actually changed (levelInfoLevelRef), which is a real event, not the
  // no-op-push case D1/Task 10 required this file not to refetch on.
  //
  // `bundle.progression` from THIS response is deliberately never applied --
  // progression has exactly one writer (Game's WS handler, per F1) and this
  // effect must not become a second one.
  //
  // `currentLevel` is hoisted out of `progression` so the dependency array
  // below is a single primitive, not a re-evaluated expression.
  const currentLevel = progression ? progression.level : null;
  useEffect(() => {
    if (!visible || currentLevel == null) return undefined;
    if (levelInfoLevelRef.current === currentLevel) return undefined;
    let cancelled = false;
    fetchProgression()
      .then((bundle) => {
        if (cancelled || !bundle) return;
        setLevelInfo({ xpFloor: bundle.xpFloor, xpToNext: bundle.xpToNext, respecCost: bundle.respecCost });
        levelInfoLevelRef.current = currentLevel;
      })
      .catch(() => { /* keep the previous levelInfo; the next level change retries */ });
    return () => { cancelled = true; };
  }, [visible, currentLevel]);

  // Poll the game's live snapshot for websocket-pushed updates (kill XP,
  // level-up, death, AND now allocate/respec -- see F1). Deliberately NOT a
  // refetch: Game already holds the latest pushed row locally (onProgression
  // is its only writer), so this just reads it back. progressionChanged
  // gates the setState so a stream of no-op pushes (zero-XP kills still push
  // a frame) causes no re-render.
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

  const handleAllocate = (statKey) => {
    if (busy || !progression || (progression.stat_points || 0) < 1) return;
    setBusy(true);
    setError(null);
    // F1: the response's `progression` is intentionally NOT applied to
    // anything here -- Game.onProgression (fed by the WS push
    // refreshLivePlayerStats now sends, e77d929/bbab966) is the sole writer,
    // and the poll effect above will pick the change up from there.
    allocateStat(statKey, 1)
      .catch((err) => setError(err.message || 'allocate failed'))
      .finally(() => setBusy(false));
  };

  const handleRespec = () => {
    if (busy || !progression || !levelInfo) return;
    const cost = levelInfo.respecCost;
    if (respecDisabled(gold, cost)) return;
    setBusy(true);
    setError(null);
    respecRequest()
      .then((bundle) => {
        // gold has no WS echo for a respec (refreshPlayerStats doesn't carry
        // it, and a respec never sends a `wallet` message) -- this is the
        // one field still applied directly from the HTTP response, both to
        // this component's own state AND (via applyGoldResult) to Game's
        // cache so the canvas-drawn gold HUD updates too. See the module
        // header for the residual, out-of-scope race this leaves against a
        // concurrent item-pickup wallet push.
        if (bundle && typeof bundle.gold === 'number') {
          setGold(bundle.gold);
          if (gameRef.current && gameRef.current.applyGoldResult) {
            gameRef.current.applyGoldResult(bundle.gold);
          }
        }
      })
      .catch((err) => setError(err.message || 'respec failed'))
      .finally(() => setBusy(false));
  };

  if (!visible) {
    return <ShowButton type="button" title="Show character sheet (C)" aria-label="Show character sheet" onClick={() => persistVisible(true)}>📜</ShowButton>;
  }

  const level = progression ? progression.level : 1;
  const { into, need, pct } = xpProgress(progression, levelInfo);
  const cost = levelInfo ? levelInfo.respecCost : null;
  const points = progression ? (progression.stat_points || 0) : 0;

  return (
    <Frame>
      <Header>
        <Title>Character Stats</Title>
        <HideButton type="button" title="Hide character sheet (C)" aria-label="Hide character sheet"
          onClick={() => persistVisible(false)}>×</HideButton>
      </Header>

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
        disabled={busy || !progression || !levelInfo || respecDisabled(gold, cost)}
        onClick={handleRespec}
      >
        {levelInfo ? `Respec (${cost}g)` : 'Respec'}
      </RespecButton>

      {error && <ErrorLine>{error}</ErrorLine>}
    </Frame>
  );
}
