// Generates the EXTRA build guides (the 2nd and 3rd build of every class) shown in the U window.
//
//   make build-guides          (dumps the passive tree from the dev DB, then runs this)
//   npx vite-node scripts/build-guides/generate.mjs
//
// Inputs
//   .tree.json   the real passive tree (backend/scripts/dump-passive-tree.js)
//   weights.mjs  what each build values -> its 150-step passive route (path.mjs walks the real graph)
//   texts/*.mjs  the hand-written parts of each build, in English and Ukrainian; {skill_id} placeholders
//   the skills catalog and the Ukrainian dictionaries, for names, unlock lines and passive labels
// Outputs (do not edit by hand -- edit the inputs and run this again)
//   core/buildGuides.variants.data.js      BUILD_GUIDE_VARIANTS     (English)
//   core/buildGuides.variants.uk.data.js   BUILD_GUIDE_VARIANTS_UK  (Ukrainian)
import fs from 'node:fs';
import { buildGraph, buildRoute, sumGrants } from './path.mjs';
import { WEIGHTS } from './weights.mjs';
import warrior from './texts/warrior.mjs';
import mage from './texts/mage.mjs';
import monk from './texts/monk.mjs';
import cultist from './texts/cultist.mjs';
import archer from './texts/archer.mjs';
import druid from './texts/druid.mjs';
import { SKILLS } from '../../src/games/something2/src/js/core/skillsData.js';
import { BUILD_GUIDES } from '../../src/games/something2/src/js/core/buildGuides.data.js';
import { setLang, t, hasTranslation } from '../../src/games/something2/src/js/i18n/i18n.js';

const CORE = new URL('../../src/games/something2/src/js/core/', import.meta.url);
const TREE = new URL('./.tree.json', import.meta.url);
const CLASS_ORDER = ['Warrior', 'Mage', 'Monk', 'Cultist', 'Archer', 'Druid'];
const BUILDS = [...warrior, ...mage, ...monk, ...cultist, ...archer, ...druid];
const MILESTONES = [10, 30, 60, 100, 150];
const TOTAL = 150;
const MAX_KEY_NODES = 16;

const skillById = new Map(SKILLS.map((s) => [s.id, s]));
const skillOf = (id, cls) => {
  const s = skillById.get(id);
  if (!s) throw new Error(`unknown skill ${id}`);
  if (s.class !== cls) throw new Error(`${id} is a ${s.class} skill, not ${cls}`);
  return s;
};

