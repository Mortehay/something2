// Turns an art-catalogue subject into the plain visible phrase consumed by the
// image prompt wrapper. Each subject kind has its own contract: an item or icon
// is one physical object, while a character appearance is one complete hero.
// Styling, background and camera direction stay downstream in artDispatcher.
const defaultTextProvider = require('./textProvider');

const TEMPERATURE = () => {
  const raw = parseFloat(process.env.ART_DESCRIBER_TEMPERATURE);
  return Number.isFinite(raw) ? raw : 0.15;
};

// Icon phrases should be terse. A hero needs enough room to preserve class,
// anatomy, clothing, equipment and the selected appearance without collapsing
// into the same generic armored figure.
const LENGTHS = {
  short: { words: 8, tokens: 40 },
  medium: { words: 16, tokens: 70 },
  long: { words: 30, tokens: 120 },
};
const HERO_LENGTHS = {
  short: { words: 30, tokens: 120 },
  medium: { words: 55, tokens: 220 },
  long: { words: 90, tokens: 360 },
};

function budgetFor(subject, length) {
  const lengths = subject && subject.kind === 'character_appearance' ? HERO_LENGTHS : LENGTHS;
  return lengths[length] || lengths.medium;
}

const ICON_RULES = [
  'Reply with ONE noun phrase naming ONE physical object.',
  'Never describe an action, an event, or two things interacting. "axe cleaving',
  '  through stone" is wrong -- it names two objects and a verb. "heavy war axe',
  '  with a chipped blade" is right.',
  'No sentences, no preamble, no quotes, no trailing full stop.',
  'Describe only what is visible. Never name the art style, the medium, the',
  '  background, the framing, or the view angle -- those are added later.',
  'The object must have a PHYSICAL FORM you could hold or point at. Wind, auras,',
  '  light, overlays and "energy" are not forms. If an effect has no natural',
  '  form, name the WEAPON, TOOL or EMBLEM associated with it instead.',
  'Never mention a person, a character, a hand, or who uses the thing.',
  'Never name a BODY PART. No fist, no hand, no skull, no claw.',
  'IF THE NAME ALREADY CONTAINS A PHYSICAL OBJECT, THAT OBJECT IS THE ANSWER.',
  '  "Shield Slam" is a SHIELD. Name that object, then describe it.',
  'Use a colour only when the name or effect implies one.',
  'The answer must contain something that could NOT be said of a plain sword.',
  '  Take the distinguishing detail from the name -- blood, bone, chain, wave,',
  '  steel, thunder -- and put it in the object.',
].join('\n');

const HERO_RULES = [
  'Reply with ONE noun phrase describing ONE complete full-body hero.',
  'Keep the named class immediately recognizable through clothing, equipment,',
  '  materials and silhouette. Preserve every supplied identity cue.',
  'Make the selected appearance direction visible; do not merely repeat its label.',
  'Describe a normal coherent anatomy, face or head, clothing and carried gear.',
  'Give the hero only the class equipment requested. Do not add extra weapons.',
  'No companions, mounts, scenery, floor, pedestal, spell effects or action scene.',
  'No sentences, preamble, quotes or trailing full stop.',
  'Describe only visible features. Never name the art style, medium, background,',
  '  framing, camera angle, image dimensions or UI purpose -- those are added later.',
  'Do not use vague quality words such as epic, amazing, detailed or beautiful.',
].join('\n');

const CONTRACTS = {
  item: {
    role: 'You name what a fantasy game ITEM looks like, for a small icon.',
    ask: 'Describe the object itself.',
    rules: ICON_RULES,
    examples: [
      ['iron-spear (weapon)', 'long iron spear with a leaf-shaped head'],
      ['obsidian-plate (armor)', 'blackened plate cuirass with sharp obsidian edges'],
      ['void-signet (ring)', 'dark metal signet ring set with a starless black stone'],
    ],
  },
  skill: {
    role: 'You name the ICON for a fantasy game ABILITY. The icon is ONE physical object that suggests the effect -- never the character who uses it, and never the action itself.',
    ask: 'Name the single object that would appear on this ability\'s icon.',
    rules: ICON_RULES,
    examples: [
      ['Bone Storm (Cultist, magic)', 'cluster of jagged bone shards'],
      ['Thunder Strike (Warrior, magic)', 'forked lightning bolt'],
      ['Fan of Knives (Archer, melee)', 'five throwing knives spread in a fan'],
      ['Whirlwind (Warrior, melee)', 'battle axe with a spiral-etched blade'],
      ['Shield Slam (Warrior, melee)', 'round iron shield with a spiked boss'],
      ['Blood Harvest (Warrior, melee)', 'curved reaping scythe with a blood-filled groove'],
    ],
  },
  passive_label: {
    role: 'You name the ICON for a passive character bonus. The icon is a small emblem standing for the effect, never a person.',
    ask: 'Describe a single emblem that stands for this bonus.',
    rules: ICON_RULES,
    examples: [
      ['Fleet - cooldown floor drops from 0.40 to 0.32', 'winged boot'],
      ['Cryomancy - +35% ice damage, hits chill', 'jagged ice crystal'],
      ['Sanguine Aura', 'red gemstone ringed in gold'],
    ],
  },
  character_appearance: {
    role: 'You are the character concept writer for a fantasy RPG. Describe ONE full-body fantasy game HERO, not an item or an icon.',
    ask: 'Describe this specific class and appearance as one coherent visible hero.',
    rules: HERO_RULES,
    examples: [
      ['Warrior; practical leather armor and short sword; battle-worn veteran',
        'battle-worn warrior with a square weathered face, cropped dark hair, repaired brown leather armor, iron shoulder guards, red sash and one nicked short sword'],
      ['Mage; layered arcane robes, apprentice staff and ward focus; ceremonial scholar',
        'composed mage with a narrow face, silver-bound blue robes, embroidered sleeves, brass ward medallion and one ashwood apprentice staff capped by a violet crystal'],
      ['Druid; leaf-and-bark robes, wooden club and animal charm; rugged wilderness exile',
        'weathered druid with braided auburn hair, layered moss-green robes, bark shoulder mantle, bone animal charm and one knotty wooden club wrapped in vines'],
    ],
  },
};

