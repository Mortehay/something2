// Pure form <-> payload helpers for the AI Providers admin tab (SOMET-330).
// The component keeps the JSX; every rule lives here so it can be unit-tested.
//
// THE RULE THIS FILE EXISTS FOR: the API never sends the stored auth token
// back (it sends `has_token`), so the token input always renders EMPTY even
// when a token is stored. That makes "left the field alone" and "deliberately
// cleared the field" look identical in the DOM, and the payload builder is
// what tells them apart:
//
//   untouched  -> omit auth_token entirely   -> backend keeps the stored one
//   cleared    -> send auth_token: ""        -> backend deletes it
//   typed      -> send the value             -> backend stores it
//
// Get this wrong and renaming a provider silently destroys its credentials.

// A worked example, so the admin is not staring at an empty textarea trying to
// guess the shape. Automatic1111's txt2img body is the most likely target.
export const EXAMPLE_TEMPLATE = {
  prompt: '{{prompt}}',
  steps: 20,
  cfg_scale: 7,
  width: '{{width}}',
  height: '{{height}}',
  seed: '{{seed}}',
  override_settings: { sd_model_checkpoint: '{{model}}' },
};

// The provider kinds an admin can add. Drives the kind picker.
export const KINDS = [
  { value: 'image', label: 'Image' },
  { value: 'image_edit', label: 'Image edit' },
  { value: 'text', label: 'Text' },
  { value: 'audio', label: 'Audio' },
  { value: 'sprite', label: 'Sprite sheets' },
];

// Whether the game consumes a provider of this kind yet. image_edit can be
// configured and tested but nothing in the game calls it, so the UI says so.
export const GAME_USES = { image: true, image_edit: false, text: true, audio: true, sprite: true };

const KIND_VALUES = new Set(KINDS.map((k) => k.value));

// Kinds with hand-written backend adapters: no request template to validate
// or send. (image_edit has an OPTIONAL template, handled on its own.)
const TEMPLATELESS = new Set(['audio', 'text', 'sprite']);

export const PLACEHOLDERS = ['{{prompt}}', '{{model}}', '{{seed}}', '{{width}}', '{{height}}', '{{frames}}'];

export function emptyProviderForm(modality = 'image') {
  return {
    name: '',
    base_url: '',
    auth_header_name: '',
    auth_token: '',
    // Held as TEXT, not as an object: the admin is editing JSON by hand and
    // needs their formatting (and their syntax errors) preserved between
    // keystrokes. Parsing happens at save.
    // BLANK on purpose: a worked example is now a template the admin applies
    // (applyTemplate), not a default that leaks A1111 into every kind.
    request_template: '',
    model: '',
    models_path: '',
    models_pointer: '',
    response_image_pointer: '',
    // SOMET-346: how to cut a multi-frame sheet the remote returns whole.
    // Blank = a single static image, which is the pre-346 behaviour.
    sheet_layout: '',
    sheet_columns: '',
    sheet_rows: '',
    sheet_directions: '',
    enabled: true,
    // Game audio slice 1: 'image' (default) or 'audio'. Only meaningful at
    // create time -- see providerToForm and the SettingsAdmin form, which
    // renders this read-only once a row exists, because changing it would
    // orphan clips' provider attribution.
    modality,
    // 'box' | 'a1111' | 'openai_compatible' | 'ollama' | 'generic', or ''
    // for none. Set by the template the admin picked, sent as null when blank.
    adapter: '',
    // Audio only: per-group gateway model ({music, ambience, sfx_realistic,
    // sfx_retro}). Blank values are dropped at save.
    models_by_group: {},
    // Never populated from the server -- it cannot be. Tracks whether a token
    // exists so the UI can say so without knowing its value.
    has_token: false,
    // Set once the user edits the token field, which is what distinguishes
    // "untouched" from "cleared".
    token_touched: false,
  };
}

export function providerToForm(row) {
  if (!row) return emptyProviderForm();
  return {
    ...emptyProviderForm(row.modality || 'image'),
    name: row.name || '',
    base_url: row.base_url || '',
    auth_header_name: row.auth_header_name || '',
    auth_token: '',                       // always empty: the server never sends it
    request_template: JSON.stringify(row.request_template ?? {}, null, 2),
    model: row.model || '',
    models_path: row.models_path || '',
    models_pointer: row.models_pointer || '',
    response_image_pointer: row.response_image_pointer || '',
    sheet_layout: row.sheet_layout || '',
    sheet_columns: row.sheet_columns == null ? '' : String(row.sheet_columns),
    sheet_rows: row.sheet_rows == null ? '' : String(row.sheet_rows),
    sheet_directions: row.sheet_directions || '',
    enabled: row.enabled !== false,
    modality: row.modality || 'image',
    adapter: row.adapter || '',
    models_by_group: { ...(row.models_by_group || {}) },
    has_token: Boolean(row.has_token),
    token_touched: false,
  };
}

