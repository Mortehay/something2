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

export const PLACEHOLDERS = ['{{prompt}}', '{{model}}', '{{seed}}', '{{width}}', '{{height}}'];

export function emptyProviderForm() {
  return {
    name: '',
    base_url: '',
    auth_header_name: '',
    auth_token: '',
    // Held as TEXT, not as an object: the admin is editing JSON by hand and
    // needs their formatting (and their syntax errors) preserved between
    // keystrokes. Parsing happens at save.
    request_template: JSON.stringify(EXAMPLE_TEMPLATE, null, 2),
    model: '',
    models_path: '/sdapi/v1/sd-models',
    models_pointer: '$[*].model_name',
    response_image_pointer: 'images[0]',
    enabled: true,
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
    ...emptyProviderForm(),
    name: row.name || '',
    base_url: row.base_url || '',
    auth_header_name: row.auth_header_name || '',
    auth_token: '',                       // always empty: the server never sends it
    request_template: JSON.stringify(row.request_template ?? {}, null, 2),
    model: row.model || '',
    models_path: row.models_path || '',
    models_pointer: row.models_pointer || '',
    response_image_pointer: row.response_image_pointer || '',
    enabled: row.enabled !== false,
    has_token: Boolean(row.has_token),
    token_touched: false,
  };
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
  const parsed = parseTemplate(form.request_template);
  if (parsed.error) return `Request template ${parsed.error}`;
  return null;
}

// Warns about a template that will produce the same picture every time, or no
// picture at all. Not an error -- a fixed prompt is legal, just almost never
// what the admin meant, and the entity's own prompt would be ignored.
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
export function providerFormToPayload(form) {
  const parsed = parseTemplate(form.request_template);
  const payload = {
    name: form.name.trim(),
    base_url: form.base_url.trim(),
    auth_header_name: form.auth_header_name.trim() || null,
    request_template: parsed.template,
    model: form.model.trim() || null,
    models_path: form.models_path.trim() || null,
    models_pointer: form.models_pointer.trim() || null,
    response_image_pointer: form.response_image_pointer.trim() || null,
    enabled: form.enabled !== false,
  };
  // The three-way token decision, and the only place it is made.
  if (form.token_touched) payload.auth_token = form.auth_token;
  return payload;
}
