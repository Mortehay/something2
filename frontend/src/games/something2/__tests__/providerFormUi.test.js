import { describe, it, expect } from 'vitest';
import {
  ADAPTER_OPTIONS, AUDIO_GROUPS, editCapabilityOptions, editSettings, withEditSetting,
  duplicateTemplatePayload, parseTemplate,
} from '../providerForm.js';

// Task 9: the pure rules behind the per-kind provider fields and the
// Templates section. The JSX only wires these up.

describe('adapter and audio group lists', () => {
  it('offers a blank "per-kind default" adapter plus the five the server accepts', () => {
    expect(ADAPTER_OPTIONS.map((o) => o.value)).toEqual(['', 'box', 'a1111', 'openai_compatible', 'ollama', 'generic']);
  });
  it('audio groups follow the drain order', () => {
    expect(AUDIO_GROUPS).toEqual(['music', 'ambience', 'sfx_realistic', 'sfx_retro']);
  });
});

describe('editCapabilityOptions', () => {
  it('Base model (blank) is always the first option, even before any Refresh', () => {
    expect(editCapabilityOptions(null, '')).toEqual([{ value: '', label: 'Base model' }]);
  });
  it('does not duplicate the base entry the box already lists, and keeps an unlisted saved value', () => {
    const cache = { entries: [
      { kind: 'image_edit', id: '', label: 'Base model' },
      { kind: 'image_edit', id: 'pixelate', label: 'pixelate' },
      { kind: 'text', id: 'qwen-a', label: 'qwen-a' },
    ] };
    expect(editCapabilityOptions(cache, 'gone')).toEqual([
      { value: '', label: 'Base model' },
      { value: 'pixelate', label: 'pixelate' },
      { value: 'gone', label: 'gone' },
    ]);
  });
});

describe('image_edit steps/cfg live in request_template', () => {
  it('reads them as strings, blank when absent or unparseable', () => {
    expect(editSettings('{"steps":20,"cfg_scale":4}')).toEqual({ steps: '20', cfg_scale: '4' });
    expect(editSettings('')).toEqual({ steps: '', cfg_scale: '' });
    expect(editSettings('{not json')).toEqual({ steps: '', cfg_scale: '' });
  });
  it('writes a number, removes the key on blank, and keeps other keys', () => {
    const text = withEditSetting('{"steps":20,"seed":1}', 'cfg_scale', '4.5');
    expect(parseTemplate(text).template).toEqual({ steps: 20, seed: 1, cfg_scale: 4.5 });
    const cleared = withEditSetting(text, 'steps', '');
    expect(parseTemplate(cleared).template).toEqual({ seed: 1, cfg_scale: 4.5 });
  });
  it('starts from an empty object when the current text is blank', () => {
    expect(parseTemplate(withEditSetting('', 'steps', '12')).template).toEqual({ steps: 12 });
  });
  it('clearing the last setting yields blank text (template stays optional)', () => {
    expect(withEditSetting('{"steps":20}', 'steps', '')).toBe('');
  });
});

describe('duplicateTemplatePayload', () => {
  it('copies kind, adapter, description and defaults under "<name> copy", never builtin', () => {
    const row = {
      id: 7, name: 'GPU box — brain', modality: 'text', adapter: 'box', description: 'd',
      defaults: { base_url: 'http://b', model: 'qwen' }, builtin: true, sync_uuid: 'u',
    };
    expect(duplicateTemplatePayload(row)).toEqual({
      name: 'GPU box — brain copy', modality: 'text', adapter: 'box', description: 'd',
      defaults: { base_url: 'http://b', model: 'qwen' },
    });
  });
});
