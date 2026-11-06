// backend/seeds/data/skillDescriptions.js
//
// The text of every skill, written FROM its data so text and mechanics cannot
// disagree. Pure: no I/O, and the tables it reads are passed in (skills.js hands it
// the buff table), so it has no dependency on the authority.
//
//   damaging skills  -> skill.units / skill.hits (skillSpec) + SKILL_EFFECTS
//   buff skills      -> the BUFFS entry (skillBalance)
//
// The old free-text descriptions promised things the server never did; they live on
// as skill.loreEn / skill.loreUk (flavour, not shown as the description).
//
// Unknown data is an ERROR, not a shrug: an effect kind or buff field this file does
// not know throws at load, so a new mechanic cannot ship without its sentence.

const { SKILL_EFFECTS, DOT_SHARE, SUMMON_KINDS } = require('./skillEffects.js');

const num = (n) => {
  const r = Math.round(n * 10) / 10;
  return String(r);
};
const ukNum = (n) => num(n).replace('.', ',');
const pct = (n) => Math.round(n);

const UK_ELEMENT = { physical: 'фізична', arcane: 'аркана', fire: 'вогонь', ice: 'лід', lightning: 'блискавка', shadow: 'тінь', holy: 'світло' };
const UK_FORM = { bear: 'ведмідь', hawk: 'яструб', wolf: 'вовк' };

const UK_SUMMON_LABEL = {
  wolf: 'Дух-вовк', treant: 'Трент', golem: 'Кривавий голем',
  warlord: 'Примарний воєвода', clone: 'Ілюзія', spirit: 'Астральний дух',
};

// ---- effects of damaging skills ---------------------------------------------
// kind -> (effect) => [en, uk]
const DOT_NAME = {
  bleed: ['Bleeds', 'Кровотеча'],
  poison: ['Poisons', 'Отрута'],
  burn: ['Burns', 'Підпал'],
};
const COND = {
  far: (b) => [`+${pct(b)}% damage at long range.`, `+${pct(b)}% шкоди здалеку.`],
  self_low_hp: (b) => [`Up to +${pct(b)}% damage: the lower your life, the more.`,
    `До +${pct(b)}% шкоди: чим менше у вас життя, тим більше.`],
  full_mana: (b) => [`+${pct(b)}% damage at full mana.`, `+${pct(b)}% шкоди при повній мані.`],
  bleeding: (b) => [`+${pct(b)}% damage to bleeding targets.`, `+${pct(b)}% шкоди по цілях із кровотечею.`],
};

