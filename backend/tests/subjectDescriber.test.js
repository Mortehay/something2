const test = require('node:test');
const assert = require('node:assert');
const {
  clean, buildMessages, subjectContext, grantsPhrase, CONTRACTS, TEMPERATURE,
} = require('../src/services/subjectDescriber.js');

// SOMET-550. The contract that turns a catalogue row into a subject phrase.
//
// These are unit tests over the PROMPT and the CLEANUP, not over the model.
// What the model returns is judged by looking at the images it produces; what
// can be pinned here is the shape of what we ask for and the shape of what we
// accept back.

test('a stray leading article is stripped, however wrong', () => {
  // Every one of these is REAL output from the 2026-09-06 sample. The model
  // adds an article the exemplars never use, and gets it wrong.
  assert.equal(clean('a arrow with a kidney-shaped head', 'short'),
    'arrow with a kidney-shaped head');
  assert.equal(clean('an ice-tipped rapier', 'short'), 'ice-tipped rapier');
  assert.equal(clean('a five throwing knives spread in a fan', 'short'),
    'five throwing knives spread in a fan');
  assert.equal(clean('The heavy war axe', 'short'), 'heavy war axe');
  // A phrase that legitimately starts with a describing word keeps it.
  assert.equal(clean('long, slender dagger', 'short'), 'long, slender dagger');
});

test('the wrappers a model adds despite instructions are removed', () => {
  assert.equal(clean('Answer: heavy war axe', 'short'), 'heavy war axe');
  assert.equal(clean('"heavy war axe"', 'short'), 'heavy war axe');
  assert.equal(clean('heavy war axe.', 'short'), 'heavy war axe');
  // Only the first line: a chatty model explains itself underneath.
  assert.equal(clean('heavy war axe\nThis represents the ability.', 'short'),
    'heavy war axe');
});

test('a runaway answer is cut at a word boundary, not mid-phrase', () => {
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const out = clean(long, 'short');
  assert.ok(out.split(/\s+/).length <= 8, 'a paragraph must not reach the image prompt');
  assert.ok(!out.endsWith('wor'), 'and must not be truncated inside a word');
});

test('empty and malformed input do not throw', () => {
  for (const v of [null, undefined, '', '   ', 42]) {
    assert.equal(typeof clean(v, 'short'), 'string');
  }
});

// THE POINT OF THE MODULE: the three kinds are asked DIFFERENT questions,
// because "describe the object" is the wrong instruction for two of them. An
// ability is not a thing with a shape, and asking for one drew the warrior who
// casts it.
test('each kind gets its own contract, not one shared prompt', () => {
  const sys = (kind) => buildMessages({ kind, key: 'k', name: 'K' }, 'short')[0].content;
  assert.match(sys('skill'), /ability/i);
  assert.match(sys('passive_label'), /bonus/i);
  assert.match(sys('item'), /ITEM/);
  assert.notEqual(sys('skill'), sys('item'));
  // An unknown kind falls back rather than throwing -- a new subject kind is a
  // registry entry, and it must not need a change here to be describable.
  assert.equal(sys('brand_new_kind'), sys('item'));
});

test('every skill and passive exemplar is ONE object, never an action', () => {
  // Few-shot teaches SHAPE. The first version used "forked lightning bolt
  // STRIKING an anvil" and the model copied the form, answering with actions;
  // SDXL then rendered the anvil and dropped the bolt.
  for (const kind of ['skill', 'passive_label']) {
    for (const [, answer] of CONTRACTS[kind].examples) {
      assert.doesNotMatch(answer, /\b(striking|cleaving|hitting|swinging|casting)\b/i,
        `${kind} exemplar teaches an action: "${answer}"`);
    }
  }
});

// SOMET-552. Every one of these was measured on a 20-skill sample, and each
// exists because the model broke a rule the contract did not state.
test('the rule that the name\'s own object wins is stated', () => {
  const sys = buildMessages({ kind: 'skill', key: 'k', name: 'K' }, 'short')[0].content;
  // "Shield Slam" returned "heavy war hammer": it read the verb and ignored
  // the noun beside it.
  assert.match(sys, /IF THE NAME ALREADY CONTAINS A PHYSICAL OBJECT/);
  assert.ok(CONTRACTS.skill.examples.some(([q]) => /Shield Slam/.test(q)),
    'and is taught by an exemplar, because few-shot teaches shape');
});

test('no exemplar names a body part', () => {
  // "Skull Splitter" -> "crushing fist with a shattered skull". A fist is how
  // this model puts a person into an icon it was told to keep people out of.
  for (const kind of ['skill', 'passive_label', 'item']) {
    for (const [, answer] of CONTRACTS[kind].examples) {
      assert.doesNotMatch(answer, /\b(fist|hand|skull|claw|arm|finger)\b/i,
        `${kind} exemplar teaches a body part: "${answer}"`);
    }
  }
});

