import { describe, it, expect } from 'vitest';
import { pickActive } from '../useAiProviders.js';

describe('pickActive', () => {
  const rows = [
    { id: 1, is_active: true, enabled: true, modality: 'audio' },
    { id: 2, is_active: true, enabled: true },                    // legacy row: image
    { id: 3, is_active: true, enabled: false, modality: 'image' },
  ];
  it('never hands the image pickers the audio provider', () => {
    expect(pickActive(rows, 'image').id).toBe(2);
    expect(pickActive(rows, 'audio').id).toBe(1);
    expect(pickActive([], 'audio')).toBe(null);
  });
});
