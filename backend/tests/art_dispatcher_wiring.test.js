const test = require('node:test');
const assert = require('node:assert');
const d = require('../src/services/artDispatcher.js');
const {
  buildObjectPrompt, BACKDROP, CUTOUT_BACKDROP, OBJECT_NEGATIVES,
} = require('../src/services/objectPrompt.js');

// SOMET-548: requestForSubject now reads the subject's prompt notes, so it
// needs a db. NO_NOTES is a subject with none -- the default state for
// everything in the catalogue, and the case these framing tests are about.
// A test that wants notes applied provides its own rows; see
// art_prompt_notes_db.test.js for the composition itself.
const NO_NOTES = { query: async () => ({ rows: [] }) };

// SOMET-540. The parts of the dispatcher that need no database: the resolution
// precondition, and the request it composes for a subject.

// --- The resolution precondition -----------------------------------------
//
// Measured 2026-09-04 (SOMET-536): the same checkpoint, prompts and seeds give
// 2 of 8 usable subjects at 512 and 6 of 8 at 1024, because off-native SDXL
// repeats the subject instead of scaling it. These assert the guard that stops
// a 617-image batch running at 512 and reporting 617 successes.

test('a provider that hardcodes a below-minimum size is refused', () => {
  const refusal = d.providerSizeRefusal({
    id: 5, name: 'desktop gpu (objects)',
    request_template: { width: 512, height: 512, prompt: '{{prompt}}' },
  });
  assert.ok(refusal, 'a 512 template must be refused');
  assert.match(refusal, /512/);
  assert.match(refusal, /1024/, 'the refusal must name the minimum, or it is not actionable');
  assert.match(refusal, /request_template/, 'and say where to change it');
});

test('a provider at or above the minimum is accepted', () => {
  assert.equal(d.providerSizeRefusal({
    id: 5, request_template: { width: 1024, height: 1024 },
  }), null);
  assert.equal(d.providerSizeRefusal({
    id: 5, request_template: { width: 1536, height: 1536 },
  }), null, 'larger than the minimum is fine');
});

// The SMALLER edge decides. A template that is native in one dimension and
// half-native in the other still tiles along the short edge.
test('a mixed template is judged by its smaller edge', () => {
  assert.ok(d.providerSizeRefusal({ id: 5, request_template: { width: 1024, height: 512 } }),
    'native width does not excuse a half-native height');
});

// The same rule the entity alpha guard follows: refuse what we can positively
// see is wrong, allow what we cannot read. A template we cannot parse is a
// provider we know nothing about, not a broken one.
test('an unreadable or placeholder template is allowed through, not refused', () => {
  assert.equal(d.providerSizeRefusal({ id: 5, request_template: {} }), null,
    'no width key means the remote applies its own default -- unknowable from here');
  assert.equal(d.providerSizeRefusal({ id: 5, request_template: null }), null);
  assert.equal(d.providerSizeRefusal({ id: 5 }), null);
  assert.equal(d.providerSizeRefusal({
    id: 5, request_template: { width: '{{width}}', height: '{{height}}' },
  }), null, 'a placeholder means WE choose the value, so it is not a misconfiguration');
});

// A string is what a hand-edited JSON template most often contains, and it
// would slip past a typeof-number-only check while still sending 512.
test('a numeric STRING in the template is still read as a size', () => {
  assert.ok(d.providerSizeRefusal({ id: 5, request_template: { width: '512', height: '512' } }),
    '"512" sends 512 just as surely as 512 does');
});

test('the minimum is the measured one', () => {
  assert.equal(d.MIN_OBJECT_PX(), 1024,
    'below SDXL native the model tiles; 2/8 usable at 512 versus 6/8 at 1024');
});

// --- The composed request -------------------------------------------------

// `requestForSubject` is async and registry-driven now (SOMET-538): a tile
// composes its prompt from its biome, an object takes the shared wrapper, and
// the native-size ask is object-only.
const OBJECT_REG = { generationKind: 'object' };
const TILE_REG = {
  generationKind: 'tile',
  composePrompt: async (db, subject) => `${subject.basePrompt}, mossy palette`,
};

