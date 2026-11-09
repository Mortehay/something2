import { describe, it, expect } from 'vitest';
import { BUILD_GUIDES } from '../buildGuides.data.js';
import { BUILD_GUIDES_UK } from '../buildGuides.uk.data.js';
import { getSkillById } from '../skillsData.js';

// The guides are hand-written text, and the skills they describe get rebalanced. Two things drifted
// before: cooldown numbers (the guide kept the old ones) and "not implemented" notes for effects
// that have since been built. These checks fail when either comes back.

const EN_CD = /(\d+(?:\.\d+)?) s cooldown/;
const UK_CD = /перезарядк[а-я]* (\d+(?:\.\d+)?) с/;
const STALE = [/not implemented/i, /не реалізован/i, /Costs 0 mana/i, /Безкоштовн/i, /at (?:no|zero) cost/i, /wastes mana/i];

function walk(guides, cdRe) {
  const out = [];
  for (const [cls, g] of Object.entries(guides)) {
    for (const h of g.hotbar || []) out.push({ cls, h, cdRe });
  }
  return out;
}

describe.each([['en', BUILD_GUIDES, EN_CD], ['uk', BUILD_GUIDES_UK, UK_CD]])('guide freshness (%s)', (_l, guides, cdRe) => {
  it('every cooldown quoted for a hotbar skill matches the catalog', () => {
    const bad = [];
    for (const { cls, h } of walk(guides, cdRe)) {
      const m = cdRe.exec(h.why || '');
      const skill = getSkillById(h.skillId);
      if (m && skill && Number(m[1]) !== skill.cooldown) bad.push(`${cls}/${h.skillId}: guide ${m[1]}, catalog ${skill.cooldown}`);
    }
    expect(bad).toEqual([]);
  });

  it('carries no note that an effect is missing', () => {
    const hits = [];
    const scan = (v, p) => {
      if (typeof v === 'string') { for (const re of STALE) if (re.test(v)) hits.push(`${p}: ${v.slice(0, 70)}`); }
      else if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${p}[${i}]`));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(x, `${p}.${k}`);
    };
    scan(guides, 'guide');
    expect(hits).toEqual([]);
  });
});
