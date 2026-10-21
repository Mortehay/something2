import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KindFields } from '../ProviderKindFields.jsx';
import { emptyProviderForm, applyTemplate } from '../providerForm.js';

// Task 9: the per-kind field blocks shared by ProviderCard and the Templates
// editor. SSR render (vitest is node-env), asserting on what only real
// discovery data or a saved value can produce.

const cache = { entries: [
  { kind: 'text', id: 'qwen-a', label: 'qwen-a' },
  { kind: 'text', id: 'qwen-b', label: 'qwen-b' },
  { kind: 'audio', id: 'audio:ace-step', label: 'audio:ace-step' },
  { kind: 'audio', id: 'audio:sfx-x', label: 'audio:sfx-x' },
  { kind: 'image_edit', id: '', label: 'Base model' },
  { kind: 'image_edit', id: 'pixelate', label: 'pixelate' },
], unsupported: [] };

const render = (form, extra = {}) => renderToStaticMarkup(h(KindFields, { form, set: () => {}, ...extra }));
const selectNamed = (html, label) => (html.match(new RegExp(`<select aria-label="${label}"[^>]*>(.*?)</select>`)) || [])[1] || '';

describe('KindFields', () => {
  it('text: discovered models of the text kind only, the saved one selected, plus Other…', () => {
    const html = render({ ...emptyProviderForm('text'), model: 'qwen-b' }, { discoveryCache: cache });
    const sel = selectNamed(html, 'Model');
    expect(sel).toContain('<option value="qwen-a">qwen-a</option>');
    expect(sel).toContain('<option value="qwen-b" selected="">qwen-b</option>');
    expect(sel).toContain('Other…');
    expect(sel).not.toContain('audio:ace-step');
    expect(sel).not.toContain('pixelate');
  });

  it('text: a saved model the provider no longer lists still shows selected (round trip)', () => {
    const html = render({ ...emptyProviderForm('text'), model: 'hand-typed:7b' }, { discoveryCache: cache });
    expect(selectNamed(html, 'Model')).toContain('<option value="hand-typed:7b" selected="">hand-typed:7b</option>');
  });

  it('text with nothing discovered and no model: a free-text input', () => {
    const html = render(emptyProviderForm('text'));
    expect(html).not.toContain('<select');
    expect(html).toContain('aria-label="Model"');
  });

  it('audio: one select per drain group, audio entries only, each group keeps its own value', () => {
    const form = { ...emptyProviderForm('audio'), models_by_group: { music: 'audio:ace-step', sfx_retro: 'audio:sfx-x' } };
    const html = render(form, { discoveryCache: cache });
    for (const g of ['music', 'ambience', 'sfx_realistic', 'sfx_retro']) {
      expect(selectNamed(html, `Model for ${g}`)).toContain('audio:sfx-x');
      expect(selectNamed(html, `Model for ${g}`)).not.toContain('qwen-a');
    }
    expect(selectNamed(html, 'Model for music')).toContain('<option value="audio:ace-step" selected="">');
    expect(selectNamed(html, 'Model for sfx_retro')).toContain('<option value="audio:sfx-x" selected="">');
    expect(selectNamed(html, 'Model for ambience')).toMatch(/<option value="" selected="">/);
  });

  it('image_edit: capability select with Base model blank, steps/cfg read from the template', () => {
    const tpl = { modality: 'image_edit', adapter: 'box', defaults: { request_template: { steps: 20, cfg_scale: 4 } } };
    const form = { ...applyTemplate(emptyProviderForm('image_edit'), tpl), model: 'pixelate' };
    const html = render(form, { discoveryCache: cache });
    const sel = selectNamed(html, 'Capability');
    expect(sel).toContain('<option value="">Base model</option>');
    expect(sel).toContain('<option value="pixelate" selected="">pixelate</option>');
    expect(html).toMatch(/aria-label="Steps"[^>]*value="20"/);
    expect(html).toMatch(/aria-label="CFG"[^>]*value="4"/);
  });

  it('sprite: the concept-model select is unchanged (box default first)', () => {
    const html = render({ ...emptyProviderForm('sprite'), model: 'core-b' }, { models: ['core-a', 'core-b'] });
    const sel = selectNamed(html, 'Concept model');
    expect(sel).toMatch(/^<option value="">Box default \(Qwen\)<\/option>/);
    expect(sel).toContain('<option value="core-b" selected="">core-b</option>');
  });

  it('image: request template textarea and the models_cache dropdown', () => {
    const html = render({ ...emptyProviderForm('image'), request_template: '{"prompt":"{{prompt}}"}', model: 'm2' }, { models: ['m1', 'm2'] });
    expect(html).toContain('<textarea');
    expect(selectNamed(html, 'Model')).toContain('<option value="m2" selected="">m2</option>');
  });
});
