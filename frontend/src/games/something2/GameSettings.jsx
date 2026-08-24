// frontend/src/games/something2/GameSettings.jsx
//
// SOMET-493 -- the in-game Settings panel, pinned directly below "How to play"
// in the same always-visible HUD stack.
//
// Two settings live here, and they are owned by two different things, which is
// the whole reason this component polls rather than holding local state for
// both:
//
//   Auto-loot   SERVER-owned. Every authority `state` frame overwrites
//               Game.autoLoot, so the checkbox must render from that mirror,
//               not from a local useState the server never agreed to. It used
//               to be a button drawn inside the canvas inventory panel; it is
//               a preference, not an inventory operation, and burying it
//               behind `i` made it something players had to be told about.
//
//   Inspect     CLIENT-owned. Persisted here in localStorage (the same
//               convention Minimap.jsx and CharacterSheet.jsx use for their
//               visibility) and pushed into the Game instance.
//
// The push is re-asserted on every poll tick rather than only in an effect on
// change. GameShell throws the Game instance away and builds a new one on a
// character switch (see `gameEpoch`), and a fresh Game starts with
// inspectEnabled false -- a change-only effect would leave the panel reading
// ON against an engine that had quietly reset to OFF.
import { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { HiOutlineCog6Tooth } from 'react-icons/hi2';

const LS_INSPECT = 'something2.settings.inspect';
// Matches CharacterSheet's own poll cadence. This reads two booleans off an
// in-memory object; there is nothing here worth a rAF subscription.
const POLL_MS = 500;

// Same shape as GameView's HowToButton, deliberately: these are one stack of
// controls and a second visual language for the middle item would read as a
// different kind of thing.
const SettingsButton = styled.button`
  position: absolute;
  top: 296px;
  right: 16px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid ${(p) => (p.$open ? 'var(--s2-accent)' : 'var(--s2-border)')};
  background: var(--s2-panel-veil);
  backdrop-filter: blur(8px);
  color: ${(p) => (p.$open ? 'var(--s2-accent)' : 'var(--s2-text)')};
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  pointer-events: auto;
  transition: background 0.15s, color 0.15s;

  svg { font-size: 16px; }
  &:hover { background: var(--s2-panel-veil-solid); color: var(--s2-accent); }
`;

// Anchored under the button rather than centred behind a scrim like the Help
// card: these are toggles you flip while looking at the world, and a
// full-screen backdrop would hide the very thing the inspect toggle changes.
const Panel = styled.div`
  position: absolute;
  top: 338px;
  right: 16px;
  z-index: 25;
  width: 288px;
  padding: 14px 16px 12px;
  border-radius: 12px;
  border: 1px solid var(--s2-border);
  background: var(--s2-panel-veil-solid);
  backdrop-filter: blur(10px);
  box-shadow: 0 8px 32px var(--s2-shadow);
  pointer-events: auto;

  h3 {
    margin: 0 0 2px;
    font-size: 14px;
    color: var(--s2-text-strong);
  }
  p.sub {
    margin: 0 0 12px;
    font-size: 11px;
    color: var(--s2-text-dim);
  }
`;

const Row = styled.label`
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 0;
  cursor: ${(p) => (p.$disabled ? 'not-allowed' : 'pointer')};
  opacity: ${(p) => (p.$disabled ? 0.5 : 1)};
  border-top: 1px solid var(--s2-border);

  &:first-of-type { border-top: none; }

  input {
    margin: 2px 0 0;
    width: 15px;
    height: 15px;
    accent-color: var(--s2-accent);
    cursor: inherit;
  }
  .label {
    font-size: 13px;
    font-weight: 600;
    color: var(--s2-text);
  }
  .hint {
    display: block;
    margin-top: 2px;
    font-size: 11px;
    font-weight: 400;
    line-height: 1.35;
    color: var(--s2-text-dim);
  }
`;

// Read once at module scope would be wrong (a second character switch must not
// re-read a stale value), so this is a function called from the initialiser.
// A browser with storage blocked throws on access rather than returning null,
// which would otherwise take the whole HUD down.
function readInspectPref() {
  try {
    return localStorage.getItem(LS_INSPECT) === '1';
  } catch {
    return false;
  }
}

export default function GameSettings({ gameRef }) {
  const [open, setOpen] = useState(false);
  const [inspect, setInspect] = useState(readInspectPref);
  // null = not in a playing world yet, so the controls render disabled rather
  // than claiming a state they cannot reach.
  const [autoLoot, setAutoLoot] = useState(null);

  // The poll needs the CURRENT preference without re-subscribing every time it
  // changes; the ref is that, and setInterval below depends only on gameRef.
  const inspectRef = useRef(inspect);
  useEffect(() => { inspectRef.current = inspect; });

  useEffect(() => {
    const tick = () => {
      const game = gameRef.current;
      const snap = game && game.getSettingsSnapshot ? game.getSettingsSnapshot() : null;
      setAutoLoot(snap ? snap.autoLoot : null);
      // Re-assert the client preference onto whatever Game instance is live
      // now. See the module header: a new instance starts OFF.
      if (snap && game.setInspectEnabled && snap.inspect !== inspectRef.current) {
        game.setInspectEnabled(inspectRef.current);
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [gameRef]);

  const toggleInspect = useCallback((next) => {
    setInspect(next);
    try {
      localStorage.setItem(LS_INSPECT, next ? '1' : '0');
    } catch {
      // Storage blocked (private window, site data off). The setting still
      // applies to this session; only its persistence is lost, and losing the
      // toggle entirely would be the worse failure.
    }
    const game = gameRef.current;
    if (game && game.setInspectEnabled) game.setInspectEnabled(next);
  }, [gameRef]);

  // Auto-loot is only mirrored locally if the intent actually reached the
  // server -- setAutoLoot returns false on a dead socket. The optimistic
  // update is kept so the checkbox moves before the next state frame lands.
  const toggleAutoLoot = useCallback((next) => {
    const game = gameRef.current;
    if (!game || !game.setAutoLoot) return;
    if (game.setAutoLoot(next)) setAutoLoot(next);
  }, [gameRef]);

  const inWorld = autoLoot !== null;

  return (
    <>
      <SettingsButton
        type="button"
        $open={open}
        title="Settings — auto-loot and hover inspect"
        aria-label="Settings"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <HiOutlineCog6Tooth /> Settings
      </SettingsButton>

      {open && (
        <Panel role="dialog" aria-label="Settings">
          <h3>Settings</h3>
          <p className="sub">Preferences for this character.</p>

          <Row $disabled={!inWorld}>
            <input
              type="checkbox"
              checked={autoLoot === true}
              disabled={!inWorld}
              onChange={(e) => toggleAutoLoot(e.target.checked)}
            />
            <span className="label">
              Auto-loot
              <span className="hint">
                Walk over items to collect them without pressing G.
              </span>
            </span>
          </Row>

          <Row>
            <input
              type="checkbox"
              checked={inspect}
              onChange={(e) => toggleInspect(e.target.checked)}
            />
            <span className="label">
              Inspect on hover
              <span className="hint">
                Hover anything in the world for a card describing it. Creatures
                also show their level, HP and MP bars, and how aggressive they
                are. Click to keep the card up while you read it.
              </span>
            </span>
          </Row>
        </Panel>
      )}
    </>
  );
}