// ---- language tables -----------------------------------------------------------------------------
const L = {
  en: {
    stat: { strength: 'STR', dexterity: 'DEX', constitution: 'CON', intelligence: 'INT', wisdom: 'WIS', charisma: 'CHA' },
    pool: { hp: 'max HP', mana: 'max mana', stamina: 'max stamina' },
    damage: (el) => `${el} damage`,
    elements: { physical: 'physical', fire: 'fire', ice: 'ice', lightning: 'lightning', arcane: 'arcane' },
    resist: (el) => `${el} resistance`,
    unlock: ({ lvl, quests, secret, price }) => `Lv ${lvl}${quests ? ` · quest ${quests}` : ''}${secret ? ' (secret gem)' : ''} · ${price} g`,
    tree: 'Tree nodes so far give',
    nothing: 'Tree nodes so far give mostly small bonuses.',
    rules: {
      hpRegen: (v) => `+${num(v)} HP regen/s`, manaRegen: (v) => `+${num(v)} mana regen/s`, staminaRegen: (v) => `+${num(v)} stamina regen/s`,
      formPower: (v) => `+${num(v)} form power`, critChance: (v) => `+${pct(v)}% crit chance`, critDamage: (v) => `+${pct(v)}% crit damage`,
      attackSpeedMult: (v) => `+${pct(v - 1)}% attack speed`, castSpeedMult: (v) => `+${pct(v - 1)}% cast speed`,
      dodgeChance: (v) => `+${pct(v)}% dodge`, stunChance: (v) => `+${pct(v)}% stun chance`,
      skillDamageMult: (v) => `x${num(v)} skill damage`, lifeCostMultiplier: (v) => `life costs x${num(v)}`,
      manaCostMult: (v) => `mana costs x${num(v)}`, staminaCostMult: (v) => `stamina costs x${num(v)}`,
      projectileCount: (v) => `+${num(v)} projectile`, pierceBonus: (v) => `+${num(v)} pierce`, killHeal: (v) => `+${pct(v)}% life per kill`,
      skillLeech: (v) => `${pct(v)}% skill leech`, aoeRadiusMult: (v) => `+${pct(v - 1)}% area`, projectileSpeedMult: (v) => `+${pct(v - 1)}% projectile speed`,
      meleeReachBonus: (v) => `+${num(v)} melee reach`, regenLifeShare: (v) => `${pct(v)}% of mana regen heals life`,
      cooldownFloor: (v) => `cooldown floor ${num(v)}`, skillCooldownMult: (v) => `skill cooldowns x${num(v)}`, lowLifeDamage: (v) => `+${pct(v)}% damage at low life`,
      fullManaDamage: (v) => `+${pct(v)}% damage at full mana`, auraLeech: (v) => `aura leech ${num(v)}`, reflectShare: (v) => `${pct(v)}% damage reflected`,
      dodgeRiposte: (v) => `${pct(v)}% of a dodged blow sent back`, meleeWaveShare: (v) => `melee wave ${pct(v)}%`, meleeArcBonus: (v) => `melee arc ${num(v)}`,
      manaPerWisdom: (v) => `+${num(v)} max mana per WIS`, auraRadius: (v) => `+${num(v)} aura radius`,
    },
    skillDamage: { strengthSkillDamage: 'STR', dexteritySkillDamage: 'DEX', constitutionSkillDamage: 'CON', intelligenceSkillDamage: 'INT', wisdomSkillDamage: 'WIS', charismaSkillDamage: 'CHA' },
    skillDamageText: (ab, v) => `+${pct(v)}% damage to all ${ab} skills`,
    join: (a) => a.join(', '),
    status: (s) => `hits ${{ burn: 'burn', shock: 'shock', chill: 'chill' }[s] || s}`,
  },
  uk: {
    stat: { strength: 'СИЛ', dexterity: 'СПР', constitution: 'СТА', intelligence: 'ІНТ', wisdom: 'МУД', charisma: 'ХАР' },
    pool: { hp: 'макс. ЗДР', mana: 'макс. мани', stamina: 'макс. витривалості' },
    damage: (el) => el,
    elements: { physical: 'фізичної шкоди', fire: 'шкоди вогнем', ice: 'шкоди льодом', lightning: 'шкоди блискавкою', arcane: 'чародійної шкоди' },
    resist: (el) => `опір: ${el}`,
    unlock: ({ lvl, quests, secret, price }) => `Рів. ${lvl}${quests ? ` · завдання ${quests}` : ''}${secret ? ' (таємний самоцвіт)' : ''} · ${price} з`,
    tree: 'Вузли дерева на цей момент дають',
    nothing: 'Вузли дерева на цей момент дають переважно малі бонуси.',
    rules: {
      hpRegen: (v) => `+${num(v)} ЗДР/с відновлення`, manaRegen: (v) => `+${num(v)} мани/с відновлення`, staminaRegen: (v) => `+${num(v)} витривалості/с відновлення`,
      formPower: (v) => `+${num(v)} сили форм`, critChance: (v) => `+${pct(v)}% шансу крита`, critDamage: (v) => `+${pct(v)}% шкоди крита`,
      attackSpeedMult: (v) => `+${pct(v - 1)}% швидкості атаки`, castSpeedMult: (v) => `+${pct(v - 1)}% швидкості чаклування`,
      dodgeChance: (v) => `+${pct(v)}% ухиляння`, stunChance: (v) => `+${pct(v)}% шансу оглушення`,
      skillDamageMult: (v) => `x${num(v)} шкоди навичок`, lifeCostMultiplier: (v) => `ціна життям x${num(v)}`,
      manaCostMult: (v) => `ціна мани x${num(v)}`, staminaCostMult: (v) => `ціна витривалості x${num(v)}`,
      projectileCount: (v) => `+${num(v)} снаряд`, pierceBonus: (v) => `+${num(v)} пробиття`, killHeal: (v) => `+${pct(v)}% життя за вбивство`,
      skillLeech: (v) => `${pct(v)}% вампіризму навичок`, aoeRadiusMult: (v) => `+${pct(v - 1)}% площі`, projectileSpeedMult: (v) => `+${pct(v - 1)}% швидкості снарядів`,
      meleeReachBonus: (v) => `+${num(v)} дальності ближнього бою`, regenLifeShare: (v) => `${pct(v)}% відновлення мани лікує життя`,
      cooldownFloor: (v) => `мінімум перезарядки ${num(v)}`, skillCooldownMult: (v) => `перезарядки навичок x${num(v)}`, lowLifeDamage: (v) => `+${pct(v)}% шкоди при низькому життю`,
      fullManaDamage: (v) => `+${pct(v)}% шкоди при повній мані`, auraLeech: (v) => `вампіризм аур ${num(v)}`, reflectShare: (v) => `${pct(v)}% шкоди відбито`,
      dodgeRiposte: (v) => `${pct(v)}% ухиленого удару повертається`, meleeWaveShare: (v) => `хвиля ближнього бою ${pct(v)}%`, meleeArcBonus: (v) => `дуга ближнього бою ${num(v)}`,
      manaPerWisdom: (v) => `+${num(v)} макс. мани за МУД`, auraRadius: (v) => `+${num(v)} радіуса аур`,
    },
    skillDamage: { strengthSkillDamage: 'СИЛ', dexteritySkillDamage: 'СПР', constitutionSkillDamage: 'СТА', intelligenceSkillDamage: 'ІНТ', wisdomSkillDamage: 'МУД', charismaSkillDamage: 'ХАР' },
    skillDamageText: (ab, v) => `+${pct(v)}% шкоди всіх навичок ${ab}`,
    join: (a) => a.join(', '),
    status: (s) => `удари ${{ burn: 'підпалюють', shock: 'вражають струмом', chill: 'охолоджують' }[s] || s}`,
  },
};

