import { describe, it, expect } from 'vitest';
import { emptyProviderForm, providerFormToPayload, spriteModelOptions, validateProviderForm } from '../providerForm.js';

describe('sprite modality provider form', () => {
  const form = { ...emptyProviderForm(), name: 'box sprites', base_url: 'http://192.168.0.217:8001', modality: 'sprite', request_template: 'not json' };
  it('sends modality sprite and no image-only fields', () => {
    const p = providerFormToPayload(form);
    expect(p.modality).toBe('sprite');
    for (const k of ['request_template', 'models_path', 'models_pointer', 'response_image_pointer', 'sheet_layout', 'sheet_columns', 'sheet_rows']) {
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
      { value: '', label: 'Box default (Qwen)' },
      { value: 'gguf:qwen-fast', label: 'gguf:qwen-fast' },
      { value: 'sdxl-x', label: 'sdxl-x' },
    ]);
  });
  it('keeps a saved model that is no longer listed so the select does not silently change it', () => {
    expect(spriteModelOptions(['gguf:qwen-fast'], 'old-model').map((o) => o.value)).toEqual(['', 'gguf:qwen-fast', 'old-model']);
  });
});
