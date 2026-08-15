const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const {
  resolveGenerationTarget, typeTableForKind, loadTypeOverride,
} = require('../src/services/generationTarget');
const { isRemoteJobId } = require('../src/services/remoteImageProvider');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// --- The invariant that makes this epic a no-op until it is configured ---

test('with nothing configured, generation stays on local sprite-gen', () => {
  // If this ever returns remote, every existing installation's generation
  // silently changes engine on upgrade.
  assert.deepStrictEqual(resolveGenerationTarget(), { source: 'local' });
  assert.deepStrictEqual(resolveGenerationTarget({ request: {}, type: null, active: null }),
    { source: 'local' });
  assert.deepStrictEqual(
    resolveGenerationTarget({ request: {}, type: { ai_provider_mode: 'default' }, active: null }),
    { source: 'local' },
  );
});

// --- The four levels, each on its own ------------------------------------

test('level 4: the active provider is the default when nothing overrides it', () => {
  assert.deepStrictEqual(
    resolveGenerationTarget({ type: { ai_provider_mode: 'default' }, active: { id: 7 } }),
    { source: 'remote', providerId: 7 },
  );
});

test('level 3: a type pinned to local stays local while a provider is active', () => {
  // The whole point of the 'local' mode: activating a remote provider must not
  // silently take over a type the admin deliberately pinned.
  assert.deepStrictEqual(
    resolveGenerationTarget({ type: { ai_provider_mode: 'local' }, active: { id: 7 } }),
    { source: 'local' },
  );
});

test('level 3: a type pinned to a specific provider beats the active one', () => {
  assert.deepStrictEqual(
    resolveGenerationTarget({
      type: { ai_provider_mode: 'provider', ai_provider_id: 2 }, active: { id: 7 },
    }),
    { source: 'remote', providerId: 2 },
  );
});

test('level 1: the request body beats the type, which beats the active provider', () => {
  const type = { ai_provider_mode: 'provider', ai_provider_id: 2 };
  const active = { id: 7 };
  // Request wins.
  assert.deepStrictEqual(
    resolveGenerationTarget({ request: { ai_provider_id: 9 }, type, active }),
    { source: 'remote', providerId: 9 },
  );
  // Request can also force local past both.
  assert.deepStrictEqual(
    resolveGenerationTarget({ request: { ai_provider_local: true }, type, active }),
    { source: 'local' },
  );
});

test('all four levels in one ordering assertion', () => {
  const type = { ai_provider_mode: 'provider', ai_provider_id: 2 };
  const active = { id: 7 };
  assert.strictEqual(resolveGenerationTarget({ request: { ai_provider_id: 9 }, type, active }).providerId, 9);
  assert.strictEqual(resolveGenerationTarget({ request: {}, type, active }).providerId, 2);
  assert.strictEqual(resolveGenerationTarget({ request: {}, type: null, active }).providerId, 7);
  assert.strictEqual(resolveGenerationTarget({ request: {}, type: null, active: null }).source, 'local');
});

// --- Degradation ---------------------------------------------------------

test('a pin whose provider was deleted degrades to the default, not an error', () => {
  // ON DELETE SET NULL leaves mode='provider' with a NULL id. That must keep
  // generating (via the active provider, or local) rather than breaking the
  // type until somebody notices.
  const dangling = { ai_provider_mode: 'provider', ai_provider_id: null };
  assert.deepStrictEqual(resolveGenerationTarget({ type: dangling, active: { id: 7 } }),
    { source: 'remote', providerId: 7 });
  assert.deepStrictEqual(resolveGenerationTarget({ type: dangling, active: null }),
    { source: 'local' });
});

test('a non-integer provider id is ignored rather than trusted', () => {
  // These arrive from a JSON request body, so they are whatever the client
  // sent. A string id would reach Postgres as a raw cast error.
  for (const bad of ['9', 9.5, null, true, {}, []]) {
    assert.deepStrictEqual(
      resolveGenerationTarget({ request: { ai_provider_id: bad }, active: null }),
      { source: 'local' },
      `ai_provider_id ${JSON.stringify(bad)} must not be honoured`,
    );
  }
});

test('ai_provider_local only forces local when it is exactly true', () => {
  assert.strictEqual(
    resolveGenerationTarget({ request: { ai_provider_local: 'yes' }, active: { id: 7 } }).source,
    'remote',
    'a truthy-but-not-true value must not silently disable the active provider',
  );
});

// --- Table routing -------------------------------------------------------

test('the override is read from the catalog that owns the kind', () => {
  assert.strictEqual(typeTableForKind('tile'), 'tile_types');
  assert.strictEqual(typeTableForKind('object'), 'entity_types');
  assert.strictEqual(typeTableForKind(undefined), 'entity_types');
});

// --- Job id dispatch -----------------------------------------------------

