// Amber Stance, the Game wiring: ready once per arrival after the first drawn
// frame, input held while sealed, the first real input after ready breaks.
// Against a real Game with a recording fake authority client.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Game } from '../Game.js';
import { GAME_WIDTH, GAME_HEIGHT } from '../constants.js';

const realWindow = globalThis.window;
const realPerf = globalThis.performance;
let clock = 0;

function makeGame() {
  const g = new Game();
  g.state = 'playing';
  g.chunked = true;
  g.localUserId = 'me';
  g.player.x = 1000;
  g.player.y = 1000;
  g.canvas = {
    addEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: GAME_WIDTH, height: GAME_HEIGHT }),
    width: GAME_WIDTH, height: GAME_HEIGHT,
  };
  g.camera = { screenX: 0, screenY: 0, update: () => {} };
  g.chunkedMap = { isWalkable: () => true, speedAt: () => 1, biomeAt: () => null };
  g.streamer = { update: () => {}, isLoadedAt: () => true };
  g.creatures = { interpolate: () => {}, creatures: new Map(), applySnapshot: () => {} };
  g.projectiles = null;
  g._inputBuffer = [];
  g.frames = [];
  let seq = 0;
  g.authorityClient = {
    sendInput: (dx, dy, dt) => { seq++; g.frames.push({ type: 'input', dx, dy }); return { sent: true, seq, dx, dy, dt }; },
    sendAttack: () => g.frames.push({ type: 'attack' }),
    sendCastSkill: () => { g.frames.push({ type: 'castSkill' }); return true; },
    sendAmberReady: (arrival) => g.frames.push({ type: 'amberReady', arrival }),
    sendAmberBreak: (arrival) => g.frames.push({ type: 'amberBreak', arrival }),
    sendInteract: () => g.frames.push({ type: 'interact' }),
  };
  // initChunked finished: join answered, chunks loaded, preload waited.
  g._amberEntryReady = true;
  g.setupInput();
  return g;
}

const me = (over = {}) => ({ id: 'me', x: 1000, y: 1000, hp: 100, maxHp: 100, ...over });
const sealed = (a, ms = 27000) => me({ amber: { a, ms, v: null } });
const of = (g, type) => g.frames.filter((f) => f.type === type);
// One game-loop iteration as gameLoop runs it: update, draw, then the after-draw step.
function frame(g, dt = 0.05) {
  const pre = g._amberPrereqsMet();
  g.update(dt);
  if (pre) g._amberFrameDrawn();
}
const press = (g, key, code) => g._keydownHandler({ key, code, target: null });
const release = (g, key, code) => g._keyupHandler({ key, code, target: null });

beforeEach(() => {
  clock = 1000;
  globalThis.window = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  globalThis.performance = { now: () => clock };
});
afterEach(() => {
  globalThis.window = realWindow;
  globalThis.performance = realPerf;
});

describe('ready', () => {
  it('ready sent once per arrival', () => {
    const g = makeGame();
    g._onWorldState({ tick: 1, players: [sealed(7)] });
    frame(g);
    g._onWorldState({ tick: 2, players: [sealed(7, 26000)] });
    frame(g);
    frame(g);
    expect(of(g, 'amberReady')).toEqual([{ type: 'amberReady', arrival: 7 }]);
    g._onWorldState({ tick: 3, players: [sealed(8)] });
    frame(g);
    expect(of(g, 'amberReady').map((f) => f.arrival)).toEqual([7, 8]);
  });

  it('waits for a frame drawn after the first state frame', () => {
    const g = makeGame();
    frame(g); // drawn before any state frame
    expect(of(g, 'amberReady')).toHaveLength(0);
    g._onWorldState({ tick: 1, players: [sealed(3)] });
    expect(of(g, 'amberReady')).toHaveLength(0); // not drawn yet
    frame(g);
    expect(of(g, 'amberReady')).toHaveLength(1);
  });

  it('waits for the world entry and for the chunk under the player', () => {
    const g = makeGame();
    g._amberEntryReady = false;
    g._onWorldState({ tick: 1, players: [sealed(3)] });
    frame(g);
    expect(of(g, 'amberReady')).toHaveLength(0);
    g._amberEntryReady = true;
    g.streamer.isLoadedAt = () => false;
    frame(g);
    expect(of(g, 'amberReady')).toHaveLength(0);
    g.streamer.isLoadedAt = () => true;
    frame(g);
    expect(of(g, 'amberReady')).toHaveLength(1);
  });
});

