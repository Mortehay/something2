// Covers the bulk "Regenerate all tiles / all entities" run: what it plans,
// what it refuses, how it stops, and the two properties this feature must
// never lose -- that it cannot touch sprites, and that it cannot quietly
// generate through the local stub when the admin asked for the AI provider.
const test = require('node:test');
const assert = require('node:assert');

const bulk = require('../src/services/bulkImageRegeneration');
const remoteImageProvider = require('../src/services/remoteImageProvider');

// A pool that answers the two catalog SELECTs from fixtures and records every
// write, so a test can assert on the SQL a run actually issued.
function stubPool({ tiles = [], entities = [] } = {}) {
  const writes = [];
  return {
    writes,
    async query(sql, params) {
      if (/FROM tile_types/.test(sql)) return { rows: tiles };
      if (/FROM entity_types/.test(sql)) return { rows: entities };
      if (/^UPDATE/.test(sql.trim())) {
        writes.push({ sql, params });
        return { rows: [{ name: 'x' }] };
      }
      return { rows: [] };
    },
  };
}

const tileRow = (over = {}) => ({
  id: 1, name: 'grass', prompt: 'green grass', art_biome: null,
  ai_provider_mode: 'provider', ai_provider_id: 4, ...over,
});
const entityRow = (over = {}) => ({
  id: 10, name: 'Tree', prompt: 'a tree', render_mode: 'static',
  ai_provider_mode: 'provider', ai_provider_id: 5, ...over,
});

test.beforeEach(() => bulk.__reset());

// --- Planning ------------------------------------------------------------

test('colour-box entity types are left out unless explicitly included', async () => {
  // render_mode 'rect' is a deliberate choice for 114 types in this catalog.
  // Sweeping them into an "regenerate all" run would silently change how they
  // draw, which is a different decision from re-drawing existing art.
  const pool = stubPool({
    entities: [entityRow(), entityRow({ id: 11, name: 'Rock', render_mode: 'rect' })],
  });
  const off = await bulk.loadSubjects(pool, { kind: 'entities' });
  assert.deepStrictEqual(off.map(s => s.name), ['Tree']);

  const on = await bulk.loadSubjects(pool, { kind: 'entities', includeRect: true });
  assert.deepStrictEqual(on.map(s => s.name), ['Tree', 'Rock']);
});

test('a type with no prompt falls back to its name rather than an empty prompt', async () => {
  const pool = stubPool({ tiles: [tileRow({ prompt: null })] });
  const [subject] = await bulk.loadSubjects(pool, { kind: 'tiles' });
  assert.strictEqual(subject.basePrompt, 'grass');
});

test('provider resolution follows the pin, and a local pin is never redirected', () => {
  const pinned = { row: { ai_provider_mode: 'provider', ai_provider_id: 7 } };
  assert.strictEqual(bulk.resolveProviderId(pinned, null, 5), 7);

  // No choice + no active provider = nothing to generate with. With a
  // --provider-for-default it becomes that provider, which is what makes the
  // 100 unpinned creature types reachable from the buttons.
  const unpinned = { row: { ai_provider_mode: 'default', ai_provider_id: null } };
  assert.strictEqual(bulk.resolveProviderId(unpinned, null, null), null);
  assert.strictEqual(bulk.resolveProviderId(unpinned, null, 5), 5);

  // 'local' asked for sprite-gen BY NAME. Redirecting it to a remote provider
  // would override an explicit choice, so it stays null and is skipped.
  const local = { row: { ai_provider_mode: 'local', ai_provider_id: null } };
  assert.strictEqual(bulk.resolveProviderId(local, null, 5), null);
});

test('subjects with no AI provider are reported by name, not just counted', async () => {
  const pool = stubPool({
    entities: [entityRow(), entityRow({ id: 11, name: 'Wolf', ai_provider_mode: 'local' })],
  });
  const run = await bulk.startRun(pool, { kind: 'entities' }, {
    loadProvider: async () => ({ id: 5, name: 'p', model: 'm' }),
    regenerateSubject: async () => ({ ok: true, imageKey: 'k' }),
  });
  assert.deepStrictEqual(run.skipped, [{ table: 'entity_types', name: 'Wolf' }]);
  assert.strictEqual(run.total, 1);
});

