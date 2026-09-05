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
  'Use a colour only when the name or effect implies one.',
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
function subjectContext(subject) {
  const bits = [];
  const name = subject.name || subject.key;
  bits.push(`Name: ${name}`);
  if (subject.kind === 'passive_label' && subject.key && subject.key !== name) {
    bits.push(`Effect: ${subject.key}`);
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
      temperature: 0.4,
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
  describeSubject, buildMessages, clean, subjectContext, LENGTHS, CONTRACTS, MODEL,
};
