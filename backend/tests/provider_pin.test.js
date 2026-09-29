// SOMET-342. The per-type generation pin has existed as two columns and a
// resolver since SOMET-328 and could not be SET by anything: no route wrote
// them. These cover the write half.
//
// The unit tests below are about the rule; the DB test at the bottom is about
// the two things only a real database can answer -- that a saved pin comes
// back on reload, and that deleting the provider degrades the pin to Default
// rather than leaving a dangling reference.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const {
  PIN_MODES, pinProvided, providerPinError, providerPinValues, providerPinModalityError,
} = require('../src/services/providerPin.js');
const { resolveGenerationTarget } = require('../src/services/generationTarget.js');

test('a body with neither key is not a pin write', () => {
  // The whole reason a PUT that knows nothing about pins is safe: the route
  // leaves both columns alone. If this ever returns true for an unrelated
  // body, every save from an older client silently resets the pin.
  assert.strictEqual(pinProvided({ name: 'Wolf', prompt: 'a wolf' }), false);
  assert.strictEqual(pinProvided({ ai_provider_mode: 'default' }), true);
  assert.strictEqual(pinProvided({ ai_provider_id: null }), true);
});

test('an unknown mode is refused with a readable message', () => {
  // The DB CHECK also refuses it -- as a 500 carrying a constraint name.
  const err = providerPinError({ ai_provider_mode: 'whatever' });
  assert.match(err, /ai_provider_mode must be one of/);
  for (const mode of PIN_MODES) {
    assert.strictEqual(providerPinError({ ai_provider_mode: mode, ai_provider_id: 7 }), null, mode);
  }
});

test('a provider pin with no target is refused', () => {
  // The half-state the DB cannot see: mode says "this specific service", the
  // id says nothing, and the resolver would quietly fall through to whichever
  // provider happens to be active. That is not what the admin asked for.
  assert.match(providerPinError({ ai_provider_mode: 'provider' }),
    /needs an ai_provider_id/);
  assert.match(providerPinError({ ai_provider_mode: 'provider', ai_provider_id: null }),
    /needs an ai_provider_id/);
});

test('a non-integer provider id is refused', () => {
  assert.match(providerPinError({ ai_provider_mode: 'provider', ai_provider_id: 'two' }),
    /must be an integer/);
  assert.match(providerPinError({ ai_provider_id: 1.5 }), /must be an integer/);
});

test('unpinning drops a stale id instead of failing the save', () => {
  // The editor posts the whole form, so a type being changed FROM a provider
  // TO default arrives with the old id still in the payload. Rejecting that
  // would make "unpin" impossible from the obvious UI; storing it would leave
  // a pin that shows as Default and does nothing.
  assert.strictEqual(providerPinError({ ai_provider_mode: 'default', ai_provider_id: 3 }), null);
  assert.deepStrictEqual(providerPinValues({ ai_provider_mode: 'default', ai_provider_id: 3 }),
    { mode: 'default', id: null });
  assert.deepStrictEqual(providerPinValues({ ai_provider_mode: 'local', ai_provider_id: 3 }),
    { mode: 'local', id: null });
  assert.deepStrictEqual(providerPinValues({ ai_provider_mode: 'provider', ai_provider_id: 3 }),
    { mode: 'provider', id: 3 });
});

test('a pin write with only an id normalizes to default, not to a broken pin', () => {
  // `{ai_provider_id: 5}` with no mode is not a request to pin -- mode is the
  // field that decides, and its column default is 'default'.
  assert.deepStrictEqual(providerPinValues({ ai_provider_id: 5 }), { mode: 'default', id: null });
});

test('the pin loses to a per-job choice and beats the global default', () => {
  // Precedence is SOMET-328's and already tested there; asserted here because
  // it is the acceptance criterion this ticket has to keep true while adding
  // the ability to set the pin at all.
  const pinned = { ai_provider_mode: 'provider', ai_provider_id: 2 };
  const active = { id: 9 };
  assert.deepStrictEqual(
    resolveGenerationTarget({ request: { ai_provider_id: 4 }, type: pinned, active }),
    { source: 'remote', providerId: 4 }, 'the per-job selector must win for that job');
  assert.deepStrictEqual(
    resolveGenerationTarget({ request: {}, type: pinned, active }),
    { source: 'remote', providerId: 2 }, 'the pin must beat the global default');
  assert.deepStrictEqual(
    resolveGenerationTarget({ request: {}, type: { ai_provider_mode: 'default' }, active }),
    { source: 'remote', providerId: 9 }, 'an unpinned type follows the active provider');
});

