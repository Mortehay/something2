import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import SpriteFrameGrid from '../SpriteFrameGrid.jsx';

const DIRS = ['s', 'se', 'e', 'ne', 'n', 'w', 'nw', 'sw'];
function makeManifest(quality, unmirrored) {
  const rows = [];
  const frames = {};
  let r = 0;
  for (const action of ['idle', 'attack']) {
    for (const direction of DIRS) {
      rows.push({ row: r, action, direction, frames: 6 });
      for (let i = 0; i < 6; i += 1) frames[`${action}/${direction}/${i}`] = [i * 96, r * 96, 96, 96];
      r += 1;
    }
  }
  return { version: 1, cell: [96, 96], frames_per_action: 6, rows, frames, ...(quality ? { quality } : {}), ...(unmirrored ? { unmirrored } : {}) };
}
const render = (props = {}) => renderToString(h(SpriteFrameGrid, {
  sheetUrl: 'http://x/sheet.png', manifest: makeManifest(), onSend: () => {}, secondsPerCell: 60, sending: false, ...props,
}));
const marks = new Set(['attack/e/2', 'attack/e/3']);

describe('SpriteFrameGrid read-only', () => {
  it('shows frames and flags but no marking controls', () => {
    const html = render({ readOnly: true, manifest: makeManifest([{ action: 'idle', direction: 'e', frame: 1, attempts: 2, passed: false, failed_checks: ['facing'] }]) });
    expect(html).toContain('aria-label="idle s frame 0"');
    expect(html.match(/<button[^>]*aria-label="idle [a-z]+ frame \d"[^>]*>/g).every((b) => /disabled/.test(b))).toBe(true);
    expect(html).not.toContain('Mark row');
    expect(html).not.toContain('Mark flagged');
    expect(html).not.toMatch(/Redraw \d+ frame/);
    expect(html).toContain('1 flagged');
  });
});

describe('SpriteFrameGrid', () => {
  it('shows marked counts, row summary, pressed frames and the send button', () => {
    const html = render({ initialMarks: marks });
    expect(html).toMatch(/attack[^<]*<[^>]*>[^<]*2/);
    expect(html).toContain('f2, f3 redrawn in order · context: f1, f4');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html).toContain('Redraw 2 frames');
    expect(html).toContain('2 frames marked');
  });
  it('says "1 frame marked" for a single mark', () => {
    const html = render({ initialMarks: new Set(['attack/e/2']) });
    expect(html).toContain('1 frame marked');
    expect(html).toContain('Redraw 1 frame<');
  });
  it('opens on the first action with marks and doubles e', () => {
    const html = render({ initialMarks: marks });
    expect(html).toContain('×2 in game');
    expect(html).toContain('attack · e');
    expect(html).not.toContain('idle · e<');
  });
  it('lists the western group with disabled frames', () => {
    const html = render({ initialMarks: marks });
    expect(html).toContain('Not drawn in game (mirrored from e / ne / se)');
    const west = html.slice(html.indexOf('Not drawn in game'));
    expect(west.match(/<button[^>]*disabled/g).length).toBeGreaterThanOrEqual(18);
  });
  it('singular button copy', () => {
    expect(render({ initialMarks: new Set(['attack/s/0']) })).toContain('Redraw 1 frame<');
  });
  it('Mark flagged only with quality', () => {
    expect(render({ initialMarks: marks })).not.toContain('Mark flagged');
    const q = [{ action: 'attack', direction: 's', frame: 1, attempts: 3, passed: false, failed_checks: ['palette'] }];
    const html = render({ manifest: makeManifest(q), initialMarks: marks });
    expect(html).toContain('Mark flagged (1)');
    expect(html).toContain('palette');
  });
  it('flag tooltip shows the reason when present', () => {
    const q = [{ action: 'attack', direction: 's', frame: 1, attempts: 1, passed: false, failed_checks: ['size_jump'], reason: 'size jump: figure area +30% (likely a close-up)' }];
    expect(render({ manifest: makeManifest(q), initialMarks: marks })).toContain('likely a close-up');
  });
  it('disables send with no marks', () => {
    expect(render()).toMatch(/<button[^>]*disabled[^>]*>Redraw 0 frames/);
  });
  it('crops against the passed real sheet size, not the rect box', () => {
    const html = render({ initialMarks: marks, sheetPx: { w: 1000, h: 3000 } });
    expect(html).toContain('background-size:2000px 6000px');
  });
  it('compare: previous strip only for rows with redrawn frames, one changed badge', () => {
    const html = render({
      initialMarks: new Set(),
      initialAction: 'attack',
      compare: {
        previousUrl: 'http://x/prev.png',
        redrawFrames: [{ action: 'attack', direction: 'e', frame: 2 }],
        changedUnmarked: ['attack/s/1'],
      },
    });
    expect(html.match(/data-strip="previous"/g)).toHaveLength(1);
    expect(html).toContain('prev.png');
    expect(html.match(/changed, not marked/g).length).toBe(2); // frame badge + tab count
    expect(html.match(/<span[^>]*>changed, not marked<\/span>/g)).toHaveLength(1);
    expect(html).toContain('attack · e');
  });
  it('no compare: no previous strips', () => {
    expect(render({ initialMarks: marks })).not.toContain('data-strip="previous"');
  });
});

describe('SpriteFrameGrid real western rows (SOMET-686)', () => {
  const real = () => makeManifest(undefined, { idle: ['w'] });
  const idleHtml = (props) => render({ initialAction: 'idle', ...props });
  it('an as-is w row is markable, outside the collapsed details, and e has no x2 badge', () => {
    const html = idleHtml({ manifest: real() });
    const cut = html.indexOf('<details');
    const main = html.slice(0, cut);
    const west = html.slice(cut);
    expect(main).toContain('idle · w');
    expect(main).toMatch(/<button(?![^>]*disabled)[^>]*aria-label="idle w frame 0"/);
    expect(west).not.toContain('idle · w');
    expect(west).toContain('idle · nw');
    expect(main).not.toMatch(/idle · e<\/strong>(<!-- -->)?<span[^>]*>×2/);
  });
  it('Mark flagged keeps a western flag of an as-is row', () => {
    const q = [{ action: 'idle', direction: 'w', frame: 1, attempts: 3, passed: false, failed_checks: ['x'] }];
    expect(idleHtml({ manifest: makeManifest(q, { idle: ['w'] }) })).toContain('Mark flagged (1)');
    expect(idleHtml({ manifest: makeManifest(q) })).not.toContain('Mark flagged');
  });
  it('an old sheet keeps w inside the details and e doubled', () => {
    const html = idleHtml({});
    expect(html.slice(0, html.indexOf('<details'))).not.toContain('idle · w');
    expect(html).toContain('×2 in game');
  });
});
