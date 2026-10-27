import { describe, it, expect } from 'vitest';
import { sfxChains, sfxPriority } from '../sfxResolve.js';

describe('sfxChains', () => {
  it('a skill cast resolves skill -> attack_type, most-specific miss key first', () => {
    const chains = sfxChains({ e: 'use', k: 'magic', s: 'skill:12', a: 'p:7', x: 10, y: 20 });
    expect(chains).toEqual([{ keys: ['skill/12/use', 'attack_type/magic/use'], missKey: 'skill/12/use' }]);
  });

  it('a weapon swing/shot resolves item -> attack_type', () => {
    const chains = sfxChains({ e: 'use', k: 'melee', s: 'Iron Sword', a: 'p:7', x: 0, y: 0 });
    expect(chains).toEqual([{ keys: ['item/Iron Sword/use', 'attack_type/melee/use'], missKey: 'item/Iron Sword/use' }]);
  });

  it("a creature's own attack resolves to creature/<type>/attack, no attack_type fallback", () => {
    const chains = sfxChains({ e: 'use', c: 'slime', a: 'c:3', x: 0, y: 0 });
    expect(chains).toEqual([{ keys: ['creature/slime/attack'], missKey: 'creature/slime/attack' }]);
  });

  it('an item hit resolves item -> attack_type', () => {
    const chains = sfxChains({ e: 'hit', k: 'ranged', s: 'Short Bow', x: 0, y: 0 });
    expect(chains).toEqual([{ keys: ['item/Short Bow/hit', 'attack_type/ranged/hit'], missKey: 'item/Short Bow/hit' }]);
  });

  it('a skill hit resolves skill -> attack_type', () => {
    const chains = sfxChains({ e: 'hit', k: 'magic', s: 'skill:12', x: 0, y: 0 });
    expect(chains).toEqual([{ keys: ['skill/12/hit', 'attack_type/magic/hit'], missKey: 'skill/12/hit' }]);
  });

  it("a creature's hit (no s -- its own attack sound already played on use) resolves to the generic melee hit only", () => {
    const chains = sfxChains({ e: 'hit', c: 'slime', x: 0, y: 0 });
    expect(chains).toEqual([{ keys: ['attack_type/melee/hit'], missKey: 'attack_type/melee/hit' }]);
  });

  it('hurt resolves to creature/<type>/hurt', () => {
    const chains = sfxChains({ e: 'hurt', c: 'slime', a: 'c:3', x: 0, y: 0 });
    expect(chains).toEqual([{ keys: ['creature/slime/hurt'], missKey: 'creature/slime/hurt' }]);
  });

  it('death resolves to creature/<type>/death', () => {
    const chains = sfxChains({ e: 'death', c: 'slime', x: 0, y: 0 });
    expect(chains).toEqual([{ keys: ['creature/slime/death'], missKey: 'creature/slime/death' }]);
  });

  it('an unrecognised or malformed event resolves to no chains, never a throw', () => {
    expect(sfxChains(null)).toEqual([]);
    expect(sfxChains(undefined)).toEqual([]);
    expect(sfxChains({})).toEqual([]);
    expect(sfxChains({ e: 'nearby', c: 'slime', x: 0, y: 0 })).toEqual([]);
    expect(sfxChains({ e: 'use', x: 0, y: 0 })).toEqual([]); // no s, no c
    expect(sfxChains({ e: 'hurt', x: 0, y: 0 })).toEqual([]); // no c
  });
});

