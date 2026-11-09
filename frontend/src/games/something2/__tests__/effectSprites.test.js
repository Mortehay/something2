import { describe, it, expect } from 'vitest';
import { previewAngles, effectSelectionEta, effectEtaLabel, effectStatusLabel, previewSprite } from '../effectSprites.js';
import { etaLabel } from '../spriteEta.js';

const ETA = {
  aura: { low: 69, typical: 69, high: 125, placeholder: true },
  burst: { low: 69, typical: 69, high: 125, placeholder: true },
};
const subj = (over = {}) => ({ subject_kind: 'aura', name: 'a', kind: 'aura', sprite: null, job: null, ...over });

describe('effect sprite helpers', () => {
  it('previewAngles: one angle for aura/burst, four for projectile/beam', () => {
    expect(previewAngles('aura')).toEqual([0]);
    expect(previewAngles('burst')).toEqual([0]);
    expect(previewAngles('projectile')).toEqual([0, 60, 150, 270]);
    expect(previewAngles('beam')).toEqual([0, 60, 150, 270]);
  });

  it('selection ETA sums per-kind estimates and says "not yet measured" while placeholder', () => {
    const subjects = [subj({ name: 'a' }), subj({ name: 'b' }), subj({ name: 'c', kind: 'burst', subject_kind: 'vfx' })];
    const est = effectSelectionEta(subjects, new Set(['aura|a', 'aura|b']), ETA);
    expect(est).toEqual({ low: 138, typical: 138, high: 250, placeholder: true });
    expect(effectEtaLabel(est)).toBe(`${etaLabel({ low: 138, typical: 138, high: 250 })} (box estimate, not yet measured)`);
    expect(effectEtaLabel(est)).toContain('~2 min');
    const measured = effectSelectionEta(subjects, new Set(['aura|a']), { aura: { low: 60, typical: 60, high: 60, placeholder: false } });
    expect(effectEtaLabel(measured)).not.toContain('not yet measured');
  });

  it('status label: approved only when the approved image is the job image', () => {
    expect(effectStatusLabel(subj())).toBe('none');
    expect(effectStatusLabel(subj({ job: { status: 'queued' } }))).toBe('queued');
    expect(effectStatusLabel(subj({ job: { status: 'running' } }))).toBe('drawing');
    expect(effectStatusLabel(subj({ job: { status: 'done', image_key: 'k2' }, sprite: { image: 'k1' } }))).toBe('ready to approve');
    expect(effectStatusLabel(subj({ job: { status: 'done', image_key: 'k1' }, sprite: { image: 'k1' } }))).toBe('approved');
    expect(effectStatusLabel(subj({ job: { status: 'failed', error: 'box down' } }))).toBe('failed: box down');
  });

  it('previewSprite prefers a done candidate over the approved sprite', () => {
    const sprite = { image: 'old', frames: 4, loop: true, fps: 8 };
    expect(previewSprite(subj())).toBeNull();
    expect(previewSprite(subj({ sprite }))).toEqual({ image_key: 'old', frames: 4, loop: true, fps: 8 });
    expect(previewSprite(subj({ sprite, job: { status: 'done', image_key: 'new', frames: 6 } })))
      .toEqual({ image_key: 'new', frames: 6, loop: true, fps: 8 });
    expect(previewSprite(subj({ sprite, job: { status: 'failed' } })).image_key).toBe('old');
  });
});
