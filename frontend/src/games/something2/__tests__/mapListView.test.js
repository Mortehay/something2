import { describe, it, expect } from 'vitest';
import {
  regionOf, groupWorldsByRegion, filterWorlds, defaultOpenGroups, STANDALONE_GROUP,
} from '../mapListView.js';

const w = (name, extra = {}) => ({ id: name, name, ...extra });

describe('regionOf', () => {
  it('takes the text before the first colon', () => {
    expect(regionOf('The Rimevault: Sealed Core')).toBe('The Rimevault');
  });

  it('splits on the FIRST colon, not the last', () => {
    // Place names are free text and may themselves contain a colon; the region
    // is always the leading segment.
    expect(regionOf('The Underdeep: Hub: Lower')).toBe('The Underdeep');
  });

  it('returns null for a name with no colon', () => {
    expect(regionOf('Windwatch Pass')).toBeNull();
  });

  it('returns null when the colon is leading, so the region would be empty', () => {
    expect(regionOf(': Orphan')).toBeNull();
  });

  it('returns null for a whitespace-only region rather than grouping under a blank header', () => {
    expect(regionOf('   : Orphan')).toBeNull();
  });

  it('tolerates a missing or non-string name', () => {
    expect(regionOf(undefined)).toBeNull();
    expect(regionOf(null)).toBeNull();
    expect(regionOf(42)).toBeNull();
  });
});

describe('groupWorldsByRegion', () => {
  it('groups worlds sharing a region prefix', () => {
    const groups = groupWorldsByRegion([
      w('The Rimevault: Hold'), w('The Catacombs: Elite'), w('The Rimevault: Coldforge'),
    ]);
    expect(groups).toEqual([
      { region: 'The Rimevault', worlds: [w('The Rimevault: Hold'), w('The Rimevault: Coldforge')] },
      { region: 'The Catacombs', worlds: [w('The Catacombs: Elite')] },
    ]);
  });

  it('orders regions by first appearance, not alphabetically', () => {
    // /api/worlds is created_at DESC, so first-appearance means newest-first --
    // alphabetical would bury freshly seeded regions in the middle of 39 groups.
    const groups = groupWorldsByRegion([w('Zeta: One'), w('Alpha: Two')]);
    expect(groups.map((g) => g.region)).toEqual(['Zeta', 'Alpha']);
  });

  it('preserves world order within a group', () => {
    const groups = groupWorldsByRegion([w('R: c'), w('R: a'), w('R: b')]);
    expect(groups[0].worlds.map((x) => x.name)).toEqual(['R: c', 'R: a', 'R: b']);
  });

  it('collects colon-less worlds into the standalone group', () => {
    const groups = groupWorldsByRegion([w('Windwatch Pass'), w('The Abyss: Floor 1')]);
    expect(groups.find((g) => g.region === STANDALONE_GROUP).worlds)
      .toEqual([w('Windwatch Pass')]);
  });

  it('puts the standalone group LAST even when its first member came first', () => {
    // It is a catch-all, not a region. Floating it to the top because one old
    // one-off map sorted newest would be noise.
    const groups = groupWorldsByRegion([w('Windwatch Pass'), w('The Abyss: Floor 1')]);
    expect(groups.map((g) => g.region)).toEqual(['The Abyss', STANDALONE_GROUP]);
  });

  it('omits the standalone group entirely when every world has a region', () => {
    const groups = groupWorldsByRegion([w('The Abyss: Floor 1')]);
    expect(groups.map((g) => g.region)).toEqual(['The Abyss']);
  });

  it('returns an empty list for no worlds', () => {
    expect(groupWorldsByRegion([])).toEqual([]);
    expect(groupWorldsByRegion(undefined)).toEqual([]);
  });
});

describe('filterWorlds', () => {
  const worlds = [w('The Rimevault: Sealed Core'), w('Windwatch Pass'), w('The Abyss: Floor 1')];

  it('matches on the place part of the name', () => {
    expect(filterWorlds(worlds, 'sealed').map((x) => x.name))
      .toEqual(['The Rimevault: Sealed Core']);
  });

  it('matches on the region prefix, so a region name pulls its whole region', () => {
    const regional = [w('The Rimevault: Hold'), w('The Rimevault: Coldforge'), w('Windwatch Pass')];
    expect(filterWorlds(regional, 'rimevault')).toHaveLength(2);
  });

  it('is case-insensitive', () => {
    expect(filterWorlds(worlds, 'WINDWATCH')).toHaveLength(1);
  });

  it('ignores surrounding whitespace in the query', () => {
    expect(filterWorlds(worlds, '  abyss  ')).toHaveLength(1);
  });

  it('returns everything for an empty or whitespace query', () => {
    expect(filterWorlds(worlds, '')).toHaveLength(3);
    expect(filterWorlds(worlds, '   ')).toHaveLength(3);
    expect(filterWorlds(worlds, undefined)).toHaveLength(3);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterWorlds(worlds, 'zzz')).toEqual([]);
  });

  it('tolerates a world with no name', () => {
    expect(() => filterWorlds([{ id: 'x' }], 'a')).not.toThrow();
    expect(filterWorlds([{ id: 'x' }], 'a')).toEqual([]);
  });
});

describe('defaultOpenGroups', () => {
  const groups = [
    { region: 'The Rimevault', worlds: [w('The Rimevault: Hold')] },
    { region: 'Home', worlds: [w('Home: Start', { is_entry: true })] },
  ];

  it('opens only the region containing the entry world', () => {
    expect([...defaultOpenGroups(groups)]).toEqual(['Home']);
  });

  it('opens nothing when no world is the entry world', () => {
    const none = [{ region: 'A', worlds: [w('A: x')] }];
    expect([...defaultOpenGroups(none)]).toEqual([]);
  });

  it('opens EVERY group while a filter is active', () => {
    // The caller passes already-filtered groups, so every group here has a
    // surviving hit. Leaving them closed would show a match count with no
    // visible matches, which reads as a broken search.
    expect([...defaultOpenGroups(groups, { filtered: true })].sort())
      .toEqual(['Home', 'The Rimevault']);
  });

  it('tolerates missing groups', () => {
    expect([...defaultOpenGroups(undefined)]).toEqual([]);
  });
});
