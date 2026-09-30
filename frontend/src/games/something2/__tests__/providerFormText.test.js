import { describe, it, expect } from 'vitest';
import { emptyProviderForm, providerFormToPayload, validateProviderForm } from '../providerForm.js';

describe('text modality provider form', () => {
  const form = { ...emptyProviderForm(), name: 'box text', base_url: 'http://192.168.0.217:8001', modality: 'text', request_template: 'not json' };
  it('sends modality text and no image-only fields', () => {
    const p = providerFormToPayload(form);
    expect(p.modality).toBe('text');
    for (const k of ['request_template', 'models_path', 'models_pointer', 'response_image_pointer', 'sheet_layout']) {
      expect(p).not.toHaveProperty(k);
    }
  });
  it('does not validate the (unused) request template', () => {
    expect(validateProviderForm(form)).toBeNull();
  });
});