function num(v) { return String(Math.round(v * 100) / 100); }
function pct(v) { return String(Math.round(v * 1000) / 10); }
const sign = (v) => (v >= 0 ? `+${v}` : `${v}`);

// One grant as a phrase.
function describeGrant(g, lang) {
  const Lg = L[lang];
  const v = Number(g.value) || 0;
  if (g.type === 'stat') return `${sign(v)} ${Lg.stat[g.stat]}`;
  if (g.type === 'resource') return `${sign(v)} ${Lg.pool[g.pool]}`;
  if (g.type === 'damage') return lang === 'en' ? `${sign(v)}% ${Lg.damage(Lg.elements[g.element])}` : `${sign(v)}% ${Lg.elements[g.element]}`;
  if (g.type === 'resist') return lang === 'en' ? `${sign(v)}% ${Lg.resist(Lg.elements[g.element])}` : `${sign(v)}% ${Lg.resist(Lg.elements[g.element].replace(' шкоди', '').replace('шкоди ', ''))}`;
  if (g.type === 'status') return Lg.status(g.status);
  if (g.type === 'rule') {
    if (Lg.skillDamage[g.rule]) return Lg.skillDamageText(Lg.skillDamage[g.rule], v);
    const f = Lg.rules[g.rule];
    return f ? f(v) : null;
  }
  return null;
}

// ---- text helpers --------------------------------------------------------------------------------
function fill(text, lang) {
  return text.replace(/\{([a-z0-9_]+)\}/g, (m, id) => {
    const s = skillById.get(id);
    if (!s) throw new Error(`placeholder ${m} is not a skill`);
    return lang === 'uk' ? s.nameUk : s.nameEn;
  });
}