test('an object request wraps a plain subject with the shared framing', async () => {
  const req = await d.requestForSubject(NO_NOTES, { seed: '12345' },
    { key: 'crude-blade', name: 'crude-blade', basePrompt: 'a crude blade, a fantasy weapon' },
    OBJECT_REG, null);
  assert.equal(req.prompt, buildObjectPrompt('a crude blade, a fantasy weapon'),
    'the wrapper must be the SHARED one -- icons and world props are one house style');
  assert.match(req.prompt, /^only a crude blade, a fantasy weapon and nothing else/);
  assert.equal(req.kind, 'object');
  assert.equal(req.frames, 1, 'a sheet is never wanted here');
});

// A TILE MUST NOT GET THE OBJECT WRAPPER. "only X and nothing else, one single
// object, centered, flat solid magenta background" asks for a cut-out prop; a
// seamless ground texture is the opposite of that.
test('a tile composes its own prompt and gets none of the object framing', async () => {
  const req = await d.requestForSubject(NO_NOTES, { seed: 7 },
    { key: 'grass', name: 'grass', basePrompt: 'lush grass', biome: 'forest' }, TILE_REG, null);
  assert.equal(req.kind, 'tile');
  assert.equal(req.prompt, 'lush grass, mossy palette');
  assert.ok(!/nothing else|magenta|cut out/i.test(req.prompt),
    `a tile prompt must carry no cutout framing: "${req.prompt}"`);
});

// The 1024 minimum exists because an off-native SDXL OBJECT tiles into a sprite
// sheet. A seamless texture has no such failure, and forcing it would change
// working terrain art for no reason.
test('the native-size ask is made for objects and NOT for tiles', async () => {
  const obj = await d.requestForSubject(NO_NOTES, { seed: 1 },
    { key: 'k', basePrompt: 'a thing' }, OBJECT_REG, null);
  assert.equal(obj.width, d.MIN_OBJECT_PX());
  assert.equal(obj.height, d.MIN_OBJECT_PX());

  const tile = await d.requestForSubject(NO_NOTES, { seed: 1 },
    { key: 't', basePrompt: 'grass' }, TILE_REG, null);
  assert.equal(tile.width, undefined,
    'a tile must not be forced to the object minimum -- 512 is correct for terrain');
  assert.equal(tile.height, undefined);
});

// bigint comes back from pg as a STRING. Sent unconverted it would be rejected
// or coerced downstream, and the per-subject seed is what stands between this
// batch and one repeated composition.
test('the seed is sent as a number even though the column is bigint', async () => {
  const req = await d.requestForSubject(NO_NOTES, { seed: '2037' },
    { key: 'k', basePrompt: 'a thing' }, OBJECT_REG, null);
  assert.strictEqual(req.seed, 2037);
});

// --- Subject resolution ---------------------------------------------------

// One query per KIND, not per job. 617 jobs resolving one at a time would be
// 617 full-catalogue queries against a table that never changes mid-batch.
test('the subject resolver lists each kind once, however many jobs it serves', async () => {
  let listCalls = 0;
  const subjects = {
    registryFor: (kind) => (kind === 'skill' ? {
      list: async () => {
        listCalls += 1;
        return [{ key: 'a', name: 'A', basePrompt: 'an a' }, { key: 'b', name: 'B', basePrompt: 'a b' }];
      },
    } : null),
  };
  const get = d.subjectResolver({}, subjects);
  assert.equal((await get('skill', 'a')).name, 'A');
  assert.equal((await get('skill', 'b')).name, 'B');
  assert.equal((await get('skill', 'a')).name, 'A');
  assert.equal(listCalls, 1, `the catalogue was listed ${listCalls} times for 3 lookups`);
  assert.equal(await get('skill', 'missing'), null,
    'an unknown key resolves to null so the job can fail with a reason');
});

test('an unknown subject kind throws rather than resolving to nothing', async () => {
  const get = d.subjectResolver({}, { registryFor: () => null });
  await assert.rejects(() => get('nonsense', 'x'), /unknown subject kind/);
});

// --- The backdrop, which invalidated a whole canary batch ------------------
//
// "flat solid magenta background" does not merely describe the backdrop: SDXL
// bleeds it into the SUBJECT. Measured across 8 generated subjects spanning
// four kinds, 62-100% of each subject's saturated pixels came back magenta --
// an archer, a medallion, a mushroom, a crossbow and two weapon skills, all one
// colour, one of them an empty magenta frame. Structurally perfect and
// unusable.

