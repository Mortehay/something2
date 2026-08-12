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

export function emptyVfxForm() {
  return {
    name: '', shape: 'arc', color: '#dddddd', width: '2', duration_ms: '180',
    ease: 'out', fade: true, follows_weapon: false,
    particle_count: '0', particle_spread: '6.283', particle_speed: '100',
    particle_gravity: '0', particle_lifetime_ms: '300', particle_size: '2',
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
  };
}

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export function vfxFormToPayload(f) {
  return {
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
  return null;
}
