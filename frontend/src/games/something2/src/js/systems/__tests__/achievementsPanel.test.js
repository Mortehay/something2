import { describe, it, expect } from 'vitest';
import {
  layoutAchievementsPanel, achProgress, filterAchievements, sortAchievements, ACH_TABS, ACH_ROW_H,
} from '../achievementsPanel.js';

const A = (key, category, counter, target, unlocked = false, extra = {}) => ({
  key, category, name: key, description: key, icon: 'x', target, counter, unlocked,
  unlockedAt: unlocked ? '2026-10-01T10:00:00Z' : null, title: null, ...extra,
});

const FIXTURE = [
  A('slay100', 'combat', 40, 100),
  A('slay10', 'combat', 10, 10, true),
  A('walk', 'exploration', 90, 100),
  A('quest5', 'quests', 1, 5),
  A('lvl10', 'progression', 3, 10, false, { title: 'Veteran' }),
  A('gem', 'skills', 0, 3),
];

describe('achProgress', () => {
  it('clamps counter to target and handles zero target', () => {
    expect(achProgress(A('a', 'combat', 50, 100))).toBe(0.5);
    expect(achProgress(A('a', 'combat', 500, 100))).toBe(1);
    expect(achProgress(A('a', 'combat', 5, 0))).toBe(0);
    expect(achProgress(A('a', 'combat', 0, 10, true))).toBe(1);
  });
});

describe('filter and sort', () => {
  it('filters by category, All keeps everything', () => {
    expect(filterAchievements(FIXTURE, 'all')).toHaveLength(6);
    expect(filterAchievements(FIXTURE, 'combat').map((a) => a.key)).toEqual(['slay100', 'slay10']);
  });
  it('unlocked first, then closest to done', () => {
    expect(sortAchievements(FIXTURE).map((a) => a.key))
      .toEqual(['slay10', 'walk', 'slay100', 'lvl10', 'quest5', 'gem']);
  });
});

describe('layoutAchievementsPanel', () => {
  it('header counts unlocked/total and has all tabs with hit areas', () => {
    const l = layoutAchievementsPanel({ achievements: FIXTURE });
    expect(l.headerText).toContain('1/6');
    expect(l.tabs.map((t) => t.tab)).toEqual(ACH_TABS.map((t) => t.key));
    expect(l.hitAreas.filter((h) => h.kind === 'achtab')).toHaveLength(ACH_TABS.length);
    expect(l.hitAreas.some((h) => h.kind === 'achclose')).toBe(true);
    expect(l.tabs.find((t) => t.tab === 'combat').count).toBe(2);
  });
  it('tab filters rows and falls back to All for unknown tabs', () => {
    expect(layoutAchievementsPanel({ achievements: FIXTURE, tab: 'skills' }).items).toHaveLength(1);
    expect(layoutAchievementsPanel({ achievements: FIXTURE, tab: 'bogus' }).tab).toBe('all');
  });
  it('scroll is clamped and rows outside the list are culled', () => {
    const many = Array.from({ length: 30 }, (_, i) => A('k' + i, 'combat', i, 100));
    const top = layoutAchievementsPanel({ achievements: many });
    expect(top.maxScroll).toBeGreaterThan(0);
    expect(top.rows.length).toBeLessThan(30);
    const far = layoutAchievementsPanel({ achievements: many, scroll: 1e6 });
    expect(far.scrollY).toBe(far.maxScroll);
    expect(layoutAchievementsPanel({ achievements: many, scroll: -5 }).scrollY).toBe(0);
    for (const h of far.hitAreas.filter((x) => x.kind === 'achrow')) {
      expect(h.y).toBeGreaterThanOrEqual(far.listArea.y);
      expect(h.y + h.h).toBeLessThanOrEqual(far.listArea.y + far.listArea.h);
    }
    expect(ACH_ROW_H).toBeGreaterThan(0);
  });
  it('titles tab: No title entry first, active highlighted, hit areas carry the title', () => {
    const titles = [
      { title: 'Veteran', source: 'achievement', sourceName: 'Level 10' },
      { title: 'Hero', source: 'quest', sourceName: 'Big Quest' },
    ];
    const l = layoutAchievementsPanel({ achievements: FIXTURE, titles, activeTitle: 'Hero', tab: 'titles' });
    const hits = l.hitAreas.filter((h) => h.kind === 'achtitle');
    expect(hits.map((h) => h.title)).toEqual([null, 'Veteran', 'Hero']);
    expect(l.items.map((i) => i.active)).toEqual([false, false, true]);
    expect(l.items[2].sourceName).toBe('Quest: Big Quest');
    const cleared = layoutAchievementsPanel({ achievements: FIXTURE, titles, activeTitle: null, tab: 'titles' });
    expect(cleared.items[0].active).toBe(true);
  });
});
