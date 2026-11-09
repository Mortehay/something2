// Turns an art-catalogue subject into the plain visible phrase consumed by the
// image prompt wrapper. Each subject kind has its own contract: an item or icon
// is one physical object, a character appearance is one complete hero, an
// entity is the creature, person or world object it names, and a tile is a
// patch of ground.
// Styling, background and camera direction stay downstream in artDispatcher.
const defaultTextProvider = require('./textProvider');
const { TILE_FRAMING } = require('./biomePrompt.js');

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

// An entity is a whole figure or prop, so it needs more room than an icon but
// carries no class or appearance direction to spell out.
const ENTITY_LENGTHS = {
  short: { words: 15, tokens: 70 },
  medium: { words: 28, tokens: 120 },
  long: { words: 45, tokens: 200 },
};

// An effect description is one short noun phrase; the box wraps it itself.
const EFFECT_LENGTHS = {
  short: { words: 20, tokens: 90 },
  medium: { words: 40, tokens: 160 },
  long: { words: 40, tokens: 160 },
};

function budgetFor(subject, length) {
  const kind = subject && subject.kind;
  const lengths = kind === 'character_appearance' ? HERO_LENGTHS
    : kind === 'entity' ? ENTITY_LENGTHS
      : (kind === 'vfx' || kind === 'aura') ? EFFECT_LENGTHS : LENGTHS;
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

// SOMET-682. Entities had no contract and fell back to the ITEM one, so every
// regenerated entity came back as something it carries: Village Blacksmith ->
// "rusty iron hammer", Captain Valdor -> "tricorn hat", 16 of 16.
const ENTITY_RULES = [
  'Reply with ONE noun phrase describing the subject ITSELF: the whole creature,',
  '  person, monster or world object the name refers to.',
  'NEVER answer with something the subject holds, wears or uses. A blacksmith is',
  '  a person, not a hammer; a captain is a person, not a hat.',
  'A creature or person is shown full-body. Describe build, face or head,',
  '  clothing or hide, and at most one or two signature carried items.',
  'The current prompt, when given, is the truth about what the subject is. Keep',
  '  every identity cue it states and add visible detail; never contradict it.',
  'No sentences, preamble, quotes or trailing full stop.',
  'Describe only visible features. Never name the art style, medium, background,',
  '  framing, camera angle, image dimensions or transparency -- those are added later.',
  'No scenery, floor, landscape or second character.',
  '  Never place the subject on, in or beside anything: no throne, nest, hive,',
  '  altar, cart or building it sits on, tends or stands before.',
  'Never write the subject\'s own name in the answer; describe it instead.',
  'Do not use vague quality words such as epic, amazing, detailed or beautiful.',
].join('\n');

const TILE_RULES = [
  'Reply with ONE noun phrase describing the SURFACE of one map tile: ground,',
  '  floor, water, or the face of a wall, door or gate.',
  'Name the material and its visible texture: grain, cracks, pebbles, blades,',
  '  ripples, moss, planks, mortar. It must read as a texture that repeats seamlessly.',
  'Never a separate object, creature, person, horizon or sky. Never name the view',
  '  or camera -- that is added later.',
  'The current prompt, when given, is the truth about what the ground is. Keep',
  '  it and add visible detail; never contradict it.',
  'Do not name a colour palette or art style -- the biome adds those later.',
  'No sentences, preamble, quotes or trailing full stop.',
].join('\n');

// The box wraps an effect prompt in its own style and background text, so the
// description is the subject only.
const EFFECT_RULES = [
  'Reply with ONE noun phrase giving the effect\'s shape, motion, colours and materials.',
  'No style or medium words (pixel art, sprite, game asset).',
  'No background or scene words (ground, floor, sky, background, scene).',
  'No negations: never write "no", "not" or "without".',
  'No sentences, no preamble, no quotes, no trailing full stop.',
  'Keep every colour the current prompt states.',
].join('\n');

// Exemplars are made-up subjects, never batch-1 effects (SOMET-682: copied verbatim).
const EFFECT_CONTRACT = {
  role: 'You describe ONE animated visual effect for a game effect strip.',
  ask: 'Describe this effect itself.',
  rules: EFFECT_RULES,
  examples: [
    ['thorn_lash; Type: projectile; current prompt: thorn lash, green',
      'spinning green thorn spike trailing curling vine tendrils and pale sap droplets'],
    ['rune_pulse; Type: burst; current prompt: rune pulse, violet',
      'expanding violet ring of glowing glyphs breaking into drifting sparks'],
    ['sunlance; Type: beam; current prompt: sunlance, gold',
      'straight gold beam with a white-hot core, rippling edges and flickering motes'],
    ['moss_halo; Type: aura; current prompt: moss halo, green',
      'slowly rotating halo of green moss clumps and floating spores'],
  ],
};

const CONTRACTS = {
  vfx: EFFECT_CONTRACT,
  aura: EFFECT_CONTRACT,
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
  // Exemplars are deliberately NOT catalogue subjects: a live probe with the
  // real Village Blacksmith as an exemplar got the exemplar back verbatim.
  entity: {
    role: 'You are the concept writer for a fantasy RPG. Describe ONE game ENTITY -- the creature, person or world object the name refers to -- never an item it carries.',
    ask: 'Describe this entity itself, as one visible whole.',
    rules: ENTITY_RULES,
    examples: [
      ['Harbor Fishmonger; current prompt: a stout fishmonger in an oilskin apron behind a fish crate',
        'stout red-cheeked fishmonger with a knitted cap, glistening oilskin apron, rolled sleeves and a gutting knife at the belt'],
      ['Frost Wisp Swarm; current prompt: a tiny ice-touched wisp creature',
        'tiny floating wisp of pale blue frost with a jagged icicle tail and two glinting white eyes'],
      ['broken_cart; current prompt: an abandoned wooden cart with a broken wheel',
        'tilted wooden farm cart with a cracked spoked wheel, splintered side boards and a frayed rope'],
      ['Ember Crone; current prompt: an old witch tending a cauldron on a hearth',
        'hunched old witch with ash-grey hair, a soot-streaked shawl and glowing ember eyes, gripping a charred ladle'],
    ],
  },
  tile: {
    role: 'You describe the SURFACE of one map tile for a fantasy game: ground, floor, water, or the face of a wall, door or gate.',
    ask: 'Describe this surface.',
    rules: TILE_RULES,
    examples: [
      ['mud_flat; current prompt: wet brown mud ground', 'wet brown mud with shallow puddles, boot ruts and scattered reeds'],
      ['slate_roof; current prompt: grey slate tile surface', 'overlapping grey slate tiles with chipped edges and lichen spots'],
      ['iron_door; current prompt: riveted iron door', 'dark riveted iron plates with rust streaks and a heavy crossbar'],
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

// SOMET-568. A `rule` grant names a FORMULA, and its identifier is the name of
// that formula in the code -- `meleeWaveShare`, `cooldownFloor`. Rendered raw,
// the labels whose ONLY grant is a rule were described from one camelCase token.
//
// EACH PHRASE WAS READ OFF ITS CONSUMER (RULE_KEYS[rule].consumer in
// seeds/data/passiveTree.js), not guessed from the name. Two mislead:
//   auraLeech      "leech" reads as draining an enemy; world.js says "It HEALS
//                  and never drains" -- a healing aura.
//   regenLifeShare not a second health regen: the share rides the mana
//                  ACTUALLY regenerated.
//
// DIRECTION. The tree uses several rules both ways -- Whirlwind pairs a wide arc
// with meleeDamageMult 0.8, Spearpoint carries meleeArcBonus -0.5 -- so a rule
// that can cut both ways is { pivot, more, less }: `more` above the pivot (1 for
// a multiplier, 0 for a bonus), `less` below it, nothing AT it. A plain string
// is for a rule the tree only uses one way (cooldownFloor is min-combined, so
// only a lower floor ever changes anything).
//
// NO NUMBERS: these are multipliers, floors and shares whose meaning is not
// readable from the digits (cooldownFloor 0.32 is BETTER than 0.40), and a model
// handed the digits may draw them.
const RULE_PHRASES = {
  lifeCostMultiplier: { pivot: 1, more: 'abilities cost more life', less: 'abilities cost less life' },
  treeCharmBonus: { pivot: 0, more: 'charms more creatures to fight alongside you', less: 'charms fewer creatures to fight alongside you' },
  cooldownFloor: 'abilities recharge faster',
  regenLifeShare: 'regenerating mana also restores life',
  attackSpeedMult: { pivot: 1, more: 'attacks faster', less: 'attacks slower' },
  castSpeedMult: { pivot: 1, more: 'casts spells faster', less: 'casts spells slower' },
  meleeReachBonus: { pivot: 0, more: 'strikes from further away', less: 'strikes at shorter reach' },
  meleeArcBonus: { pivot: 0, more: 'strikes through a wider arc', less: 'strikes through a narrower arc' },
  projectileCount: { pivot: 0, more: 'fires extra projectiles', less: 'fires fewer projectiles' },
  projectileSpeedMult: { pivot: 1, more: 'projectiles fly faster', less: 'projectiles fly slower' },
  pierceBonus: { pivot: 0, more: 'projectiles pierce through enemies', less: 'projectiles pierce fewer enemies' },
  auraLeech: 'a healing aura',
  auraRadius: { pivot: 0, more: 'a wider aura', less: 'a smaller aura' },
  meleeDamageMult: { pivot: 1, more: 'heavier melee blows', less: 'lighter melee blows' },
  meleeWaveShare: 'melee blows send out a shockwave',
  hpRegen: { pivot: 0, more: 'regenerates health faster', less: 'regenerates health slower' },
  manaRegen: { pivot: 0, more: 'regenerates mana faster', less: 'regenerates mana slower' },
  staminaRegen: { pivot: 0, more: 'regenerates stamina faster', less: 'regenerates stamina slower' },
  formPower: { pivot: 0, more: 'shapeshift forms are stronger', less: 'shapeshift forms are weaker' },
  strengthSkillDamage: { pivot: 0, more: 'strength-based skills hit harder', less: 'strength-based skills hit softer' },
  dexteritySkillDamage: { pivot: 0, more: 'dexterity-based skills hit harder', less: 'dexterity-based skills hit softer' },
  constitutionSkillDamage: { pivot: 0, more: 'constitution-based skills hit harder', less: 'constitution-based skills hit softer' },
  intelligenceSkillDamage: { pivot: 0, more: 'intelligence-based skills hit harder', less: 'intelligence-based skills hit softer' },
  wisdomSkillDamage: { pivot: 0, more: 'wisdom-based skills hit harder', less: 'wisdom-based skills hit softer' },
  charismaSkillDamage: { pivot: 0, more: 'charisma-based skills hit harder', less: 'charisma-based skills hit softer' },
  skillDamageMult: { pivot: 1, more: 'every skill hits harder', less: 'every skill hits softer' },
  lowLifeDamage: 'skills hit harder while badly wounded',
  fullManaDamage: 'skills hit harder while mana is nearly full',
  critChance: { pivot: 0, more: 'critical strikes are more likely', less: 'critical strikes are less likely' },
  critDamage: { pivot: 0, more: 'critical strikes hit harder', less: 'critical strikes hit softer' },
  manaCostMult: { pivot: 1, more: 'skills cost more mana', less: 'skills cost less mana' },
  staminaCostMult: { pivot: 1, more: 'skills cost more stamina', less: 'skills cost less stamina' },
  skillCooldownMult: { pivot: 1, more: 'skills recharge slower', less: 'skills recharge faster' },
  skillLeech: 'skills heal a share of the damage they deal',
  killHeal: 'killing a creature restores life',
  spellLevelBonus: 'spells are of a higher level',
  stunChance: 'hits may stun',
  dodgeChance: 'blows may be dodged outright',
  dodgeStamina: 'dodging a blow restores stamina',
  dodgeRiposte: 'a dodged blow is partly sent back at the attacker',
  reflectShare: 'a share of each blow is sent back at the attacker',
  aoeRadiusMult: { pivot: 1, more: 'area skills cover more ground', less: 'area skills cover less ground' },
  manaPerWisdom: { pivot: 0, more: 'wisdom grants maximum mana', less: 'wisdom grants less maximum mana' },
};

// An UNMAPPED rule is DROPPED rather than passed through as camelCase -- the
// same rule as grantsPhrase's `default`. The staleness test against RULE_KEYS
// and the generated tree is what stops that being a silent hole.
function rulePhrase(g) {
  const p = Object.prototype.hasOwnProperty.call(RULE_PHRASES, g.rule) ? RULE_PHRASES[g.rule] : null;
  if (!p) return '';
  if (typeof p === 'string') return p;
  const v = Number(g.value);
  if (!Number.isFinite(v) || v === p.pivot) return '';
  return v > p.pivot ? p.more : p.less;
}

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
      case 'rule': return rulePhrase(g);
      default: return '';
    }
  }).filter(Boolean).join(', ');
}

