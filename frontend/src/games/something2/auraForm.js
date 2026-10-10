// Form <-> payload for the Aura Effects admin (SOMET-604). Pure, so it is
// testable under vitest's node env. Vocabulary and limits are asserted equal
// to backend/src/services/auraEffects.js by auraForm.test.js.
export const AURA_SIDES = ['allies', 'enemies'];
export const AURA_SHAPES = ['ring', 'disc', 'particles'];
export const AURA_LIMITS = { maxRadius: 2000, minTickMs: 100, maxTickMs: 5000, maxPulseMs: 10000, maxParticles: 64, maxNameLen: 200 };
export const AURA_ELEMENTS = ['physical', 'fire', 'ice', 'lightning', 'arcane'];

const FIELDS = {
  target_side: 'allies', radius: '200', damage_mult: '1', defense_mult: '1', speed_mult: '1',
  dot_dps: '0', dot_element: 'physical', tick_ms: '1000', shape: 'ring', color: '#d4a017', pulse_ms: '1200',
  particle_count: '0', particle_spread: '6.283', particle_speed: '100', particle_gravity: '0',
  particle_lifetime_ms: '300', particle_size: '2',
};
const TEXT = new Set(['target_side', 'dot_element', 'shape', 'color']);

export function emptyAuraForm() { return { name: '', ...FIELDS }; }
export function auraToForm(r) {
  const f = { name: r.name ?? '' };
  for (const [k, d] of Object.entries(FIELDS)) f[k] = TEXT.has(k) ? (r[k] ?? d) : String(r[k] ?? d);
  return f;
}
// Blank stays NaN (and is then rejected) -- never silently 0.
const n = (v) => (typeof v === 'string' && v.trim() === '' ? NaN : Number(v));
export function auraFormToPayload(f) {
  const p = { name: String(f.name || '').trim() };
  for (const k of Object.keys(FIELDS)) p[k] = TEXT.has(k) ? f[k] : n(f[k]);
  // The DoT field is disabled for allies; a leftover value from an earlier
  // 'enemies' edit must neither be sent nor block the save.
  if (p.target_side === 'allies') p.dot_dps = 0;
  return p;
}
export function validateAuraForm(f) {
  const p = auraFormToPayload(f);
  if (!p.name) return 'Name is required';
  if (!(p.radius > 0 && p.radius <= AURA_LIMITS.maxRadius)) return `Radius must be greater than 0 and at most ${AURA_LIMITS.maxRadius}`;
  if (!(p.damage_mult > 0)) return 'Damage multiplier must be greater than 0';
  if (!(p.defense_mult > 0)) return 'Defense multiplier must be greater than 0';
  if (!(p.speed_mult > 0)) return 'Speed multiplier must be greater than 0';
  if (!(p.dot_dps >= 0)) return 'DoT per second must be 0 or greater';
  if (p.target_side === 'allies' && p.dot_dps > 0) return 'Only an enemies aura can deal damage over time';
  if (!Number.isInteger(p.tick_ms) || p.tick_ms < AURA_LIMITS.minTickMs || p.tick_ms > AURA_LIMITS.maxTickMs) {
    return `Tick must be a whole number of ms between ${AURA_LIMITS.minTickMs} and ${AURA_LIMITS.maxTickMs}`;
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(p.color)) return 'Colour must be #rrggbb';
  if (!Number.isInteger(p.pulse_ms) || p.pulse_ms < 0 || p.pulse_ms > AURA_LIMITS.maxPulseMs) return `Pulse must be 0..${AURA_LIMITS.maxPulseMs} ms`;
  if (!Number.isInteger(p.particle_count) || p.particle_count < 0 || p.particle_count > AURA_LIMITS.maxParticles) {
    return `Particles must be a whole number between 0 and ${AURA_LIMITS.maxParticles}`;
  }
  if (!(p.particle_lifetime_ms > 0)) return 'Particle life must be greater than 0';
  if (!(p.particle_size >= 0)) return 'Particle size must be 0 or greater';
  return null;
}
