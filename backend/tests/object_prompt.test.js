const test = require('node:test');
const assert = require('node:assert');
const {
  buildObjectPrompt, OBJECT_NEGATIVES, BACKDROP,
} = require('../src/services/objectPrompt.js');

// SOMET-558. The framing exclusions moved from the POSITIVE prompt to the
// negative terms.
//
// They used to read "no frame, no border, no picture frame, no card, no
// ground, no floor, no shadow, no scenery, no other objects" inside the prompt
// itself. CLIP has no reliable negation, so that clause conditioned every one
// of those nouns IN -- the same defect this ticket fixed for operator
// corrections, in our own house wording and applied to every object ever
// generated.

// The exact wording removed, kept here as the record of what has to stay
// covered. If someone deletes a term from OBJECT_NEGATIVES, this is what
// notices.
const REMOVED = ['frame', 'border', 'picture frame', 'card',
  'ground', 'floor', 'shadow', 'scenery', 'other objects'];

test('the prompt no longer spells out what to omit', () => {
  const prompt = buildObjectPrompt('fletched wooden arrow');
  // "no <noun>" is the shape that was doing the damage.
  assert.ok(!/\bno (frame|border|picture frame|card|ground|floor|shadow|scenery|other objects)\b/
    .test(prompt), `still negating inside the positive prompt: ${prompt}`);
  // And the nouns themselves are gone, not merely the word "no" -- naming
  // "shadow" anywhere in a positive prompt is what conditions one.
  //
  // WORD BOUNDARIES, not includes(): "background" contains "ground", and the
  // prompt says "background" twice on purpose.
  for (const term of ['shadow', 'picture frame', 'scenery', 'floor', 'ground']) {
    assert.ok(!new RegExp(`\\b${term}\\b`).test(prompt),
      `"${term}" must not appear in the positive prompt`);
  }
  // The guard on the guard: the boundary check must still SEE a real leak.
  assert.ok(/\bground\b/.test('no ground, no floor'),
    'the boundary regex must match a genuine occurrence, or this test is blind');
});

// THE ASSERTION THAT MAKES THIS A MOVE AND NOT A DELETION. Every concept the
// old wording excluded must still be expressed somewhere.
test('every removed exclusion is still covered by a negative term', () => {
  const negatives = OBJECT_NEGATIVES.join(', ');
  const covers = {
    frame: 'picture frame',
    'picture frame': 'picture frame',
    border: 'border',
    card: 'trading card',
    ground: 'ground',
    floor: 'floor',
    shadow: 'shadow',
    scenery: 'scenery',
    'other objects': 'multiple objects',
  };
  for (const term of REMOVED) {
    assert.ok(negatives.includes(covers[term]),
      `"${term}" was removed from the prompt with nothing to replace it`);
  }
});

// WHAT MUST NOT HAVE BEEN SWEPT UP. These were measured to work: asked for a
// bare subject this model answers with a TILESET of it -- a forest for one pine
// tree -- and this trio is what stops it. They constrain what the image IS
// rather than naming things to omit, so the negation objection never applied.
test('the measured positive constraints survive', () => {
  const prompt = buildObjectPrompt('fletched wooden arrow');
  for (const kept of ['only fletched wooden arrow and nothing else',
    'one single object', 'centered', BACKDROP,
    'pixel art RPG game asset', 'cut out on a plain flat background']) {
    assert.ok(prompt.includes(kept), `lost a measured constraint: "${kept}"`);
  }
});

// SOMET-548's placement rule still holds: a correction lands with the framing,
// BEFORE the styling, because what comes first is what holds.
test('a correction still lands ahead of the styling', () => {
  const prompt = buildObjectPrompt('an arrow', { corrections: ['steel broadhead'] });
  assert.ok(prompt.indexOf('steel broadhead') < prompt.indexOf('pixel art RPG game asset'),
    'a correction after the styling sits in the weakest position in the prompt');
});

test('no corrections leaves no stray separator', () => {
  const prompt = buildObjectPrompt('an arrow');
  assert.ok(!prompt.includes(', ,'), prompt);
  assert.ok(!/,\s*,/.test(prompt), prompt);
});
