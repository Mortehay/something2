const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');
const { Pool } = require('pg');
const queue = require('../src/services/artJobQueue.js');
const remote = require('../src/services/remoteImageProvider.js');
const cs = require('../src/services/catalogSubjects.js');
const { dispatch } = require('../src/services/artDispatcher.js');
const { withAdvisoryLock, ART_JOBS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const { makePng, SOLID } = require('./helpers/png.js');

// SOMET-538. Tiles and entities on the shared queue.
//
// The whole risk of moving them here is that they are NOT the same as the three
// new kinds, and treating them as such breaks working art in two specific ways:
// a tile is legitimately an opaque 512 square, and both kinds carry per-type
// provider pins. Everything below is about those two properties.
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

// A FULLY OPAQUE image, which is what a seamless ground texture correctly is.
const opaquePng = () => makePng(64, 64, () => SOLID);
const storeServing = (png) => ({ getObjectStream: async () => Readable.from([png]) });
const succeed = (key) => async (registryId) => {
  remote.setJob(registryId, { status: 'done', result: { image_key: key, frames: 1 } });
};

// The terrain provider as it really is: 512, which is CORRECT for tiles.
const TERRAIN = (id) => ({
  id, name: 'terrain', base_url: 'http://stub/x',
  request_template: { width: 512, height: 512, prompt: '{{prompt}}' },
});

async function freshPool(t) {
  const pool = new Pool({ connectionString: DB_URL, max: 6, connectionTimeoutMillis: 3000 });
  const { rows } = await pool.query(
    `INSERT INTO ai_providers (name, base_url, request_template)
     VALUES ($1, 'http://stub.invalid/x', '{"width":512,"height":512}'::jsonb) RETURNING id`,
    [`zzTestTE ${process.pid} ${Date.now()}`],
  );
  const providerId = rows[0].id;
  t.after(async () => {
    await pool.query('DELETE FROM ai_providers WHERE id = $1', [providerId]).catch(() => {});
    await pool.end().catch(() => {});
  });
  return { pool, providerId };
}

// Every case restores whatever catalogue rows it touched, INSIDE the lock.
function lockedTest(name, body) {
  test(name, async (t) => {
    if (!requireTestDb(t, 'writes tile_types and entity_types')) return;
    const { pool, providerId } = await freshPool(t);
    await withAdvisoryLock(pool, ART_JOBS_LOCK_KEY, async () => {
      await pool.query('DELETE FROM art_jobs');
      // The PIN COLUMNS are snapshotted too. ai_provider_mode is NOT NULL with
      // a 'default' default, so a cleanup that resets it to NULL throws, gets
      // swallowed by .catch, and leaves the pin in place for every later test.
      const tiles = await pool.query(
        'SELECT id, image, ai_provider_mode, ai_provider_id FROM tile_types');
      const ents = await pool.query('SELECT id, image, render_mode FROM entity_types');
      try {
        await body(t, pool, providerId);
      } finally {
        // Put the catalogue back exactly as it was: these are REAL rows the
        // rest of the suite reads, not fixtures of ours.
        for (const r of tiles.rows) {
          await pool.query(
            `UPDATE tile_types SET image = $1, ai_provider_mode = $2, ai_provider_id = $3
              WHERE id = $4`,
            [r.image, r.ai_provider_mode, r.ai_provider_id, r.id],
          ).catch(() => {});
        }
        for (const r of ents.rows) {
          await pool.query('UPDATE entity_types SET image = $1, render_mode = $2 WHERE id = $3',
            [r.image, r.render_mode, r.id]).catch(() => {});
        }
        await pool.query('DELETE FROM art_jobs').catch(() => {});
      }
    });
  });
}

// --- The guards must not reach a tile ------------------------------------

// THE EXPENSIVE MISTAKE IN THIS TICKET. Both cutout guards are correct for an
// isolated object and wrong for a seamless texture. Applied to tiles they would
// refuse the entire terrain catalogue, and it would read as the provider having
// broken rather than the guard being pointed at the wrong thing.
lockedTest('a fully OPAQUE tile is accepted -- the cutout guards are object-only',
  async (t, pool, providerId) => {
    const [tile] = await cs.SUBJECTS.tile.list(pool);
    await queue.enqueue(pool, [{ kind: 'tile', key: tile.key }],
      { backend: 'connector', providerId });

    const out = await dispatch(pool, {
      provider: TERRAIN(providerId),
      generate: succeed('zzTest/tiles/grass.png'),
      deps: { store: storeServing(opaquePng()) },
    });
    assert.equal(out.done, 1,
      `an opaque tile must be accepted; got ${JSON.stringify(out.results)}`);

    const { rows } = await pool.query('SELECT image FROM tile_types WHERE name = $1', [tile.key]);
    assert.equal(rows[0].image, 'zzTest/tiles/grass.png');
  });

// The counterpart: the same opaque image sent for an OBJECT is still refused,
// so the exemption is scoped rather than a hole.
lockedTest('the same opaque image is still refused for an object kind',
  async (t, pool, providerId) => {
    const [skill] = await cs.SUBJECTS.skill.list();
    await queue.enqueue(pool, [{ kind: 'skill', key: skill.key }],
      { backend: 'connector', providerId });
    t.after(async () => {
      await pool.query("DELETE FROM catalog_art WHERE image LIKE 'zzTest%'").catch(() => {});
    });

    const out = await dispatch(pool, {
      provider: { id: providerId, request_template: { width: 1024, height: 1024 } },
      generate: succeed('zzTest/opaque-object.png'),
      deps: { store: storeServing(opaquePng()) },
    });
    assert.equal(out.done, 0, 'an opaque square is not an icon');
    assert.equal(out.failed, 1);
  });

// A 512 provider is CORRECT for terrain. Refusing it because 512 is below the
// object minimum would block a perfectly good tile batch.
lockedTest('a 512 provider is not refused when only tiles are queued',
  async (t, pool, providerId) => {
    const [tile] = await cs.SUBJECTS.tile.list(pool);
    await queue.enqueue(pool, [{ kind: 'tile', key: tile.key }],
      { backend: 'connector', providerId });

    const out = await dispatch(pool, {
      provider: TERRAIN(providerId),
      generate: succeed('zzTest/tiles/ok.png'),
      deps: { store: storeServing(opaquePng()) },
    });
    assert.equal(out.claimed, 1, 'a tile batch on a 512 provider must run');
  });

// ...but the moment an OBJECT is in the queue, the same provider is refused.
lockedTest('the same 512 provider IS refused once an object kind is queued',
  async (t, pool, providerId) => {
    const [tile] = await cs.SUBJECTS.tile.list(pool);
    const [skill] = await cs.SUBJECTS.skill.list();
    await queue.enqueue(pool, [
      { kind: 'tile', key: tile.key }, { kind: 'skill', key: skill.key },
    ], { backend: 'connector', providerId });

    await assert.rejects(
      () => dispatch(pool, { provider: TERRAIN(providerId), generate: succeed('x') }),
      /below the 1024px minimum/,
    );
    const { rows } = await pool.query("SELECT count(*)::int n FROM art_jobs WHERE state='queued'");
    assert.equal(rows[0].n, 2, 'the queue must be untouched by a configuration refusal');
  });

// --- Entities -------------------------------------------------------------

// A type carrying an image that still draws as a colour box would show none of
// the art the run just paid for. The bulk tool already does this; moving to the
// queue must not lose it.
lockedTest('an entity that drew as a colour box is promoted to static',
  async (t, pool, providerId) => {
    const { rows: before } = await pool.query(
      "SELECT name FROM entity_types WHERE render_mode = 'rect' ORDER BY name LIMIT 1");
    if (before.length === 0) return t.skip('no rect entity in this catalogue to promote');
    const name = before[0].name;

    await queue.enqueue(pool, [{ kind: 'entity', key: name }],
      { backend: 'connector', providerId });
    const out = await dispatch(pool, {
      provider: { id: providerId, request_template: { width: 1024, height: 1024 } },
      generate: succeed('zzTest/entities/thing.png'),
      deps: { store: storeServing(makePng(64, 64, (x, y) => (x > 20 && x < 44 && y > 20 && y < 44 ? SOLID : 0))) },
    });
    assert.equal(out.done, 1, `expected the entity to be written; got ${JSON.stringify(out.results)}`);

    const { rows } = await pool.query(
      'SELECT image, render_mode FROM entity_types WHERE name = $1', [name]);
    assert.equal(rows[0].image, 'zzTest/entities/thing.png');
    assert.equal(rows[0].render_mode, 'static',
      'a rect type given art must stop drawing as a colour box');
  });

// --- Provider pins --------------------------------------------------------

// A type pinned to a provider was pinned for a reason. Sending it to whatever
// provider the batch was started with would silently retarget it, and the
// result looks like the model changed rather than like the pin being ignored.
lockedTest('a pinned type keeps its own provider, an unpinned one takes the batch default',
  async (t, pool, providerId) => {
    const { rows: pin } = await pool.query(
      `INSERT INTO ai_providers (name, base_url, request_template)
       VALUES ($1, 'http://pinned.invalid/x', '{}'::jsonb) RETURNING id`,
      [`zzTestPinned ${process.pid} ${Date.now()}`]);
    const pinnedId = pin[0].id;
    const tiles = await cs.SUBJECTS.tile.list(pool);
    const [a, b] = tiles;
    await pool.query(
      `UPDATE tile_types SET ai_provider_mode = 'provider', ai_provider_id = $1 WHERE name = $2`,
      [pinnedId, a.key]);
    // The pin itself is restored by lockedTest's snapshot; only the extra
    // provider row is this test's own to remove, and it must go AFTER the jobs
    // that reference it.
    t.after(async () => {
      await pool.query('DELETE FROM art_jobs').catch(() => {});
      await pool.query('DELETE FROM ai_providers WHERE id = $1', [pinnedId]).catch(() => {});
    });

    const { subjects } = await cs.subjectsForEnqueue(pool, 'tile', [a.key, b.key],
      { active: null, fallbackProviderId: providerId });
    await queue.enqueue(pool, subjects, { backend: 'connector', providerId });

    const { rows } = await pool.query(
      'SELECT subject_key, provider_id FROM art_jobs ORDER BY subject_key');
    const byKey = new Map(rows.map((r) => [r.subject_key, r.provider_id]));
    assert.equal(byKey.get(a.key), pinnedId,
      'the pinned tile must keep its own provider, not the batch default');
    assert.equal(byKey.get(b.key), providerId,
      'an unpinned tile takes the batch default');
  });

// A type pinned to 'local' asked for the local service by name.
lockedTest('a type pinned to local is not redirected to the batch provider',
  async (t, pool, providerId) => {
    const [tile] = await cs.SUBJECTS.tile.list(pool);
    await pool.query("UPDATE tile_types SET ai_provider_mode = 'local' WHERE name = $1", [tile.key]);

    const { subjects } = await cs.subjectsForEnqueue(pool, 'tile', [tile.key],
      { active: null, fallbackProviderId: providerId });
    assert.equal(subjects[0].providerId, null,
      'a local pin means local -- not "whatever this batch is using"');
  });

// A key that has left the catalogue is reported, not silently dropped:
// "I selected 100 and 97 were queued" needs an explanation.
lockedTest('a selected key that no longer exists is reported back', async (t, pool) => {
  const [tile] = await cs.SUBJECTS.tile.list(pool);
  const { subjects, unknown } = await cs.subjectsForEnqueue(
    pool, 'tile', [tile.key, 'zzNoSuchTile'], {});
  assert.deepEqual(subjects.map((s) => s.key), [tile.key]);
  assert.deepEqual(unknown, ['zzNoSuchTile']);
});
