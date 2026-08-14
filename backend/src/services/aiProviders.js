// SOMET-324: the ai_providers catalog -- registered remote AI image services.
//
// Two kinds of function live here, and the split matters:
//
//   * PURE helpers (serializeProvider, providerFieldError, buildProviderPatch)
//     take plain objects and return plain objects. They carry the rules that
//     are easy to get wrong -- what leaves the server, what a PATCH means --
//     and they are unit-testable without a database.
//   * DB functions take a `db` (pool or client) as their first argument, so a
//     caller inside an open transaction can pass its client.
//
// THE ONE RULE THIS MODULE EXISTS TO ENFORCE: auth_token never leaves the
// process. Every read path goes through serializeProvider. The single
// exception is loadActiveProviderWithSecret / loadProviderWithSecret, whose
// names say what they hand back and whose callers are server-side only.

// Columns an admin may write through create/PATCH. is_active is deliberately
// absent -- activation is POST /activate, because it has a cross-row effect
// (deactivating the previous holder) that a field assignment does not express.
// models_cache/models_fetched_at are absent too: they are discovery output,
// not admin input.
const WRITABLE = [
  'name',
  'base_url',
  'auth_header_name',
  'auth_token',
  'request_template',
  'model',
  'models_path',
  'models_pointer',
  'response_image_pointer',
  'enabled',
];

// The row as the browser is allowed to see it: auth_token replaced by a
// boolean. Returning the token and trusting the UI not to display it would
// still put it in devtools' network tab and in any log that captures a
// response body.
//
// has_token is what lets the Settings form render "a token is stored" without
// knowing the value, which in turn is what makes the empty-field-means-
// unchanged PATCH convention below comprehensible to the person using it.
function serializeProvider(row) {
  if (!row) return row;
  const { auth_token: token, ...rest } = row;
  return { ...rest, has_token: Boolean(token) };
}

function serializeProviders(rows) {
  return rows.map(serializeProvider);
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// base_url must be a parseable absolute http(s) URL. This is the save-time
// half of the SSRF guard; SOMET-333 adds the call-time half plus redirect and
// size limits. Checking here as well as there is deliberate -- a row can be
// edited straight in psql, so the call site cannot trust the column.
function baseUrlError(value) {
  if (typeof value !== 'string' || !value.trim()) return 'base_url is required';
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    return 'base_url must be an absolute URL, e.g. http://192.168.1.20:7860';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'base_url must use http or https';
  }
  // A username/password in the URL would be silently forwarded by fetch and
  // would not appear in the auth_header_name/auth_token fields the admin
  // thinks are the only credentials in play.
  if (url.username || url.password) {
    return 'base_url must not embed credentials; use the auth header fields';
  }
  return null;
}

// `partial` is the PATCH case: absent keys are "leave alone" rather than
// "clear", so only the keys actually present get validated.
function providerFieldError(body, { partial = false } = {}) {
  if (!isPlainObject(body)) return 'body must be an object';

  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('name')) {
    if (typeof body.name !== 'string' || !body.name.trim()) return 'name is required';
  }
  if (!partial || has('base_url')) {
    const bad = baseUrlError(body.base_url);
    if (bad) return bad;
  }
  if (!partial || has('request_template')) {
    // The template becomes a POST body. An array or a bare string would be
    // accepted by jsonb and then fail at generate time against the remote
    // service, which is far away from the person who typed it.
    if (!isPlainObject(body.request_template)) {
      return 'request_template must be a JSON object';
    }
  }
  for (const k of ['auth_header_name', 'model', 'models_path', 'models_pointer',
    'response_image_pointer']) {
    if (has(k) && body[k] !== null && typeof body[k] !== 'string') {
      return `${k} must be a string or null`;
    }
  }
  if (has('auth_token') && body.auth_token !== null && typeof body.auth_token !== 'string') {
    return 'auth_token must be a string or null';
  }
  if (has('enabled') && typeof body.enabled !== 'boolean') {
    return 'enabled must be a boolean';
  }
  return null;
}

