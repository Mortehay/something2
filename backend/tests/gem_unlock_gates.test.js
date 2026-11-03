const test = require('node:test');
const assert = require('node:assert');
const { SKILLS, checkGemRequirements } = require('../seeds/data/skills.js');

const MAXED = { level: 99, strength: 99, dexterity: 99, constitution: 99, intelligence: 99, wisdom: 99, charisma: 99 };
const gated = SKILLS.find((s) => (s.reqQuests || []).length > 0);
const free = SKILLS.find((s) => (s.reqQuests || []).length === 0);

test('the catalog has a free starter set, quest-gated gems and secret ones', () => {
  assert.ok(free, 'some gems need no quest');
  assert.ok(gated, 'some gems need a quest');
  assert.ok(SKILLS.some((s) => s.secretGem));
  for (const s of SKILLS) for (const k of s.reqQuests) assert.match(k, /^act\d_/);
  // Gates only ever tighten as the level rises.
  const rank = (s) => (s.reqQuests[0] ? Number(s.reqQuests[0][3]) : 0);
  const byLvl = [...SKILLS].sort((a, b) => a.reqLvl - b.reqLvl);
  let prev = 0;
  for (const s of byLvl) { assert.ok(rank(s) >= prev, `${s.id}: gate went backwards`); prev = rank(s); }
});

test('a gated gem is refused without its quest and the message names everything missing', () => {
  const r = checkGemRequirements(gated, { level: 1 }, 'unarmed', { completedQuests: [], questTitles: { [gated.reqQuests[0]]: 'The Reliquary' } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.questsOk, false);
  assert.deepStrictEqual(r.missingQuests, gated.reqQuests);
  assert.match(r.message, /Level \d+/);
  assert.match(r.message, /completing quest "The Reliquary"/);
});

test('level and attributes met but quest missing is refused with the quest alone', () => {
  const r = checkGemRequirements(gated, MAXED, { name: 'any' }, { completedQuests: new Set() });
  assert.strictEqual(r.questsOk, false);
  assert.match(r.message, /^Requires completing quest /);
});

test('the quest done opens it', () => {
  const r = checkGemRequirements(gated, MAXED, { name: 'any' }, { completedQuests: new Set(gated.reqQuests) });
  assert.strictEqual(r.questsOk, true);
  assert.strictEqual(r.message, '');
});

test('without quest context the check stays level/attribute only (older callers, join race)', () => {
  const r = checkGemRequirements(gated, MAXED, { name: 'any' });
  assert.strictEqual(r.questsOk, true);
  assert.ok(!r.errors.some((e) => /quest/i.test(e)));
  assert.strictEqual(r.message, '');
});

test('Druid gems are gated by charisma (her main attribute), not STR/DEX', () => {
  const druid = SKILLS.filter((s) => s.class === 'Druid');
  const forms = new Set(['dru_bear_form', 'dru_hawk_form', 'dru_wolf_form']);
  for (const s of druid) {
    if (forms.has(s.id)) { assert.strictEqual(s.reqCha, 0); continue; }
    assert.ok(s.reqCha > 0, `${s.id} needs charisma`);
    assert.strictEqual(s.reqStr, 0, `${s.id} no STR gate`);
    assert.strictEqual(s.reqDex, 0, `${s.id} no DEX gate`);
  }
  const top = druid.reduce((a, b) => (b.reqLvl > a.reqLvl ? b : a));
  assert.ok(top.reqCha >= 30, 'the top Druid gem asks for a lot of charisma');
});
