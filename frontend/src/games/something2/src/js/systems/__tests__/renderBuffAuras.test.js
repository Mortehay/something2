// Character buff auras in the world (Task 5): the ground pass under the actors and
// the body pass over them, drawn against a recording fake ctx.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RenderSystem } from '../RenderSystem.js';
import { worldToScreen } from '../../core/iso.js';
import { blastScreenRadiusX } from '../../core/blasts.js';
import { appearanceDrawScale } from '../../core/characterAppearance.js';
import { Game } from '../../core/Game.js';

// A fake ctx with a REAL save/restore stack for the state the passes touch, so
// "restored after drawing" is checked the way a canvas would do it.
function fakeCtx() {
  const calls = [];
  const stack = [];
  const ctx = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: false,
    strokeStyle: '#000', fillStyle: '#000', lineWidth: 1,
    save() { stack.push([this.globalAlpha, this.globalCompositeOperation, this.strokeStyle, this.fillStyle, this.lineWidth]); },
    restore() {
      const s = stack.pop();
      if (s) [this.globalAlpha, this.globalCompositeOperation, this.strokeStyle, this.fillStyle, this.lineWidth] = s;
    },
    translate: () => {}, scale: () => {}, beginPath: () => {}, closePath: () => {},
    arc: (...a) => calls.push({ op: 'arc', a }),
    ellipse: (...a) => calls.push({ op: 'ellipse', a }),
    stroke() { calls.push({ op: 'stroke', style: this.strokeStyle, alpha: this.globalAlpha }); },
    fill() { calls.push({ op: 'fill', style: this.fillStyle, alpha: this.globalAlpha }); },
    createRadialGradient: (...a) => {
      const g = { stops: [], a, addColorStop: (o, c) => g.stops.push([o, c]) };
      calls.push({ op: 'gradient', g });
      return g;
    },
    drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) {
      calls.push({ op: 'drawImage', img, sx, sy, sw, sh, dx, dy, dw, dh, alpha: this.globalAlpha, comp: this.globalCompositeOperation });
    },
  };
  return { ctx, calls, stack };
}

// 8 frames of 128x128.
const sheetImg = (name) => ({ name, naturalWidth: 1024, naturalHeight: 128 });
const IMAGES = {
  'vfx:buff/immolation.png': sheetImg('immolation'),
  'vfx:buff/a.png': sheetImg('a'),
  'vfx:buff/b.png': sheetImg('b'),
  'vfx:buff/c.png': sheetImg('c'),
};

const visual = (over = {}) => ({
  placement: 'body', radius: null, scale: null, priority: null, color: '#ff8800',
  sprite_image: null, sprite_frames: 8, sprite_additive: false, sprite_fps: 10, ...over,
});

const VISUALS = {
  mag_immolation_aura: visual({ placement: 'ground', color: '#ff4400', sprite_image: 'buff/immolation.png', sprite_additive: true }),
  buff_a: visual({ sprite_image: 'buff/a.png', priority: 5 }),
  buff_b: visual({ sprite_image: 'buff/b.png', priority: 1 }),
  buff_c: visual({ sprite_image: 'buff/c.png' }),
  plain_ground: visual({ placement: 'ground', color: '#22cc66' }),
  plain_body: visual({ color: '#3366ff' }),
};

function renderer(ctx, { visuals = VISUALS, settings = { main_opacity: 0.85, other_opacity: 0.45 }, nowMs = 0 } = {}) {
  const rs = Object.create(RenderSystem.prototype);
  rs.ctx = ctx;
  rs.nowMs = nowMs;
  rs.buffVisuals = visuals;
  rs.buffVisualSettings = settings;
  rs.skillsById = new Map();
  rs.imageManager = { get: (k) => IMAGES[k] || null };
  return rs;
}

const player = (buffs, over = {}) => ({ x: 200, y: 300, width: 64, height: 64, hp: 100, maxHp: 100, imageKey: 'player', buffs, ...over });
const draws = (calls) => calls.filter((c) => c.op === 'drawImage');

