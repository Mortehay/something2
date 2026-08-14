import { describe, it, expect } from 'vitest';
import {
  emptyProviderForm, providerToForm, providerFormToPayload, validateProviderForm,
  parseTemplate, templateWarning, EXAMPLE_TEMPLATE,
} from '../providerForm.js';

// A row as GET /api/ai-providers returns it: has_token, never auth_token.
const row = (over = {}) => ({
  id: 1,
  name: 'desktop',
  base_url: 'http://192.168.1.20:7860/sdapi/v1/txt2img',
  auth_header_name: 'Authorization',
  request_template: { prompt: '{{prompt}}' },
  model: 'sd15',
  models_path: '/sdapi/v1/sd-models',
  models_pointer: '$[*].model_name',
  response_image_pointer: 'images[0]',
  enabled: true,
  is_active: false,
  has_token: true,
  ...over,
});

describe('the token field, which is the bug this module exists to prevent', () => {
  it('never prefills the token, because the server never sends it', () => {
    const form = providerToForm(row());
    expect(form.auth_token).toBe('');
    expect(form.has_token).toBe(true);
    expect(form.token_touched).toBe(false);
  });

  it('omits auth_token entirely when the field was not touched', () => {
    // The whole point: editing the NAME of a provider must not wipe its
    // credentials just because the token input rendered empty.
    const form = { ...providerToForm(row()), name: 'renamed' };
    const payload = providerFormToPayload(form);
    expect('auth_token' in payload).toBe(false);
    expect(payload.name).toBe('renamed');
  });

  it('sends an empty string when the admin deliberately clears it', () => {
    const form = { ...providerToForm(row()), auth_token: '', token_touched: true };
    expect(providerFormToPayload(form).auth_token).toBe('');
  });

  it('sends the value when the admin types a new one', () => {
    const form = { ...providerToForm(row()), auth_token: 'sk-new', token_touched: true };
    expect(providerFormToPayload(form).auth_token).toBe('sk-new');
  });

  it('produces three distinguishable payloads for the three intents', () => {
    const base = providerToForm(row());
    const untouched = providerFormToPayload(base);
    const cleared = providerFormToPayload({ ...base, auth_token: '', token_touched: true });
    const typed = providerFormToPayload({ ...base, auth_token: 'sk', token_touched: true });
    expect(untouched).not.toEqual(cleared);
    expect(cleared).not.toEqual(typed);
    expect(untouched).not.toEqual(typed);
  });
});

describe('template parsing', () => {
  it('accepts a JSON object', () => {
    expect(parseTemplate('{"a":1}')).toEqual({ template: { a: 1 } });
    expect(parseTemplate(JSON.stringify(EXAMPLE_TEMPLATE)).template).toEqual(EXAMPLE_TEMPLATE);
  });

  it('rejects invalid JSON with the parser message, not a generic one', () => {
    const out = parseTemplate('{not json}');
    expect(out.error).toMatch(/not valid JSON/);
    expect(out.template).toBeUndefined();
  });

  it('rejects an array or a bare value', () => {
    expect(parseTemplate('[1,2]').error).toMatch(/must be a JSON object/);
    expect(parseTemplate('"a string"').error).toMatch(/must be a JSON object/);
    expect(parseTemplate('42').error).toMatch(/must be a JSON object/);
  });

  it('rejects an empty template', () => {
    expect(parseTemplate('').error).toBeTruthy();
    expect(parseTemplate('   ').error).toBeTruthy();
  });

  it('warns when the template ignores the prompt', () => {
    // Legal, but almost certainly a mistake: every generated image would be
    // identical and the entity's own prompt would go unused.
    expect(templateWarning('{"steps":20}')).toMatch(/no \{\{prompt\}\}/);
    expect(templateWarning('{"prompt":"{{prompt}}"}')).toBeNull();
    // A template that will not parse produces a parse error, not a warning.
    expect(templateWarning('{bad')).toBeNull();
  });
});

describe('validation mirrors the server rules', () => {
  const valid = () => ({ ...emptyProviderForm(), name: 'x', base_url: 'http://h:7860' });

  it('accepts a well-formed form', () => {
    expect(validateProviderForm(valid())).toBeNull();
  });

  it('requires a name and a base URL', () => {
    expect(validateProviderForm({ ...valid(), name: '  ' })).toMatch(/Name is required/);
    expect(validateProviderForm({ ...valid(), base_url: '' })).toMatch(/Base URL is required/);
  });

  it('rejects a relative URL, a wrong scheme, and embedded credentials', () => {
    expect(validateProviderForm({ ...valid(), base_url: '192.168.1.20:7860' })).toMatch(/absolute/);
    expect(validateProviderForm({ ...valid(), base_url: 'file:///etc/passwd' })).toMatch(/http or https/);
    expect(validateProviderForm({ ...valid(), base_url: 'http://u:p@h/x' })).toMatch(/credentials/);
  });

  it('blocks save on an unparseable template rather than posting a string', () => {
    expect(validateProviderForm({ ...valid(), request_template: '{oops' })).toMatch(/not valid JSON/);
  });
});

describe('round trip', () => {
  it('preserves every field through form and back to payload', () => {
    const payload = providerFormToPayload(providerToForm(row()));
    expect(payload).toMatchObject({
      name: 'desktop',
      base_url: 'http://192.168.1.20:7860/sdapi/v1/txt2img',
      auth_header_name: 'Authorization',
      request_template: { prompt: '{{prompt}}' },
      model: 'sd15',
      models_path: '/sdapi/v1/sd-models',
      models_pointer: '$[*].model_name',
      response_image_pointer: 'images[0]',
      enabled: true,
    });
  });

  it('sends null rather than "" for the optional text fields', () => {
    // "" and NULL are different in the column, and the discovery code treats
    // an empty models_path as "no path" via a falsy check either way -- but a
    // stored "" makes the row read as configured when it is not.
    const payload = providerFormToPayload({
      ...emptyProviderForm(), name: 'x', base_url: 'http://h:1',
      auth_header_name: '', model: '', models_path: '', models_pointer: '',
      response_image_pointer: '',
    });
    expect(payload.auth_header_name).toBeNull();
    expect(payload.model).toBeNull();
    expect(payload.models_path).toBeNull();
    expect(payload.response_image_pointer).toBeNull();
  });

  it('an empty row yields a usable starting form with a worked example', () => {
    const form = providerToForm(null);
    expect(parseTemplate(form.request_template).template).toEqual(EXAMPLE_TEMPLATE);
    expect(templateWarning(form.request_template)).toBeNull();
  });
});
