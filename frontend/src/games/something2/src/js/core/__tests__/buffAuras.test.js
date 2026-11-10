import { describe, it, expect } from 'vitest';
import {
  visibleBuffs, mainBuffId, buffOpacity, groundRadius, bodyScale, snapshotBuffs, indexBuffVisuals,
} from '../buffAuras.js';
import { remotePlayerFromFrame } from '../worldPlayers.js';
import { SKILLS_BY_ID } from '../skillsData.js';

const settings = { main_opacity: 0.85, other_opacity: 0.45 };

describe('buffOpacity', () => {
  it('a lone visible buff draws fully opaque', () => {
    expect(buffOpacity(1, true, settings)).toBe(1);
  });
  it('with several, the main one uses main_opacity and the rest other_opacity', () => {
    expect(buffOpacity(3, true, settings)).toBe(0.85);
    expect(buffOpacity(3, false, settings)).toBe(0.45);
  });
  it('reads the configured values, not the defaults', () => {
    const s = { main_opacity: 0.6, other_opacity: 0.2 };
    expect(buffOpacity(2, true, s)).toBe(0.6);
    expect(buffOpacity(2, false, s)).toBe(0.2);
  });
});

// Fake catalog: ids chosen so that id order never agrees with the expected
// winner -- a sort that fell through to the id would pick the wrong one.
const skills = new Map([
  ['a_low_tier', { tier: 1, reqLvl: 1 }],
  ['b_high_tier', { tier: 5, reqLvl: 1 }],
  ['c_mid_tier_low_lvl', { tier: 3, reqLvl: 10 }],
  ['d_mid_tier_high_lvl', { tier: 3, reqLvl: 30 }],
]);

describe('mainBuffId', () => {
  it('a buff with a priority beats a higher tier with none', () => {
    const visuals = { a_low_tier: { priority: 5 }, b_high_tier: { priority: null } };
    const entries = [{ id: 'b_high_tier', castAt: 2 }, { id: 'a_low_tier', castAt: 1 }];
    expect(mainBuffId(entries, visuals, skills)).toBe('a_low_tier');
  });

  it('the higher priority number wins', () => {
    const visuals = { a_low_tier: { priority: 2 }, b_high_tier: { priority: 7 } };
    const entries = [{ id: 'a_low_tier' }, { id: 'b_high_tier' }];
    expect(mainBuffId(entries, visuals, skills)).toBe('b_high_tier');
  });

  it('no priority: highest tier wins', () => {
    const visuals = { a_low_tier: {}, b_high_tier: {} };
    const entries = [{ id: 'a_low_tier', castAt: 9 }, { id: 'b_high_tier', castAt: 1 }];
    expect(mainBuffId(entries, visuals, skills)).toBe('b_high_tier');
  });

  it('same tier: highest reqLvl wins', () => {
    const visuals = { c_mid_tier_low_lvl: {}, d_mid_tier_high_lvl: {} };
    const entries = [{ id: 'c_mid_tier_low_lvl', castAt: 9 }, { id: 'd_mid_tier_high_lvl', castAt: 1 }];
    expect(mainBuffId(entries, visuals, skills)).toBe('d_mid_tier_high_lvl');
  });

  it('full tie on priority, tier and reqLvl: the later castAt wins', () => {
    const twins = new Map([['x_first', { tier: 2, reqLvl: 5 }], ['y_second', { tier: 2, reqLvl: 5 }]]);
    const visuals = { x_first: {}, y_second: {} };
    expect(mainBuffId([{ id: 'x_first', castAt: 2000 }, { id: 'y_second', castAt: 1000 }], visuals, twins)).toBe('x_first');
    expect(mainBuffId([{ id: 'x_first', castAt: 1000 }, { id: 'y_second', castAt: 2000 }], visuals, twins)).toBe('y_second');
  });

  it('falls back to the visual row tier/req_lvl when the catalog lacks the skill', () => {
    const visuals = { p: { tier: 1, req_lvl: 50 }, q: { tier: 4, req_lvl: 2 } };
    expect(mainBuffId([{ id: 'p' }, { id: 'q' }], visuals, new Map())).toBe('q');
  });

  it('no entries: null', () => {
    expect(mainBuffId([], {}, skills)).toBe(null);
  });

  // Review Focus 3: the answer must not depend on the order the server lists buffs in.
  it('the same entries reversed give the same id', () => {
    const cases = [
      [{ a_low_tier: { priority: 5 }, b_high_tier: {} }, [{ id: 'a_low_tier' }, { id: 'b_high_tier' }]],
      [{ a_low_tier: {}, b_high_tier: {}, c_mid_tier_low_lvl: {}, d_mid_tier_high_lvl: {} },
        [{ id: 'a_low_tier' }, { id: 'b_high_tier' }, { id: 'c_mid_tier_low_lvl' }, { id: 'd_mid_tier_high_lvl' }]],
      // Complete tie, castAt included: only the id is left to decide, and it must still be stable.
      [{ m: {}, n: {} }, [{ id: 'm', castAt: 5 }, { id: 'n', castAt: 5 }]],
    ];
    for (const [visuals, entries] of cases) {
      const forward = mainBuffId(entries, visuals, skills);
      const backward = mainBuffId([...entries].reverse(), visuals, skills);
      expect(forward).not.toBe(null);
      expect(backward).toBe(forward);
    }
  });

  it('works against the real skills catalog (tier and reqLvl are present)', () => {
    const imm = SKILLS_BY_ID.get('mag_immolation_aura');
    expect(typeof imm.tier).toBe('number');
    expect(typeof imm.reqLvl).toBe('number');
  });
});