const EFFECT_TEXT = {
  stun: (x) => (x.chance
    ? [`${pct(x.chance)}% chance to stun for ${num(x.s)} s.`, `${pct(x.chance)}% шансу оглушити на ${ukNum(x.s)} с.`]
    : [`Stuns for ${num(x.s)} s.`, `Оглушує на ${ukNum(x.s)} с.`]),
  root: (x) => [`Roots for ${num(x.s)} s.`, `Знерухомлює на ${ukNum(x.s)} с.`],
  slow: (x) => [`Slows by ${pct(x.pct)}% for ${num(x.s)} s.`, `Сповільнює на ${pct(x.pct)}% на ${ukNum(x.s)} с.`],
  silence: (x) => [`Silences for ${num(x.s)} s.`, `Накладає мовчання на ${ukNum(x.s)} с.`],
  weaken: (x) => [`Target deals ${pct(x.pct)}% less damage for ${num(x.s)} s.`,
    `Ослаблення: ціль завдає на ${pct(x.pct)}% менше шкоди ${ukNum(x.s)} с.`],
  vuln: (x) => [`Target takes ${pct(x.pct)}% more damage for ${num(x.s)} s.`,
    `Вразливість: ціль отримує на ${pct(x.pct)}% більше шкоди ${ukNum(x.s)} с.`],
  sunder: (x) => [`Reduces armor by ${pct(x.pct)}% for ${num(x.s)} s.`, `Зменшує броню на ${pct(x.pct)}% на ${ukNum(x.s)} с.`],
  bleed: (x) => dot('bleed', x),
  poison: (x) => dot('poison', x),
  burn: (x) => dot('burn', x),
  shock: () => ['Shocks: the target takes extra damage, loses mana and is briefly interrupted.',
    'Шок: ціль отримує більше шкоди, втрачає ману й на мить переривається.'],
  fear: (x) => [`Fear: the target flees for ${num(x.s)} s.`, `Страх: ціль тікає ${ukNum(x.s)} с.`],
  knockback: (x) => [`Knocks back ${x.px} px.`, `Відкидає на ${x.px} px.`],
  pull: (x) => [`Pulls enemies in from up to ${x.px} px.`, `Притягує ворогів з відстані до ${x.px} px.`],
  pierce: (x) => [`Ignores ${pct(x.pct)}% of armor.`, `Ігнорує ${pct(x.pct)}% броні.`],
  execute: (x) => [`Execute: +${pct(x.bonus)}% damage to targets below ${pct(x.below)}% life.`,
    `Добивання: +${pct(x.bonus)}% шкоди цілям із життям нижче ${pct(x.below)}%.`],
  cond: (x) => {
    const f = COND[x.when];
    if (!f) throw new Error(`skillDescriptions: unknown condition "${x.when}"`);
    return f(x.bonus);
  },
  chain: (x) => [`Chain: hits ${x.n} more targets nearby.`, `Ланцюг: вражає ще ${x.n} цілей поблизу.`],
  echo: (x) => [`Echo: repeats after ${num(x.s)} s for ${pct(x.pct)}% of the damage.`,
    `Відлуння: повторюється через ${ukNum(x.s)} с із ${pct(x.pct)}% шкоди.`],
  zone: (x) => [`Zone: leaves a damaging area on the ground for ${num(x.s)} s.`,
    `Зона: залишає на землі ділянку, що завдає шкоди ${ukNum(x.s)} с.`],
  lifesteal: (x) => [`Lifesteal: heals you for ${pct(x.pct)}% of the damage dealt.`,
    `Вампіризм: лікує вас на ${pct(x.pct)}% завданої шкоди.`],
  selfheal: (x) => [`Heals you for ${pct(x.pct)}% of max life.`, `Лікує вас на ${pct(x.pct)}% максимального здоров'я.`],
  mana: (x) => [`Restores ${pct(x.pct)}% of max mana.`, `Відновлює ${pct(x.pct)}% максимальної мани.`],
  dash: (x) => (x.dir === 'back'
    ? [`Leaps ${x.px} px back.`, `Відскок назад на ${x.px} px.`]
    : [`Dashes ${x.px} px forward.`, `Ривок уперед на ${x.px} px.`]),
  cleanse: () => ['Removes slows and roots from you.', 'Знімає з вас сповільнення та знерухомлення.'],
  taunt: (x) => [`Taunt: nearby enemies must attack you for ${num(x.s)} s.`,
    `Змушує ворогів поблизу атакувати вас ${ukNum(x.s)} с.`],
  summon: (x) => {
    const k = SUMMON_KINDS[x.kind];
    if (!k) throw new Error(`skillDescriptions: unknown summon kind "${x.kind}"`);
    return [`Summons ${k.label} x${x.n} for ${num(x.s)} s.`,
      `Прикликання: ${UK_SUMMON_LABEL[x.kind]} ×${x.n} на ${ukNum(x.s)} с.`];
  },
};

function dot(kind, x) {
  const [en, uk] = DOT_NAME[kind];
  const share = pct(DOT_SHARE * 100);
  return [`${en} for ${num(x.s)} s (about ${share}% of the damage in total).`,
    `${uk} ${ukNum(x.s)} с (приблизно ${share}% шкоди загалом).`];
}

