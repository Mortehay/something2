// How large a boss is drawn, as a multiple of the player. Only drawing changes:
// the hitbox the server fights with stays as it is, and feet stay centred on it.
// Player.js builds the player at this size; a test holds the two together.
export const PLAYER_DRAW_SIZE = 64;

export const BOSS_SCALE_BY_TIER = Object.freeze({
  miniboss: 1.5,
  dungeon_elite: 2,
  dungeon_end: 2.5,
  world: 3,
});

// A tier added later still reads as a boss rather than a normal creature.
const DEFAULT_SCALE = BOSS_SCALE_BY_TIER.miniboss;

export function bossDrawSize(tier, display) {
  const size = PLAYER_DRAW_SIZE * (BOSS_SCALE_BY_TIER[tier] ?? DEFAULT_SCALE);
  // A display size set above the tier's is an explicit choice: kept.
  return Number.isFinite(display) && display > size ? display : size;
}
