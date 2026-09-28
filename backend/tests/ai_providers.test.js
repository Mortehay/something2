const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const {
  serializeProvider,
  serializeProviders,
  providerFieldError,
  baseUrlError,
  buildProviderPatch,
  setActiveProvider,
  loadActiveProviderWithSecret,
  loadImageProviderWithSecret,
  createProvider,
} = require('../src/services/aiProviders');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// Tests below call setActiveProvider, which clears the active row of the
// target's modality -- including a real provider someone left active on the
// test database (e.g. the audio box profile). Snapshot the active ids first
// and put them back after the test's own rows are deleted, so a run never
// leaves the database without the providers it started with.
async function snapshotActive(pool) {
  const ids = (await pool.query('SELECT id FROM ai_providers WHERE is_active')).rows.map((r) => r.id);
  return async function restoreActive() {
    if (!ids.length) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Clear whatever is active in each snapshotted modality, then re-set the
      // snapshot (the per-modality unique index forbids two at once).
      await client.query(
        `UPDATE ai_providers SET is_active = false
          WHERE is_active AND id <> ALL($1)
            AND modality IN (SELECT modality FROM ai_providers WHERE id = ANY($1))`, [ids]);
      await client.query('UPDATE ai_providers SET is_active = true WHERE id = ANY($1) AND NOT is_active', [ids]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
}

// A stored row as Postgres hands it back.
function row(over = {}) {
  return {
    id: 1,
    name: 'desktop',
    base_url: 'http://192.168.1.20:7860',
    auth_header_name: null,
    auth_token: 'sk-secret-value',
    request_template: { prompt: '{{prompt}}' },
    model: 'sd_xl_base',
    enabled: true,
    is_active: false,
    ...over,
  };
}

// --- Token masking -------------------------------------------------------
// The single rule this module exists for. Asserted on the VALUE, not just on
// the key's absence, so a future change that renames the column to something
// serializeProvider does not strip still fails here.

test('serializeProvider never returns the auth token', () => {
  const out = serializeProvider(row());
  assert.strictEqual(out.auth_token, undefined, 'auth_token must not survive serialization');
  assert.strictEqual(out.has_token, true, 'a stored token must be reported as present');
  // Belt and braces: the secret must not have leaked into ANY field, e.g. via
  // a spread that copied it under another name.
  assert.ok(!JSON.stringify(out).includes('sk-secret-value'),
    'the token value must not appear anywhere in the serialized row');
  // Everything else is expected to survive.
  assert.strictEqual(out.name, 'desktop');
  assert.strictEqual(out.base_url, 'http://192.168.1.20:7860');
});

test('serializeProvider reports an absent token as has_token false', () => {
  assert.strictEqual(serializeProvider(row({ auth_token: null })).has_token, false);
  assert.strictEqual(serializeProvider(row({ auth_token: '' })).has_token, false);
});

test('serializeProviders masks every row in a list', () => {
  // The list route is the easy one to forget: a single-get that masks and a
  // list that does not is a green test suite and a leaked token.
  const out = serializeProviders([row({ id: 1 }), row({ id: 2, name: 'laptop' })]);
  assert.strictEqual(out.length, 2);
  for (const p of out) {
    assert.strictEqual(p.auth_token, undefined);
    assert.strictEqual(p.has_token, true);
  }
  assert.ok(!JSON.stringify(out).includes('sk-secret-value'));
});

// --- PATCH token semantics ----------------------------------------------
// Absent / "" / value are three DIFFERENT intents. Collapsing any two of them
// is the bug that wipes a working provider's credentials on an unrelated edit.

test('a PATCH without the auth_token key does not write the column', () => {
  const { columns } = buildProviderPatch({ name: 'renamed' });
  assert.deepStrictEqual(columns, ['name']);
  assert.ok(!columns.includes('auth_token'),
    'an absent token key must leave the stored token alone');
});

test('an empty-string auth_token clears the stored token', () => {
  const { columns, values } = buildProviderPatch({ auth_token: '' });
  assert.deepStrictEqual(columns, ['auth_token']);
  assert.deepStrictEqual(values, [null], '"" is the explicit "remove the token" signal');
});

test('a non-empty auth_token is stored as given', () => {
  const { columns, values } = buildProviderPatch({ auth_token: 'sk-new' });
  assert.deepStrictEqual(columns, ['auth_token']);
  assert.deepStrictEqual(values, ['sk-new']);
});

test('the three token intents produce three different writes', () => {
  // Stated as one assertion because it is the property that matters: no two
  // of these may be equal.
  const absent = JSON.stringify(buildProviderPatch({ name: 'x' }));
  const cleared = JSON.stringify(buildProviderPatch({ name: 'x', auth_token: '' }));
  const set = JSON.stringify(buildProviderPatch({ name: 'x', auth_token: 'sk' }));
  assert.notStrictEqual(absent, cleared);
  assert.notStrictEqual(cleared, set);
  assert.notStrictEqual(absent, set);
});

test('buildProviderPatch ignores columns an admin may not set directly', () => {
  // is_active has a cross-row effect and belongs to POST /activate. A PATCH
  // that could set it would let "rename this profile" switch which service
  // draws every sprite. models_cache is discovery output, not admin input.
  const { columns } = buildProviderPatch({
    name: 'ok', is_active: true, models_cache: ['forged'], id: 99, created_at: 'x',
  });
  assert.deepStrictEqual(columns, ['name']);
});

// --- Validation ----------------------------------------------------------

test('request_template must be a JSON object', () => {
  const base = { name: 'n', base_url: 'http://h:1', request_template: {} };
  assert.strictEqual(providerFieldError(base), null);
  for (const bad of [[], 'a string', 42, null]) {
    assert.match(
      providerFieldError({ ...base, request_template: bad }) || '',
      /request_template must be a JSON object/,
      `request_template ${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test('base_url must be an absolute http(s) URL without credentials', () => {
  assert.strictEqual(baseUrlError('http://192.168.1.20:7860'), null);
  assert.strictEqual(baseUrlError('https://gpu.local/sdapi'), null);
  // Not a URL at all.
  assert.ok(baseUrlError('192.168.1.20:7860'));
  assert.ok(baseUrlError(''));
  assert.ok(baseUrlError(undefined));
  // Wrong scheme: file:// would make the backend read local files.
  assert.match(baseUrlError('file:///etc/passwd') || '', /http or https/);
  assert.match(baseUrlError('ftp://host/x') || '', /http or https/);
  // Credentials in the URL bypass the auth header fields entirely.
  assert.match(baseUrlError('http://user:pass@host/x') || '', /must not embed credentials/);
});

test('a partial update only validates the keys it carries', () => {
  // The PATCH case: omitting name must not read as "name is empty".
  assert.strictEqual(providerFieldError({ model: 'sd15' }, { partial: true }), null);
  assert.ok(providerFieldError({ model: 'sd15' }), 'a create still requires name/base_url');
  // A key that IS present is still checked.
  assert.ok(providerFieldError({ base_url: 'nonsense' }, { partial: true }));
});

// --- Single active provider ---------------------------------------------
// Enforced by a partial unique index, so this needs a real database. Guarded
// the same way the repo's other DB tests are; it does NOT run without a URL.

test('exactly one provider can be active', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const made = [];
  const restoreActive = await snapshotActive(pool);
  // ONE after-hook, deleting before ending. node:test runs t.after hooks in
  // registration order, so a separate `t.after(() => pool.end())` registered
  // first would close the pool out from under the cleanup query and the rows
  // would survive the run.
  t.after(async () => {
    try {
      if (made.length) {
        await pool.query('DELETE FROM ai_providers WHERE id = ANY($1)', [made]);
      }
      await restoreActive();
    } finally {
      await pool.end();
    }
  });

  const insert = async (name) => {
    const r = await pool.query(
      `INSERT INTO ai_providers (name, base_url, request_template)
       VALUES ($1, 'http://127.0.0.1:9/never-called', '{}'::jsonb) RETURNING id`,
      [name],
    );
    made.push(r.rows[0].id);
    return r.rows[0].id;
  };

  const a = await insert(`test-provider-a-${process.pid}`);
  const b = await insert(`test-provider-b-${process.pid}`);

  await setActiveProvider(pool, a);
  await setActiveProvider(pool, b);

  // Scoped to image: one active row PER modality, and an audio provider may
  // legitimately be active on the same database.
  const active = await pool.query("SELECT id FROM ai_providers WHERE is_active AND modality = 'image'");
  assert.strictEqual(active.rowCount, 1, 'activating b must deactivate a');
  assert.strictEqual(active.rows[0].id, b);

  // Activating an id that does not exist must not leave the world with zero
  // active providers -- the deactivation has to roll back with the failure.
  const missing = await setActiveProvider(pool, 2147483600);
  assert.strictEqual(missing, null, 'activating a missing id reports not-found');
  const stillActive = await pool.query("SELECT id FROM ai_providers WHERE is_active AND modality = 'image'");
  assert.strictEqual(stillActive.rowCount, 1, 'a failed activation must not clear the active row');
  assert.strictEqual(stillActive.rows[0].id, b);
});

// --- Modality (game audio slice 1) ---------------------------------------

test('providerFieldError: modality', () => {
  const base = { name: 'box', base_url: 'http://192.168.0.217:8001' };
  assert.strictEqual(providerFieldError({ ...base, modality: 'audio' }), null,
    'an audio provider needs no request_template');
  assert.match(providerFieldError({ ...base, modality: 'video', request_template: {} }), /modality/);
  assert.match(providerFieldError(base), /request_template/,
    'an image provider (the default) still requires a template');
});

test('activation is per modality', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const made = [];
  const restoreActive = await snapshotActive(pool);
  t.after(async () => {
    try {
      if (made.length) await pool.query('DELETE FROM ai_providers WHERE id = ANY($1)', [made]);
      await restoreActive();
    } finally { await pool.end(); }
  });
  const tag = `${process.pid}-${Date.now()}`;
  const img = await createProvider(pool, { name: `mod-img-${tag}`, base_url: 'http://127.0.0.1:9/', request_template: {} });
  made.push(img.id);
  const aud = await createProvider(pool, { name: `mod-aud-${tag}`, base_url: 'http://127.0.0.1:9/', modality: 'audio' });
  made.push(aud.id);
  assert.deepStrictEqual(aud.request_template, {}, 'audio create fills an empty template');

  await setActiveProvider(pool, img.id);
  await setActiveProvider(pool, aud.id);
  const active = await pool.query('SELECT id FROM ai_providers WHERE is_active AND id = ANY($1) ORDER BY id', [made]);
  assert.deepStrictEqual(active.rows.map((r) => r.id), [img.id, aud.id].sort((a, b) => a - b),
    'activating the audio provider must not deactivate the image one');

  const image = await loadActiveProviderWithSecret(pool);
  assert.notStrictEqual(image && image.id, aud.id, 'the default lookup never returns an audio provider');
  const audio = await loadActiveProviderWithSecret(pool, 'audio');
  assert.strictEqual(audio.id, aud.id);
});

// --- Image paths never reach an audio provider (spec §2) -----------------

test('image lookups by id never return an audio provider', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const made = [];
  t.after(async () => {
    try { if (made.length) await pool.query('DELETE FROM ai_providers WHERE id = ANY($1)', [made]); }
    finally { await pool.end(); }
  });
  const tag = `${process.pid}-${Date.now()}`;
  const img = await createProvider(pool, { name: `pin-img-${tag}`, base_url: 'http://127.0.0.1:9/', request_template: {} });
  made.push(img.id);
  const aud = await createProvider(pool, { name: `pin-aud-${tag}`, base_url: 'http://127.0.0.1:9/', modality: 'audio' });
  made.push(aud.id);

  assert.strictEqual((await loadImageProviderWithSecret(pool, img.id)).id, img.id);
  assert.strictEqual(await loadImageProviderWithSecret(pool, aud.id), null, 'an audio row is not an image provider');
  assert.strictEqual(await loadImageProviderWithSecret(pool, 2147483600), null);

  // artDispatcher: a job pinned to the audio provider degrades to the batch's
  // provider exactly like a pin whose provider was deleted.
  const { resolveJobProvider } = require('../src/services/artDispatcher');
  const batch = { id: img.id, name: 'batch' };
  const other = await resolveJobProvider(pool, aud.id, batch);
  assert.strictEqual(other, batch, 'an audio-pinned art job must not be sent to the audio provider');
});

test('PATCH cannot change a provider\'s modality', { skip: !url ? 'no database URL' : false }, async (t) => {
  require('./helpers/auth.js');
  const request = require('supertest');
  const { app, __setPool } = require('../src/index.js');
  const { signToken } = require('../src/auth/tokens.js');
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  const made = [];
  const users = [];
  t.after(async () => {
    try {
      if (made.length) await pool.query('DELETE FROM ai_providers WHERE id = ANY($1)', [made]);
      if (users.length) await pool.query('DELETE FROM users WHERE id = ANY($1)', [users]);
    } finally { await pool.end(); }
  });
  const tag = `${process.pid}-${Date.now()}`;
  const u = (await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version',
    [`prov-admin-${tag}`, 'x', 'admin'])).rows[0];
  users.push(u.id);
  const auth = `Bearer ${signToken({ userId: u.id, username: `prov-admin-${tag}`, role: 'admin', tokenVersion: u.token_version })}`;
  const img = await createProvider(pool, { name: `mod-lock-${tag}`, base_url: 'http://127.0.0.1:9/', request_template: {} });
  made.push(img.id);

  const res = await request(app).patch(`/api/ai-providers/${img.id}`).set('Authorization', auth)
    .send({ modality: 'audio' });
  assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error, /modality cannot be changed/);
  const after = await pool.query('SELECT modality FROM ai_providers WHERE id = $1', [img.id]);
  assert.strictEqual(after.rows[0].modality, 'image', 'the row is unchanged');

  // The edit form always resends the current modality; that must still save.
  const same = await request(app).patch(`/api/ai-providers/${img.id}`).set('Authorization', auth)
    .send({ modality: 'image', model: 'renamed' });
  assert.strictEqual(same.status, 200, JSON.stringify(same.body));
  assert.strictEqual(same.body.model, 'renamed');
});
