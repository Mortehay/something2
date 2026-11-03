// The aura around an enchanted weapon.
//
//   +0..+3   nothing
//   +4..+9   a soft, translucent blue that deepens toward turquoise
//   +10..+15 fire red/crimson, hotter and bigger with every level, fiercest at +15
//
// COST. This is drawn for every visible player every frame, so it is built to be
// cheap: the glow is a radial-gradient SPRITE rendered once per level into a small
// offscreen canvas and then blitted with a single drawImage; the "particles" are a
// handful of sparks positioned by a closed-form orbit (no per-particle state, no
// allocation). Nothing here creates a gradient, a path or an object per frame.
// `shouldDrawGlow` additionally culls anything off screen before any of it runs.

export const GLOW_MIN_LEVEL = 4;       // mirrors services/enchant.js glowMinLevel (the server sends the live value)
export const GLOW_FIRE_LEVEL = 10;     // mirrors glowFireLevel
export const GLOW_MAX_LEVEL = 15;
const SPRITE_SIZE = 128;               // px; scaled on blit
const MAX_SPARKS = 7;

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }

// The visual parameters for a level, or null when there is no aura. `opts` carries
// the server's thresholds so a rebalanced config moves the aura with it.
//   rgb       [r,g,b] core colour
//   radius    glow radius in screen px (before zoom)
//   alpha     peak opacity of the glow core, 0..1
//   sparks    how many orbiting sparks
//   tier      1 = blue, 2 = fire
export function glowParams(level, opts = {}) {
  const min = Number.isInteger(opts.minLevel) ? opts.minLevel : GLOW_MIN_LEVEL;
  const fire = Number.isInteger(opts.fireLevel) ? opts.fireLevel : GLOW_FIRE_LEVEL;
  const max = Number.isInteger(opts.maxLevel) ? opts.maxLevel : GLOW_MAX_LEVEL;
  const n = Math.floor(Number(level) || 0);
  if (n < min) return null;
  const lvl = Math.min(n, max);

  if (lvl < fire) {
    // Blue: barely-there at the first level, saturated turquoise just below the fire step.
    const t = clamp01((lvl - min) / Math.max(1, fire - 1 - min));
    return {
      tier: 1,
      rgb: [Math.round(lerp(90, 20, t)), Math.round(lerp(170, 215, t)), Math.round(lerp(255, 235, t))],
      radius: lerp(16, 26, t),
      alpha: lerp(0.18, 0.62, t),
      sparks: Math.round(lerp(0, 2, t)),
    };
  }
  // Fire: scarlet at +10 climbing to blinding crimson at the cap -- brighter, denser,
  // wider and busier with every level.
  const t = clamp01((lvl - fire) / Math.max(1, max - fire));
  return {
    tier: 2,
    rgb: [255, Math.round(lerp(95, 25, t)), Math.round(lerp(40, 20, t))],
    radius: lerp(28, 46, t),
    alpha: lerp(0.62, 0.95, t),
    sparks: Math.round(lerp(3, MAX_SPARKS, t)),
  };
}

// One radial-gradient sprite per level, built lazily and kept. A map keyed by level
// is at most 12 entries (levels 4..15) of 128x128.
const spriteCache = new Map();

function makeCanvas(size) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(size, size);
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = size; c.height = size;
    return c;
  }
  return null;                                   // headless (tests): nothing to draw on
}