// --- Sprite safety -------------------------------------------------------

test('the catalog writes touch image and render_mode only, never sprite', () => {
  // The interactive approve routes DO clear `sprite`. A bulk button doing the
  // same would delete animation work across the whole catalog in one click,
  // so this asserts on the actual SQL the run issues.
  for (const sql of Object.values(bulk.CATALOG_UPDATE)) {
    assert.ok(!/sprite/i.test(sql), `bulk SQL must not mention sprite: ${sql}`);
    assert.match(sql, /SET image = \$1/);
  }
});

test('every generation asks for exactly one frame, so no sheet is ever requested', async () => {
  const seen = [];
  const original = remoteImageProvider.runGeneration;
  const originalGet = remoteImageProvider.getJob;
  remoteImageProvider.runGeneration = async (jobId, provider, req) => { seen.push(req); };
  remoteImageProvider.getJob = () => ({ status: 'done', result: { image_key: 'k' } });
  try {
    const pool = stubPool();
    await bulk.regenerateSubject(pool, {
      table: 'tile_types', kind: 'tile', id: 1, name: 'grass',
      basePrompt: 'green grass', biome: null,
    }, { id: 4, name: 'p' }, { seed: 3 });
    assert.strictEqual(seen.length, 1);
    // frames > 1 is what makes the remote return a sprite SHEET.
    assert.strictEqual(seen[0].frames, 1);
    assert.strictEqual(seen[0].kind, 'tile');
    // 3 is the BASE seed; what goes out is this subject's own seed derived
    // from it. See the per-subject seed tests below.
    assert.strictEqual(seen[0].seed, bulk.seedFor({ table: 'tile_types', name: 'grass' }, 3));
  } finally {
    remoteImageProvider.runGeneration = original;
    remoteImageProvider.getJob = originalGet;
  }
});

test('a finished subject is written to the catalog with its new image key', async () => {
  const original = remoteImageProvider.runGeneration;
  const originalGet = remoteImageProvider.getJob;
  remoteImageProvider.runGeneration = async () => {};
  remoteImageProvider.getJob = () => ({ status: 'done', result: { image_key: 'sprites/x.png' } });
  try {
    const pool = stubPool();
    const res = await bulk.regenerateSubject(pool, {
      table: 'entity_types', kind: 'object', id: 10, name: 'Tree',
      basePrompt: 'a tree', biome: null,
    }, { id: 5, name: 'p' }, {});
    assert.strictEqual(res.ok, true);
    assert.strictEqual(pool.writes.length, 1);
    assert.deepStrictEqual(pool.writes[0].params, ['sprites/x.png', 10]);
  } finally {
    remoteImageProvider.runGeneration = original;
    remoteImageProvider.getJob = originalGet;
  }
});

test('a job that ends without an image writes nothing to the catalog', async () => {
  // The failure that would otherwise point a live tile at a key with no object
  // behind it, showing every player a broken texture.
  const original = remoteImageProvider.runGeneration;
  const originalGet = remoteImageProvider.getJob;
  remoteImageProvider.runGeneration = async () => {};
  remoteImageProvider.getJob = () => ({ status: 'error', error: 'provider answered 500' });
  try {
    const pool = stubPool();
    const res = await bulk.regenerateSubject(pool, {
      table: 'tile_types', kind: 'tile', id: 1, name: 'grass',
      basePrompt: 'g', biome: null,
    }, { id: 4 }, {});
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /provider answered 500/);
    assert.strictEqual(pool.writes.length, 0);
  } finally {
    remoteImageProvider.runGeneration = original;
    remoteImageProvider.getJob = originalGet;
  }
});

// --- Per-subject seeds ---------------------------------------------------

