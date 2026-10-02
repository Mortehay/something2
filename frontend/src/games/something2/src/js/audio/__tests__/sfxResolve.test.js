import { describe, it, expect } from 'vitest';
import { sfxChains } from '../sfxResolve.js';

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
