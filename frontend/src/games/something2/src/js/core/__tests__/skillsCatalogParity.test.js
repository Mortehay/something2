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

describe('gem story gates match the backend', () => {
  it('has the same reqQuests and secret flags per gem', () => {
    const sig = (list) => list.map((s) => `${s.id}:${(s.reqQuests || []).join('+')}:${!!s.secretGem}`).sort();
    expect(sig(SKILLS)).toEqual(sig(backend.SKILLS));
  });
});

describe('skill damage preview matches the backend formula', () => {
  it('gives the same per-hit base and weapon share for every skill', async () => {
    const { skillDamagePreview } = await import('../skillsData.js');
    const sb = require(path.resolve(__dirname, '../../../../../../../../backend/src/authority/skillBalance.js'));
    for (const s of backend.SKILLS) {
      if (s.type === 'buff') { expect(skillDamagePreview(s, 50)).toBeNull(); continue; }
      for (const wd of [0, 50, 333]) {
        const server = sb.skillHitDamage(s, wd);
        const client = skillDamagePreview(s, wd);
        expect(client.hits).toBe(server.hits);
        expect(client.bonus).toBeCloseTo(server.bonus, 9);
        expect(client.total).toBeCloseTo(server.base * server.hits, 6);
      }
    }
  });
});

describe('per-skill element, attribute and projectile flag match the backend', () => {
  it('has the same three fields on every skill', () => {
    const sig = (list) => list.map((s) => `${s.id}:${s.element || ''}:${s.attribute || ''}:${!!s.projectile}`).sort();
    expect(sig(SKILLS)).toEqual(sig(backend.SKILLS));
  });
});

// The client's catalog is no longer a hand-kept copy: it is GENERATED from the
// server's by scripts/generate-skills-catalog.mjs. Two guards keep that true.
describe('the client catalog is generated from the server catalog', () => {
  it('is deeply identical to the server catalog, field for field', () => {
    // Order aside (the client floats the Druid forms first), every skill matches in
    // every field -- name, description, cost, cooldown, element, attribute, flags.
    const byId = new Map(backend.SKILLS.map((s) => [s.id, s]));
    expect(SKILLS.length).toBe(backend.SKILLS.length);
    for (const s of SKILLS) expect(s).toEqual(byId.get(s.id));
  });

  it('skillsCatalog.generated.js is up to date with the server file', async () => {
    const { renderCatalog, loadServerSkills, OUT_FILE } = await import('../../../../../../../scripts/generate-skills-catalog.mjs');
    const fs = await import('node:fs');
    expect(fs.readFileSync(OUT_FILE, 'utf8')).toBe(renderCatalog(loadServerSkills()));
  });

  it('no hand-written copy of the catalog is left in skillsData.js', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(path.resolve(__dirname, '../skillsData.js'), 'utf8');
    expect(src).toContain('skillsCatalog.generated.js');
    expect(src).not.toMatch(/id: 'war_crushing_blow'/);
  });
});

describe('skill synergies and forms match the backend', () => {
  it('computes the same tags, form and synergy table for every skill', async () => {
    const client = await import('../skillsData.js');
    const syn = require(path.resolve(__dirname, '../../../../../../../../backend/src/authority/skillSynergy.js'));
    expect(client.SYNERGIES).toEqual(syn.SYNERGIES);
    for (const s of backend.SKILLS) {
      expect([...client.skillTags(s)].sort()).toEqual([...syn.skillTags(s)].sort());
      expect(client.formOfSkill(s)).toBe(syn.formOfSkill(s));
    }
  });
});
