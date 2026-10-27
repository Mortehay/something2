const test = require('node:test');
const assert = require('node:assert');
const {
  templateFieldError, templateFromProvider, TEMPLATE_DEFAULT_KEYS,
} = require('../src/services/aiProviderTemplates');

const ok = { name: 'T', modality: 'image', adapter: 'a1111', defaults: { base_url: 'http://h:1' } };

test('a valid template passes', () => {
  assert.equal(templateFieldError(ok), null);
});

test('auth_token at any depth is refused', () => {
  assert.equal(templateFieldError({ ...ok, defaults: { auth_token: 'x' } }), 'templates never hold a token');
  assert.equal(
    templateFieldError({ ...ok, defaults: { request_template: { headers: { auth_token: 'x' } } } }),
    'templates never hold a token');
  assert.equal(
    templateFieldError({ ...ok, defaults: { request_template: { list: [{ auth_token: 'x' }] } } }),
    'templates never hold a token');
});

test('unknown default keys are refused', () => {
  assert.match(templateFieldError({ ...ok, defaults: { enabled: true } }), /unknown default 'enabled'/);
});

test('name, modality, adapter are checked', () => {
  assert.match(templateFieldError({ ...ok, name: ' ' }), /name is required/);
  assert.match(templateFieldError({ ...ok, modality: 'x' }), /modality must be/);
  assert.match(templateFieldError({ ...ok, adapter: 'x' }), /adapter must be/);
  assert.equal(templateFieldError({ description: 'd' }, { partial: true }), null);
});

test('default values go through providerFieldError', () => {
  assert.match(templateFieldError({ ...ok, defaults: { base_url: 'ftp://h' } }), /http or https/);
});

test('templateFromProvider keeps only preset-able, non-null keys', () => {
  const t = templateFromProvider({
    name: 'p', modality: 'image', adapter: 'box', base_url: 'http://h:1', model: null,
    auth_token: 's', is_active: true, models_cache: ['a'], enabled: true,
  }, 'T');
  assert.deepEqual(t.defaults, { base_url: 'http://h:1' });
  assert.equal(t.name, 'T');
  assert.equal(t.builtin, false);
  assert.equal(t.description, '');
  for (const k of Object.keys(t.defaults)) assert.ok(TEMPLATE_DEFAULT_KEYS.includes(k));
});
