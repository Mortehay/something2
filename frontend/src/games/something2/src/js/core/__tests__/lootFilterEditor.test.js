import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defaultFilterConfig, activePreset } from '../lootFilter.js';
import * as ed from '../lootFilterEditor.js';

const require = createRequire(import.meta.url);
const server = require(path.resolve(__dirname, '../../../../../../../../backend/src/authority/lootFilter.js'));

const rulesOf = (c) => activePreset(c).rules;
const base = () => defaultFilterConfig();

describe('rules', () => {
  it('a new rule goes on top, with unique ids', () => {
    let c = ed.addRule(base());
    c = ed.addRule(c);
    c = ed.addRule(c);
    expect(rulesOf(c).map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
  });

  it('stops at the server limit', () => {
    let c = base();
    for (let i = 0; i < ed.MAX_RULES + 5; i += 1) c = ed.addRule(c);
    expect(rulesOf(c)).toHaveLength(ed.MAX_RULES);
  });

  it('moves a rule up and down, and is a no-op at the ends', () => {
    let c = base();
    for (let i = 0; i < 3; i += 1) c = ed.addRule(c); // r3 r2 r1
    c = ed.moveRule(c, 'r1', -1);
    expect(rulesOf(c).map((r) => r.id)).toEqual(['r3', 'r1', 'r2']);
    c = ed.moveRule(c, 'r3', -1);
    expect(rulesOf(c).map((r) => r.id)).toEqual(['r3', 'r1', 'r2']);
    c = ed.moveRule(c, 'r2', 1);
    expect(rulesOf(c).map((r) => r.id)).toEqual(['r3', 'r1', 'r2']);
  });

  it('toggles, removes and never mutates the config it was given', () => {
    const before = ed.addRule(base());
    const snapshot = JSON.stringify(before);
    const after = ed.toggleRule(before, 'r1');
    expect(rulesOf(after)[0].enabled).toBe(false);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(rulesOf(ed.removeRule(after, 'r1'))).toHaveLength(0);
  });
});

describe('conditions and style', () => {
  const withRule = () => ed.addRule(base());

  it('toggles rarity, category, base type and affix', () => {
    let c = withRule();
    c = ed.toggleRarity(c, 'r1', 'blue');
    c = ed.toggleRarity(c, 'r1', 'foxy');
    c = ed.toggleRarity(c, 'r1', 'blue');
    c = ed.toggleCategory(c, 'r1', 'weapon');
    c = ed.toggleTypeId(c, 'r1', 12);
    c = ed.toggleAffix(c, 'r1', 5);
    c = ed.setAffixMode(c, 'r1', 'all');
    expect(rulesOf(c)[0].conditions).toMatchObject({ rarities: ['foxy'], categories: ['weapon'], typeIds: [12], affixIds: [5], affixMode: 'all' });
  });

  it('level steps clear at the bottom, clamp at the top, and never invert', () => {
    let c = withRule();
    c = ed.stepLevel(c, 'r1', 'minLevel', +1);
    expect(rulesOf(c)[0].conditions.minLevel).toBe(1);
    c = ed.stepLevel(c, 'r1', 'minLevel', -1);
    expect(rulesOf(c)[0].conditions.minLevel).toBeNull();
    c = ed.stepLevel(c, 'r1', 'maxLevel', +1); // 1
    c = ed.stepLevel(c, 'r1', 'maxLevel', +10); // 11
    c = ed.stepLevel(c, 'r1', 'minLevel', +20); // from "any" the first step lands on 1
    expect(rulesOf(c)[0].conditions.minLevel).toBe(1);
    c = ed.stepLevel(c, 'r1', 'minLevel', +20); // 21: above max 11, so max is pushed along
    expect(rulesOf(c)[0].conditions).toMatchObject({ minLevel: 21, maxLevel: 21 });
    for (let i = 0; i < 20; i += 1) c = ed.stepLevel(c, 'r1', 'maxLevel', +10);
    expect(rulesOf(c)[0].conditions.maxLevel).toBe(ed.LEVEL_MAX);
  });

  it('font steps stay inside the limits', () => {
    let c = withRule();
    c = ed.stepFont(c, 'r1', +1);
    expect(rulesOf(c)[0].style.fontSize).toBe(ed.DEFAULT_FONT + 1);
    for (let i = 0; i < 100; i += 1) c = ed.stepFont(c, 'r1', +1);
    expect(rulesOf(c)[0].style.fontSize).toBe(ed.FONT_MAX);
    for (let i = 0; i < 100; i += 1) c = ed.stepFont(c, 'r1', -1);
    expect(rulesOf(c)[0].style.fontSize).toBe(ed.FONT_MIN);
  });
});

describe('presets', () => {
  it('duplicates the active preset and makes the copy active; cannot remove the last one', () => {
    let c = ed.addRule(base());
    c = ed.duplicatePreset(c);
    expect(c.presets).toHaveLength(2);
    expect(c.activeId).not.toBe('default');
    expect(rulesOf(c)).toHaveLength(1);
    c = ed.setActivePreset(c, 'default');
    c = ed.removePreset(c, 'default');
    expect(c.presets).toHaveLength(1);
    expect(ed.removePreset(c, c.presets[0].id).presets).toHaveLength(1);
  });

  it('renames (trimmed, never to empty) and toggles the auto-loot flag', () => {
    let c = ed.renamePreset(base(), 'default', '  Mine ');
    expect(c.presets[0].name).toBe('Mine');
    expect(ed.renamePreset(c, 'default', '   ').presets[0].name).toBe('Mine');
    expect(activePreset(ed.toggleAutolootSkip(c)).autolootSkipHidden).toBe(false);
  });
});

describe('what the editor builds is accepted by the server', () => {
  it('a heavily edited config passes sanitizeConfig unchanged in meaning', () => {
    let c = ed.addStarterPreset(base());
    c = ed.addRule(c);
    c = ed.setAction(c, 'r1', 'hide');
    c = ed.toggleRarity(c, 'r1', 'white');
    c = ed.stepLevel(c, 'r1', 'minLevel', +5);
    c = ed.stepFont(c, 'r1', +3);
    c = ed.setStyle(c, 'r1', { textColor: ed.PALETTE[3], beam: true, beamColor: ed.PALETTE[4] });
    c = ed.duplicatePreset(c);
    const clean = server.sanitizeConfig(c);
    expect(clean.presets).toHaveLength(3);
    expect(clean.activeId).toBe(c.activeId);
    expect(clean.presets.find((p) => p.id === c.activeId).rules.length).toBe(5);
  });
});