test('a provider that cuts out server-side is asked for a GREY backdrop', () => {
  assert.equal(d.backdropFor({ request_template: { cutout: true } }), CUTOUT_BACKDROP);
  // Grey, not white and not a saturated colour. White cost 21 of 101 subjects
  // on 2026-09-05 (the provider's cutout is a colour key, so a pale subject on
  // white shares its backdrop's colour); a saturated backdrop bleeds its hue
  // into the subject, which is what the magenta finding measured. Grey is the
  // only candidate that avoids both, so this assertion pins BOTH properties.
  assert.match(CUTOUT_BACKDROP, /grey|gray/, 'the cutout backdrop must be grey');
  assert.doesNotMatch(CUTOUT_BACKDROP, /white|magenta|green|blue/,
    'a saturated or pale backdrop reintroduces a measured, expensive bug');
});

// A provider that does NOT cut out is feeding the chroma-key step, which keys
// magenta by contract. Changing this would silently break transparency there.
test('a provider that does NOT cut out keeps magenta, for the chroma key', () => {
  assert.equal(d.backdropFor({ request_template: { cutout: false } }), BACKDROP);
  assert.equal(d.backdropFor({ request_template: {} }), BACKDROP);
  assert.equal(d.backdropFor({}), BACKDROP);
  assert.equal(d.backdropFor(null), BACKDROP);
  assert.match(BACKDROP, /magenta/);
});

test('the composed request carries the backdrop its provider needs', async () => {
  const cut = await d.requestForSubject(NO_NOTES, { seed: 1 }, { key: 'k', basePrompt: 'a sword' },
    OBJECT_REG, { request_template: { cutout: true } });
  assert.match(cut.prompt, /grey background/);
  // Both exclusions matter and for DIFFERENT measured reasons: magenta bleeds
  // its hue into the subject, and white shares a colour with pale subjects so
  // the provider's flood-fill cutout eats them.
  assert.ok(!/magenta/.test(cut.prompt), 'naming magenta tints the subject magenta');
  assert.ok(!/white/.test(cut.prompt), 'white lost 21 of 101 subjects to the cutout');

  const keyed = await d.requestForSubject(NO_NOTES, { seed: 1 }, { key: 'k', basePrompt: 'a sword' },
    OBJECT_REG, { request_template: { cutout: false } });
  assert.match(keyed.prompt, /magenta background/);
});

// SOMET-548. The dispatcher must actually APPLY a subject's notes.
//
// objectPrompt has its own tests for where corrections land, but those call
// buildObjectPrompt directly and would stay green against a dispatcher that
// never loads a note -- the same orphaned-helper hole the history slice had.
test('an object request carries the subject\'s active prompt notes', async () => {
  const withNotes = {
    query: async () => ({ rows: [{ id: 1, note: 'throwing darts, not a dartboard' }] }),
  };
  const req = await d.requestForSubject(withNotes, { seed: 1 },
    { key: 'darts', basePrompt: 'a darts' }, OBJECT_REG,
    { request_template: { cutout: true } });

  assert.match(req.prompt, /throwing darts, not a dartboard/,
    'a stored note must reach the prompt the provider is sent');
  assert.ok(req.prompt.indexOf('throwing darts') < req.prompt.indexOf('pixel art RPG game asset'),
    'and keep its position ahead of the styling');
});

// A tile composes its own prompt from its biome's palette. Notes are an OBJECT
// feature, and loading them for a tile would be a query per tile for rows that
// could never be used.
test('a tile does NOT get prompt notes', async () => {
  let queried = false;
  const spy = { query: async () => { queried = true; return { rows: [] }; } };
  await d.requestForSubject(spy, { seed: 1 }, { key: 't', basePrompt: 'grass' },
    { generationKind: 'tile', composePrompt: async () => 'a grass tile' },
    { request_template: {} });
  assert.equal(queried, false, 'a tile must not query for notes it cannot use');
});

// --- SOMET-551: the dispatcher must USE a stored description ---------------
//
// artPromptDescriptions has its own tests, but they call subjectPhrase()
// directly and would stay green against a dispatcher that never calls it --
// the orphaned-helper hole that the history and notes slices both had. These
// assert the wiring.
//
// The stub routes by SQL because requestForSubject now makes two reads (notes
// and description) and a blanket `rows: []` cannot tell them apart.
function dbWith({ description = null, notes = [] } = {}) {
  return {
    query: async (sql) => {
      if (/art_prompt_descriptions/.test(sql)) {
        return { rows: description ? [description] : [] };
      }
      if (/art_prompt_notes/.test(sql)) return { rows: notes };
      return { rows: [] };
    },
  };
}

