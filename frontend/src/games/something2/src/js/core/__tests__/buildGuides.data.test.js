import { describe, it, expect } from 'vitest';
import { BUILD_GUIDES } from '../buildGuides.data.js';
import { getSkillById } from '../skillsData.js';

const CLASSES = ['Warrior', 'Mage', 'Monk', 'Cultist', 'Archer', 'Druid'];
const STATS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
const KINDS = ['minor', 'notable', 'greater', 'keystone'];
const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;

describe('BUILD_GUIDES data', () => {
  it('has exactly the six classes', () => {
    expect(Object.keys(BUILD_GUIDES).sort()).toEqual([...CLASSES].sort());
  });

  describe.each(CLASSES)('%s', (cls) => {
    const g = BUILD_GUIDES[cls];

    it('has identity and text fields', () => {
      expect(g.className).toBe(cls);
      expect(nonEmpty(g.name)).toBe(true);
      expect(nonEmpty(g.summary)).toBe(true);
      expect(nonEmpty(g.playstyle)).toBe(true);
    });

    it('has 3-5 stat priorities with valid codes', () => {
      expect(g.stats.length).toBeGreaterThanOrEqual(3);
      expect(g.stats.length).toBeLessThanOrEqual(5);
      for (const s of g.stats) {
        expect(STATS).toContain(s.stat);
        expect(nonEmpty(s.why)).toBe(true);
      }
    });

    it('has a 9-slot hotbar of catalog skills', () => {
      expect(g.hotbar).toHaveLength(9);
      expect(g.hotbar.map((h) => h.slot).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      for (const h of g.hotbar) {
        const skill = getSkillById(h.skillId);
        expect(skill, `${cls} hotbar skill ${h.skillId}`).toBeTruthy();
        expect(skill.class).toBe(cls);
        expect(h.name).toBe(skill.nameEn);
        expect(nonEmpty(h.unlock)).toBe(true);
        expect(nonEmpty(h.why)).toBe(true);
      }
    });

    it('has early skills that exist in the catalog', () => {
      expect(g.earlySkills.length).toBeGreaterThan(0);
      for (const e of g.earlySkills) {
        const skill = getSkillById(e.skillId);
        expect(skill, `${cls} early skill ${e.skillId}`).toBeTruthy();
        expect(e.name).toBe(skill.nameEn);
        expect(Number.isInteger(e.level)).toBe(true);
        expect(nonEmpty(e.note)).toBe(true);
      }
    });

    it('has a 150-step passive path of unique keys', () => {
      const p = g.passives;
      expect(nonEmpty(p.startKey)).toBe(true);
      expect(p.steps).toHaveLength(150);
      const keys = p.steps.map((s) => s.key);
      expect(new Set(keys).size).toBe(150);
      expect(keys).not.toContain(p.startKey);
      for (const s of p.steps) {
        expect(nonEmpty(s.key)).toBe(true);
        expect(nonEmpty(s.label)).toBe(true);
        expect(KINDS).toContain(s.kind);
      }
    });

    it('has the five milestones', () => {
      expect(g.passives.milestones.map((m) => m.points)).toEqual([10, 30, 60, 100, 150]);
      for (const m of g.passives.milestones) expect(nonEmpty(m.summary)).toBe(true);
    });

    it('has keystone entries that point at the right step', () => {
      const { keystones, steps } = g.passives;
      expect(keystones.length).toBeGreaterThan(0);
      for (const k of keystones) {
        expect(Number.isInteger(k.atStep)).toBe(true);
        expect(steps[k.atStep - 1].key).toBe(k.key);
        expect(steps[k.atStep - 1].label).toBe(k.label);
        expect(nonEmpty(k.note)).toBe(true);
      }
    });

    it('has gear and weakness bullets', () => {
      for (const list of [g.gear, g.weaknesses]) {
        expect(Array.isArray(list)).toBe(true);
        expect(list.length).toBeGreaterThan(0);
        for (const line of list) expect(nonEmpty(line)).toBe(true);
      }
    });
  });
});
