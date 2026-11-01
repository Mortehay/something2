'use strict';

// Skill synergies and Druid-form gating. PURE rules plus two small bits of
// per-player state (p._synPrimers, p._chain), no clock of their own.
//
// SYNERGIES. Every skill carries TAGS (from its type and its name). Casting a
// skill PRIMES its tags for a few seconds; casting a different skill whose tags
// complete a synergy while a matching primer is live multiplies that cast's
// damage and consumes the primer: ice then fire is "Shatter", a curse then a
// strike is "Exploit Weakness", and so on. Independent of that, casting a
// DIFFERENT skill within a short gap of the last cast builds a chain, +6% a
// link up to +18%, so rotating skills beats spamming one.
//
// The client mirrors skillTags / SYNERGIES in core/skillsData.js (a parity test
// pins them) so a tooltip can name what a skill pairs with.

const PRIMER_MS = 5000;
const CHAIN_WINDOW_MS = 3500;
const CHAIN_STEP = 0.06;
const CHAIN_MAX = 3;

// Keyword rules run against the id WITHOUT its class prefix.
const TAG_RULES = [
  ['ice', /frost|ice|blizzard|freez|chill|glaci|snow|deep_comet/],
  ['fire', /fire|flame|ignite|ember|meteor|combustion|immolat|scorch|dragons_breath|explosive|solar/],
  ['lightning', /lightning|storm|thunder|static|shock|discharge|overload|spark|heavenly|cyclone/],
  ['poison', /poison|venom|plague|neurotox|rot|spore|ivy|swarm|toxic|insect/],
  ['bleed', /bleed|blood|rend|rip|slit|gouge|wound|maim|hemophilia|vein|mangle|scythe|bite|heartseeker|throat|stab/],
  ['control', /root|entangl|hibernate|paraly|hamstring|trip|_net|slow|silence|polymorph|bash|stun|taunt|lock|block|disorient|cripple|constrict|vine|trap|sand|blind|pressure_point|off_balance|winded|gravity|singularity|temporal/],
  ['mark', /mark|expose|vulnerab|sunder|weaken|eagle_eye|brand/],
  ['shadow', /shadow|abyssal|void|dark|curse|black_|death|umbral|soul/],
];

const tagCache = new Map();

function stripClassPrefix(id) {
  return String(id || '').replace(/^[a-z]{3}_/, '');
}

// The tag set of a skill: its type ('melee' | 'magic' | 'buff' | 'debuff'),
// an explicit element if it has one, and every keyword rule its name matches.
function skillTags(skill) {
  if (!skill) return new Set();
  const hit = tagCache.get(skill.id);
  if (hit) return hit;
  const tags = new Set();
  if (skill.type) tags.add(skill.type);
  if (skill.element && typeof skill.element === 'string') tags.add(skill.element);
  const name = stripClassPrefix(skill.id);
  for (const [tag, re] of TAG_RULES) if (re.test(name)) tags.add(tag);
  if (skill.type === 'debuff') tags.add('curse');
  tagCache.set(skill.id, tags);
  return tags;
}

// from: any of these tags primes it. to: any of these tags on the cast completes it.
const SYNERGIES = [
  { name: 'Shatter', from: ['ice'], to: ['fire', 'melee'], mult: 1.30 },
  { name: 'Thermal Shock', from: ['fire'], to: ['ice'], mult: 1.25 },
  { name: 'Conduction', from: ['lightning'], to: ['melee'], mult: 1.25 },
  { name: 'Catalyst', from: ['poison'], to: ['fire', 'lightning'], mult: 1.30 },
  { name: 'Ambush', from: ['control'], to: ['melee', 'bleed'], mult: 1.30 },
  { name: 'Exploit Weakness', from: ['curse', 'mark'], to: ['melee', 'magic'], mult: 1.20 },
  { name: 'Empowered Strike', from: ['buff'], to: ['melee'], mult: 1.15 },
  { name: 'Blood Poisoning', from: ['bleed'], to: ['poison', 'shadow'], mult: 1.25 },
  { name: 'Eclipse', from: ['shadow'], to: ['lightning', 'fire'], mult: 1.20 },
];

// What a cast earns, and the state it leaves behind. `now` is the world clock.
// Returns { mult, name, chain }: mult 1 and name null when nothing applies.
function onCast(p, skill, now) {
  const tags = skillTags(skill);
  const damaging = skill.type !== 'buff';

  // Chain: a different skill soon after the last one.
  const prev = p._chain;
  let chain = 0;
  if (prev && prev.skillId !== skill.id && now - prev.at <= CHAIN_WINDOW_MS) {
    chain = Math.min(CHAIN_MAX, prev.n + 1);
  }
  p._chain = { skillId: skill.id, at: now, n: chain };

  // Synergy: the best live primer (from a different skill) this cast completes.
  if (!p._synPrimers) p._synPrimers = new Map();
  let best = null;
  if (damaging) {
    for (const syn of SYNERGIES) {
      if (!syn.to.some((t) => tags.has(t))) continue;
      const tag = syn.from.find((t) => {
        const pr = p._synPrimers.get(t);
        return pr && pr.until > now && pr.skillId !== skill.id;
      });
      if (tag && (!best || syn.mult > best.syn.mult)) best = { syn, tag };
    }
  }
  if (best) p._synPrimers.delete(best.tag);

  // This cast primes its own tags.
  for (const t of tags) p._synPrimers.set(t, { skillId: skill.id, until: now + PRIMER_MS });

  const chainMult = 1 + CHAIN_STEP * chain;
  return {
    mult: (best ? best.syn.mult : 1) * (damaging ? chainMult : 1),
    name: best ? best.syn.name : null,
    chain: damaging ? chain : 0,
  };
}

module.exports = {
  PRIMER_MS, CHAIN_WINDOW_MS, CHAIN_STEP, CHAIN_MAX,
  TAG_RULES, SYNERGIES, skillTags, onCast,
};
