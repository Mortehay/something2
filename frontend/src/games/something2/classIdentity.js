// Per-class copy for the character picker (SOMET-471).
//
// A separate module rather than literals inside CharacterSelect.jsx because
// vitest runs in a node environment here and that component cannot be rendered
// in a test at all -- the same reason characterSession.js exists. Everything in
// the picker worth asserting lives in a plain module; the JSX only arranges it.

export const MAIN_STAT_LABEL = {
  strength: 'STR',
  dexterity: 'DEX',
  constitution: 'CON',
  intelligence: 'INT',
  wisdom: 'WIS',
  charisma: 'CHA',
};

// Keyed by the class NAME the server sends on /api/characters/classes. One
// line, describing what the class does DIFFERENTLY -- not its stat spread or
// its pools, which the picker already shows next to it.
//
// Ranger is deliberately absent. SOMET-471 demoted it rather than renaming it
// into Archer, so the row still exists and existing characters still play it,
// but it is never offered here -- and if it somehow were, describeClass falls
// through to the visible "No description yet." rather than to an empty cell.
export const IDENTITY = {
  Warrior: 'Hits hardest in melee.',
  Mage: 'Largest mana pool and the strongest spells.',
  Monk: 'Regenerates mana fastest.',
  Cultist: 'Casts with life instead of mana.',
  Archer: 'Attacks fastest.',
  Druid: 'Charms creatures to fight alongside them.',
};

// A class the client has no copy for renders as an em dash and a visible
// "No description yet." rather than an empty cell: an unknown class means a
// client out of date with its server, and that should LOOK wrong instead of
// looking like a class with nothing interesting about it.
export function describeClass(cls) {
  if (!cls || typeof cls.name !== 'string' || cls.name.length === 0) return '';
  const stat = MAIN_STAT_LABEL[cls.mainStat] || '—';
  return `${stat} · ${IDENTITY[cls.name] || 'No description yet.'}`;
}
