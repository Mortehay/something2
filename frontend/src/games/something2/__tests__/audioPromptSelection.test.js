import { describe, it, expect } from 'vitest';
import {
  audioSlotRows, applyFilters, filtersFromParams, paramsFromFilters, PROMPT_FILTERS,
} from '../audioSelection.js';

const subjects = [{
  kind: 'world', label: 'Worlds', slots: { music: 'music', ambience: 'ambience' }, subjects: ['Vale'],
  filledSlots: {}, promptStates: { Vale: { music: 'stale' } },
}, {
  kind: 'creature', label: 'Creatures', slots: { hurt: 'sfx' }, subjects: ['Wolf', 'Bat'],
  filledSlots: {}, promptStates: { Wolf: { hurt: 'written' }, Bat: { hurt: 'cleared' } },
}];

describe('prompt state on slot rows', () => {
  const rows = audioSlotRows(subjects);
  it('maps promptStates, defaulting to none', () => {
    expect(rows.map((r) => [r.id, r.prompt])).toEqual([
      ['world/Vale/music', 'stale'], ['world/Vale/ambience', 'none'],
      ['creature/Wolf/hurt', 'written'], ['creature/Bat/hurt', 'cleared'],
    ]);
  });
  it('filters: none includes cleared (both mean "no prompt will be used")', () => {
    const f = (prompt) => applyFilters(rows, { sound: 'all', prompt }).map((r) => r.id);
    expect(f('none')).toEqual(['world/Vale/ambience', 'creature/Bat/hurt']);
    expect(f('written')).toEqual(['creature/Wolf/hurt']);
    expect(f('stale')).toEqual(['world/Vale/music']);
    expect(f('all')).toHaveLength(4);
  });
  it('round-trips the prompt filter through the URL and drops unknown values', () => {
    expect(PROMPT_FILTERS).toEqual(['all', 'none', 'written', 'stale']);
    const p = paramsFromFilters({ kind: 'all', sound: 'missing', search: '', prompt: 'stale' });
    expect(p.get('prompt')).toBe('stale');
    expect(filtersFromParams(p).prompt).toBe('stale');
    expect(filtersFromParams(new URLSearchParams('prompt=bogus')).prompt).toBe('all');
    expect(paramsFromFilters({ kind: 'all', sound: 'missing', search: '', prompt: 'all' }).has('prompt')).toBe(false);
  });
});
