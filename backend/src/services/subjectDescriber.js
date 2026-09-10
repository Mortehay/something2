// SOMET-550. Ask a local model what a subject actually looks like.
//
// THE PROBLEM. Base prompts are built by template from a row's name
// (catalogSubjects.js): `a ${deslug(name)}, a fantasy ${category}`. That gives
// "a darts, a fantasy weapon", which SDXL drew as a DARTBOARD. For the abstract
// kinds it is worse, and they are the bulk of the work -- of 530 subjects
// missing art, 428 are skills and passive labels:
//
//   skill          "Bone Storm, a Cultist magic ability"  -> draws a cultist
//   passive_label  "Fleet"                                -> one abstract word
//
// A DIFFERENT CONTRACT PER KIND, because "describe the object" is the wrong
// instruction for two of the three kinds. An ability is not a thing with a
// shape; it needs an ICON standing for it. Asking for an object is what makes
// the model draw the warrior who casts Crushing Blow rather than the blow.
//
// FEW-SHOT, NOT JUST AN INSTRUCTION. At 7B a system prompt alone drifts in form
// within a few dozen calls, and inconsistent phrasing across ~1000 rows becomes
// inconsistent art. The exemplars are the thing holding the voice steady, so
// they are hand-written and deliberately boring.
//
// The output feeds buildObjectPrompt as the SUBJECT only. It must never carry
// styling ("pixel art", "isometric"), a backdrop, or framing -- those are added
// downstream and saying them twice is how a prompt starts fighting itself.

const ENDPOINT = () => process.env.ART_DESCRIBER_URL
  || 'http://localhost:20434/v1/chat/completions';
const MODEL = () => process.env.ART_DESCRIBER_MODEL || 'qwen2.5-coder:7b';
const TIMEOUT_MS = () => parseInt(process.env.ART_DESCRIBER_TIMEOUT_MS || '120000', 10);
// SOMET-552. Measured: at 0.4 the SAME subject came back differently on 13 of
// 20 re-runs -- "curved saber with a thick, sinewy tendon" one run, "curved
// saber with a looped cord" the next. That instability is not a style choice,
// it defeats the point of storing the description at all: a re-run is supposed
// to be a deliberate new artefact, not a coin flip, and comparing two runs of
// anything is impossible when the baseline moves on its own.
const TEMPERATURE = () => {
  const raw = parseFloat(process.env.ART_DESCRIBER_TEMPERATURE);
  return Number.isFinite(raw) ? raw : 0.15;
};

// Word budgets rather than token counts: the model obeys "at most N words" far
// better than a token cap, and a token cap truncates mid-phrase, which yields a
// prompt ending in a dangling adjective.
const LENGTHS = {
  short: { words: 8, tokens: 40 },
  medium: { words: 16, tokens: 70 },
  long: { words: 30, tokens: 120 },
};

const RULES = [
  'Reply with ONE noun phrase naming ONE physical object.',
  'Never describe an action, an event, or two things interacting. "axe cleaving',
  '  through stone" is wrong -- it names two objects and a verb, and the model',
  '  renders the dominant noun and drops the rest. "heavy war axe with a chipped',
  '  blade" is right. Measured: the first form produced a stone well; the second',
  '  form is what this rule exists to force.',
  'No sentences, no preamble, no quotes, no trailing full stop.',
  'Describe only what is visible. Never name the art style, the medium, the',
  '  background, the framing, or the view angle -- those are added later.',
  'The object must have a PHYSICAL FORM you could hold or point at. Wind, auras,',
  '  light, overlays and "energy" are not forms -- asked for those this model',
  '  returns a generic grey stone disc, measured. If the effect has no natural',
  '  physical form, name the WEAPON, TOOL or EMBLEM associated with it instead.',
  'Never mention a person, a character, a hand, or who uses the thing.',
  'Never name a BODY PART. No fist, no hand, no skull, no claw -- measured, a',
  '  fist is how this model smuggles a person into an icon it was told not to',
  '  put one in ("Skull Splitter" returned "crushing fist with a shattered',
  '  skull", breaking three rules in five words).',
  'IF THE NAME ALREADY CONTAINS A PHYSICAL OBJECT, THAT OBJECT IS THE ANSWER.',
  '  "Shield Slam" is a SHIELD. Measured, this model answered "heavy war',
  '  hammer" -- it read the verb and ignored the noun standing right next to',
  '  it. Name the object from the name, then describe it.',
  'Use a colour only when the name or effect implies one.',
  'The answer must contain something that could NOT be said of a plain sword.',
  '  Measured over 20 warrior abilities: 16 came back as an axe, a sword or a',
  '  hammer with an ordinary adjective, which draws 16 near-identical icons.',
  '  Take the distinguishing detail from the name -- blood, bone, chain, wave,',
  '  steel, thunder -- and put it in the object.',
].join('\n');

