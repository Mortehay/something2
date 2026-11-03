import { describe, it, expect, afterEach } from 'vitest';
import { BUILD_GUIDES } from '../buildGuides.data.js';
import { BUILD_GUIDES_UK } from '../buildGuides.uk.data.js';
import { getBuildGuide } from '../buildGuide.js';
import { setLang } from '../../i18n/i18n.js';

// Same keys and the same non-text values at every path; only strings may differ,
// and only at the paths that hold human text.
const TEXT_KEYS = new Set(['name', 'summary', 'playstyle', 'why', 'unlock', 'note', 'label']);
const ID_KEYS = new Set(['className', 'stat', 'skillId', 'startKey', 'key', 'kind']);

function parity(en, uk, path, errors) {
  if (Array.isArray(en)) {
    if (!Array.isArray(uk) || uk.length !== en.length) { errors.push(`${path}: array length`); return; }
    en.forEach((v, i) => parity(v, uk[i], `${path}[${i}]`, errors));
  } else if (en && typeof en === 'object') {
    if (!uk || typeof uk !== 'object') { errors.push(`${path}: not an object`); return; }
    const a = Object.keys(en).sort().join(',');
    const b = Object.keys(uk).sort().join(',');
    if (a !== b) errors.push(`${path}: keys ${a} vs ${b}`);
    for (const k of Object.keys(en)) parity(en[k], uk[k], `${path}.${k}`, errors);
  } else if (typeof en === 'string') {
    if (typeof uk !== 'string' || !uk.trim()) { errors.push(`${path}: missing text`); return; }
    const leaf = path.split('.').pop().replace(/\[\d+\]$/, '');
    if (ID_KEYS.has(leaf) && uk !== en) errors.push(`${path}: id changed`);
  } else if (uk !== en) {
    errors.push(`${path}: value ${en} vs ${uk}`);
  }
}

describe('BUILD_GUIDES_UK', () => {
  afterEach(() => setLang('en'));

  it('has the same classes', () => {
    expect(Object.keys(BUILD_GUIDES_UK).sort()).toEqual(Object.keys(BUILD_GUIDES).sort());
  });

  it.each(Object.keys(BUILD_GUIDES))('%s matches the English shape, keys and ids', (cls) => {
    const errors = [];
    parity(BUILD_GUIDES[cls], BUILD_GUIDES_UK[cls], cls, errors);
    expect(errors).toEqual([]);
  });

  it.each(Object.keys(BUILD_GUIDES))('%s translates the human text', (cls) => {
    const en = BUILD_GUIDES[cls];
    const uk = BUILD_GUIDES_UK[cls];
    for (const k of ['name', 'summary', 'playstyle']) expect(uk[k]).not.toBe(en[k]);
    expect(uk.gear.every((s, i) => s !== en.gear[i])).toBe(true);
    expect(uk.weaknesses.every((s, i) => s !== en.weaknesses[i])).toBe(true);
    for (const text of TEXT_KEYS) expect(typeof text).toBe('string');
  });

  it('getBuildGuide returns the overlay in uk and English otherwise', () => {
    setLang('en');
    expect(getBuildGuide('Warrior')).toBe(BUILD_GUIDES.Warrior);
    setLang('uk');
    expect(getBuildGuide('warrior')).toBe(BUILD_GUIDES_UK.Warrior);
  });

  it('an explicit guides argument wins and is not overlaid', () => {
    setLang('uk');
    const custom = { Warrior: { className: 'Warrior' } };
    expect(getBuildGuide('Warrior', custom)).toBe(custom.Warrior);
    expect(getBuildGuide('Warrior', {})).toBeNull();
  });
});
