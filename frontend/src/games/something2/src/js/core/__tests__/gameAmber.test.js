// Amber Stance, the Game wiring: ready once per arrival after the first drawn
// frame, input held while sealed, the first real input after ready breaks.
// Against a real Game with a recording fake authority client.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Game } from '../Game.js';
import { GAME_WIDTH, GAME_HEIGHT } from '../constants.js';
import { TEXTURES_QUIET_MS } from '../../managers/ImageManager.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const realWindow = globalThis.window;
const realPerf = globalThis.performance;
let clock = 0;

function makeGame() {
  const g = new Game();
  // Nothing requested: the textures go quiet TEXTURES_QUIET_MS after construction.
  clock += TEXTURES_QUIET_MS;
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
  // GET /api/status-visuals, recorded; answers with g.svRows (never the network).
  g.svFetches = 0;
  g.svRows = [];
  g._fetchStatusVisuals = () => { g.svFetches++; return Promise.resolve(g.svRows); };
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

  // Final review I1: ready must not go out while the "Loading textures…" chip
  // is still up -- both read ImageManager.isQuiet (nothing pending for 1 s).
  it('waits for the textures to go quiet (the same rule as the loading chip)', () => {
    const g = makeGame();
    globalThis.Image = class { set src(v) { this._src = v; g._imgs.push(this); } };
    g._imgs = [];
    try {
      g.imageManager.load('late-sprite', '/late.png');
      g._onWorldState({ tick: 1, players: [sealed(5)] });
      frame(g);
      expect(of(g, 'amberReady')).toHaveLength(0); // still pending
      g._imgs[0].onload();                          // settles at `clock`
      clock += 999;
      frame(g);
      expect(of(g, 'amberReady')).toHaveLength(0); // pending 0, but not for 1 s yet
      clock += 1;
      frame(g);
      expect(of(g, 'amberReady')).toEqual([{ type: 'amberReady', arrival: 5 }]);
    } finally {
      delete globalThis.Image;
    }
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

describe('fix round 1', () => {
  it('a rejoin sealed with the SAME arrival id (authority restart) sends ready again and can break', () => {
    const g = makeGame();
    g._onWorldState({ tick: 1, players: [sealed(7)] });
    frame(g);
    expect(of(g, 'amberReady')).toHaveLength(1);
    // Socket lost, authority restarted, the reconnect's join is answered and
    // the new seal happens to reuse arrival 7.
    g._amberOnJoined();
    g._onWorldState({ tick: 1, players: [sealed(7)] });
    frame(g);
    expect(of(g, 'amberReady').map((f) => f.arrival)).toEqual([7, 7]);
    press(g, 'w', 'KeyW');
    frame(g);
    expect(of(g, 'amberBreak')).toEqual([{ type: 'amberBreak', arrival: 7 }]);
  });

  it('every answered join (first entry and reconnect) runs _amberOnJoined', () => {
    // The onJoined closure lives inside initChunked and serves the reconnect
    // path too (same client object); a source check is the only seam to it.
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../Game.js'), 'utf8');
    expect(src).toMatch(/onJoined: \(msg\) => \{\s*settled = true;\s*this\._amberOnJoined\(\);/);
  });

  it('a rejoin also forgets a break already sent for that arrival id', () => {
    const g = makeGame();
    g._onWorldState({ tick: 1, players: [sealed(7)] });
    frame(g);
    press(g, 'w', 'KeyW');
    frame(g);
    release(g, 'w', 'KeyW');
    expect(of(g, 'amberBreak')).toHaveLength(1);
    g._amberOnJoined();
    expect(g.amber).toBe(null);
    g._onWorldState({ tick: 1, players: [sealed(7)] });
    frame(g);
    press(g, 'w', 'KeyW');
    frame(g);
    expect(of(g, 'amberBreak')).toHaveLength(2);
  });

  it('a ready the socket dropped (send returned false) is retried on the next drawn frame', () => {
    const g = makeGame();
    let fail = true;
    g.authorityClient.sendAmberReady = (arrival) => {
      if (fail) { fail = false; return false; }
      g.frames.push({ type: 'amberReady', arrival });
      return true;
    };
    g._onWorldState({ tick: 1, players: [sealed(3)] });
    frame(g);
    expect(of(g, 'amberReady')).toHaveLength(0);
    frame(g);
    expect(of(g, 'amberReady')).toEqual([{ type: 'amberReady', arrival: 3 }]);
    frame(g);
    expect(of(g, 'amberReady')).toHaveLength(1);
  });

  it('a dropped break is retried by the next fresh press', () => {
    const g = makeGame();
    let fail = true;
    g.authorityClient.sendAmberBreak = (arrival) => {
      if (fail) { fail = false; return false; }
      g.frames.push({ type: 'amberBreak', arrival });
      return true;
    };
    g._onWorldState({ tick: 1, players: [sealed(3)] });
    frame(g);
    press(g, 'w', 'KeyW');
    frame(g);
    expect(of(g, 'amberBreak')).toHaveLength(0);
    release(g, 'w', 'KeyW');
    frame(g);
    press(g, 'w', 'KeyW');
    frame(g);
    expect(of(g, 'amberBreak')).toEqual([{ type: 'amberBreak', arrival: 3 }]);
  });
});

// Final review M4: a running game keeps the status-visuals list it entered
// with. A snapshot naming a variant it has no approved sheet for refetches the
// list (bounded: one request in flight, a minimum gap, never again for a
// variant the server's own answer lacked); the fallback draws meanwhile.
describe('unknown amber variant refetches status visuals', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  // Sheets are not drawn here: loading one is a no-op.
  const mk = () => { const g = makeGame(); g.imageManager.load = () => Promise.resolve(); return g; };
  const APPROVED_3 = { key: 'amber_stance_3', variant: 3, sprite_image: 'status/a3.png', sprite_frames: 8, sprite_fps: 10 };

  it('a variant missing from the list refetches once; the fresh row is indexed', async () => {
    const g = mk();
    g.svRows = [APPROVED_3];
    g._onWorldState({ tick: 1, players: [me({ amber: { a: 1, ms: 9000, v: 3 } })] });
    g._onWorldState({ tick: 2, players: [me({ amber: { a: 1, ms: 8900, v: 3 } })] }); // in flight: no second request
    expect(g.svFetches).toBe(1);
    await flush();
    expect(g.statusVisuals.amber_stance_3).toEqual(APPROVED_3);
    clock += 120000;
    g._onWorldState({ tick: 3, players: [me({ amber: { a: 1, ms: 8800, v: 3 } })] });
    expect(g.svFetches).toBe(1); // now known: nothing to fetch
  });

  it('a remote player\'s variant counts too, and a row without a sprite is unknown', async () => {
    const g = mk();
    g.setStatusVisuals([{ key: 'amber_stance_3', variant: 3, sprite_image: null }]);
    g._onWorldState({ tick: 1, players: [me(), { id: 'p2', x: 0, y: 0, amber: { a: 4, ms: 9000, v: 3 } }] });
    expect(g.svFetches).toBe(1);
  });

  it('a variant the server still lacks is not asked for again (no loop)', async () => {
    const g = mk();
    g.svRows = []; // the server has nothing approved for it either
    for (let i = 0; i < 5; i++) {
      g._onWorldState({ tick: i, players: [me({ amber: { a: 1, ms: 9000, v: 7 } })] });
      await flush();
      clock += 120000;
    }
    expect(g.svFetches).toBe(1);
  });

  it('different unknown variants are spaced by the minimum gap', async () => {
    const g = mk();
    g._onWorldState({ tick: 1, players: [me({ amber: { a: 1, ms: 9000, v: 5 } })] });
    await flush();
    g._onWorldState({ tick: 2, players: [me({ amber: { a: 2, ms: 9000, v: 6 } })] });
    await flush();
    expect(g.svFetches).toBe(1);
    clock += 30000;
    g._onWorldState({ tick: 3, players: [me({ amber: { a: 2, ms: 9000, v: 6 } })] });
    expect(g.svFetches).toBe(2);
  });

  it('a null variant or a known approved one never fetches; a failed fetch is not fatal', async () => {
    const g = mk();
    g.setStatusVisuals([APPROVED_3]);
    g._onWorldState({ tick: 1, players: [me({ amber: { a: 1, ms: 9000, v: null } })] });
    g._onWorldState({ tick: 2, players: [me({ amber: { a: 1, ms: 9000, v: 3 } })] });
    expect(g.svFetches).toBe(0);
    g._fetchStatusVisuals = () => { g.svFetches++; return Promise.reject(new Error('offline')); };
    g._onWorldState({ tick: 3, players: [me({ amber: { a: 1, ms: 9000, v: 9 } })] });
    await flush();
    expect(g.svFetches).toBe(1);
    expect(g.statusVisuals.amber_stance_3).toEqual(APPROVED_3); // the list it had is kept
    clock += 30000;
    g._onWorldState({ tick: 4, players: [me({ amber: { a: 1, ms: 9000, v: 9 } })] });
    expect(g.svFetches).toBe(2); // a failure is retried after the gap, not marked missing
  });
});