describe('ground buff auras', () => {
  it('Immolation draws its sheet 2 x blastScreenRadiusX(auraRadius) wide on the feet, fully opaque', () => {
    const { ctx, calls } = fakeCtx();
    const p = player([{ id: 'mag_immolation_aura', castAt: 1, auraRadius: 150 }]);
    renderer(ctx)._drawBuffGround(p, null);
    const d = draws(calls);
    expect(d).toHaveLength(1);
    const w = 2 * blastScreenRadiusX(150);
    expect(d[0].dw).toBeCloseTo(w);
    expect(d[0].dh).toBeCloseTo(w / 2);           // 128x128 frames: aspect 1, flattened 2:1
    const feet = worldToScreen(p.x + 32, p.y + 32);
    expect(d[0].dx + d[0].dw / 2).toBeCloseTo(feet.x);
    expect(d[0].dy + d[0].dh / 2).toBeCloseTo(feet.y);
    expect(d[0].alpha).toBe(1);
    expect(d[0].comp).toBe('lighter');
  });

  it('without auraRadius the row radius is used, else 64', () => {
    const { ctx, calls } = fakeCtx();
    const visuals = { ...VISUALS, mag_immolation_aura: { ...VISUALS.mag_immolation_aura, radius: 90 } };
    renderer(ctx, { visuals })._drawBuffGround(player([{ id: 'mag_immolation_aura' }]), null);
    expect(draws(calls)[0].dw).toBeCloseTo(2 * blastScreenRadiusX(90));
    const second = fakeCtx();
    renderer(second.ctx)._drawBuffGround(player([{ id: 'mag_immolation_aura' }]), null);
    expect(draws(second.calls)[0].dw).toBeCloseTo(2 * blastScreenRadiusX(64));
  });

  it('a ground buff without a sheet strokes a ring in its colour and draws no image', () => {
    const { ctx, calls } = fakeCtx();
    renderer(ctx)._drawBuffGround(player([{ id: 'plain_ground' }]), null);
    expect(draws(calls)).toHaveLength(0);
    const ring = calls.find((c) => c.op === 'ellipse');
    expect(ring.a[2]).toBeCloseTo(blastScreenRadiusX(64));
    expect(ring.a[3]).toBeCloseTo(blastScreenRadiusX(64) / 2);
    expect(calls.find((c) => c.op === 'stroke').style).toBe('#22cc66');
  });

  it('body buffs do not draw in the ground pass', () => {
    const { ctx, calls } = fakeCtx();
    renderer(ctx)._drawBuffGround(player([{ id: 'buff_a' }, { id: 'plain_body' }]), null);
    expect(calls).toHaveLength(0);
  });

  it('draws for remote players too', () => {
    const { ctx, calls } = fakeCtx();
    const remotes = new Map([[7, player([{ id: 'mag_immolation_aura', auraRadius: 150 }], { x: 900 })]]);
    renderer(ctx)._drawBuffGround(player([]), remotes);
    expect(draws(calls)).toHaveLength(1);
  });
});

