const test = require('node:test');
const assert = require('node:assert');
const d = require('../src/services/artDispatcher.js');
const { buildObjectPrompt } = require('../src/services/objectPrompt.js');

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
  const req = await d.requestForSubject({}, { seed: '12345' },
    { key: 'crude-blade', name: 'crude-blade', basePrompt: 'a crude blade, a fantasy weapon' },
    OBJECT_REG);
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
  const req = await d.requestForSubject({}, { seed: 7 },
    { key: 'grass', name: 'grass', basePrompt: 'lush grass', biome: 'forest' }, TILE_REG);
  assert.equal(req.kind, 'tile');
  assert.equal(req.prompt, 'lush grass, mossy palette');
  assert.ok(!/nothing else|magenta|cut out/i.test(req.prompt),
    `a tile prompt must carry no cutout framing: "${req.prompt}"`);
});

// The 1024 minimum exists because an off-native SDXL OBJECT tiles into a sprite
// sheet. A seamless texture has no such failure, and forcing it would change
// working terrain art for no reason.
test('the native-size ask is made for objects and NOT for tiles', async () => {
  const obj = await d.requestForSubject({}, { seed: 1 },
    { key: 'k', basePrompt: 'a thing' }, OBJECT_REG);
  assert.equal(obj.width, d.MIN_OBJECT_PX());
  assert.equal(obj.height, d.MIN_OBJECT_PX());

  const tile = await d.requestForSubject({}, { seed: 1 },
    { key: 't', basePrompt: 'grass' }, TILE_REG);
  assert.equal(tile.width, undefined,
    'a tile must not be forced to the object minimum -- 512 is correct for terrain');
  assert.equal(tile.height, undefined);
});

// bigint comes back from pg as a STRING. Sent unconverted it would be rejected
// or coerced downstream, and the per-subject seed is what stands between this
// batch and one repeated composition.
test('the seed is sent as a number even though the column is bigint', async () => {
  const req = await d.requestForSubject({}, { seed: '2037' },
    { key: 'k', basePrompt: 'a thing' }, OBJECT_REG);
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