function unlockLine(skill, lang) {
  const quests = (skill.reqQuests || []).join(', ');
  return L[lang].unlock({ lvl: skill.reqLvl, quests, secret: Boolean(skill.secretGem), price: skill.gemPrice });
}

// ---- passives ------------------------------------------------------------------------------------
const tree = JSON.parse(fs.readFileSync(TREE, 'utf8'));
const graph = buildGraph(tree);

function milestoneText(route, points, lang) {
  const s = sumGrants(graph, route.slice(0, points));
  const Lg = L[lang];
  const parts = [];
  const stats = Object.entries(s.stat).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
  for (const [k, v] of stats) parts.push(`${Lg.stat[k]} +${num(v)}`);
  if (s.pool.hp) parts.push(`${sign(num(s.pool.hp))} ${Lg.pool.hp}`);
  if (s.pool.mana) parts.push(`${sign(num(s.pool.mana))} ${Lg.pool.mana}`);
  if (s.pool.stamina) parts.push(`${sign(num(s.pool.stamina))} ${Lg.pool.stamina}`);
  const dmg = Object.entries(s.damage).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 2);
  for (const [el, v] of dmg) parts.push(lang === 'en' ? `+${num(v)}% ${Lg.elements[el]} damage` : `+${num(v)}% ${Lg.elements[el]}`);
  for (const [rule, f] of [['formPower', 'formPower'], ['critChance', 'critChance'], ['attackSpeedMult', null]]) {
    const v = s.rule[rule];
    if (v && Lg.rules[rule] && rule !== 'attackSpeedMult') parts.push(Lg.rules[rule](v));
  }
  return parts.length ? `${Lg.tree}: ${parts.join(', ')}.` : Lg.nothing;
}

function keyNodes(route) {
  const out = [];
  route.forEach((key, i) => {
    const n = graph.nodes.get(key);
    const hasRule = (n.grants || []).some((g) => g.type === 'rule' || g.type === 'status');
    if (n.kind === 'keystone' || (n.kind === 'greater' && hasRule)) out.push({ key, atStep: i + 1, node: n });
  });
  return out.slice(0, MAX_KEY_NODES);
}

function notePhrase(node, lang) {
  const parts = (node.grants || []).map((g) => describeGrant(g, lang)).filter(Boolean);
  return parts.length ? `${L[lang].join(parts)}.` : (lang === 'en' ? 'A small bonus on the way.' : 'Невеликий бонус дорогою.');
}

const untranslated = new Set();
function labelFor(label, lang) {
  if (lang === 'en') return label;
  setLang('uk');
  const out = t(label);
  if (!hasTranslation(label)) untranslated.add(label);
  setLang('en');
  return out;
}

// ---- assemble ------------------------------------------------------------------------------------
function assemble(build, route, lang) {
  const w = WEIGHTS[build.id];
  const pick = (x) => fill(x[lang], lang);
  const steps = route.map((key) => {
    const n = graph.nodes.get(key);
    return { key, label: labelFor(n.label, lang), kind: n.kind };
  });
  const keys = keyNodes(route);
  return {
    id: build.id,
    className: build.className,
    name: pick(build.name),
    summary: pick(build.summary),
    playstyle: pick(build.playstyle),
    stats: build.stats.map((s) => ({ stat: s.stat, why: pick(s.why) })),
    hotbar: build.hotbar.map((h, i) => {
      const sk = skillOf(h.skillId, build.className);
      return { slot: i + 1, skillId: h.skillId, name: lang === 'uk' ? sk.nameUk : sk.nameEn, unlock: unlockLine(sk, lang), why: pick(h.why) };
    }),
    earlySkills: build.earlySkills.map((e) => {
      const sk = skillOf(e.skillId, build.className);
      return { skillId: e.skillId, name: lang === 'uk' ? sk.nameUk : sk.nameEn, level: sk.reqLvl, note: pick(e.note) };
    }),
    passives: {
      startKey: w.startKey,
      steps,
      milestones: MILESTONES.map((points) => ({ points, summary: milestoneText(route, points, lang) })),
      keystones: keys.map((k) => ({
        key: k.key, label: labelFor(k.node.label, lang), atStep: k.atStep, note: notePhrase(k.node, lang),
      })),
    },
    gear: build.gear.map(pick),
    weaknesses: build.weaknesses.map(pick),
  };
}