// Turns a PATCH body into the columns/values to write.
//
// THE TOKEN CONVENTION, which is the whole reason this is a named function
// with its own tests: the UI cannot render the stored token (serializeProvider
// removed it), so an untouched token field submits as *absent*, not as the old
// value. Absent must therefore mean "keep what is stored". That leaves no way
// to express "remove the token" -- so empty string is that, explicitly.
//
//   auth_token key absent    -> column not written at all
//   auth_token: ""           -> column set to NULL (token removed)
//   auth_token: "sk-..."     -> column set to that value
//
// Getting this backwards silently wipes a working provider's credentials the
// first time an admin edits its name.
function buildProviderPatch(body) {
  const columns = [];
  const values = [];
  for (const key of WRITABLE) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    let value = body[key];
    if (key === 'auth_token') {
      // '' is the explicit clear; anything else stores as given.
      value = value === '' ? null : value;
    }
    columns.push(key);
    values.push(value);
  }
  return { columns, values };
}

async function listProviders(db) {
  const r = await db.query('SELECT * FROM ai_providers ORDER BY id ASC');
  return serializeProviders(r.rows);
}

async function getProvider(db, id) {
  const r = await db.query('SELECT * FROM ai_providers WHERE id = $1', [id]);
  return serializeProvider(r.rows[0]);
}

// Server-side only: the row WITH its auth_token, for actually calling the
// service. Named so that a reviewer seeing this at a route boundary knows
// something is wrong.
async function loadProviderWithSecret(db, id) {
  const r = await db.query('SELECT * FROM ai_providers WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// The provider generation falls back to when nothing more specific is chosen.
// Disabled profiles are excluded: `enabled` is the admin's "this box is off
// right now" switch, and an active-but-disabled profile must not silently
// swallow every generation request.
async function loadActiveProviderWithSecret(db) {
  const r = await db.query('SELECT * FROM ai_providers WHERE is_active AND enabled');
  return r.rows[0] || null;
}

async function createProvider(db, body) {
  const { columns, values } = buildProviderPatch(body);
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  const r = await db.query(
    `INSERT INTO ai_providers (${columns.join(', ')})
     VALUES (${placeholders.join(', ')}) RETURNING *`,
    values,
  );
  return serializeProvider(r.rows[0]);
}

// Returns undefined when no row matched, so the route can 404 rather than
// reporting a successful update of nothing.
async function updateProvider(db, id, body) {
  const { columns, values } = buildProviderPatch(body);
  if (columns.length === 0) return getProvider(db, id);
  const assignments = columns.map((c, i) => `${c} = $${i + 1}`);
  const r = await db.query(
    `UPDATE ai_providers SET ${assignments.join(', ')}, updated_at = now()
     WHERE id = $${columns.length + 1} RETURNING *`,
    [...values, id],
  );
  return serializeProvider(r.rows[0]);
}

async function deleteProvider(db, id) {
  const r = await db.query('DELETE FROM ai_providers WHERE id = $1 RETURNING id', [id]);
  return r.rowCount > 0;
}

// Clearing before setting is REQUIRED, not stylistic: ai_providers_single_
// active_index is a non-deferrable unique index, so setting a second row
// active before clearing the first raises a duplicate key error mid-statement.
// The transaction is what makes the pair atomic -- a crash between them must
// not leave zero active providers when there was one before.
async function setActiveProvider(pool, id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE ai_providers SET is_active = false WHERE is_active');
    const r = await client.query(
      'UPDATE ai_providers SET is_active = true, updated_at = now() WHERE id = $1 RETURNING *',
      [id],
    );
    if (r.rowCount === 0) {
      // No such provider: roll back rather than commit the deactivation we
      // just did. Activating a missing id must not turn off the working one.
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('COMMIT');
    return serializeProvider(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Stores the result of a discovery run (SOMET-325).
async function saveModelsCache(db, id, models) {
  const r = await db.query(
    `UPDATE ai_providers SET models_cache = $1, models_fetched_at = now(), updated_at = now()
     WHERE id = $2 RETURNING *`,
    [JSON.stringify(models), id],
  );
  return serializeProvider(r.rows[0]);
}

module.exports = {
  serializeProvider,
  serializeProviders,
  providerFieldError,
  baseUrlError,
  buildProviderPatch,
  listProviders,
  getProvider,
  loadProviderWithSecret,
  loadActiveProviderWithSecret,
  createProvider,
  updateProvider,
  deleteProvider,
  setActiveProvider,
  saveModelsCache,
  WRITABLE,
};
