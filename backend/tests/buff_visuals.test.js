// Pure rules of the buff visuals service: which buffs draw, and their defaults.
const test = require('node:test');
const assert = require('node:assert');
const { VISUAL_BUFF_IDS, GROUND_DEFAULT, defaultVisual } = require('../src/services/buffVisuals.js');
const { SKILLS_BY_ID } = require('../seeds/data/skills.js');

const FORMS = ['dru_bear_form', 'dru_hawk_form', 'dru_wolf_form'];
const TRAPS = ['arc_bear_trap', 'arc_explosive_trap', 'arc_tar_trap'];

test('55 visual buffs: every buff skill except the forms and traps', () => {
  assert.strictEqual(VISUAL_BUFF_IDS.length, 55);
  assert.ok(VISUAL_BUFF_IDS.includes('mag_immolation_aura'));
  for (const id of [...FORMS, ...TRAPS]) assert.ok(!VISUAL_BUFF_IDS.includes(id), id);
  for (const id of VISUAL_BUFF_IDS) assert.strictEqual(SKILLS_BY_ID.get(id).type, 'buff', id);
  assert.strictEqual(new Set(VISUAL_BUFF_IDS).size, 55);
});

test('ground default for the seven ground buffs, body for the rest', () => {
  assert.deepStrictEqual([...GROUND_DEFAULT].sort(), ['arc_tailwind_aura', 'cul_martyrdom_aura', 'dru_thorns_aura',
    'dru_tranquility', 'mag_immolation_aura', 'mnk_fast_mana_aura', 'war_banner_of_victory']);
  for (const id of GROUND_DEFAULT) {
    assert.ok(VISUAL_BUFF_IDS.includes(id), id);
    assert.strictEqual(defaultVisual(SKILLS_BY_ID.get(id)).placement, 'ground', id);
  }
  const d = defaultVisual(SKILLS_BY_ID.get('war_shield_wall'));
  assert.deepStrictEqual(d, { skill_id: 'war_shield_wall', placement: 'body', radius: 64, scale: 1.3, priority: null,
    color: SKILLS_BY_ID.get('war_shield_wall').iconColor });
});

test('colour falls back to #ffffff without an iconColor', () => {
  const { iconColor, ...rest } = SKILLS_BY_ID.get('war_shield_wall');
  assert.ok(iconColor);
  assert.strictEqual(defaultVisual(rest).color, '#ffffff');
});
