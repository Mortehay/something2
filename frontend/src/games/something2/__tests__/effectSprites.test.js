import { describe, it, expect } from 'vitest';
import { previewAngles, previewFrameAt, effectSelectionEta, effectEtaLabel, effectStatusLabel, previewSprite } from '../effectSprites.js';
import { etaLabel } from '../spriteEta.js';

const ETA = {
  aura: { low: 35.2, typical: 35.2, high: 140.2 },
  burst: { low: 35.2, typical: 35.2, high: 140.2 },
};
const subj = (over = {}) => ({ subject_kind: 'aura', name: 'a', kind: 'aura', sprite: null, job: null, ...over });

describe('effect sprite helpers', () => {
  it('previewAngles: one angle for aura/burst, four for projectile/beam', () => {
    expect(previewAngles('aura')).toEqual([0]);
    expect(previewAngles('burst')).toEqual([0]);
    expect(previewAngles('projectile')).toEqual([0, 60, 150, 270]);
    expect(previewAngles('beam')).toEqual([0, 60, 150, 270]);
  });

  it('selection ETA sums the measured warm seconds and adds the cold first job once', () => {
    const subjects = [subj({ name: 'a' }), subj({ name: 'b' }), subj({ name: 'c', kind: 'burst', subject_kind: 'vfx' })];
    const est = effectSelectionEta(subjects, new Set(['aura|a', 'aura|b', 'vfx|c']), ETA);
    expect(est.low).toBeCloseTo(105.6);
    expect(est.typical).toBeCloseTo(105.6);
    // one cold start (140.2 - 35.2 = 105), not three
    expect(est.high).toBeCloseTo(105.6 + 105);
    expect(effectEtaLabel(est)).toBe(etaLabel(est));
    expect(effectEtaLabel(est)).not.toMatch(/placeholder|not yet measured/);
    expect(effectSelectionEta(subjects, new Set(), ETA)).toEqual({ low: 0, typical: 0, high: 0 });
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
      .toEqual({ image_key: 'new', frames: 6, loop: true, fps: 10 });
    expect(previewSprite(subj({ sprite, job: { status: 'failed' } })).image_key).toBe('old');
  });
});

describe('status with the backend approved job', () => {
  it('status "approved" reads approved; no job falls back to the sprite', () => {
    expect(effectStatusLabel(subj({ job: { status: 'approved', image_key: 'k1' }, sprite: { image: 'k1' } }))).toBe('approved');
    expect(effectStatusLabel(subj({ job: { status: 'approved', image_key: 'k1' } }))).toBe('approved');
    expect(effectStatusLabel(subj({ sprite: { image: 'k1' } }))).toBe('approved');
  });
});

describe('preview play settings are shared by candidate and approved sprite', () => {
  it('a done candidate plays by job.play (its box atlas), not the kind defaults', () => {
    const job = { status: 'done', image_key: 'n', frames: 6, play: { frames: 10, loop: false, fps: null } };
    expect(previewSprite(subj({ kind: 'burst', job }))).toEqual({ image_key: 'n', frames: 10, loop: false, fps: null });
    const proj = { status: 'done', image_key: 'p', frames: 4, play: { frames: 8, loop: true, fps: 14 } };
    const cand = previewSprite(subj({ kind: 'projectile', subject_kind: 'vfx', job: proj }));
    expect(cand).toEqual({ image_key: 'p', frames: 8, loop: true, fps: 14 });
    // after approve, the sprite carries the same columns and previews identically
    const appr = previewSprite(subj({ kind: 'projectile', subject_kind: 'vfx', sprite: { image: 'p', frames: 8, loop: true, fps: 14 } }));
    expect(appr).toEqual(cand);
  });

  it('a candidate and its approved sprite preview the same way', () => {
    const cand = previewSprite(subj({ kind: 'burst', job: { status: 'done', image_key: 'n', frames: 6 } }));
    const appr = previewSprite(subj({ kind: 'burst', sprite: { image: 'n', frames: 6, loop: false, fps: null } }));
    expect(cand).toEqual(appr);
    const aura = previewSprite(subj({ kind: 'aura', sprite: { image: 'a', frames: 8, loop: null, fps: 10 } }));
    expect(aura.loop).toBe(true);
    expect(previewSprite(subj({ kind: 'aura', job: { status: 'done', image_key: 'x', frames: 8 } })).loop).toBe(true);
  });
});

describe('previewFrameAt', () => {
  const loop = { frames: 4, loop: true, fps: 10 };
  const shot = { frames: 4, loop: false, fps: 10 };
  it('wraps a loop', () => {
    expect(previewFrameAt(loop, 0, 0)).toBe(0);
    expect(previewFrameAt(loop, 350, 0)).toBe(3);
    expect(previewFrameAt(loop, 400, 0)).toBe(0);
  });
  it('holds a one-shot on the last frame, then restarts after duration + 400', () => {
    expect(previewFrameAt(shot, 399, 0)).toBe(3);
    expect(previewFrameAt(shot, 790, 0)).toBe(3);
    expect(previewFrameAt(shot, 800, 0)).toBe(0);
    expect(previewFrameAt(shot, 950, 0)).toBe(1);
  });
  it('fps null spreads the strip over 800 ms', () => {
    const s = { frames: 4, loop: false, fps: null };
    expect(previewFrameAt(s, 100, 0)).toBe(0);
    expect(previewFrameAt(s, 600, 0)).toBe(3);
    expect(previewFrameAt(s, 1200, 0)).toBe(0);
  });
  it('one frame and negative elapsed give 0', () => {
    expect(previewFrameAt({ frames: 1, loop: true, fps: 10 }, 500, 0)).toBe(0);
    expect(previewFrameAt(loop, 0, 500)).toBe(0);
  });
});
