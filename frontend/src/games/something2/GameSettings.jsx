// frontend/src/games/something2/GameSettings.jsx
//
// SOMET-493 / SOMET-494 -- the in-game Settings panel with preferences and hotkey customization.
import { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { HiOutlineCog6Tooth } from 'react-icons/hi2';
import { DEFAULT_KEYBINDS } from './src/js/core/Game.js';
import { loadVolumes, saveVolumes, applyVolumeChange } from './src/js/audio/audioSettings.js';

const LS_INSPECT = 'something2.settings.inspect';
const LS_CONSTANT_ATTACK = 'something2.settings.constantAttack';
const LS_KEYBINDS = 'something2_keybinds';
const POLL_MS = 500;

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
  transition: background 0.15s, color 0.15s, border-color 0.15s;

  svg { font-size: 16px; }
  &:hover { background: var(--s2-panel-veil-solid); color: var(--s2-accent); }
`;

const Panel = styled.div`
  position: absolute;
  top: 338px;
  right: 16px;
  z-index: 25;
  width: 360px;
  max-height: 520px;
  display: flex;
  flex-direction: column;
  padding: 14px 16px 14px;
  border-radius: 14px;
  border: 1px solid var(--s2-border);
  background: var(--s2-panel-veil-solid);
  backdrop-filter: blur(12px);
  box-shadow: 0 12px 36px var(--s2-shadow);
  pointer-events: auto;

  h3 {
    margin: 0 0 2px;
    font-size: 15px;
    font-weight: 700;
    color: var(--s2-text-strong);
  }
  p.sub {
    margin: 0 0 10px;
    font-size: 11px;
    color: var(--s2-text-dim);
  }
`;

const Tabs = styled.div`
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--s2-border);
  padding-bottom: 6px;
`;

const TabButton = styled.button`
  background: ${(p) => (p.$active ? 'rgba(251, 191, 36, 0.15)' : 'transparent')};
  border: 1px solid ${(p) => (p.$active ? 'var(--s2-accent)' : 'transparent')};
  color: ${(p) => (p.$active ? 'var(--s2-accent)' : 'var(--s2-text-dim)')};
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;

  &:hover {
    color: var(--s2-text-strong);
    background: rgba(255, 255, 255, 0.05);
  }
`;

const TabContent = styled.div`
  overflow-y: auto;
  padding-right: 4px;
  max-height: 380px;

  &::-webkit-scrollbar {
    width: 6px;
  }
  &::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.15);
    border-radius: 3px;
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

const KeybindRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.06);

  &:first-of-type { border-top: none; }

  .label-group {
    display: flex;
    flex-direction: column;
  }
  .name {
    font-size: 12px;
    font-weight: 600;
    color: var(--s2-text);
  }
  .desc {
    font-size: 10px;
    color: var(--s2-text-dim);
  }
`;

const KeyButton = styled.button`
  min-width: 64px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid ${(p) => (p.$listening ? '#fbbf24' : 'var(--s2-border)')};
  background: ${(p) => (p.$listening ? 'rgba(251, 191, 36, 0.25)' : 'rgba(255, 255, 255, 0.06)')};
  color: ${(p) => (p.$listening ? '#fbbf24' : 'var(--s2-text-strong)')};
  font-size: 11px;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  text-align: center;
  transition: all 0.15s;
  box-shadow: ${(p) => (p.$listening ? '0 0 10px rgba(251, 191, 36, 0.4)' : 'none')};

  &:hover {
    background: ${(p) => (p.$listening ? 'rgba(251, 191, 36, 0.35)' : 'rgba(255, 255, 255, 0.12)')};
    border-color: var(--s2-accent);
  }

  &:focus {
    outline: none;
    border-color: #fbbf24;
  }
`;

const ResetButton = styled.button`
  margin-top: 12px;
  width: 100%;
  padding: 7px 12px;
  border-radius: 8px;
  border: 1px solid var(--s2-border);
  background: rgba(255, 255, 255, 0.04);
  color: var(--s2-text-dim);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;

  &:hover {
    background: rgba(239, 68, 68, 0.15);
    color: #f87171;
    border-color: rgba(239, 68, 68, 0.3);
  }