describe('body buff auras', () => {
  it('height is scale x drawn character height, centred on the body', () => {
    const { ctx, calls } = fakeCtx();
    const p = player([{ id: 'buff_c' }]);
    renderer(ctx)._drawBuffBodies(p, null);
    const d = draws(calls);
    expect(d).toHaveLength(1);
    const dh = 64 * appearanceDrawScale('player');
    expect(d[0].dh).toBeCloseTo(1.3 * dh);
    expect(d[0].dw).toBeCloseTo(1.3 * dh);       // square frames
    const feet = worldToScreen(p.x + 32, p.y + 32);
    expect(d[0].dx + d[0].dw / 2).toBeCloseTo(feet.x);
    expect(d[0].dy + d[0].dh / 2).toBeCloseTo(feet.y - dh / 2);
    expect(d[0].comp).toBe('source-over');
  });

  it('plays frames at sprite_fps, looping', () => {
    const { ctx, calls } = fakeCtx();
    // 10 fps, 950 ms -> frame 9 -> 9 % 8 = 1 -> sx = 128.
    renderer(ctx, { nowMs: 950 })._drawBuffBodies(player([{ id: 'buff_c' }]), null);
    expect(draws(calls)[0].sx).toBe(128);
  });

  it('three buffs: the main one at 0.85, the other two at 0.45', () => {
    const { ctx, calls } = fakeCtx();
    const p = player([{ id: 'buff_c', castAt: 9 }, { id: 'buff_b', castAt: 5 }, { id: 'buff_a', castAt: 1 }]);
    renderer(ctx)._drawBuffBodies(p, null);
    const d = draws(calls);
    expect(d).toHaveLength(3);
    const byName = Object.fromEntries(d.map((c) => [c.img.name, c.alpha]));
    expect(byName).toEqual({ a: 0.85, b: 0.45, c: 0.45 });   // buff_a has the highest priority
  });

  it('a body buff without a sheet fills a radial glow in its colour and draws no image', () => {
    const { ctx, calls } = fakeCtx();
    renderer(ctx)._drawBuffBodies(player([{ id: 'plain_body' }]), null);
    expect(draws(calls)).toHaveLength(0);
    const g = calls.find((c) => c.op === 'gradient').g;
    expect(g.stops.map((s) => s[1]).every((c) => c.startsWith('rgba(51,102,255,'))).toBe(true);
    const fill = calls.find((c) => c.op === 'fill');
    expect(fill.style).toBe(g);
    expect(fill.alpha).toBe(1);
  });

  it('the glow gradient is built once per colour, not once per frame', () => {
    const { ctx, calls } = fakeCtx();
    const rs = renderer(ctx);
    for (let i = 0; i < 5; i++) rs._drawBuffBodies(player([{ id: 'plain_body' }]), null);
    expect(calls.filter((c) => c.op === 'gradient')).toHaveLength(1);
    expect(calls.filter((c) => c.op === 'fill')).toHaveLength(5);
  });
});

describe('no per-frame allocation for sheets', () => {
  it('over 5 frames the shared _vfxSheet path is never used and the row is resolved once', () => {
    const { ctx, calls } = fakeCtx();
    const rs = renderer(ctx);
    let vfxSheetCalls = 0;
    rs._vfxSheet = () => { vfxSheetCalls++; return null; };
    let blitCalls = 0;
    rs._blitSprite = () => { blitCalls++; };
    const p = player([{ id: 'mag_immolation_aura', auraRadius: 150 }, { id: 'buff_a' }, { id: 'buff_b' }]);
    for (let i = 0; i < 5; i++) {
      rs._drawBuffGround(p, null);
      rs._drawBuffBodies(p, null);
    }
    expect(vfxSheetCalls).toBe(0);
    expect(blitCalls).toBe(0);
    expect(draws(calls)).toHaveLength(15);
    // The same cached object every time it is asked.
    expect(rs._buffSheet(VISUALS.buff_a)).toBe(rs._buffSheet(VISUALS.buff_a));
  });

  it('a sheet that lands or is replaced later is picked up', () => {
    const { ctx, calls } = fakeCtx();
    const rs = renderer(ctx);
    const row = visual({ sprite_image: 'buff/late.png' });
    rs.buffVisuals = { late: row };
    let img = null;
    rs.imageManager = { get: (k) => (k === 'vfx:buff/late.png' ? img : null) };
    const p = player([{ id: 'late' }]);
    rs._drawBuffBodies(p, null);
    expect(draws(calls)).toHaveLength(0);                 // not loaded: glow fallback
    img = { name: 'late1', naturalWidth: 1024, naturalHeight: 128 };
    rs._drawBuffBodies(p, null);
    img = { name: 'late2', naturalWidth: 512, naturalHeight: 128 }; // 8 frames of 64x128
    rs._drawBuffBodies(p, null);
    const d = draws(calls);
    expect(d.map((c) => c.img.name)).toEqual(['late1', 'late2']);
    expect(d[1].sw).toBe(64);
    expect(d[1].dw).toBeCloseTo(d[1].dh / 2);
  });
});

