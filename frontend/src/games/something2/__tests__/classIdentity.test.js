import { describe, it, expect } from 'vitest';
import { describeClass, IDENTITY, MAIN_STAT_LABEL } from '../classIdentity.js';

// The six class names the server can send, written out by hand rather than
// imported from the module under test: importing IDENTITY's own keys to check
// IDENTITY's coverage would pass against an empty object.
const PLAYABLE = ['Warrior', 'Mage', 'Monk', 'Cultist', 'Archer', 'Druid'];

describe('classIdentity', () => {
  it('has an identity line for every playable class, and no others', () => {
    for (const name of PLAYABLE) {
      expect(typeof IDENTITY[name], `${name} needs a line`).toBe('string');
      expect(IDENTITY[name].length).toBeGreaterThan(0);
    }
    // Ranger was DEMOTED, not renamed into Archer (SOMET-471). It must not
    // reappear here: a line for it would be the first step back towards
    // offering it in the picker.
    expect(Object.keys(IDENTITY).sort()).toEqual([...PLAYABLE].sort());
  });

  it('gives every class a DISTINCT line', () => {
    // Six classes that all say the same thing is a picker that tells a player
    // nothing, and it is the copy-paste failure this table invites.
    expect(new Set(Object.values(IDENTITY)).size).toBe(PLAYABLE.length);
  });

  it('labels all six stats', () => {
    expect(MAIN_STAT_LABEL).toEqual({
      strength: 'STR',
      dexterity: 'DEX',
      constitution: 'CON',
      intelligence: 'INT',
      wisdom: 'WIS',
      charisma: 'CHA',
    });
  });

  it('renders the main stat and the identity line together', () => {
    expect(describeClass({ name: 'Cultist', mainStat: 'constitution' }))
      .toBe('CON · Casts with life instead of mana.');
    expect(describeClass({ name: 'Druid', mainStat: 'charisma' }))
      .toBe('CHA · Charms creatures to fight alongside them.');
    expect(describeClass({ name: 'Warrior', mainStat: 'strength' }))
      .toBe('STR · Hits hardest in melee.');
  });

  it('degrades visibly rather than silently on an unknown class', () => {
    expect(describeClass({ name: 'Necromancer', mainStat: null }))
      .toBe('— · No description yet.');
  });

  it('still renders the identity line when only the stat is unknown', () => {
    // A server that added a seventh stat would otherwise blank the whole line.
    expect(describeClass({ name: 'Monk', mainStat: 'luck' }))
      .toBe('— · Regenerates mana fastest.');
  });

  it('returns an empty string for a missing class object', () => {
    expect(describeClass(null)).toBe('');
    expect(describeClass(undefined)).toBe('');
    expect(describeClass({})).toBe('');
  });
});
