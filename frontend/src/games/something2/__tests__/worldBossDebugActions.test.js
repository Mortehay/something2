import { describe, it, expect } from 'vitest';
import { BOSS_STAGE_ACTIONS } from '../worldBossDebugActions.js';

describe('BOSS_STAGE_ACTIONS (SOMET-605)', () => {
  it('offers exactly the two server actions, in order, each with a label', () => {
    expect(BOSS_STAGE_ACTIONS.map((a) => a.action)).toEqual(['phase', 'enrage']);
    for (const a of BOSS_STAGE_ACTIONS) expect(typeof a.label).toBe('string');
    expect(Object.isFrozen(BOSS_STAGE_ACTIONS)).toBe(true);
  });
});