describe('what draws nothing', () => {
  it('dru_bear_form (a form, not in the library) draws nothing in either pass', () => {
    const { ctx, calls } = fakeCtx();
    const rs = renderer(ctx);
    const p = player([{ id: 'dru_bear_form', castAt: 1 }]);
    rs._drawBuffGround(p, null);
    rs._drawBuffBodies(p, null);
    expect(calls).toHaveLength(0);
  });

  it('a dead player draws no buffs; a living one beside it does', () => {
    const { ctx, calls } = fakeCtx();
    const remotes = new Map([[2, player([{ id: 'buff_c' }], { hp: 50 })]]);
    renderer(ctx)._drawBuffBodies(player([{ id: 'buff_a' }], { hp: 0 }), remotes);
    expect(draws(calls).map((c) => c.img.name)).toEqual(['c']);
  });

  it('an empty library or no player draws nothing and does not throw', () => {
    const { ctx, calls } = fakeCtx();
    renderer(ctx, { visuals: {} })._drawBuffBodies(player([{ id: 'buff_a' }]), null);
    renderer(ctx)._drawBuffGround(null, null);
    expect(calls).toHaveLength(0);
  });
});

describe('state is restored', () => {
  it('composite op and alpha are back to their prior values after both passes', () => {
    const { ctx, stack } = fakeCtx();
    ctx.globalAlpha = 0.7;
    const rs = renderer(ctx);
    const p = player([
      { id: 'mag_immolation_aura', auraRadius: 150 }, { id: 'plain_ground' },
      { id: 'buff_a' }, { id: 'buff_b' }, { id: 'plain_body' },
    ]);
    rs._drawBuffGround(p, null);
    rs._drawBuffBodies(p, null);
    expect(ctx.globalAlpha).toBe(0.7);
    expect(ctx.globalCompositeOperation).toBe('source-over');
    expect(stack).toHaveLength(0);
  });
});

describe('Game wiring', () => {
  const realWindow = globalThis.window;
  beforeEach(() => { globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} }; });
  afterEach(() => { globalThis.window = realWindow; });

  function makeGame() {
    const g = new Game();
    g.state = 'playing';
    g.localUserId = 'me';
    g.player = { x: 0, y: 0, width: 64, height: 64, hp: 100, maxHp: 100 };
    g._inputBuffer = [];
    g.chunkedMap = null;
    return g;
  }

  it('setBuffVisuals re-indexes the library and loads its sheets', () => {
    const g = makeGame();
    const loads = [];
    g.imageManager = { load: (k, url) => { loads.push([k, url]); return Promise.resolve(); }, get: () => null };
    g.setBuffVisuals({
      visuals: [{ skill_id: 'buff_a', placement: 'body', sprite_image: 'buff/a.png' }, { skill_id: 'plain_body', placement: 'body' }],
      settings: { main_opacity: 0.9, other_opacity: 0.3 },
    });
    expect(Object.keys(g.buffVisuals).sort()).toEqual(['buff_a', 'plain_body']);
    expect(g.buffVisualSettings).toEqual({ main_opacity: 0.9, other_opacity: 0.3 });
    expect(loads.map((l) => l[0])).toEqual(['vfx:buff/a.png']);
    expect(loads[0][1]).toContain('buff/a.png');
  });

  it('a frame without the local player clears its buffs', () => {
    const g = makeGame();
    g._onWorldState({ tick: 1, players: [{ id: 'me', x: 0, y: 0, hp: 100, maxHp: 100, buffs: [{ id: 'buff_a', castAt: 1 }] }] });
    expect(g.player.buffs).toHaveLength(1);
    g._onWorldState({ tick: 2, players: [] });
    expect(g.player.buffs).toEqual([]);
  });
});