function grantsPhrase(grants) {
  if (!Array.isArray(grants) || !grants.length) return '';
  return grants.map((g) => {
    if (!g || typeof g !== 'object') return '';
    switch (g.type) {
      case 'stat': return `+${g.value} ${g.stat}`;
      case 'damage': return `+${g.value} ${g.element} damage`;
      case 'resist': return `+${g.value} ${g.element} resistance`;
      case 'resource': return `+${g.value} ${g.pool}`;
      case 'status': return `inflicts ${g.status}`;
      case 'rule': return `${g.rule} ${g.value}`;
      default: return '';
    }
  }).filter(Boolean).join(', ');
}

function subjectContext(subject) {
  const bits = [`Name: ${subject.name || subject.key}`];
  if (subject.kind === 'passive_label') {
    const effect = grantsPhrase(subject.grants);
    if (effect) bits.push(`Effect: ${effect}`);
  }
  if (subject.row) {
    if (subject.row.class_name) bits.push(`Class: ${subject.row.class_name}`);
    if (subject.row.class_identity) bits.push(`Class identity: ${subject.row.class_identity}`);
    if (subject.row.variant_direction) bits.push(`Appearance direction: ${subject.row.variant_direction}`);
    for (const [label, field] of [['Category', 'category'], ['Element', 'element'],
      ['Class', 'class'], ['Type', 'type'], ['Rarity', 'rarity']]) {
      if (subject.row[field]) bits.push(`${label}: ${subject.row[field]}`);
    }
  }
  return bits.join('\n');
}

function buildMessages(subject, length) {
  const contract = CONTRACTS[subject.kind] || CONTRACTS.item;
  const budget = budgetFor(subject, length);
  const shots = contract.examples.map(([q, a]) => `Subject: ${q}\nAnswer: ${a}`).join('\n\n');
  return [
    {
      role: 'system',
      content: `${contract.role}\n\n${contract.rules}\nAt most ${budget.words} words.\n\nExamples:\n${shots}`,
    },
    { role: 'user', content: `${subjectContext(subject)}\n\n${contract.ask}` },
  ];
}

function clean(text, length, subject = null) {
  const budget = budgetFor(subject, length);
  let out = String(text || '').trim();
  out = out.replace(/^(answer|subject|description)\s*:\s*/i, '');
  out = out.replace(/^["'`]+|["'`]+$/g, '');
  out = out.split('\n')[0].trim();
  out = out.replace(/[.]+$/, '');
  out = out.replace(/^(a|an|the)\s+/i, '');
  const words = out.split(/\s+/).filter(Boolean);
  if (words.length > budget.words * 1.5) out = words.slice(0, budget.words).join(' ');
  return out.toLowerCase();
}

async function describeSubject(db, subject, {
  length = 'medium', fetchImpl = fetch, textProvider = defaultTextProvider, boxOnly = false,
} = {}) {
  const budget = budgetFor(subject, length);
  const messages = buildMessages(subject, length);
  const result = await textProvider.complete(db, {
    system: messages[0].content,
    prompt: messages[1].content,
    maxTokens: budget.tokens,
    temperature: TEMPERATURE(),
  }, { fetchImpl, boxOnly });
  if (!result.ok) {
    const err = new Error(result.error || 'text provider failed');
    err.busy = Boolean(result.busy);
    err.via = result.via;
    throw err;
  }
  const text = clean(result.text, length, subject);
  if (!text) throw new Error('describer returned nothing usable');
  return { text, model: result.model, length, via: result.via };
}

module.exports = {
  describeSubject, buildMessages, clean, subjectContext, grantsPhrase, budgetFor,
  LENGTHS, HERO_LENGTHS, CONTRACTS, TEMPERATURE,
};
