import { describe, it, expect } from 'vitest';
import {
  emptyProviderForm, providerFormToPayload, providerToForm, spriteModelOptions, validateProviderForm,
  applyTemplate, templateToPayload, QWEN_FAST, QWEN_QUALITY,
} from '../providerForm.js';

describe('sprite modality provider form', () => {
  const form = { ...emptyProviderForm(), name: 'box sprites', base_url: 'http://192.168.0.217:8001', modality: 'sprite', request_template: 'not json' };
  it('sends modality sprite and no image-only fields', () => {
    const p = providerFormToPayload(form);
    expect(p.modality).toBe('sprite');
    // its request_template carries only the sheet method, never the text field
    expect(p.request_template).toEqual({ sheet_method: '2d' });
    for (const k of ['models_path', 'models_pointer', 'response_image_pointer', 'sheet_layout', 'sheet_columns', 'sheet_rows']) {
      expect(p).not.toHaveProperty(k);
    }
  });
  it('does not validate the (unused) request template', () => {
    expect(validateProviderForm(form)).toBeNull();
  });
  it('sends the chosen concept model, and null for the box default', () => {
    expect(providerFormToPayload({ ...form, model: 'gguf:Qwen-Image-2512-Q3_K_M' }).model).toBe('gguf:Qwen-Image-2512-Q3_K_M');
    expect(providerFormToPayload({ ...form, model: '' }).model).toBeNull();
  });
});

describe('spriteModelOptions', () => {
  it('leads with the box Qwen default, then the cached models in order', () => {
    expect(spriteModelOptions(['gguf:qwen-fast', 'sdxl-x'], '')).toEqual([
      { value: '', label: 'Box default (Qwen fast — fits the card)' },
      { value: 'gguf:qwen-fast', label: 'gguf:qwen-fast' },
      { value: 'sdxl-x', label: 'sdxl-x' },
    ]);
  });
  it('keeps a saved model that is no longer listed so the select does not silently change it', () => {
    expect(spriteModelOptions(['gguf:qwen-fast'], 'old-model').map((o) => o.value)).toEqual(['', 'gguf:qwen-fast', 'old-model']);
  });
});

describe('sprite options: two Qwens and the 3D turnaround', () => {
  const form = { ...emptyProviderForm('sprite'), name: 'box', base_url: 'http://box:8001' };

  it('names the two box Qwens in plain words', () => {
    const labels = Object.fromEntries(spriteModelOptions([QWEN_QUALITY, QWEN_FAST, 'sdxl'], '').map((o) => [o.value, o.label]));
    expect(labels[QWEN_FAST]).toMatch(/fits the card/);
    expect(labels[QWEN_QUALITY]).toMatch(/larger than VRAM/);
    expect(labels.sdxl).toBe('sdxl');
  });

  it('defaults to 2D and sends the chosen sheet method', () => {
    expect(form.sheet_method).toBe('2d');
    expect(providerFormToPayload({ ...form, sheet_method: 'turnaround3d' }).request_template).toEqual({ sheet_method: 'turnaround3d' });
    expect(providerFormToPayload({ ...form, sheet_method: 'bogus' }).request_template).toEqual({ sheet_method: '2d' });
  });

  it('reads the sheet method back from a stored row, 2d when absent', () => {
    const row = { name: 'b', base_url: 'http://box:8001', modality: 'sprite', request_template: { sheet_method: 'turnaround3d' } };
    expect(providerToForm(row).sheet_method).toBe('turnaround3d');
    expect(providerToForm({ ...row, request_template: {} }).sheet_method).toBe('2d');
  });

  it('a template carries the model and sheet method both ways', () => {
    const t = { modality: 'sprite', adapter: 'box', defaults: { model: QWEN_FAST, request_template: { sheet_method: 'turnaround3d' } } };
    const applied = applyTemplate(form, t);
    expect(applied.model).toBe(QWEN_FAST);
    expect(applied.sheet_method).toBe('turnaround3d');
    expect(templateToPayload({ ...applied, name: 'x' }).defaults).toMatchObject({ model: QWEN_FAST, request_template: { sheet_method: 'turnaround3d' } });
  });
});
