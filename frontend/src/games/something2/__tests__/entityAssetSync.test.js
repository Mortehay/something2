import { describe, it, expect } from 'vitest';
import { syncApprovedAsset } from '../entityAssetSync.js';

// The tile editor shipped this bug for real: generate a texture, Approve it,
// press Save Changes, and the tile silently went back to the previous picture
// with both requests answering 200. The entity editor is saved from it only by
// this rule, and until now nothing tested it -- deleting the effect it lives in
// left the whole 1590-test suite green.

const openForm = (o = {}) => ({
  name: 'Slime', color: '#0f0', hp: 18, max_hp: 18,
  render_mode: 'rect', image: '',
  ...o,
});

describe('syncApprovedAsset', () => {
  it('adopts an image approved while the form was open', () => {
    // Without this, Save Changes sends render_mode 'rect' and image '' back
    // over the approval, and the entity renders as a coloured box again.
    const next = syncApprovedAsset(openForm(), {
      render_mode: 'static', image: 'sprites/objects/Slime/rmt_new/static.png',
    });
    expect(next.render_mode).toBe('static');
    expect(next.image).toBe('sprites/objects/Slime/rmt_new/static.png');
  });

  it('adopts a newly approved animation the same way', () => {
    const next = syncApprovedAsset(openForm({ render_mode: 'static', image: 'old.png' }), {
      render_mode: 'animated', image: 'atlas.png',
    });
    expect(next.render_mode).toBe('animated');
    expect(next.image).toBe('atlas.png');
  });

  it('replaces a PREVIOUS image, not just an empty one', () => {
    // The half-guard that let the tile bug through protected only the
    // first-asset case. An entity that already has art is the common case.
    const next = syncApprovedAsset(openForm({ render_mode: 'static', image: 'sprites/Slime/seeded/static.png' }), {
      render_mode: 'static', image: 'sprites/objects/Slime/rmt_new/static.png',
    });
    expect(next.image).toBe('sprites/objects/Slime/rmt_new/static.png');
  });

  it('leaves every other field alone', () => {
    const prev = openForm({ hp: 42, name: 'Wolf' });
    const next = syncApprovedAsset(prev, { render_mode: 'static', image: 'a.png' });
    expect(next.hp).toBe(42);
    expect(next.name).toBe('Wolf');
    expect(next.color).toBe('#0f0');
  });

  it('returns the SAME object when nothing changed, so the effect cannot loop', () => {
    // This runs inside an effect that calls setFormData. A fresh object every
    // time would re-render, re-run the effect, and spin.
    const prev = openForm({ render_mode: 'static', image: 'a.png' });
    expect(syncApprovedAsset(prev, { render_mode: 'static', image: 'a.png' })).toBe(prev);
  });

  it('maps the server\'s nulls to the form\'s own empty values', () => {
    const prev = openForm({ render_mode: 'static', image: 'a.png' });
    const next = syncApprovedAsset(prev, { render_mode: null, image: null });
    expect(next.render_mode).toBe('rect');
    expect(next.image).toBe('');
  });

  it('does nothing when there is no live row to sync from', () => {
    const prev = openForm();
    expect(syncApprovedAsset(prev, null)).toBe(prev);
    expect(syncApprovedAsset(prev, undefined)).toBe(prev);
  });
});
