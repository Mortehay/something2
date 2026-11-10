// Form <-> payload for the VFX effects admin (slice E, SOMET-162). Pure, so
// it is testable under vitest's node environment -- the component itself
// cannot be rendered here, which is the same constraint every other admin
// form in this project works under.

export const VFX_SHAPES = ['arc', 'line', 'ring', 'burst', 'bolt'];
export const VFX_EASES = ['linear', 'out', 'in'];
// Mirrors the DB CHECK (1714440169000_vfx_particles.js) and the API's own
// constant. Three copies is deliberate and each has a distinct job: the DB is
// the backstop, the API rejects a non-browser caller, and this one gives the
// author an error before a round trip.
export const MAX_PARTICLE_COUNT = 64;
// Sprite sheets (1714440873000_world_boss_attack_kits.js; same three-copy rule).
export const MAX_SPRITE_FRAMES = 64;
export const MAX_SPRITE_SIZE = 2000;
export const MAX_SPRITE_BYTES = 600 * 1024;

export function emptyVfxForm() {
  return {
    name: '', shape: 'arc', color: '#dddddd', width: '2', duration_ms: '180',
    ease: 'out', fade: true, follows_weapon: false,
    particle_count: '0', particle_spread: '6.283', particle_speed: '100',
    particle_gravity: '0', particle_lifetime_ms: '300', particle_size: '2',
    sprite_image: '', sprite_frames: '1', sprite_size: '0', sprite_additive: false,
    sprite_loop: false, sprite_fps: '', sprite_stretch: false, sprite_touched: false,
  };
}

export function vfxToForm(e) {
  return {
    name: e.name ?? '',
    shape: e.shape ?? 'arc',
    color: e.color ?? '#dddddd',
    width: String(e.width ?? 2),
    duration_ms: String(e.duration_ms ?? 180),
    ease: e.ease ?? 'out',
    fade: e.fade !== false,
    follows_weapon: e.follows_weapon === true,
    particle_count: String(e.particle_count ?? 0),
    particle_spread: String(e.particle_spread ?? 6.283),
    particle_speed: String(e.particle_speed ?? 100),
    particle_gravity: String(e.particle_gravity ?? 0),
    particle_lifetime_ms: String(e.particle_lifetime_ms ?? 300),
    particle_size: String(e.particle_size ?? 2),
    sprite_image: e.sprite_image ?? '',
    sprite_frames: String(e.sprite_frames ?? 1),
    sprite_size: String(e.sprite_size ?? 0),
    sprite_additive: e.sprite_additive === true,
    sprite_loop: e.sprite_loop === true,
    sprite_fps: e.sprite_fps == null ? '' : String(e.sprite_fps),
    sprite_stretch: e.sprite_stretch === true,
    sprite_touched: false,
  };
}

// Sprite edits. `sprite_touched` is form-only: the payload carries the sprite columns ONLY when it
// is true, because the API reads a missing sprite_image key as "leave all seven sprite columns
// alone" but '' as "clear the sprite". Without this a save from a card opened before an effect
// sprite was approved would send the stale snapshot and revert it (same rule as auraForm.js).
// Set by pick, clear and any sprite-field edit; `patch` is the field change(s) that caused it.
export function touchSprite(f, patch = {}) { return { ...f, ...patch, sprite_touched: true }; }
// Removing the sprite: every sprite field back to its default, sent as sprite_image ''.
export function clearedSpriteForm(f) {
  return touchSprite(f, {
    sprite_image: '', sprite_frames: '1', sprite_size: '0', sprite_additive: false,
    sprite_loop: false, sprite_fps: '', sprite_stretch: false,
  });
}

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export function vfxFormToPayload(f) {
  const p = {
    name: String(f.name || '').trim(),
    shape: f.shape,
    color: f.color,
    width: num(f.width, 2),
    duration_ms: num(f.duration_ms, 180),
    ease: f.ease,
    fade: !!f.fade,
    follows_weapon: !!f.follows_weapon,
    particle_count: Math.floor(num(f.particle_count, 0)),
    particle_spread: num(f.particle_spread, 6.283),
    particle_speed: num(f.particle_speed, 100),
    particle_gravity: num(f.particle_gravity, 0),
    particle_lifetime_ms: num(f.particle_lifetime_ms, 300),
    particle_size: num(f.particle_size, 2),
  };
  if (f.sprite_touched) {
    p.sprite_image = f.sprite_image ? String(f.sprite_image) : '';
    p.sprite_frames = Math.floor(num(f.sprite_frames, 1));
    p.sprite_size = num(f.sprite_size, 0);
    p.sprite_additive = !!f.sprite_additive;
    p.sprite_loop = !!f.sprite_loop;
    p.sprite_fps = f.sprite_fps === '' || f.sprite_fps == null ? null : num(f.sprite_fps, null);
    p.sprite_stretch = !!f.sprite_stretch;
  }
  return p;
}