describe('visibleBuffs', () => {
  it('keeps buffs with a visual and drops forms and unknown ids', () => {
    const visuals = { mag_immolation_aura: { placement: 'ground' } };
    const buffs = [{ id: 'mag_immolation_aura' }, { id: 'dru_bear_form' }, { id: 'no_such_skill' }];
    expect(visibleBuffs(buffs, visuals).map((b) => b.id)).toEqual(['mag_immolation_aura']);
  });
  it('no buffs or no library: nothing', () => {
    expect(visibleBuffs(undefined, {})).toEqual([]);
    expect(visibleBuffs([{ id: 'x' }], null)).toEqual([]);
  });
});

describe('groundRadius / bodyScale', () => {
  it('prefers the snapshot auraRadius over the row radius', () => {
    expect(groundRadius({ auraRadius: 150 }, { radius: 64 })).toBe(150);
    expect(groundRadius({}, { radius: 64 })).toBe(64);
  });
  it('falls back to 64 with neither', () => {
    expect(groundRadius({}, {})).toBe(64);
  });
  it('body scale defaults to 1.3', () => {
    expect(bodyScale({ scale: 2 })).toBe(2);
    expect(bodyScale({})).toBe(1.3);
  });
});

describe('indexBuffVisuals', () => {
  it('indexes rows by skill id and carries the opacity settings', () => {
    const lib = indexBuffVisuals({
      visuals: [{ skill_id: 'mag_immolation_aura', placement: 'ground' }],
      settings: { main_opacity: 0.7, other_opacity: 0.3 },
    });
    expect(lib.visuals.mag_immolation_aura.placement).toBe('ground');
    expect(lib.settings).toEqual({ main_opacity: 0.7, other_opacity: 0.3 });
  });
  it('a missing response is an empty library with default settings', () => {
    expect(indexBuffVisuals(null)).toEqual({ visuals: {}, settings: { main_opacity: 0.85, other_opacity: 0.45 } });
  });
});

// Review Focus 2: every snapshot REPLACES the buff list; an absent field is "no buffs".
describe('snapshot buffs', () => {
  it('a remote player frame without buffs has an empty buff list', () => {
    expect(remotePlayerFromFrame({ id: 'u1', x: 1, y: 2 }).buffs).toEqual([]);
  });
  it('a remote player frame with buffs carries them', () => {
    const buffs = [{ id: 'mag_immolation_aura', castAt: 1, auraRadius: 150 }];
    expect(remotePlayerFromFrame({ id: 'u1', buffs }).buffs).toEqual(buffs);
  });
  it('the next frame replaces, never merges with, the previous list', () => {
    const first = remotePlayerFromFrame({ id: 'u1', buffs: [{ id: 'a' }, { id: 'b' }] });
    const second = remotePlayerFromFrame({ id: 'u1', buffs: [{ id: 'b' }] });
    const third = remotePlayerFromFrame({ id: 'u1' });
    expect(first.buffs.map((b) => b.id)).toEqual(['a', 'b']);
    expect(second.buffs.map((b) => b.id)).toEqual(['b']);
    expect(third.buffs).toEqual([]);
  });
  it('snapshotBuffs (used for the local player) maps absent to []', () => {
    expect(snapshotBuffs(undefined)).toEqual([]);
    expect(snapshotBuffs(null)).toEqual([]);
    expect(snapshotBuffs([{ id: 'a' }, null])).toEqual([{ id: 'a' }]);
  });
});
