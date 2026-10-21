import { describe, it, expect } from 'vitest';
import {
  KINDS, GAME_USES, emptyProviderForm, providerToForm, providerFormToPayload, validateProviderForm,
  applyTemplate, templatesForKind, modelOptions, templateToPayload, templateToForm,
} from '../providerForm.js';

const A1111 = {
  modality: 'image', adapter: 'a1111',
  defaults: {
    base_url: 'http://h:7860',
    request_template: { prompt: '{{prompt}}', override_settings: { sd_model_checkpoint: '{{model}}' } },
    sheet_columns: 4,
  },
};

describe('kinds', () => {
  it('lists the five kinds; only image_edit is unused by the game', () => {
    expect(KINDS.map((k) => k.value)).toEqual(['image', 'image_edit', 'text', 'audio', 'sprite']);
    expect(GAME_USES).toEqual({ image: true, image_edit: false, text: true, audio: true, sprite: true });
  });
  it('emptyProviderForm is blank for the kind', () => {
    const f = emptyProviderForm('text');
    expect(f.modality).toBe('text');
    expect(f.adapter).toBe('');
    expect(f.models_by_group).toEqual({});
    expect(f.request_template).not.toContain('sd_model_checkpoint');
    expect(emptyProviderForm().modality).toBe('image');
  });
});

describe('applyTemplate', () => {
  it('keeps a typed token and its touched flag', () => {
    const f = applyTemplate({ ...emptyProviderForm(), name: 'mine', enabled: false, token_touched: true, auth_token: 'typed' }, A1111);
    expect(f.token_touched).toBe(true);
    expect(f.auth_token).toBe('typed');
    expect(f.name).toBe('mine');
    expect(f.enabled).toBe(false);
  });
  it('does not make a saved row look token-edited (no auth_token in payload)', () => {
    const f = applyTemplate(providerToForm({ name: 'p', base_url: 'http://h:1', has_token: true, request_template: {} }), A1111);
    expect(f.has_token).toBe(true);
    expect(providerFormToPayload(f)).not.toHaveProperty('auth_token');
  });
  it('converts defaults like providerToForm and sets modality/adapter', () => {
    const f = applyTemplate(emptyProviderForm('text'), A1111);
    expect(f.modality).toBe('image');
    expect(f.adapter).toBe('a1111');
    expect(f.sheet_columns).toBe('4');
    expect(JSON.parse(f.request_template).prompt).toBe('{{prompt}}');
  });
  it('leaves fields the template lacks, and maps adapter null to ""', () => {
    const f = applyTemplate({ ...emptyProviderForm(), model: 'keep', base_url: 'http://keep:1', adapter: 'box' },
      { modality: 'text', adapter: null, defaults: { models_path: '/v1/models' } });
    expect(f.model).toBe('keep');
    expect(f.base_url).toBe('http://keep:1');
    expect(f.models_path).toBe('/v1/models');
    expect(f.adapter).toBe('');
    expect(f.modality).toBe('text');
  });
});

describe('templatesForKind', () => {
  it('filters by kind with built-ins first', () => {
    const list = [
      { id: 1, modality: 'image', builtin: false }, { id: 2, modality: 'text', builtin: true },
      { id: 3, modality: 'image', builtin: true },
    ];
    expect(templatesForKind(list, 'image').map((t) => t.id)).toEqual([3, 1]);
  });
});

describe('modelOptions', () => {
  const cache = { entries: [{ kind: 'text', id: 'a' }, { kind: 'audio', id: 'audio:b', group: 'music' }] };
  it('lists only the kind and keeps an unlisted current value', () => {
    expect(modelOptions(cache, 'text', 'gone').map((o) => o.value)).toEqual(['a', 'gone']);
    expect(modelOptions(cache, 'text', 'a').map((o) => o.value)).toEqual(['a']);
    expect(modelOptions(null, 'text', '')).toEqual([]);
  });
});

describe('payloads per kind', () => {
  const base = { ...emptyProviderForm(), name: 'p', base_url: 'http://h:1' };
  it('audio drops blank group models and sends adapter', () => {
    const p = providerFormToPayload({ ...base, modality: 'audio', adapter: 'box', models_by_group: { music: 'audio:x', ambience: '' } });
    expect(p.models_by_group).toEqual({ music: 'audio:x' });
    expect(p.adapter).toBe('box');
    expect(p).not.toHaveProperty('request_template');
  });
  it('adapter is null when blank', () => {
    expect(providerFormToPayload({ ...base, modality: 'sprite' }).adapter).toBeNull();
  });
  it('image_edit sends model and a parsed template, {} when blank, and no image-only fields', () => {
    const p = providerFormToPayload({ ...base, modality: 'image_edit', model: 'm', request_template: '{"a":1}' });
    expect(p.modality).toBe('image_edit');
    expect(p.model).toBe('m');
    expect(p.request_template).toEqual({ a: 1 });
    expect(p).not.toHaveProperty('models_path');
    expect(providerFormToPayload({ ...base, modality: 'image_edit' }).request_template).toEqual({});
  });
  it('image_edit template is optional but must parse when present', () => {
    const f = { ...base, modality: 'image_edit' };
    expect(validateProviderForm(f)).toBeNull();
    expect(validateProviderForm({ ...f, request_template: '{oops' })).toMatch(/not valid JSON/);
  });
  it('an enabled text provider needs a model; a disabled one does not', () => {
    const f = { ...base, modality: 'text', model: '' };
    expect(validateProviderForm(f)).toBe('Pick or type a model');
    expect(validateProviderForm({ ...f, model: 'llama3' })).toBeNull();
    expect(validateProviderForm({ ...f, enabled: false })).toBeNull();
  });
});

describe('template payload/form', () => {
  it('round-trips, with no token, name or enabled in defaults', () => {
    const form = { ...applyTemplate(emptyProviderForm(), A1111), name: 'My A1111', auth_token: 'sk', token_touched: true, description: 'd' };
    const payload = templateToPayload(form);
    expect(payload).toMatchObject({ name: 'My A1111', modality: 'image', adapter: 'a1111', description: 'd' });
    expect(payload.defaults.sheet_columns).toBe(4);
    expect(payload.defaults.request_template).toEqual(A1111.defaults.request_template);
    for (const k of ['auth_token', 'name', 'enabled', 'has_token']) expect(payload.defaults).not.toHaveProperty(k);
    const back = templateToForm({ ...payload, id: 1 });
    expect(back.name).toBe('My A1111');
    expect(back.auth_token).toBe('');
    expect(back.sheet_columns).toBe('4');
    expect(back.adapter).toBe('a1111');
  });
  it('omits blank fields so applying leaves the target alone', () => {
    const p = templateToPayload({ ...emptyProviderForm('text'), name: 't', adapter: '', model: 'm' });
    expect(p.defaults).toEqual({ model: 'm' });
    expect(p.adapter).toBeNull();
  });
});

describe('isProviderFormDirty', () => {
  const row = { name: 'a', base_url: 'http://x', modality: 'text', adapter: 'ollama', model: 'm', enabled: true };
  it('is clean for an untouched form and dirty after an edit', async () => {
    const { isProviderFormDirty, providerToForm } = await import('../providerForm.js');
    const form = providerToForm(row);
    expect(isProviderFormDirty(form, row)).toBe(false);
    expect(isProviderFormDirty({ ...form, base_url: 'http://y' }, row)).toBe(true);
    expect(isProviderFormDirty({ ...form, auth_token: 't', token_touched: true }, row)).toBe(true);
  });
});