// --- SOMET-591: a pin may not name the audio provider ----------------------
//
// providerPinError above stays pure and synchronous; whether an id names an
// image or audio row is a database fact, so that half is this async
// function, called separately at each route that persists a pin (see
// index.js). Unit-tested here against a fake db so the rule is covered
// without needing a real connection for every shape; the DB test further
// down exercises the actual routes end to end.

test('providerPinModalityError only refuses a pin that actually names the audio provider', async () => {
  const fakeDb = (modality) => ({ query: async () => ({ rows: modality == null ? [] : [{ modality }] }) });
  const refuseIfCalled = { query: async () => { throw new Error('must not query when there is no id to check'); } };

  assert.strictEqual(
    await providerPinModalityError(fakeDb('image'), { mode: 'provider', id: 3 }), null,
    'an image provider id is allowed');
  assert.match(
    await providerPinModalityError(fakeDb('audio'), { mode: 'provider', id: 3 }),
    /not an image provider/);
  assert.strictEqual(
    await providerPinModalityError(fakeDb(null), { mode: 'provider', id: 999 }), null,
    'a dangling id degrades like any other pin to a deleted provider, not a rejection here');
  assert.strictEqual(
    await providerPinModalityError(refuseIfCalled, { mode: 'default', id: null }), null,
    'default/local pins carry no id, so no lookup is made');
  assert.strictEqual(
    await providerPinModalityError(refuseIfCalled, { mode: 'provider', id: null }), null,
    'a bare "provider" mode with no id is already refused by providerPinError before this would run');
});

const TEST_DB = process.env.TEST_DATABASE_URL;

test('a pin round-trips, and survives its provider being deleted as Default',
  { skip: !TEST_DB && 'TEST_DATABASE_URL not set' }, async () => {
    const pool = new Pool({ connectionString: TEST_DB });
    const name = `zzPinType-${process.pid}`;
    try {
      const prov = await pool.query(
        `INSERT INTO ai_providers (name, base_url, request_template)
         VALUES ($1, 'https://example.invalid', '{}'::jsonb) RETURNING id`,
        [`zzPinProvider-${process.pid}`]);
      const providerId = prov.rows[0].id;

      await pool.query(
        `INSERT INTO entity_types (name, color, ai_provider_mode, ai_provider_id)
         VALUES ($1, '#123456', 'provider', $2)`, [name, providerId]);

      // Reload: the pin is what the editor will show.
      const back = await pool.query(
        'SELECT ai_provider_mode, ai_provider_id FROM entity_types WHERE name = $1', [name]);
      assert.deepStrictEqual(back.rows[0], { ai_provider_mode: 'provider', ai_provider_id: providerId });

      // Delete the provider. ON DELETE SET NULL clears the id and leaves the
      // mode saying 'provider' -- a dangling pin, which the resolver is
      // written to treat as "no pin" rather than as a broken type.
      await pool.query('DELETE FROM ai_providers WHERE id = $1', [providerId]);
      const after = await pool.query(
        'SELECT ai_provider_mode, ai_provider_id FROM entity_types WHERE name = $1', [name]);
      assert.strictEqual(after.rows[0].ai_provider_id, null);
      assert.deepStrictEqual(
        resolveGenerationTarget({ request: {}, type: after.rows[0], active: null }),
        { source: 'local' },
        'a pin whose provider is gone must fall back, not point at a deleted id');
    } finally {
      await pool.query('DELETE FROM entity_types WHERE name = $1', [name]).catch(() => {});
      await pool.query('DELETE FROM ai_providers WHERE name LIKE $1', [`zzPinProvider-${process.pid}`]).catch(() => {});
      await pool.end();
    }
  });