// Template `defaults` (or a stored row's fields) -> the form fields they set.
// Only keys PRESENT in `defaults` appear in the result, so applying a template
// that lacks a field leaves the form's current value alone. Same conversions
// as providerToForm: the request template becomes editable JSON text and the
// sheet grid numbers become strings.
function defaultsToForm(defaults) {
  const d = defaults || {};
  const out = {};
  for (const key of ['base_url', 'auth_header_name', 'model', 'models_path', 'models_pointer',
    'response_image_pointer', 'sheet_layout', 'sheet_directions']) {
    if (key in d) out[key] = d[key] == null ? '' : String(d[key]);
  }
  for (const key of ['sheet_columns', 'sheet_rows']) {
    if (key in d) out[key] = d[key] == null ? '' : String(d[key]);
  }
  if ('request_template' in d) out.request_template = JSON.stringify(d.request_template ?? {}, null, 2);
  if ('models_by_group' in d) out.models_by_group = { ...(d.models_by_group || {}) };
  return out;
}

// Pre-fills a form from a provider template. Overwrites modality and adapter
// (always from the template; adapter null -> '') plus every key in
// template.defaults. NEVER touches name, auth_token, token_touched, has_token
// or enabled: a template carries no credentials, and applying one over an
// existing row must not read as "the token was edited" (see the file header).
export function applyTemplate(form, template) {
  return {
    ...form,
    modality: template.modality,
    adapter: template.adapter || '',
    ...defaultsToForm(template.defaults),
  };
}

// Templates of one kind, built-in ones first (stable within each group).
export function templatesForKind(templates, modality) {
  const list = (templates || []).filter((t) => t.modality === modality);
  return [...list.filter((t) => t.builtin), ...list.filter((t) => !t.builtin)];
}

// Dropdown options for a model field, from a discovery_cache ({entries:[{kind,
// id,label,available,group?}]}). Entries of the form's kind only (and, for
// audio, optionally one group). A saved `current` the provider no longer lists
// stays selectable, so opening the form cannot silently change it.
export function modelOptions(discoveryCache, modality, current, group) {
  const entries = (discoveryCache?.entries || [])
    .filter((e) => e.kind === modality && (group == null || e.group === group));
  const options = entries.map((e) => ({ value: e.id, label: e.label || e.id }));
  if (current && !options.some((o) => o.value === current)) {
    options.push({ value: current, label: current });
  }
  return options;
}