// ---- checks that the guides are honest ---------------------------------------------------------
function validate(build, route) {
  const w = WEIGHTS[build.id];
  if (!w) throw new Error(`${build.id}: no weights`);
  if (build.hotbar.length !== 9) throw new Error(`${build.id}: hotbar must have 9 skills`);
  if (new Set(build.hotbar.map((h) => h.skillId)).size !== 9) throw new Error(`${build.id}: duplicate hotbar skill`);
  if (build.stats.length < 3 || build.stats.length > 5) throw new Error(`${build.id}: 3-5 stats`);
  if (route.length !== TOTAL || new Set(route).size !== TOTAL) throw new Error(`${build.id}: route is not ${TOTAL} unique steps`);
  // Every step touches the start node or an earlier step.
  const owned = new Set([w.startKey]);
  route.forEach((k, i) => {
    if (!graph.adj.get(k).some((n) => owned.has(n))) throw new Error(`${build.id}: step ${i + 1} (${k}) touches nothing already taken`);
    owned.add(k);
  });
  const start = graph.nodes.get(w.startKey);
  if (!start || start.startClass !== build.className) throw new Error(`${build.id}: ${w.startKey} is not the ${build.className} start`);
}

// ---- sanity: the unlock lines we make must match the ones already in the hand-written main guides ----
function checkUnlockFormat() {
  const bad = [];
  for (const g of Object.values(BUILD_GUIDES)) {
    for (const h of g.hotbar) {
      const mine = unlockLine(skillById.get(h.skillId), 'en');
      if (mine !== h.unlock) bad.push(`${h.skillId}: "${mine}" vs "${h.unlock}"`);
    }
  }
  return bad;
}

const out = { en: {}, uk: {} };
const report = [];
const mismatches = checkUnlockFormat();
if (mismatches.length) { console.warn(`unlock lines differing from the main guides (${mismatches.length}):\n  ${mismatches.slice(0, 5).join('\n  ')}`); }

for (const build of BUILDS) {
  const w = WEIGHTS[build.id];
  const route = buildRoute(graph, { startKey: w.startKey, weights: w, must: w.must, total: TOTAL });
  validate(build, route);
  for (const lang of ['en', 'uk']) {
    (out[lang][build.className] = out[lang][build.className] || []).push(assemble(build, route, lang));
  }
  report.push(`${build.id}: ${route.length} steps`);
}

const header = (name, lang) => `// GENERATED by frontend/scripts/build-guides/generate.mjs -- do not edit by hand.
// The extra builds (2nd and 3rd) of every class for the Build Guide window (${lang}). Each class lists them in the
// order the window offers them, after the hand-written main build in ${lang === 'uk' ? 'buildGuides.uk.data.js' : 'buildGuides.data.js'}.
// Passive routes are laid out on the real passive tree (every step touches an earlier one); text comes from
// scripts/build-guides/texts/. Edit those, then run \`make build-guides\`.

export const ${name} = `;

for (const [lang, name] of [['en', 'BUILD_GUIDE_VARIANTS'], ['uk', 'BUILD_GUIDE_VARIANTS_UK']]) {
  const ordered = {};
  for (const c of CLASS_ORDER) if (out[lang][c]) ordered[c] = out[lang][c];
  const file = new URL(lang === 'uk' ? 'buildGuides.variants.uk.data.js' : 'buildGuides.variants.data.js', CORE);
  fs.writeFileSync(file, `${header(name, lang)}${JSON.stringify(ordered, null, 2)};\n`);
}

console.log(report.join('\n'));
console.log(`untranslated passive labels (${untranslated.size}):`, [...untranslated].slice(0, 12).join(' | '));
