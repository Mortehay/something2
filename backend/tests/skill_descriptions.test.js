// The generated skill descriptions (seeds/data/skillDescriptions.js): complete in both
// languages, faithful to the effects table and the buff table, and free of numbers
// that are not in the data. The text is the player's only source of truth about a
// skill, so a promise in it that the data does not make is a bug.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SKILLS } = require('../seeds/data/skills.js');
const { SKILL_EFFECTS, DOT_SHARE, SUMMON_KINDS } = require('../seeds/data/skillEffects.js');
const { BUFFS } = require('../src/authority/skillBalance.js');
const {
  describeSkill, EFFECT_WORDS, EFFECT_TEXT, BUFF_TEXT,
} = require('../seeds/data/skillDescriptions.js');

// Numbers read out of a text, with Ukrainian decimal commas normalised.
const numbersIn = (text) => (text.replace(/(\d),(\d)/g, '$1.$2').match(/\d+(?:\.\d+)?/g) || []).map(Number);
const close = (a, b) => Math.abs(a - b) < 0.051;
const allowed = (set, n) => set.some((v) => close(v, n));

// Fixed numbers the text states as rules of the game, not as per-skill data.
const RULE_NUMBERS = [1, 4, 10, 15, 20, 30, 50]; // 1 life, 4 s idle, +10%/s sniper (cap 50%), +15% per 20% missing, below 30% life

function damagingAllowed(s) {
  const out = [s.units, s.units * 4, s.hits, DOT_SHARE * 100, ...RULE_NUMBERS];
  if (s.hits > 1) out.push(s.units / s.hits);
  for (const x of SKILL_EFFECTS[s.id] || []) {
    for (const v of Object.values(x)) if (typeof v === 'number') out.push(v);
  }
  return out;
}
function buffAllowed(spec) {
  const out = [...RULE_NUMBERS];
  for (const v of Object.values(spec)) {
    if (typeof v === 'number') out.push(v, v * 100, (v - 1) * 100, (1 - v) * 100, v / 1000);
    if (v && typeof v === 'object') {
      for (const w of Object.values(v)) if (typeof w === 'number') out.push(w, w * 100, w / 1000);
    }
  }
  return out;
}

test('every skill has a non-empty description in both languages, and its lore survives', () => {
  assert.equal(SKILLS.length, 300);
  for (const s of SKILLS) {
    assert.ok(s.descEn && s.descEn.length > 10, `${s.id}: descEn`);
    assert.ok(s.descUk && s.descUk.length > 10, `${s.id}: descUk`);
    assert.ok(s.loreEn && s.loreUk, `${s.id}: the original text is kept as lore`);
    assert.notEqual(s.descEn, s.loreEn, `${s.id}: the description is the generated one`);
  }
  const crush = SKILLS.find((s) => s.id === 'war_crushing_blow');
  assert.match(crush.loreEn, /180%/, 'lore is the original, unedited text');
  assert.ok(!/180%/.test(crush.descEn), 'the shown description no longer claims 180%');
});

test('regenerating from the generated catalog gives the same text (it is a pure function of the data)', () => {
  for (const s of SKILLS) {
    const d = describeSkill(s, BUFFS);
    assert.equal(d.en, s.descEn, s.id);
    assert.equal(d.uk, s.descUk, s.id);
  }
});

test('every effect in the table is in the text of the skills that carry it, in both languages', () => {
  for (const s of SKILLS.filter((x) => x.type !== 'buff')) {
    for (const x of SKILL_EFFECTS[s.id]) {
      const [wEn, wUk] = EFFECT_WORDS[x.k];
      assert.ok(s.descEn.toLowerCase().includes(wEn.toLowerCase()), `${s.id}: EN text lacks "${wEn}" for ${x.k}`);
      assert.ok(s.descUk.toLowerCase().includes(wUk.toLowerCase()), `${s.id}: UK text lacks "${wUk}" for ${x.k}`);
      // and the effect's own numbers are the ones printed
      for (const v of Object.values(x)) {
        if (typeof v === 'number') {
          assert.ok(allowed(numbersIn(s.descEn), v) || allowed(numbersIn(s.descEn), Math.round(v)), `${s.id}: ${x.k} ${v} not printed`);
        }
      }
    }
  }
});

test('every effect kind in the table has a sentence, and a summon kind a label', () => {
  const kinds = new Set();
  for (const list of Object.values(SKILL_EFFECTS)) for (const x of list) kinds.add(x.k);
  for (const k of kinds) {
    assert.ok(EFFECT_TEXT[k], `no sentence for ${k}`);
    assert.ok(EFFECT_WORDS[k], `no check word for ${k}`);
  }
  for (const k of Object.keys(SUMMON_KINDS)) assert.ok(SUMMON_KINDS[k].label, k);
});

test('every field of every buff has a sentence (a new mechanic cannot ship unwritten)', () => {
  for (const [id, spec] of Object.entries(BUFFS)) {
    for (const field of Object.keys(spec)) assert.ok(BUFF_TEXT[field], `${id}.${field}`);
  }
  for (const s of SKILLS.filter((x) => x.type === 'buff')) assert.ok(BUFFS[s.id], `${s.id} has no BUFFS entry`);
});

test('no description contains a number that is not in the data', () => {
  for (const s of SKILLS) {
    const ok = s.type === 'buff' ? buffAllowed(BUFFS[s.id]) : damagingAllowed(s);
    for (const text of [s.descEn, s.descUk]) {
      for (const n of numbersIn(text)) {
        assert.ok(allowed(ok, n), `${s.id}: "${n}" is not in the data. ${text}`);
      }
    }
  }
});

test('damaging skills quote their damage in weapon hits; multi-hit and channeled skills say so', () => {
  const byId = (id) => SKILLS.find((s) => s.id === id);
  assert.match(byId('war_crushing_blow').descEn, /^Deals about \d+(\.\d)?x weapon damage\./);
  assert.match(byId('arc_rain_of_arrows').descEn, /^10 hits of about/);
  assert.match(byId('arc_rain_of_arrows').descUk, /^10 ударів приблизно/);
  assert.match(byId('war_whirlwind').descEn, /^Channeled: about [\d.]+x weapon damage per second/);
  assert.match(byId('war_whirlwind').descUk, /^Підтримуване: приблизно [\d,]+x шкоди зброї за секунду/);
  // a damage-over-time effect is quoted as a share of the damage
  assert.match(byId('cul_blood_scythe').descEn, /Bleeds for 6 s \(about 60% of the damage in total\)/);
});

test('buff text says what the buff does and how long it lasts; shapeshifts are toggles', () => {
  const byId = (id) => SKILLS.find((s) => s.id === id);
  assert.equal(byId('war_battle_shout').descEn, '+20% damage dealt. Lasts 20 s.');
  assert.equal(byId('war_battle_shout').descUk, '+20% до завданої шкоди. Діє 20 с.');
  assert.match(byId('dru_bear_form').descEn, /Shapeshift \(bear\)/);
  assert.match(byId('dru_bear_form').descEn, /Lasts until you cancel it\.$/);
  assert.match(byId('dru_bear_form').descUk, /ведмідь/);
  assert.doesNotMatch(byId('war_unstoppable').descEn, /Lasts/, 'an instant effect has no duration');
});

test('an unknown effect kind or buff field is an error, not a silent omission', () => {
  assert.throws(() => describeSkill({ id: 'b', type: 'buff' }, { b: { dur: 5, bogus: 1 } }), /bogus/);
  assert.throws(() => describeSkill({ id: 'b', type: 'buff' }, {}), /no BUFFS entry/);
});