// The framing a hand-written entity prompt often carries ("pixel art, ...,
// single object, solid transparent background"). It is added downstream, and a
// model shown it tends to echo it back into the subject phrase.
const STYLE_PHRASES = [
  /^pixel art( boss creature)?\s*,\s*/i,
  /,\s*single object\b.*$/i,
  TILE_FRAMING,
];

function plainPrompt(prompt) {
  return STYLE_PHRASES.reduce((out, re) => out.replace(re, ''), String(prompt || '')).trim();
}

function subjectContext(subject) {
  const name = subject.name || subject.key;
  const bits = [`Name: ${name}`];
  // SOMET-682. The subject's existing prompt is the truth about WHAT it is. An
  // entity's is often the only description there is; without it the model had
  // just a name to go on.
  const current = plainPrompt(subject.basePrompt);
  if (current && current.toLowerCase() !== String(name).toLowerCase()) {
    bits.push(`Current prompt: ${current}`);
  }
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
  // No fallback. Borrowing another kind's contract is how entities were
  // described as items (SOMET-682); a new kind must say what it is.
  const contract = Object.prototype.hasOwnProperty.call(CONTRACTS, subject.kind)
    ? CONTRACTS[subject.kind] : null;
  if (!contract) throw new Error(`no description contract for subject kind: ${subject.kind}`);
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

// SOMET-683. The entity contract forbids scenery and the subject's own name, and
// the describer breaks both anyway (a prompt rule is a request, not a gate):
// "seated upon a throne of fused bones" drew the throne, "tending burning hive
// cells" drew a honeycomb, "abyssor, a towering voidreaver" repeated the name.
// Entity kind only -- an item's "on" is part of what it is.
const SCENERY_TAIL = new RegExp(
  '[,;]?\\s+(?:'
  + '(?:seated|sitting|perched|enthroned|lying|resting|standing|kneeling)\\s+(?:up)?on\\b'
  + '|(?:(?:seated|sitting|perched|lying|resting|standing|kneeling)\\s+)?(?:tending|guarding|amid|amidst|among|surrounded by|in front of|before|beside|next to|atop|on top of)\\b'
  + '|(?:in|inside|within)\\s+(?:a|an|the)\\s+(?:\\w+\\s+){0,2}(?:lair|nest|hive|cave|chamber|hall|room|forest|swamp|ruin|ruins|dungeon|temple)\\b'
  + ').*$', 'i');
const MIN_ENTITY_WORDS = 3;

function stripScenery(text) {
  const cut = text.replace(SCENERY_TAIL, '').trim();
  // A cut that leaves almost nothing means the scenery WAS the description;
  // keep the original rather than hand the image model a stub.
  return cut.split(/\s+/).filter(Boolean).length >= MIN_ENTITY_WORDS ? cut : text;
}

function stripOwnName(text, name) {
  const lower = String(name || '').toLowerCase().trim();
  if (!lower) return text;
  // "Abyssor, the Voidreaver" -> both the whole name and the part before the comma.
  const variants = [...new Set([lower, lower.split(',')[0].trim()])].filter((v) => v.length >= 3);
  for (const v of variants) {
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stripped = text.replace(new RegExp(`^${esc}\\b\\s*[,:\\u2013-]?\\s*`, 'i'), '')
      .replace(/^(a|an|the)\s+/i, '');
    if (stripped !== text && stripped.split(/\s+/).filter(Boolean).length >= MIN_ENTITY_WORDS) {
      return stripped;
    }
  }
  return text;
}

// Effects: the box adds style and background itself, so drop any the model wrote.
const EFFECT_STYLE_RE = /\b(?:pixel[- ]art|pixel|sprite[- ](?:sheet|strip)|sprite|8-bit|16-bit|game asset|transparent)\b/gi;
const EFFECT_SCENE_RE = /(?:\b(?:on|against|over)\s+(?:(?:a|the)\s+)?(?:[\w-]+\s+){0,4}?(?:background|backdrop|ground|floor|sky)(?![\w-]))|\b(?:background|backdrop|scene|landscape)(?![\w-])/gi;

function tidyEffect(t) {
  return t.replace(/\s+,/g, ',').replace(/(?:,\s*){2,}/g, ', ')
    .replace(/^[\s,]+|[\s,]+$/g, '').replace(/\s{2,}/g, ' ');
}

function stripEffectStyle(text) {
  const src = String(text || '');
  const full = tidyEffect(src.replace(EFFECT_SCENE_RE, '').replace(EFFECT_STYLE_RE, ''));
  if (/[a-z]{2,}/i.test(full)) return full;
  // Stripping must never leave nothing: keep the text, drop only style words.
  return tidyEffect(src.replace(EFFECT_STYLE_RE, '')) || src.trim();
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
  out = out.toLowerCase();
  if (subject && subject.kind === 'entity') {
    out = stripScenery(stripOwnName(out, subject.name || subject.key));
  }
  if (subject && (subject.kind === 'vfx' || subject.kind === 'aura')) {
    out = stripEffectStyle(out);
  }
  return out;
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
  describeSubject, buildMessages, clean, subjectContext, grantsPhrase, RULE_PHRASES, budgetFor,
  LENGTHS, HERO_LENGTHS, ENTITY_LENGTHS, EFFECT_LENGTHS, stripEffectStyle, CONTRACTS, TEMPERATURE, plainPrompt,
};
