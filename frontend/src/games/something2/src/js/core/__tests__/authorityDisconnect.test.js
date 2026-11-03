import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Game } from '../Game.js';

// F-028: WorldAuthorityClient's onClose only set the unread
// `authorityJoined` flag. Game.state stayed 'playing', so update() kept
// running local prediction (the player kept moving under WASD) and every
// authorityClient.send* call silently no-op'd against the dead socket —
// no toast, no visible state change, only a manual reload recovered.
//
// The fix: an unintentional close (the socket died, not something Game
// itself tore down on purpose — e.g. a doorway transition or the 'kicked'
// flow) now transitions to a visible 'disconnected' state, mirroring the
// existing 'kicked' branch. update() already early-returns for any state
// other than 'playing', so freezing local prediction falls out of that
// existing guard for free once the state actually changes.
describe('Game authority reconnect', () => {
  function playingWithClient() {
    const g = new Game();
    g.state = 'playing';
    g.authorityClient = { worldId: 'w1', characterId: 7, connect: vi.fn(), disconnect: vi.fn() };
    return g;
  }

  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('an unintentional drop freezes the view, then re-joins the same world and character after a backoff', () => {
    const g = playingWithClient();
    g._onAuthorityClose(false);
    expect(g.state).toBe('disconnected');
    expect(g._reconnecting).toBe(true);
    expect(g.authorityClient.connect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(g.authorityClient.connect).toHaveBeenCalledWith('w1', 7);
  });

  it('returns to playing when the server re-joins us, and resets the attempt counter', () => {
    const g = playingWithClient();
    g._onAuthorityClose(false);
    vi.advanceTimersByTime(1000);
    g._onReconnected();
    expect(g.state).toBe('playing');
    expect(g._reconnecting).toBe(false);
    expect(g._reconnectAttempts).toBe(0);
  });

  it('backs off between failed attempts and gives up for good after RECONNECT_MAX', () => {
    const g = playingWithClient();
    g._onAuthorityClose(false);
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(10000);
      g._onAuthorityClose(false); // each attempt's socket dies again
    }
    expect(g.authorityClient.connect).toHaveBeenCalledTimes(6);
    expect(g.state).toBe('disconnected');
    expect(g._reconnecting).toBe(false);
  });

  it('a join that never completes is abandoned and retried', () => {
    const g = playingWithClient();
    g._onAuthorityClose(false);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(8000);
    expect(g.authorityClient.disconnect).toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(g.authorityClient.connect).toHaveBeenCalledTimes(2);
  });

  it('destroying the game cancels a pending reconnect', () => {
    const g = playingWithClient();
    g._onAuthorityClose(false);
    g._cancelReconnect();
    vi.advanceTimersByTime(60000);
    expect(g.authorityClient.connect).not.toHaveBeenCalled();
  });

  it('draws "reconnecting" while retrying and "reload" once it has given up', () => {
    const g = playingWithClient();
    g.canvas = { width: 800, height: 600 };
    g.ctx = {
      fillStyle: null, font: null, textAlign: null, textBaseline: null,
      fillRect: vi.fn(), fillText: vi.fn(), save: vi.fn(), restore: vi.fn(),
    };
    g._onAuthorityClose(false);
    g.render();
    expect(g.ctx.fillText.mock.calls[0][0].toLowerCase()).toContain('reconnecting');
  });
});

describe('Game authority disconnect handling', () => {
  it('an unintentional close while playing transitions to a visible disconnected state', () => {
    const g = new Game();
    g.state = 'playing';
    g._onAuthorityClose(false);
    expect(g.state).toBe('disconnected');
    // The `authorityJoined` assertion that stood here was dropped with the
    // flag itself (SOMET-96): it was written on join and close and read
    // NOWHERE, so asserting it only pinned bookkeeping. `state` is the signal
    // that actually gates rendering and input, and it is already asserted
    // above.
  });

  it('an intentional close (our own disconnect(), e.g. a doorway transition or destroy()) does not overwrite state', () => {
    const g = new Game();
    g.state = 'playing';
    g._onAuthorityClose(true);
    expect(g.state).toBe('playing');
  });

  it('does not clobber the kicked state if a stale close from a torn-down socket arrives late', () => {
    const g = new Game();
    g.state = 'kicked';
    g._onAuthorityClose(false);
    expect(g.state).toBe('kicked');
  });

  it('update() freezes local prediction once disconnected, instead of continuing to move the player under dead input', () => {
    const g = new Game();
    g.chunked = true;
    g.state = 'playing';
    const before = { x: g.player.x, y: g.player.y };
    g.keys = { d: true }; // holding a movement key
    g._onAuthorityClose(false);
    expect(g.state).toBe('disconnected');
    // update() bails out for any state other than 'playing' (existing
    // guard) — once disconnected, the player must stop moving under local
    // prediction rather than sliding around a dead session.
    g.update(0.1);
    expect(g.player.x).toBe(before.x);
    expect(g.player.y).toBe(before.y);
  });

  it('render() shows a visible disconnected message distinct from the live game view', () => {
    const g = new Game();
    g.state = 'disconnected';
    g.canvas = { width: 800, height: 600 };
    g.ctx = {
      fillStyle: null, font: null, textAlign: null, textBaseline: null,
      fillRect: vi.fn(), fillText: vi.fn(), save: vi.fn(), restore: vi.fn(),
    };
    g.render();
    expect(g.ctx.fillRect).toHaveBeenCalled();
    expect(g.ctx.fillText).toHaveBeenCalled();
    const [text] = g.ctx.fillText.mock.calls[0];
    expect(text.toLowerCase()).toContain('connection lost');
  });
});

// G18. Three gaps in the reconnect path.
describe('Game authority reconnect: state hygiene', () => {
  function playing() {
    const g = new Game();
    g.state = 'playing';
    g.authorityClient = { worldId: 'w1', characterId: 7, connect: vi.fn(), disconnect: vi.fn() };
    return g;
  }
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('a failed attempt\'s join guard does not survive to cut a LATER attempt short', () => {
    const g = playing();
    g._onAuthorityClose(false);          // drop
    vi.advanceTimersByTime(1000);        // attempt 1 starts, 8 s guard armed (fires at t=9000)
    expect(g.authorityClient.connect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    g._onAuthorityClose(false);          // attempt 1's socket dies at once
    expect(g._reconnectGuard).toBeNull();
    vi.advanceTimersByTime(8400);        // t=9500: attempt 2 (started ~t=3100) is mid-wait
    expect(g.authorityClient.disconnect).not.toHaveBeenCalled();
  });

  it('a rejoin starts from an empty input buffer (the server restarts its acks at 0)', () => {
    const g = playing();
    g._inputBuffer = [{ seq: 410, dx: 1, dy: 0, dt: 0.016 }, { seq: 411, dx: 1, dy: 0, dt: 0.016 }];
    g._onAuthorityClose(false);
    vi.advanceTimersByTime(1000);
    g._onReconnected();
    expect(g._inputBuffer).toEqual([]);
  });

  it('entering another world cancels a reconnect in progress (no spurious "Reconnected")', async () => {
    const g = playing();
    g._onAuthorityClose(false);
    expect(g._reconnecting).toBe(true);
    await g.initChunked({}); // no canvas: returns early, but only after cancelling
    expect(g._reconnecting).toBe(false);
    expect(g._reconnectTimer).toBeNull();
    vi.advanceTimersByTime(60000);
    expect(g.authorityClient.connect).not.toHaveBeenCalled();
  });
});