test('every subject gets its own seed, stably', () => {
  // The defect this exists for: 50 tiles generated at seed 0 came back with a
  // mean pairwise structural correlation of +0.83 -- near-identical layouts,
  // differing mainly in colour -- because identical seeds mean identical
  // starting noise. The same tiles at per-subject seeds measured -0.01.
  const a = { table: 'tile_types', name: 'grass' };
  const b = { table: 'tile_types', name: 'rocks' };
  assert.notStrictEqual(bulk.seedFor(a), bulk.seedFor(b), 'two subjects must not share a seed');
  // Same subject, same answer: a re-run reproduces the art rather than
  // rerolling it, which is what makes --resume meaningful.
  assert.strictEqual(bulk.seedFor(a), bulk.seedFor(a));
  // Same NAME in a different catalog is a different subject.
  assert.notStrictEqual(bulk.seedFor(a), bulk.seedFor({ table: 'entity_types', name: 'grass' }));
  // The base shifts the whole catalog to fresh variations.
  assert.notStrictEqual(bulk.seedFor(a), bulk.seedFor(a, 1000));
  for (const s of [bulk.seedFor(a), bulk.seedFor(b), bulk.seedFor(a, 7)]) {
    assert.ok(Number.isInteger(s) && s >= 0, `seed must be a non-negative integer, got ${s}`);
  }
});

test('the seed actually sent is the per-subject one, not the base', async () => {
  const seen = [];
  const original = remoteImageProvider.runGeneration;
  const originalGet = remoteImageProvider.getJob;
  remoteImageProvider.runGeneration = async (jobId, provider, req) => { seen.push(req.seed); };
  remoteImageProvider.getJob = () => ({ status: 'done', result: { image_key: 'k' } });
  try {
    const pool = stubPool();
    const grass = { table: 'tile_types', kind: 'tile', id: 1, name: 'grass', basePrompt: 'g', biome: null };
    const rocks = { table: 'tile_types', kind: 'tile', id: 2, name: 'rocks', basePrompt: 'r', biome: null };
    await bulk.regenerateSubject(pool, grass, { id: 4 }, { seed: 0 });
    await bulk.regenerateSubject(pool, rocks, { id: 4 }, { seed: 0 });
    assert.notStrictEqual(seen[0], seen[1], 'a batch must not send one seed for every subject');
    assert.strictEqual(seen[0], bulk.seedFor(grass));

    // sameSeed is the deliberate escape hatch, e.g. an A/B where the seed must
    // be held constant. It has to still work.
    await bulk.regenerateSubject(pool, grass, { id: 4 }, { seed: 5, sameSeed: true });
    assert.strictEqual(seen[2], 5);
  } finally {
    remoteImageProvider.runGeneration = original;
    remoteImageProvider.getJob = originalGet;
  }
});

// --- Cutout guard --------------------------------------------------------

// Minimal PNG headers: signature, IHDR length/type, 8 bytes of w/h, bit depth,
// then the colour-type byte the guard reads.
function pngHead(colourType) {
  const b = Buffer.alloc(32);
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
  b[24] = 8;              // bit depth
  b[25] = colourType;
  return b;
}

// A store whose objects are just their headers, and a stream that emits once.
function stubStore(colourType) {
  const { Readable } = require('node:stream');
  return {
    getObjectStream: async () => Readable.from([pngHead(colourType)]),
  };
}

test('pngHasAlpha reads the colour type, and admits when it cannot tell', () => {
  assert.strictEqual(bulk.pngHasAlpha(pngHead(6)), true, 'RGBA');
  assert.strictEqual(bulk.pngHasAlpha(pngHead(4)), true, 'grey+alpha');
  assert.strictEqual(bulk.pngHasAlpha(pngHead(2)), false, 'RGB');
  assert.strictEqual(bulk.pngHasAlpha(pngHead(0)), false, 'greyscale');
  // Not a PNG, or too short to hold an IHDR: null, meaning "no opinion". The
  // guard refuses only on a positive false, so an unreadable header never
  // blocks a run.
  assert.strictEqual(bulk.pngHasAlpha(Buffer.from('not a png at all')), null);
  assert.strictEqual(bulk.pngHasAlpha(null), null);
});

