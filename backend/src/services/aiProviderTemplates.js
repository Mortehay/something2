// Editable AI provider templates: named presets that pre-fill the admin "Add
// provider" form. Same split as aiProviders.js: pure helpers first, then DB
// functions that take `db` as their first argument.
//
// A template NEVER holds a credential. templateFieldError rejects an
// `auth_token` key at any depth of `defaults`, and templateFromProvider only
// copies TEMPLATE_DEFAULT_KEYS, so a token cannot arrive by either door.

const { MODALITIES, ADAPTERS, providerFieldError } = require('./aiProviders');

const TEMPLATE_DEFAULT_KEYS = Object.freeze([
  'base_url',
  'auth_header_name',
  'request_template',
  'model',
  'models_path',
  'models_pointer',
  'response_image_pointer',
  'sheet_layout',
  'sheet_columns',
  'sheet_rows',
  'sheet_directions',
  'models_by_group',
]);

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Recursive walk over objects and arrays: any key named exactly auth_token.
function hasTokenKey(v) {
  if (Array.isArray(v)) return v.some(hasTokenKey);
  if (!isPlainObject(v)) return false;
  return Object.keys(v).some((k) => k === 'auth_token' || hasTokenKey(v[k]));
}

// `partial` is the PATCH case: only keys present are validated.
function templateFieldError(body, { partial = false } = {}) {
  if (!isPlainObject(body)) return 'body must be an object';
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('name')) {
    if (typeof body.name !== 'string' || !body.name.trim()) return 'name is required';
  }
  if (!partial || has('modality')) {
    if (!MODALITIES.includes(body.modality)) {
      return `modality must be one of ${MODALITIES.join(', ')}`;
    }
  }
  if (has('adapter') && body.adapter !== null && !ADAPTERS.includes(body.adapter)) {
    return `adapter must be one of ${ADAPTERS.join(', ')}`;
  }
  if (has('description') && typeof body.description !== 'string') {
    return 'description must be a string';
  }
  if (has('defaults')) {
    const d = body.defaults;
    if (!isPlainObject(d)) return 'defaults must be an object';
    if (hasTokenKey(d)) return 'templates never hold a token';
    for (const k of Object.keys(d)) {
      if (!TEMPLATE_DEFAULT_KEYS.includes(k)) return `unknown default '${k}'`;
    }
    const bad = providerFieldError({
      ...d,
      name: 'x',
      base_url: d.base_url ?? 'http://placeholder',
      modality: body.modality,
    }, { partial: true });
    if (bad) return bad;
  }
  return null;
}

// The template a provider row would make: only the preset-able columns, nulls
// dropped. Works on a serialized row too (it has no auth_token to begin with).
function templateFromProvider(row, name) {
  const defaults = {};
  for (const k of TEMPLATE_DEFAULT_KEYS) {
    if (row[k] !== null && row[k] !== undefined) defaults[k] = row[k];
  }
  return {
    name,
    modality: row.modality,
    adapter: row.adapter ?? null,
    description: '',
    defaults,
    builtin: false,
  };
}

async function listTemplates(db) {
  const r = await db.query('SELECT * FROM ai_provider_templates ORDER BY modality, name');
  return r.rows;
}

async function getTemplate(db, id) {
  const r = await db.query('SELECT * FROM ai_provider_templates WHERE id = $1', [id]);
  return r.rows[0];
}

async function createTemplate(db, body) {
  const r = await db.query(
    `INSERT INTO ai_provider_templates (name, modality, adapter, description, defaults, builtin)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [body.name, body.modality, body.adapter ?? null, body.description ?? '',
      JSON.stringify(body.defaults ?? {}), body.builtin === true],
  );
  return r.rows[0];
}

const PATCHABLE = ['name', 'modality', 'adapter', 'description', 'defaults'];

// Returns undefined when no row matched, so the route can 404.
async function updateTemplate(db, id, patch) {
  const columns = [];
  const values = [];
  for (const key of PATCHABLE) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    columns.push(key);
    values.push(key === 'defaults' ? JSON.stringify(patch[key]) : patch[key]);
  }
  if (columns.length === 0) return getTemplate(db, id);
  const assignments = columns.map((c, i) => `${c} = $${i + 1}`);
  const r = await db.query(
    `UPDATE ai_provider_templates SET ${assignments.join(', ')}, updated_at = now()
     WHERE id = $${columns.length + 1} RETURNING *`,
    [...values, id],
  );
  return r.rows[0];
}

async function deleteTemplate(db, id) {
  const r = await db.query('DELETE FROM ai_provider_templates WHERE id = $1 RETURNING id', [id]);
  return r.rowCount > 0;
}

module.exports = {
  TEMPLATE_DEFAULT_KEYS,
  templateFieldError,
  templateFromProvider,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
};
