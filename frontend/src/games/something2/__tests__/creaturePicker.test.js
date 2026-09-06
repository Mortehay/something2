import { describe, it, expect } from 'vitest';
import { matchCreatureTypes, DEFAULT_LIMIT } from '../creaturePicker.js';

const t = (name) => ({ id: name, name });
const CATALOG = [t('Rime Swarm'), t('Rime Skirmisher'), t('Rime Line'), t('Void Swarm'), t('Slime')];

describe('matchCreatureTypes', () => {
  it('returns nothing for an empty query rather than the whole catalog', () => {
    // The results list only renders when there is a query; returning all 293
    // types here would put the wall of controls straight back.
    expect(matchCreatureTypes(CATALOG, '')).toEqual({ shown: [], total: 0 });
    expect(matchCreatureTypes(CATALOG, '   ')).toEqual({ shown: [], total: 0 });
    expect(matchCreatureTypes(CATALOG, undefined)).toEqual({ shown: [], total: 0 });
  });

  it('matches a substring anywhere in the name, not just the prefix', () => {
    // "swarm" is the archetype suffix -- prefix-only matching would make the
    // most useful query in the catalog return nothing.
    const r = matchCreatureTypes(CATALOG, 'swarm');
    expect(r.shown.map((x) => x.name)).toEqual(['Rime Swarm', 'Void Swarm']);
  });

  it('is case-insensitive', () => {
    expect(matchCreatureTypes(CATALOG, 'RIME').total).toBe(3);
  });

  it('ignores surrounding whitespace', () => {
    expect(matchCreatureTypes(CATALOG, '  void  ').total).toBe(1);
  });

  it('excludes types that are already selected', () => {
    const r = matchCreatureTypes(CATALOG, 'rime', { exclude: new Set(['Rime Swarm']) });
    expect(r.shown.map((x) => x.name)).toEqual(['Rime Skirmisher', 'Rime Line']);
    expect(r.total).toBe(2);
  });

  it('accepts an array for exclude, not only a Set', () => {
    // A Set's .has does not exist on an array; taking an array without
    // converting it would throw rather than silently excluding nothing.
    const r = matchCreatureTypes(CATALOG, 'rime', { exclude: ['Rime Line'] });
    expect(r.shown.map((x) => x.name)).toEqual(['Rime Swarm', 'Rime Skirmisher']);
  });

  it('caps the shown list but reports the TRUE total', () => {
    // The count is what tells an admin to keep typing. If it were capped too,
    // a type past the cap would look like it does not exist.
    const many = Array.from({ length: 50 }, (_, i) => t(`Rime ${i}`));
    const r = matchCreatureTypes(many, 'rime');
    expect(r.shown).toHaveLength(DEFAULT_LIMIT);
    expect(r.total).toBe(50);
  });

  it('honours an explicit limit', () => {
    const many = Array.from({ length: 50 }, (_, i) => t(`Rime ${i}`));
    expect(matchCreatureTypes(many, 'rime', { limit: 3 }).shown).toHaveLength(3);
  });

  it('counts the total AFTER exclusions, so the count matches what is selectable', () => {
    const many = Array.from({ length: 30 }, (_, i) => t(`Rime ${i}`));
    const r = matchCreatureTypes(many, 'rime', { exclude: new Set(['Rime 0', 'Rime 1']) });
    expect(r.total).toBe(28);
  });

  it('returns an empty result when nothing matches', () => {
    expect(matchCreatureTypes(CATALOG, 'zzz')).toEqual({ shown: [], total: 0 });
  });

  it('skips entries with no usable name instead of throwing', () => {
    const dirty = [t('Rime Swarm'), { id: 'x' }, null, { id: 'y', name: 42 }];
    expect(() => matchCreatureTypes(dirty, 'rime')).not.toThrow();
    expect(matchCreatureTypes(dirty, 'rime').total).toBe(1);
  });

  it('tolerates a missing catalog', () => {
    expect(matchCreatureTypes(undefined, 'rime')).toEqual({ shown: [], total: 0 });
  });
});