test('an entity image with no alpha channel is refused instead of stored', async () => {
  // txt2img returns opaque RGB. Storing that as an entity image turns a
  // cutout into an opaque square -- 194 of them, unattended.
  const original = remoteImageProvider.runGeneration;
  const originalGet = remoteImageProvider.getJob;
  remoteImageProvider.runGeneration = async () => {};
  remoteImageProvider.getJob = () => ({ status: 'done', result: { image_key: 'sprites/o.png' } });
  try {
    const pool = stubPool();
    const res = await bulk.regenerateSubject(pool, {
      table: 'entity_types', kind: 'object', id: 10, name: 'Tree',
      basePrompt: 'a tree', biome: null,
    }, { id: 5 }, { deps: { store: stubStore(2) } });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /no transparency/);
    assert.strictEqual(pool.writes.length, 0, 'the catalog must not be updated');
  } finally {
    remoteImageProvider.runGeneration = original;
    remoteImageProvider.getJob = originalGet;
  }
});

test('an entity image WITH alpha is stored normally', async () => {
  const original = remoteImageProvider.runGeneration;
  const originalGet = remoteImageProvider.getJob;
  remoteImageProvider.runGeneration = async () => {};
  remoteImageProvider.getJob = () => ({ status: 'done', result: { image_key: 'sprites/o.png' } });
  try {
    const pool = stubPool();
    const res = await bulk.regenerateSubject(pool, {
      table: 'entity_types', kind: 'object', id: 10, name: 'Tree',
      basePrompt: 'a tree', biome: null,
    }, { id: 5 }, { deps: { store: stubStore(6) } });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(pool.writes.length, 1);
  } finally {
    remoteImageProvider.runGeneration = original;
    remoteImageProvider.getJob = originalGet;
  }
});

test('a TILE with no alpha is stored -- a tile texture is meant to be opaque', async () => {
  // The guard keys on kind. Applying it everywhere would fail all 50 tiles,
  // which are correct exactly as the provider returns them.
  const original = remoteImageProvider.runGeneration;
  const originalGet = remoteImageProvider.getJob;
  remoteImageProvider.runGeneration = async () => {};
  remoteImageProvider.getJob = () => ({ status: 'done', result: { image_key: 'sprites/t.png' } });
  try {
    const pool = stubPool();
    const res = await bulk.regenerateSubject(pool, {
      table: 'tile_types', kind: 'tile', id: 1, name: 'grass',
      basePrompt: 'grass', biome: null,
    }, { id: 4 }, { deps: { store: stubStore(2) } });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(pool.writes.length, 1);
  } finally {
    remoteImageProvider.runGeneration = original;
    remoteImageProvider.getJob = originalGet;
  }
});

// --- The run ------------------------------------------------------------

// Lets a test hold a run open at a known point and step it forward.
function gatedSubjectRunner() {
  const gates = [];
  const started = [];
  return {
    started,
    release(index, value = { ok: true, imageKey: 'k' }) { gates[index].resolve(value); },
    runner(pool, subject) {
      started.push(subject.name);
      return new Promise((resolve) => { gates.push({ resolve }); });
    },
  };
}

async function tick() { await new Promise(r => setImmediate(r)); }

test('a second run is refused while one is in flight, and allowed after it ends', async () => {
  // One remote box, one GPU. A second concurrent run would interleave two
  // progress counters without finishing anything sooner.
  const gate = gatedSubjectRunner();
  const pool = stubPool({ tiles: [tileRow(), tileRow({ id: 2, name: 'sand' })] });
  const deps = {
    loadProvider: async () => ({ id: 4, name: 'p', model: 'm' }),
    regenerateSubject: gate.runner,
  };
  await bulk.startRun(pool, { kind: 'tiles' }, deps);
  await tick();

  await assert.rejects(
    () => bulk.startRun(pool, { kind: 'tiles' }, deps),
    (err) => err.code === 'ALREADY_RUNNING',
  );

  gate.release(0);
  await tick();
  gate.release(1);
  await tick();
  assert.strictEqual(bulk.getRun().status, 'done');
  assert.strictEqual(bulk.getRun().done, 2);

  // The run is over, so the button works again.
  await bulk.startRun(pool, { kind: 'tiles' }, deps);
  assert.strictEqual(bulk.getRun().status, 'running');
});

