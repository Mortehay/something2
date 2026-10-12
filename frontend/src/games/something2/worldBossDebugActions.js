// SOMET-605 (spec §5): the World Boss test panel's stage triggers. `action`
// is the debugWorldBoss wire value server.js handles (admin only).
export const BOSS_STAGE_ACTIONS = Object.freeze([
  Object.freeze({ action: 'phase', label: 'Trigger Next Phase' }),
  Object.freeze({ action: 'enrage', label: 'Trigger Enrage' }),
]);
