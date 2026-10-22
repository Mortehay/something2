import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { JobStatusCell } from '../SpriteConsoleAdmin.jsx';

const render = (subject, run = null) => renderToString(h(JobStatusCell, { subject, run }));

describe('JobStatusCell', () => {
  it('a failed redraw reads "redraw failed" in the error style with the error as title', () => {
    const html = render({ job_id: 'r1', job_state: 'failed', redraw_of: 'r0', last_error: 'box down' });
    expect(html).toContain('redraw failed');
    expect(html).toContain('title="box down"');
  });
  it('a failed sheet still reads "failed"', () => {
    const html = render({ job_id: 'r1', job_state: 'failed', last_error: 'oops' });
    expect(html).toMatch(/>failed</);
  });
  it('a running redraw shows "redrawing N%"', () => {
    const run = { current: { id: 'r1', phase: 'running', pct: 42 } };
    expect(render({ job_id: 'r1', job_state: 'running', redraw_of: 'r0' }, run)).toContain('redrawing 42%');
  });
});
