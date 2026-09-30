// frontend/src/games/something2/__tests__/audioPromptDraft.test.js
import { describe, it, expect } from 'vitest';
import { provenanceText, generatePromptFields } from '../audioPromptDraft.js';

describe('provenanceText', () => {
  it('names model and route, or a person', () => {
    expect(provenanceText({ model: 'qwen', via: 'box' })).toBe('written by qwen (GPU box)');
    expect(provenanceText({ model: 'qwen2.5-coder:7b', via: 'fallback' })).toBe('written by qwen2.5-coder:7b (CPU fallback)');
    expect(provenanceText({ model: null, via: null, text: 'x' })).toBe('edited by hand');
    expect(provenanceText({ model: null, via: null, text: '' })).toBe('cleared by hand — generation ignores it');
    expect(provenanceText(null)).toBe('no stored prompt');
  });
});

describe('generatePromptFields', () => {
  const active = { style: 'village', text: 'stored lute' };
  it('unchanged draft sends nothing: the server uses the stored prompt', () => {
    expect(generatePromptFields({ isSfx: false, styleDraft: null, textDraft: null, active })).toEqual({});
    expect(generatePromptFields({ isSfx: false, styleDraft: 'village', textDraft: 'stored lute', active })).toEqual({});
  });
  it('edited but unsaved draft is sent explicitly', () => {
    expect(generatePromptFields({ isSfx: false, styleDraft: 'tavern', textDraft: null, active }))
      .toEqual({ style: 'tavern', prompt: 'stored lute' });
  });
  it('sfx never sends style/prompt (entity comes from the stored prompt server-side)', () => {
    expect(generatePromptFields({ isSfx: true, styleDraft: null, textDraft: 'typed', active })).toEqual({});
  });
});