`;

function readPref(key) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writePref(key, on) {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // storage blocked
  }
}

function readKeybinds() {
  try {
    const raw = localStorage.getItem(LS_KEYBINDS);
    if (raw) {
      return { ...DEFAULT_KEYBINDS, ...JSON.parse(raw) };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_KEYBINDS };
}

function writeKeybinds(binds) {
  try {
    localStorage.setItem(LS_KEYBINDS, JSON.stringify(binds));
  } catch {
    // ignore
  }
}

export function formatKeyDisplay(keyStr) {
  if (!keyStr) return '—';
  const k = String(keyStr).toLowerCase();
  if (k === 'mouse1' || k === 'lmb') return 'LMB';
  if (k === 'mouse2' || k === 'rmb' || k === 'right' || k === 'right click') return 'RMB';
  if (k === 'mouse3' || k === 'mmb' || k === 'middle' || k === 'middle click') return 'MMB';
  if (k === ' ' || k === 'space' || k === 'spacebar') return 'SPACE';
  return k.toUpperCase();
}

const KEYBIND_DEFINITIONS = [
  { key: 'slot1', name: 'Skill Slot 1', desc: 'Hotkey for Hotbar Slot 1' },
  { key: 'slot2', name: 'Skill Slot 2', desc: 'Hotkey for Hotbar Slot 2' },
  { key: 'slot3', name: 'Skill Slot 3', desc: 'Hotkey for Hotbar Slot 3' },
  { key: 'slot4', name: 'Skill Slot 4', desc: 'Hotkey for Hotbar Slot 4' },
  { key: 'slot5', name: 'Skill Slot 5', desc: 'Hotkey for Hotbar Slot 5' },
  { key: 'slot6', name: 'Skill Slot 6', desc: 'Hotkey for Hotbar Slot 6' },
  { key: 'slot7', name: 'Skill Slot 7', desc: 'Hotkey for Hotbar Slot 7' },
  { key: 'slot8', name: 'Skill Slot 8', desc: 'Hotkey for Hotbar Slot 8' },
  { key: 'slot9', name: 'Skill Slot 9', desc: 'Hotkey for Hotbar Slot 9' },
  { key: 'inventory', name: 'Inventory', desc: 'Toggle Inventory & Equipment' },
  { key: 'character', name: 'Character Sheet', desc: 'Toggle Character Stats panel' },
  { key: 'passiveTree', name: 'Passive Skill Tree', desc: 'Toggle Passive Skill Graph' },
  { key: 'skills', name: 'Skills & Gems', desc: 'Open Skill Gems & Sockets panel' },
  { key: 'interact', name: 'Interact / Shop', desc: 'Interact with NPCs / Gem Merchant' },
  { key: 'bank', name: 'Bank / Stash', desc: 'Open Account Chest' },
  { key: 'openChest', name: 'Open Chest', desc: 'Open nearest world chest' },
  { key: 'pickup', name: 'Pick Up', desc: 'Pick up items from ground' },
];

export default function GameSettings({ gameRef }) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('general'); // 'general' | 'keybinds' | 'sound'
  const [inspect, setInspect] = useState(() => readPref(LS_INSPECT));
  const [constantAttack, setConstantAttack] = useState(() => readPref(LS_CONSTANT_ATTACK));
  const [autoLoot, setAutoLoot] = useState(null);
  const [keybinds, setKeybinds] = useState(() => readKeybinds());
  const [listeningAction, setListeningAction] = useState(null);
  const [volumes, setVolumesState] = useState(() => loadVolumes());

  const inspectRef = useRef(inspect);
  useEffect(() => { inspectRef.current = inspect; });
  const constantAttackRef = useRef(constantAttack);
  useEffect(() => { constantAttackRef.current = constantAttack; });
  const keybindsRef = useRef(keybinds);
  useEffect(() => { keybindsRef.current = keybinds; });

  useEffect(() => {
    const tick = () => {
      const game = gameRef.current;
      const snap = game && game.getSettingsSnapshot ? game.getSettingsSnapshot() : null;
      setAutoLoot(snap ? snap.autoLoot : null);
      if (snap && game.setInspectEnabled && snap.inspect !== inspectRef.current) {
        game.setInspectEnabled(inspectRef.current);
      }
      if (snap && game.setConstantAttack && snap.constantAttack !== constantAttackRef.current) {
        game.setConstantAttack(constantAttackRef.current);
      }
      if (game && game.setKeybinds && !listeningAction) {
        game.setKeybinds(keybindsRef.current);
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [gameRef, listeningAction]);

  const toggleInspect = useCallback((next) => {
    setInspect(next);
    writePref(LS_INSPECT, next);
    const game = gameRef.current;
    if (game && game.setInspectEnabled) game.setInspectEnabled(next);
  }, [gameRef]);

  const toggleConstantAttack = useCallback((next) => {
    setConstantAttack(next);
    writePref(LS_CONSTANT_ATTACK, next);
    const game = gameRef.current;
    if (game && game.setConstantAttack) game.setConstantAttack(next);
  }, [gameRef]);

  const toggleAutoLoot = useCallback((next) => {
    const game = gameRef.current;
    if (!game || !game.setAutoLoot) return;
    if (game.setAutoLoot(next)) setAutoLoot(next);
  }, [gameRef]);

  const applyNewKeybind = useCallback((actionKey, newBoundKey) => {
    setKeybinds((prev) => {
      const updated = { ...prev, [actionKey]: newBoundKey };
      writeKeybinds(updated);
      const game = gameRef.current;
      if (game && game.setKeybinds) game.setKeybinds(updated);
      return updated;
    });
    setListeningAction(null);
  }, [gameRef]);

  const resetKeybindsToDefault = useCallback(() => {
    setKeybinds({ ...DEFAULT_KEYBINDS });
    writeKeybinds({ ...DEFAULT_KEYBINDS });
    const game = gameRef.current;
    if (game && game.setKeybinds) game.setKeybinds({ ...DEFAULT_KEYBINDS });
  }, [gameRef]);

  // The updater itself stays pure (StrictMode-safe: double-invoking it is a
  // no-op). Persisting and pushing to the live engine happens in the effect
  // below, keyed off the committed `volumes` value, so two changeVolume
  // calls in the same tick (e.g. two sliders dragged before a re-render)
  // both land instead of the second silently reverting the first.
  const changeVolume = useCallback((field, value) => {
    setVolumesState((cur) => applyVolumeChange(cur, field, value));
  }, []);

  useEffect(() => {
    saveVolumes(volumes);
    const game = gameRef.current;
    if (game && game.audio) game.audio.setVolumes(volumes);
  }, [volumes, gameRef]);

  const inWorld = autoLoot !== null;

  return (
    <>
      <SettingsButton
        type="button"
        $open={open}
        title="Settings — preferences & hotkeys"
        aria-label="Settings"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <HiOutlineCog6Tooth /> Settings
      </SettingsButton>

      {open && (
        <Panel role="dialog" aria-label="Settings">
          <h3>Settings</h3>
          <p className="sub">Preferences & keybindings for this character.</p>

          <Tabs>
            <TabButton
              type="button"
              $active={activeTab === 'general'}
              onClick={() => { setActiveTab('general'); setListeningAction(null); }}
            >
              Preferences
            </TabButton>
            <TabButton
              type="button"
              $active={activeTab === 'keybinds'}
              onClick={() => setActiveTab('keybinds')}
            >
              Keybindings
            </TabButton>
            <TabButton
              type="button"
              $active={activeTab === 'sound'}
              onClick={() => { setActiveTab('sound'); setListeningAction(null); }}
            >
              Sound
            </TabButton>
          </Tabs>

          <TabContent>
            {activeTab === 'general' && (
              <>
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
                      Walk over items to collect them without pressing pickup key.
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
                      also show their level, HP/MP bars, and aggression.
                    </span>
                  </span>
                </Row>

                <Row>
                  <input
                    type="checkbox"
                    checked={constantAttack}
                    onChange={(e) => toggleConstantAttack(e.target.checked)}
                  />
                  <span className="label">
                    Constant attack
                    <span className="hint">
                      Hold the left mouse button to keep attacking continuously instead of clicking each time.
                    </span>
                  </span>
                </Row>
              </>
            )}

            {activeTab === 'keybinds' && (
              <>
                {KEYBIND_DEFINITIONS.map((def) => {
                  const currentBind = keybinds[def.key] ?? DEFAULT_KEYBINDS[def.key];
                  const isListening = listeningAction === def.key;
                  return (
                    <KeybindRow key={def.key}>
                      <div className="label-group">
                        <span className="name">{def.name}</span>
                        <span className="desc">{def.desc}</span>
                      </div>
                      <KeyButton
                        type="button"
                        $listening={isListening}
                        autoFocus={isListening}
                        onClick={(e) => {
                          if (!isListening) {
                            setListeningAction(def.key);
                          }
                        }}
                        onMouseDown={(e) => {
                          if (isListening) {
                            e.preventDefault();
                            e.stopPropagation();
                            const mouseMap = { 0: 'mouse1', 1: 'mouse3', 2: 'mouse2' };
                            const boundMouse = mouseMap[e.button] || `mouse${e.button + 1}`;
                            applyNewKeybind(def.key, boundMouse);
                          }
                        }}
                        onContextMenu={(e) => {
                          if (isListening) {
                            e.preventDefault();
                            e.stopPropagation();
                            applyNewKeybind(def.key, 'mouse2');
                          }
                        }}
                        onKeyDown={(e) => {
                          if (isListening) {
                            e.preventDefault();
                            e.stopPropagation();
                            if (e.key === 'Escape') {
                              setListeningAction(null);
                              return;
                            }
                            let keyVal = (e.key || '').toLowerCase();
                            if (keyVal === ' ') keyVal = 'space';
                            applyNewKeybind(def.key, keyVal);
                          }
                        }}
                        onBlur={() => {
                          if (isListening) {
                            setListeningAction(null);
                          }
                        }}
                        title={isListening ? "Press any key, mouse click (LMB/RMB/MMB), or Esc to cancel" : `Change hotkey for ${def.name}`}
                      >
                        {isListening ? '...' : formatKeyDisplay(currentBind)}
                      </KeyButton>
                    </KeybindRow>
                  );
                })}

                <ResetButton type="button" onClick={resetKeybindsToDefault}>
                  ↺ Reset Keybinds to Default
                </ResetButton>
              </>
            )}

            {activeTab === 'sound' && (
              <>
                <Row>
                  <input
                    type="checkbox"
                    checked={volumes.muted}
                    onChange={(e) => changeVolume('muted', e.target.checked)}
                  />
                  <span className="label">
                    Mute all audio
                    <span className="hint">
                      Silence music, ambience, and sound effects.
                    </span>
                  </span>
                </Row>

                <Row>
                  <span className="label" style={{ minWidth: 60 }}>
                    Master
                    <span className="hint">{Math.round(volumes.master * 100)}%</span>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={volumes.master}
                    onChange={(e) => changeVolume('master', e.target.value)}
                    style={{ flex: 1, width: '100%', height: 'auto' }}
                  />
                </Row>

                <Row>
                  <span className="label" style={{ minWidth: 60 }}>
                    Music
                    <span className="hint">{Math.round(volumes.music * 100)}%</span>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={volumes.music}
                    onChange={(e) => changeVolume('music', e.target.value)}
                    style={{ flex: 1, width: '100%', height: 'auto' }}
                  />
                </Row>

                <Row>
                  <span className="label" style={{ minWidth: 60 }}>
                    Ambience
                    <span className="hint">{Math.round(volumes.ambience * 100)}%</span>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={volumes.ambience}
                    onChange={(e) => changeVolume('ambience', e.target.value)}
                    style={{ flex: 1, width: '100%', height: 'auto' }}
                  />
                </Row>
              </>
            )}
          </TabContent>
        </Panel>
      )}
    </>
  );
}
