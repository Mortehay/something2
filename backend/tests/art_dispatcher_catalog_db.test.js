const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');
const { Pool } = require('pg');
const queue = require('../src/services/artJobQueue.js');
const remote = require('../src/services/remoteImageProvider.js');
const cs = require('../src/services/catalogSubjects.js');
const { dispatch } = require('../src/services/artDispatcher.js');
const { withAdvisoryLock, ART_JOBS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const { unkeyedBackdropPng, cutoutPng } = require('./helpers/png.js');

// SOMET-540, the wiring half: what a FINISHED generation does to the catalog.
//
// The queue's own tests cover claiming and retries. These cover the step that
// was missing until now -- pointing the subject at the image. Without it a
// 617-image batch reports 617 successes and every subject still renders as a
// blank slot, which is exactly the "green over a dead feature" shape this repo
// keeps finding.
const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

// A provider at native resolution, so these cases exercise the catalog write
// rather than tripping the size precondition -- which has its own tests.
const PROVIDER = (id) => ({
  id, name: 'stub gpu', base_url: 'http://stub/sdapi/v1/txt2img',
  request_template: { width: 1024, height: 1024, prompt: '{{prompt}}' },
});

// A PNG header with a chosen colour type. 6 = RGBA (a real cutout), 2 = RGB
// (an opaque square, which is what txt2img returns without a cutout step).
function pngHead(colourType) {
  const b = Buffer.alloc(32);
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
  b[25] = colourType;
  return b;
}
const storeReturning = (colourType) => ({
  getObjectStream: async () => Readable.from([pngHead(colourType)]),
});

// A store serving a COMPLETE png, which the transparency guard needs -- it
// reads every scanline, unlike the header check.
const storeServing = (png) => ({
  getObjectStream: async () => Readable.from([png]),
});

const succeed = (key) => async (registryId) => {
  remote.setJob(registryId, { status: 'done', result: { image_key: key, frames: 1 } });
};

async function freshPool(t) {
  const pool = new Pool({ connectionString: DB_URL, max: 6, connectionTimeoutMillis: 3000 });
  const { rows } = await pool.query(
    `INSERT INTO ai_providers (name, base_url, request_template)
     VALUES ($1, 'http://stub.invalid/sdapi/v1/txt2img', '{}'::jsonb) RETURNING id`,
    [`zzTestProvider ${process.pid} ${Date.now()}`],
  );
  const providerId = rows[0].id;
  t.after(async () => {
    // NOT 'DELETE FROM art_jobs' here. t.after runs AFTER the advisory lock is
    // released, so a blanket delete at this point wipes a PEER FILE's in-flight
    // jobs -- three files now share ART_JOBS_LOCK_KEY and all three claim
    // globally. Measured: peers reported claimed:0 and failed on a job they had
    // just enqueued. This file's own rows are already cleaned inside the lock,
    // by lockedTest's finally.
    await pool.query("DELETE FROM catalog_art WHERE image LIKE 'zzTest%'").catch(() => {});
    await pool.query('DELETE FROM ai_providers WHERE id = $1', [providerId]).catch(() => {});
    await pool.end().catch(() => {});
  });
  return { pool, providerId };
}

function lockedTest(name, body) {
  test(name, async (t) => {
    if (!requireTestDb(t, 'writes art_jobs and catalog_art')) return;
    const { pool, providerId } = await freshPool(t);
    await withAdvisoryLock(pool, ART_JOBS_LOCK_KEY, async () => {
      await pool.query('DELETE FROM art_jobs');
      try {
        await body(t, pool, providerId);
      } finally {
        await pool.query('DELETE FROM art_jobs').catch(() => {});
      }
    });
  });
}

// THE POINT OF THE WHOLE QUEUE. A job marked done whose subject still has no
// art is a batch that did nothing.
lockedTest('a finished job points its subject at the generated image', async (t, pool, providerId) => {
  const [skill] = await cs.SUBJECTS.skill.list();
  await queue.enqueue(pool, [{ kind: 'skill', key: skill.key }],
    { backend: 'connector', providerId });

  const out = await dispatch(pool, {
    provider: PROVIDER(providerId),
    generate: succeed('zzTest/skills/1/static.png'),
    deps: { store: storeReturning(6) },
  });
  assert.equal(out.done, 1, `dispatch reported ${JSON.stringify(out.results)}`);

  const { rows } = await pool.query(
    'SELECT image, provider_id FROM catalog_art WHERE subject_kind = $1 AND subject_key = $2',
    ['skill', skill.key],
  );
  assert.equal(rows.length, 1, 'the subject must now have art -- this is the deliverable');
  assert.equal(rows[0].image, 'zzTest/skills/1/static.png');
  assert.equal(rows[0].provider_id, providerId,
    'which provider drew it is the first question when a batch comes out wrong');
});

// Items do NOT write catalog_art -- they have their own icon column. A single
// write path would have quietly left all 189 merchant goods blank.
lockedTest('an item writes its own icon column, not catalog_art', async (t, pool, providerId) => {
  const { rows: before } = await pool.query(
    "SELECT name, icon FROM item_types ORDER BY name LIMIT 1");
  const item = before[0];
  t.after(async () => {
    await pool.query('UPDATE item_types SET icon = $1 WHERE name = $2', [item.icon, item.name])
      .catch(() => {});
  });

  await queue.enqueue(pool, [{ kind: 'item', key: item.name }],
    { backend: 'connector', providerId });
  const out = await dispatch(pool, {
    provider: PROVIDER(providerId),
    generate: succeed('zzTest/items/1/static.png'),
    deps: { store: storeReturning(6) },
  });
  assert.equal(out.done, 1, `dispatch reported ${JSON.stringify(out.results)}`);

  const { rows } = await pool.query('SELECT icon FROM item_types WHERE name = $1', [item.name]);
  assert.equal(rows[0].icon, 'zzTest/items/1/static.png');
  const { rows: art } = await pool.query(
    "SELECT 1 FROM catalog_art WHERE subject_kind = 'item'");
  assert.equal(art.length, 0, 'an item must not also land in catalog_art -- two homes drift');
});

// Stable Diffusion has no alpha channel. An opaque square renders as a grey
// block in an icon slot, and it is indistinguishable from real art by every
// check except this one.
lockedTest('an image with no transparency is refused, and the subject keeps no art', async (t, pool, providerId) => {
  const [skill] = await cs.SUBJECTS.skill.list();
  await queue.enqueue(pool, [{ kind: 'skill', key: skill.key }],
    { backend: 'connector', providerId });

  const out = await dispatch(pool, {
    provider: PROVIDER(providerId),
    generate: succeed('zzTest/opaque.png'),
    deps: { store: storeReturning(2) },       // RGB, no alpha
  });
  assert.equal(out.done, 0);
  assert.equal(out.failed, 1);

  const { rows } = await pool.query(
    'SELECT 1 FROM catalog_art WHERE subject_kind = $1 AND subject_key = $2',
    ['skill', skill.key],
  );
  assert.equal(rows.length, 0, 'a refused image must not be recorded as the subject\'s art');
  const { rows: job } = await pool.query('SELECT last_error FROM art_jobs');
  assert.match(job[0].last_error, /transparency/);
});

// "done" with nothing to point at is not done.
lockedTest('a generation that finishes without an image_key is a failure', async (t, pool, providerId) => {
  const [skill] = await cs.SUBJECTS.skill.list();
  await queue.enqueue(pool, [{ kind: 'skill', key: skill.key }],
    { backend: 'connector', providerId });

  const out = await dispatch(pool, {
    provider: PROVIDER(providerId),
    generate: async (id) => { remote.setJob(id, { status: 'done', result: { frames: 1 } }); },
    deps: { store: storeReturning(6) },
  });
  assert.equal(out.failed, 1);
  const { rows } = await pool.query('SELECT last_error FROM art_jobs');
  assert.match(rows[0].last_error, /image_key/);
});

// Passive labels move when the tree is reseeded and catalogue rows get
// renamed. A job whose subject has vanished must fail with a reason rather
// than throw and wedge the row in `running`.
lockedTest('a subject that has left the catalogue fails with a reason', async (t, pool, providerId) => {
  await queue.enqueue(pool, [{ kind: 'passive_label', key: 'zzTestNoSuchLabel' }],
    { backend: 'connector', providerId });

  const out = await dispatch(pool, {
    provider: PROVIDER(providerId), generate: succeed('zzTest/x.png'),
  });
  assert.equal(out.failed, 1);
  const { rows } = await pool.query('SELECT state, last_error FROM art_jobs');
  assert.match(rows[0].last_error, /no longer in the catalogue/);
  assert.notEqual(rows[0].state, 'running', 'the row must not be left claimed');
});

// THE PRECONDITION, at the level that matters: a misconfigured provider must
// cost nothing. Claiming first and failing per row would burn an attempt on
// every one of 617 subjects before anyone noticed.
lockedTest('a below-native provider is refused BEFORE anything is claimed', async (t, pool, providerId) => {
  const [skill] = await cs.SUBJECTS.skill.list();
  await queue.enqueue(pool, [{ kind: 'skill', key: skill.key }],
    { backend: 'connector', providerId });

  await assert.rejects(
    () => dispatch(pool, {
      provider: { id: providerId, name: 'half-native', request_template: { width: 512, height: 512 } },
      generate: succeed('zzTest/x.png'),
    }),
    /below the 1024px minimum/,
  );

  const { rows } = await pool.query('SELECT state, attempts FROM art_jobs');
  assert.equal(rows[0].state, 'queued', 'the queue must be untouched');
  assert.equal(rows[0].attempts, 0, 'no attempt may be burned by a configuration error');
});

// The composed prompt is what actually reaches the provider. Asserting the
// request the dispatcher builds, not the helper that builds it.
lockedTest('the request sent for a real subject carries the wrapped prompt and its own seed', async (t, pool, providerId) => {
  const [skill] = await cs.SUBJECTS.skill.list();
  const [job] = await queue.enqueue(pool, [{ kind: 'skill', key: skill.key }],
    { backend: 'connector', providerId });

  let sent = null;
  await dispatch(pool, {
    provider: PROVIDER(providerId),
    generate: async (id, provider, req) => {
      sent = req;
      remote.setJob(id, { status: 'done', result: { image_key: 'zzTest/x.png', frames: 1 } });
    },
    deps: { store: storeReturning(6) },
  });

  assert.ok(sent, 'the generator was never called');
  assert.match(sent.prompt, /^only .* and nothing else, one single object, centered/);
  assert.ok(!/\{\{/.test(sent.prompt), 'no unsubstituted placeholder may reach the provider');
  assert.equal(sent.seed, Number(job.seed),
    'the seed stored at enqueue must be the one sent, or a re-run draws something else');
  assert.equal(sent.frames, 1);
});


// AN ALPHA CHANNEL IS NOT A CUTOUT. Found by looking at a live batch rather than
// by a failing test: a passive label came back as a scene with the magenta
// backdrop never keyed -- 90% opaque, alpha channel present, colour type 6. It
// passed the header check, passed the provider's own 422 (which fires near 1%),
// and was written to the catalog as a success. In an icon slot it is a square.
lockedTest('an image whose backdrop was never keyed is refused, though it HAS alpha',
  async (t, pool, providerId) => {
    const [skill] = await cs.SUBJECTS.skill.list();
    await queue.enqueue(pool, [{ kind: 'skill', key: skill.key }],
      { backend: 'connector', providerId });

    const out = await dispatch(pool, {
      provider: PROVIDER(providerId),
      generate: succeed('zzTest/unkeyed.png'),
      deps: { store: storeServing(unkeyedBackdropPng()) },
    });
    assert.equal(out.done, 0, 'a coloured square must not be recorded as art');
    assert.equal(out.failed, 1);

    const { rows } = await pool.query(
      'SELECT 1 FROM catalog_art WHERE subject_kind = $1 AND subject_key = $2',
      ['skill', skill.key],
    );
    assert.equal(rows.length, 0);
    const { rows: job } = await pool.query('SELECT last_error FROM art_jobs');
    assert.match(job[0].last_error, /backdrop was not keyed/);
    assert.match(job[0].last_error, /transparent/,
      'the message must carry the measurement, or it is unactionable');
  });

// The counterpart, so the guard is shown to ACCEPT a real cutout rather than
// merely to reject things. A floor that refuses everything would pass the test
// above and break the entire feature.
lockedTest('a genuine cutout passes the transparency floor and is recorded',
  async (t, pool, providerId) => {
    const [skill] = await cs.SUBJECTS.skill.list();
    await queue.enqueue(pool, [{ kind: 'skill', key: skill.key }],
      { backend: 'connector', providerId });

    const out = await dispatch(pool, {
      provider: PROVIDER(providerId),
      generate: succeed('zzTest/cutout.png'),
      deps: { store: storeServing(cutoutPng()) },
    });
    assert.equal(out.done, 1, `a real cutout must be accepted; got ${JSON.stringify(out.results)}`);
    const { rows } = await pool.query(
      'SELECT image FROM catalog_art WHERE subject_kind = $1 AND subject_key = $2',
      ['skill', skill.key],
    );
    assert.equal(rows[0].image, 'zzTest/cutout.png');
  });
