// How large a boss is drawn, per axis. Seeded bosses have display size == hitbox,
// which left the art no bigger than the box. Only drawing changes: the hitbox
// the server fights with stays as it is.
export const BOSS_ART_SCALE = 1.5;

const positive = (v) => Number.isFinite(v) && v > 0;

export function bossDrawSize(display, hitbox, fallback) {
  const box = positive(hitbox) ? hitbox : null;
  // A display size already above the hitbox is an explicit choice: kept.
  if (positive(display) && (box === null || display > box)) return display;
  if (box !== null) return box * BOSS_ART_SCALE;
  return fallback;
}