// Returns { template } or { error }. Kept separate from validateProviderForm
// so the editor can show a live parse error under the textarea without
// running the rest of the validation.
export function parseTemplate(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { error: 'request template is required' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: `not valid JSON: ${err.message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'the template must be a JSON object, not an array or a bare value' };
  }
  return { template: parsed };
}

// Mirrors backend/src/services/aiProviders.js baseUrlError. Duplicated
// deliberately: the server check is the one that matters, but repeating it
// here turns a round trip into an inline message.
export function validateProviderForm(form) {
  if (!form.name || !form.name.trim()) return 'Name is required';
  if (!form.base_url || !form.base_url.trim()) return 'Base URL is required';
  let url;
  try {
    url = new URL(form.base_url);
  } catch (_) {
    return 'Base URL must be absolute, e.g. http://192.168.1.20:7860';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Base URL must use http or https';
  }
  if (url.username || url.password) {
    return 'Base URL must not embed credentials; use the auth header fields instead';
  }
  // An enabled text provider is useless without a model (the server rejects it
  // too: 'a text provider needs a model').
  if (form.modality === 'text' && form.enabled !== false && !(form.model || '').trim()) {
    return 'Pick or type a model';
  }
  // Audio, text and sprite providers have no request template -- the server
  // fills {} for one -- so the image-only field below is not part of their
  // validation.
  if (TEMPLATELESS.has(form.modality)) return null;
  // image_edit's template is optional: blank is fine, non-blank must parse.
  if (form.modality === 'image_edit' && !(form.request_template || '').trim()) return null;
  const parsed = parseTemplate(form.request_template);
  if (parsed.error) return `Request template ${parsed.error}`;
  return null;
}

// Warns about a template that will produce the same picture every time, or no
// picture at all. Not an error -- a fixed prompt is legal, just almost never
// what the admin meant, and the entity's own prompt would be ignored.
// The sprite provider's Model dropdown. Blank means "let the box pick its Qwen
// concept model" (gpuBoxSprites.resolveConceptModel) -- the box's own API
// default is SDXL, which is never used implicitly. A saved model the box no
// longer lists stays selectable, so opening the form cannot silently change it.
export function spriteModelOptions(models, current) {
  const entries = (models || []).map((id) => ({ kind: 'sprite', id }));
  return [{ value: '', label: 'Box default (Qwen)' }, ...modelOptions({ entries }, 'sprite', current)];
}

export function templateWarning(text) {
  const parsed = parseTemplate(text);
  if (parsed.error) return null;
  const json = JSON.stringify(parsed.template);
  if (!json.includes('{{prompt}}')) {
    return 'This template has no {{prompt}} placeholder, so the entity or tile prompt will be ignored.';
  }
  return null;
}

// The PATCH/POST body. See the token rules at the top of this file.
//
// An audio, text or sprite provider omits every image-only field rather than sending
// empty/default values for them: the backend has no use for a request
// template, model discovery path, response pointer or sprite-sheet grid on
// an audio or text row, and sending them would just be dead columns to
// ignore. The server fills a default request_template ({}) itself when it is
// absent and modality is 'audio', 'text' or 'sprite'.
export function providerFormToPayload(form) {
  const modality = KIND_VALUES.has(form.modality) ? form.modality : 'image';
  const payload = {
    name: form.name.trim(),
    base_url: form.base_url.trim(),
    auth_header_name: form.auth_header_name.trim() || null,
    model: form.model.trim() || null,
    enabled: form.enabled !== false,
    modality,
    adapter: form.adapter || null,
  };
  if (modality === 'audio') {
    // Blank groups are dropped, not sent as "": a missing key means "use the
    // provider's default model for that group".
    const byGroup = {};
    for (const [group, value] of Object.entries(form.models_by_group || {})) {
      if (typeof value === 'string' && value.trim()) byGroup[group] = value.trim();
    }
    payload.models_by_group = byGroup;
  }
  if (modality === 'image_edit') {
    const text = form.request_template || '';
    payload.request_template = text.trim() ? (parseTemplate(text).template ?? {}) : {};
  }
  if (modality === 'image') {
    const parsed = parseTemplate(form.request_template);
    payload.request_template = parsed.template;
    payload.models_path = form.models_path.trim() || null;
    payload.models_pointer = form.models_pointer.trim() || null;
    payload.response_image_pointer = form.response_image_pointer.trim() || null;
    payload.sheet_layout = form.sheet_layout || null;
    // Sent as numbers or null, never as "" -- the column is integer, and an
    // empty string would be a cast error rather than "not configured".
    payload.sheet_columns = form.sheet_columns === '' ? null : Number(form.sheet_columns);
    payload.sheet_rows = form.sheet_rows === '' ? null : Number(form.sheet_rows);
    payload.sheet_directions = form.sheet_directions.trim() || null;
  }
  // The three-way token decision, and the only place it is made.
  if (form.token_touched) payload.auth_token = form.auth_token;
  return payload;
}

// --- Provider templates (admin-managed presets) ---------------------------
// A template is a provider form minus identity and credentials: `defaults`
// never holds name, enabled or any token. Blank fields are omitted so applying
// the template leaves the target form's value alone instead of blanking it.

// Form -> POST/PATCH /api/ai-provider-templates body.
export function templateToPayload(form) {
  const defaults = {};
  const put = (key, value) => { if (value !== '' && value != null) defaults[key] = value; };
  put('base_url', (form.base_url || '').trim());
  put('auth_header_name', (form.auth_header_name || '').trim());
  put('model', (form.model || '').trim());
  if (form.modality === 'image' || form.modality === 'image_edit') {
    const text = form.request_template || '';
    if (text.trim()) {
      const parsed = parseTemplate(text);
      if (parsed.template) defaults.request_template = parsed.template;
    }
  }
  if (form.modality === 'image') {
    put('models_path', (form.models_path || '').trim());
    put('models_pointer', (form.models_pointer || '').trim());
    put('response_image_pointer', (form.response_image_pointer || '').trim());
    put('sheet_layout', form.sheet_layout || '');
    put('sheet_columns', form.sheet_columns === '' ? '' : Number(form.sheet_columns));
    put('sheet_rows', form.sheet_rows === '' ? '' : Number(form.sheet_rows));
    put('sheet_directions', (form.sheet_directions || '').trim());
  }
  if (form.modality === 'audio') {
    const byGroup = {};
    for (const [group, value] of Object.entries(form.models_by_group || {})) {
      if (typeof value === 'string' && value.trim()) byGroup[group] = value.trim();
    }
    if (Object.keys(byGroup).length) defaults.models_by_group = byGroup;
  }
  return {
    name: (form.name || '').trim(),
    modality: KIND_VALUES.has(form.modality) ? form.modality : 'image',
    adapter: form.adapter || null,
    description: form.description || '',
    defaults,
  };
}

// Template row -> editable form (the inverse of templateToPayload). Blank
// token and has_token=false: a template never carries credentials.
export function templateToForm(row) {
  if (!row) return { ...emptyProviderForm(), description: '' };
  return {
    ...emptyProviderForm(row.modality || 'image'),
    name: row.name || '',
    description: row.description || '',
    adapter: row.adapter || '',
    ...defaultsToForm(row.defaults),
  };
}
