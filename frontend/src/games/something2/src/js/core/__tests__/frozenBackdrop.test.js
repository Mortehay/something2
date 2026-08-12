import { describe, it, expect } from 'vitest';
import { Game } from '../Game.js';

// SOMET-79: the 'kicked' and 'disconnected' screens re-applied a 0.75-alpha
// black fill EVERY frame with nothing clearing in between, so the alpha
// compounded (1 - 0.25^n) and the canvas converged to solid black within about
// a second. Both branches carry a comment promising to "freeze on the last
// frame's background" and dim it -- the dimming was destroying the very thing
// it existed to keep visible.
//
// The assertion is about REPETITION, not appearance: a single-frame check
// looks identical before and after the fix, which is how this survived.
function fakeGame() {
  const ops = [];
  const g = new Game();
  g.canvas = { width: 100, height: 50 };
  g.ctx = {
    fillStyle: null,
    font: null,
    textAlign: null,
    textBaseline: null,
    fillRect: (...a) => ops.push({ op: 'fillRect', fill: g.ctx.fillStyle, a }),
    fillText: () => ops.push({ op: 'fillText' }),
    getImageData: () => ({ marker: 'frozen-frame' }),
    putImageData: (d) => ops.push({ op: 'putImageData', d }),
    save: () => {},
    restore: () => {},
  };
  return { g, ops };
}

for (const state of ['kicked', 'disconnected']) {
  describe(`${state} overlay`, () => {
    it('restores the frozen frame each render instead of stacking veils', () => {
      const { g, ops } = fakeGame();
      g.setState(state);
      for (let i = 0; i < 5; i++) g.render();

      const puts = ops.filter((o) => o.op === 'putImageData');
      expect(puts).toHaveLength(5);
      expect(puts[0].d).toEqual({ marker: 'frozen-frame' });

      // Exactly ONE veil per frame, over freshly restored pixels. Before the
      // fix there was no putImageData at all and the veil landed on the
      // previous frame's already-veiled output.
      const veils = ops.filter((o) => o.op === 'fillRect' && o.fill === 'rgba(0,0,0,0.75)');
      expect(veils).toHaveLength(5);
    });

    it('captures the frame once, on entry, not per frame', () => {
      const { g } = fakeGame();
      let captures = 0;
      g.ctx.getImageData = () => { captures += 1; return { marker: 'frozen-frame' }; };
      g.setState(state);
      g.render();
      g.render();
      expect(captures).toBe(1);
    });

    it('still draws a backdrop when the frame could not be captured', () => {
      // A tainted or zero-sized canvas must not throw on the way into an error
      // state -- degrade to a plain black backdrop rather than breaking the
      // transition that is trying to explain the disconnect.
      const { g, ops } = fakeGame();
      g.ctx.getImageData = () => { throw new Error('tainted canvas'); };
      expect(() => { g.setState(state); g.render(); }).not.toThrow();
      expect(ops.some((o) => o.op === 'fillRect')).toBe(true);
    });
  });
}
