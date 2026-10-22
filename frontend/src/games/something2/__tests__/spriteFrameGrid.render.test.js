import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import SpriteFrameGrid from '../SpriteFrameGrid.jsx';

const DIRS = ['s', 'se', 'e', 'ne', 'n', 'w', 'nw', 'sw'];
function makeManifest(quality) {
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
  return { version: 1, cell: [96, 96], frames_per_action: 6, rows, frames, ...(quality ? { quality } : {}) };
}
const render = (props = {}) => renderToString(h(SpriteFrameGrid, {
  sheetUrl: 'http://x/sheet.png', manifest: makeManifest(), onSend: () => {}, secondsPerCell: 60, sending: false, ...props,
}));
const marks = new Set(['attack/e/2', 'attack/e/3']);

describe('SpriteFrameGrid', () => {
  it('shows marked counts, row summary, pressed frames and the send button', () => {
    const html = render({ initialMarks: marks });
    expect(html).toMatch(/attack[^<]*<[^>]*>[^<]*2/);
    expect(html).toContain('f2, f3 redrawn in order · context: f1, f4');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html).toContain('Redraw 2 frames');
    expect(html).toContain('2 frames marked');
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
  it('disables send with no marks', () => {
    expect(render()).toMatch(/<button[^>]*disabled[^>]*>Redraw 0 frames/);
  });
});