// The three routes that persist a pin (POST/PUT entity-types, PUT tile-types)
// each call providerPinModalityError before writing. Exercised through the
// real app + a real database, not a mocked pool.query -- the whole point of
// the rule is a fact that only a database has, so it is not meaningfully
// testable against a fake.
test('a pin naming the audio provider is refused with 400 "not an image provider" at every write route',
  { skip: !TEST_DB && 'TEST_DATABASE_URL not set' }, async (t) => {
    require('./helpers/auth.js');
    const request = require('supertest');
    const { app, __setPool } = require('../src/index.js');
    const { signToken } = require('../src/auth/tokens.js');
    const pool = new Pool({ connectionString: TEST_DB });
    __setPool(pool);
    const made = {
      providers: [], entityTypes: [], tileTypes: [], users: [],
    };
    t.after(async () => {
      try {
        if (made.entityTypes.length) await pool.query('DELETE FROM entity_types WHERE id = ANY($1)', [made.entityTypes]);
        if (made.tileTypes.length) await pool.query('DELETE FROM tile_types WHERE id = ANY($1)', [made.tileTypes]);
        if (made.providers.length) await pool.query('DELETE FROM ai_providers WHERE id = ANY($1)', [made.providers]);
        if (made.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]);
      } finally { await pool.end(); }
    });

    const tag = `${process.pid}-${Date.now()}`;
    const u = (await pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version',
      [`pin-modality-${tag}`, 'x', 'admin'])).rows[0];
    made.users.push(u.id);
    const auth = `Bearer ${signToken({
      userId: u.id, username: `pin-modality-${tag}`, role: 'admin', tokenVersion: u.token_version,
    })}`;

    const aud = (await pool.query(
      `INSERT INTO ai_providers (name, base_url, modality, request_template)
       VALUES ($1, 'http://127.0.0.1:9/', 'audio', '{}'::jsonb) RETURNING id`,
      [`pin-modality-audio-${tag}`])).rows[0];
    made.providers.push(aud.id);
    const img = (await pool.query(
      `INSERT INTO ai_providers (name, base_url, request_template)
       VALUES ($1, 'http://127.0.0.1:9/', '{}'::jsonb) RETURNING id`,
      [`pin-modality-image-${tag}`])).rows[0];
    made.providers.push(img.id);

    // POST /api/entity-types refuses the audio id ...
    const entityName = `pin-modality-entity-${tag}`;
    const post = await request(app).post('/api/entity-types').set('Authorization', auth).send({
      name: entityName, color: '#123456', ai_provider_mode: 'provider', ai_provider_id: aud.id,
    });
    assert.equal(post.status, 400, JSON.stringify(post.body));
    assert.match(post.body.error, /not an image provider/);
    const notCreated = await pool.query('SELECT id FROM entity_types WHERE name = $1', [entityName]);
    assert.equal(notCreated.rows.length, 0, 'the refused pin must not create the row');

    // ... and accepts the equivalent pin naming the image provider.
    const postOk = await request(app).post('/api/entity-types').set('Authorization', auth).send({
      name: entityName, color: '#123456', ai_provider_mode: 'provider', ai_provider_id: img.id,
    });
    assert.equal(postOk.status, 201, JSON.stringify(postOk.body));
    made.entityTypes.push(postOk.body.id);

    // PUT /api/entity-types/:id refuses it on update too, and leaves the
    // stored pin untouched rather than half-applying the write.
    const put = await request(app).put(`/api/entity-types/${postOk.body.id}`).set('Authorization', auth).send({
      name: entityName, color: '#123456', ai_provider_mode: 'provider', ai_provider_id: aud.id,
    });
    assert.equal(put.status, 400, JSON.stringify(put.body));
    assert.match(put.body.error, /not an image provider/);
    const afterPut = await pool.query('SELECT ai_provider_id FROM entity_types WHERE id = $1', [postOk.body.id]);
    assert.equal(afterPut.rows[0].ai_provider_id, img.id, 'the existing pin survives a refused write');

    // PUT /api/tile-types/:id refuses it as well.
    const tileName = `pin-modality-tile-${tag}`;
    const tile = (await pool.query(
      'INSERT INTO tile_types (name, color) VALUES ($1, $2) RETURNING id', [tileName, '#654321'])).rows[0];
    made.tileTypes.push(tile.id);
    const putTile = await request(app).put(`/api/tile-types/${tile.id}`).set('Authorization', auth).send({
      name: tileName, color: '#654321', ai_provider_mode: 'provider', ai_provider_id: aud.id,
    });
    assert.equal(putTile.status, 400, JSON.stringify(putTile.body));
    assert.match(putTile.body.error, /not an image provider/);
  });