test('remote job ids are distinguishable and still traversal-safe', () => {
  const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  assert.ok(isRemoteJobId('rmt_deadbeef'));
  assert.ok(!isRemoteJobId('deadbeef'), 'a sprite-gen id must not be treated as remote');

  // The existing guard was NOT relaxed to accommodate the prefix -- it already
  // allowed underscores. These must still be rejected.
  assert.ok(JOB_ID_RE.test('rmt_0123456789abcdef'), 'a real remote id must pass the guard');
  for (const attack of ['../secret', 'rmt_../secret', 'rmt_%2e%2e%2fsecret', 'a/b', 'rmt_a/b']) {
    assert.ok(!JOB_ID_RE.test(attack), `${attack} must still be rejected`);
  }
});

// --- Source guard: the live path must actually branch ---------------------

test('startGenerationJob resolves a target before calling sprite-gen', () => {
  // A resolver that nothing calls is the exact shape of the inert-loader bug
  // this repo has shipped before: every unit test green, feature dead.
  const src = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  const start = src.indexOf('async function startGenerationJob(');
  assert.ok(start !== -1, 'could not locate startGenerationJob');
  const body = src.slice(start, src.indexOf('\napp.post(', start));

  assert.match(body, /resolveGenerationTarget\(/, 'the live path must resolve a target');
  assert.match(body, /remoteImageProvider\.startGeneration\(/,
    'the live path must be able to dispatch to a remote provider');
  // And the remote branch must come BEFORE the sprite-gen call it replaces.
  assert.ok(body.indexOf('remoteImageProvider.startGeneration(') < body.indexOf('spriteGen.postGenerate('),
    'the remote branch must short-circuit before the local sprite-gen call');
});

// --- Schema-level degradation -------------------------------------------
// The pure test above asserts a dangling pin RESOLVES to the fallback. This
// asserts the database is what makes the pin dangle -- i.e. that deleting a
// provider does not take the referencing types down with it.
//
// Everything happens inside a transaction that is rolled back, so this is
// safe to point at any database, including a shared dev one.

test('deleting a provider blanks the pin instead of failing or cascading',
  { skip: !url ? 'no database URL' : false }, async (t) => {
    const pool = new Pool({ connectionString: url });
    t.after(() => pool.end());
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const p = await client.query(
        `INSERT INTO ai_providers (name, base_url, request_template)
         VALUES ('zz-target-test', 'http://127.0.0.1:9/never', '{}'::jsonb) RETURNING id`,
      );
      const providerId = p.rows[0].id;

      await client.query(
        `INSERT INTO entity_types (name, color, prompt, ai_provider_mode, ai_provider_id)
         VALUES ('zzTargetTestType', '#000', '', 'provider', $1)`,
        [providerId],
      );

      const pinned = await loadTypeOverride(client, 'object', 'zzTargetTestType');
      assert.deepStrictEqual(pinned, { ai_provider_mode: 'provider', ai_provider_id: providerId });
      assert.deepStrictEqual(resolveGenerationTarget({ type: pinned, active: null }),
        { source: 'remote', providerId });

      // The provider goes away. This must not error, and must not delete the
      // entity type along with it.
      await client.query('DELETE FROM ai_providers WHERE id = $1', [providerId]);

      const survivors = await client.query(
        "SELECT count(*)::int AS n FROM entity_types WHERE name = 'zzTargetTestType'",
      );
      assert.strictEqual(survivors.rows[0].n, 1, 'the entity type must survive its provider');

      const dangling = await loadTypeOverride(client, 'object', 'zzTargetTestType');
      assert.strictEqual(dangling.ai_provider_id, null, 'the pin must be blanked, not left dangling');
      // And the type keeps generating, via the fallback.
      assert.deepStrictEqual(resolveGenerationTarget({ type: dangling, active: null }),
        { source: 'local' });
      assert.deepStrictEqual(resolveGenerationTarget({ type: dangling, active: { id: 42 } }),
        { source: 'remote', providerId: 42 });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

test('the mode column rejects a value the resolver does not understand',
  { skip: !url ? 'no database URL' : false }, async (t) => {
    const pool = new Pool({ connectionString: url });
    t.after(() => pool.end());
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(
        client.query(
          `INSERT INTO entity_types (name, color, prompt, ai_provider_mode)
           VALUES ('zzBadMode', '#000', '', 'whatever')`,
        ),
        /check constraint/i,
        'an unknown mode must be rejected by the database, not silently stored',
      );
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

test('all three job-status routes dispatch on the id prefix', () => {
  // Wiring two of three is how a feature ships half-working and green.
  const src = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  const dispatched = (src.match(/fetchJobDocument\(req\.params\.jobId\)/g) || []).length;
  assert.strictEqual(dispatched, 3,
    `all three /api/*-jobs/:jobId routes must dispatch, found ${dispatched}`);
  assert.ok(!/await spriteGen\.getJob\(req\.params\.jobId\)/.test(src),
    'no job-status route may still call sprite-gen directly');
});