describe('SOMET-605 boss events', () => {
  it('boss events resolve to creature/<type>/<e>', () => {
    for (const e of ['spawn', 'phase', 'enrage']) {
      expect(sfxChains({ e, c: 'Ignis', a: 'c:wb_1', x: 0, y: 0 }))
        .toEqual([{ keys: [`creature/Ignis/${e}`], missKey: `creature/Ignis/${e}` }]);
    }
    expect(sfxChains({ e: 'phase', x: 0, y: 0 })).toEqual([]);
  });

  it('sfxPriority -- own beats everything, boss events are boss, the rest nearest', () => {
    expect(sfxPriority({ e: 'use', a: 'p:1' }, 'p:1')).toBe('own');
    expect(sfxPriority({ e: 'phase', c: 'Ignis', a: 'c:wb_1' }, 'p:1')).toBe('boss');
    expect(sfxPriority({ e: 'enrage', c: 'Ignis' }, undefined)).toBe('boss');
    expect(sfxPriority({ e: 'hurt', c: 'Slime' }, 'p:1')).toBe('nearest');
    expect(sfxPriority({ e: 'death', c: 'Ignis' }, 'p:1')).toBe('nearest');
  });
});

// SOMET-607 (S5, spec §4.4): the local player entering an enemy aura.
describe('aura apply', () => {
  it("resolves to aura/<name>/apply, c carrying the aura's name", () => {
    expect(sfxChains({ e: 'apply', c: 'pack_leader', a: 'p:1', x: 0, y: 0 }))
      .toEqual([{ keys: ['aura/pack_leader/apply'], missKey: 'aura/pack_leader/apply' }]);
  });

  it('no aura name resolves to no chains', () => {
    expect(sfxChains({ e: 'apply', x: 0, y: 0 })).toEqual([]);
  });

  it('plays at own when the event carries the local player as actor, same generic rule as everything else', () => {
    expect(sfxPriority({ e: 'apply', c: 'pack_leader', a: 'p:1' }, 'p:1')).toBe('own');
  });
});

// SOMET-610 (S7, spec §3.6/§4.4): a creature skill's own telegraph/cast/hit.
describe('creature skill events', () => {
  it('resolve to creature_skill/<name>/<slot>, keyed by the skill NAME on `s`', () => {
    expect(sfxChains({ e: 'skill_telegraph', s: 'Magma Slam', a: 'c:1', x: 0, y: 0 }))
      .toEqual([{ keys: ['creature_skill/Magma Slam/telegraph'], missKey: 'creature_skill/Magma Slam/telegraph' }]);
    expect(sfxChains({ e: 'skill_cast', s: 'Magma Slam', a: 'c:1', x: 0, y: 0 }))
      .toEqual([{ keys: ['creature_skill/Magma Slam/use'], missKey: 'creature_skill/Magma Slam/use' }]);
    expect(sfxChains({ e: 'skill_hit', s: 'Magma Slam', a: 'c:1', x: 0, y: 0 }))
      .toEqual([{ keys: ['creature_skill/Magma Slam/hit'], missKey: 'creature_skill/Magma Slam/hit' }]);
  });

  it('no skill name resolves to no chains', () => {
    for (const e of ['skill_telegraph', 'skill_cast', 'skill_hit']) {
      expect(sfxChains({ e, a: 'c:1', x: 0, y: 0 })).toEqual([]);
    }
  });

  // Not boss-exclusive event NAMES (an ordinary creature casts a scaled-down
  // kit too, e.g. Fire Elemental Guard @0.4) -- priority depends on a live
  // cross-reference (bossActorIds), not the event tuple alone.
  it('sfxPriority: own beats everything; boss only with a matching bossActorIds entry; nearest otherwise', () => {
    const bossActorIds = new Set(['c:wb_1']);
    expect(sfxPriority({ e: 'skill_cast', s: 'Magma Slam', a: 'c:wb_1' }, 'p:1', bossActorIds)).toBe('boss');
    expect(sfxPriority({ e: 'skill_telegraph', s: 'Magma Slam', a: 'c:2' }, 'p:1', bossActorIds)).toBe('nearest');
    expect(sfxPriority({ e: 'skill_hit', s: 'Magma Slam', a: 'c:wb_1' }, 'p:1')).toBe('nearest'); // no bossActorIds at all
    expect(sfxPriority({ e: 'skill_cast', s: 'Magma Slam', a: 'p:1' }, 'p:1', bossActorIds)).toBe('own'); // own still wins
  });
});