// Mirrors the server's validateVfxEffect. Same rules, stated for the author
// before a round trip rather than instead of the server's check.
export function validateVfxForm(f) {
  if (!String(f.name || '').trim()) return 'Name is required';
  if (!VFX_SHAPES.includes(f.shape)) return `shape must be one of ${VFX_SHAPES.join(', ')}`;
  if (!VFX_EASES.includes(f.ease)) return `ease must be one of ${VFX_EASES.join(', ')}`;
  const n = num(f.particle_count, NaN);
  if (!Number.isInteger(n) || n < 0 || n > MAX_PARTICLE_COUNT) {
    return `Particles must be a whole number between 0 and ${MAX_PARTICLE_COUNT}`;
  }
  if (!(num(f.particle_lifetime_ms, 0) > 0)) return 'Particle life must be greater than 0';
  if (!(num(f.particle_size, -1) >= 0)) return 'Particle size must be 0 or greater';
  if (!(num(f.duration_ms, 0) > 0)) return 'Duration must be greater than 0';
  const frames = num(f.sprite_frames, NaN);
  if (!Number.isInteger(frames) || frames < 1 || frames > MAX_SPRITE_FRAMES) {
    return `Sprite frames must be a whole number between 1 and ${MAX_SPRITE_FRAMES}`;
  }
  const size = num(f.sprite_size, NaN);
  if (!(size >= 0 && size <= MAX_SPRITE_SIZE)) return `Sprite size must be between 0 and ${MAX_SPRITE_SIZE}`;
  return null;
}

// A sprite file the author picked: PNG, small enough for the server, and (when the frame
// count is known) wide enough to be cut into whole frames. Returns an error string or null.
export function validateSpriteFile(file, frames = 1) {
  if (!file) return 'Choose a PNG file';
  if (file.type && file.type !== 'image/png') return 'The sprite sheet must be a PNG';
  if (file.size > MAX_SPRITE_BYTES) return `The sprite sheet must be ${Math.floor(MAX_SPRITE_BYTES / 1024)} KB or smaller`;
  return null;
}

// A picked image's size against its frame count: a strip of N frames must be at least N px
// wide, and the frames are cut at floor(width / N), so a width that does not divide evenly
// loses a few right-hand pixels -- worth saying, not worth refusing.
export function spriteSheetHint(width, height, frames) {
  const n = Math.max(1, Math.floor(Number(frames)) || 1);
  if (!(width > 0 && height > 0)) return null;
  if (width < n) return `The image is ${width}px wide: it cannot hold ${n} frames`;
  const fw = Math.floor(width / n);
  const rest = width - fw * n;
  return rest === 0
    ? `${n} frame${n === 1 ? '' : 's'} of ${fw}x${height}px`
    : `${n} frames of ${fw}x${height}px (the last ${rest}px of the width are unused)`;
}

// The Attack Effects list's Sprite filter: 'all' | 'with' (has a sprite sheet) | 'without'.
export function vfxSpriteFilter(effects, mode) {
  if (mode === 'with') return effects.filter(e => !!e.sprite_image);
  if (mode === 'without') return effects.filter(e => !e.sprite_image);
  return effects;
}
