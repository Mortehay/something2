import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { SKILLS, LEGACY_SKILL_ID_ALIASES, getSkillById } from '../skillsData.js';

// SOMET-571 rework. The frontend skill catalog is a copy of the backend's
// (backend/seeds/data/skills.js), and the BACKEND's ids key catalog_art,
// the audio bindings and the authority's skill lookups. One id had drifted:
// the frontend said `plague_globule`, the backend `cul_plague_globule`, so the
// Skill Tree tab showed Cultist at 49/50 while the console said 300/300, and
// the in-game icon lookup missed that skill. Pin the ids (and the class each
// belongs to) so a rename on one side cannot land alone.
const require = createRequire(import.meta.url);
const backend = require(path.resolve(__dirname, '../../../../../../../../backend/seeds/data/skills.js'));

describe('frontend skill catalog matches the backend catalog', () => {
  it('has the same ids, in the same classes', () => {
    const pairs = (list) => list.map((s) => `${s.class}:${s.id}`).sort();
    expect(pairs(SKILLS)).toEqual(pairs(backend.SKILLS));
  });

  // SOMET-618. LEGACY_SKILL_ID_ALIASES exists so a renamed id (like
  // plague_globule -> cul_plague_globule) still resolves for a player whose
  // localStorage has the old id. A retired key that is somehow still a live
  // id, or a target that ISN'T a live id, would mean the map is stale or
  // backwards -- either defeats the point of keeping it.
  it('keeps LEGACY_SKILL_ID_ALIASES pointing retired ids at real current ids', () => {
    const currentIds = new Set(SKILLS.map((s) => s.id));
    for (const [oldId, newId] of Object.entries(LEGACY_SKILL_ID_ALIASES)) {
      expect(currentIds.has(oldId)).toBe(false);
      expect(currentIds.has(newId)).toBe(true);
      expect(getSkillById(oldId)?.id).toBe(newId);
    }
  });
});
