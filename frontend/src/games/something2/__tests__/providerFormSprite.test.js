import { describe, it, expect } from 'vitest';
import { emptyProviderForm, providerFormToPayload, validateProviderForm } from '../providerForm.js';

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
});