// One contract per kind. The differences are the point of this module.
const CONTRACTS = {
  item: {
    role: 'You name what a fantasy game ITEM looks like, for a small icon.',
    ask: 'Describe the object itself.',
    examples: [
      ['iron-spear (weapon)', 'long iron spear with a leaf-shaped head'],
      ['obsidian-plate (armor)', 'blackened plate cuirass with sharp obsidian edges'],
      ['void-signet (ring)', 'dark metal signet ring set with a starless black stone'],
    ],
  },
  // An ability is not an object. Asking for one draws the caster.
  skill: {
    role: 'You name the ICON for a fantasy game ABILITY. The icon is ONE physical '
      + 'object that suggests the effect -- never the character who uses it, and '
      + 'never the action itself.',
    ask: 'Name the single object that would appear on this ability\'s icon.',
    // Every exemplar is ONE object. The earlier set used phrases like "forked
    // lightning bolt STRIKING an anvil", and the model copied the form: it
    // answered with actions, and SDXL rendered the anvil and dropped the bolt.
    // Few-shot teaches shape as much as content.
    examples: [
      ['Bone Storm (Cultist, magic)', 'cluster of jagged bone shards'],
      ['Thunder Strike (Warrior, magic)', 'forked lightning bolt'],
      ['Fan of Knives (Archer, melee)', 'five throwing knives spread in a fan'],
      // The formless case, shown rather than described: a whirlwind has no
      // form, so the exemplar names a PROP that suggests it.
      ['Whirlwind (Warrior, melee)', 'battle axe with a spiral-etched blade'],
      // The name-carries-the-object case, shown rather than described: this
      // exact subject returned "heavy war hammer" before the rule existed.
      ['Shield Slam (Warrior, melee)', 'round iron shield with a spiked boss'],
      // And the distinctiveness case: "Blood Harvest" is not a plain axe, it
      // is an axe you can tell apart from the other five axes.
      ['Blood Harvest (Warrior, melee)', 'curved reaping scythe with a blood-filled groove'],
    ],
  },
  // The hardest kind: the subject is one abstract word. The catalogue holds the
  // mechanical effect and the template throws it away -- see subjectContext().
  passive_label: {
    role: 'You name the ICON for a passive character bonus. The icon is a small '
      + 'emblem standing for the effect, never a person.',
    ask: 'Describe a single emblem that stands for this bonus.',
    examples: [
      ['Fleet - cooldown floor drops from 0.40 to 0.32', 'winged boot'],
      ['Cryomancy - +35% ice damage, hits chill', 'jagged ice crystal'],
      ['Sanguine Aura', 'red gemstone ringed in gold'],
    ],
  },
};

// Everything the catalogue knows that helps, including the parts the template
// discards. A passive label's key carries its mechanical effect
// ("Fleet - your cooldown floor drops from 0.40 to 0.32") and the template
// sends only the word "Fleet"; the effect is exactly what tells a model what to
// draw, so it goes in.
// A passive node's grants, as words a model can draw from. The NUMBERS matter
// least here -- what tells you what to draw is "ice", "chill", "mana",
// "strength". Units are deliberately not asserted: the tree stores 35 for +35%
// ice damage and 2 for +2 strength, and claiming a unit we have not checked
// would put a wrong fact in every icon prompt.
function grantsPhrase(grants) {
  if (!Array.isArray(grants) || !grants.length) return '';
  const words = grants.map((g) => {
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
  }).filter(Boolean);
  return words.join(', ');
}

