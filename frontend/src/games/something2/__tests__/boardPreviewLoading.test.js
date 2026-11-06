import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PREVIEW_LOADING_TEXT, elapsedSeconds } from '../boardModel.js';

// SOMET-734: the seed preview's waiting state. SSR render (vitest is node-env).
vi.mock('../useBoard.js', () => ({}));
const { ConfirmDialog } = await import('../BoardActions.jsx');

const status = { available: true, online: true, host: 'opiz03', commit: 'a1b2c3d', behindMain: 0, healthCode: 200, tunnels: {} };
const dialog = (preview) => renderToStaticMarkup(h(ConfirmDialog, {
  kind: 'seed', status, job: null, pending: false, preview, now: Date.now(), onConfirm: () => {}, onClose: () => {}, onPreviewAgain: () => {},
}));
const applyButton = (html) => (html.match(new RegExp('<button[^>]*>Apply</button>')) || [''])[0];

describe('waiting for the seed preview', () => {
  it('says plainly what is happening and counts the seconds', () => {
    const html = dialog({ state: 'loading', startedAt: Date.now() - 12_000 });
    expect(html).toContain('Reading what would change on the board…');
    expect(html).toContain('12 s');
    expect(html).not.toContain('Checking what would change');
  });
  it('Apply stays disabled until the preview is ready', () => {
    expect(applyButton(dialog({ state: 'loading', startedAt: Date.now() }))).toContain('disabled');
    expect(applyButton(dialog(null))).toContain('disabled');
    const ready = dialog({ state: 'ready', loadedAt: Date.now(), data: { needsUpdate: false, groups: [{ group: 'items', add: 1, change: 0, remove: 0, overwrite: 0, blocked: 0, refused: null }], files: { art: 1, audio: 1, artTotal: 1, audioTotal: 1 } } });
    expect(applyButton(ready)).not.toContain('disabled');
  });
  it('elapsed seconds never go negative or NaN', () => {
    expect(PREVIEW_LOADING_TEXT).toBe('Reading what would change on the board…');
    expect(elapsedSeconds(1000, 13_900)).toBe(12);
    expect(elapsedSeconds(5000, 1000)).toBe(0);
    expect(elapsedSeconds(undefined, 1000)).toBe(0);
    expect(elapsedSeconds(1000, NaN)).toBe(0);
  });
});