// A word each kind's sentence must contain, per language: the test uses these to
// prove no effect in the table is missing from the text. (cond is checked by its number.)
const EFFECT_WORDS = {
  stun: ['stun', 'оглуш'], root: ['Root', 'Знерухом'], slow: ['Slow', 'Сповіль'],
  silence: ['Silence', 'мовчання'], weaken: ['less damage', 'Ослаблення'],
  vuln: ['more damage', 'Вразливість'], sunder: ['armor', 'броню'],
  bleed: ['Bleed', 'Кровотеча'], poison: ['Poison', 'Отрута'], burn: ['Burn', 'Підпал'],
  shock: ['Shock', 'Шок'], fear: ['Fear', 'Страх'], knockback: ['Knocks back', 'Відкидає'],
  pull: ['Pulls', 'Притягує'], pierce: ['Ignores', 'Ігнорує'], execute: ['Execute', 'Добивання'],
  cond: ['damage', 'шкоди'], chain: ['Chain', 'Ланцюг'], echo: ['Echo', 'Відлуння'],
  zone: ['Zone', 'Зона'], lifesteal: ['Lifesteal', 'Вампіризм'], selfheal: ['Heals you', 'Лікує вас'],
  mana: ['mana', 'мани'], dash: ['px', 'px'], cleanse: ['Removes slows', 'Знімає з вас'],
  taunt: ['Taunt', 'Змушує'], summon: ['Summons', 'Прикликання'],
};

// ---- damaging skills ----------------------------------------------------------
function damageSentence(skill) {
  const u = Number(skill.units) || 0;
  const hits = Math.max(1, Number(skill.hits) || 1);
  if (skill.channeled) {
    // `units` is ONE tick of a channel; the client ticks four times a second.
    const perSec = u * 4;
    const burst = hits > 1;
    return [
      `Channeled: about ${num(perSec)}x weapon damage per second${burst ? `, in bursts of ${hits} hits` : ''}.`,
      `Підтримуване: приблизно ${ukNum(perSec)}x шкоди зброї за секунду${burst ? `, серіями по ${hits} ударів` : ''}.`,
    ];
  }
  if (hits > 1) {
    return [
      `${hits} hits of about ${num(u / hits)}x weapon damage each (about ${num(u)}x in total).`,
      `${hits} ударів приблизно по ${ukNum(u / hits)}x шкоди зброї (загалом приблизно ${ukNum(u)}x).`,
    ];
  }
  return [`Deals about ${num(u)}x weapon damage.`, `Завдає приблизно ${ukNum(u)}x шкоди зброї.`];
}

function describeDamaging(skill) {
  const parts = [damageSentence(skill)];
  for (const x of SKILL_EFFECTS[skill.id] || []) {
    const f = EFFECT_TEXT[x.k];
    if (!f) throw new Error(`skillDescriptions: no sentence for effect kind "${x.k}" (${skill.id})`);
    parts.push(f(x));
  }
  return { en: parts.map((p) => p[0]).join(' '), uk: parts.map((p) => p[1]).join(' ') };
}

// ---- buffs --------------------------------------------------------------------
const up = (m) => pct((m - 1) * 100);
const down = (m) => pct((1 - m) * 100);