test('a stored description replaces the catalogue phrase in the composed prompt', async () => {
  const req = await d.requestForSubject(
    dbWith({ description: { text: 'gnarled wand tipped with a blue crystal', model: 'test-llm' } }),
    { seed: 1 }, { key: 'wand', basePrompt: 'a wand, a fantasy weapon' },
    OBJECT_REG, { request_template: { cutout: true } },
  );
  assert.match(req.prompt, /gnarled wand tipped with a blue crystal/);
  assert.doesNotMatch(req.prompt, /a fantasy weapon/,
    'the template phrase must be REPLACED, not appended to');
  assert.equal(req.promptModel, 'test-llm',
    'the history needs to record who wrote the prompt, not only who drew it');
});

// The case every existing subject depends on. 87 items already have art built
// from the template; a silent change here would alter their regenerations.
test('with NO description the composed prompt is unchanged', async () => {
  const withNone = await d.requestForSubject(dbWith(), { seed: 1 },
    { key: 'wand', basePrompt: 'a wand, a fantasy weapon' },
    OBJECT_REG, { request_template: { cutout: true } });
  assert.match(withNone.prompt, /only a wand, a fantasy weapon and nothing else/);
  assert.equal(withNone.promptModel, null,
    'null says "never described", which is the fact the history wants');
});

test('a description and a note compose together, description first', async () => {
  const req = await d.requestForSubject(
    dbWith({
      description: { text: 'gnarled wand', model: 'm' },
      notes: [{ id: 1, note: 'no shadow' }],
    }),
    { seed: 1 }, { key: 'wand', basePrompt: 'ignored' },
    OBJECT_REG, { request_template: { cutout: true } },
  );
  // The description is WHAT THE THING IS and leads; the note is a correction
  // and sits with the exclusions. Losing that order would bury the subject.
  assert.ok(req.prompt.indexOf('gnarled wand') < req.prompt.indexOf('no shadow'));
});

test('a tile takes no description -- it composes its own prompt', async () => {
  let asked = false;
  const spy = {
    query: async (sql) => {
      if (/art_prompt_descriptions/.test(sql)) asked = true;
      return { rows: [] };
    },
  };
  await d.requestForSubject(spy, { seed: 1 }, { key: 't', basePrompt: 'grass' },
    { generationKind: 'tile', composePrompt: async () => 'a grass tile' },
    { request_template: {} });
  assert.equal(asked, false, 'a tile must not be queried for a phrase it cannot use');
});

// SOMET-558. The house framing exclusions reach the provider as NEGATIVE
// terms, and only for objects.
//
// The seam that matters: objectPrompt exports the list and the dispatcher has
// to attach it. A term deleted from one and not the other is silently
// unenforced, which is exactly the "moved it and lost it" failure this guards.
test('an object request carries the framing exclusions as negatives', async () => {
  const req = await d.requestForSubject(NO_NOTES, { seed: 1 },
    { key: 'arrow', name: 'arrow', basePrompt: 'an arrow, a fantasy ammo' }, OBJECT_REG, null);
  assert.ok(Array.isArray(req.negative), 'the request must carry a negative list');
  for (const term of OBJECT_NEGATIVES) {
    assert.ok(req.negative.includes(term), `missing negative term: ${term}`);
  }
  // And the other half: none of them may still be in the positive prompt.
  //
  // WORD BOUNDARIES, not includes(). "background" contains "ground", and the
  // prompt legitimately says "flat solid neutral grey background" twice -- a
  // substring check calls that a leak and fails on correct output.
  for (const term of OBJECT_NEGATIVES) {
    assert.ok(!new RegExp(`\\b${term}\\b`).test(req.prompt),
      `"${term}" is still in the positive prompt, where it conditions itself IN`);
  }
});

// A TILE IS LEGITIMATELY FULL OF GROUND AND FLOOR. Steering a terrain texture
// away from them would ruin every tile in the catalogue, so the house list is
// object-only.
test('a tile request does NOT carry the object framing exclusions', async () => {
  const req = await d.requestForSubject(NO_NOTES, { seed: 1 },
    { key: 'grass', name: 'grass', basePrompt: 'lush grass', biome: 'forest' }, TILE_REG, null);
  const carried = req.negative || [];
  for (const term of ['ground', 'floor', 'scenery']) {
    assert.ok(!carried.includes(term),
      `a tile must not be steered away from "${term}"`);
  }
});