function subjectContext(subject) {
  const bits = [];
  const name = subject.name || subject.key;
  bits.push(`Name: ${name}`);
  // SOMET-552. THIS BRANCH USED TO BE DEAD. It read
  // `subject.key !== name`, and catalogSubjects sets a passive label's key AND
  // name to the same label text -- always equal, so all 128 labels were
  // described from one English word with their mechanical effect thrown away.
  // Measured 2026-09-10: "Versatility" (+2 to a stat) became "gear shift" and
  // drew a machine lever on a stone plinth.
  if (subject.kind === 'passive_label') {
    const effect = grantsPhrase(subject.grants);
    if (effect) bits.push(`Effect: ${effect}`);
  }
  if (subject.row) {
    for (const [label, field] of [['Category', 'category'], ['Element', 'element'],
      ['Class', 'class'], ['Type', 'type'], ['Rarity', 'rarity']]) {
      if (subject.row[field]) bits.push(`${label}: ${subject.row[field]}`);
    }
  }
  return bits.join('\n');
}

function buildMessages(subject, length) {
  const contract = CONTRACTS[subject.kind] || CONTRACTS.item;
  const budget = LENGTHS[length] || LENGTHS.medium;
  const shots = contract.examples
    .map(([q, a]) => `Subject: ${q}\nAnswer: ${a}`)
    .join('\n\n');
  return [
    {
      role: 'system',
      content: `${contract.role}\n\n${RULES}\nAt most ${budget.words} words.\n\n`
        + `Examples:\n${shots}`,
    },
    { role: 'user', content: `${subjectContext(subject)}\n\n${contract.ask}` },
  ];
}

// Strip what the model adds despite being told not to. Cheap and worth it: a
// stray leading "Answer:" or a wrapping quote goes straight into an image
// prompt otherwise, and the guards downstream cannot see a bad prompt.
function clean(text, length) {
  const budget = LENGTHS[length] || LENGTHS.medium;
  let out = String(text || '').trim();
  out = out.replace(/^(answer|subject|description)\s*:\s*/i, '');
  out = out.replace(/^["'`]+|["'`]+$/g, '');
  out = out.split('\n')[0].trim();
  out = out.replace(/[.]+$/, '');
  // STRIP A LEADING ARTICLE. The exemplars never use one, but the model adds it
  // anyway and gets it wrong: measured output included "a arrow",
  // "a ice-tipped rapier" and "a five throwing knives spread in a fan".
  // buildObjectPrompt wraps this as "only X and nothing else", which supplies
  // the determiner, so the article is redundant even when correct.
  //
  // The catalogue TEMPLATE has the same defect ("a apprentice staff",
  // "a arbalest") -- pre-existing, and not fixed here, but this must not add
  // to it. A prompt that opens on a grammatical error spends its first token
  // badly, which is the reasoning catalogSubjects already records for
  // "a pile of gold" over "a gold".
  out = out.replace(/^(a|an|the)\s+/i, '');
  // A model that ignores the word budget produces a paragraph; truncating at a
  // word boundary is better than sending it, and better than a token cut.
  const words = out.split(/\s+/).filter(Boolean);
  if (words.length > budget.words * 1.5) out = words.slice(0, budget.words).join(' ');
  return out.toLowerCase();
}

async function describeSubject(subject, { length = 'medium', fetchImpl = fetch } = {}) {
  const budget = LENGTHS[length] || LENGTHS.medium;
  const res = await fetchImpl(ENDPOINT(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL(),
      messages: buildMessages(subject, length),
      max_tokens: budget.tokens,
      temperature: TEMPERATURE(),
      stream: false,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS()),
  });
  if (!res.ok) throw new Error(`describer answered ${res.status}`);
  const json = await res.json();
  const raw = json.choices && json.choices[0] && json.choices[0].message
    ? json.choices[0].message.content : '';
  const text = clean(raw, length);
  if (!text) throw new Error('describer returned nothing usable');
  return { text, model: MODEL(), length };
}

module.exports = {
  describeSubject, buildMessages, clean, subjectContext, grantsPhrase,
  LENGTHS, CONTRACTS, MODEL, TEMPERATURE,
};