// field -> (value, spec) => [en, uk] | null (null: consumed by another field)
const BUFF_TEXT = {
  dur: () => null,
  maxStacks: () => null,
  absorbMagicOnly: () => null,
  formOnly: () => ['Works only while shapeshifted.', 'Діє лише у формі тварини.'],
  dealt: (v) => (v === 'missing'
    ? ['Damage dealt rises as your life falls: +15% for every 20% missing.', 'Шкода зростає, коли життя спадає: +15% за кожні 20% втраченого.']
    : [`+${up(v)}% damage dealt.`, `+${up(v)}% до завданої шкоди.`]),
  taken: (v) => [`-${down(v)}% damage taken.`, `-${down(v)}% отримуваної шкоди.`],
  takenMagic: (v) => [`-${down(v)}% magic damage taken.`, `-${down(v)}% отримуваної магічної шкоди.`],
  lowHpTaken: (v) => [`-${down(v)}% damage taken while below 30% life.`, `-${down(v)}% отримуваної шкоди, поки життя нижче 30%.`],
  speed: (v) => [`+${up(v)}% movement speed.`, `+${up(v)}% до швидкості руху.`],
  atk: (v) => (v === 'lowhp'
    ? ['Attack speed rises as your life falls.', 'Швидкість атаки зростає, коли життя спадає.']
    : [`+${up(v)}% attack speed.`, `+${up(v)}% до швидкості атаки.`]),
  stackAtk: (v, s) => [`+${pct(v * 100)}% attack speed per swing, up to ${s.maxStacks} stacks (lost after 4 s idle).`,
    `+${pct(v * 100)}% до швидкості атаки за кожен удар, до ${s.maxStacks} разів (зникає після 4 с без дій).`],
  sniper: () => ['+10% damage per second standing still (max +50%).', '+10% шкоди за кожну секунду нерухомості (максимум +50%).'],
  manaRegen: (v) => [`Mana regeneration x${num(v)}.`, `Відновлення мани x${ukNum(v)}.`],
  leech: (v) => [`Heals you for ${pct(v * 100)}% of the damage you deal.`, `Лікує вас на ${pct(v * 100)}% завданої шкоди.`],
  crit: (v) => [`+${pct(v * 100)}% critical chance.`, `+${pct(v * 100)}% до шансу критичного удару.`],
  critDmg: (v) => [`+${pct(v * 100)}% critical damage.`, `+${pct(v * 100)}% до критичної шкоди.`],
  critNext: (v) => [`Your next ${v} spells always crit.`, `Наступні ${v} закляття завжди критичні.`],
  nextMult: (v) => [`Your next spell deals x${num(v)} damage.`, `Наступне закляття завдає x${ukNum(v)} шкоди.`],
  dodge: (v) => [`${pct(v * 100)}% chance to dodge.`, `${pct(v * 100)}% шансу ухилитися.`],
  parry: (v) => [`${pct(v * 100)}% chance to parry.`, `${pct(v * 100)}% шансу парирувати.`],
  counter: (v) => [`A dodge counter-strikes for ${v} damage.`, `Ухилення відповідає контрударом на ${v} шкоди.`],
  reflect: (v) => [`Reflects ${pct(v * 100)}% of the damage you take.`, `Повертає ${pct(v * 100)}% отриманої шкоди.`],
  reflectPhys: (v) => [`Reflects ${pct(v * 100)}% of the physical damage you take.`, `Повертає ${pct(v * 100)}% отриманої фізичної шкоди.`],
  reach: (v) => [`+${up(v)}% melee reach.`, `+${up(v)}% до дальності ближнього бою.`],
  range: (v) => [`+${v} px attack range.`, `+${v} px до дальності атаки.`],
  hpMult: (v) => [`+${up(v)}% max life.`, `+${up(v)}% до максимального здоров'я.`],
  heal: (v) => [`Heals ${pct(v * 100)}% of max life at once.`, `Одразу лікує ${pct(v * 100)}% максимального здоров'я.`],
  healFlat: (v) => [`Heals ${v} life at once.`, `Одразу лікує ${v} здоров'я.`],
  hot: (v) => [`Heals ${num(v * 100)}% of max life per second.`, `Лікує ${ukNum(v * 100)}% максимального здоров'я за секунду.`],
  mana: (v) => [`Restores ${pct(v * 100)}% of max mana at once.`, `Одразу відновлює ${pct(v * 100)}% максимальної мани.`],
  manaShield: (v) => [`${pct(v * 100)}% of damage taken is paid from mana instead of life.`, `${pct(v * 100)}% отриманої шкоди оплачується маною замість життя.`],
  absorbPts: (v) => [`Absorbs ${v} damage.`, `Поглинає ${v} шкоди.`],
  absorbHits: (v, s) => (s.absorbMagicOnly
    ? [`Negates the next ${v} magic hits.`, `Повністю блокує наступні ${v} магічні удари.`]
    : [`Negates the next ${v} hits.`, `Повністю блокує наступні ${v} ударів.`]),
  hpFloor: () => ['Your life cannot fall below 1.', 'Ваше життя не може впасти нижче 1.'],
  physImmune: () => ['Immune to physical damage.', 'Імунітет до фізичної шкоди.'],
  ccImmune: () => ['Immune to stuns and slows.', 'Імунітет до оглушення та сповільнення.'],
  curseImmune: () => ['Immune to burning and charm.', 'Імунітет до підпалу та підкорення.'],
  stealth: () => ['Monsters do not notice you; your first attack out of it is a critical hit.', 'Монстри вас не помічають; перша атака з прихованості завжди критична.'],
  aura: (v) => [`Deals ${v.dps} ${v.element} damage per second to enemies within ${v.radius} px.`,
    `Завдає ${v.dps} шкоди (${UK_ELEMENT[v.element] || v.element}) за секунду ворогам у радіусі ${v.radius} px.`],
  revive: (v) => [`Revives you with ${pct(v * 100)}% life once, when you would die.`, `Воскрешає вас один раз із ${pct(v * 100)}% здоров'я, коли ви мали б загинути.`],
  form: (v) => [`Shapeshift (${v}): recast to leave the form.`, `Форма тварини (${UK_FORM[v] || v}): повторне використання повертає людську подобу.`],
  trap: (v) => ({
    bear: ['Lays a bear trap: stuns and damages whoever steps on it.', 'Ставить ведмежий капкан: оглушує й ранить того, хто наступить.'],
    explosive: ['Lays a mine that explodes when an enemy comes near.', 'Ставить міну, що вибухає, коли ворог наближається.'],
    tar: ['Lays a tar pool that slows enemies standing in it.', 'Розливає смолу, що сповільнює ворогів у ній.'],
  }[v] || (() => { throw new Error(`skillDescriptions: unknown trap "${v}"`); })()),
  mark: (v) => [`Marks enemies within ${v.radius} px: they take ${pct(v.vuln * 100)}% more damage for ${num(v.ms / 1000)} s.`,
    `Позначає ворогів у радіусі ${v.radius} px: вони отримують на ${pct(v.vuln * 100)}% більше шкоди ${ukNum(v.ms / 1000)} с.`],
  transfuse: (v) => [`Pays ${pct(v * 100)}% of your max life to fully heal the nearest ally.`,
    `Віддає ${pct(v * 100)}% вашого максимального здоров'я, щоб повністю зцілити найближчого союзника.`],
};

function describeBuff(skill, spec) {
  if (!spec) throw new Error(`skillDescriptions: buff "${skill.id}" has no BUFFS entry`);
  const parts = [];
  for (const [field, value] of Object.entries(spec)) {
    const f = BUFF_TEXT[field];
    if (!f) throw new Error(`skillDescriptions: no sentence for buff field "${field}" (${skill.id})`);
    const t = f(value, spec);
    if (t) parts.push(t);
  }
  const d = Number(spec.dur) || 0;
  if (spec.form || d >= 3600) {
    parts.push(['Lasts until you cancel it.', 'Діє, доки ви його не скасуєте.']);
  } else if (d > 1) {
    parts.push([`Lasts ${num(d)} s.`, `Діє ${ukNum(d)} с.`]);
  }
  return { en: parts.map((p) => p[0]).join(' '), uk: parts.map((p) => p[1]).join(' ') };
}

// buffs: the BUFFS table (skillBalance.BUFFS).
function describeSkill(skill, buffs) {
  return skill.type === 'buff' ? describeBuff(skill, buffs[skill.id]) : describeDamaging(skill);
}

module.exports = { describeSkill, describeDamaging, describeBuff, EFFECT_WORDS, EFFECT_TEXT, BUFF_TEXT };
