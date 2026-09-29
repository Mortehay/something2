import { describe, it, expect } from 'vitest';
import { applyVolumeChange, DEFAULT_VOLUMES } from '../audioSettings.js';

describe('applyVolumeChange', () => {
  it('clamps sliders and toggles mute without touching other fields', () => {
    const v = applyVolumeChange(DEFAULT_VOLUMES, 'music', 1.7);
    expect(v.music).toBe(1);
    expect(v.master).toBe(DEFAULT_VOLUMES.master);
    expect(applyVolumeChange(v, 'ambience', -2).ambience).toBe(0);
    // Sound effects (game audio slice 3, Task 8): sfx is clamped the same
    // way as the other three sliders, and DEFAULT_VOLUMES already carries it.
    expect(applyVolumeChange(v, 'sfx', 1.7).sfx).toBe(1);
    expect(applyVolumeChange(v, 'muted', 'yes').muted).toBe(true);
    expect(applyVolumeChange(v, 'bogus', 0.5)).toEqual(v);
  });
});