export function glowSprite(level, opts = {}) {
  const params = glowParams(level, opts);
  if (!params) return null;
  const key = `${Math.min(Math.floor(level), opts.maxLevel || GLOW_MAX_LEVEL)}:${opts.minLevel || ""}:${opts.fireLevel || ""}`;
  if (spriteCache.has(key)) return spriteCache.get(key);
  const canvas = makeCanvas(SPRITE_SIZE);
  const ctx = canvas && canvas.getContext && canvas.getContext("2d");
  if (!ctx) { spriteCache.set(key, null); return null; }
  const c = SPRITE_SIZE / 2;
  const [r, g, b] = params.rgb;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  // A hot core fading through the colour to nothing: three stops are enough to read
  // as a glow rather than a disc, and fire adds a bright white-ish core.
  grad.addColorStop(0, params.tier === 2 ? `rgba(255,${Math.min(255, g + 150)},${Math.min(255, b + 120)},${params.alpha})` : `rgba(${r},${g},${b},${params.alpha})`);
  grad.addColorStop(0.45, `rgba(${r},${g},${b},${params.alpha * 0.55})`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  spriteCache.set(key, canvas);
  return canvas;
}

export function clearGlowCache() { spriteCache.clear(); }

// Where the glow sits relative to a player: the weapon hand, which is on the side the
// player faces. `facing` is the game's facing string/vector label; unknown facings
// fall back to a centred glow rather than throwing.
const FACING_OFFSET = {
  n: [0.6, -0.2], ne: [0.8, -0.1], e: [0.9, 0.1], se: [0.7, 0.3],
  s: [-0.6, 0.3], sw: [-0.8, 0.2], w: [-0.9, 0.0], nw: [-0.7, -0.2],
};

export function handOffset(facing, scale = 1) {
  const key = typeof facing === "string" ? facing.toLowerCase() : "";
  const o = FACING_OFFSET[key] || [0.7, 0.1];
  return { dx: o[0] * 14 * scale, dy: o[1] * 14 * scale };
}

// Cheap rejection before any drawing: skip a glow that is wholly off the canvas.
export function shouldDrawGlow(x, y, radius, width, height) {
  return Number.isFinite(x) && Number.isFinite(y)
    && x + radius >= 0 && y + radius >= 0 && x - radius <= width && y - radius <= height;
}

// Draw the aura at screen point (x, y). `time` is a ms clock; the pulse and the spark
// orbits are pure functions of it, so there is no animation state to keep per player.
// Returns true if anything was drawn.
export function drawWeaponGlow(ctx, x, y, level, time, opts = {}) {
  const params = glowParams(level, opts);
  if (!params) return false;
  const zoom = Number.isFinite(opts.zoom) && opts.zoom > 0 ? opts.zoom : 1;
  const radius = params.radius * zoom;
  if (opts.width && opts.height && !shouldDrawGlow(x, y, radius, opts.width, opts.height)) return false;
  const sprite = glowSprite(level, opts);
  if (!sprite) return false;

  // A slow pulse that quickens and deepens with the tier -- fire breathes harder.
  const speed = params.tier === 2 ? 0.006 : 0.003;
  const depth = params.tier === 2 ? 0.16 : 0.08;
  const pulse = 1 + depth * Math.sin(time * speed + (opts.phase || 0));
  const r = radius * pulse;

  const prevOp = ctx.globalCompositeOperation;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalCompositeOperation = "lighter";      // additive, so it glows over any ground
  ctx.globalAlpha = 1;
  ctx.drawImage(sprite, x - r, y - r, r * 2, r * 2);

  // Sparks: a few points on a wobbling orbit, drawn as tiny additive squares (cheaper
  // than arcs, indistinguishable at this size).
  if (params.sparks > 0) {
    const [pr, pg, pb] = params.rgb;
    ctx.fillStyle = `rgb(${Math.min(255, pr + 40)},${Math.min(255, pg + 60)},${Math.min(255, pb + 40)})`;
    const size = Math.max(1.5, 2.4 * zoom);
    for (let i = 0; i < params.sparks; i += 1) {
      const a = time * 0.002 * (i % 2 ? 1 : -1) + (i * Math.PI * 2) / params.sparks + (opts.phase || 0);
      const orbit = r * (0.55 + 0.35 * Math.sin(time * 0.004 + i * 1.7));
      ctx.globalAlpha = 0.55 + 0.4 * Math.sin(time * 0.007 + i * 2.3);
      ctx.fillRect(x + Math.cos(a) * orbit - size / 2, y + Math.sin(a) * orbit * 0.6 - size / 2, size, size);
    }
  }
  ctx.globalCompositeOperation = prevOp;
  ctx.globalAlpha = prevAlpha;
  return true;
}