test('the distinctiveness rule is stated, because 16 of 20 were the same weapon', () => {
  const sys = buildMessages({ kind: 'skill', key: 'k', name: 'K' }, 'short')[0].content;
  assert.match(sys, /could NOT be said of a plain sword/);
});

test('the physical-form rule is stated, because formless subjects fail', () => {
  const sys = buildMessages({ kind: 'skill', key: 'k', name: 'K' }, 'short')[0].content;
  // Measured: "circular gust of wind" produced a grey stone disc, twice.
  assert.match(sys, /PHYSICAL FORM/);
});

// The template throws this away: a passive node's GRANTS carry its mechanical
// effect, and the effect is exactly what says what to draw.
//
// THIS TEST USED TO PASS OVER A DEAD BRANCH. It passed `key` and `name` as
// DIFFERENT strings, and the code read `subject.key !== name` -- but
// catalogSubjects sets both to the same label text for all 128 labels, so the
// effect line never appeared in production. The fixture was the only place the
// condition was ever true. It now uses the shape catalogSubjects actually
// produces: key === name, effect carried by `grants`.
test('a passive label contributes its effect, not just its name', () => {
  const ctx = subjectContext({
    kind: 'passive_label',
    key: 'Cryomancy',
    name: 'Cryomancy',                     // EQUAL, as the catalogue emits them
    grants: [{ type: 'damage', element: 'ice', value: 35 },
      { type: 'status', status: 'chill', value: 1 }],
  });
  assert.match(ctx, /Name: Cryomancy/);
  assert.match(ctx, /ice damage/, 'the effect is the useful half');
  assert.match(ctx, /chill/);
});

test('every grant type renders, because an unhandled one is a silent blank', () => {
  const all = grantsPhrase([
    { type: 'stat', stat: 'strength', value: 2 },
    { type: 'damage', element: 'fire', value: 35 },
    { type: 'resist', element: 'ice', value: 20 },
    { type: 'resource', pool: 'mana', value: 60 },
    { type: 'status', status: 'chill', value: 1 },
    { type: 'rule', rule: 'cooldownFloor', value: 0.32 },
  ]);
  // These six are every type in passive_nodes, checked against the live table.
  for (const word of ['strength', 'fire damage', 'ice resistance', 'mana', 'chill', 'cooldownFloor']) {
    assert.ok(all.includes(word), `"${word}" is missing from "${all}"`);
  }
  assert.equal(grantsPhrase([]), '', 'and no grants is no Effect line, not an empty one');
  assert.equal(grantsPhrase(undefined), '');
  assert.equal(grantsPhrase([{ type: 'something_new' }]), '',
    'an unknown type is dropped rather than rendered as undefined');
});

test('an item contributes its catalogue fields', () => {
  const ctx = subjectContext({
    kind: 'item', key: 'obsidian-plate', name: 'obsidian plate',
    row: { category: 'armor', element: 'shadow' },
  });
  assert.match(ctx, /Category: armor/);
  assert.match(ctx, /Element: shadow/);
});

// The output is the SUBJECT only. buildObjectPrompt adds styling, backdrop and
// framing; saying them twice is how a prompt starts fighting itself.
test('the contract forbids styling, backdrop and framing words', () => {
  const sys = buildMessages({ kind: 'item', key: 'k', name: 'K' }, 'short')[0].content;
  assert.match(sys, /Never name the art style/i);
  assert.match(sys, /background/i);
});

// SOMET-552. Sampling temperature is the difference between a description you
// can reason about and one that moves under you. Measured over the same 20
// warrior abilities, two runs apart: temperature 0.4 agreed on 7 of 20,
// temperature 0.15 on 15 of 20.
test('temperature defaults low, because a description that moves is not a record', () => {
  const before = process.env.ART_DESCRIBER_TEMPERATURE;
  try {
    delete process.env.ART_DESCRIBER_TEMPERATURE;
    assert.ok(TEMPERATURE() <= 0.2, `default is ${TEMPERATURE()}, which re-rolls the answer`);
    process.env.ART_DESCRIBER_TEMPERATURE = '0.8';
    assert.equal(TEMPERATURE(), 0.8, 'and is tunable, for deliberately exploring alternatives');
    // A junk value must not become NaN in the request body -- the provider
    // rejects it, and every description in the run fails for a reason that
    // points at the model rather than at the env var.
    process.env.ART_DESCRIBER_TEMPERATURE = 'warm';
    assert.ok(Number.isFinite(TEMPERATURE()));
  } finally {
    if (before === undefined) delete process.env.ART_DESCRIBER_TEMPERATURE;
    else process.env.ART_DESCRIBER_TEMPERATURE = before;
  }
});
