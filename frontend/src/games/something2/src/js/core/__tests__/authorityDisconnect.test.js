import { describe, it, expect, vi } from 'vitest';
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
describe('Game authority disconnect handling', () => {
  it('an unintentional close while playing transitions to a visible disconnected state', () => {
    const g = new Game();
    g.state = 'playing';
    g._onAuthorityClose(false);
    expect(g.state).toBe('disconnected');
    expect(g.authorityJoined).toBe(false);
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