test('cancelling stops before the next subject and leaves the finished ones alone', async () => {
  const gate = gatedSubjectRunner();
  const pool = stubPool({
    tiles: [tileRow(), tileRow({ id: 2, name: 'sand' }), tileRow({ id: 3, name: 'stone' })],
  });
  await bulk.startRun(pool, { kind: 'tiles' }, {
    loadProvider: async () => ({ id: 4, name: 'p' }),
    regenerateSubject: gate.runner,
  });
  await tick();
  gate.release(0);
  await tick();

  assert.strictEqual(bulk.cancelRun(), true);
  assert.strictEqual(bulk.getRun().cancelling, true);
  // The subject already in flight is allowed to finish -- aborting mid-call
  // would leave the remote drawing an image nobody stores.
  gate.release(1);
  await tick();

  const run = bulk.getRun();
  assert.strictEqual(run.status, 'cancelled');
  assert.strictEqual(run.done, 2);
  assert.deepStrictEqual(gate.started, ['grass', 'sand']); // 'stone' never started
  assert.strictEqual(bulk.cancelRun(), false, 'cancelling a finished run is a no-op');
});

test('a dead provider stops the run instead of failing all 358 identically', async () => {
  const pool = stubPool({
    tiles: Array.from({ length: 10 }, (_, i) => tileRow({ id: i + 1, name: `t${i}` })),
  });
  await bulk.startRun(pool, { kind: 'tiles', giveUpAfter: 3 }, {
    loadProvider: async () => ({ id: 4, name: 'p' }),
    regenerateSubject: async () => ({ ok: false, error: 'could not reach the box' }),
  });
  // Let the driver work through its failures.
  for (let i = 0; i < 20; i += 1) await tick();

  const run = bulk.getRun();
  assert.strictEqual(run.status, 'error');
  assert.strictEqual(run.failed, 3, 'stopped at the third consecutive failure, not the tenth');
  assert.match(run.error, /3 consecutive failures/);
  assert.strictEqual(run.errors.length, 3);
});

test('a run with nothing to do finishes immediately rather than hanging', async () => {
  // What the buttons hit when no provider is configured at all: the admin gets
  // "0 to generate, here is what was skipped" instead of a spinner.
  const pool = stubPool({ tiles: [tileRow({ ai_provider_mode: 'local' })] });
  const run = await bulk.startRun(pool, { kind: 'tiles' }, {});
  assert.strictEqual(run.status, 'done');
  assert.strictEqual(run.total, 0);
  assert.strictEqual(run.skipped.length, 1);
});

test('an unknown kind is refused before any work starts', async () => {
  await assert.rejects(
    () => bulk.startRun(stubPool(), { kind: 'sprites' }, {}),
    (err) => err.code === 'BAD_REQUEST' && /kind must be one of/.test(err.message),
  );
  // And notably did not leave a run behind.
  assert.strictEqual(bulk.getRun(), null);
});

test('the run view never carries the pool or the raw plan to the client', async () => {
  const pool = stubPool({ tiles: [tileRow()] });
  const run = await bulk.startRun(pool, { kind: 'tiles' }, {
    loadProvider: async () => ({ id: 4, name: 'p' }),
    regenerateSubject: async () => ({ ok: true, imageKey: 'k' }),
  });
  assert.strictEqual(run.pool, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(run, 'cancelRequested'));
  // `plan` is the whole subject list with its catalog rows. It was being sent
  // on every 2s poll -- 26KB for 50 tiles, ~190KB for 358 -- and the UI reads
  // none of it. Caught live, not by this suite, which is why it is here now.
  assert.ok(!Object.prototype.hasOwnProperty.call(run, 'plan'));
  assert.ok(!Object.prototype.hasOwnProperty.call(run, 'consecutiveFailures'));
  // Everything the button actually renders must survive the whitelist.
  for (const key of ['id', 'kind', 'status', 'total', 'done', 'failed',
    'skipped', 'errors', 'current', 'error', 'started_at', 'finished_at', 'cancelling']) {
    assert.ok(Object.prototype.hasOwnProperty.call(run, key), `missing ${key}`);
  }
});