describe('input hold', () => {
  it('held key during load does not break or move', () => {
    const g = makeGame();
    g._amberEntryReady = false; // still loading
    g._onWorldState({ tick: 1, players: [sealed(4)] });
    const x0 = g.player.x, y0 = g.player.y;
    press(g, 'd', 'KeyD');
    for (let i = 0; i < 5; i++) frame(g);
    expect(of(g, 'input')).toHaveLength(0);
    expect(of(g, 'amberBreak')).toHaveLength(0);
    expect(g.player.x).toBe(x0);
    expect(g.player.y).toBe(y0);
    // Loading finishes with the key STILL held: a key held since before ready
    // is not a fresh input, so it neither breaks nor moves.
    g._amberEntryReady = true;
    for (let i = 0; i < 5; i++) frame(g);
    expect(of(g, 'amberReady')).toHaveLength(1);
    expect(of(g, 'amberBreak')).toHaveLength(0);
    expect(of(g, 'input')).toHaveLength(0);
    expect(g.player.x).toBe(x0);
  });

  it('first input after ready breaks once', () => {
    const g = makeGame();
    g._onWorldState({ tick: 1, players: [sealed(9)] });
    frame(g);
    expect(of(g, 'amberReady')).toHaveLength(1);
    const x0 = g.player.x;
    press(g, 'w', 'KeyW');
    for (let i = 0; i < 5; i++) frame(g);
    expect(of(g, 'amberBreak')).toEqual([{ type: 'amberBreak', arrival: 9 }]);
    expect(of(g, 'input')).toHaveLength(0);
    expect(g.player.x).toBe(x0);
    // Still sealed in the next frame: still no input.
    g._onWorldState({ tick: 2, players: [sealed(9, 25000)] });
    frame(g);
    expect(of(g, 'input')).toHaveLength(0);
    expect(of(g, 'amberBreak')).toHaveLength(1);
    // The server ended it: the held key moves the player again.
    g._onWorldState({ tick: 3, players: [me()] });
    frame(g);
    expect(of(g, 'input').length).toBeGreaterThan(0);
    expect(of(g, 'amberBreak')).toHaveLength(1);
  });

  it('an attack click after ready breaks instead of attacking', () => {
    const g = makeGame();
    g._onWorldState({ tick: 1, players: [sealed(2)] });
    frame(g);
    g._mouseDownHandler({ button: 0, clientX: 900, clientY: 300, preventDefault: () => {} });
    expect(of(g, 'attack')).toHaveLength(0);
    expect(of(g, 'amberBreak')).toEqual([{ type: 'amberBreak', arrival: 2 }]);
    expect(g._attackHeld).toBe(false);
  });

  it('an attack click before ready neither attacks nor breaks', () => {
    const g = makeGame();
    g._onWorldState({ tick: 1, players: [sealed(2)] });
    g._mouseDownHandler({ button: 0, clientX: 900, clientY: 300, preventDefault: () => {} });
    expect(of(g, 'attack')).toHaveLength(0);
    expect(of(g, 'amberBreak')).toHaveLength(0);
  });

  it('a skill key after ready breaks instead of casting', () => {
    const g = makeGame();
    g.hotbarSkills.set(1, { id: 'test_bolt', type: 'magic', cost: 0, costType: 'mana', cooldown: 1 });
    g.unlockedSkills = new Set(['test_bolt']);
    g._onWorldState({ tick: 1, players: [sealed(6)] });
    frame(g);
    press(g, '1', 'Digit1');
    expect(of(g, 'castSkill')).toHaveLength(0);
    expect(of(g, 'amberBreak')).toEqual([{ type: 'amberBreak', arrival: 6 }]);
  });

  it('interaction keys do not break', () => {
    const g = makeGame();
    g._onWorldState({ tick: 1, players: [sealed(5)] });
    frame(g);
    press(g, 'i', 'KeyI');
    release(g, 'i', 'KeyI');
    expect(g.inventoryOpen).toBe(true);
    frame(g);
    press(g, 'i', 'KeyI');
    release(g, 'i', 'KeyI');
    // Typing into the chat box (an editable target) is not movement.
    g._keydownHandler({ key: 'w', code: 'KeyW', target: { tagName: 'INPUT', type: 'text' } });
    frame(g);
    frame(g);
    expect(of(g, 'amberBreak')).toHaveLength(0);
    expect(of(g, 'input')).toHaveLength(0);
  });

  it("an 'amber' refusal ends a held attack", () => {
    const g = makeGame();
    g._attackHeld = true;
    g._onAttackRefused({ reason: 'amber' });
    expect(g._attackHeld).toBe(false);
  });
});

describe('fade tracking', () => {
  it('records when amber leaves a player snapshot, and forgets it on a new seal', () => {
    const g = makeGame();
    g._onWorldState({ tick: 1, players: [sealed(1), { id: 'p2', x: 0, y: 0, amber: { a: 4, ms: 9000, v: 2 } }] });
    expect(g.remotePlayers.get('p2').amber).toEqual({ a: 4, ms: 9000, v: 2 });
    expect(g.player.amber).toEqual({ a: 1, ms: 27000, v: null });
    clock = 2000;
    g._onWorldState({ tick: 2, players: [me(), { id: 'p2', x: 0, y: 0 }] });
    expect(g.player.amber).toBe(null);
    expect(g._amberFades.get('me')).toEqual({ at: 2000, v: null });
    expect(g._amberFades.get('p2')).toEqual({ at: 2000, v: 2 });
    g._onWorldState({ tick: 3, players: [sealed(9)] });
    expect(g._amberFades.has('me')).toBe(false);
  });
});

describe('status visuals', () => {
  it('setStatusVisuals indexes the rows and loads approved sheets', () => {
    const g = makeGame();
    const loads = [];
    g.imageManager = { load: (k) => loads.push(k) };
    g.setStatusVisuals([
      { key: 'amber_stance_1', status_key: 'amber_stance', variant: 1, sprite_image: null },
      { key: 'amber_stance_2', status_key: 'amber_stance', variant: 2, sprite_image: 'status/a2.png', sprite_frames: 8 },
    ]);
    expect(Object.keys(g.statusVisuals)).toEqual(['amber_stance_1', 'amber_stance_2']);
    expect(loads).toEqual(['vfx:status/a2.png']);
  });
});
